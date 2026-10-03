import path from "node:path";
import { activeProfile } from "../core/config.js";
import { ServiceNowError } from "../core/errors.js";
import { throwIfCancelled, trackProgress } from "../core/progress.js";
import {
  currentRequestProfile,
  runWithProfile,
} from "../core/request-context.js";
import {
  getDeniedPackages,
  getDocsDir,
  getMaxRecords,
} from "../core/settings.js";
import { explainFlow, flowMermaid } from "./explain-flow.js";
import { explainPortal, portalMermaid } from "./portal.js";
import { explainUiExperience, uiExperienceMermaid } from "./ui-experience.js";
import {
  artifactDependencies,
  dependencyMermaid,
  type DependencyResult,
} from "./dependencies.js";
import { lintArtifacts } from "./codecheck.js";
import {
  ARTIFACT_GROUPS,
  ARTIFACT_TYPES,
  type ArtifactType,
} from "../core/artifacts/registry.js";
import {
  LIST_LIMIT,
  artifactTypeCatalog,
  listArtifacts,
  type ArtifactSummary,
} from "./artifacts.js";
import {
  collectApps,
  collectAutomation,
  collectPlugins,
  collectTables,
  type AppRow,
  type AutomationStat,
  type CollectorResult,
} from "./collectors.js";
import {
  generateErDiagram,
  generateTableFlow,
  type ErColumns,
} from "./diagrams.js";
import {
  docsRunBegin,
  docsRunEnd,
  docsWriteRaw,
  resolveDocsProfile,
  type DocWriteStatus,
} from "./docs.js";
import { describeTable, getTableChain, type ColumnInfo } from "./meta.js";
import { tableLogic, scopeClause, type ScriptSummary } from "./scripts.js";
import {
  securityScan,
  type SecurityCheckName,
  type SecurityFinding,
  type SecurityScan,
} from "./security.js";
import { assertNoCaret, mdTable, snString } from "./shared.js";
import { queryTable, type SnRecord } from "./table.js";

/**
 * S-15 — document generators. Each kind of document collects structured
 * metadata from the instance, renders it to Markdown and writes both through
 * the S-14 docs store: `<profile>/<path>.md` with frontmatter plus a `.json`
 * companion holding the collected data (its hash is `sn_source_hash`, so a
 * re-run over unchanged metadata is `unchanged`). Hand-written text lives in
 * `<!-- sn:manual:start purpose -->` blocks and survives re-runs.
 *
 * Generators read structure only — dictionary, automation definitions, ACLs,
 * application records — never business records (ID-02). Unreadable sources
 * become Caveats lines, never failures.
 */

/** Caveat every document carries: what it is built from (C-11, ID-02). */
const METADATA_CAVEAT =
  "Metadata only: built from dictionary, automation and access-control definitions; no business records were read.";
const VISIBILITY_CAVEAT =
  "Visibility: every read runs as this profile's user. On a domain-separated instance only the records of the user's domain (and its visible parents) are seen, and ACLs can hide definitions, so an absent entry is not proof that none exists.";

/** Rows per logic type that tableLogic reads (its own page size). */
const LOGIC_LIMIT = 200;

/** One kind of generated document (ID-11): the S-15 kind registry entry. */
export interface DocKind<T = unknown> {
  title: string;
  /** Layout version, written as `sn_generator_version` (ID-18). */
  version: string;
  /** Packages whose tools the kind's data comes from. */
  requires: readonly string[];
  /** The generator name recorded in the frontmatter and in index.json runs. */
  generator: string;
  /** Profile-relative path of the Markdown document for a target. */
  path: (target: string) => string;
  collect: (target: string, opts: CollectOptions) => Promise<T>;
  render: (data: T, ctx: RenderContext) => string;
  /** One document per profile: the target is not a name (no path check). */
  singleton?: boolean;
  /** Tables whose records the document holds (ID-29's collected column). */
  sources?: (data: T) => string[];
}

export interface CollectOptions {
  /** document_table: draw the ER and table-flow diagrams (default true). */
  diagrams?: boolean;
  /** document_table: which columns the ER entity shows (default `own`). */
  columns?: ErColumns;
  /** document_instance: the run the README and artifact-types kinds describe. */
  instance?: InstanceRunContext;
  /**
   * document_app (P-21): also a Mermaid diagram per flow, subflow, workflow,
   * portal and UI Builder experience, a dependency graph and a lint summary
   * (default false).
   */
  detail?: boolean;
}

