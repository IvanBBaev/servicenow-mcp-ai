import { ServiceNowError } from "./errors.js";
import { snRequest } from "./http.js";
import { assertTableAllowed, assertWriteAllowed } from "./policy.js";
import { getMaxRecords, MAX_PAGE_SIZE } from "./settings.js";

// Re-exported so existing imports and host/SSRF unit tests keep working.
export { ServiceNowError } from "./errors.js";
export { _buildBaseUrl } from "./host.js";

export interface QueryOptions {
  table: string;
  query?: string;
  fields?: string[];
  limit?: number;
  offset?: number;
  displayValue?: "true" | "false" | "all";
  /** Page through all matching records (up to SN_MAX_RECORDS) instead of one page. */
  fetchAll?: boolean;
}

export type SnRecord = Record<string, unknown>;

export interface QueryResult {
  records: SnRecord[];
  total?: number;
}

function tablePath(table: string): string {
  return `/api/now/table/${encodeURIComponent(table)}`;
}

function recordPath(table: string, sysId: string): string {
  return `/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}`;
}

/** Fetch a single page of records (and the X-Total-Count when present). */
async function queryPage(
  opts: QueryOptions,
  limit: number,
  offset: number,
): Promise<QueryResult> {
  const params = new URLSearchParams();
  if (opts.query) params.set("sysparm_query", opts.query);
  if (opts.fields?.length) params.set("sysparm_fields", opts.fields.join(","));
  params.set("sysparm_limit", String(limit));
  if (offset) params.set("sysparm_offset", String(offset));
  params.set("sysparm_display_value", opts.displayValue ?? "false");

  const { data, total } = await snRequest<{ result: SnRecord[] }>({
    method: "GET",
    path: tablePath(opts.table),
    params,
  });
  if (!Array.isArray(data?.result)) {
    throw new ServiceNowError(
      "Unexpected response from ServiceNow Table API: missing 'result' array.",
    );
  }
  return { records: data.result, total };
}

/**
 * Read records from a table. By default returns a single page of up to `limit`
 * records (default 10). When `fetchAll` is set, pages through every matching
 * record in batches, up to the SN_MAX_RECORDS safety cap. `total` reflects the
 * server's X-Total-Count (all matching rows), when provided.
 */
export async function queryTable(opts: QueryOptions): Promise<QueryResult> {
  assertTableAllowed(opts.table);
  if (!opts.fetchAll) {
    return queryPage(opts, opts.limit ?? 10, opts.offset ?? 0);
  }

  const pageSize = Math.min(opts.limit ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  const cap = getMaxRecords();
  const records: SnRecord[] = [];
  let total: number | undefined;
  let offset = opts.offset ?? 0;

  for (;;) {
    const want = Math.min(pageSize, cap - records.length);
    if (want <= 0) break;
    const page = await queryPage(opts, want, offset);
    if (total === undefined) total = page.total;
    records.push(...page.records);
    if (page.records.length < want) break; // server returned fewer => no more rows
    offset += page.records.length;
  }

  return { records, total };
}

/** Read a single record by sys_id. */
export async function getRecord(
  table: string,
  sysId: string,
  fields?: string[],
): Promise<SnRecord> {
  assertTableAllowed(table);
  const params = new URLSearchParams();
  if (fields?.length) params.set("sysparm_fields", fields.join(","));

  const { data } = await snRequest<{ result: SnRecord }>({
    method: "GET",
    path: recordPath(table, sysId),
    params,
  });
  if (!data || data.result == null) {
    throw new ServiceNowError(
      "Unexpected response from ServiceNow Table API: missing 'result'.",
    );
  }
  return data.result;
}

/** Create a new record. */
export async function createRecord(
  table: string,
  fields: SnRecord,
): Promise<SnRecord> {
  assertTableAllowed(table);
  assertWriteAllowed("create");
  const { data } = await snRequest<{ result: SnRecord }>({
    method: "POST",
    path: tablePath(table),
    body: fields,
  });
  if (!data || data.result == null) {
    throw new ServiceNowError(
      "Unexpected response from ServiceNow Table API: missing 'result'.",
    );
  }
  return data.result;
}

/** Update an existing record by sys_id. */
export async function updateRecord(
  table: string,
  sysId: string,
  fields: SnRecord,
): Promise<SnRecord> {
  assertTableAllowed(table);
  assertWriteAllowed("update");
  const { data } = await snRequest<{ result: SnRecord }>({
    method: "PATCH",
    path: recordPath(table, sysId),
    body: fields,
  });
  if (!data || data.result == null) {
    throw new ServiceNowError(
      "Unexpected response from ServiceNow Table API: missing 'result'.",
    );
  }
  return data.result;
}

/** Delete a record by sys_id. */
export async function deleteRecord(
  table: string,
  sysId: string,
): Promise<{ deleted: true; table: string; sys_id: string }> {
  assertTableAllowed(table);
  assertWriteAllowed("delete");
  await snRequest<unknown>({
    method: "DELETE",
    path: recordPath(table, sysId),
  });
  return { deleted: true, table, sys_id: sysId };
}
