import { queryTable, type SnRecord } from "./table.js";
import { describeTable, getTableChain, type ColumnInfo } from "./meta.js";
import { assertNoCaret, snString } from "./shared.js";
import { cached, schemaCacheScope } from "../core/cache.js";
import { ServiceNowError } from "../core/errors.js";

/**
 * N-62 — platform-aware compact reads (dark core; no tool wires it yet). The
 * `query_table` / `get_record` options (`fields:"summary"`,
 * `display_value:"display"`, `omit_empty`, `format:"table"`) and their
 * defaults wait for O-21 (a); the default-view query, the display-field
 * fallback order and the journal handling are unverified until O-5.
 */

/** List columns kept from a layout, besides sys_id, the display field and sys_updated_on. */
export const SUMMARY_MAX_LIST_COLUMNS = 12;

/** Columns tried, in order, when no table of the chain has a default list layout. */
const HEURISTIC_COLUMNS = [
  "number",
  "name",
  "short_description",
  "state",
  "priority",
  "active",
  "assigned_to",
  "assignment_group",
  "category",
  "sys_class_name",
];

export interface SummaryFieldSet {
  table: string;
  field_set: "summary";
  /** The resolved field list: sys_id, the display field, list columns, sys_updated_on. */
  fields: string[];
  displayField?: string;
  /** Where the list columns came from. */
  source: "list_layout" | "heuristic";
  /** The chain table whose default list layout was used (source `list_layout`). */
  layoutTable?: string;
  /** Layout reads that failed (the resolver then walks on or falls back). */
  warnings?: string[];
}

/**
 * The child-most `display=true` column of a table's chain, falling back to
 * `name` and then `number`.
 */
export function pickDisplayField(
  columns: ColumnInfo[],
  chain: string[],
): string | undefined {
  const rank = (c: ColumnInfo): number => {
    const i = chain.indexOf(c.sourceTable ?? "");
    return i < 0 ? chain.length : i;
  };
  const flagged = columns
    .filter((c) => c.display)
    .sort((a, b) => rank(a) - rank(b));
  if (flagged[0]) return flagged[0].element;
  const names = new Set(columns.map((c) => c.element));
  return ["name", "number"].find((n) => names.has(n));
}

const listLayoutQuery = (table: string): string =>
  `list_id.name=${table}^list_id.view.name=NULL^list_id.parentISEMPTY` +
  `^list_id.sys_userISEMPTY^ORDERBYposition`;

/**
 * The `fields:"summary"` resolver: sys_id, the display field, up to 12
 * columns of the default list view and sys_updated_on. A table without a
 * default layout uses its nearest ancestor's; with none in the chain, a
 * heuristic set filtered by the dictionary. Every read is cached per table
 * and profile with the schema (cold: the dictionary reads plus one layout
 * read per chain table tried; warm: none). A failed layout read is not
 * cached, so the next call retries it.
 */
