import { ServiceNowError, notConfiguredError } from "./errors.js";
import { getCredentials, credentialStatus, activeProfile } from "./config.js";
import { resolveHost } from "./host.js";
import {
  AUTH_EXPIRED_HINT,
  getAuthProvider,
  getAuthMode,
  invalidateToken,
  reloadBearerTokenFile,
} from "./auth.js";
import { getDispatcher } from "./dispatcher.js";
import { elevationHint, elevationNeeded } from "./elevation.js";
import { logger } from "./logging.js";
import { currentSignal } from "./request-context.js";
import {
  rawRequest,
  readBodyBytes,
  readBodyText,
  htmlToText,
  looksLikeHtml,
  isHibernationPage,
  telemetryFor,
  countError,
  MAX_TEXT_DETAIL_CHARS,
  HIBERNATING_HINT,
  INSTANCE_HTML_HINT,
} from "./http-util.js";

// Telemetry is owned by http-util.ts (shared with the Jira client) but kept
// importable here for the status payload and the existing tests.
export { getTelemetry } from "./http-util.js";

/** Arguments for a single ServiceNow REST request. */
export interface SnRequestArgs {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Absolute API path under the instance origin, e.g. "/api/now/table/incident". */
  path: string;
  params?: URLSearchParams;
  /** JSON request body. Mutually exclusive with `rawBody`. */
  body?: unknown;
  /** Pre-encoded request body (e.g. binary upload). Sets `contentType`. */
  rawBody?: string | Uint8Array;
  /** Content-Type for `rawBody`. Ignored when `body` is used (always JSON). */
  contentType?: string;
  /** Accept header; defaults to application/json. */
  accept?: string;
  /** "json" (default) parses the body; "binary" returns base64 in `data`. */
  responseType?: "json" | "binary";
  /**
   * Caller cancellation: aborts the in-flight attempt and stops retrying.
   * Defaults to the current tool call's signal (M-3), so every request a
   * cancelled call makes is aborted without api/ threading it.
   */
  signal?: AbortSignal;
  /** Per-attempt timeout override for this call (default SN_TIMEOUT_MS). */
  timeoutMs?: number;
  /**
   * Skip the per-host request queue. Reserved for diagnostics (status,
   * test-connection, doctor) that must answer even while the queue is stalled.
   */
  bypassQueue?: boolean;
}

export interface SnResponse<T> {
  data: T;
  /** X-Total-Count (all matching rows) when the API provides it. */
  total?: number;
  status: number;
  /** Content-Type of the response, useful for binary downloads. */
  contentType?: string;
}

