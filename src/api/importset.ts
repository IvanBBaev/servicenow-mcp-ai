import { promises as fs } from "node:fs";
import path from "node:path";
import { ServiceNowError } from "../core/errors.js";
import { snRequest } from "../core/http.js";
import {
  assertImportSetTable,
  assertTableAllowed,
  assertTableWriteAllowed,
  assertWriteAllowed,
} from "../core/policy.js";
import { throwIfCancelled } from "../core/progress.js";
import { getDocsMaxFileBytes } from "../core/settings.js";
import {
  appendWriteJournal,
  journaledWrite,
  sha256Hex,
  ulid,
  writeOutcome,
  type JournalInput,
} from "../core/write-journal.js";
import { resolveUploadPath } from "./attachment.js";
import { errorCode, tooLarge } from "./docs-paths.js";
import { queryTable, type SnRecord } from "./table.js";
import { assertNoCaret, snString } from "./shared.js";

/**
 * ServiceNow Import Set API: push rows into a staging table and let the
 * configured transform maps run, returning the transform result (created or
 * updated target records, or errors). N-68 adds several rows per call and
 * rows read from a CSV / JSONL file under SN_DOCS_DIR.
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
  // H-11: a staging table (SN_IMPORT_SET_TABLES), then the write rules.
  assertImportSetTable(stagingTable);
  assertTableWriteAllowed(stagingTable);
  assertWriteAllowed("import-set insert");
  const { data } = await snRequest<ImportSetResult>({
    method: "POST",
    path: `/api/now/import/${encodeURIComponent(stagingTable)}`,
    body: record,
  });
  return data;
}

/** A staging row as the tool accepts it: scalar column values only. */
export type ImportRow = Record<string, string | number | boolean | null>;

/** The most rows one call sends (N-68); a bigger file is split by the caller. */
export const IMPORT_MAX_ROWS = 500;

/**
 * Insert several rows in one request (`insertMultiple`). Verified on a PDI
 * (OD-14): it answers with an asynchronous import set, and keeps the values
 * only when the staging table has an insertMultiple mapping
 * (`insertMultipleMappingWarning`). A 404 or 405 reports it absent (`null`)
 * and the caller falls back to one request per row.
 */
export async function insertImportSetRows(
  stagingTable: string,
  records: ImportRow[],
): Promise<ImportSetResult | null> {
  assertImportSetTable(stagingTable);
  assertTableWriteAllowed(stagingTable);
  assertWriteAllowed("import-set insert");
  try {
    const { data } = await snRequest<ImportSetResult>({
      method: "POST",
      path: `/api/now/import/${encodeURIComponent(stagingTable)}/insertMultiple`,
      body: { records },
    });
    return data;
  } catch (error) {
    if (
      error instanceof ServiceNowError &&
      (error.status === 404 || error.status === 405)
    ) {
      return null;
    }
    throw error;
  }
}

/** Where a multi-row import came from, for the preview and the journal. */
export interface ImportSource {
  file_path: string;
  format: "csv" | "jsonl";
}

/** What a multi-row import returns; a row failure is reported, not thrown. */
export interface ImportRowsOutcome {
  /** `insertMultiple` — one request; `sequential` — one per row (the endpoint was absent). */
  mode: "insertMultiple" | "sequential";
  /** Rows given. */
  rows: number;
  /** Rows that reached the instance (all of them, or the ones before the first failure). */
  sent: number;
  /** One Import Set API response per request made. */
  results: ImportSetResult[];
  /** Import set numbers the responses named. */
  import_sets: string[];
  /** The first row that failed in sequential mode; the rows after it were not sent. */
  failed?: { index: number; error: string; code?: string };
}

/** The column names of a row set, in order of first appearance. */
export function columnsOf(rows: ImportRow[]): string[] {
  const columns = new Set<string>();
  for (const row of rows)
    for (const name of Object.keys(row)) columns.add(name);
  return [...columns];
}

function importSetsOf(results: ImportSetResult[]): string[] {
  return [...new Set(results.map((r) => importBody(r).number).filter(Boolean))];
}

type RowLine = Pick<JournalInput, "fields" | "result" | "error">;

