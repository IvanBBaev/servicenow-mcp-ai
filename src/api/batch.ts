import { snRequest } from "../core/http.js";
import {
  assertTableAllowed,
  assertTableWriteAllowed,
  assertWriteAllowed,
  assertPackageAllowed,
  assertPackageWriteAllowed,
  getAllowedTables,
  getDeniedTables,
} from "../core/policy.js";
import {
  getBatchMaxRequests,
  getBatchUnmapped,
  getMaxBatchWrites,
} from "../core/settings.js";
import { getAttachmentMeta } from "./attachment.js";
import { ServiceNowError } from "../core/errors.js";
import { reportProgress } from "../core/progress.js";

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
export const PACKAGE_BY_PATH: [RegExp, string][] = [
  [/^\/api\/sn_sc(?:\/|$)/i, "catalog"],
  [/^\/api\/sn_cicd(?:\/|$)/i, "atf"],
  [/^\/api\/sn_codesearch(?:\/|$)/i, "scripts"],
  [/^\/api\/now\/(?:v\d+\/)?identifyreconcile(?:\/|$)/i, "cmdb"],
  [/^\/api\/sn_chg_rest(?:\/|$)/i, "change"],
  [/^\/api\/sn_km_api(?:\/|$)/i, "knowledge"],
  [/^\/api\/now\/(?:v\d+\/)?email(?:\/|$)/i, "email"],
  [/^\/api\/now\/(?:v\d+\/)?cmdb(?:\/|$)/i, "cmdb"],
  [/^\/api\/now\/(?:v\d+\/)?import(?:\/|$)/i, "importset"],
  [/^\/api\/now\/(?:v\d+\/)?stats(?:\/|$)/i, "aggregate"],
  [/^\/api\/now\/(?:v\d+\/)?attachment(?:\/|$)/i, "attachment"],
  [/^\/api\/now\/(?:v\d+\/)?table(?:\/|$)/i, "table"],
];