/** Parse the X-Total-Count header (total matching rows) when present. */
function parseTotalCount(res: Response): number | undefined {
  const raw = res.headers.get("x-total-count");
  return raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/** Extract a human-readable message from a ServiceNow error body. */
function extractErrorDetail(json: unknown): string | undefined {
  if (json && typeof json === "object" && "error" in json) {
    const err = (json as { error?: unknown }).error;
    if (err && typeof err === "object") {
      const o = err as { message?: unknown; detail?: unknown };
      if (typeof o.message === "string" && o.message) return o.message;
      if (typeof o.detail === "string" && o.detail) return o.detail;
    }
  }
  return undefined;
}

/**
 * Perform an authenticated request against the configured ServiceNow instance.
 *
 * The host is resolved and SSRF-checked before any network call, and the query
 * string is omitted from error messages (encoded queries can contain personal
 * data). Transient failures are retried with exponential backoff within the
 * request deadline; non-idempotent methods are retried only on connection
 * errors, never on a received response. Everything below the URL — identity
 * header, proxy/TLS dispatcher, queue, timeout, deadline, retry, error shaping —
 * is the shared primitive in http-util.ts, which the Jira twin and the OAuth
 * token exchange use as well.
 */
export async function snRequest<T>({
  method,
  path,
  params,
  body,
  rawBody,
  contentType,
  accept,
  responseType = "json",
  signal,
  timeoutMs,
  bypassQueue,
}: SnRequestArgs): Promise<SnResponse<T>> {
  const { instance } = getCredentials();
  if (!instance) {
    // M-1: recoverable — code NOT_CONFIGURED + a hint naming what is missing.
    throw notConfiguredError(
      "ServiceNow instance is not configured. Use the servicenow_set_credentials tool first.",
      credentialStatus().missing,
      activeProfile(),
    );
  }

  const host = resolveHost(instance);
  const base = `https://${host}`;
  const qs = params?.toString();
  // The path already carrying a query string is a caller mistake, but join with
  // the right separator so we never emit a malformed double-"?" URL.
  const sep = path.includes("?") ? "&" : "?";
  const url = `${base}${path}${qs ? `${sep}${qs}` : ""}`;
  const safeUrl = `${base}${path}`;

  const baseHeaders: Record<string, string> = {
    Accept: accept ?? "application/json",
  };
  let payload: string | Uint8Array | undefined;
  if (rawBody !== undefined) {
    payload = rawBody;
    if (contentType) baseHeaders["Content-Type"] = contentType;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    baseHeaders["Content-Type"] = "application/json";
  }

  // Optional proxy / client certificate / CA policy, one agent per config.
  const dispatcher = await getDispatcher(host);

  // A server-side token revocation surfaces as 401 before the cached token's
  // TTL runs out; one forced re-auth attempt recovers, a second 401 is real.
  let retried401 = false;

  const res = await rawRequest({
    url,
    safeUrl,
    method,
    host,
    system: "ServiceNow",
    // Authorize per attempt: with long backoffs an OAuth token can expire
    // between tries (Basic is just a cheap base64; OAuth reads its cache).
    headers: async () => ({
      ...baseHeaders,
      ...(await getAuthProvider().headers(host)),
    }),
    body: payload,
    dispatcher,
    extractDetail: extractErrorDetail,
    signal: signal ?? currentSignal(),
    timeoutMs,
    bypassQueue,
    onResponse: (r) => {
      if (r.status !== 401 || retried401) return false;
      const mode = getAuthMode();
      if (mode === "oauth") {
        retried401 = true;
        invalidateToken(host);
        logger.debug("401 with cached OAuth token — re-authenticating once", {
          method,
          path,
        });
        return true;
      }
      // L6-02: an external issuer may have rotated SN_TOKEN_FILE — re-read it
      // once and replay only when it now holds a different token.
      if (mode === "token") {
        retried401 = true;
        if (reloadBearerTokenFile()) {
          logger.debug("401 with bearer token — retrying with SN_TOKEN_FILE", {
            method,
            path,
          });
          return true;
        }
      }
      return false;
    },
    makeError: (message, status, detail, options) => {
      if (
        status === 401 &&
        (!options?.code || options.code === "INSTANCE_HTTP_401") &&
        getAuthMode() === "token"
      ) {
        return new ServiceNowError(message, status, detail, {
          ...options,
          code: "AUTH_EXPIRED",
          hint: AUTH_EXPIRED_HINT,
        });
      }
      // N-20 EL-2: a 403 on a write the platform gates behind an elevated
      // role is not a missing ACL — say which role and how to get around it.
      const elevation =
        status === 403 &&
        (!options?.code || options.code === "INSTANCE_HTTP_403")
          ? elevationNeeded(method, path)
          : undefined;
      return elevation
        ? new ServiceNowError(message, status, detail, {
            ...options,
            code: "ELEVATION_REQUIRED",
            hint: elevationHint(elevation),
          })
        : new ServiceNowError(message, status, detail, options);
    },
  });

  const total = parseTotalCount(res);
  const responseContentType = res.headers.get("content-type") ?? undefined;

  if (responseType === "binary") {
    const buf = await readBodyBytes(res, { system: "ServiceNow", safeUrl });
    return {
      data: buf.toString("base64") as unknown as T,
      total,
      status: res.status,
      contentType: responseContentType,
    };
  }

  return {
    data: parseJsonOrThrowHtml(
      await readBodyText(res, { system: "ServiceNow", safeUrl }),
      res.status,
      responseContentType ?? null,
      host,
      safeUrl,
    ) as T,
    total,
    status: res.status,
    contentType: responseContentType,
  };
}

/**
 * Parse a 2xx body that should be JSON. A hibernating developer instance (and
 * an SSO/login page reached through a redirect) answers API calls with an
 * HTML page and HTTP 200; without this check that page surfaced later as a
 * misleading "missing 'result'" error (H-8 C-3 / L1-08). The page is reduced
 * to a short text excerpt; only the query-less URL reaches the message.
 * Non-HTML, non-JSON text keeps the historical `{ raw }` shape.
 */
export function parseJsonOrThrowHtml(
  text: string,
  status: number,
  contentType: string | null,
  host: string,
  safeUrl: string,
): unknown {
  if (!text) return {};
  const isJsonType = (contentType ?? "").toLowerCase().includes("json");
  if (!isJsonType && looksLikeHtml(text, contentType)) {
    countError(telemetryFor(host), "instance_html");
    const hibernating = isHibernationPage(text);
    const excerpt = htmlToText(text).slice(0, MAX_TEXT_DETAIL_CHARS);
    logger.debug("HTML page in place of a JSON API body", {
      url: safeUrl,
      status,
      hibernating,
    });
    throw new ServiceNowError(
      `ServiceNow returned an HTML page instead of JSON (HTTP ${status}) for ${safeUrl}` +
        (hibernating
          ? " — the developer instance appears to be hibernating."
          : "."),
      status,
      { raw: excerpt, html: true },
      {
        code: "INSTANCE_HTML_RESPONSE",
        hint: hibernating ? HIBERNATING_HINT : INSTANCE_HTML_HINT,
      },
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}