export interface RenderContext {
  profile: string;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const code = (v: string): string => (v ? `\`${v.replaceAll("`", "'")}\`` : "");

/** One-line cell text: no newlines, no runaway length. */
function cell(value: unknown, max = 200): string {
  const text = snString(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function tableOrNone(header: string[], rows: string[][]): string {
  return rows.length ? mdTable(header, rows) : "_None._";
}

function mermaidBlock(mermaid: string): string {
  return ["```mermaid", mermaid.replace(/\n+$/, ""), "```"].join("\n");
}

function caveatsSection(caveats: string[]): string[] {
  return ["## Caveats", "", ...caveats.map((c) => `- ${c}`), ""];
}

const PURPOSE_BLOCK = [
  "## Purpose",
  "",
  "<!-- sn:manual:start purpose -->",
  "<!-- sn:manual:end -->",
  "",
];

function isAccessDenied(error: unknown): boolean {
  return (
    error instanceof ServiceNowError &&
    (error.status === 401 || error.status === 403)
  );
}

function isCancelled(error: unknown): boolean {
  return error instanceof ServiceNowError && error.code === "CANCELLED";
}

// ---------------------------------------------------------------------------
// Table document (ID-08)
// ---------------------------------------------------------------------------

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
async function diagram<T extends { mermaid: string; truncated?: number }>(
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
    if (isCancelled(error)) throw error;
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
  const logicTable = (type: string, header: string[], rows: string[][]) =>
    data.unreadable.includes(type)
      ? "_Not readable for this user — see Caveats._"
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

// ---------------------------------------------------------------------------
// Application document (ID-09, ID-22)
// ---------------------------------------------------------------------------

export interface AppDocRecord {
  /** sys_app or sys_store_app. */
  table: string;
  sys_id: string;
  name: string;
  scope: string;
  version: string;
  vendor: string;
  short_description: string;
}

export interface AppDocData {
  app: AppDocRecord;
  tables: { name: string; label: string; extends: string }[];
  /** Artefacts per registry type (non-empty types only). */
  artefacts: Record<string, ArtifactSummary[]>;
  /** Unverified types whose table could not be read (gate O-5). */
  degraded: string[];
  /** Types the user could not read. */
  unreadable: string[];
  er?: string;
  /** P-21 (`detail`): diagrams, dependency graph and lint summary. */
  detail?: AppDetail;
  caveats: string[];
}

/** P-21: the `detail` part of the application document. */
export interface AppDetail {
  diagrams: { type: string; sys_id: string; name: string; mermaid: string }[];
  dependencies?: {
    roots: number;
    nodes: number;
    edges: number;
    mermaid: string;
  };
  lint?: {
    scanned: number;
    findingCount: number;
    bySeverity: Record<string, number>;
    types: Record<string, { scanned: number; findingCount: number }>;
    top: {
      type: string;
      name: string;
      field: string;
      findings: number;
      rule: string;
    }[];
  };
}

/** P-21: diagrams per explained type, dependency roots, lint rows per type. */
export const APP_DETAIL_LIMITS = {
  diagramsPerType: 10,
  dependencyRoots: 10,
  lintPerType: 50,
  lintTop: 20,
} as const;

/** Which explainer draws each diagram type (and the package it belongs to). */
const APP_DIAGRAM_TYPES: {
  type: string;
  pkg: string;
  load: (sysId: string) => Promise<{ mermaid: string; truncated: number }>;
}[] = [
  {
    type: "flow",
    pkg: "flows",
    load: async (id) =>
      flowMermaid(await explainFlow({ sys_id: id, kind: "flow", depth: 0 })),
  },
  {
    type: "subflow",
    pkg: "flows",
    load: async (id) =>
      flowMermaid(await explainFlow({ sys_id: id, kind: "subflow", depth: 0 })),
  },
  {
    type: "workflow",
    pkg: "flows",
    load: async (id) =>
      flowMermaid(await explainFlow({ sys_id: id, kind: "workflow" })),
  },
  {
    type: "sp_portal",
    pkg: "ui",
    load: async (id) => portalMermaid(await explainPortal({ portal: id })),
  },
  {
    // P-14: a UI Builder experience (sys_ux_page_registry) — its page map.
    type: "workspace",
    pkg: "ui",
    load: async (id) =>
      uiExperienceMermaid(await explainUiExperience({ sys_id: id })),
  },
];

/** Types never used as dependency roots (their own sections, or runtime rows). */
const NOT_DEPENDENCY_ROOTS = new Set([
  "table",
  "role",
  "cross_scope_privilege",
  "flow_context",
  "workflow_context",
]);

function packageDenied(pkg: string): boolean {
  return getDeniedPackages().includes(pkg);
}

/**
 * P-21 — the `detail` part: bounded, and every piece degrades to a caveat
 * (a denied package, an unreadable table, an unverified type) instead of
 * failing the document.
 */
async function collectAppDetail(
  scopeRef: string,
  artefacts: Record<string, ArtifactSummary[]>,
  caveats: string[],
): Promise<AppDetail> {
  const L = APP_DETAIL_LIMITS;
  const diagrams: AppDetail["diagrams"] = [];
  for (const d of APP_DIAGRAM_TYPES) {
    const rows = artefacts[d.type] ?? [];
    if (!rows.length) continue;
    if (packageDenied(d.pkg)) {
      caveats.push(
        `Diagrams of ${d.type}: the ${d.pkg} package is denied (SN_PACKAGES_DENY).`,
      );
      continue;
    }
    if (rows.length > L.diagramsPerType) {
      caveats.push(
        `Diagrams of ${d.type}: the first ${L.diagramsPerType} of ${rows.length} are drawn.`,
      );
    }
    for (const row of rows.slice(0, L.diagramsPerType)) {
      throwIfCancelled();
      const mermaid = await diagram(
        `${d.type} ${row.name || row.sys_id}`,
        () => d.load(row.sys_id),
        caveats,
      );
      if (mermaid !== undefined) {
        diagrams.push({
          type: d.type,
          sys_id: row.sys_id,
          name: row.name,
          mermaid,
        });
      }
    }
  }

  const detail: AppDetail = { diagrams };

  if (packageDenied("artifacts")) {
    caveats.push(
      "Dependencies: the artifacts package is denied (SN_PACKAGES_DENY).",
    );
  } else {
    const roots = ARTIFACT_TYPES.filter(
      (t) => !NOT_DEPENDENCY_ROOTS.has(t.type),
    ).flatMap((t) => (artefacts[t.type] ?? []).map((row) => ({ t, row })));
    if (roots.length > L.dependencyRoots) {
      caveats.push(
        `Dependencies: outbound edges of the first ${L.dependencyRoots} of ${roots.length} artefacts.`,
      );
    }
    const nodes = new Map<string, DependencyResult["nodes"][number]>();
    const edges = new Map<string, DependencyResult["edges"][number]>();
    let used = 0;
    for (const { t, row } of roots.slice(0, L.dependencyRoots)) {
      throwIfCancelled();
      try {
        const r = await artifactDependencies({
          artifactType: t.type,
          sys_id: row.sys_id,
          direction: "outbound",
          depth: 1,
        });
        used++;
        for (const n of r.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);
        for (const e of r.edges) edges.set(`${e.from}|${e.to}|${e.field}`, e);
      } catch (e) {
        rethrowCancelled(e);
        caveats.push(
          `Dependencies of ${t.type} ${row.name || row.sys_id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (used > 0) {
      const merged = {
        root: null,
        nodes: [...nodes.values()],
        edges: [...edges.values()],
      } as unknown as DependencyResult;
      const drawn = dependencyMermaid(merged);
      if (drawn.truncated) {
        caveats.push(
          `Dependency graph: ${drawn.truncated} node(s) left out by SN_DIAGRAM_MAX_NODES.`,
        );
      }
      detail.dependencies = {
        roots: used,
        nodes: nodes.size,
        edges: edges.size,
        mermaid: drawn.mermaid,
      };
    }
  }

  if (packageDenied("codecheck")) {
    caveats.push("Lint: the codecheck package is denied (SN_PACKAGES_DENY).");
  } else {
    try {
      const a = await lintArtifacts({ scope: scopeRef, limit: L.lintPerType });
      for (const w of a.warnings) caveats.push(`Lint: ${w}`);
      detail.lint = {
        scanned: a.scanned,
        findingCount: a.findingCount,
        bySeverity: a.bySeverity,
        types: Object.fromEntries(
          Object.entries(a.types)
            .filter(([, t]) => t.scanned > 0)
            .map(([k, t]) => [
              k,
              { scanned: t.scanned, findingCount: t.findingCount },
            ]),
        ),
        top: a.results.slice(0, L.lintTop).map((r) => ({
          type: r.type,
          name: r.name,
          field: r.field,
          findings: r.findings.length,
          rule: r.findings[0]?.rule ?? "",
        })),
      };
    } catch (e) {
      rethrowCancelled(e);
      caveats.push(`Lint: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return detail;
}

function rethrowCancelled(e: unknown): void {
  if (e instanceof ServiceNowError && e.code === "CANCELLED") throw e;
}

/**
 * Artefact fields the app document leaves out, in the Markdown and the JSON:
 * a property's or preference's `value` is configuration data, not structure,
 * and may be a secret (the snapshot redacts it); the descriptor's
 * `secretFields` go too.
 */
const OMITTED_FIELDS = new Set(["value"]);

function omitted(t: ArtifactType, field: string): boolean {
  return OMITTED_FIELDS.has(field) || t.secretFields.includes(field);
}

/** Types the app document renders in their own sections, not per group. */
const OWN_SECTION_TYPES = new Set(["table", "role", "cross_scope_privilege"]);

/**
 * The column set of one artefact type in the app document: name, natural key
 * (when it is neither sys_id nor the name), active, SDK-managed, the applied table and the
 * type's metadata fields. Exported for the registry-completeness test.
 */
export function artifactColumns(t: ArtifactType): string[] {
  const cols = ["name"];
  const singleKey = t.keyFields.length === 1 ? t.keyFields[0] : undefined;
  if (singleKey !== "sys_id" && singleKey !== t.nameField) {
    cols.push("key");
  }
  if (t.activeField) cols.push("active");
  cols.push("sdkManaged");
  for (const f of [
    ...(t.appliesToField ? [t.appliesToField] : []),
    ...(t.metaFields ?? []),
  ]) {
    if (
      f !== t.nameField &&
      f !== t.activeField &&
      !omitted(t, f) &&
      !cols.includes(f)
    ) {
      cols.push(f);
    }
  }
  return cols;
}

function artifactCell(a: ArtifactSummary, col: string): string {
  switch (col) {
    case "name":
      return cell(a.name);
    case "key":
      return Object.values(a.key)
        .map((v) => cell(v))
        .join(", ");
    case "active":
      return a.active === undefined ? "" : String(a.active);
    case "sdkManaged":
      return a.sdkManaged;
    default:
      return cell(a[col]);
  }
}

function artifactTable(t: ArtifactType, rows: ArtifactSummary[]): string {
  const cols = artifactColumns(t);
  return mdTable(
    cols,
    rows.map((a) => cols.map((c) => artifactCell(a, c))),
  );
}

async function appRecord(scope: string): Promise<AppDocRecord> {
  const byId = /^[0-9a-f]{32}$/i.test(scope);
  for (const table of ["sys_app", "sys_store_app"]) {
    try {
      const { records } = await queryTable({
        table,
        query: byId ? `sys_id=${scope}` : `scope=${scope}`,
        fields: [
          "sys_id",
          "name",
          "scope",
          "version",
          "vendor",
          "short_description",
        ],
        displayValue: "false",
        limit: 1,
      });
      const r = records[0];
      if (r) {
        return {
          table,
          sys_id: snString(r.sys_id),
          name: snString(r.name),
          scope: snString(r.scope),
          version: snString(r.version),
          vendor: snString(r.vendor),
          short_description: cell(r.short_description, 500),
        };
      }
    } catch (error) {
      if (!isAccessDenied(error)) throw error;
    }
  }
  throw new ServiceNowError(
    `No application with scope '${scope}' was found in sys_app or sys_store_app.`,
    404,
    undefined,
    {
      hint: "Pass the scope namespace (x_acme_app) or the application's sys_id; servicenow_list_artifacts with artifactType 'table' lists what a scope owns.",
    },
  );
}

/** What the registry-driven artefact sweep of one scope found (ID-22, ID-29). */
export interface ScopeArtefacts {
  /** Artefacts per registry type (non-empty types only, omitted fields dropped). */
  artefacts: Record<string, ArtifactSummary[]>;
  /** Unverified types whose table could not be read (gate O-5). */
  degraded: string[];
  /** Types the user could not read (ACL or table policy). */
  unreadable: string[];
  /** Types whose listing stopped at LIST_LIMIT.max. */
  capped: Record<string, { listed: number; total: number }>;
  /** Degraded types whose licensed plugin / store app is not installed. */
  packageOff: Record<string, string>;
  /** Degraded types whose table the instance does not have (unlicensed). */
  absent: string[];
}

/**
 * List every registry type (bar `table`) of one scope through listArtifacts,
 * so the table policy, the unverified-type degrade path and the SDK-managed
 * verdicts apply exactly as in servicenow_list_artifacts.
 */
async function collectScopeArtefacts(
  scopeRef: string,
): Promise<ScopeArtefacts> {
  const out: ScopeArtefacts = {
    artefacts: {},
    degraded: [],
    unreadable: [],
    capped: {},
    packageOff: {},
    absent: [],
  };
  for (const group of ARTIFACT_GROUPS) {
    for (const t of ARTIFACT_TYPES.filter((x) => x.group === group)) {
      if (t.type === "table") continue;
      let res: Record<string, unknown>;
      try {
        res = await listArtifacts({
          artifactType: t.type,
          scope: scopeRef,
          limit: LIST_LIMIT.max,
        });
      } catch (error) {
        if (!isAccessDenied(error)) throw error;
        out.unreadable.push(t.type);
        continue;
      }
      if (res.degraded) {
        out.degraded.push(t.type);
        if (typeof res.requires === "string") {
          out.packageOff[t.type] = res.requires;
        } else if (res.available === false) {
          out.absent.push(t.type);
        }
        continue;
      }
      const rows = (res.artifacts as ArtifactSummary[]).map((a) => {
        const row: ArtifactSummary = { ...a };
        for (const f of Object.keys(row)) {
          if (omitted(t, f)) delete row[f];
        }
        return row;
      });
      if (!rows.length) continue;
      out.artefacts[t.type] = rows;
      const total = typeof res.total === "number" ? res.total : rows.length;
      if (total > rows.length) {
        out.capped[t.type] = { listed: rows.length, total };
      }
    }
  }
  return out;
}

/** Collect the application document's data (metadata only). */
export async function collectApp(
  scope: string,
  opts: CollectOptions = {},
): Promise<AppDocData> {
  const s = scope.trim();
  assertNoCaret(s, "scope");
  if (s.toLowerCase() === "global") {
    throw new ServiceNowError(
      "The global scope is the whole instance, not one application.",
      400,
      undefined,
      {
        hint: "Document a scoped application (x_…) here; the instance-wide document is servicenow_document_instance.",
      },
    );
  }
  const caveats: string[] = [];
  const app = await appRecord(s);
  const scopeRef = /^[0-9a-f]{32}$/i.test(s) ? s : app.scope || s;

  const tablesRes = await queryTable({
    table: "sys_db_object",
    query: `${scopeClause("sys_scope", scopeRef)}^ORDERBYname`,
    fields: ["name", "label", "super_class.name"],
    displayValue: "false",
    fetchAll: true,
  });
  if (tablesRes.truncated) {
    caveats.push(
      `Tables: the sys_db_object read stopped at SN_MAX_RECORDS (${getMaxRecords()}); the list is partial.`,
    );
  }
  const tables = tablesRes.records.map((r) => ({
    name: snString(r.name),
    label: snString(r.label),
    extends: snString(r["super_class.name"]),
  }));

  const { artefacts, degraded, unreadable, capped } =
    await collectScopeArtefacts(scopeRef);
  for (const [type, c] of Object.entries(capped)) {
    caveats.push(
      `${type}: ${c.listed} of ${c.total} records listed (the listing stops at ${LIST_LIMIT.max}).`,
    );
  }

  let er: string | undefined;
  if (tables.length) {
    er = await diagram(
      "ER diagram",
      () =>
        generateErDiagram(
          tables.map((x) => x.name),
          { columns: "keys", depth: 0 },
        ),
      caveats,
    );
  }

  const detail = opts.detail
    ? await collectAppDetail(scopeRef, artefacts, caveats)
    : undefined;

  return {
    app,
    tables,
    artefacts,
    degraded,
    unreadable,
    ...(er !== undefined ? { er } : {}),
    ...(detail ? { detail } : {}),
    caveats,
  };
}

/** P-21: the `detail` sections of the application document. */
function renderAppDetail(d: AppDetail): string[] {
  const lines: string[] = ["## Diagrams", ""];
  if (!d.diagrams.length) lines.push("_None._", "");
  for (const g of d.diagrams) {
    lines.push(
      `### ${code(g.type)} ${cell(g.name || g.sys_id)}`,
      "",
      mermaidBlock(g.mermaid),
      "",
    );
  }
  lines.push("## Dependencies", "");
  if (d.dependencies) {
    lines.push(
      `Outbound references of ${d.dependencies.roots} artefact(s): ${d.dependencies.nodes} nodes, ${d.dependencies.edges} edges.`,
      "",
      mermaidBlock(d.dependencies.mermaid),
      "",
    );
  } else {
    lines.push("_None._", "");
  }
  lines.push("## Lint summary", "");
  if (d.lint) {
    const l = d.lint;
    lines.push(
      `${l.scanned} artefacts scanned · ${l.findingCount} findings (error ${l.bySeverity.error ?? 0} · warn ${l.bySeverity.warn ?? 0} · info ${l.bySeverity.info ?? 0}).`,
      "",
      tableOrNone(
        ["Type", "Scanned", "Findings"],
        Object.entries(l.types).map(([t, v]) => [
          code(t),
          String(v.scanned),
          String(v.findingCount),
        ]),
      ),
      "",
    );
    if (l.top.length) {
      lines.push(
        mdTable(
          ["Type", "Artefact", "Field", "Findings", "Top rule"],
          l.top.map((r) => [
            code(r.type),
            cell(r.name),
            r.field,
            String(r.findings),
            r.rule,
          ]),
        ),
        "",
      );
    }
  } else {
    lines.push("_Not available._", "");
  }
  return lines;
}

/** Render the application document (pure: same data, same bytes). */
export function renderApp(data: AppDocData, ctx: RenderContext): string {
  const a = data.app;
  const typeOf = new Map(ARTIFACT_TYPES.map((t) => [t.type, t]));
  const artefactCount = Object.values(data.artefacts).reduce(
    (n, rows) => n + rows.length,
    0,
  );
  const lines: string[] = [
    `# Application ${code(a.scope || a.name)}`,
    "",
    `Generated by servicenow_document_app from the instance metadata of profile ${code(ctx.profile)} (the timestamp is in the frontmatter). Text inside the manual block survives re-runs.`,
    "",
    mdTable(
      ["Field", "Value"],
      [
        ["Name", cell(a.name)],
        ["Scope", code(a.scope)],
        ["Version", a.version],
        ["Vendor", cell(a.vendor)],
        ["Record", `${a.table} ${code(a.sys_id)}`],
        ["Description", a.short_description],
      ],
    ),
    "",
    `- **Tables:** ${data.tables.length}`,
    `- **Artefacts:** ${artefactCount} in ${Object.keys(data.artefacts).length} type(s)`,
    "",
    ...PURPOSE_BLOCK,
    "## Tables",
    "",
    tableOrNone(
      ["Table", "Label", "Extends"],
      data.tables.map((t) => [code(t.name), cell(t.label), code(t.extends)]),
    ),
    "",
  ];
  if (data.er !== undefined) {
    lines.push("### Entity relationships", "", mermaidBlock(data.er), "");
  }

  for (const [type, title] of [
    ["role", "Roles"],
    ["cross_scope_privilege", "Cross-scope privileges"],
  ] as const) {
    const t = typeOf.get(type);
    const rows = data.artefacts[type];
    lines.push(
      `## ${title}`,
      "",
      t && rows ? artifactTable(t, rows) : "_None._",
      "",
    );
  }

  lines.push("## Artefacts", "");
  let any = false;
  for (const group of ARTIFACT_GROUPS) {
    const types = ARTIFACT_TYPES.filter(
      (t) =>
        t.group === group &&
        !OWN_SECTION_TYPES.has(t.type) &&
        data.artefacts[t.type]?.length,
    );
    if (!types.length) continue;
    any = true;
    lines.push(`### Group ${code(group)}`, "");
    for (const t of types) {
      const rows = data.artefacts[t.type]!;
      lines.push(
        `#### ${code(t.type)} (${code(t.table)}, ${rows.length})`,
        "",
        artifactTable(t, rows),
        "",
      );
    }
  }
  if (!any) lines.push("_None._", "");

  if (data.detail) lines.push(...renderAppDetail(data.detail));

  if (data.degraded.length) {
    lines.push(
      "## Not confirmed on this instance",
      "",
      "These artefact types are not confirmed on a live instance (gate O-5): their table could not be read here, so they are left out rather than reported empty.",
      "",
      ...data.degraded.map(
        (t) => `- ${code(t)} (${code(typeOf.get(t)?.table ?? "")})`,
      ),
      "",
    );
  }

  lines.push(
    ...caveatsSection([
      ...data.unreadable.map(
        (t) =>
          `Unreadable: ${code(t)} (${code(typeOf.get(t)?.table ?? "")}) could not be read by this user; its artefacts are missing here.`,
      ),
      ...data.caveats,
      VISIBILITY_CAVEAT,
      METADATA_CAVEAT,
    ]),
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Security document (ID-23)
// ---------------------------------------------------------------------------

/** SecurityCheckName in declaration order: the document's section order. */
export const SECURITY_CHECK_ORDER: readonly SecurityCheckName[] = [
  "acl_roles",
  "role_inheritance",
  "public_rest_resources",
  "public_ui_pages",
  "tables_without_acl",
  "admin_overlap_roles",
  "elevated_privilege_acls",
];

/** Which check a finding belongs to; `undefined` for the ACL script rules. */
function checkOf(f: SecurityFinding): SecurityCheckName | undefined {
  switch (f.rule) {
    case "acl-roles-only":
    case "acl-open":
    case "acl-public-role":
      return "acl_roles";
    case "public-rest-resource":
      return "public_rest_resources";
    case "public-ui-page":
    case "public-page":
      return "public_ui_pages";
    case "table-no-acl":
      return "tables_without_acl";
    case "admin-overlap-role":
      return "admin_overlap_roles";
    case "acl-elevated-privilege":
      return "elevated_privilege_acls";
    default:
      return undefined;
  }
}

const MATRIX_RULES = new Set([
  "acl-open",
  "acl-public-role",
  "acl-elevated-privilege",
  "acl-roles-only",
]);
const MATRIX_OPERATIONS = ["create", "read", "write", "delete"] as const;

/** Table × operation → the roles each ACL requires (`public` for none). */
export function aclMatrix(
  findings: readonly SecurityFinding[],
): { table: string; cells: Record<string, string[]> }[] {
  const seen = new Set<string>();
  const rows = new Map<string, Record<string, string[]>>();
  for (const f of findings) {
    if (!MATRIX_RULES.has(f.rule) || !f.roles || seen.has(f.sys_id)) continue;
    seen.add(f.sys_id);
    const table = f.table ?? f.name.split(".")[0] ?? f.name;
    const op = f.operation;
    if (!(MATRIX_OPERATIONS as readonly string[]).includes(op)) continue;
    const row = rows.get(table) ?? {};
    const entry = f.roles.length ? [...f.roles].sort().join(", ") : "public";
    const list = row[op] ?? [];
    if (!list.includes(entry)) list.push(entry);
    row[op] = list.sort();
    rows.set(table, row);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([table, cells]) => ({ table, cells }));
}

function findingRows(findings: SecurityFinding[]): string[][] {
  return findings.map((f) => [
    f.severity,
    f.rule,
    code(f.name),
    f.operation,
    (f.roles ?? []).join(", "),
    f.hint,
  ]);
}

const FINDING_HEADER = [
  "Severity",
  "Rule",
  "Name",
  "Operation",
  "Roles",
  "Hint",
];

/** Render the security document (pure: same scan, same bytes). */
export function renderSecurity(scan: SecurityScan, ctx: RenderContext): string {
  const lines: string[] = [
    `# Security review — profile ${code(ctx.profile)}`,
    "",
    "Generated from the security scan of servicenow_check_code_health (S-3; the timestamp is in the frontmatter). Text inside the manual block survives re-runs.",
    "",
    `- **Scan available:** ${scan.available ? "yes" : "no"}`,
    ...(scan.unavailableReason
      ? [`- **Unavailable:** ${scan.unavailableReason}`]
      : []),
    `- **Active ACLs scanned:** ${scan.aclCount}`,
    `- **Findings:** ${scan.findings.length} (error ${scan.bySeverity.error}, warn ${scan.bySeverity.warn}, info ${scan.bySeverity.info})`,
    "",
    ...PURPOSE_BLOCK,
  ];
  const caveats: string[] = [];
  if (scan.truncated) {
    const why =
      scan.truncatedReason === "cap"
        ? `SN_MAX_RECORDS (${getMaxRecords()})`
        : scan.truncatedReason === "scan_limit"
          ? "the fetchAll scan budget (the instance withheld most rows)"
          : scan.truncatedReason === "ceiling"
            ? "the scan's own row ceiling"
            : "an unknown limit";
    caveats.push(
      `Truncated: the ACL read stopped at ${why} before the last active ACL; the findings and the matrix are partial.`,
    );
  }
  if (scan.filtered) {
    caveats.push(
      `Filtered: the instance counted ${scan.filtered} ACL row(s) it did not return to this user; they are not in this document.`,
    );
  }
  if (!scan.available) {
    lines.push(
      ...caveatsSection([
        ...caveats,
        "No access-control data could be read, so this document holds no findings. Re-run with a user that can read sys_security_acl.",
        METADATA_CAVEAT,
      ]),
    );
    return lines.join("\n");
  }

  const matrix = aclMatrix(scan.findings);
  lines.push(
    "## ACL matrix",
    "",
    "Roles each flagged ACL requires, per table and operation (`public` = no role). Only ACLs the scan flagged are listed — an ACL with a condition or script and roles appears only when a rule flagged it.",
    "",
    tableOrNone(
      ["Table", ...MATRIX_OPERATIONS],
      matrix.map((r) => [
        code(r.table),
        ...MATRIX_OPERATIONS.map((op) => (r.cells[op] ?? []).join("; ")),
      ]),
    ),
    "",
    "## Checks",
    "",
  );

  const scripts = scan.findings.filter((f) => checkOf(f) === undefined);
  lines.push(
    "### ACL scripts",
    "",
    tableOrNone(FINDING_HEADER, findingRows(scripts)),
    "",
  );
  for (const name of SECURITY_CHECK_ORDER) {
    const check = scan.checks?.[name];
    const findings = scan.findings.filter((f) => checkOf(f) === name);
    lines.push(`### ${code(name)}`, "");
    if (check) {
      lines.push(
        check.available
          ? `Scanned ${check.scanned} row(s), ${findings.length} finding(s)${check.truncated ? " — the read stopped early, so the result may be partial" : ""}.`
          : `Unavailable: ${check.unavailableReason ?? "the check's table could not be read."}`,
        ...(check.note ? ["", `Note: ${check.note}`] : []),
        "",
      );
      if (check.truncated) {
        caveats.push(
          `${name}: the check's read stopped early; its result may be partial.`,
        );
      }
    }
    lines.push(tableOrNone(FINDING_HEADER, findingRows(findings)), "");
  }
  lines.push(
    ...caveatsSection([...caveats, VISIBILITY_CAVEAT, METADATA_CAVEAT]),
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Instance-level kinds: shared reads
// ---------------------------------------------------------------------------

/** One table an instance-level kind read: its rows, or why it has none. */
export interface SectionRead {
  table: string;
  rows: Record<string, string>[];
  /** The user could not read the table (any error but a cancel). */
  unreadable?: true;
  /** The read stopped at the SN_MAX_RECORDS cap. */
  truncated?: true;
}

/**
 * Read `fields` of every row of `table` matching `query` as flat strings.
 * Never throws except on a cancel: an unreadable table is a flagged, empty
 * read that the document turns into a Caveats line.
 */
async function readSection(
  table: string,
  fields: string[],
  query: string,
): Promise<SectionRead> {
  throwIfCancelled();
  try {
    const r = await queryTable({
      table,
      fields,
      query,
      displayValue: "false",
      fetchAll: true,
    });
    return {
      table,
      rows: r.records.map((rec) =>
        Object.fromEntries(fields.map((f) => [f, snString(rec[f])])),
      ),
      ...(r.truncated ? { truncated: true as const } : {}),
    };
  } catch (error) {
    if (isCancelled(error)) throw error;
    return { table, rows: [], unreadable: true };
  }
}

const NOT_READABLE = "_Not readable for this user — see Caveats._";

/** A section's table, or the not-readable note. */
function sectionTable(
  read: SectionRead,
  header: string[],
  rows: string[][],
): string {
  return read.unreadable ? NOT_READABLE : tableOrNone(header, rows);
}

/** Caveats lines for unreadable and capped reads, in read order. */
function readCaveats(reads: SectionRead[]): string[] {
  const out: string[] = [];
  for (const r of reads) {
    if (r.unreadable) {
      out.push(
        `${codeOf(r.table)} is not readable for this user; its section is empty.`,
      );
    } else if (r.truncated) {
      out.push(
        `Truncated: the ${codeOf(r.table)} read stopped at the SN_MAX_RECORDS cap; its list is partial.`,
      );
    }
  }
  return out;
}

const yesNo = (v?: string): string =>
  v === "true" ? "yes" : v === "false" ? "no" : (v ?? "");

/** `code()` over an optional row field. */
const codeOf = (v?: string): string => code(v ?? "");

/** Compare by a numeric `order` then by name (stable across instances). */
function byOrderThenName(
  a: Record<string, string>,
  b: Record<string, string>,
): number {
  const oa = Number(a.order);
  const ob = Number(b.order);
  const na = Number.isFinite(oa) ? oa : 0;
  const nb = Number.isFinite(ob) ? ob : 0;
  if (na !== nb) return na - nb;
  return (a.name ?? "").localeCompare(b.name ?? "");
}

// ---------------------------------------------------------------------------
// Catalog document (catalogs → categories → items → variables)
// ---------------------------------------------------------------------------

export interface CatalogDocData {
  catalogs: SectionRead;
  categories: SectionRead;
  items: SectionRead;
  variables: SectionRead;
}

/** Catalog variable types (item_option_new.type) by their stored number. */
const VARIABLE_TYPES: Record<string, string> = {
  "1": "Yes/No",
  "2": "Multi line text",
  "3": "Multiple choice",
  "4": "Numeric scale",
  "5": "Select box",
  "6": "Single line text",
  "7": "Checkbox",
  "8": "Reference",
  "9": "Date",
  "10": "Date/Time",
  "11": "Label",
  "12": "Break",
  "14": "Macro",
  "15": "UI Page",
  "16": "Wide single line text",
  "17": "Macro with label",
  "18": "Lookup select box",
  "19": "Container start",
  "20": "Container end",
  "21": "List collector",
  "22": "Lookup multiple choice",
  "23": "HTML",
  "24": "Container split",
  "25": "Masked",
  "26": "Email",
  "27": "URL",
  "28": "IP address",
  "29": "Duration",
  "31": "Requested for",
  "32": "Rich text label",
  "33": "Attachment",
};

export async function collectCatalog(): Promise<CatalogDocData> {
  const catalogs = await readSection(
    "sc_catalog",
    ["sys_id", "title", "active"],
    "ORDERBYtitle",
  );
  const categories = await readSection(
    "sc_category",
    ["sys_id", "title", "sc_catalog", "parent", "active"],
    "ORDERBYtitle",
  );
  const items = await readSection(
    "sc_cat_item",
    ["sys_id", "name", "sys_class_name", "active", "category", "sc_catalogs"],
    "ORDERBYname",
  );
  const variables = await readSection(
    "item_option_new",
    [
      "sys_id",
      "name",
      "question_text",
      "type",
      "cat_item",
      "order",
      "mandatory",
      "active",
    ],
    "cat_itemISNOTEMPTY^ORDERBYorder",
  );
  return { catalogs, categories, items, variables };
}

/** Render the catalog document (pure: same data, same bytes). */
export function renderCatalog(
  data: CatalogDocData,
  ctx: RenderContext,
): string {
  const { catalogs, categories, items, variables } = data;
  const catalogTitle = new Map(
    catalogs.rows.map((c) => [c.sys_id, c.title || c.sys_id]),
  );
  const categoryTitle = new Map(
    categories.rows.map((c) => [c.sys_id, c.title || c.sys_id]),
  );
  const itemCatalogs = (i: Record<string, string>): string =>
    (i.sc_catalogs ?? "")
      .split(",")
      .filter(Boolean)
      .map((id) => catalogTitle.get(id) ?? id)
      .join(", ");
  const lines: string[] = [
    `# Service catalog — profile ${code(ctx.profile)}`,
    "",
    "Generated from the catalog definitions (sc_catalog, sc_category, sc_cat_item, item_option_new; the timestamp is in the frontmatter). Text inside the manual block survives re-runs.",
    "",
    `- **Catalogs:** ${catalogs.rows.length}`,
    `- **Categories:** ${categories.rows.length}`,
    `- **Items:** ${items.rows.length}`,
    `- **Item variables:** ${variables.rows.length}`,
    "",
    ...PURPOSE_BLOCK,
    "## Catalogs",
    "",
    sectionTable(
      catalogs,
      ["Catalog", "Active", "Categories", "Items"],
      catalogs.rows.map((c) => [
        cell(c.title),
        yesNo(c.active),
        String(categories.rows.filter((x) => x.sc_catalog === c.sys_id).length),
        String(
          items.rows.filter((i) =>
            (i.sc_catalogs ?? "").split(",").includes(c.sys_id ?? ""),
          ).length,
        ),
      ]),
    ),
    "",
    "## Categories",
    "",
    sectionTable(
      categories,
      ["Category", "Catalog", "Parent", "Active"],
      categories.rows.map((c) => [
        cell(c.title),
        cell(catalogTitle.get(c.sc_catalog) ?? c.sc_catalog),
        cell(c.parent ? (categoryTitle.get(c.parent) ?? c.parent) : ""),
        yesNo(c.active),
      ]),
    ),
    "",
    "## Items",
    "",
    sectionTable(
      items,
      ["Item", "Class", "Category", "Catalogs", "Active", "Variables"],
      items.rows.map((i) => [
        cell(i.name),
        codeOf(i.sys_class_name),
        cell(i.category ? (categoryTitle.get(i.category) ?? i.category) : ""),
        cell(itemCatalogs(i)),
        yesNo(i.active),
        String(variables.rows.filter((v) => v.cat_item === i.sys_id).length),
      ]),
    ),
    "",
    "## Variables",
    "",
  ];
  if (variables.unreadable) {
    lines.push(NOT_READABLE, "");
  } else {
    const itemName = new Map(items.rows.map((i) => [i.sys_id, i.name]));
    const byItem = new Map<string, Record<string, string>[]>();
    for (const v of variables.rows) {
      const item = v.cat_item ?? "";
      const list = byItem.get(item) ?? [];
      list.push(v);
      byItem.set(item, list);
    }
    const itemIds = [...byItem.keys()].sort((a, b) =>
      (itemName.get(a) ?? a).localeCompare(itemName.get(b) ?? b),
    );
    if (!itemIds.length) lines.push("_None._", "");
    for (const id of itemIds) {
      lines.push(
        `### ${cell(itemName.get(id) ?? id)}`,
        "",
        mdTable(
          ["Order", "Name", "Question", "Type", "Mandatory", "Active"],
          (byItem.get(id) ?? [])
            .sort(byOrderThenName)
            .map((v) => [
              v.order ?? "",
              codeOf(v.name),
              cell(v.question_text),
              VARIABLE_TYPES[v.type ?? ""] ?? v.type ?? "",
              yesNo(v.mandatory),
              yesNo(v.active),
            ]),
        ),
        "",
      );
    }
  }
  lines.push(
    ...caveatsSection([
      ...readCaveats([catalogs, categories, items, variables]),
      "Variables that come from a variable set are not listed per item; only variables attached directly to an item are.",
      VISIBILITY_CAVEAT,
      METADATA_CAVEAT,
    ]),
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Integrations document (inbound REST, outbound REST, import)
// ---------------------------------------------------------------------------

export interface IntegrationsDocData {
  restApis: SectionRead;
  restMessages: SectionRead;
  transformMaps: SectionRead;
  dataSources: SectionRead;
}

/**
 * Only descriptive fields are read: no endpoints' credentials, no scripts,
 * no connection strings (a data source's `connection_url` and credentials
 * stay out of the document).
 */
export async function collectIntegrations(): Promise<IntegrationsDocData> {
  const restApis = await readSection(
    "sys_ws_definition",
    ["name", "namespace", "base_uri", "active", "sys_scope.scope"],
    "ORDERBYname",
  );
  const restMessages = await readSection(
    "sys_rest_message",
    ["name", "rest_endpoint", "authentication_type", "sys_scope.scope"],
    "ORDERBYname",
  );
  const transformMaps = await readSection(
    "sys_transform_map",
    [
      "name",
      "source_table",
      "target_table",
      "active",
      "run_business_rules",
      "sys_scope.scope",
    ],
    "ORDERBYname",
  );
  const dataSources = await readSection(
    "sys_data_source",
    ["name", "type", "import_set_table_name", "format", "sys_scope.scope"],
    "ORDERBYname",
  );
  return { restApis, restMessages, transformMaps, dataSources };
}

/** Render the integrations document (pure: same data, same bytes). */
export function renderIntegrations(
  data: IntegrationsDocData,
  ctx: RenderContext,
): string {
  const { restApis, restMessages, transformMaps, dataSources } = data;
  const scope = (r: Record<string, string>): string =>
    codeOf(r["sys_scope.scope"]);
  const lines: string[] = [
    `# Integrations — profile ${code(ctx.profile)}`,
    "",
    "Generated from the integration definitions (sys_ws_definition, sys_rest_message, sys_transform_map, sys_data_source; the timestamp is in the frontmatter). Text inside the manual block survives re-runs.",
    "",
    `- **Scripted REST APIs:** ${restApis.rows.length}`,
    `- **Outbound REST messages:** ${restMessages.rows.length}`,
    `- **Transform maps:** ${transformMaps.rows.length}`,
    `- **Data sources:** ${dataSources.rows.length}`,
    "",
    ...PURPOSE_BLOCK,
    "## Inbound — scripted REST APIs",
    "",
    sectionTable(
      restApis,
      ["Name", "Namespace", "Base URI", "Active", "Scope"],
      restApis.rows.map((r) => [
        cell(r.name),
        codeOf(r.namespace),
        codeOf(r.base_uri),
        yesNo(r.active),
        scope(r),
      ]),
    ),
    "",
    "## Outbound — REST messages",
    "",
    sectionTable(
      restMessages,
      ["Name", "Endpoint", "Authentication", "Scope"],
      restMessages.rows.map((r) => [
        cell(r.name),
        code(cell(r.rest_endpoint)),
        cell(r.authentication_type),
        scope(r),
      ]),
    ),
    "",
    "## Import — transform maps",
    "",
    sectionTable(
      transformMaps,
      [
        "Name",
        "Source table",
        "Target table",
        "Active",
        "Runs business rules",
        "Scope",
      ],
      transformMaps.rows.map((r) => [
        cell(r.name),
        codeOf(r.source_table),
        codeOf(r.target_table),
        yesNo(r.active),
        yesNo(r.run_business_rules),
        scope(r),
      ]),
    ),
    "",
    "## Import — data sources",
    "",
    sectionTable(
      dataSources,
      ["Name", "Type", "Import set table", "Format", "Scope"],
      dataSources.rows.map((r) => [
        cell(r.name),
        cell(r.type),
        codeOf(r.import_set_table_name),
        cell(r.format),
        scope(r),
      ]),
    ),
    "",
    ...caveatsSection([
      ...readCaveats([restApis, restMessages, transformMaps, dataSources]),
      "Descriptive fields only: credentials, connection strings and scripts of these definitions are not read.",
      VISIBILITY_CAVEAT,
      METADATA_CAVEAT,
    ]),
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Instance README (the landing page of a profile's documentation)
// ---------------------------------------------------------------------------

/** Build properties shown in the README's Version section. */
const VERSION_PROPERTIES = [
  "glide.buildname",
  "glide.builddate",
  "glide.buildtag",
  "glide.war",
];

/** One document linked from the README, relative to the profile folder. */
export interface InstanceDocLink {
  kind: string;
  target: string;
  path: string;
}

export interface InstanceDocData {
  version: SectionRead;
  tableCount: number;
  plugins?: {
    source: string;
    total: number;
    active: { id: string; name: string; version: string }[];
  };
  apps: Record<string, AppRow[]>;
  automation: Record<string, AutomationStat | null>;
  updateSets: SectionRead;
  /** The documents this run writes besides the README. */
  documents: InstanceDocLink[];
  /** Collector sources that could not be read or hit the cap. */
  unreadable: string[];
  capped: string[];
}

/** The instance-run context the README and artifact-types kinds read. */
export interface InstanceRunContext {
  documents: InstanceDocLink[];
  /** Tables whose records some document of this run holds. */
  collected: ReadonlySet<string>;
  /** Application rows read before the run (depth without named apps, S-16). */
  apps?: CollectorResult<Record<string, AppRow[]>>;
  /** S-16 discovery: the depth and the scopes this run documents. */
  discovery?: DiscoveryRun;
  /** Data of the documents built so far, keyed `<kind>:<target>` (S-16). */
  built?: ReadonlyMap<string, unknown>;
}

export async function collectInstance(
  opts: CollectOptions,
): Promise<InstanceDocData> {
  const version = await readSection(
    "sys_properties",
    ["name", "value"],
    `nameIN${VERSION_PROPERTIES.join(",")}^ORDERBYname`,
  );
  const tables = await collectTables();
  const plugins = await collectPlugins();
  const apps = opts.instance?.apps ?? (await collectApps());
  const automation = await collectAutomation();
  const updateSets = await readSection(
    "sys_update_set",
    ["name", "application.scope"],
    "state=in progress^ORDERBYname",
  );
  const unreadable = [
    ...tables.unreadable,
    ...plugins.unreadable,
    ...apps.unreadable,
    ...automation.unreadable,
  ];
  const capped = [
    ...tables.capped,
    ...plugins.capped,
    ...apps.capped,
    ...automation.capped,
  ];
  const p = plugins.data;
  return {
    version,
    tableCount: tables.data.length,
    ...(p
      ? {
          plugins: {
            source: p.source,
            total: p.plugins.length,
            active: p.plugins
              .filter((x) => x.active === "active" || x.active === "true")
              .map((x) => ({ id: x.id, name: x.name, version: x.version }))
              .sort((a, b) => a.id.localeCompare(b.id)),
          },
        }
      : {}),
    apps: Object.fromEntries(
      Object.entries(apps.data).map(([source, rows]) => [
        source,
        [...rows].sort((a, b) => a.scope.localeCompare(b.scope)),
      ]),
    ),
    automation: automation.data,
    updateSets,
    documents: opts.instance?.documents ?? [],
    unreadable,
    capped,
  };
}

/** Render the instance README (pure: same data, same bytes). */
export function renderInstance(
  data: InstanceDocData,
  ctx: RenderContext,
): string {
  const appRows = Object.entries(data.apps).flatMap(([source, rows]) =>
    rows.map((a) => ({ ...a, source })),
  );
  const documented = new Map(
    data.documents.filter((d) => d.kind === "app").map((d) => [d.target, d]),
  );
  const lines: string[] = [
    `# Instance — profile ${code(ctx.profile)}`,
    "",
    "Generated by servicenow_document_instance from the instance's metadata (the timestamp is in the frontmatter). Text inside the manual block survives re-runs.",
    "",
    "## Version",
    "",
    sectionTable(
      data.version,
      ["Property", "Value"],
      data.version.rows.map((r) => [codeOf(r.name), cell(r.value)]),
    ),
    "",
    "## Counts",
    "",
    mdTable(["What", "Count"], countRows(data)),
    "",
    ...PURPOSE_BLOCK,
    "## Documents in this run",
    "",
    ...(data.documents.length
      ? data.documents.map((d) => `- [${docTitle(d)}](${d.path})`)
      : ["_None._"]),
    "",
    "## Applications",
    "",
    tableOrNone(
      ["Name", "Scope", "Version", "Active", "Source", "Document"],
      appRows.map((a) => {
        const doc = documented.get(a.scope);
        return [
          cell(a.name),
          code(a.scope),
          cell(a.version),
          yesNo(a.active),
          code(a.source),
          doc ? `[${a.scope}](${doc.path})` : "",
        ];
      }),
    ),
    "",
    "## Active plugins",
    "",
    data.plugins
      ? tableOrNone(
          ["ID", "Name", "Version"],
          data.plugins.active.map((x) => [
            code(x.id),
            cell(x.name),
            cell(x.version),
          ]),
        )
      : NOT_READABLE,
    "",
    "## Automation",
    "",
    automationTable(data.automation),
    "",
    "## Update sets in progress",
    "",
    sectionTable(
      data.updateSets,
      ["Name", "Application"],
      data.updateSets.rows.map((r) => [
        cell(r.name),
        codeOf(r["application.scope"]),
      ]),
    ),
    "",
  ];
  const caveats = [
    ...readCaveats([data.version, data.updateSets]),
    ...data.unreadable.map(
      (s) => `${code(s)} is not readable for this user; it is missing above.`,
    ),
    ...data.capped.map(
      (s) =>
        `Truncated: the ${code(s)} read stopped at the SN_MAX_RECORDS cap; its count is a lower bound.`,
    ),
  ];
  if (data.documents.length) {
    caveats.push(
      "A linked document that is missing on disk failed or was not reached (a cancelled run); index.json `runs` records whether this run finished.",
    );
  }
  lines.push(
    ...caveatsSection([...caveats, VISIBILITY_CAVEAT, METADATA_CAVEAT]),
  );
  return lines.join("\n");
}

/** The README's Counts rows (also the discovery overview's, S-16). */
function countRows(data: InstanceDocData): string[][] {
  const stats = Object.values(data.automation).filter(
    (s): s is AutomationStat => s !== null,
  );
  const scriptTotal = stats.reduce((n, s) => n + s.total, 0);
  const scriptActive = stats.reduce((n, s) => n + (s.active ?? 0), 0);
  return [
    ["Tables (`sys_db_object`)", String(data.tableCount)],
    [
      "Plugins (active / total)",
      data.plugins
        ? `${data.plugins.active.length} / ${data.plugins.total}`
        : "n/a",
    ],
    ...Object.entries(data.apps).map(([source, rows]) => [
      `Applications (${code(source)})`,
      String(rows.length),
    ]),
    ["Scripts (active / total)", `${scriptActive} / ${scriptTotal}`],
    [
      "Update sets in progress",
      data.updateSets.unreadable ? "n/a" : String(data.updateSets.rows.length),
    ],
  ];
}

/** The automation statistics table (README and discovery overview). */
function automationTable(
  automation: Record<string, AutomationStat | null>,
): string {
  return tableOrNone(
    ["Type", "Table", "Total", "Active", "Last updated"],
    Object.entries(automation).map(([type, s]) =>
      s
        ? [
            type,
            code(s.table),
            String(s.total),
            s.active === null ? "n/a" : String(s.active),
            s.lastUpdated,
          ]
        : [type, "", "n/a", "n/a", ""],
    ),
  );
}

function docTitle(d: InstanceDocLink): string {
  switch (d.kind) {
    case "table":
      return `Table ${d.target}`;
    case "app":
      return `Application ${d.target}`;
    case "discovery_tables":
      return `Discovery: tables of ${d.target}`;
    case "discovery_artifacts":
      return `Discovery: artefacts of ${d.target}`;
    default:
      return (
        (DOC_KINDS[d.kind as DocKindId] as DocKind | undefined)?.title ?? d.kind
      );
  }
}

// ---------------------------------------------------------------------------
// Artifact types (ID-29): the registry, with what this run collected
// ---------------------------------------------------------------------------

interface CatalogTypeEntry {
  type: string;
  group: string;
  table: string;
  sdkApi: string;
  verified: boolean;
}

export interface ArtifactTypesDocData {
  count: number;
  note: string;
  types: {
    type: string;
    group: string;
    table: string;
    sdkApi: string;
    verified: boolean;
    collected: boolean;
  }[];
}

export function collectArtifactTypes(
  opts: CollectOptions,
): Promise<ArtifactTypesDocData> {
  const catalog = artifactTypeCatalog() as {
    count: number;
    note: string;
    types: CatalogTypeEntry[];
  };
  const collected = opts.instance?.collected ?? new Set<string>();
  return Promise.resolve({
    count: catalog.count,
    note: catalog.note,
    types: catalog.types.map((t) => ({
      type: t.type,
      group: t.group,
      table: t.table,
      sdkApi: t.sdkApi,
      verified: t.verified,
      collected: collected.has(t.table),
    })),
  });
}

/** Render the artifact-types document (pure: same data, same bytes). */
export function renderArtifactTypes(
  data: ArtifactTypesDocData,
  ctx: RenderContext,
): string {
  const collected = data.types.filter((t) => t.collected).length;
  return [
    `# Artifact types — profile ${code(ctx.profile)}`,
    "",
    "The artefact types this server knows (servicenow_artifact_types), and which of them this documentation run collected (the timestamp is in the frontmatter).",
    "",
    `- **Types:** ${data.count}`,
    `- **Collected in this run:** ${collected}`,
    "",
    "## Types",
    "",
    "`Collected in this run` is yes when a document of this run holds at least one record from the type's table.",
    "",
    tableOrNone(
      [
        "Type",
        "Group",
        "Table",
        "SDK API",
        "Verified",
        "Collected in this run",
      ],
      data.types.map((t) => [
        code(t.type),
        t.group,
        code(t.table),
        cell(t.sdkApi),
        t.verified ? "yes" : "no",
        t.collected ? "yes" : "no",
      ]),
    ),
    "",
    ...caveatsSection([
      data.note,
      "A type not collected may simply have no records, be outside the documented tables and applications, or be hidden from this user.",
    ]),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Discovery (S-16): <profile>/discovery/, a tiered map of the instance
// ---------------------------------------------------------------------------

/**
 * `document_instance({depth})` tiers, cumulative: `overview` (version and
 * counts), `apps` (+ per-scope tables and dictionary, the apps index),
 * `artefacts` (+ per-scope artefacts by registry type).
 */
export const DISCOVERY_DEPTHS = ["overview", "apps", "artefacts"] as const;
export type DiscoveryDepth = (typeof DISCOVERY_DEPTHS)[number];

/** The discovery part of one document_instance run. */
export interface DiscoveryRun {
  depth: DiscoveryDepth;
  /** Scopes the per-scope files cover, in order. */
  scopes: string[];
  /** `sys_app` scopes beyond INSTANCE_TARGETS_MAX, left out of this run. */
  skipped: string[];
  /** `named` (the `apps` argument) or `sys_app` (every custom application). */
  source: "named" | "sys_app";
}

const DISCOVERY_DIR = "discovery";

/** Files of a discovery run, relative to the discovery folder, in run order. */
export function discoveryFiles(run: DiscoveryRun): string[] {
  if (run.depth === "overview") return ["overview.md"];
  return [
    "overview.md",
    "apps.md",
    ...run.scopes.map((s) => `tables-${s}.md`),
    ...(run.depth === "artefacts"
      ? run.scopes.map((s) => `artifacts-${s}.md`)
      : []),
  ];
}

const DISCOVERY_CAVEAT =
  "Discovery files are thin renderings of the same data the other documents of this profile use; re-run with the same depth to refresh them.";

export interface DiscoveryOverviewData {
  depth: DiscoveryDepth;
  version: SectionRead;
  tableCount: number;
  plugins?: { source: string; total: number; active: number };
  /** Applications per source table. */
  apps: Record<string, number>;
  automation: Record<string, AutomationStat | null>;
  updateSetsInProgress: number | null;
  scopes: string[];
  skipped: string[];
  files: string[];
  unreadable: string[];
  capped: string[];
}

async function collectDiscoveryOverview(
  opts: CollectOptions,
): Promise<DiscoveryOverviewData> {
  const run = discoveryOf(opts);
  const readme =
    (opts.instance?.built?.get("instance:README") as
      | InstanceDocData
      | undefined) ?? (await collectInstance(opts));
  return {
    depth: run.depth,
    version: readme.version,
    tableCount: readme.tableCount,
    ...(readme.plugins
      ? {
          plugins: {
            source: readme.plugins.source,
            total: readme.plugins.total,
            active: readme.plugins.active.length,
          },
        }
      : {}),
    apps: Object.fromEntries(
      Object.entries(readme.apps).map(([source, rows]) => [
        source,
        rows.length,
      ]),
    ),
    automation: readme.automation,
    updateSetsInProgress: readme.updateSets.unreadable
      ? null
      : readme.updateSets.rows.length,
    scopes: run.scopes,
    skipped: run.skipped,
    files: discoveryFiles(run),
    unreadable: readme.unreadable,
    capped: readme.capped,
  };
}

function discoveryOf(opts: CollectOptions): DiscoveryRun {
  const run = opts.instance?.discovery;
  if (!run) {
    throw new ServiceNowError(
      "Discovery documents are written by servicenow_document_instance with a depth.",
      400,
    );
  }
  return run;
}

/** Render discovery/overview.md (pure: same data, same bytes). */
export function renderDiscoveryOverview(
  data: DiscoveryOverviewData,
  ctx: RenderContext,
): string {
  const stats = Object.values(data.automation).filter(
    (s): s is AutomationStat => s !== null,
  );
  const scriptTotal = stats.reduce((n, s) => n + s.total, 0);
  const scriptActive = stats.reduce((n, s) => n + (s.active ?? 0), 0);
  return [
    `# Discovery — profile ${code(ctx.profile)}`,
    "",
    `Generated by servicenow_document_instance with depth ${code(data.depth)} (the timestamp is in the frontmatter). The profile's landing page is [README](../README.md).`,
    "",
    "## Version",
    "",
    sectionTable(
      data.version,
      ["Property", "Value"],
      data.version.rows.map((r) => [codeOf(r.name), cell(r.value)]),
    ),
    "",
    "## Counts",
    "",
    mdTable(
      ["What", "Count"],
      [
        ["Tables (`sys_db_object`)", String(data.tableCount)],
        [
          "Plugins (active / total)",
          data.plugins
            ? `${data.plugins.active} / ${data.plugins.total}`
            : "n/a",
        ],
        ...Object.entries(data.apps).map(([source, n]) => [
          `Applications (${code(source)})`,
          String(n),
        ]),
        ["Scripts (active / total)", `${scriptActive} / ${scriptTotal}`],
        [
          "Update sets in progress",
          data.updateSetsInProgress === null
            ? "n/a"
            : String(data.updateSetsInProgress),
        ],
        ["Scopes discovered", String(data.scopes.length)],
      ],
    ),
    "",
    "## Automation",
    "",
    automationTable(data.automation),
    "",
    "## Files",
    "",
    ...data.files.map((f) => `- [${f}](${f})`),
    "",
    ...caveatsSection([
      ...data.unreadable.map(
        (s) => `${code(s)} is not readable for this user; it is missing above.`,
      ),
      ...data.capped.map(
        (s) =>
          `Truncated: the ${code(s)} read stopped at the SN_MAX_RECORDS cap; its count is a lower bound.`,
      ),
      ...(data.skipped.length
        ? [
            `${data.skipped.length} more scope(s) beyond the ${INSTANCE_TARGETS_MAX}-scope cap were not discovered; name them with \`apps\`.`,
          ]
        : []),
      DISCOVERY_CAVEAT,
      VISIBILITY_CAVEAT,
      METADATA_CAVEAT,
    ]),
  ].join("\n");
}

/** Tables per sys_dictionary read (keeps the nameIN list short). */
const DICTIONARY_CHUNK = 50;

const DICTIONARY_FIELDS = [
  "name",
  "element",
  "column_label",
  "internal_type",
  "reference",
  "max_length",
  "mandatory",
];

export interface DiscoveryTablesData {
  scope: string;
  tables: SectionRead;
  /** Column definitions of the scope's tables (own columns only). */
  columns: SectionRead;
}

async function collectDiscoveryTables(
  scope: string,
): Promise<DiscoveryTablesData> {
  const tables = await readSection(
    "sys_db_object",
    ["name", "label", "super_class.name"],
    `${scopeClause("sys_scope", scope)}^ORDERBYname`,
  );
  const names = tables.rows.map((r) => r.name).filter(Boolean);
  const columns: SectionRead = { table: "sys_dictionary", rows: [] };
  for (let i = 0; i < names.length; i += DICTIONARY_CHUNK) {
    const chunk = names.slice(i, i + DICTIONARY_CHUNK);
    const r = await readSection(
      "sys_dictionary",
      DICTIONARY_FIELDS,
      `nameIN${chunk.join(",")}^elementISNOTEMPTY^ORDERBYname^ORDERBYelement`,
    );
    columns.rows.push(...r.rows);
    if (r.unreadable) columns.unreadable = true;
    if (r.truncated) columns.truncated = true;
  }
  return { scope, tables, columns };
}

/** Render discovery/tables-<scope>.md (pure: same data, same bytes). */
export function renderDiscoveryTables(
  data: DiscoveryTablesData,
  ctx: RenderContext,
): string {
  const byTable = new Map<string, Record<string, string>[]>();
  for (const c of data.columns.rows) {
    const name = c.name ?? "";
    const list = byTable.get(name) ?? [];
    list.push(c);
    byTable.set(name, list);
  }
  const lines: string[] = [
    `# Discovery: tables of ${code(data.scope)} — profile ${code(ctx.profile)}`,
    "",
    "Tables the scope owns (`sys_db_object`) and their own columns (`sys_dictionary`); inherited columns live on the parent table. [Overview](overview.md) · [Applications](apps.md)",
    "",
    "## Tables",
    "",
    sectionTable(
      data.tables,
      ["Table", "Label", "Extends", "Columns"],
      data.tables.rows.map((r) => [
        codeOf(r.name),
        cell(r.label),
        codeOf(r["super_class.name"]),
        data.columns.unreadable
          ? "n/a"
          : String(byTable.get(r.name ?? "")?.length ?? 0),
      ]),
    ),
    "",
  ];
  if (!data.columns.unreadable) {
    for (const t of data.tables.rows) {
      const cols = byTable.get(t.name ?? "") ?? [];
      lines.push(
        `## ${codeOf(t.name)}`,
        "",
        tableOrNone(
          ["Column", "Label", "Type", "Reference", "Max length", "Mandatory"],
          cols.map((c) => [
            codeOf(c.element),
            cell(c.column_label),
            codeOf(c.internal_type),
            codeOf(c.reference),
            cell(c.max_length),
            yesNo(c.mandatory),
          ]),
        ),
        "",
      );
    }
  }
  lines.push(
    ...caveatsSection([
      ...readCaveats([data.tables, data.columns]),
      DISCOVERY_CAVEAT,
      VISIBILITY_CAVEAT,
      METADATA_CAVEAT,
    ]),
  );
  return lines.join("\n");
}

/** Why a registry type has (or has no) rows in a discovery artefacts file. */
export type DiscoveryTypeStatus =
  | "collected"
  | "capped"
  | "empty"
  | "tables"
  | "unverified"
  | "absent"
  | "unreadable"
  | "package_off";

export interface DiscoveryArtifactsData {
  scope: string;
  types: {
    type: string;
    group: string;
    table: string;
    verified: boolean;
    status: DiscoveryTypeStatus;
    count?: number;
    total?: number;
    /** package_off: the plugin / store app that provides the table. */
    requires?: string;
  }[];
  /** Artefacts per registry type (non-empty types only). */
  artefacts: Record<string, ArtifactSummary[]>;
}

async function collectDiscoveryArtifacts(
  scope: string,
): Promise<DiscoveryArtifactsData> {
  const found = await collectScopeArtefacts(scope);
  const catalog = artifactTypeCatalog() as { types: CatalogTypeEntry[] };
  const unreadable = new Set(found.unreadable);
  const absent = new Set(found.absent);
  const degraded = new Set(found.degraded);
  return {
    scope,
    types: catalog.types.map((t) => {
      const head = {
        type: t.type,
        group: t.group,
        table: t.table,
        verified: t.verified,
      };
      const rows = found.artefacts[t.type];
      const cap = found.capped[t.type];
      const requires = found.packageOff[t.type];
      if (t.type === "table") return { ...head, status: "tables" as const };
      if (cap) {
        return {
          ...head,
          status: "capped" as const,
          count: cap.listed,
          total: cap.total,
        };
      }
      if (rows) {
        return { ...head, status: "collected" as const, count: rows.length };
      }
      if (requires) {
        return { ...head, status: "package_off" as const, requires };
      }
      if (absent.has(t.type)) return { ...head, status: "absent" as const };
      if (degraded.has(t.type)) {
        return { ...head, status: "unverified" as const };
      }
      if (unreadable.has(t.type)) {
        return { ...head, status: "unreadable" as const };
      }
      return { ...head, status: "empty" as const };
    }),
    artefacts: found.artefacts,
  };
}

function discoveryStatus(
  t: DiscoveryArtifactsData["types"][number],
  scope: string,
): string {
  switch (t.status) {
    case "collected":
      return `yes (${t.count})`;
    case "capped":
      return `yes, ${t.count} of ${t.total} (cap)`;
    case "tables":
      return `see [tables-${scope}.md](tables-${scope}.md)`;
    case "unverified":
      return "no — unverified: table not readable here (O-5)";
    case "absent":
      return "no — unverified: the instance has no such table";
    case "unreadable":
      return "no — unreadable for this user (ACL or table policy)";
    case "package_off":
      return `no — package off: ${code(t.requires ?? "")} not installed`;
    default:
      return "no — no records in this scope";
  }
}

/** Render discovery/artifacts-<scope>.md (pure: same data, same bytes). */
export function renderDiscoveryArtifacts(
  data: DiscoveryArtifactsData,
  ctx: RenderContext,
): string {
  const typeOf = new Map(ARTIFACT_TYPES.map((t) => [t.type, t]));
  const collected = data.types.filter(
    (t) => t.status === "collected" || t.status === "capped",
  ).length;
  const lines: string[] = [
    `# Discovery: artefacts of ${code(data.scope)} — profile ${code(ctx.profile)}`,
    "",
    "Every artefact type this server knows (servicenow_artifact_types), with what this scope has of it and, when nothing was collected, why. [Overview](overview.md) · [Applications](apps.md)",
    "",
    `- **Types:** ${data.types.length}`,
    `- **Collected:** ${collected}`,
    "",
    "## Types",
    "",
    tableOrNone(
      [
        "Type",
        "Group",
        "Table",
        "Verified",
        "Collected / not collected and why",
      ],
      data.types.map((t) => [
        code(t.type),
        t.group,
        code(t.table),
        t.verified ? "yes" : "no",
        discoveryStatus(t, data.scope),
      ]),
    ),
    "",
  ];
  for (const group of ARTIFACT_GROUPS) {
    const types = ARTIFACT_TYPES.filter(
      (t) => t.group === group && data.artefacts[t.type]?.length,
    );
    if (!types.length) continue;
    lines.push(`## ${group}`, "");
    for (const t of types) {
      lines.push(
        `### ${code(t.type)}`,
        "",
        artifactTable(typeOf.get(t.type) ?? t, data.artefacts[t.type] ?? []),
        "",
      );
    }
  }
  lines.push(
    ...caveatsSection([
      ...data.types
        .filter((t) => t.status === "capped")
        .map(
          (t) =>
            `${t.type}: ${t.count} of ${t.total} records listed (the listing stops at ${LIST_LIMIT.max}).`,
        ),
      "Property and preference values and descriptor secret fields are left out.",
      DISCOVERY_CAVEAT,
      VISIBILITY_CAVEAT,
      METADATA_CAVEAT,
    ]),
  );
  return lines.join("\n");
}

export interface DiscoveryAppsData {
  source: DiscoveryRun["source"];
  depth: DiscoveryDepth;
  apps: {
    name: string;
    scope: string;
    version: string;
    active: string;
    source: string;
    /** Tables and artefacts found; null when not collected (or it failed). */
    tables: number | null;
    artefacts: number | null;
  }[];
  skipped: string[];
  unreadable: string[];
}

function collectDiscoveryApps(
  opts: CollectOptions,
): Promise<DiscoveryAppsData> {
  const run = discoveryOf(opts);
  const built = opts.instance?.built ?? new Map<string, unknown>();
  const known = new Map<string, AppRow & { source: string }>();
  for (const [source, rows] of Object.entries(
    opts.instance?.apps?.data ?? {},
  )) {
    for (const a of rows) {
      if (!known.has(a.scope)) known.set(a.scope, { ...a, source });
    }
  }
  return Promise.resolve({
    source: run.source,
    depth: run.depth,
    apps: run.scopes.map((scope) => {
      const a = known.get(scope);
      const t = built.get(`discovery_tables:${scope}`) as
        | DiscoveryTablesData
        | undefined;
      const x = built.get(`discovery_artifacts:${scope}`) as
        | DiscoveryArtifactsData
        | undefined;
      return {
        name: a?.name ?? "",
        scope,
        version: a?.version ?? "",
        active: a?.active ?? "",
        source: a?.source ?? "",
        tables: t && !t.tables.unreadable ? t.tables.rows.length : null,
        artefacts: x
          ? Object.values(x.artefacts).reduce((n, r) => n + r.length, 0)
          : null,
      };
    }),
    skipped: run.skipped,
    unreadable: opts.instance?.apps?.unreadable ?? [],
  });
}

/** Render discovery/apps.md (pure: same data, same bytes). */
export function renderDiscoveryApps(
  data: DiscoveryAppsData,
  ctx: RenderContext,
): string {
  const n = (v: number | null): string => (v === null ? "n/a" : String(v));
  return [
    `# Discovery: applications — profile ${code(ctx.profile)}`,
    "",
    data.source === "named"
      ? "The scopes named in this run (`apps`), with what discovery found in each. [Overview](overview.md)"
      : "The custom applications (`sys_app`, global excluded), with what discovery found in each. [Overview](overview.md)",
    "",
    tableOrNone(
      [
        "Name",
        "Scope",
        "Version",
        "Active",
        "Source",
        "Tables",
        "Artefacts",
        "Files",
      ],
      data.apps.map((a) => [
        cell(a.name),
        code(a.scope),
        cell(a.version),
        yesNo(a.active),
        code(a.source),
        n(a.tables),
        data.depth === "artefacts" ? n(a.artefacts) : "",
        [
          `[tables](tables-${a.scope}.md)`,
          ...(data.depth === "artefacts"
            ? [`[artefacts](artifacts-${a.scope}.md)`]
            : []),
        ].join(" · "),
      ]),
    ),
    "",
    ...caveatsSection([
      ...data.unreadable.map(
        (s) =>
          `${code(s)} is not readable for this user; its applications are missing.`,
      ),
      ...(data.skipped.length
        ? [
            `Not discovered (beyond the ${INSTANCE_TARGETS_MAX}-scope cap; name them with \`apps\`): ${data.skipped.map(code).join(", ")}.`,
          ]
        : []),
      "`n/a` means that scope's file was not built in this run (it failed; see the tool result's `failed`).",
      DISCOVERY_CAVEAT,
      VISIBILITY_CAVEAT,
      METADATA_CAVEAT,
    ]),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Kind registry and the writer
// ---------------------------------------------------------------------------

/** Tables whose records a document holds (feeds `Collected in this run`). */
function nonEmpty(pairs: [string, unknown[]][]): string[] {
  return pairs.filter(([, rows]) => rows.length > 0).map(([t]) => t);
}

const tableKind: DocKind<TableDocData> = {
  title: "Table",
  version: "1",
  requires: ["docs"],
  generator: "servicenow_document_table",
  path: (table) => `tables/${table}.md`,
  collect: (table, opts) => collectTable(table, opts),
  render: renderTable,
  sources: (d) => [
    "sys_db_object",
    ...nonEmpty([
      ["sys_script", d.logic.businessRules],
      ["sys_script_client", d.logic.clientScripts],
      ["sys_ui_policy", d.logic.uiPolicies],
      ["sys_ui_action", d.logic.uiActions],
      ["sys_security_acl", d.logic.acls],
    ]),
  ],
};

const appKind: DocKind<AppDocData> = {
  title: "Application",
  version: "1",
  requires: ["docs"],
  generator: "servicenow_document_app",
  path: (scope) => `apps/${scope}.md`,
  collect: (scope, opts) => collectApp(scope, opts),
  render: renderApp,
  sources: (d) => [
    d.app.table,
    ...(d.tables.length ? ["sys_db_object"] : []),
    ...ARTIFACT_TYPES.filter((t) => d.artefacts[t.type]?.length).map(
      (t) => t.table,
    ),
  ],
};

const securityKind: DocKind<SecurityScan> = {
  title: "Security",
  version: "1",
  requires: ["codecheck"],
  generator: "servicenow_document_security",
  path: () => "security.md",
  collect: () => securityScan(),
  render: renderSecurity,
  singleton: true,
};

const catalogKind: DocKind<CatalogDocData> = {
  title: "Service catalog",
  version: "1",
  requires: ["docs", "catalog"],
  generator: "servicenow_document_instance",
  path: () => "catalog.md",
  collect: () => collectCatalog(),
  render: renderCatalog,
  singleton: true,
  sources: (d) =>
    nonEmpty([
      ["sc_catalog", d.catalogs.rows],
      ["sc_category", d.categories.rows],
      ["sc_cat_item", d.items.rows],
      ["item_option_new", d.variables.rows],
    ]),
};

const integrationsKind: DocKind<IntegrationsDocData> = {
  title: "Integrations",
  version: "1",
  requires: ["docs"],
  generator: "servicenow_document_instance",
  path: () => "integrations.md",
  collect: () => collectIntegrations(),
  render: renderIntegrations,
  singleton: true,
  sources: (d) =>
    nonEmpty([
      ["sys_ws_definition", d.restApis.rows],
      ["sys_rest_message", d.restMessages.rows],
      ["sys_transform_map", d.transformMaps.rows],
      ["sys_data_source", d.dataSources.rows],
    ]),
};

const instanceKind: DocKind<InstanceDocData> = {
  title: "Instance",
  version: "1",
  requires: ["docs"],
  generator: "servicenow_document_instance",
  path: () => "README.md",
  collect: (_target, opts) => collectInstance(opts),
  render: renderInstance,
  singleton: true,
  sources: (d) => [
    ...Object.entries(d.apps)
      .filter(([, rows]) => rows.length)
      .map(([t]) => t),
    ...(d.plugins?.total ? [d.plugins.source] : []),
    ...nonEmpty([["sys_update_set", d.updateSets.rows]]),
  ],
};

const artifactTypesKind: DocKind<ArtifactTypesDocData> = {
  title: "Artifact types",
  version: "1",
  requires: ["docs"],
  generator: "servicenow_document_instance",
  path: () => "artifact-types.md",
  collect: (_target, opts) => collectArtifactTypes(opts),
  render: renderArtifactTypes,
  singleton: true,
};

const discoveryOverviewKind: DocKind<DiscoveryOverviewData> = {
  title: "Discovery overview",
  version: "1",
  requires: ["docs"],
  generator: "servicenow_document_instance",
  path: () => `${DISCOVERY_DIR}/overview.md`,
  collect: (_target, opts) => collectDiscoveryOverview(opts),
  render: renderDiscoveryOverview,
  singleton: true,
};

const discoveryTablesKind: DocKind<DiscoveryTablesData> = {
  title: "Discovery: tables",
  version: "1",
  requires: ["docs"],
  generator: "servicenow_document_instance",
  path: (scope) => `${DISCOVERY_DIR}/tables-${scope}.md`,
  collect: (scope) => collectDiscoveryTables(scope),
  render: renderDiscoveryTables,
  sources: (d) =>
    nonEmpty([
      ["sys_db_object", d.tables.rows],
      ["sys_dictionary", d.columns.rows],
    ]),
};

const discoveryArtifactsKind: DocKind<DiscoveryArtifactsData> = {
  title: "Discovery: artefacts",
  version: "1",
  requires: ["docs"],
  generator: "servicenow_document_instance",
  path: (scope) => `${DISCOVERY_DIR}/artifacts-${scope}.md`,
  collect: (scope) => collectDiscoveryArtifacts(scope),
  render: renderDiscoveryArtifacts,
  sources: (d) =>
    ARTIFACT_TYPES.filter((t) => d.artefacts[t.type]?.length).map(
      (t) => t.table,
    ),
};

const discoveryAppsKind: DocKind<DiscoveryAppsData> = {
  title: "Discovery: applications",
  version: "1",
  requires: ["docs"],
  generator: "servicenow_document_instance",
  path: () => `${DISCOVERY_DIR}/apps.md`,
  collect: (_target, opts) => collectDiscoveryApps(opts),
  render: renderDiscoveryApps,
  singleton: true,
};

/** The S-15 document kinds (ID-11); P-21 and later kinds register here too. */
export const DOC_KINDS = {
  table: tableKind,
  app: appKind,
  security: securityKind,
  catalog: catalogKind,
  integrations: integrationsKind,
  instance: instanceKind,
  artifact_types: artifactTypesKind,
  discovery_overview: discoveryOverviewKind,
  discovery_tables: discoveryTablesKind,
  discovery_artifacts: discoveryArtifactsKind,
  discovery_apps: discoveryAppsKind,
} as const;

export type DocKindId = keyof typeof DOC_KINDS;

/** The optional kinds `document_instance({kinds})` can add to a run. */
export const INSTANCE_DOC_KINDS = [
  "security",
  "catalog",
  "integrations",
] as const satisfies readonly DocKindId[];
export type InstanceDocKindId = (typeof INSTANCE_DOC_KINDS)[number];

export interface DocumentOptions extends CollectOptions {
  /** Docs profile folder: `current` (default) or a profile name. */
  profile?: string;
  /** Write the files (default true); false returns the Markdown instead. */
  write?: boolean;
}

export interface DocumentResult {
  kind: DocKindId;
  /** Docs-relative path of the Markdown document (written or not). */
  path: string;
  /** With `write:false`: the rendered Markdown. */
  markdown?: string;
  /** With `write` (the default): the written files. */
  file?: string;
  companion?: string;
  status?: DocWriteStatus;
  bytes?: number;
  preview?: string;
  preview_truncated?: true;
  caveats: number;
}

/** Characters of a written document echoed back (S-11's PREVIEW_CHARS). */
const PREVIEW_CHARS = 2000;

const SAFE_TARGET = /^[A-Za-z0-9_.-]+$/;

function assertTarget(kindId: DocKindId, target: string): string {
  const t = target.trim();
  if (!(DOC_KINDS[kindId] as DocKind).singleton && !SAFE_TARGET.test(t)) {
    throw new ServiceNowError(
      `'${target}' cannot name a document (letters, digits, '_', '.', '-').`,
      400,
    );
  }
  return t;
}

/** Run `fn` against the `profile` connection (the active one directly). */
function inProfile<T>(profile: string, fn: () => Promise<T>): Promise<T> {
  return profile === activeProfile() && currentRequestProfile() === undefined
    ? fn()
    : runWithProfile(profile, fn);
}

/**
 * Collect, render and (by default) write one document of `kind` for
 * `target`. The whole run reads the `profile` connection, so the document
 * and the data always belong to the same instance.
 */
export async function generateDocument(
  kind: DocKindId,
  target: string,
  opts: DocumentOptions = {},
): Promise<DocumentResult> {
  const profile = resolveDocsProfile(opts.profile ?? "current");
  return inProfile(profile, () => generateFor(kind, target, profile, opts));
}

/** A collected and rendered document, not yet written. */
interface BuiltDocument {
  kindId: DocKindId;
  kind: DocKind;
  data: unknown;
  markdown: string;
  /** Docs-relative path of the Markdown document. */
  rel: string;
  caveats: number;
}

async function buildDocument(
  kindId: DocKindId,
  target: string,
  profile: string,
  opts: CollectOptions,
): Promise<BuiltDocument> {
  const kind = DOC_KINDS[kindId] as DocKind;
  const t = assertTarget(kindId, target);
  const data = await kind.collect(t, opts);
  const markdown = kind.render(data, { profile });
  const caveats = (markdown.match(/^## Caveats\n\n([\s\S]*)$/m)?.[1] ?? "")
    .split("\n")
    .filter((line) => line.startsWith("- ")).length;
  return {
    kindId,
    kind,
    data,
    markdown,
    rel: `${profile}/${kind.path(t)}`,
    caveats,
  };
}

/** Write a built document: the Markdown plus its `.json` companion. */
async function writeBuilt(
  built: BuiltDocument,
  profile: string,
): Promise<DocumentResult> {
  const { kind, kindId, data, markdown, rel } = built;
  const companion = rel.replace(/\.md$/, ".json");
  const meta = {
    generator: kind.generator,
    kind: kindId,
    profile,
    generatorVersion: kind.version,
    source: data,
  };
  const written = await docsWriteRaw(rel, markdown, [".md"], meta);
  await docsWriteRaw(companion, JSON.stringify(data, null, 2), [".json"], meta);
  return {
    kind: kindId,
    path: written.path,
    file: path.resolve(getDocsDir(), written.path),
    companion,
    ...(written.status ? { status: written.status } : {}),
    bytes: written.bytes,
    ...(markdown.length > PREVIEW_CHARS
      ? {
          preview: markdown.slice(0, PREVIEW_CHARS),
          preview_truncated: true as const,
        }
      : { preview: markdown }),
    caveats: built.caveats,
  };
}

async function generateFor(
  kindId: DocKindId,
  target: string,
  profile: string,
  opts: DocumentOptions,
): Promise<DocumentResult> {
  const built = await buildDocument(kindId, target, profile, opts);
  if (opts.write === false) {
    return {
      kind: kindId,
      path: built.rel,
      markdown: built.markdown,
      caveats: built.caveats,
    };
  }
  const progress = trackProgress(1);
  await docsRunBegin(built.kind.generator, profile);
  let result;
  try {
    result = await writeBuilt(built, profile);
    progress.tick(built.rel);
  } catch (error) {
    await docsRunEnd(built.kind.generator, profile, {
      files: 0,
      partial: true,
    });
    throw error;
  }
  await docsRunEnd(built.kind.generator, profile, { files: 2 });
  return result;
}

/** servicenow_document_table: `<profile>/tables/<table>.md` + `.json`. */
export function documentTable(
  table: string,
  opts: DocumentOptions = {},
): Promise<DocumentResult> {
  return generateDocument("table", table, opts);
}

/** servicenow_document_app: `<profile>/apps/<scope>.md` + `.json`. */
export function documentApp(
  scope: string,
  opts: DocumentOptions = {},
): Promise<DocumentResult> {
  return generateDocument("app", scope, opts);
}

/**
 * The `security` kind (ID-23): `<profile>/security.md` + `.json` from
 * `securityScan()`. Also reachable through `document_instance({kinds})`.
 */
export function documentSecurity(
  opts: DocumentOptions = {},
): Promise<DocumentResult> {
  return generateDocument("security", "security", opts);
}

// ---------------------------------------------------------------------------
// document_instance: the README plus the named documents, one run
// ---------------------------------------------------------------------------

const INSTANCE_GENERATOR = "servicenow_document_instance";

/** Named targets per call (tables, apps), each. */
export const INSTANCE_TARGETS_MAX = 50;

export interface DocumentInstanceOptions {
  /** Docs profile folder: `current` (default) or a profile name. */
  profile?: string;
  /** Tables to document (tables/<name>.md each). */
  tables?: string[];
  /** Application scopes to document (apps/<scope>.md each). */
  apps?: string[];
  /** Optional instance-wide kinds (security, catalog, integrations). */
  kinds?: InstanceDocKindId[];
  /** S-16 discovery tier; omitted, no `discovery/` files are written. */
  depth?: DiscoveryDepth;
  /** Write the files (default true); false returns the Markdown instead. */
  write?: boolean;
}

export interface InstanceDocumentEntry {
  kind: DocKindId;
  target: string;
  /** Docs-relative path of the Markdown document. */
  path: string;
  status?: DocWriteStatus;
  bytes?: number;
  caveats: number;
  /** With `write:false`: the rendered Markdown. */
  markdown?: string;
}

export interface DocumentInstanceResult {
  profile: string;
  /** Docs-relative path of the README. */
  path: string;
  documents: InstanceDocumentEntry[];
  /** Files written (Markdown + companions); 0 with `write:false`. */
  files: number;
  partial: false;
  /** Named documents that failed; the run went on without them. */
  failed?: { kind: DocKindId; target: string; path: string; error: string }[];
}

function uniqueTargets(
  kindId: DocKindId,
  list: string[] | undefined,
): string[] {
  const out = [...new Set((list ?? []).map((t) => t.trim()))];
  if (out.length > INSTANCE_TARGETS_MAX) {
    throw new ServiceNowError(
      `At most ${INSTANCE_TARGETS_MAX} ${kindId === "table" ? "tables" : "apps"} per run.`,
      400,
    );
  }
  for (const t of out) assertTarget(kindId, t);
  return out;
}

/**
 * servicenow_document_instance: `<profile>/README.md` from the E-7
 * collectors, then one document per named table, app and optional kind, then
 * `<profile>/artifact-types.md` (ID-29). Every document (Markdown + `.json`)
 * is written as soon as it is built, with one progress tick per document
 * (message = its path), so a cancelled run leaves valid files behind and
 * index.json `runs` marks it `partial:true`. A named document that fails
 * (other than on a cancel) is reported in `failed` and the run goes on.
 */
export async function documentInstance(
  opts: DocumentInstanceOptions = {},
): Promise<DocumentInstanceResult> {
  const profile = resolveDocsProfile(opts.profile ?? "current");
  const tables = uniqueTargets("table", opts.tables);
  const apps = uniqueTargets("app", opts.apps);
  const kinds = [...new Set(opts.kinds ?? [])];
  for (const k of kinds) {
    if (!(INSTANCE_DOC_KINDS as readonly string[]).includes(k)) {
      throw new ServiceNowError(
        `Unknown document kind '${String(k)}' (one of ${INSTANCE_DOC_KINDS.join(", ")}).`,
        400,
      );
    }
  }
  const depth = opts.depth;
  if (
    depth !== undefined &&
    !(DISCOVERY_DEPTHS as readonly string[]).includes(depth)
  ) {
    throw new ServiceNowError(
      `Unknown depth '${String(depth)}' (one of ${DISCOVERY_DEPTHS.join(", ")}).`,
      400,
    );
  }
  return inProfile(profile, async () => {
    let discovery: Discovery | undefined;
    if (depth) discovery = await resolveDiscovery(depth, apps);
    return instanceRun(
      profile,
      tables,
      apps,
      kinds,
      opts.write !== false,
      discovery,
    );
  });
}

interface Discovery {
  run: DiscoveryRun;
  apps: CollectorResult<Record<string, AppRow[]>>;
}

/**
 * The scopes a discovery run covers: the named `apps`, else every custom
 * application in `sys_app` (global and names that cannot be a file name are
 * left out), sorted, the first INSTANCE_TARGETS_MAX of them.
 */
async function resolveDiscovery(
  depth: DiscoveryDepth,
  named: string[],
): Promise<Discovery> {
  const apps = await collectApps();
  if (named.length || depth === "overview") {
    return {
      run: {
        depth,
        scopes: depth === "overview" ? [] : named,
        skipped: [],
        source: "named",
      },
      apps,
    };
  }
  const all = [
    ...new Set(
      (apps.data.sys_app ?? [])
        .map((a) => a.scope.trim())
        .filter((s) => s && s !== "global" && SAFE_TARGET.test(s)),
    ),
  ].sort((a, b) => a.localeCompare(b));
  return {
    run: {
      depth,
      scopes: all.slice(0, INSTANCE_TARGETS_MAX),
      skipped: all.slice(INSTANCE_TARGETS_MAX),
      source: "sys_app",
    },
    apps,
  };
}

async function instanceRun(
  profile: string,
  tables: string[],
  apps: string[],
  kinds: InstanceDocKindId[],
  write: boolean,
  discovery?: Discovery,
): Promise<DocumentInstanceResult> {
  const d = discovery?.run;
  const scoped = d && d.depth !== "overview" ? d.scopes : [];
  const steps: { kind: DocKindId; target: string }[] = [
    ...(d ? [{ kind: "discovery_overview" as const, target: "overview" }] : []),
    ...tables.map((target) => ({ kind: "table" as const, target })),
    ...apps.map((target) => ({ kind: "app" as const, target })),
    ...kinds.map((kind) => ({ kind, target: kind })),
    ...scoped.flatMap((target) => [
      { kind: "discovery_tables" as const, target },
      ...(d?.depth === "artefacts"
        ? [{ kind: "discovery_artifacts" as const, target }]
        : []),
    ]),
    ...(d && d.depth !== "overview"
      ? [{ kind: "discovery_apps" as const, target: "apps" }]
      : []),
    { kind: "artifact_types", target: "artifact-types" },
  ];
  const done = new Map<string, unknown>();
  const run: InstanceRunContext = {
    documents: steps.map((s) => ({
      kind: s.kind,
      target: s.target,
      path: (DOC_KINDS[s.kind] as DocKind).path(s.target),
    })),
    collected: new Set<string>(),
    ...(discovery
      ? { apps: discovery.apps, discovery: discovery.run, built: done }
      : {}),
  };
  const collected = run.collected as Set<string>;
  const plan = [{ kind: "instance" as DocKindId, target: "README" }, ...steps];

  const progress = trackProgress(plan.length);
  const documents: InstanceDocumentEntry[] = [];
  const failed: NonNullable<DocumentInstanceResult["failed"]> = [];
  let files = 0;
  if (write) await docsRunBegin(INSTANCE_GENERATOR, profile);
  try {
    for (const step of plan) {
      // A cancel between documents stops before the next one starts.
      throwIfCancelled();
      const rel = `${profile}/${(DOC_KINDS[step.kind] as DocKind).path(step.target)}`;
      let built: BuiltDocument;
      try {
        built = await buildDocument(step.kind, step.target, profile, {
          instance: run,
        });
      } catch (error) {
        if (isCancelled(error) || step.kind === "instance") throw error;
        failed.push({
          kind: step.kind,
          target: step.target,
          path: rel,
          error: error instanceof Error ? error.message : String(error),
        });
        progress.tick(`${rel} (failed)`);
        continue;
      }
      for (const t of built.kind.sources?.(built.data) ?? []) collected.add(t);
      done.set(`${step.kind}:${step.target}`, built.data);
      if (write) {
        const r = await writeBuilt(built, profile);
        files += 2;
        documents.push({
          kind: step.kind,
          target: step.target,
          path: r.path,
          ...(r.status ? { status: r.status } : {}),
          ...(r.bytes !== undefined ? { bytes: r.bytes } : {}),
          caveats: r.caveats,
        });
      } else {
        documents.push({
          kind: step.kind,
          target: step.target,
          path: built.rel,
          caveats: built.caveats,
          markdown: built.markdown,
        });
      }
      progress.tick(built.rel);
    }
  } catch (error) {
    if (write) {
      await docsRunEnd(INSTANCE_GENERATOR, profile, { files, partial: true });
    }
    throw error;
  }
  if (write) await docsRunEnd(INSTANCE_GENERATOR, profile, { files });
  return {
    profile,
    path: `${profile}/README.md`,
    documents,
    files,
    partial: false,
    ...(failed.length ? { failed } : {}),
  };
}