export function packageForUrl(url: string): string | undefined {
  const path = url.split(/[?#]/, 1)[0] ?? url;
  for (const [re, pkg] of PACKAGE_BY_PATH) {
    if (re.test(path)) return pkg;
  }
  return undefined;
}

/** A batch inside a batch would hide its sub-requests from every guard. */
const NESTED_BATCH = /^\/api\/now\/(?:v\d+\/)?batch(?:\/|$)/i;

/** `/api/now/attachment/<sys_id>[/file]` — the parent table is not in the path. */
const ATTACHMENT_BY_ID =
  /^\/api\/now\/(?:v\d+\/)?attachment\/(?!file(?:$|\/))([^/?#]+)(?:\/file)?\/?$/i;

/** `/api/now/attachment` (list) and `/api/now/attachment/file` (upload). */
const ATTACHMENT_ROOT = /^\/api\/now\/(?:v\d+\/)?attachment(?:\/file)?\/?$/i;

function tablePolicyActive(): boolean {
  return getAllowedTables().length > 0 || getDeniedTables().length > 0;
}

/**
 * H-4: every table a sub-request names — in its path (Table, Stats, Import
 * Set, CMDB instance), its query (`table_name`, or `table_name=` inside an
 * attachment `sysparm_query`) and its body (`table_name` of an Email API
 * send, the item classes of an IRE payload). Headers carry no table on any
 * REST API this server maps.
 */
export function tablesForSubRequest(req: {
  url: string;
  body?: unknown;
}): string[] {
  const tables = new Set<string>();
  const fromPath = tableFromUrl(req.url);
  if (fromPath) tables.add(fromPath);
  const query = req.url.includes("?")
    ? new URLSearchParams(req.url.slice(req.url.indexOf("?") + 1).split("#")[0])
    : undefined;
  const qTable = query?.get("table_name");
  if (qTable) tables.add(qTable);
  if (ATTACHMENT_ROOT.test(pathOf(req.url))) {
    for (const [, t] of (query?.get("sysparm_query") ?? "").matchAll(
      /(?:^|\^)table_name=([^^]+)/g,
    )) {
      if (t) tables.add(t);
    }
  }
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    const body = req.body as Record<string, unknown>;
    if (typeof body.table_name === "string" && body.table_name) {
      tables.add(body.table_name);
    }
    if (packageForUrl(req.url) === "cmdb" && Array.isArray(body.items)) {
      for (const item of body.items) {
        const cls = (item as { className?: unknown } | null)?.className;
        if (typeof cls === "string" && cls) tables.add(cls);
      }
      if (Array.isArray(body.relations) && body.relations.length > 0) {
        tables.add("cmdb_rel_ci");
      }
    }
  }
  return [...tables];
}

function pathOf(url: string): string {
  return url.split(/[?#]/, 1)[0] ?? url;
}

/**
 * H-4: a sub-request that names its target only by attachment sys_id is
 * governed by the attachment's parent table — resolved with one metadata read
 * (which applies the table policy) while a table policy is configured. An
 * unscoped attachment list is refused then: its rows could come from any table.
 */
async function assertAttachmentScope(
  req: BatchSubRequest,
  index: number,
  named: string[],
): Promise<void> {
  if (!tablePolicyActive()) return;
  const path = pathOf(req.url);
  const byId = ATTACHMENT_BY_ID.exec(path);
  if (byId?.[1]) {
    await getAttachmentMeta(decodeURIComponent(byId[1]));
    return;
  }
  if (req.method === "GET" && ATTACHMENT_ROOT.test(path) && !named.length) {
    throw new ServiceNowError(
      `Sub-request ${index + 1} lists attachments without naming a table (table_name) while SN_TABLES_ALLOW / SN_TABLES_DENY is set — its rows could come from a denied table. Use servicenow_list_attachments, or add table_name=<table> to sysparm_query.`,
      403,
    );
  }
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

  // H-4 (L2-03): the size cap is checked before any sub-request is built.
  const max = getBatchMaxRequests();
  if (requests.length > max) {
    throw new ServiceNowError(
      `A batch may carry at most ${max} sub-requests (SN_BATCH_MAX_REQUESTS); this one has ${requests.length}. Split it.`,
      400,
    );
  }
  // H-11 (L3-02): the per-batch write cap, also before anything is built.
  const maxWrites = getMaxBatchWrites();
  const writes = requests.filter((r) => r.method !== "GET").length;
  if (maxWrites && writes > maxWrites) {
    throw new ServiceNowError(
      `A batch may carry at most ${maxWrites} write sub-requests (SN_MAX_BATCH_WRITES); this one has ${writes}. Nothing was sent.`,
      429,
      undefined,
      {
        code: "WRITE_CAP",
        hint: "Split the batch or raise SN_MAX_BATCH_WRITES.",
      },
    );
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
    if (NESTED_BATCH.test(pathOf(req.url))) {
      throw new ServiceNowError(
        `Sub-request ${index + 1} targets the Batch API itself; a nested batch would hide its sub-requests from the access policy.`,
        403,
      );
    }
    if (req.method !== "GET") assertWriteAllowed(`batch ${req.method}`);
    // H-11: a write sub-request also meets the protected-table rule.
    const checkTable =
      req.method === "GET" ? assertTableAllowed : assertTableWriteAllowed;
    for (const table of tablesForSubRequest(req)) checkTable(table);
    const pkg = packageForUrl(req.url);
    if (!pkg && getBatchUnmapped() === "deny") {
      throw new ServiceNowError(
        `Sub-request ${index + 1} targets "${pathOf(req.url)}", which no tool package owns, and SN_BATCH_UNMAPPED=deny refuses unmapped REST paths in a batch.`,
        403,
      );
    }
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

  // H-4: the attachment scope needs a metadata read, so it runs after every
  // local check above passed and before the batch is sent.
  for (const [index, req] of requests.entries()) {
    await assertAttachmentScope(req, index, tablesForSubRequest(req));
  }

  // M-3: the Batch API is one round-trip, so progress is two coarse steps —
  // validated and sent, then answered — counted in sub-requests.
  const total = restRequests.length;
  reportProgress({
    progress: 0,
    total,
    message: `sending ${total} sub-request(s)`,
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
  reportProgress({
    progress: total,
    total,
    message: `${data.serviced_requests?.length ?? 0} serviced, ${data.unserviced_requests?.length ?? 0} not serviced`,
  });

  return results;
}
