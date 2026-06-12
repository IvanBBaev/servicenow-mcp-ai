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
    fields: ["name", "label", "super_class"],
    displayValue: "true",
    fetchAll: true,
  });
  return records.map((r) => ({
    name: String(r.name ?? ""),
    label: r.label ? String(r.label) : undefined,
    superClass: r.super_class ? String(r.super_class) : undefined,
  }));
}

export interface ColumnInfo {
  element: string;
  label?: string;
  type?: string;
  mandatory?: boolean;
  maxLength?: number;
  reference?: string;
}

/** Describe a table's columns from sys_dictionary. */
export async function describeTable(table: string): Promise<ColumnInfo[]> {
  const { records } = await queryTable({
    table: "sys_dictionary",
    query: `name=${table}^elementISNOTEMPTY^ORDERBYelement`,
    fields: [
      "element",
      "column_label",
      "internal_type",
      "mandatory",
      "max_length",
      "reference",
    ],
    displayValue: "false",
    fetchAll: true,
  });
  return records.map((r: SnRecord) => ({
    element: String(r.element ?? ""),
    label: r.column_label ? String(r.column_label) : undefined,
    type: r.internal_type ? String(r.internal_type) : undefined,
    mandatory: r.mandatory === "true" || r.mandatory === true,
    maxLength: r.max_length ? Number(r.max_length) : undefined,
    reference: r.reference ? String(r.reference) : undefined,
  }));
}
