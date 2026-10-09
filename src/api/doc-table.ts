import { rethrowIfCancelled } from "../core/errors.js";
import { getMaxRecords } from "../core/settings.js";
import { generateErDiagram, generateTableFlow } from "./diagrams.js";
import { describeTable, getTableChain, type ColumnInfo } from "./meta.js";
import { DOMAIN_CAVEAT, recordDomain } from "./domain-separation.js";
import { tableLogic, type ScriptSummary } from "./scripts.js";
import { assertNoCaret, snString } from "./shared.js";
import { queryTable, type SnRecord } from "./table.js";
import {
  caveatsSection,
  cell,
  code,
  type CollectOptions,
  isAccessDenied,
  LOGIC_LIMIT,
  mermaidBlock,
  METADATA_CAVEAT,
  PURPOSE_BLOCK,
  type RenderContext,
  tableOrNone,
  VISIBILITY_CAVEAT,
} from "./doc-shared.js";

/**
 * Table document (ID-08).
 */

export interface TableDocColumn {
  element: string;
  label: string;
  type: string;
  reference: string;
  mandatory: boolean;
  defaultValue: string;
  flags: string[];
}

export interface TableDocReference {
  table: string;
  element: string;
  label: string;
}

export interface TableDocAcl {
  sys_id: string;
  name: string;
  operation: string;
  active: string;
  roles: string[];
}

export interface TableDocData {
  table: string;
  chain: string[];
  /** Columns grouped by the table that defines them, in chain order. */
  columns: Record<string, TableDocColumn[]>;
  referencedBy: TableDocReference[];
  logic: {
    businessRules: Record<string, string>[];
    clientScripts: Record<string, string>[];
    uiPolicies: Record<string, string>[];
    uiActions: Record<string, string>[];
    acls: TableDocAcl[];
  };
  diagrams?: { er?: string; flow?: string };
  unreadable: string[];
  caveats: string[];
}

function docColumn(c: ColumnInfo): TableDocColumn {
  const flags = [
    ...(c.display ? ["display"] : []),
    ...(c.readOnly ? ["read-only"] : []),
    ...(c.unique ? ["unique"] : []),
  ];
  return {
    element: c.element,
    label: c.label ?? "",
    type: c.type ?? "",
    reference: c.reference ?? "",
    mandatory: c.mandatory === true,
    defaultValue: c.defaultValue ?? "",
    flags,
  };
}

/** The metadata fields of a logic entry, as strings. */
function pick(entry: ScriptSummary, fields: string[]): Record<string, string> {
  const out: Record<string, string> = {
    sys_id: entry.sys_id,
    name: entry.name,
  };
  for (const f of fields) out[f] = cell(entry[f]);
  // N-12: absent on an instance without domain separation.
  const { domain } = recordDomain(entry);
  if (domain) out.domain = cell(domain);
  return out;
}

/** Roles per ACL sys_id from sys_security_acl_role; undefined when unreadable. */
async function aclRoles(
  ids: string[],
  caveats: string[],
): Promise<Map<string, string[]> | undefined> {
  const roles = new Map<string, string[]>();
  if (!ids.length) return roles;
  try {
    const res = await queryTable({
      table: "sys_security_acl_role",
      query: `sys_security_aclIN${ids.join(",")}`,
      fields: ["sys_security_acl", "sys_user_role.name"],
      displayValue: "false",
      fetchAll: true,
    });
    if (res.truncated) {
      caveats.push(
        `ACL roles: the sys_security_acl_role read stopped at SN_MAX_RECORDS (${getMaxRecords()}); some roles may be missing.`,
      );
    }
    for (const r of res.records) {
      const acl = snString(r.sys_security_acl);
      const role = snString(r["sys_user_role.name"]);
      if (!acl || !role) continue;
      const list = roles.get(acl) ?? [];
      if (!list.includes(role)) list.push(role);
      roles.set(acl, list);
    }
    for (const list of roles.values()) list.sort();
    return roles;
  } catch (error) {
    if (!isAccessDenied(error)) throw error;
    caveats.push(
      "ACL roles: sys_security_acl_role is not readable for this user, so the Roles column is empty. Run servicenow_check_capabilities.",
    );
    return undefined;
  }
}

async function referencingColumns(
  table: string,
  caveats: string[],
): Promise<TableDocReference[]> {
  try {
    const res = await queryTable({
      table: "sys_dictionary",
      query: `reference=${table}^ORDERBYname^ORDERBYelement`,
      fields: ["name", "element", "column_label"],
      displayValue: "false",
      fetchAll: true,
    });
    if (res.truncated) {
      caveats.push(
        `Referenced by: the sys_dictionary read stopped at SN_MAX_RECORDS (${getMaxRecords()}); the list is partial.`,
      );
    }
    return res.records
      .map((r: SnRecord) => ({
        table: snString(r.name),
        element: snString(r.element),
        label: snString(r.column_label),
      }))
      .filter((r) => r.table && r.element);
  } catch (error) {
    if (!isAccessDenied(error)) throw error;
    caveats.push(
      "Referenced by: sys_dictionary could not be searched for references to this table.",
    );
    return [];
  }
}

