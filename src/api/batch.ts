import { snRequest } from "../http.js";
import { assertTableAllowed, assertWriteAllowed } from "../policy.js";
import { ServiceNowError } from "../errors.js";

/**
 * ServiceNow Batch API (`/api/now/v1/batch`): run several REST calls in a
 * single HTTP round-trip. Request and response bodies are base64-encoded on
 * the wire, which this module handles so callers work with plain JSON.
 *
 * The same table-policy and read-only guards as the rest of the client are
 * applied per sub-request before anything is sent: any non-GET method is
 * treated as a write, and table paths are checked against the allow/deny list.
 */

export interface BatchSubRequest {
  /** Optional caller id echoed back in the result; auto-assigned when omitted. */
  id?: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** API path under the instance origin, e.g. "/api/now/table/incident". */
  url: string;
  /** JSON body for write methods; base64-encoded into the batch payload. */
  body?: unknown;
  /** Extra request headers. Accept/Content-Type are added automatically. */
  headers?: { name: string; value: string }[];
}

export interface BatchResult {
  id: string;
  statusCode: number;
  /** Decoded response body: parsed JSON when possible, otherwise raw text. */
  body?: unknown;
  headers?: { name: string; value: string }[];
  executionTime?: number;
  /** Present when ServiceNow could not service the sub-request at all. */
  error?: string;
}

interface RestRequestPayload {
  id: string;
  method: string;
  url: string;
  headers: { name: string; value: string }[];
  body?: string;
}

interface ServicedResponse {
  id?: string;
  status_code?: number;
  body?: string;
  headers?: { name: string; value: string }[];
  execution_time?: number;
}

interface UnservicedResponse {
  id?: string;
  error?: string;
  error_message?: string;
}

interface BatchApiResponse {
  batch_request_id?: string;
  serviced_requests?: ServicedResponse[];
  unserviced_requests?: UnservicedResponse[];
}

/**
 * Best-effort extraction of the table/class name from a sub-request path, so
 * the allow/deny policy also covers Stats, Import Set and CMDB Instance URLs —
 * not just the Table API.
 */
function tableFromUrl(url: string): string | undefined {
  const match =
    /\/api\/now\/(?:v\d+\/)?(?:table|stats|import)\/([^/?]+)/i.exec(url) ??
    /\/api\/now\/(?:v\d+\/)?cmdb\/instance\/([^/?]+)/i.exec(url);
  const name = match?.[1];
  return name ? decodeURIComponent(name) : undefined;
}

function hasHeader(headers: { name: string }[], name: string): boolean {
  return headers.some((h) => h.name.toLowerCase() === name.toLowerCase());
}

function decodeBody(encoded: string | undefined): unknown {
  if (!encoded) return undefined;
  const text = Buffer.from(encoded, "base64").toString("utf8");
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Run a set of REST sub-requests through the Batch API in one HTTP call. */
export async function runBatch(
  requests: BatchSubRequest[],
): Promise<BatchResult[]> {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new ServiceNowError("A batch needs at least one sub-request.");
  }

  const restRequests: RestRequestPayload[] = requests.map((req, index) => {
    // Only the REST surface: same-host endpoints like /oauth_token.do or
    // /login.do are outside the policy model and must not be reachable.
    if (!req.url || !req.url.startsWith("/api/")) {
      throw new ServiceNowError(
        `Sub-request ${index + 1} must target a REST API path starting with "/api/".`,
      );
    }
    // Enforce policy before sending: writes respect read-only mode and table
    // paths respect the allow/deny list, so the batch cannot bypass guards.
    if (req.method !== "GET") assertWriteAllowed(`batch ${req.method}`);
    const table = tableFromUrl(req.url);
    if (table) assertTableAllowed(table);

    const headers = [...(req.headers ?? [])];
    if (!hasHeader(headers, "Accept")) {
      headers.push({ name: "Accept", value: "application/json" });
    }
    const payload: RestRequestPayload = {
      id: req.id ?? String(index + 1),
      method: req.method,
      url: req.url,
      headers,
    };
    if (req.body !== undefined) {
      if (!hasHeader(headers, "Content-Type")) {
        headers.push({ name: "Content-Type", value: "application/json" });
      }
      payload.body = Buffer.from(JSON.stringify(req.body), "utf8").toString(
        "base64",
      );
    }
    return payload;
  });

  const { data } = await snRequest<BatchApiResponse>({
    method: "POST",
    path: "/api/now/v1/batch",
    body: { batch_request_id: "1", rest_requests: restRequests },
  });

  const results: BatchResult[] = (data.serviced_requests ?? []).map((r) => ({
    id: String(r.id ?? ""),
    statusCode: r.status_code ?? 0,
    body: decodeBody(r.body),
    headers: r.headers,
    executionTime: r.execution_time,
  }));

  for (const u of data.unserviced_requests ?? []) {
    results.push({
      id: String(u.id ?? ""),
      statusCode: 0,
      error: u.error_message || u.error || "Request was not serviced.",
    });
  }

  return results;
}
