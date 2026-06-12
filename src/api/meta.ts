import { queryTable, type SnRecord } from "../servicenow.js";

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
  const clauses: string[] = [];
  if (filter?.trim()) {
    const f = filter.trim();
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
    name: String(r.name ?? ""),
    label: r.label ? String(r.label) : undefined,
    superClass: r["super_class.name"] ? String(r["super_class.name"]) : undefined,
  }));
}

/** Guard against malformed/cyclic super_class data on the instance. */
const MAX_CHAIN_DEPTH = 20;

/**
 * Resolve a table's inheritance chain (child first, root last) by walking
 * sys_db_object.super_class. An unknown table yields just itself.
 */
export async function getTableChain(table: string): Promise<string[]> {
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
}

/**
 * Describe a table's columns from sys_dictionary, including columns inherited
 * through the super_class chain (e.g. incident inherits most fields from
 * task). When a child overrides a parent's dictionary entry, the child wins.
 */
export async function describeTable(table: string): Promise<ColumnInfo[]> {
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
    ],
    displayValue: "false",
    fetchAll: true,
  });

  const rank = new Map(chain.map((t, i) => [t, i]));
  const byElement = new Map<string, SnRecord>();
  for (const r of records) {
    const element = String(r.element ?? "");
    if (!element) continue;
    const existing = byElement.get(element);
    const rApplies = rank.get(String(r.name)) ?? Number.MAX_SAFE_INTEGER;
    const existingApplies = existing
      ? (rank.get(String(existing.name)) ?? Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
    if (!existing || rApplies < existingApplies) byElement.set(element, r);
  }

  return [...byElement.values()]
    .sort((a, b) => String(a.element).localeCompare(String(b.element)))
    .map((r: SnRecord) => ({
      element: String(r.element ?? ""),
      label: r.column_label ? String(r.column_label) : undefined,
      type: r.internal_type ? String(r.internal_type) : undefined,
      mandatory: r.mandatory === "true" || r.mandatory === true,
      maxLength: r.max_length ? Number(r.max_length) : undefined,
      reference: r.reference ? String(r.reference) : undefined,
      sourceTable: r.name ? String(r.name) : undefined,
    }));
}
