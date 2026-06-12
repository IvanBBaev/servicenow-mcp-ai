import { ServiceNowError } from "../errors.js";
import { queryTable, getRecord, type SnRecord } from "../servicenow.js";

/**
 * Script intelligence helpers. ServiceNow keeps all server/client code in
 * ordinary tables (sys_script, sys_script_include, ...), so these read-only
 * tools go through the Table API and obey the same auth, SSRF and table-policy
 * guards as any other read. Reading `sys_script` therefore requires `sys_script`
 * to be allowed by SN_TABLES_ALLOW/DENY.
 */

/** Descriptor for one kind of ServiceNow script artefact. */
interface ScriptType {
  /** The table the artefact lives in. */
  table: string;
  /** Field holding the human-readable name. */
  nameField: string;
  /** Field referencing the table the artefact applies to, when applicable. */
  appliesToField?: string;
  /** Metadata fields surfaced in listings (besides name/sys_id/audit fields). */
  metaFields: string[];
  /** Field(s) holding executable source code. */
  scriptFields: string[];
}

/** Supported script types, keyed by the value clients pass as `type`. */
export const SCRIPT_TYPES: Record<string, ScriptType> = {
  business_rule: {
    table: "sys_script",
    nameField: "name",
    appliesToField: "collection",
    metaFields: ["collection", "when", "order", "active", "condition"],
    scriptFields: ["script"],
  },
  script_include: {
    table: "sys_script_include",
    nameField: "name",
    metaFields: ["api_name", "client_callable", "access", "active"],
    scriptFields: ["script"],
  },
  client_script: {
    table: "sys_script_client",
    nameField: "name",
    appliesToField: "table",
    metaFields: ["table", "type", "ui_type", "field", "active"],
    scriptFields: ["script"],
  },
  ui_policy: {
    table: "sys_ui_policy",
    nameField: "short_description",
    appliesToField: "table",
    metaFields: ["table", "active", "run_scripts"],
    scriptFields: ["script_true", "script_false"],
  },
  ui_action: {
    table: "sys_ui_action",
    nameField: "name",
    appliesToField: "table",
    metaFields: ["table", "action_name", "active", "client", "order"],
    scriptFields: ["script"],
  },
  scheduled_job: {
    table: "sysauto_script",
    nameField: "name",
    metaFields: ["active", "run_type", "run_time"],
    scriptFields: ["script"],
  },
  transform: {
    table: "sys_transform_script",
    nameField: "map",
    metaFields: ["map", "when", "order"],
    scriptFields: ["script"],
  },
  rest_operation: {
    table: "sys_ws_operation",
    nameField: "name",
    metaFields: ["web_service_definition", "http_method", "operation_uri", "active"],
    scriptFields: ["operation_script"],
  },
  acl: {
    table: "sys_security_acl",
    nameField: "name",
    metaFields: ["operation", "type", "active", "admin_overrides"],
    scriptFields: ["script"],
  },
};

/** Names of every supported script type, for error messages and iteration. */
export const SCRIPT_TYPE_NAMES = Object.keys(SCRIPT_TYPES);

function resolveType(type: string): ScriptType {
  const descriptor = SCRIPT_TYPES[type];
  if (!descriptor) {
    throw new ServiceNowError(
      `Unknown script type '${type}'. Valid types: ${SCRIPT_TYPE_NAMES.join(", ")}.`,
      400,
    );
  }
  return descriptor;
}

const AUDIT_FIELDS = ["sys_updated_on", "sys_updated_by"];

export interface ListScriptsOptions {
  type: string;
  table?: string;
  name?: string;
  active?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
}

export interface ScriptSummary {
  type: string;
  sys_id: string;
  name: string;
  [field: string]: unknown;
}

/**
 * List script artefacts of a single type as compact metadata (no source code),
 * optionally filtered by applied table, name fragment, active flag, or a raw
 * encoded query.
 */
export async function listScripts(
  opts: ListScriptsOptions,
): Promise<{ type: string; count: number; scripts: ScriptSummary[] }> {
  const descriptor = resolveType(opts.type);
  const clauses: string[] = [];

  if (opts.table?.trim()) {
    const t = opts.table.trim();
    if (descriptor.appliesToField) {
      clauses.push(`${descriptor.appliesToField}=${t}`);
    } else {
      clauses.push(`${descriptor.nameField}LIKE${t}`);
    }
  }
  if (opts.name?.trim()) {
    clauses.push(`${descriptor.nameField}LIKE${opts.name.trim()}`);
  }
  if (opts.active !== undefined) {
    clauses.push(`active=${opts.active}`);
  }
  if (opts.query?.trim()) {
    clauses.push(opts.query.trim());
  }
  clauses.push(`ORDERBY${descriptor.nameField}`);

  const fields = [
    "sys_id",
    descriptor.nameField,
    ...descriptor.metaFields,
    ...AUDIT_FIELDS,
  ];

  const { records } = await queryTable({
    table: descriptor.table,
    query: clauses.join("^"),
    fields,
    displayValue: "true",
    limit: opts.limit ?? 50,
    offset: opts.offset,
  });

  const scripts = records.map((r) => normalizeSummary(opts.type, descriptor, r));
  return { type: opts.type, count: scripts.length, scripts };
}

function normalizeSummary(
  type: string,
  descriptor: ScriptType,
  record: SnRecord,
): ScriptSummary {
  const summary: ScriptSummary = {
    type,
    sys_id: String(record.sys_id ?? ""),
    name: String(record[descriptor.nameField] ?? ""),
  };
  for (const field of [...descriptor.metaFields, ...AUDIT_FIELDS]) {
    if (field in record) summary[field] = record[field];
  }
  return summary;
}