async function sendRows(
  stagingTable: string,
  rows: ImportRow[],
  lines: RowLine[],
): Promise<ImportRowsOutcome> {
  const multi = await insertImportSetRows(stagingTable, rows);
  if (multi) {
    return {
      mode: "insertMultiple",
      rows: rows.length,
      sent: rows.length,
      results: [multi],
      import_sets: importSetsOf([multi]),
    };
  }
  const results: ImportSetResult[] = [];
  let failed: ImportRowsOutcome["failed"];
  for (const [index, row] of rows.entries()) {
    throwIfCancelled();
    try {
      results.push(await insertImportSetRow(stagingTable, row));
      lines.push({ fields: row, result: "applied" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof ServiceNowError ? error.code : undefined;
      failed = { index, error: message, ...(code ? { code } : {}) };
      lines.push({ fields: row, result: writeOutcome(error), error: message });
      break;
    }
  }
  return {
    mode: "sequential",
    rows: rows.length,
    sent: results.length,
    results,
    import_sets: importSetsOf(results),
    ...(failed ? { failed } : {}),
  };
}

/**
 * N-68 — import several rows under one journal envelope (weight = the row
 * count, so the H-11 caps see every row before anything is sent): one
 * `insertMultiple` request when the instance has it, else one request per
 * row, stopping at the first failure. In sequential mode every row sent gets
 * its own journal line, linked to the envelope by `batch_id` like a batch.
 */
export async function importRows(
  stagingTable: string,
  rows: ImportRow[],
  source?: ImportSource,
): Promise<ImportRowsOutcome> {
  const batchId = ulid();
  const lines: RowLine[] = [];
  try {
    return await journaledWrite(
      {
        action: "create",
        table: stagingTable,
        fields: {
          rows: rows.length,
          columns: columnsOf(rows),
          ...(source ?? {}),
        },
        batch_id: batchId,
        body_sha256: sha256Hex(JSON.stringify(rows)),
      },
      () => sendRows(stagingTable, rows, lines),
      (outcome) =>
        outcome.failed
          ? {
              result: "failed",
              error: `row ${outcome.failed.index}: ${outcome.failed.error}`,
            }
          : {},
      { writes: rows.length, deletes: 0 },
    );
  } finally {
    // The rows that were sent are journaled even when the loop was cancelled.
    for (const line of lines) {
      appendWriteJournal({
        action: "create",
        table: stagingTable,
        batch_id: batchId,
        ...line,
      });
    }
  }
}

function invalid(message: string, hint?: string): ServiceNowError {
  return new ServiceNowError(message, undefined, undefined, {
    code: "INVALID_INPUT",
    ...(hint ? { hint } : {}),
  });
}

const FILE_HINT =
  "file_path is relative to SN_DOCS_DIR (an absolute path must lie inside it): a .csv with a header row or a .jsonl with one object per line.";

/** Blank lines between records are skipped. */
function isBlank(cells: string[]): boolean {
  return cells.length === 1 && cells[0] === "";
}

/**
 * RFC 4180 CSV: the first record names the columns, a quoted field may hold
 * commas, doubled quotes and line breaks, and records end in LF or CRLF.
 * Every value stays a string; the transform map converts it.
 */
function parseCsv(text: string, rel: string): ImportRow[] {
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  const endCell = (): void => {
    cells.push(cell);
    cell = "";
  };
  const endRecord = (): void => {
    endCell();
    records.push({ line: start, cells });
    cells = [];
    start = line;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') {
        if (c === "\n") line++;
        cell += c;
      } else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = false;
      }
    } else if (c === '"' && cell === "") {
      quoted = true;
    } else if (c === ",") {
      endCell();
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      line++;
      endRecord();
    } else {
      cell += c;
    }
  }
  if (quoted) {
    throw invalid(
      `${rel}: the quoted field starting on line ${start} is not closed.`,
    );
  }
  if (cell !== "" || cells.length) endRecord();
  const [header, ...body] = records.filter((r) => !isBlank(r.cells));
  if (!header) throw invalid(`${rel} has no header row.`);
  const columns = header.cells.map((name) => name.trim());
  const empty = columns.indexOf("");
  if (empty !== -1) {
    throw invalid(`${rel}: header column ${empty + 1} is empty.`);
  }
  if (new Set(columns).size !== columns.length) {
    throw invalid(`${rel}: header column names must be unique.`);
  }
  return body.map(({ line: at, cells: values }) => {
    if (values.length !== columns.length) {
      throw invalid(
        `${rel} line ${at}: expected ${columns.length} fields, got ${values.length}.`,
      );
    }
    return Object.fromEntries(
      columns.map((name, i) => [name, values[i] ?? ""]),
    );
  });
}

