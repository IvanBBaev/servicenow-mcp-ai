import { ServiceNowError } from "./errors.js";
import { getCredentials } from "./config.js";
import { resolveHost } from "./host.js";
import { getAuthProvider, getAuthMode, invalidateToken } from "./auth.js";
import { getTlsDispatcher } from "./mtls.js";
import { logger } from "./logging.js";
import { getMaxRetries, getTimeoutMs } from "./settings.js";
import {
  backoffMs,
  countError,
  delay,
  isIdempotent,
  retryAfterMs,
  shouldRetryStatus,
  telemetryFor,
  withSlot,
} from "./http-util.js";

// Telemetry is owned by http-util.ts (shared with the Jira client) but kept
// importable here for the status payload and the existing tests.
export {
  getTelemetry,
  _resetTelemetry,
  type Telemetry,
  type TelemetrySnapshot,
} from "./http-util.js";

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
 * data). Transient failures are retried with exponential backoff; non-idempotent
 * methods are retried only on connection errors, never on a received response.
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
}: SnRequestArgs): Promise<SnResponse<T>> {
  const { instance } = getCredentials();
  if (!instance) {
    throw new ServiceNowError(
      "ServiceNow instance is not configured. Use the servicenow_set_credentials tool first.",
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
  const timeoutMs = getTimeoutMs();
  const maxRetries = getMaxRetries();

  const headers: Record<string, string> = {
    Accept: accept ?? "application/json",
  };
  let payload: string | Uint8Array | undefined;
  if (rawBody !== undefined) {
    payload = rawBody;
    if (contentType) headers["Content-Type"] = contentType;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }

  const started = Date.now();
  const telemetry = telemetryFor(host);
  telemetry.requests += 1;
  // A server-side token revocation surfaces as 401 before the cached token's
  // TTL runs out; one forced re-auth attempt recovers, a second 401 is real.
  // Optional client certificate (mutual TLS), built once per request.
  const dispatcher = await getTlsDispatcher();
  let retried401 = false;
  for (let attempt = 0; ; attempt++) {
    // Authorize per attempt: with long backoffs an OAuth token can expire
    // between tries (Basic is just a cheap base64; OAuth reads its cache).
    Object.assign(headers, await getAuthProvider().headers(host));
    let res: Response;
    try {
      // Node's fetch accepts Uint8Array bodies and a `dispatcher` (undici) at
      // runtime; the loose record bridges gaps in the DOM RequestInit typing.
      // The timeout signal is created inside the slot, so time spent queued on
      // the per-host semaphore does not consume the request's timeout budget.
      res = await withSlot(host, () => {
        const init: Record<string, unknown> = {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        };
        if (dispatcher) init.dispatcher = dispatcher;
        return fetch(url, init);
      });
    } catch (cause) {
      const err = cause instanceof Error ? cause : new Error(String(cause));
      const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
      // Only retry transport errors for idempotent requests, to avoid
      // duplicating non-idempotent writes whose outcome is unknown.
      if (isIdempotent(method) && attempt < maxRetries) {
        telemetry.retries += 1;
        await delay(backoffMs(attempt + 1));
        continue;
      }
      logger.warn("ServiceNow request failed (transport)", {
        method,
        path,
        timedOut,
        ms: Date.now() - started,
      });
      countError(telemetry, "transport");
      telemetry.totalMs += Date.now() - started;
      if (timedOut) {
        throw new ServiceNowError(
          `Request to ServiceNow timed out after ${timeoutMs}ms.`,
        );
      }
      throw new ServiceNowError(
        `Could not reach ServiceNow at ${safeUrl}: ${err.message}`,
      );
    }

    if (res.status === 401 && !retried401 && getAuthMode() === "oauth") {
      retried401 = true;
      telemetry.retries += 1;
      invalidateToken(host);
      await res.text().catch(() => undefined); // release the socket
      logger.debug("401 with cached OAuth token — re-authenticating once", {
        method,
        path,
      });
      continue;
    }

    if (
      !res.ok &&
      shouldRetryStatus(res.status, method) &&
      attempt < maxRetries
    ) {
      telemetry.retries += 1;
      const wait = retryAfterMs(res) ?? backoffMs(attempt + 1);
      await res.text().catch(() => undefined); // release the socket
      logger.debug("Retrying ServiceNow request", {
        method,
        path,
        status: res.status,
        attempt: attempt + 1,
        waitMs: wait,
      });
      await delay(wait);
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      let json: unknown = {};
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = { raw: text };
        }
      }
      const detail =
        extractErrorDetail(json) || res.statusText || text || "(no detail)";
      logger.warn("ServiceNow API error", {
        method,
        path,
        status: res.status,
        ms: Date.now() - started,
      });
      countError(telemetry, res.status);
      telemetry.totalMs += Date.now() - started;
      throw new ServiceNowError(
        `ServiceNow API error (${res.status}): ${detail}`,
        res.status,
        json,
      );
    }

    const total = parseTotalCount(res);
    const responseContentType = res.headers.get("content-type") ?? undefined;
    telemetry.totalMs += Date.now() - started;
    logger.debug("ServiceNow request ok", {
      method,
      path,
      status: res.status,
      ms: Date.now() - started,
    });

    if (responseType === "binary") {
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        data: buf.toString("base64") as unknown as T,
        total,
        status: res.status,
        contentType: responseContentType,
      };
    }

    const text = await res.text();
    let json: unknown = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }
    return {
      data: json as T,
      total,
      status: res.status,
      contentType: responseContentType,
    };
  }
}
