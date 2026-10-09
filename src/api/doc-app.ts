import { crossScopeReport, type CrossScopeReport } from "./cross-scope.js";
import { ServiceNowError, rethrowIfCancelled } from "../core/errors.js";
import { throwIfCancelled } from "../core/progress.js";
import { getDeniedPackages, getMaxRecords } from "../core/settings.js";
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
  listArtifacts,
  type ArtifactSummary,
} from "./artifacts.js";
import { generateErDiagram } from "./diagrams.js";
import { DOMAIN_CAVEAT, recordDomain } from "./domain-separation.js";
import { scopeClause } from "./scripts.js";
import { assertNoCaret, mdTable, snString } from "./shared.js";
import { queryTable } from "./table.js";
import { isSysIdAnyCase } from "../core/sys-id.js";
import { diagram } from "./doc-table.js";
import {
  caveatsSection,
  cell,
  code,
  type CollectOptions,
  isAccessDenied,
  mermaidBlock,
  METADATA_CAVEAT,
  PURPOSE_BLOCK,
  type RenderContext,
  tableOrNone,
  VISIBILITY_CAVEAT,
} from "./doc-shared.js";

/**
 * Application document (ID-09, ID-22).
 */

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
  /** N-14: calls into other scopes joined to sys_scope_privilege, and the inverse. */
  crossScope?: Omit<CrossScopeReport, "caveats">;
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
  app: AppDocRecord,
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
        rethrowIfCancelled(e);
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
      rethrowIfCancelled(e);
      caveats.push(`Lint: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (app.sys_id) {
    const { caveats: cs, ...crossScope } = await crossScopeReport(
      app.sys_id,
      app.scope,
    );
    caveats.push(...cs);
    detail.crossScope = crossScope;
  } else {
    caveats.push("Cross-scope: the application record has no sys_id.");
  }
  return detail;
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

export function artifactTable(
  t: ArtifactType,
  rows: ArtifactSummary[],
): string {
  const cols = artifactColumns(t);
  // N-12: a domain column only when a row is domain-specific.
  const domains = rows.map((a) => recordDomain(a).domain);
  const withDomain = domains.some(Boolean);
  return mdTable(
    withDomain ? [...cols, "domain"] : cols,
    rows.map((a, i) => [
      ...cols.map((c) => artifactCell(a, c)),
      ...(withDomain ? [cell(domains[i] ?? "")] : []),
    ]),
  );
}

/**
 * N-12: artefacts per domain, for the rows that are domain-specific; empty
 * on an instance without domain separation.
 */
export function artefactsByDomain(
  artefacts: Record<string, ArtifactSummary[]>,
): { domain: string; count: number; types: string[] }[] {
  const by = new Map<string, { count: number; types: Set<string> }>();
  for (const [type, rows] of Object.entries(artefacts)) {
    for (const a of rows) {
      const { domain } = recordDomain(a);
      if (!domain) continue;
      const entry = by.get(domain) ?? { count: 0, types: new Set<string>() };
      entry.count++;
      entry.types.add(type);
      by.set(domain, entry);
    }
  }
  return [...by.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([domain, e]) => ({
      domain,
      count: e.count,
      types: [...e.types].sort(),
    }));
}

async function appRecord(scope: string): Promise<AppDocRecord> {
  const byId = isSysIdAnyCase(scope);
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
export async function collectScopeArtefacts(
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
  const scopeRef = isSysIdAnyCase(s) ? s : app.scope || s;

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
    ? await collectAppDetail(scopeRef, app, artefacts, caveats)
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
  lines.push("## Cross-scope access", "");
  if (d.crossScope) {
    const x = d.crossScope;
    lines.push(
      `${x.scanned} script(s) scanned · outbound: ${x.counts.denied} denied, ${x.counts.missing} missing, ${x.counts.requested} requested, ${x.counts.allowed} allowed.`,
      "",
      "### Outbound",
      "",
      tableOrNone(
        [
          "Status",
          "Target scope",
          "Type",
          "Target",
          "Operations",
          "Called from",
        ],
        x.outbound.map((c) => [
          c.status,
          code(c.targetScope),
          c.targetType,
          code(c.target),
          c.operations.join(", "),
          cell(
            c.callers.map((k) => `${k.type} ${k.name}`).join(", ") +
              (c.callerCount > c.callers.length
                ? ` (+${c.callerCount - c.callers.length})`
                : ""),
          ),
        ]),
      ),
      "",
      "### Inbound",
      "",
      tableOrNone(
        ["Source scope", "Type", "Target", "Operation", "Status"],
        x.inbound.map((r) => [
          code(r.sourceScope),
          r.targetType,
          code(r.target),
          r.operation,
          r.status,
        ]),
      ),
      "",
      "### Restricted caller access",
      "",
      tableOrNone(
        [
          "Source scope",
          "Target scope",
          "Source table",
          "Target table",
          "Target",
          "Status",
        ],
        x.restricted.map((r) => [
          code(r.sourceScope),
          code(r.targetScope),
          code(r.sourceTable),
          code(r.targetTable),
          cell(r.target),
          r.status,
        ]),
      ),
      "",
    );
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

  const domains = artefactsByDomain(data.artefacts);
  if (domains.length) {
    lines.push(
      "## Domains",
      "",
      DOMAIN_CAVEAT,
      "",
      mdTable(
        ["Domain", "Artefacts", "Types"],
        domains.map((d) => [
          cell(d.domain),
          String(d.count),
          d.types.map(code).join(", "),
        ]),
      ),
      "",
    );
  }

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
