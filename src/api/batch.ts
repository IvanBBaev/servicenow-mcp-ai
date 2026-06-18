import { snRequest } from "../core/http.js";
import {
  assertTableAllowed,
  assertWriteAllowed,
  assertPackageAllowed,
  assertPackageWriteAllowed,
} from "../core/policy.js";
import { ServiceNowError } from "../core/errors.js";

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

/**
 * Map a sub-request path to the tool package that owns that REST surface, so a
 * batch cannot bypass SN_PACKAGES_DENY / SN_PACKAGES_READONLY: a denied
 * package's API must stay unreachable and a read-only package's writes must be
 * refused even inside a batch (the package axis otherwise only filters at tool
 * registration, which batch sub-requests skip). Unknown paths return undefined
 * and fall back to the table/read-only axes alone.
 */
const PACKAGE_BY_PATH: [RegExp, string][] = [
  [/^\/api\/sn_sc(?:\/|$)/i, "catalog"],
  [/^\/api\/sn_chg_rest(?:\/|$)/i, "change"],
  [/^\/api\/sn_km_api(?:\/|$)/i, "knowledge"],
  [/^\/api\/now\/(?:v\d+\/)?email(?:\/|$)/i, "email"],
  [/^\/api\/now\/(?:v\d+\/)?cmdb(?:\/|$)/i, "cmdb"],
  [/^\/api\/now\/(?:v\d+\/)?import(?:\/|$)/i, "importset"],
  [/^\/api\/now\/(?:v\d+\/)?stats(?:\/|$)/i, "aggregate"],
  [/^\/api\/now\/(?:v\d+\/)?attachment(?:\/|$)/i, "attachment"],
  [/^\/api\/now\/(?:v\d+\/)?table(?:\/|$)/i, "table"],
];

function packageForUrl(url: string): string | undefined {
  const path = url.split(/[?#]/, 1)[0] ?? url;
  for (const [re, pkg] of PACKAGE_BY_PATH) {
    if (re.test(path)) return pkg;
  }
  return undefined;
}

/** True when a path contains an empty (`//`), `.` or `..` segment. */
function hasTraversalSegments(path: string): boolean {
  const segments = path.split("/");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // segments[0] is "" (paths start with "/"); a single trailing "" is just a
    // trailing slash. Any other empty segment is "//"; "." / ".." are traversal.
    const trailingSlash = seg === "" && i === segments.length - 1 && i > 0;
    if (
      (seg === "" && i !== 0 && !trailingSlash) ||
      seg === "." ||
      seg === ".."
    ) {
      return true;
    }
  }
  return false;
}

/**
 * ServiceNow's batch dispatcher normalizes a sub-request path (collapses `//`,
 * resolves `.`/`..`, and percent-decodes) before routing it, so a non-canonical
 * path such as `/api/now//table/x`, `/api/now/y/../table/x` or its encoded form
 * `/api/now/%2e%2e/table/x` would reach a surface the anchored matchers above
 * never see — bypassing every path-based guard (`SN_TABLES_*`, `SN_PACKAGES_*`).
 * A legitimate ServiceNow REST path is plain and canonical, so any such segment
 * (raw or percent-encoded) is refused before policy matching, which guarantees
 * the path we check is the path ServiceNow executes.
 */
function assertCanonicalPath(url: string, index: number): void {
  const rawPath = url.split(/[?#]/, 1)[0] ?? url;
  let decodedPath = rawPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    // malformed percent-encoding — police the raw form only
  }
  if (hasTraversalSegments(rawPath) || hasTraversalSegments(decodedPath)) {
    throw new ServiceNowError(
      `Sub-request ${index + 1} has a non-canonical path "${rawPath}"; '//', '/./', '/../' (or their percent-encoded forms) are not allowed — they would bypass the access policy.`,
      400,
    );
  }
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
    // Reject path-traversal/empty-segment tricks before matching, so the path
    // we police is exactly the one ServiceNow will normalize and route.
    assertCanonicalPath(req.url, index);
    // Enforce policy before sending: writes respect read-only mode, table
    // paths respect the allow/deny list, and plugin-API paths respect the
    // package allow/deny + read-only axes — so the batch cannot bypass guards.
    if (req.method !== "GET") assertWriteAllowed(`batch ${req.method}`);
    const table = tableFromUrl(req.url);
    if (table) assertTableAllowed(table);
    const pkg = packageForUrl(req.url);
    if (pkg) {
      assertPackageAllowed(pkg);
      if (req.method !== "GET") {
        assertPackageWriteAllowed(pkg, `batch ${req.method}`);
      }
    }

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