export async function summaryFields(table: string): Promise<SummaryFieldSet> {
  assertNoCaret(table, "table");
  const columns = await describeTable(table);
  const chain = await getTableChain(table);
  const known = new Set(columns.map((c) => c.element));
  const displayField = pickDisplayField(columns, chain);
  const warnings: string[] = [];

  let list: string[] = [];
  let layoutTable: string | undefined;
  for (const t of chain) {
    const elements = await readListLayout(t, warnings);
    // Formatters (".xyz") are not columns; a dot-walk keeps its base column.
    list = elements.filter(
      (e) => e && !e.startsWith(".") && known.has(e.split(".")[0] ?? ""),
    );
    if (list.length) {
      layoutTable = t;
      break;
    }
  }
  const source = layoutTable ? "list_layout" : "heuristic";
  if (!layoutTable) list = HEURISTIC_COLUMNS.filter((c) => known.has(c));

  const head = ["sys_id", ...(displayField ? [displayField] : [])];
  const body = [...new Set(list)]
    .filter((c) => !head.includes(c) && c !== "sys_updated_on")
    .slice(0, SUMMARY_MAX_LIST_COLUMNS);
  return {
    table,
    field_set: "summary",
    fields: [...head, ...body, "sys_updated_on"],
    ...(displayField ? { displayField } : {}),
    source,
    ...(layoutTable ? { layoutTable } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

async function readListLayout(
  table: string,
  warnings: string[],
): Promise<string[]> {
  try {
    return await cached(
      [schemaCacheScope(), "listLayout", table].join("|"),
      async () => {
        const { records } = await queryTable({
          table: "sys_ui_list_element",
          query: listLayoutQuery(table),
          fields: ["element", "position"],
          displayValue: "false",
          limit: 100,
        });
        return records.map((r) => snString(r.element));
      },
    );
  } catch (e) {
    if (e instanceof ServiceNowError && e.code === "CANCELLED") throw e;
    warnings.push(
      `sys_ui_list_element (${table}): unavailable — ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
}

// ── display_value:"display" compaction ───────────────────────────────────

const DATE_TYPES = new Set([
  "glide_date_time",
  "glide_date",
  "glide_time",
  "due_date",
  "calendar_date_time",
  "date",
  "datetime",
]);
const JOURNAL_TYPES = new Set(["journal", "journal_input", "journal_list"]);

/** A compacted cell: a scalar, or `[value, display]` when the two differ. */
export type CompactValue = string | number | boolean | null | [string, string];

interface ValuePair {
  value: string;
  display: string;
}

/** A `display_value=all` cell (`{ value, display_value, link? }`), or undefined. */
function asPair(v: unknown): ValuePair | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (!("value" in o) && !("display_value" in o)) return undefined;
  return { value: snString(o.value), display: snString(o.display_value) };
}

/** `[value, display]` when they differ, the value alone when they match. */
function collapse(p: ValuePair): CompactValue {
  return p.value === p.display ? p.value : [p.value, p.display];
}

function scalar(v: unknown): CompactValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    return v;
  return JSON.stringify(v);
}

/**
 * Compact one `display_value=all` record by dictionary type:
 * - reference → `[sys_id, display]` (empty → `""`);
 * - choice → the label alone when it equals the value, else `[value, label]`;
 * - dates → the raw UTC value;
 * - journal fields → dropped unless `named` lists them;
 * - any other column → its display value.
 * A column the dictionary does not know (a dot-walk) collapses like the
 * table form. Plain values pass through; masking must already have run.
 */
export function compactDisplayRecord(
  record: SnRecord,
  columns: ColumnInfo[],
  named: ReadonlySet<string> = new Set(),
): Record<string, CompactValue> {
  const byElement = new Map(columns.map((c) => [c.element, c]));
  const out: Record<string, CompactValue> = {};
  for (const [field, raw] of Object.entries(record)) {
    const col = byElement.get(field);
    const type = col?.type ?? "";
    if (JOURNAL_TYPES.has(type) && !named.has(field)) continue;
    const pair = asPair(raw);
    if (!pair) {
      out[field] = scalar(raw);
      continue;
    }
    if (!col) out[field] = collapse(pair);
    else if (type === "reference" || col.reference)
      out[field] = pair.value ? [pair.value, pair.display] : "";
    else if (col.choice) out[field] = collapse(pair);
    else if (DATE_TYPES.has(type)) out[field] = pair.value;
    else out[field] = pair.display;
  }
  return out;
}

// ── omit_empty ───────────────────────────────────────────────────────────

/** The note a response carries next to `empty_omitted`. */
export const EMPTY_OMITTED_NOTE =
  "absent column = empty string; columns not in `columns` were not requested; " +
  "a field hidden by ACL may also be absent";

function isEmpty(v: unknown): boolean {
  if (v === "" || v === null || v === undefined) return true;
  const pair = asPair(v);
  if (pair) return pair.value === "" && pair.display === "";
  return Array.isArray(v) && v.every((x) => x === "");
}

/**
 * Drop empty cells (`""`, null, an empty value pair) from records whose
 * column list the response states at the top level. `"0"` and `"false"` are
 * values and stay. Returns the trimmed records and how many cells went.
 */
export function omitEmpty<T extends Record<string, unknown>>(
  records: T[],
): { records: Partial<T>[]; emptyOmitted: number } {
  let emptyOmitted = 0;
  const trimmed = records.map((r) => {
    const kept: Partial<T> = {};
    for (const [k, v] of Object.entries(r)) {
      if (isEmpty(v)) emptyOmitted += 1;
      else kept[k as keyof T] = v as T[keyof T];
    }
    return kept;
  });
  return { records: trimmed, emptyOmitted };
}

// ── format:"table" ───────────────────────────────────────────────────────

export interface TableForm {
  columns: string[];
  rows: CompactValue[][];
  /** How to read a cell. */
  cell: string;
  /** Matching rows on the instance (the read's total), else the rows given. */
  total: number;
  truncated: boolean;
}

export const TABLE_FORM_CELL =
  "scalar = value (equal to its display value); [value, display] = value with a " +
  "different display value (a reference is [sys_id, display]); null = absent";

/**
 * Encode records as `{columns, rows, cell, total, truncated}`. A value pair
 * collapses to a scalar when value and display match, else `[value,
 * display]`; a reference's link is dropped. `maxRows` caps rows, never
 * cells. Redaction must run on the records before they get here.
 */
export function toTableForm(
  records: SnRecord[],
  opts: {
    columns?: string[];
    total?: number;
    truncated?: boolean;
    maxRows?: number;
  } = {},
): TableForm {
  const columns = opts.columns ?? [
    ...new Set(records.flatMap((r) => Object.keys(r))),
  ];
  const cap = opts.maxRows ?? records.length;
  const kept = records.slice(0, Math.max(0, cap));
  const rows = kept.map((r) =>
    columns.map((c) => {
      const v = r[c];
      const pair = asPair(v);
      return pair ? collapse(pair) : scalar(v);
    }),
  );
  return {
    columns,
    rows,
    cell: TABLE_FORM_CELL,
    total: opts.total ?? records.length,
    truncated: Boolean(opts.truncated) || kept.length < records.length,
  };
}
