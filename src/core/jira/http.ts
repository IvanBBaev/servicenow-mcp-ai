import { JiraError, type ServiceNowErrorOptions } from "../errors.js";
import { getDispatcher } from "../dispatcher.js";
import { rawRequest, readBodyBytes, readJsonBody } from "../http-util.js";
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
  /** Caller cancellation: aborts the in-flight attempt and stops retrying. */
  signal?: AbortSignal;
  /** Per-attempt timeout override for this call (default SN_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Skip the per-host request queue (diagnostics only). */
  bypassQueue?: boolean;
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

function makeJiraError(
  message: string,
  status?: number,
  detail?: unknown,
  options?: ServiceNowErrorOptions,
): JiraError {
  return new JiraError(message, status, detail, options);
}

/**
 * Perform an authenticated request against the configured Jira Cloud site.
 *
 * The Jira-flavoured twin of snRequest: the host is resolved and SSRF-checked
 * before any network call; everything below the URL (identity header, proxy
 * dispatcher, bounded queue, timeout, deadline, retry matrix, error shaping,
 * telemetry) is the shared rawRequest primitive, so the two clients cannot
 * drift. A non-idempotent write is never replayed on a transport error or on a
 * gateway/unavailable response (502/503/504), whose outcome is unknown, so a
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
  signal,
  timeoutMs,
  bypassQueue,
}: JiraRequestArgs): Promise<JiraResponse<T>> {
  const { site, email, apiToken } = getJiraCredentials();
  if (!site) {
    throw new JiraError(
      "Jira site is not configured. Use the jira_set_credentials tool first (or set JIRA_SITE).",
      undefined,
      undefined,
      { code: "NOT_CONFIGURED" },
    );
  }
  if (!email || !apiToken) {
    throw new JiraError(
      "Jira auth requires JIRA_EMAIL and JIRA_API_TOKEN. Use the jira_set_credentials tool first.",
      undefined,
      undefined,
      { code: "NOT_CONFIGURED" },
    );
  }

  if (form !== undefined && body !== undefined) {
    throw new JiraError(
      "A Jira request cannot carry both a JSON body and a form; pass only one.",
      undefined,
      undefined,
      { code: "INVALID_INPUT" },
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
        undefined,
        undefined,
        { code: "INVALID_INPUT" },
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

  // Proxy and CA policy apply to Atlassian too; the ServiceNow client
  // certificate identity does not.
  const dispatcher = await getDispatcher(host, { clientCert: false });

  const res = await rawRequest({
    url,
    safeUrl,
    method,
    host,
    system: "Jira",
    headers: () => headers,
    body: payload,
    dispatcher,
    extractDetail: extractJiraErrorDetail,
    makeError: makeJiraError,
    signal,
    timeoutMs,
    bypassQueue,
  });

  const responseContentType = res.headers.get("content-type") ?? undefined;

  if (responseType === "binary") {
    const buf = await readBodyBytes(res, {
      system: "Jira",
      safeUrl,
      makeError: makeJiraError,
    });
    return {
      data: buf.toString("base64") as unknown as T,
      status: res.status,
      contentType: responseContentType,
    };
  }

  return {
    data: (await readJsonBody(res, {
      system: "Jira",
      safeUrl,
      makeError: makeJiraError,
    })) as T,
    status: res.status,
    contentType: responseContentType,
  };
}