/**
 * Read one script artefact in full, including its source code and execution
 * context (e.g. for a business rule: collection, when, order, condition).
 */
export async function getScript(
  type: string,
  sysId: string,
): Promise<{ type: string; table: string; record: SnRecord }> {
  const descriptor = resolveType(type);
  const record = await getRecord(descriptor.table, sysId);
  return { type, table: descriptor.table, record };
}

export interface SearchCodeOptions {
  text: string;
  type?: string;
  table?: string;
  limit?: number;
}

export interface CodeMatch {
  type: string;
  sys_id: string;
  name: string;
  table?: string;
  field: string;
  line: number;
  snippet: string;
}

/**
 * Search the source of script artefacts for a literal substring (case
 * sensitivity follows ServiceNow's LIKE). Returns a short snippet per match
 * rather than whole scripts, to keep the result compact. Answers questions like
 * "where is this script include used?".
 */
export async function searchCode(
  opts: SearchCodeOptions,
): Promise<{ count: number; matches: CodeMatch[] }> {
  const text = opts.text?.trim();
  if (!text) {
    throw new ServiceNowError("searchCode requires a non-empty 'text'.", 400);
  }
  const limit = opts.limit ?? 50;
  const types = opts.type ? [opts.type] : SCRIPT_TYPE_NAMES;
  // Validate an explicit type up front (iterating all types skips validation).
  if (opts.type) resolveType(opts.type);

  const matches: CodeMatch[] = [];
  for (const typeName of types) {
    if (matches.length >= limit) break;
    const descriptor = SCRIPT_TYPES[typeName];
    const remaining = limit - matches.length;

    const codeQuery = descriptor.scriptFields
      .map((f) => `${f}LIKE${text}`)
      .join("^OR");
    const singleField = descriptor.scriptFields.length === 1;
    const tableFilter =
      opts.table?.trim() && descriptor.appliesToField
        ? `${descriptor.appliesToField}=${opts.table.trim()}`
        : undefined;

    // A table filter can only be safely AND-ed in the query for single-field
    // types; for multi-field types it is applied as a post-filter instead.
    const query =
      tableFilter && singleField ? `${tableFilter}^${codeQuery}` : codeQuery;

    const fields = [
      "sys_id",
      descriptor.nameField,
      ...(descriptor.appliesToField ? [descriptor.appliesToField] : []),
      ...descriptor.scriptFields,
    ];

    const { records } = await queryTable({
      table: descriptor.table,
      query,
      fields,
      displayValue: "false",
      limit: remaining,
    });

    for (const record of records) {
      if (matches.length >= limit) break;
      const appliesTo = descriptor.appliesToField
        ? String(record[descriptor.appliesToField] ?? "")
        : undefined;
      if (tableFilter && !singleField && appliesTo !== opts.table?.trim()) {
        continue;
      }
      const match = firstMatch(typeName, descriptor, record, text, appliesTo);
      if (match) matches.push(match);
    }
  }
  return { count: matches.length, matches };
}

function firstMatch(
  type: string,
  descriptor: ScriptType,
  record: SnRecord,
  text: string,
  appliesTo: string | undefined,
): CodeMatch | undefined {
  const needle = text.toLowerCase();
  for (const field of descriptor.scriptFields) {
    const source = record[field];
    if (typeof source !== "string") continue;
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        const snippet = lines[i].trim().slice(0, 200);
        return {
          type,
          sys_id: String(record.sys_id ?? ""),
          name: String(record[descriptor.nameField] ?? ""),
          ...(appliesTo ? { table: appliesTo } : {}),
          field,
          line: i + 1,
          snippet,
        };
      }
    }
  }
  return undefined;
}

/** One automation entry in a table's logic overview (metadata only). */
type LogicEntry = ScriptSummary;

export interface TableLogic {
  table: string;
  businessRules: LogicEntry[];
  clientScripts: LogicEntry[];
  uiPolicies: LogicEntry[];
  uiActions: LogicEntry[];
  acls: LogicEntry[];
}

/**
 * Assemble the full automation picture for a table: business rules (ordered by
 * when + order), client scripts, UI policies, UI actions and ACLs. Metadata
 * only — use getScript for source. This is the entry point for "what happens
 * when a record on this table is inserted/updated?".
 */
export async function tableLogic(table: string): Promise<TableLogic> {
  const t = table.trim();
  const [businessRules, clientScripts, uiPolicies, uiActions, acls] =
    await Promise.all([
      listOrdered("business_rule", `collection=${t}^ORDERBYwhen^ORDERBYorder`),
      listScripts({ type: "client_script", table: t, limit: 200 }).then(
        (r) => r.scripts,
      ),
      listScripts({ type: "ui_policy", table: t, limit: 200 }).then(
        (r) => r.scripts,
      ),
      listScripts({ type: "ui_action", table: t, limit: 200 }).then(
        (r) => r.scripts,
      ),
      listScripts({ type: "acl", query: `nameLIKE${t}`, limit: 200 }).then(
        (r) => r.scripts,
      ),
    ]);
  return { table: t, businessRules, clientScripts, uiPolicies, uiActions, acls };
}

/** List a script type with an explicit raw query (used for custom ordering). */
async function listOrdered(type: string, query: string): Promise<LogicEntry[]> {
  const { scripts } = await listScripts({ type, query, limit: 200 });
  return scripts;
}
