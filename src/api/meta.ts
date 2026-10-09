import { queryTable, type SnRecord } from "./table.js";
import { activeProfile } from "../core/config.js";
import { cached, peekSchemaCache, schemaCacheScope } from "../core/cache.js";

// H-7: the scope helper moved to core/cache.ts (N-21 needs it below api/);
// re-exported so existing importers keep working.
export { schemaCacheScope };
import { assertNoCaret, snString } from "./shared.js";
import { rethrowIfCancelled } from "../core/errors.js";
import { aggregate } from "./aggregate.js";
import type { TableIndex } from "./query-explain.js";

/** Cache key prefix carrying the instance and profile; see schemaCacheScope. */
const cacheKey = (parts: string[]): string =>
  [schemaCacheScope(), ...parts].join("|");

/**
 * Metadata helpers built on top of the Table API: they read ServiceNow's own
 * dictionary tables, so they go through the same auth, SSRF and table-policy
 * guards as any other read.
 */

export interface TableInfo {
  name: string;
  label?: string;
  superClass?: string;
}

/** List tables from sys_db_object, optionally filtered by a name/label fragment. */
export async function listTables(filter?: string): Promise<TableInfo[]> {
  return cached(cacheKey(["listTables", filter?.trim() ?? ""]), () =>
    listTablesUncached(filter),
  );
}

async function listTablesUncached(filter?: string): Promise<TableInfo[]> {
  const clauses: string[] = [];
  if (filter?.trim()) {
    const f = filter.trim();
    assertNoCaret(f, "table name/label");
    clauses.push(`nameLIKE${f}^ORlabelLIKE${f}`);
  }
  clauses.push("ORDERBYname");
  const { records } = await queryTable({
    table: "sys_db_object",
    query: clauses.join("^"),
    // super_class is a reference to sys_db_object; dot-walk to the parent's
    // table *name* (the raw value is a sys_id, the display value a label).
    fields: ["name", "label", "super_class.name"],
    displayValue: "false",
    fetchAll: true,
  });
  return records.map((r) => ({
    name: snString(r.name),
    label: snString(r.label) || undefined,
    superClass: snString(r["super_class.name"]) || undefined,
  }));
}

/**
 * M-4 (L5-03): tables every instance has, offered by completions and the
 * schema resource list before any schema read has been cached.
 */
export const SEED_TABLES = [
  "incident",
  "problem",
  "change_request",
  "sc_request",
  "sc_req_item",
  "sc_task",
  "task",
  "sys_user",
  "sys_user_group",
  "cmdb_ci",
  "kb_knowledge",
] as const;

/**
 * Table names the schema cache already knows for `profile` (default: the
 * active one) — described tables, their inheritance chains and reference
 * targets, and cached `listTables` results. Never calls the instance, so
 * completions and resource lists stay free and offline.
 */
export function cachedTableNames(profile: string = activeProfile()): string[] {
  const names = new Set<string>();
  for (const [key, value] of peekSchemaCache(`${schemaCacheScope(profile)}|`)) {
    const [, kind, table] = key.split("|");
    if (kind === "describeTable" && table) {
      names.add(table);
      for (const c of value as ColumnInfo[]) {
        if (c.reference) names.add(c.reference);
      }
    } else if (kind === "tableChain") {
      for (const t of value as string[]) names.add(t);
    } else if (kind === "listTables") {
      for (const t of value as TableInfo[]) names.add(t.name);
    }
  }
  names.delete("");
  return [...names].sort();
}

/**
 * H-3 (L2-06): the column names of `table` if the schema cache already holds
 * its description (a describe_table, a lint or a trace read it), else
 * undefined. Never calls the instance.
 */
export function cachedColumnNames(table: string): Set<string> | undefined {
  const key = cacheKey(["describeTable", table]);
  const hit = peekSchemaCache(key).find(([k]) => k === key);
  if (!hit) return undefined;
  return new Set((hit[1] as ColumnInfo[]).map((c) => c.element));
}

/**
 * H-3 (L2-06): the written field names the cached schema does not know —
 * a typo the instance would silently ignore. `undefined` when the schema is
 * not cached (nothing is read to find out); dot-walked names are skipped.
 */
export function unknownFields(
  table: string,
  fields: Record<string, unknown>,
): string[] | undefined {
  const known = cachedColumnNames(table);
  if (!known) return undefined;
  return Object.keys(fields).filter((f) => !f.includes(".") && !known.has(f));
}

/** Guard against malformed/cyclic super_class data on the instance. */
const MAX_CHAIN_DEPTH = 20;

/**
 * Resolve a table's inheritance chain (child first, root last) by walking
 * sys_db_object.super_class. An unknown table yields just itself. Cached with
 * the other schema reads (S-1): the trace and diagram generators resolve the
 * chain on every call, and it changes as rarely as the dictionary does.
 */
