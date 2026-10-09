import path from "node:path";
import { activeProfile } from "../core/config.js";
import { checkHardening } from "./hardening.js";
import { ServiceNowError, isCancelledError } from "../core/errors.js";
import { throwIfCancelled, trackProgress } from "../core/progress.js";
import {
  currentRequestProfile,
  runWithProfile,
} from "../core/request-context.js";
import { getDocsDir } from "../core/settings.js";
import { ARTIFACT_GROUPS, ARTIFACT_TYPES } from "../core/artifacts/registry.js";
import {
  LIST_LIMIT,
  artifactTypeCatalog,
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
  docsRunBegin,
  docsRunEnd,
  docsWriteRaw,
  resolveDocsProfile,
  type DocWriteStatus,
} from "./docs.js";
import { scopeClause } from "./scripts.js";
import { securityScan, type SecurityScan } from "./security.js";
import { mdTable } from "./shared.js";
import { WORKSPACE_CATEGORY } from "./uib-workspace.js";
import {
  caveatsSection,
  cell,
  code,
  codeOf,
  type CollectOptions,
  DISCOVERY_DEPTHS,
  type DiscoveryDepth,
  type DiscoveryRun,
  type DocKind,
  type InstanceDocLink,
  type InstanceRunContext,
  METADATA_CAVEAT,
  NOT_READABLE,
  PURPOSE_BLOCK,
  readCaveats,
  readSection,
  readSectionIn,
  type RenderContext,
  type SectionRead,
  sectionTable,
  tableOrNone,
  VISIBILITY_CAVEAT,
  yesNo,
} from "./doc-shared.js";
import {
  type AppDocData,
  artifactTable,
  collectApp,
  collectScopeArtefacts,
  renderApp,
} from "./doc-app.js";
import {
  type ArtifactTypesDocData,
  type CatalogTypeEntry,
  collectArtifactTypes,
  renderArtifactTypes,
} from "./doc-artifact-types.js";
import { collectTable, renderTable, type TableDocData } from "./doc-table.js";
import { renderSecurity } from "./doc-security.js";
import {
  accessReviewSources,
  collectAccessReview,
  renderAccessReviewDoc,
} from "./doc-access-review.js";
import { type AccessReview } from "./access-review.js";
import {
  type UpgradeDocData,
  collectUpgrade,
  renderUpgradeDoc,
  upgradeSources,
} from "./doc-upgrade.js";
import {
  type CatalogDocData,
  collectCatalog,
  renderCatalog,
} from "./doc-catalog.js";
import {
  collectIntegrations,
  type IntegrationsDocData,
  renderIntegrations,
} from "./doc-integrations.js";

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

export {
  type DocKind,
  type CollectOptions,
  type RenderContext,
  type SectionRead,
  type InstanceDocLink,
  type InstanceRunContext,
  DISCOVERY_DEPTHS,
  type DiscoveryDepth,
  type DiscoveryRun,
} from "./doc-shared.js";
export {
  type TableDocColumn,
  type TableDocReference,
  type TableDocAcl,
  type TableDocData,
  collectTable,
  renderTable,
} from "./doc-table.js";
export {
  type AppDocRecord,
  type AppDocData,
  type AppDetail,
  APP_DETAIL_LIMITS,
  artifactColumns,
  artefactsByDomain,
  type ScopeArtefacts,
  collectApp,
  renderApp,
} from "./doc-app.js";
export {
  SECURITY_CHECK_ORDER,
  aclMatrix,
  renderSecurity,
} from "./doc-security.js";
export {
  type CatalogDocData,
  collectCatalog,
  renderCatalog,
} from "./doc-catalog.js";
export {
  type IntegrationsDocData,
  collectIntegrations,
  renderIntegrations,
} from "./doc-integrations.js";
export {
  type ArtifactTypesDocData,
  collectArtifactTypes,
  renderArtifactTypes,
} from "./doc-artifact-types.js";

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
  /** N-30: workspaces and the Agent Workspace items still to migrate. */
  workspaces?: InstanceWorkspaces;
  /** The documents this run writes besides the README. */
  documents: InstanceDocLink[];
  /** Collector sources that could not be read or hit the cap. */
  unreadable: string[];
  capped: string[];
}

