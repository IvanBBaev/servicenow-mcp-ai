import { snRequest } from "../http.js";
import { assertTableAllowed, assertWriteAllowed } from "../policy.js";
import type { SnRecord } from "../servicenow.js";

/**
 * ServiceNow Import Set API: push a row into a staging table and let the
 * configured transform maps run, returning the transform result (created or
 * updated target records, or errors).
 */

export interface ImportSetResult {
  import_set?: string;
  staging_table?: string;
  result?: unknown;
  [key: string]: unknown;
}

/** Insert a single row into a staging table and run its transform. */
export async function insertImportSetRow(
  stagingTable: string,
  record: SnRecord,
): Promise<ImportSetResult> {
  assertTableAllowed(stagingTable);
  assertWriteAllowed("import-set insert");
  const { data } = await snRequest<ImportSetResult>({
    method: "POST",
    path: `/api/now/import/${encodeURIComponent(stagingTable)}`,
    body: record,
  });
  return data;
}

/** Read the outcome for a previously inserted staging row. */
export async function getImportSetRow(
  stagingTable: string,
  sysId: string,
): Promise<ImportSetResult> {
  assertTableAllowed(stagingTable);
  const { data } = await snRequest<ImportSetResult>({
    method: "GET",
    path: `/api/now/import/${encodeURIComponent(stagingTable)}/${encodeURIComponent(sysId)}`,
  });
  return data;
}