const SCALARS = new Set(["string", "number", "boolean"]);

/** JSON Lines: one flat object with scalar values per non-empty line. */
function parseJsonl(text: string, rel: string): ImportRow[] {
  const rows: ImportRow[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const where = `${rel} line ${i + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // swallowed: the line number is the useful detail, not the parser's offset
      throw invalid(`${where}: not valid JSON.`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw invalid(`${where}: expected a JSON object.`);
    }
    for (const [name, v] of Object.entries(value)) {
      if (!name) throw invalid(`${where}: a column name is empty.`);
      if (v !== null && !SCALARS.has(typeof v)) {
        throw invalid(
          `${where}: column ${name} must be a string, number, boolean or null.`,
        );
      }
    }
    rows.push(value as ImportRow);
  });
  return rows;
}

/**
 * N-68 — read the rows of a CSV or JSONL file under SN_DOCS_DIR, confined
 * like an upload (H-5) and size-checked against SN_DOCS_MAX_FILE_BYTES
 * before the read.
 */
export async function loadImportRows(
  filePath: string,
): Promise<{ rows: ImportRow[]; rel: string; format: ImportSource["format"] }> {
  const { abs, rel } = resolveUploadPath(filePath);
  const ext = path.extname(abs).toLowerCase();
  if (ext !== ".csv" && ext !== ".jsonl") {
    throw invalid(
      `Only .csv and .jsonl import files are supported: ${rel}`,
      FILE_HINT,
    );
  }
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch (e) {
    if (errorCode(e) === "ENOENT") {
      throw invalid(`File not found: ${rel}`, FILE_HINT);
    }
    throw e;
  }
  if (!stat.isFile()) throw invalid(`Not a regular file: ${rel}`);
  const max = getDocsMaxFileBytes();
  if (stat.size > max) throw tooLarge(rel, stat.size, max);
  const bytes = await fs.readFile(abs);
  // The file may have grown between the stat and the read.
  if (bytes.length > max) throw tooLarge(rel, bytes.length, max);
  const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
  const format = ext === ".csv" ? "csv" : "jsonl";
  const rows = format === "csv" ? parseCsv(text, rel) : parseJsonl(text, rel);
  if (!rows.length) throw invalid(`${rel} has no data rows.`);
  if (rows.length > IMPORT_MAX_ROWS) {
    throw invalid(
      `${rel} has ${rows.length} rows, over the ${IMPORT_MAX_ROWS}-row limit of one call.`,
      "Split the file and import it in several calls.",
    );
  }
  return { rows, rel, format };
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
 * OD-14 — `insertMultiple` maps a row's keys to staging columns through an
 * active `sys_rest_insert_multiple` record of the staging table (with a
 * `sys_rest_insert_multiple_column_mapping` row: by label, or by column
 * name). Without one the instance creates the rows and leaves every column
 * empty, so this reports the gap; a failed lookup is reported, never thrown.
 */
export async function insertMultipleMappingWarning(
  stagingTable: string,
): Promise<string | undefined> {
  assertNoCaret(stagingTable, "table");
  try {
    const { records } = await queryTable({
      table: "sys_rest_insert_multiple",
      query: `source_table=${stagingTable}^active=true`,
      fields: ["sys_id"],
      displayValue: "false",
      limit: 1,
    });
    if (records.length) return undefined;
    return `sys_rest_insert_multiple: no active record for ${stagingTable}, so insertMultiple creates the rows but leaves every column empty. Create one with a column mapping (sys_rest_insert_multiple_column_mapping, 'Column name' for rows keyed by column name), or send the rows one at a time (values).`;
  } catch (error) {
    return `sys_rest_insert_multiple: ${(error as Error).message}`;
  }
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