/**
 * N-30 — the instance's workspaces: configurable workspaces (page registries
 * in the workspace experience category) beside legacy Agent Workspace
 * configs, and the Agent Workspace items a migration has to move, each with
 * its configurable counterpart when one is found.
 */
export interface InstanceWorkspaces {
  kind: "configurable" | "agent" | "mixed" | "none";
  configurable: {
    sys_id: string;
    title: string;
    path: string;
    scope: string;
  }[];
  agent: { sys_id: string; name: string; scope: string; active: string }[];
  migration: {
    table: string;
    sys_id: string;
    name: string;
    scope: string;
    /** The configurable-workspace record that already covers it. */
    counterpart?: string;
  }[];
}

/**
 * N-30 — read the instance's workspaces (see {@link InstanceWorkspaces}).
 * The Agent Workspace tables are plugin tables: a 404 means none, not a
 * caveat. AW lists and restricted declarative actions are read only when an
 * Agent Workspace config exists. Unverified until O-5 (PDI): the category
 * sys_id, `sys_aw_list.table` and the 404 answer for an absent plugin.
 */
async function collectWorkspaces(): Promise<{
  data: InstanceWorkspaces;
  reads: SectionRead[];
}> {
  const v = (r: Record<string, string>, field: string): string =>
    r[field] ?? "";
  const categories = await readSection(
    "sys_ux_registry_m2m_category",
    ["page_registry"],
    `experience_category=${WORKSPACE_CATEGORY}`,
  );
  const registries = await readSectionIn(
    "sys_ux_page_registry",
    ["sys_id", "title", "path", "sys_scope.scope"],
    "sys_id",
    categories.rows.map((r) => v(r, "page_registry")),
    "^ORDERBYtitle",
  );
  const configs = await readSection(
    "sys_aw_master_config",
    ["sys_id", "name", "active", "sys_scope.scope"],
    "ORDERBYname",
    { absentIsEmpty: true },
  );
  const reads = [categories, registries, configs];
  const configurable = registries.rows.map((r) => ({
    sys_id: v(r, "sys_id"),
    title: v(r, "title"),
    path: v(r, "path"),
    scope: v(r, "sys_scope.scope"),
  }));
  const agent = configs.rows.map((r) => ({
    sys_id: v(r, "sys_id"),
    name: v(r, "name"),
    scope: v(r, "sys_scope.scope"),
    active: v(r, "active"),
  }));
  const migration: InstanceWorkspaces["migration"] = [];
  if (agent.length) {
    const lists = await readSection(
      "sys_aw_list",
      ["sys_id", "title", "table", "sys_scope.scope"],
      "ORDERBYtitle",
      { absentIsEmpty: true },
    );
    const actions = await readSection(
      "sys_declarative_action_assignment",
      ["sys_id", "label", "action_name", "table", "sys_scope.scope"],
      "workspaceISNOTEMPTY^ORDERBYtable^ORDERBYaction_name",
    );
    const uxLists = await readSectionIn(
      "sys_ux_list",
      ["table"],
      "table",
      lists.rows.map((r) => v(r, "table")),
    );
    const open = await readSectionIn(
      "sys_declarative_action_assignment",
      ["action_name", "table"],
      "action_name",
      actions.rows.map((r) => v(r, "action_name")),
      "^workspaceISEMPTY",
    );
    reads.push(lists, actions, uxLists, open);
    const uxTables = new Set(uxLists.rows.map((r) => v(r, "table")));
    const openActions = new Set(
      open.rows.map((r) => `${v(r, "table")}:${v(r, "action_name")}`),
    );
    for (const c of agent) {
      const twin = configurable.find((w) => w.scope && w.scope === c.scope);
      migration.push({
        table: "sys_aw_master_config",
        sys_id: c.sys_id,
        name: c.name,
        scope: c.scope,
        ...(twin ? { counterpart: `workspace ${twin.title}` } : {}),
      });
    }
    for (const r of lists.rows) {
      migration.push({
        table: "sys_aw_list",
        sys_id: v(r, "sys_id"),
        name: v(r, "title"),
        scope: v(r, "sys_scope.scope"),
        ...(v(r, "table") && uxTables.has(v(r, "table"))
          ? { counterpart: `sys_ux_list on ${v(r, "table")}` }
          : {}),
      });
    }
    for (const r of actions.rows) {
      migration.push({
        table: "sys_declarative_action_assignment",
        sys_id: v(r, "sys_id"),
        name: v(r, "label") || v(r, "action_name"),
        scope: v(r, "sys_scope.scope"),
        ...(openActions.has(`${v(r, "table")}:${v(r, "action_name")}`)
          ? {
              counterpart: `unrestricted ${v(r, "action_name")} on ${v(r, "table")}`,
            }
          : {}),
      });
    }
  }
  const kind =
    configurable.length && agent.length
      ? "mixed"
      : configurable.length
        ? "configurable"
        : agent.length
          ? "agent"
          : "none";
  return { data: { kind, configurable, agent, migration }, reads };
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
  const workspaces = await collectWorkspaces();
  const unreadable = [
    ...tables.unreadable,
    ...plugins.unreadable,
    ...apps.unreadable,
    ...automation.unreadable,
    ...new Set(
      workspaces.reads.filter((r) => r.unreadable).map((r) => r.table),
    ),
  ];
  const capped = [
    ...tables.capped,
    ...plugins.capped,
    ...apps.capped,
    ...automation.capped,
    ...new Set(workspaces.reads.filter((r) => r.truncated).map((r) => r.table)),
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
    workspaces: workspaces.data,
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
    ...(data.workspaces ? workspaceSections(data.workspaces) : []),
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

const WORKSPACE_KIND_TEXT: Record<InstanceWorkspaces["kind"], string> = {
  configurable: "configurable workspaces only.",
  agent:
    "legacy Agent Workspace only; Agent Workspace is superseded by configurable workspaces.",
  mixed:
    "both configurable workspaces and legacy Agent Workspace: a migration is pending or in progress.",
  none: "no workspace found.",
};

/** The README's Workspaces and Workspace migration sections (N-30). */
function workspaceSections(w: InstanceWorkspaces): string[] {
  const missing = w.migration.filter((m) => !m.counterpart).length;
  return [
    "## Workspaces",
    "",
    `Kind: ${WORKSPACE_KIND_TEXT[w.kind]}`,
    "",
    tableOrNone(
      ["Workspace", "Kind", "Path", "Scope", "Active"],
      [
        ...w.configurable.map((c) => [
          cell(c.title),
          "Configurable",
          codeOf(c.path),
          codeOf(c.scope),
          "",
        ]),
        ...w.agent.map((a) => [
          cell(a.name),
          "Agent Workspace (legacy)",
          "",
          codeOf(a.scope),
          yesNo(a.active),
        ]),
      ],
    ),
    "",
    "## Workspace migration",
    "",
    ...(w.migration.length
      ? [
          `${w.migration.length} legacy Agent Workspace record(s) to move to a configurable workspace; ${missing} without a configurable counterpart yet.`,
          "",
          mdTable(
            ["Record", "Table", "Scope", "Configurable counterpart"],
            w.migration.map((m) => [
              cell(m.name),
              code(m.table),
              codeOf(m.scope),
              m.counterpart ? cell(m.counterpart) : "_none yet_",
            ]),
          ),
        ]
      : ["_Nothing to migrate: no legacy Agent Workspace configuration._"]),
    "",
  ];
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
  collect: async () => {
    const scan = await securityScan();
    return { ...scan, hardening: await checkHardening() };
  },
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

const accessReviewKind: DocKind<AccessReview> = {
  title: "Access review",
  version: "1",
  requires: ["docs", "directory"],
  generator: "servicenow_document_instance",
  path: () => "access-review.md",
  collect: () => collectAccessReview(),
  render: renderAccessReviewDoc,
  singleton: true,
  sources: accessReviewSources,
};

const upgradeKind: DocKind<UpgradeDocData> = {
  title: "Upgrade readiness",
  version: "1",
  requires: ["docs", "instance"],
  generator: "servicenow_document_instance",
  path: () => "upgrade.md",
  collect: () => collectUpgrade(),
  render: renderUpgradeDoc,
  singleton: true,
  sources: upgradeSources,
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
  access_review: accessReviewKind,
  upgrade: upgradeKind,
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
  "access_review",
  "upgrade",
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
  /** Optional instance-wide kinds (INSTANCE_DOC_KINDS). */
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
        if (isCancelledError(error) || step.kind === "instance") throw error;
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
