import { snRequest } from "../core/http.js";
import { assertTableAllowed, assertWriteAllowed } from "../core/policy.js";
import { queryTable, type SnRecord } from "./table.js";
import { snString } from "./shared.js";

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

/** The transform-history row of an import set (`sys_import_set_run`). */
const RUN_FIELDS = [
  "sys_id",
  "state",
  "completion_code",
  "total",
  "inserts",
  "updates",
  "ignored",
  "skipped",
  "errors",
  "sys_created_on",
];

const MAP_FIELDS = ["sys_id", "name", "target_table", "active", "order"];

/** What S-10 adds to an insert result; every read is best-effort. */
export interface ImportRunReport {
  /** The latest `sys_import_set_run` row of the import set, or null when none is visible. */
  import_set_run: SnRecord | null;
  /** Transform maps on the staging table; `used` marks those the row went through. */
  transform_maps: SnRecord[];
  /** One line per read that could not be made (policy, ACL, network). */
  warnings?: string[];
}

/**
 * The import-set number and row results of an Import Set API response. The
 * documented shape is `{ import_set, staging_table, result: [...] }`; some
 * instances (and proxies) wrap it once more in `{ result: {...} }`.
 */
function importBody(response: ImportSetResult): {
  number: string;
  rows: SnRecord[];
} {
  const inner =
    response.result && !Array.isArray(response.result)
      ? (response.result as ImportSetResult)
      : response;
  const rows = Array.isArray(inner.result) ? (inner.result as SnRecord[]) : [];
  return { number: snString(inner.import_set), rows };
}

/**
 * S-10 — after an Import Set API insert, read the transform run it produced
 * (`sys_import_set_run`, matched by the import set number) and the transform
 * maps configured on the staging table (`sys_transform_map`), marking the ones
 * the row results name. Each read degrades to a warning, so the insert result
 * is never lost to a follow-up read.
 */
export async function describeImportRun(
  stagingTable: string,
  response: ImportSetResult,
): Promise<ImportRunReport> {
  const { number, rows } = importBody(response);
  const used = new Set(
    rows.map((r) => snString(r.transform_map)).filter(Boolean),
  );
  const warnings: string[] = [];
  let run: SnRecord | null = null;
  if (/^[A-Za-z0-9_-]{1,40}$/.test(number)) {
    try {
      const { records } = await queryTable({
        table: "sys_import_set_run",
        query: `set.number=${number}^ORDERBYDESCsys_created_on`,
        fields: RUN_FIELDS,
        displayValue: "false",
        limit: 1,
      });
      run = records[0] ?? null;
    } catch (error) {
      warnings.push(`sys_import_set_run: ${(error as Error).message}`);
    }
  } else {
    warnings.push(
      "sys_import_set_run: the response named no import set number to look up.",
    );
  }
  let maps: SnRecord[] = [];
  try {
    const { records } = await queryTable({
      table: "sys_transform_map",
      query: `source_table=${stagingTable}^ORDERBYorder`,
      fields: MAP_FIELDS,
      displayValue: "false",
      limit: 50,
    });
    maps = records.map((m) => ({ ...m, used: used.has(snString(m.name)) }));
  } catch (error) {
    warnings.push(`sys_transform_map: ${(error as Error).message}`);
  }
  // A map named by the row results but not readable from sys_transform_map.
  for (const name of used) {
    if (!maps.some((m) => snString(m.name) === name)) {
      maps.push({ name, used: true });
    }
  }
  return {
    import_set_run: run,
    transform_maps: maps,
    ...(warnings.length ? { warnings } : {}),
  };
}