/** Run a diagram generator; a failure becomes a caveat. */
export async function diagram<
  T extends { mermaid: string; truncated?: number },
>(
  label: string,
  load: () => Promise<T>,
  caveats: string[],
): Promise<string | undefined> {
  try {
    const d = await load();
    if (d.truncated) {
      caveats.push(
        `${label}: ${d.truncated} node(s) left out by SN_DIAGRAM_MAX_NODES.`,
      );
    }
    return d.mermaid;
  } catch (error) {
    rethrowIfCancelled(error);
    caveats.push(
      `${label}: not drawn — ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/** Collect the table document's data (metadata only). */
export async function collectTable(
  table: string,
  opts: CollectOptions = {},
): Promise<TableDocData> {
  const t = table.trim();
  assertNoCaret(t, "table");
  const caveats: string[] = [];
  const chain = await getTableChain(t);
  const described = await describeTable(t);
  const columns: Record<string, TableDocColumn[]> = {};
  for (const name of chain) columns[name] = [];
  for (const c of described) {
    const owner = c.sourceTable && c.sourceTable in columns ? c.sourceTable : t;
    columns[owner]!.push(docColumn(c));
  }
  const referencedBy = await referencingColumns(t, caveats);

  const logic = await tableLogic(t);
  const unreadable = [...(logic.unreadable ?? [])];
  const acls = logic.acls.filter(
    (a) => a.name === t || a.name.startsWith(`${t}.`),
  );
  const roles = await aclRoles(
    acls.map((a) => a.sys_id),
    caveats,
  );
  for (const [label, list] of [
    ["business rules", logic.businessRules],
    ["client scripts", logic.clientScripts],
    ["UI policies", logic.uiPolicies],
    ["UI actions", logic.uiActions],
    ["ACLs", logic.acls],
  ] as const) {
    if (list.length >= LOGIC_LIMIT) {
      caveats.push(
        `Logic: the ${label} list stopped at ${LOGIC_LIMIT} entries; it may be partial.`,
      );
    }
  }

  let diagrams: TableDocData["diagrams"];
  if (opts.diagrams !== false) {
    const er = await diagram(
      "ER diagram",
      () =>
        generateErDiagram([t], { columns: opts.columns ?? "own", depth: 1 }),
      caveats,
    );
    const flow = await diagram(
      "Table flow",
      () => generateTableFlow(t),
      caveats,
    );
    diagrams = {
      ...(er !== undefined ? { er } : {}),
      ...(flow !== undefined ? { flow } : {}),
    };
  }

  // N-12: one caveat when a logic entry is domain-specific.
  if (
    [
      ...logic.businessRules,
      ...logic.clientScripts,
      ...logic.uiPolicies,
      ...logic.uiActions,
    ].some((e) => recordDomain(e).domain)
  ) {
    caveats.push(DOMAIN_CAVEAT);
  }

  return {
    table: t,
    chain,
    columns,
    referencedBy,
    logic: {
      businessRules: logic.businessRules.map((e) =>
        pick(e, ["when", "order", "active", "condition"]),
      ),
      clientScripts: logic.clientScripts.map((e) =>
        pick(e, ["type", "field", "ui_type", "active"]),
      ),
      uiPolicies: logic.uiPolicies.map((e) =>
        pick(e, ["active", "run_scripts"]),
      ),
      uiActions: logic.uiActions.map((e) =>
        pick(e, ["action_name", "order", "client", "active"]),
      ),
      acls: acls.map((a) => ({
        sys_id: a.sys_id,
        name: a.name,
        operation: cell(a.operation),
        active: cell(a.active),
        roles: roles?.get(a.sys_id) ?? [],
      })),
    },
    ...(diagrams ? { diagrams } : {}),
    unreadable,
    caveats,
  };
}

function columnRows(cols: TableDocColumn[]): string[][] {
  return cols.map((c) => [
    code(c.element),
    cell(c.label),
    c.type,
    c.reference ? code(c.reference) : "",
    c.mandatory ? "yes" : "",
    cell(c.defaultValue, 80),
    c.flags.join(", "),
  ]);
}

const COLUMN_HEADER = [
  "Column",
  "Label",
  "Type",
  "Reference",
  "Mandatory",
  "Default",
  "Flags",
];

/** Render the table document (pure: same data, same bytes). */
export function renderTable(data: TableDocData, ctx: RenderContext): string {
  const t = data.table;
  const own = data.columns[t] ?? [];
  const inherited = data.chain.slice(1);
  const inheritedCount = inherited.reduce(
    (n, p) => n + (data.columns[p]?.length ?? 0),
    0,
  );
  const referencing = new Set(data.referencedBy.map((r) => r.table));
  const lines: string[] = [
    `# Table ${code(t)}`,
    "",
    `Generated by servicenow_document_table from the instance metadata of profile ${code(ctx.profile)} (the timestamp is in the frontmatter). Text inside the manual block survives re-runs.`,
    "",
    `- **Inheritance:** ${data.chain.map(code).join(" → ")}`,
    `- **Columns:** ${own.length + inheritedCount} (${own.length} own, ${inheritedCount} inherited)`,
    `- **Referenced by:** ${data.referencedBy.length} column(s) on ${referencing.size} table(s)`,
    "",
    ...PURPOSE_BLOCK,
    "## Columns",
    "",
    `### Own columns (${code(t)})`,
    "",
    tableOrNone(COLUMN_HEADER, columnRows(own)),
    "",
  ];
  for (const parent of inherited) {
    lines.push(
      `### Inherited from ${code(parent)}`,
      "",
      tableOrNone(COLUMN_HEADER, columnRows(data.columns[parent] ?? [])),
      "",
    );
  }
  lines.push(
    "## Referenced by",
    "",
    tableOrNone(
      ["Table", "Column", "Label"],
      data.referencedBy.map((r) => [code(r.table), code(r.element), r.label]),
    ),
    "",
  );
  if (data.diagrams) {
    lines.push("## Diagrams", "");
    if (data.diagrams.er !== undefined) {
      lines.push(
        "### Entity relationships",
        "",
        mermaidBlock(data.diagrams.er),
        "",
      );
    }
    if (data.diagrams.flow !== undefined) {
      lines.push(
        "### Record lifecycle",
        "",
        mermaidBlock(data.diagrams.flow),
        "",
      );
    }
  }
  const l = data.logic;
  // An unreadable definition table is not "none": say so in place.
  // N-12: a Domain column only when an entry is domain-specific.
  const logicTable = (
    type: string,
    header: string[],
    rows: string[][],
    entries: readonly { domain?: string }[] = [],
  ) =>
    data.unreadable.includes(type)
      ? "_Not readable for this user — see Caveats._"
      : entries.some((e) => e.domain)
        ? tableOrNone(
            [...header, "Domain"],
            rows.map((r, i) => [...r, entries[i]?.domain ?? ""]),
          )
        : tableOrNone(header, rows);
  lines.push(
    "## Logic",
    "",
    "### Business rules",
    "",
    logicTable(
      "business_rule",
      ["Name", "When", "Order", "Active", "Condition"],
      l.businessRules.map((r) => [
        cell(r.name),
        r.when ?? "",
        r.order ?? "",
        r.active ?? "",
        r.condition ?? "",
      ]),
      l.businessRules,
    ),
    "",
    "### Client scripts",
    "",
    logicTable(
      "client_script",
      ["Name", "Type", "Field", "UI type", "Active"],
      l.clientScripts.map((r) => [
        cell(r.name),
        r.type ?? "",
        r.field ?? "",
        r.ui_type ?? "",
        r.active ?? "",
      ]),
      l.clientScripts,
    ),
    "",
    "### UI policies",
    "",
    logicTable(
      "ui_policy",
      ["Name", "Active", "Run scripts"],
      l.uiPolicies.map((r) => [
        cell(r.name),
        r.active ?? "",
        r.run_scripts ?? "",
      ]),
      l.uiPolicies,
    ),
    "",
    "### UI actions",
    "",
    logicTable(
      "ui_action",
      ["Name", "Action name", "Order", "Client", "Active"],
      l.uiActions.map((r) => [
        cell(r.name),
        r.action_name ?? "",
        r.order ?? "",
        r.client ?? "",
        r.active ?? "",
      ]),
      l.uiActions,
    ),
    "",
    "### ACLs",
    "",
    logicTable(
      "acl",
      ["Name", "Operation", "Roles", "Active"],
      l.acls.map((a) => [
        code(a.name),
        a.operation,
        a.roles.join(", "),
        a.active,
      ]),
    ),
    "",
    ...caveatsSection([
      ...data.unreadable.map(
        (u) =>
          `Unreadable: ${u} definitions could not be read by this user (the table needs a read role); that list is empty here. Run servicenow_check_capabilities.`,
      ),
      ...data.caveats,
      VISIBILITY_CAVEAT,
      METADATA_CAVEAT,
    ]),
  );
  return lines.join("\n");
}
