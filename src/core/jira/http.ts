import { JiraError } from "../errors.js";
import { logger } from "../logging.js";
import { getMaxRetries, getTimeoutMs } from "../settings.js";
import {
  backoffMs,
  countError,
  delay,
  isIdempotent,
  retryAfterMs,
  shouldRetryStatus,
  telemetryFor,
  withSlot,
} from "../http-util.js";
import { getJiraCredentials } from "./config.js";
import { resolveJiraHost } from "./host.js";

/** Arguments for a single Jira REST request. */
export interface JiraRequestArgs {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Absolute API path under the site origin, e.g. "/rest/api/3/issue/PROJ-1". */
  path: string;
  params?: URLSearchParams;
  /** JSON request body. Mutually exclusive with `form`. */
  body?: unknown;
  /** multipart/form-data body (attachment upload). Mutually exclusive with `body`. */
  form?: FormData;
  /** Accept header; defaults to application/json. */
  accept?: string;
  /** Extra headers, e.g. the X-Atlassian-Token: no-check required for uploads. */
  extraHeaders?: Record<string, string>;
  /** "json" (default) parses the body; "binary" returns base64 in `data`. */
  responseType?: "json" | "binary";
}

export interface JiraResponse<T> {
  data: T;
  status: number;
  contentType?: string;
}

/** Basic-auth header from the Jira account email + API token. */
function basicHeader(email: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
}

/** Extract a human-readable message from a Jira error body. */
function extractJiraErrorDetail(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const o = json as {
    errorMessages?: unknown;
    errors?: unknown;
    message?: unknown;
  };
  if (Array.isArray(o.errorMessages) && o.errorMessages.length > 0) {
    return o.errorMessages.map(String).join("; ");
  }
  if (o.errors && typeof o.errors === "object") {
    const parts = Object.entries(o.errors as Record<string, unknown>).map(
      ([k, v]) => `${k}: ${String(v)}`,
    );
    if (parts.length > 0) return parts.join("; ");
  }
  if (typeof o.message === "string" && o.message) return o.message;
  return undefined;
}

/**
 * Perform an authenticated request against the configured Jira Cloud site.
 *
 * The Jira-flavoured twin of snRequest: the host is resolved and SSRF-checked
 * before any network call; transient failures retry with the same exponential
 * backoff. A non-idempotent write is never replayed on a transport error or on
 * a gateway/unavailable response (502/503/504), whose outcome is unknown, so a
 * create/transition is never duplicated. A 429 is the exception: it is rejected
 * before processing, so it is retried for every method (see shouldRetryStatus).
 */
export async function jiraRequest<T>({
  method,
  path,
  params,
  body,
  form,
  accept,
  extraHeaders,
  responseType = "json",
}: JiraRequestArgs): Promise<JiraResponse<T>> {
  const { site, email, apiToken } = getJiraCredentials();
  if (!site) {
    throw new JiraError(
      "Jira site is not configured. Use the jira_set_credentials tool first (or set JIRA_SITE).",
    );
  }
  if (!email || !apiToken) {
    throw new JiraError(
      "Jira auth requires JIRA_EMAIL and JIRA_API_TOKEN. Use the jira_set_credentials tool first.",
    );
  }

  if (form !== undefined && body !== undefined) {
    throw new JiraError(
      "A Jira request cannot carry both a JSON body and a form; pass only one.",
    );
  }
  // Auth, content negotiation and body labelling are owned by this client.
  // An extraHeaders entry for one of them would either clobber the managed
  // value or — under a different casing — get merged by fetch into one
  // broken header, so reject the call instead.
  for (const key of Object.keys(extraHeaders ?? {})) {
    const k = key.toLowerCase();
    if (k === "authorization" || k === "accept" || k === "content-type") {
      throw new JiraError(
        `extraHeaders must not set "${key}"; it is managed by the Jira client.`,
      );
    }
  }

  const host = resolveJiraHost(site);
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
    Authorization: basicHeader(email, apiToken),
    ...extraHeaders,
  };
  // FormData lets fetch set its own multipart Content-Type (with boundary);
  // a JSON body is serialised and labelled here.
  let payload: string | FormData | undefined;
  if (form !== undefined) {
    payload = form;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }

  const started = Date.now();
  const telemetry = telemetryFor(host);
  telemetry.requests += 1;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await withSlot(host, () =>
        fetch(url, {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
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
      logger.warn("Jira request failed (transport)", {
        method,
        path,
        timedOut,
        ms: Date.now() - started,
      });
      countError(telemetry, "transport");
      telemetry.totalMs += Date.now() - started;
      if (timedOut) {
        throw new JiraError(`Request to Jira timed out after ${timeoutMs}ms.`);
      }
      throw new JiraError(`Could not reach Jira at ${safeUrl}: ${err.message}`);
    }

    if (
      !res.ok &&
      shouldRetryStatus(res.status, method) &&
      attempt < maxRetries
    ) {
      telemetry.retries += 1;
      const wait = retryAfterMs(res) ?? backoffMs(attempt + 1);
      await res.text().catch(() => undefined); // release the socket
      logger.debug("Retrying Jira request", {
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
        extractJiraErrorDetail(json) || res.statusText || text || "(no detail)";
      logger.warn("Jira API error", {
        method,
        path,
        status: res.status,
        ms: Date.now() - started,
      });
      countError(telemetry, res.status);
      telemetry.totalMs += Date.now() - started;
      throw new JiraError(
        `Jira API error (${res.status}): ${detail}`,
        res.status,
        json,
      );
    }

    const responseContentType = res.headers.get("content-type") ?? undefined;
    telemetry.totalMs += Date.now() - started;
    logger.debug("Jira request ok", {
      method,
      path,
      status: res.status,
      ms: Date.now() - started,
    });

    if (responseType === "binary") {
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        data: buf.toString("base64") as unknown as T,
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
      status: res.status,
      contentType: responseContentType,
    };
  }
}