export async function getTableChain(table: string): Promise<string[]> {
  return cached(cacheKey(["tableChain", table]), () =>
    getTableChainUncached(table),
  );
}

async function getTableChainUncached(table: string): Promise<string[]> {
  const chain = [table];
  let current = table;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
    const { records } = await queryTable({
      table: "sys_db_object",
      query: `name=${current}`,
      fields: ["name", "super_class.name"],
      displayValue: "false",
      limit: 1,
    });
    const parent = records[0]?.["super_class.name"];
    if (typeof parent !== "string" || !parent || chain.includes(parent)) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

export interface ColumnInfo {
  element: string;
  label?: string;
  type?: string;
  mandatory?: boolean;
  maxLength?: number;
  reference?: string;
  /** Table in the inheritance chain that defines this column. */
  sourceTable?: string;
  // S-7: the rest of the dictionary entry. Flags are set only when true.
  defaultValue?: string;
  readOnly?: boolean;
  unique?: boolean;
  /** The table's display field. */
  display?: boolean;
  /** Choice mode (`1` dropdown with -- None --, `3` without, …). */
  choice?: string;
  /** Active choice list (sys_choice, `language=en`); with `details` only. */
  choices?: { value: string; label: string }[];
  /** sys_dictionary_override rows applying here, child first; `details` only. */
  overrides?: ColumnOverride[];
}

/** One sys_dictionary_override row: what a (child) table overrides. */
export interface ColumnOverride {
  table: string;
  defaultValue?: string;
  mandatory?: boolean;
  readOnly?: boolean;
}

/**
 * Describe a table's columns from sys_dictionary, including columns inherited
 * through the super_class chain (e.g. incident inherits most fields from
 * task). When a child overrides a parent's dictionary entry, the child wins.
 */
export async function describeTable(table: string): Promise<ColumnInfo[]> {
  // The table name is embedded raw into encoded queries below (name=…,
  // nameIN…), so a stray `^` would inject extra clauses — reject it up front,
  // the same guard the script tools and listTables already apply (K-5 class).
  assertNoCaret(table, "table");
  return cached(cacheKey(["describeTable", table]), () =>
    describeTableUncached(table),
  );
}

async function describeTableUncached(table: string): Promise<ColumnInfo[]> {
  const chain = await getTableChain(table);
  const { records } = await queryTable({
    table: "sys_dictionary",
    query: `nameIN${chain.join(",")}^elementISNOTEMPTY^ORDERBYelement`,
    fields: [
      "element",
      "column_label",
      "internal_type",
      "mandatory",
      "max_length",
      "reference",
      "name",
      "default_value",
      "read_only",
      "unique",
      "display",
      "choice",
    ],
    displayValue: "false",
    fetchAll: true,
  });

  const rank = new Map(chain.map((t, i) => [t, i]));
  const byElement = new Map<string, SnRecord>();
  for (const r of records) {
    const element = snString(r.element);
    if (!element) continue;
    const existing = byElement.get(element);
    const rApplies = rank.get(snString(r.name)) ?? Number.MAX_SAFE_INTEGER;
    const existingApplies = existing
      ? (rank.get(snString(existing.name)) ?? Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
    if (!existing || rApplies < existingApplies) byElement.set(element, r);
  }

  return [...byElement.values()]
    .sort((a, b) => snString(a.element).localeCompare(snString(b.element)))
    .map((r: SnRecord) => ({
      element: snString(r.element),
      label: snString(r.column_label) || undefined,
      type: snString(r.internal_type) || undefined,
      // snString unwraps a C-4 `{ value, display_value }` pair.
      mandatory: snString(r.mandatory) === "true",
      maxLength: snString(r.max_length)
        ? Number(snString(r.max_length))
        : undefined,
      reference: snString(r.reference) || undefined,
      sourceTable: snString(r.name) || undefined,
      defaultValue: snString(r.default_value) || undefined,
      readOnly: flag(r.read_only),
      unique: flag(r.unique),
      display: flag(r.display),
      choice: ["", "0"].includes(snString(r.choice))
        ? undefined
        : snString(r.choice),
    }));
}

const flag = (v: unknown): true | undefined =>
  snString(v) === "true" ? true : undefined;

/**
 * S-7 — describeTable plus the choice lists (sys_choice) and the dictionary
 * overrides (sys_dictionary_override) of the table's chain: two more reads,
 * so the describe_table tool asks for them with `details`. The nearest table
 * of the chain wins a choice list; an unreadable table becomes a warning.
 */
export async function describeTableDetails(
  table: string,
): Promise<{ columns: ColumnInfo[]; warnings: string[] }> {
  const columns = (await describeTable(table)).map((c) => ({ ...c }));
  const chain = await getTableChain(table);
  const rank = (t: unknown): number => {
    const i = chain.indexOf(snString(t));
    return i < 0 ? chain.length : i;
  };
  const byElement = new Map(columns.map((c) => [c.element, c]));
  const warnings: string[] = [];
  const read = async (
    t: string,
    query: string,
    fields: string[],
  ): Promise<SnRecord[]> => {
    try {
      const r = await cached(cacheKey(["details", t, table]), () =>
        queryTable({
          table: t,
          query,
          fields,
          displayValue: "false",
          fetchAll: true,
        }),
      );
      if (r.truncated)
        warnings.push(`${t}: hit the SN_MAX_RECORDS cap — partial.`);
      return r.records;
    } catch (e) {
      rethrowIfCancelled(e);
      warnings.push(
        `${t}: unavailable — ${e instanceof Error ? e.message : String(e)}`,
      );
      return [];
    }
  };
  const nameIn = `nameIN${chain.join(",")}`;

  const choices = await read(
    "sys_choice",
    `${nameIn}^inactive=false^language=en^ORDERBYsequence`,
    ["name", "element", "value", "label"],
  );
  const choiceRank = new Map<string, number>();
  for (const r of choices) {
    const col = byElement.get(snString(r.element));
    if (!col) continue;
    const at = rank(r.name);
    const best = choiceRank.get(col.element) ?? Number.MAX_SAFE_INTEGER;
    if (at > best) continue;
    if (at < best) col.choices = [];
    choiceRank.set(col.element, at);
    col.choices!.push({ value: snString(r.value), label: snString(r.label) });
  }

  const overrides = await read(
    "sys_dictionary_override",
    `${nameIn}^ORDERBYname`,
    [
      "name",
      "element",
      "default_value_override",
      "default_value",
      "mandatory_override",
      "mandatory",
      "read_only_override",
      "read_only",
    ],
  );
  for (const r of [...overrides].sort((x, y) => rank(x.name) - rank(y.name))) {
    const col = byElement.get(snString(r.element));
    if (!col) continue;
    const on = (f: string): boolean => snString(r[`${f}_override`]) === "true";
    (col.overrides ??= []).push({
      table: snString(r.name),
      ...(on("default_value")
        ? { defaultValue: snString(r.default_value) }
        : {}),
      ...(on("mandatory")
        ? { mandatory: snString(r.mandatory) === "true" }
        : {}),
      ...(on("read_only")
        ? { readOnly: snString(r.read_only) === "true" }
        : {}),
    });
  }
  return { columns, warnings };
}

/**
 * N-15 — sys_index table and fields. Unverified until O-5 (PDI): the reader
 * tolerates a missing field and turns an unreadable table into a warning.
 */
const INDEX_TABLE = "sys_index";
const INDEX_FIELDS = ["name", "logical_table_name", "col_name", "unique_index"];

/**
 * N-15 — the indexes of a table's chain (a parent's index serves an extended
 * table stored with it) and an estimated row count from the Aggregate API.
 * Both are cached with the schema; either one that cannot be read becomes a
 * warning, so describe_table never fails on them.
 */
export async function describeTableIndexes(table: string): Promise<{
  indexes: TableIndex[];
  rowEstimate?: number;
  warnings: string[];
}> {
  assertNoCaret(table, "table");
  const chain = await getTableChain(table);
  const warnings: string[] = [];
  const unavailable = (what: string, e: unknown): void => {
    rethrowIfCancelled(e);
    warnings.push(
      `${what}: unavailable — ${e instanceof Error ? e.message : String(e)}`,
    );
  };

  let indexes: TableIndex[] = [];
  try {
    const { records, truncated } = await cached(
      cacheKey(["indexes", table]),
      () =>
        queryTable({
          table: INDEX_TABLE,
          query: `logical_table_nameIN${chain.join(",")}^ORDERBYname`,
          fields: INDEX_FIELDS,
          displayValue: "false",
          fetchAll: true,
        }),
    );
    if (truncated)
      warnings.push(`${INDEX_TABLE}: hit the SN_MAX_RECORDS cap — partial.`);
    indexes = records
      .map((r) => ({
        name: snString(r.name),
        table: snString(r.logical_table_name),
        fields: snString(r.col_name)
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean),
        unique: snString(r.unique_index) === "true",
      }))
      .filter((ix) => ix.fields.length > 0);
  } catch (e) {
    unavailable(INDEX_TABLE, e);
  }

  let rowEstimate: number | undefined;
  try {
    rowEstimate = await cached(cacheKey(["rowEstimate", table]), async () => {
      const result = (await aggregate({ table, count: true })) as {
        stats?: { count?: unknown };
      };
      const n = Number(snString(result?.stats?.count));
      return Number.isFinite(n) ? n : undefined;
    });
  } catch (e) {
    unavailable("row count", e);
  }

  return {
    indexes,
    ...(rowEstimate !== undefined ? { rowEstimate } : {}),
    warnings,
  };
}
