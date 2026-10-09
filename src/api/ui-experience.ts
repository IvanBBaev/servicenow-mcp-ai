/**
 * P-14 / P-15 — `explain_ui_experience` (project/SDK-PARITY.md §4 P-14, P-15).
 *
 * Reads a UI Builder experience (a workspace or any `sys_ux_page_registry`
 * record) as a page map:
 *
 *   sys_ux_page_registry → sys_ux_app_config → sys_ux_app_route
 *     → sys_ux_screen (variants, in order, with their applicability)
 *     → sys_ux_macroponent (component tree, data resources, client state,
 *       event wiring) → sys_ux_client_script + data brokers
 *       (sys_ux_data_broker_transform / _scriptlet / _rest / _graphql) →
 *       their `ux_data_broker` ACLs
 *
 * and, for workspaces (P-15), the experience's page properties, the
 * dashboards and list menus they reference (`par_dashboard` → tabs →
 * widgets; `sys_ux_list_menu_config` → categories → lists), the audience
 * (`sys_ux_applicability`, with roles) of screens and lists, and the form
 * action layouts of the experience's application scope.
 *
 * N-30 (uib-workspace.ts) adds the workspace view: declarative actions on
 * the workspace's tables, the app shell and chrome, a UX form view per table
 * (layouts, action bar, related items, contextual side panel), the themes of
 * `m2m_app_theme`, decoded `sys_ux_list` columns and conditions, and Agent
 * Workspace vs Configurable Workspace with a migration list.
 *
 * Macroponent JSON goes through the `uib-composition` / `json` decoders and
 * the tolerant readers in uib-composition.ts: an unknown shape is reported
 * raw with `decoded:false`, never a failure.
 *
 * Bounds: at most `CHILD_LIMIT` rows per read, IN lists chunked, component
 * trees capped (COMPOSITION_MAX_ELEMENTS). Every UIB / Next Experience table
 * is `verified:false` in the registry (gate O-5), so an unreadable table
 * (policy denial, ACL, missing plugin) becomes a caveat with the table name
 * and status, and fields the instance did not return are listed per table in
 * `missingFields`. Metadata only by default: no client-script or broker script
 * bodies.
 *
 * N-26 (UX-02, UX-03, UX-04, UX-06) adds opt-in depth through `detail`:
 *
 * - `elements` — element props / config / overrides on the component tree,
 *   and each `definition.id` resolved to an OOB `now-*` component, a custom
 *   `sys_ux_lib_component` or a nested macroponent (with the registry type to
 *   pass to get_artifact);
 * - `bindings` — every binding expression (`@data.*`, `@state.*`,
 *   `@context.*`, `@payload.*`) with the data resource / broker or state
 *   property it resolves to;
 * - `events` — source element → event → handler → target, where the target
 *   is a client script, a broker operation, a state change or a page event
 *   (`sys_ux_event`);
 * - `scripts` — client-script and broker script bodies.
 *
 * N-31 (UX-22, UX-23) adds page hints: `pageHints` lists the `uib-page-weight`
 * findings (uib-page-lint.ts) of each macroponent that has any, with the
 * screen variants that render it (omitted when no page trips the rule, so a
 * light page's JSON does not grow). With `elements` depth, each macroponent
 * also carries its `pageMetrics` and a `translations` summary
 * (uib-translations.ts: user-facing composition strings against the
 * declared `required_translations`, with a bounded sample).
 *
 * N-29 (UX-11) resolves REST and GraphQL data brokers too
 * (sys_ux_data_broker_rest / _graphql, O-5: unverified) and adds broker
 * hints: `brokerHints` lists the uib-broker-lint.ts findings of each broker
 * that has any — a mutating broker with no ux_data_broker ACL (error), a
 * transform querying with GlideRecord without an access check (warn), an
 * empty input schema (info). Omitted when no broker trips a rule. The
 * transform script is read for the check but echoed only with `scripts`.
 *
 * The tool reaches the full depth through `format: "file"` (the JSON lands in
 * exports/, not in the context); a dedicated `detail` input waits for the
 * tools/list budget (O-10). Prop, binding and handler shapes are
 * verified:false until O-5.
 *
 * Layout: the result and option shapes are in ui-experience-types.ts, the
 * Mermaid and Markdown renderers in ui-experience-render.ts; this module
 * reads the experience and re-exports both.
 */
import { decodeField } from "../core/artifacts/decoders.js";
import {
  compositionTree,
  dataResources,
  eventMappings,
  eventWiring,
  stateProperties,
  type UibDataResource,
  type UibElement,
  type UibEventHandler,
} from "../core/artifacts/uib-composition.js";
import { ServiceNowError } from "../core/errors.js";
import { trackProgress } from "../core/progress.js";
import { CHILD_LIMIT, tableAvailable } from "./artifacts.js";
import { readEncodedQuery, type EncodedQueryTerm } from "./query-explain.js";
import { requiredTranslations } from "../core/artifacts/uib-translations.js";
import { lintUibPageWeight } from "./uib-page-lint.js";
import { BROKER_KIND_BY_TABLE, lintUibBroker } from "./uib-broker-lint.js";
import { snString, degradeStatus } from "./shared.js";
import {
  boundedRead,
  boundedReadIn,
  noteMissing,
  type ReadCtx,
  type Unreadable,
} from "./bounded-read.js";
import { keyQuery, queryTable, type SnRecord } from "./table.js";
import {
  WORKSPACE_CAVEAT,
  classifyWorkspace,
  decodeShell,
  formViews,
  listColumns,
  readDeclarativeActions,
  readThemes,
  type WorkspaceIo,
} from "./uib-workspace.js";
import { isSysId } from "../core/sys-id.js";
import {
  type DecodedColumn,
  type UxCounts,
  type ExplainUiExperienceOptions,
  type ExplainUiExperienceResult,
  type UiExperienceDetail,
  type UxScreen,
  type UxMacroponent,
  type UxBrokerHint,
  type UxPageHint,
  UI_EXPERIENCE_DETAILS,
  type UxScriptBody,
  type UxBinding,
  type UxDataBroker,
  type UxEventTarget,
  type UxComponent,
} from "./ui-experience-types.js";

export { UI_EXPERIENCE_DETAILS } from "./ui-experience-types.js";
export type {
  UiExperienceDetail,
  ExplainUiExperienceOptions,
  DecodedColumn,
  UxApplicability,
  UxScreen,
  UxRoute,
  UxScriptBody,
  UxComponent,
  UxBinding,
  UxEventTarget,
  UxEventChain,
  UxMacroponent,
  UxTranslations,
  UxPageHint,
  UxBrokerHint,
  UxDataBroker,
  UxDashboard,
  UxListMenu,
  UxFormActionLayout,
  UxProperty,
  UxCounts,
  ExplainUiExperienceResult,
} from "./ui-experience-types.js";
export {
  uiExperienceMermaid,
  uiExperienceEventMermaid,
  uiExperienceMarkdown,
} from "./ui-experience-render.js";

/** A record id safe to splice into an encoded query. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Characters of an undecodable JSON column echoed back raw. */
const RAW_MAX = 2000;

const UNVERIFIED_CAVEAT =
  "UI Builder and Next Experience tables are verified:false: their table and field names, and the JSON shapes of macroponent columns, come from the SDK inventory and have not been confirmed on a live instance (gate O-5).";

const LINK_CAVEAT =
  "Dashboards and list menus are found through sys_id values in the experience's page properties, and form action layouts through the experience's application scope; both links are unverified (gate O-5).";

/** Characters of one script body kept with `detail: "scripts"`. */
export const UI_SCRIPT_MAX = 100_000;

/** N-31: undeclared (or, with an unknown declaration, all) strings sampled. */
export const UI_TRANSLATION_SAMPLE = 20;

const PAGE_HINT_CAVEAT =
  "Page hints (uib-page-weight) treat a data resource with no on-demand evaluation mode as fired on page load, and read `when` conditions from data resource shapes that have not been confirmed on a live instance (gate O-5).";

const BROKER_HINT_CAVEAT =
  "Broker hints (N-29) read `mutates_server_data`, `properties` and the REST / GraphQL broker tables (sys_ux_data_broker_rest / _graphql), which have not been confirmed on a live instance (gate O-5); the GlideRecord rule is a static check of the transform script.";

/** N-29: broker tables in resolution order, with the fields read (O-5). */
const UI_BROKER_READS: readonly (readonly [string, string[]])[] = [
  [
    "sys_ux_data_broker_transform",
    ["sys_id", "name", "mutates_server_data", "properties", "script"],
  ],
  ["sys_ux_data_broker_scriptlet", ["sys_id", "name", "properties"]],
  [
    "sys_ux_data_broker_rest",
    ["sys_id", "name", "mutates_server_data", "properties"],
  ],
  [
    "sys_ux_data_broker_graphql",
    ["sys_id", "name", "mutates_server_data", "properties"],
  ],
];

const TRANSLATIONS_CAVEAT =
  "Translations list user-facing literals of the composition (text-like props and typed translation literals) against `required_translations`; both shapes are unverified until O-5, and the strings are not yet checked against sys_ui_message (N-7).";

const DETAIL_CAVEAT =
  "Element props, binding expressions, event handler targets and component resolution read UI Builder JSON shapes (propertyValues, typed bindings, handler definition / targetId / operationName) that have not been confirmed on a live instance (gate O-5).";

const str = (row: SnRecord, field: string): string => snString(row[field]);
const opt = (row: SnRecord, field: string): string | undefined =>
  str(row, field) || undefined;
const num = (row: SnRecord, field: string): number => {
  const n = Number(str(row, field));
  return Number.isFinite(n) ? n : 0;
};
const byOrder = <T extends { order: number }>(a: T, b: T): number =>
  a.order - b.order;

function groupBy(rows: SnRecord[], field: string): Map<string, SnRecord[]> {
  const out = new Map<string, SnRecord[]>();
  for (const row of rows) {
    const key = str(row, field);
    if (!key) continue;
    const list = out.get(key) ?? [];
    list.push(row);
    out.set(key, list);
  }
  return out;
}

const ids = (rows: SnRecord[], field = "sys_id"): string[] =>
  rows.map((r) => str(r, field)).filter(Boolean);

/** Every 32-hex sys_id inside a (decoded) value, bounded. */
function sysIdsIn(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 8 || out.size >= CHILD_LIMIT) return;
  if (typeof value === "string") {
    for (const m of value.matchAll(/\b[0-9a-f]{32}\b/g)) out.add(m[0]);
  } else if (Array.isArray(value)) {
    for (const v of value) sysIdsIn(v, out, depth + 1);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) sysIdsIn(v, out, depth + 1);
  }
}

/** Decode one JSON column with a reader over the decoded value. */
function column<T>(
  raw: string,
  decoder: "json" | "uib-composition",
  reader: (value: unknown) => T | null,
  what: string,
): DecodedColumn<T> {
  const d = decodeField(decoder, raw);
  if (!d.decoded) {
    return { decoded: false, reason: d.reason, raw: raw.slice(0, RAW_MAX) };
  }
  const value = reader(d.value);
  if (value === null) {
    return {
      decoded: false,
      reason: `Unknown ${what} shape.`,
      raw: raw.slice(0, RAW_MAX),
    };
  }
  return { decoded: true, value };
}

const ROOT_FIELDS = [
  "sys_id",
  "title",
  "path",
  "root_macroponent",
  "admin_panel",
  "sys_scope",
  "active",
];
const ROUTE_FIELDS = [
  "sys_id",
  "name",
  "route_type",
  "screen_type",
  "parent_macroponent",
  "app_config",
  "order",
];
const SCREEN_FIELDS = [
  "sys_id",
  "name",
  "screen_type",
  "macroponent",
  "applicability",
  "order",
  "active",
];
const MACROPONENT_FIELDS = [
  "sys_id",
  "name",
  "category",
  "composition",
  "data",
  "state_properties",
  "internal_event_mappings",
];

/** Resolve the root: the page registry record, by sys_id or path. */
async function readRoot(
  ctx: ReadCtx,
  value: string,
): Promise<{ row: SnRecord } | { unreadable: Unreadable }> {
  const table = "sys_ux_page_registry";
  const text = value.trim();
  const bySysId = isSysId(text);
  const query = bySysId ? `sys_id=${text}` : keyQuery({ path: text });
  ctx.progress.tick(table);
  try {
    const { records } = await queryTable({
      table,
      query,
      fields: ROOT_FIELDS,
      limit: 2,
      displayValue: "false",
    });
    if (!records.length) {
      throw new ServiceNowError(
        `No ${table} record matches ${bySysId ? "sys_id" : "path"} '${text}'.`,
        404,
        undefined,
        {
          hint: "Pass the experience's path (e.g. 'now/sow') or its sys_ux_page_registry sys_id.",
        },
      );
    }
    if (records.length > 1) {
      ctx.caveats.push(
        `More than one ${table} record matches path '${text}'; the first is explained.`,
      );
    }
    noteMissing(ctx, table, ROOT_FIELDS, records);
    return { row: records[0]! };
  } catch (error) {
    const status = degradeStatus(error);
    if (
      status === undefined ||
      (error instanceof ServiceNowError &&
        error.message.startsWith(`No ${table} record`))
    ) {
      throw error;
    }
    return { unreadable: { table, status, reason: (error as Error).message } };
  }
}

function emptyCounts(): UxCounts {
  return {
    routes: 0,
    screens: 0,
    macroponents: 0,
    elements: 0,
    dataResources: 0,
    clientScripts: 0,
    dataBrokers: 0,
    acls: 0,
    applicabilities: 0,
    dashboards: 0,
    listMenus: 0,
    lists: 0,
    formActionLayouts: 0,
    actions: 0,
    themes: 0,
  };
}

/**
 * Explain a UI Builder experience (`sys_id` or `path` of a
 * sys_ux_page_registry record) as a page map.
 */
export async function explainUiExperience(
  opts: ExplainUiExperienceOptions,
): Promise<ExplainUiExperienceResult> {
  const hasId = !!opts.sys_id?.trim();
  const hasPath = !!opts.path?.trim();
  if (hasId === hasPath) {
    throw new ServiceNowError(
      "Pass exactly one of 'sys_id' (sys_ux_page_registry sys_id) or 'path' (e.g. 'now/sow').",
      400,
    );
  }
  if (hasId && !isSysId(opts.sys_id!.trim())) {
    throw new ServiceNowError(
      "'sys_id' must be a 32-character sys_id; pass a path as 'path'.",
      400,
    );
  }
  const levels = detailLevels(opts.detail);
  const want = (l: UiExperienceDetail): boolean => levels.includes(l);
  const withProps = want("elements") || want("bindings");
  const ctx: ReadCtx = {
    caveats: [UNVERIFIED_CAVEAT],
    scope: "the page map",
    unreadable: [],
    missing: {},
    progress: trackProgress(),
  };
  const result: ExplainUiExperienceResult = {
    experience: null,
    appConfig: null,
    properties: [],
    routes: [],
    macroponents: [],
    dataBrokers: [],
    unresolvedBrokers: [],
    applicabilities: [],
    dashboards: [],
    listMenus: [],
    formActionLayouts: [],
    shell: null,
    actions: [],
    forms: [],
    themes: [],
    workspace: { kind: "unknown", signals: [], migration: [] },
    counts: emptyCounts(),
    verified: false,
    caveats: ctx.caveats,
    unreadable: ctx.unreadable,
  };

  const root = await readRoot(ctx, (opts.sys_id ?? opts.path)!);
  if ("unreadable" in root) {
    return degrade(result, root.unreadable, "sys_ux_page_registry");
  }
  const row = root.row;
  const expId = str(row, "sys_id");
  result.experience = {
    sys_id: expId,
    ...(opt(row, "title") ? { title: opt(row, "title") } : {}),
    ...(opt(row, "path") ? { path: opt(row, "path") } : {}),
    ...(opt(row, "root_macroponent")
      ? { root_macroponent: opt(row, "root_macroponent") }
      : {}),
    ...(opt(row, "admin_panel")
      ? { admin_panel: opt(row, "admin_panel") }
      : {}),
    ...(opt(row, "sys_scope") ? { sys_scope: opt(row, "sys_scope") } : {}),
    ...(opt(row, "active") ? { active: opt(row, "active") } : {}),
  };

  // Page properties (P-15: landing page, list and dashboard configuration).
  const propRows = await boundedReadIn(
    ctx,
    "sys_ux_page_property",
    "page",
    [expId],
    ["sys_id", "page", "name", "type", "value"],
    { order: "name" },
  );
  const referenced = new Set<string>();
  for (const p of propRows) {
    const raw = str(p, "value");
    let value: unknown = raw;
    if (/^\s*[[{]/.test(raw)) {
      const d = decodeField("json", raw);
      if (d.decoded) value = d.value;
    }
    sysIdsIn(value, referenced);
    result.properties.push({
      sys_id: str(p, "sys_id"),
      name: str(p, "name"),
      ...(opt(p, "type") ? { type: opt(p, "type") } : {}),
      ...(raw ? { value } : {}),
    });
  }

  // App config → routes → screen variants.
  const configId = opt(row, "admin_panel");
  if (configId) {
    const cfg = await boundedReadIn(
      ctx,
      "sys_ux_app_config",
      "sys_id",
      [configId],
      ["sys_id", "name", "landing_path"],
    );
    if (cfg[0]) {
      result.appConfig = {
        sys_id: str(cfg[0], "sys_id"),
        ...(opt(cfg[0], "name") ? { name: opt(cfg[0], "name") } : {}),
        ...(opt(cfg[0], "landing_path")
          ? { landing_path: opt(cfg[0], "landing_path") }
          : {}),
      };
    }
  } else {
    ctx.caveats.push(
      "The experience has no admin_panel (sys_ux_app_config): routes and screens are not read.",
    );
  }
  const routeRows = configId
    ? await boundedReadIn(
        ctx,
        "sys_ux_app_route",
        "app_config",
        [configId],
        ROUTE_FIELDS,
        {
          order: "order",
        },
      )
    : [];
  const screenRows = await boundedReadIn(
    ctx,
    "sys_ux_screen",
    "screen_type",
    ids(routeRows, "screen_type"),
    SCREEN_FIELDS,
    { order: "order" },
  );
  const screensByType = groupBy(screenRows, "screen_type");
  for (const r of routeRows) {
    const screens: UxScreen[] = (screensByType.get(str(r, "screen_type")) ?? [])
      .map((s) => ({
        sys_id: str(s, "sys_id"),
        ...(opt(s, "name") ? { name: opt(s, "name") } : {}),
        order: num(s, "order"),
        ...(opt(s, "macroponent")
          ? { macroponent: opt(s, "macroponent") }
          : {}),
        ...(opt(s, "applicability")
          ? { applicability: opt(s, "applicability") }
          : {}),
        ...(opt(s, "active") ? { active: opt(s, "active") } : {}),
      }))
      .sort(byOrder);
    result.routes.push({
      sys_id: str(r, "sys_id"),
      ...(opt(r, "name") ? { name: opt(r, "name") } : {}),
      ...(opt(r, "route_type") ? { route_type: opt(r, "route_type") } : {}),
      ...(opt(r, "screen_type") ? { screen_type: opt(r, "screen_type") } : {}),
      ...(opt(r, "parent_macroponent")
        ? { parent_macroponent: opt(r, "parent_macroponent") }
        : {}),
      order: num(r, "order"),
      screens,
    });
  }
  result.routes.sort(byOrder);

  // Macroponents: the root, route parents and screen variants.
  const macroIds = [
    ...(opt(row, "root_macroponent") ? [str(row, "root_macroponent")] : []),
    ...ids(routeRows, "parent_macroponent"),
    ...ids(screenRows, "macroponent"),
  ];
  const macroRows = await boundedReadIn(
    ctx,
    "sys_ux_macroponent",
    "sys_id",
    macroIds,
    [
      ...MACROPONENT_FIELDS,
      ...(want("elements") ? ["required_translations"] : []),
    ],
  );
  const scriptRows = await boundedReadIn(
    ctx,
    "sys_ux_client_script",
    "macroponent",
    ids(macroRows),
    [
      "sys_id",
      "name",
      "type",
      "macroponent",
      ...(want("scripts") ? ["script"] : []),
    ],
    { order: "name" },
  );
  const scriptsBy = groupBy(scriptRows, "macroponent");
  const order = new Map(macroIds.map((id, i) => [id, i] as const));
  macroRows.sort(
    (a, b) =>
      (order.get(str(a, "sys_id")) ?? 0) - (order.get(str(b, "sys_id")) ?? 0),
  );
  for (const m of macroRows) {
    const id = str(m, "sys_id");
    const mp: UxMacroponent = {
      sys_id: id,
      ...(opt(m, "name") ? { name: opt(m, "name") } : {}),
      ...(opt(m, "category") ? { category: opt(m, "category") } : {}),
      composition: column(
        str(m, "composition"),
        "uib-composition",
        (v) => compositionTree(v, { props: withProps }),
        "composition",
      ),
      data: column(str(m, "data"), "json", dataResources, "data"),
      state: column(
        str(m, "state_properties"),
        "json",
        stateProperties,
        "state_properties",
      ),
      events: column(
        str(m, "internal_event_mappings"),
        "json",
        eventWiring,
        "internal_event_mappings",
      ),
      clientScripts: (scriptsBy.get(id) ?? []).map((s) => ({
        sys_id: str(s, "sys_id"),
        ...(opt(s, "name") ? { name: opt(s, "name") } : {}),
        ...(opt(s, "type") ? { type: opt(s, "type") } : {}),
        ...(want("scripts") ? scriptBody(s) : {}),
      })),
    };
    if (mp.composition.value?.omitted) {
      ctx.caveats.push(
        `Macroponent ${mp.name ?? id}: ${mp.composition.value.omitted} composition element(s) past the element or depth cap are not listed.`,
      );
    }
    result.macroponents.push(mp);
  }
  const missingMacros = [...new Set(macroIds)].filter(
    (id) => !macroRows.some((m) => str(m, "sys_id") === id),
  );
  if (
    missingMacros.length &&
    !ctx.unreadable.some((u) => u.table === "sys_ux_macroponent")
  ) {
    ctx.caveats.push(
      `${missingMacros.length} referenced macroponent(s) were not found: ${missingMacros.slice(0, 10).join(", ")}.`,
    );
  }

  // Data brokers referenced by data resources, and their ux_data_broker ACLs.
  const brokerIds = new Set<string>();
  for (const mp of result.macroponents) {
    for (const d of mp.data.value ?? []) {
      if (d.broker && isSysId(d.broker)) brokerIds.add(d.broker);
    }
  }
  // N-29: transform, scriptlet, then REST and GraphQL brokers (the latter
  // only for ids still unresolved — O-5: unverified tables). `properties`
  // and the transform `script` are read for the broker hints; the script is
  // echoed only with `scripts` depth.
  const brokerRows = new Map<string, SnRecord>();
  const pending = new Set(brokerIds);
  for (const [table, fields] of UI_BROKER_READS) {
    if (!pending.size) break;
    const read = [
      ...fields,
      ...(want("scripts") && !fields.includes("script") ? ["script"] : []),
    ];
    const rows = await boundedReadIn(ctx, table, "sys_id", pending, read);
    for (const b of rows) {
      const id = str(b, "sys_id");
      if (!pending.delete(id)) continue;
      brokerRows.set(id, b);
      result.dataBrokers.push({
        sys_id: id,
        table,
        ...(opt(b, "name") ? { name: opt(b, "name") } : {}),
        ...(opt(b, "mutates_server_data")
          ? { mutates_server_data: opt(b, "mutates_server_data") }
          : {}),
        ...(want("scripts") ? scriptBody(b) : {}),
        acls: [],
      });
    }
  }
  const found = new Set(result.dataBrokers.map((b) => b.sys_id));
  result.unresolvedBrokers = [...brokerIds].filter((id) => !found.has(id));
  if (result.unresolvedBrokers.length) {
    ctx.caveats.push(
      `${result.unresolvedBrokers.length} data resource broker(s) are not transform, scriptlet, REST or GraphQL brokers (built-in brokers are not read) or could not be found.`,
    );
  }
  if (found.size) {
    const aclRows = await boundedReadIn(
      ctx,
      "sys_security_acl",
      "name",
      found,
      ["sys_id", "name", "operation", "active", "type"],
      { prefix: "type=ux_data_broker" },
    );
    const aclBy = groupBy(aclRows, "name");
    for (const b of result.dataBrokers) {
      b.acls = (aclBy.get(b.sys_id) ?? []).map((a) => ({
        sys_id: str(a, "sys_id"),
        ...(opt(a, "name") ? { name: opt(a, "name") } : {}),
        ...(opt(a, "operation") ? { operation: opt(a, "operation") } : {}),
        ...(opt(a, "active") ? { active: opt(a, "active") } : {}),
      }));
    }
  }
  readBrokerHints(ctx, result, brokerRows);

  // P-15: dashboards and list menus referenced by the page properties.
  if (referenced.size) {
    const dashRows = await boundedReadIn(
      ctx,
      "par_dashboard",
      "sys_id",
      referenced,
      ["sys_id", "name", "active"],
    );
    const tabRows = await boundedReadIn(
      ctx,
      "par_dashboard_tab",
      "dashboard",
      ids(dashRows),
      ["sys_id", "dashboard", "name", "order"],
      { order: "order" },
    );
    const widgetRows = await boundedReadIn(
      ctx,
      "par_dashboard_widget",
      "tab",
      ids(tabRows),
      ["sys_id", "tab", "name", "component"],
    );
    const tabsBy = groupBy(tabRows, "dashboard");
    const widgetsBy = groupBy(widgetRows, "tab");
    for (const d of dashRows) {
      result.dashboards.push({
        sys_id: str(d, "sys_id"),
        ...(opt(d, "name") ? { name: opt(d, "name") } : {}),
        ...(opt(d, "active") ? { active: opt(d, "active") } : {}),
        tabs: (tabsBy.get(str(d, "sys_id")) ?? [])
          .map((t) => ({
            sys_id: str(t, "sys_id"),
            ...(opt(t, "name") ? { name: opt(t, "name") } : {}),
            order: num(t, "order"),
            widgets: (widgetsBy.get(str(t, "sys_id")) ?? []).map((w) => ({
              sys_id: str(w, "sys_id"),
              ...(opt(w, "name") ? { name: opt(w, "name") } : {}),
              ...(opt(w, "component")
                ? { component: opt(w, "component") }
                : {}),
            })),
          }))
          .sort(byOrder),
      });
    }

    const menuRows = await boundedReadIn(
      ctx,
      "sys_ux_list_menu_config",
      "sys_id",
      referenced,
      ["sys_id", "name", "active"],
    );
    const catRows = await boundedReadIn(
      ctx,
      "sys_ux_list_category",
      "configuration",
      ids(menuRows),
      ["sys_id", "configuration", "title", "order"],
      { order: "order" },
    );
    const listRows = await boundedReadIn(
      ctx,
      "sys_ux_list",
      "category",
      ids(catRows),
      ["sys_id", "category", "title", "table", "condition", "columns", "order"],
      { order: "order" },
    );
    const m2mRows = await boundedReadIn(
      ctx,
      "sys_ux_applicability_m2m_list",
      "list",
      ids(listRows),
      ["sys_id", "list", "applicability"],
    );
    const catsBy = groupBy(catRows, "configuration");
    const listsBy = groupBy(listRows, "category");
    const m2mBy = groupBy(m2mRows, "list");
    for (const m of menuRows) {
      result.listMenus.push({
        sys_id: str(m, "sys_id"),
        ...(opt(m, "name") ? { name: opt(m, "name") } : {}),
        ...(opt(m, "active") ? { active: opt(m, "active") } : {}),
        categories: (catsBy.get(str(m, "sys_id")) ?? [])
          .map((c) => ({
            sys_id: str(c, "sys_id"),
            ...(opt(c, "title") ? { title: opt(c, "title") } : {}),
            order: num(c, "order"),
            lists: (listsBy.get(str(c, "sys_id")) ?? [])
              .map((l) => ({
                sys_id: str(l, "sys_id"),
                ...(opt(l, "title") ? { title: opt(l, "title") } : {}),
                ...(opt(l, "table") ? { table: opt(l, "table") } : {}),
                ...(opt(l, "condition")
                  ? { condition: opt(l, "condition") }
                  : {}),
                ...(opt(l, "columns")
                  ? { columns: listColumns(str(l, "columns")) }
                  : {}),
                ...listConditionTerms(str(l, "condition")),
                order: num(l, "order"),
                applicability: ids(
                  m2mBy.get(str(l, "sys_id")) ?? [],
                  "applicability",
                ),
              }))
              .sort(byOrder),
          }))
          .sort(byOrder),
      });
    }
  }

  // P-15: form action layouts of the experience's application scope.
  const scope = opt(row, "sys_scope");
  const formItems: SnRecord[] = [];
  const formActions = new Map<string, SnRecord>();
  if (scope && SAFE_ID.test(scope)) {
    const layoutRows = await boundedRead(
      ctx,
      "sys_ux_form_action_layout",
      `sys_scope=${scope}^ORDERBYname`,
      ["sys_id", "name", "table"],
    );
    formItems.push(
      ...(await boundedReadIn(
        ctx,
        "sys_ux_form_action_layout_item",
        "form_action_layout",
        ids(layoutRows),
        ["sys_id", "form_action_layout", "form_action", "order"],
        { order: "order" },
      )),
    );
    for (const a of await boundedReadIn(
      ctx,
      "sys_ux_form_action",
      "sys_id",
      ids(formItems, "form_action"),
      ["sys_id", "label", "action", "applicability"],
    )) {
      formActions.set(str(a, "sys_id"), a);
    }
    const itemsBy = groupBy(formItems, "form_action_layout");
    for (const l of layoutRows) {
      result.formActionLayouts.push({
        sys_id: str(l, "sys_id"),
        ...(opt(l, "name") ? { name: opt(l, "name") } : {}),
        ...(opt(l, "table") ? { table: opt(l, "table") } : {}),
        items: (itemsBy.get(str(l, "sys_id")) ?? [])
          .map((it) => {
            const action = formActions.get(str(it, "form_action"));
            return {
              sys_id: str(it, "sys_id"),
              order: num(it, "order"),
              ...(opt(it, "form_action")
                ? { form_action: opt(it, "form_action") }
                : {}),
              ...(action && opt(action, "label")
                ? { label: opt(action, "label") }
                : {}),
              ...(action && opt(action, "action")
                ? { action: opt(action, "action") }
                : {}),
              ...(action && opt(action, "applicability")
                ? { applicability: opt(action, "applicability") }
                : {}),
            };
          })
          .sort(byOrder),
      });
    }
  }
  if (referenced.size || formItems.length || result.formActionLayouts.length) {
    ctx.caveats.push(LINK_CAVEAT);
  }

  await readWorkspace(ctx, result, row, macroRows, configId);

  // Audiences: screen variants, lists and form actions.
  const applicabilityIds = new Set<string>([
    ...ids(screenRows, "applicability"),
    ...result.listMenus.flatMap((m) =>
      m.categories.flatMap((c) => c.lists.flatMap((l) => l.applicability)),
    ),
    ...result.formActionLayouts.flatMap((l) =>
      l.items.flatMap((i) => (i.applicability ? [i.applicability] : [])),
    ),
  ]);
  for (const a of await boundedReadIn(
    ctx,
    "sys_ux_applicability",
    "sys_id",
    applicabilityIds,
    ["sys_id", "name", "roles", "active"],
  )) {
    result.applicabilities.push({
      sys_id: str(a, "sys_id"),
      ...(opt(a, "name") ? { name: opt(a, "name") } : {}),
      roles: str(a, "roles")
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean),
      ...(opt(a, "active") ? { active: opt(a, "active") } : {}),
    });
  }

  readPageHints(ctx, result, macroRows);

  const c = result.counts;
  c.routes = result.routes.length;
  c.screens = result.routes.reduce((n, r) => n + r.screens.length, 0);
  c.macroponents = result.macroponents.length;
  c.elements = result.macroponents.reduce(
    (n, m) => n + (m.composition.value?.count ?? 0),
    0,
  );
  c.dataResources = result.macroponents.reduce(
    (n, m) => n + (m.data.value?.length ?? 0),
    0,
  );
  c.clientScripts = scriptRows.length;
  c.dataBrokers = result.dataBrokers.length;
  c.acls = result.dataBrokers.reduce((n, b) => n + b.acls.length, 0);
  c.applicabilities = result.applicabilities.length;
  c.dashboards = result.dashboards.length;
  c.listMenus = result.listMenus.length;
  c.lists = result.listMenus.reduce(
    (n, m) => n + m.categories.reduce((k, cat) => k + cat.lists.length, 0),
    0,
  );
  c.formActionLayouts = result.formActionLayouts.length;
  c.actions = result.actions.length;
  c.themes = result.themes.length;
  if (levels.length) {
    await readDetail(ctx, result, levels, macroRows, scriptRows);
  }
  if (Object.keys(ctx.missing).length) result.missingFields = ctx.missing;
  return result;
}

/** N-30: a list condition's terms, when the reader parses any. */
function listConditionTerms(condition: string): {
  conditionTerms?: EncodedQueryTerm[];
} {
  if (!condition) return {};
  const { terms } = readEncodedQuery(condition);
  return terms.length ? { conditionTerms: terms } : {};
}

/**
 * N-30: shell and chrome, declarative actions, UX form views, themes and the
 * Agent / Configurable Workspace classification (uib-workspace.ts).
 */
async function readWorkspace(
  ctx: ReadCtx,
  result: ExplainUiExperienceResult,
  row: SnRecord,
  macroRows: SnRecord[],
  configId: string | undefined,
): Promise<void> {
  const io: WorkspaceIo = {
    read: (table, query, fields) => boundedRead(ctx, table, query, fields),
    readIn: (table, field, list, fields, opts) =>
      boundedReadIn(ctx, table, field, list, fields, opts),
  };
  const expId = str(row, "sys_id");
  const rootId = opt(row, "root_macroponent");
  const rootRow = rootId
    ? macroRows.find((m) => str(m, "sys_id") === rootId)
    : undefined;
  result.shell = decodeShell(
    result.properties,
    rootId
      ? {
          sys_id: rootId,
          ...(rootRow && opt(rootRow, "name")
            ? { name: opt(rootRow, "name") }
            : {}),
          ...(rootRow && opt(rootRow, "category")
            ? { category: opt(rootRow, "category") }
            : {}),
        }
      : undefined,
  );
  const uxListTables = result.listMenus.flatMap((m) =>
    m.categories.flatMap((c) => c.lists.flatMap((l) => l.table ?? [])),
  );
  const tables = new Set<string>([
    ...uxListTables,
    ...result.formActionLayouts.flatMap((l) => l.table ?? []),
    ...(result.shell?.tabs?.newTabTables ?? []),
  ]);
  result.actions = (await readDeclarativeActions(io, tables)).sort(
    (a, b) => (a.table ?? "").localeCompare(b.table ?? "") || a.order - b.order,
  );
  result.forms = formViews(result.actions, result.formActionLayouts);
  result.themes = await readThemes(io, [
    expId,
    ...(configId ? [configId] : []),
  ]);
  const categories = (
    await boundedReadIn(
      ctx,
      "sys_ux_registry_m2m_category",
      "page_registry",
      [expId],
      ["sys_id", "page_registry", "experience_category"],
    )
  )
    .filter((r) => str(r, "page_registry") === expId)
    .map((r) => str(r, "experience_category"))
    .filter(Boolean);
  const scope = opt(row, "sys_scope");
  const inScope = async (table: string, fields: string[]) =>
    scope && SAFE_ID.test(scope)
      ? (await boundedRead(ctx, table, `sys_scope=${scope}`, fields)).filter(
          (r) => !("sys_scope" in r) || str(r, "sys_scope") === scope,
        )
      : [];
  const awConfigs = await inScope("sys_aw_master_config", ["sys_id", "name"]);
  const awLists = await inScope("sys_aw_list", ["sys_id", "title", "table"]);
  result.workspace = classifyWorkspace({
    ...(result.experience?.path ? { path: result.experience.path } : {}),
    categories,
    propertyNames: result.properties.map((p) => p.name),
    routes: result.routes.length,
    actions: result.actions,
    awConfigs,
    awLists,
    uxListTables,
    ...(result.experience?.title
      ? { experienceName: result.experience.title }
      : {}),
  });
  if (
    result.shell ||
    result.actions.length ||
    result.themes.length ||
    result.workspace.signals.length
  ) {
    ctx.caveats.push(WORKSPACE_CAVEAT);
  }
}

/**
 * N-29 (UX-11): the broker rules (uib-broker-lint.ts) over every broker
 * read. ACL presence is unknown when sys_security_acl was unreadable, so
 * `uib-broker-mutates-no-acl` does not fire then.
 */
function readBrokerHints(
  ctx: ReadCtx,
  result: ExplainUiExperienceResult,
  rows: Map<string, SnRecord>,
): void {
  const aclKnown = !ctx.unreadable.some((u) => u.table === "sys_security_acl");
  const field = (row: SnRecord, f: string): string | undefined =>
    f in row ? str(row, f) : undefined;
  const hints: UxBrokerHint[] = [];
  for (const b of result.dataBrokers) {
    const row = rows.get(b.sys_id);
    const kind = BROKER_KIND_BY_TABLE[b.table];
    if (!row || !kind) continue;
    const findings = lintUibBroker(
      {
        kind,
        mutates_server_data: field(row, "mutates_server_data"),
        properties: field(row, "properties"),
        script: kind === "transform" ? field(row, "script") : undefined,
      },
      aclKnown ? { hasAcl: b.acls.length > 0 } : {},
    );
    if (!findings.length) continue;
    hints.push({
      broker: b.sys_id,
      ...(b.name ? { name: b.name } : {}),
      table: b.table,
      findings: findings.map((f) => ({
        rule: f.rule,
        severity: f.severity,
        message: f.message,
        ...(f.line !== undefined ? { line: f.line } : {}),
      })),
    });
  }
  if (!hints.length) return;
  result.brokerHints = hints;
  ctx.caveats.push(BROKER_HINT_CAVEAT);
}

/**
 * N-31 (UX-22): the `uib-page-weight` findings of every macroponent with
 * any, and the screen variants that render it. With `elements` depth the
 * metrics land on the macroponent too (readTranslations).
 */
function readPageHints(
  ctx: ReadCtx,
  result: ExplainUiExperienceResult,
  macroRows: SnRecord[],
): void {
  const hints: UxPageHint[] = [];
  for (const row of macroRows) {
    const id = str(row, "sys_id");
    const { metrics, findings } = lintUibPageWeight({
      composition: str(row, "composition"),
      data: str(row, "data"),
    });
    if (!findings.length) continue;
    const mp = result.macroponents.find((m) => m.sys_id === id);
    const screens = result.routes.flatMap((r) =>
      r.screens
        .filter((s) => s.macroponent === id)
        .map((s) => s.name ?? s.sys_id),
    );
    hints.push({
      macroponent: id,
      ...(mp?.name ? { name: mp.name } : {}),
      ...(screens.length ? { screens } : {}),
      findings: findings.map((f) => {
        const { hint, ...rest } = f;
        void hint;
        return rest;
      }),
      ...(metrics.partial ? { partial: true as const } : {}),
    });
  }
  if (!hints.length) return;
  result.pageHints = hints;
  ctx.caveats.push(PAGE_HINT_CAVEAT);
}

/**
 * N-31 (UX-22, UX-23), `elements` depth: each macroponent's page metrics
 * and its translatable strings against `required_translations`.
 */
function readTranslations(
  ctx: ReadCtx,
  result: ExplainUiExperienceResult,
  macroRows: SnRecord[],
): void {
  let strings = 0;
  let undeclaredCount = 0;
  let any = false;
  for (const row of macroRows) {
    const mp = result.macroponents.find((m) => m.sys_id === str(row, "sys_id"));
    if (!mp) continue;
    mp.pageMetrics = lintUibPageWeight({
      composition: str(row, "composition"),
      data: str(row, "data"),
    }).metrics;
    const comp = decodeField(
      "uib-composition",
      str(row, "composition") || "[]",
    );
    if (!comp.decoded) continue;
    const declared = declaredValue(row);
    const t = requiredTranslations(comp.value, declared.value);
    const known = declared.known && t.declared !== null;
    if (!t.strings.length && !t.declared?.length) continue;
    any = true;
    const undeclared = known ? t.undeclared : [];
    mp.translations = {
      strings: t.strings.length,
      texts: t.texts.length,
      declared: known ? t.declared!.length : null,
      undeclared: undeclared.length,
      sample: (known ? undeclared : t.texts).slice(0, UI_TRANSLATION_SAMPLE),
      ...(t.omitted ? { omitted: t.omitted } : {}),
    };
    strings += t.strings.length;
    undeclaredCount += undeclared.length;
  }
  if (!any) return;
  result.detail!.translatableStrings = strings;
  result.detail!.undeclaredTranslations = undeclaredCount;
  ctx.caveats.push(TRANSLATIONS_CAVEAT);
}

/**
 * The decoded `required_translations` of a macroponent row; not `known`
 * when the field was not returned or does not decode.
 */
function declaredValue(row: SnRecord): { known: boolean; value?: unknown } {
  if (!("required_translations" in row)) return { known: false };
  const raw = str(row, "required_translations");
  if (!raw.trim()) return { known: true, value: [] };
  const d = decodeField("json", raw);
  return d.decoded ? { known: true, value: d.value } : { known: false };
}

/** The requested N-26 levels, in canonical order, unknown values dropped. */
function detailLevels(
  detail: ExplainUiExperienceOptions["detail"],
): UiExperienceDetail[] {
  const asked = new Set<string>(
    detail === undefined ? [] : typeof detail === "string" ? [detail] : detail,
  );
  return UI_EXPERIENCE_DETAILS.filter((l) => asked.has(l));
}

/** A script body, cut at UI_SCRIPT_MAX (N-26, UX-06). */
function scriptBody(row: SnRecord): UxScriptBody {
  if (!("script" in row)) return {};
  const body = str(row, "script");
  if (body.length <= UI_SCRIPT_MAX) return { script: body };
  return {
    script: body.slice(0, UI_SCRIPT_MAX),
    scriptTruncated: body.length - UI_SCRIPT_MAX,
  };
}

/** Every element of a tree, depth first. */
function* allElements(elements: UibElement[]): Generator<UibElement> {
  for (const el of elements) {
    yield el;
    for (const slot of el.slots) yield* allElements(slot.elements);
  }
}

const OOB_TAG = /^(now|sn)-/;

/**
 * N-26 depth on top of the page map: component resolution (UX-04), bindings
 * (UX-02) and event chains (UX-03). Script bodies (UX-06) were read with the
 * client scripts and brokers.
 */
async function readDetail(
  ctx: ReadCtx,
  result: ExplainUiExperienceResult,
  levels: UiExperienceDetail[],
  macroRows: SnRecord[],
  scriptRows: SnRecord[],
): Promise<void> {
  ctx.caveats.push(DETAIL_CAVEAT);
  const detail = {
    levels,
    components: 0,
    unresolvedComponents: 0,
    bindings: 0,
    eventChains: 0,
    scripts: 0,
  };
  result.detail = detail;
  const brokers = new Map(result.dataBrokers.map((b) => [b.sys_id, b]));

  if (levels.includes("elements")) {
    readTranslations(ctx, result, macroRows);
    await resolveComponents(ctx, result);
    for (const m of result.macroponents) {
      for (const comp of m.components ?? []) {
        detail.components += 1;
        if (comp.kind === "unresolved") detail.unresolvedComponents += 1;
      }
    }
  }

  if (levels.includes("bindings")) {
    for (const m of result.macroponents) {
      const resources = new Map(
        (m.data.value ?? []).map((d) => [d.elementId, d] as const),
      );
      const states = new Set((m.state.value ?? []).map((st) => st.name));
      const bindings: UxBinding[] = [];
      for (const el of allElements(m.composition.value?.elements ?? [])) {
        for (const p of el.props ?? []) {
          for (const expression of p.bindings ?? []) {
            bindings.push({
              elementId: el.elementId,
              prop: p.name,
              source: p.source,
              kind: p.kind,
              expression,
              ...resolveBinding(expression, resources, states, brokers),
            });
          }
        }
      }
      if (bindings.length) m.bindings = bindings;
      detail.bindings += bindings.length;
    }
  }

  if (levels.includes("events")) {
    const scripts = new Map(
      scriptRows.map((r) => [str(r, "sys_id"), r] as const),
    );
    const decoded = macroRows.map((row) => ({
      id: str(row, "sys_id"),
      mappings: decodedMappings(str(row, "internal_event_mappings")),
    }));
    // Handler ids that are neither a client script nor known: sys_ux_event.
    const eventIds = new Set<string>();
    for (const d of decoded) {
      for (const mp of d.mappings) {
        for (const h of mp.handlers) {
          if (
            h.definitionId &&
            isSysId(h.definitionId) &&
            !scripts.has(h.definitionId)
          ) {
            eventIds.add(h.definitionId);
          }
        }
      }
    }
    const events = new Map(
      (
        await boundedReadIn(ctx, "sys_ux_event", "sys_id", eventIds, [
          "sys_id",
          "name",
          "label",
        ])
      ).map((r) => [str(r, "sys_id"), r] as const),
    );
    for (const m of result.macroponents) {
      const mappings = decoded.find((d) => d.id === m.sys_id)?.mappings ?? [];
      if (!mappings.length) continue;
      const elements = new Map<string, UibElement>();
      for (const el of allElements(m.composition.value?.elements ?? [])) {
        elements.set(el.elementId, el);
      }
      const resources = new Map(
        (m.data.value ?? []).map((d) => [d.elementId, d] as const),
      );
      const states = new Set((m.state.value ?? []).map((st) => st.name));
      m.eventChains = mappings.map((mp) => {
        let element: UibElement | undefined = elements.get(mp.source);
        let event = mp.event;
        if (!element && mp.source.includes(".")) {
          const dot = mp.source.indexOf(".");
          element = elements.get(mp.source.slice(0, dot));
          if (element && !event) event = mp.source.slice(dot + 1);
        }
        return {
          source: mp.source,
          ...(element ? { element: element.elementId } : {}),
          ...(element?.component ? { component: element.component } : {}),
          ...(event ? { event } : {}),
          targets: mp.handlers.map((h) =>
            resolveHandler(h, { scripts, resources, states, brokers, events }),
          ),
        };
      });
      detail.eventChains += m.eventChains.length;
    }
  }

  if (levels.includes("scripts")) {
    detail.scripts =
      result.macroponents.reduce(
        (n, m) => n + m.clientScripts.filter((s) => s.script).length,
        0,
      ) + result.dataBrokers.filter((b) => b.script).length;
  }
}

function decodedMappings(raw: string) {
  const d = decodeField("json", raw);
  return d.decoded ? (eventMappings(d.value) ?? []) : [];
}

/** What one binding expression points at (N-26, UX-02). */
function resolveBinding(
  expression: string,
  resources: Map<string, UibDataResource>,
  states: Set<string>,
  brokers: Map<string, UxDataBroker>,
): Pick<UxBinding, "resolves"> {
  const m = /^@(data|state|context|payload)\.([^.[]+)(.*)$/.exec(expression);
  if (!m) return {};
  const [, kind, head, rest] = m as unknown as [string, string, string, string];
  if (kind === "data") {
    const r = resources.get(head);
    const b = r?.broker ? brokers.get(r.broker) : undefined;
    return {
      resolves: {
        dataResource: head,
        ...(r?.broker ? { broker: r.broker } : {}),
        ...(b?.name ? { brokerName: b.name } : {}),
      },
    };
  }
  if (kind === "state") {
    return { resolves: { state: head, declared: states.has(head) } };
  }
  if (kind === "context") return { resolves: { context: `${head}${rest}` } };
  return {};
}

/** The target of one event handler (N-26, UX-03). */
function resolveHandler(
  h: UibEventHandler,
  look: {
    scripts: Map<string, SnRecord>;
    resources: Map<string, UibDataResource>;
    states: Set<string>;
    brokers: Map<string, UxDataBroker>;
    events: Map<string, SnRecord>;
  },
): UxEventTarget {
  const type = h.type ? { type: h.type } : {};
  const scriptId = [h.definitionId, h.targetId].find(
    (i) => i && look.scripts.has(i),
  );
  if (scriptId || /CLIENT_?SCRIPT/i.test(h.type ?? "")) {
    const row = scriptId ? look.scripts.get(scriptId) : undefined;
    const sysId = scriptId ?? h.definitionId;
    const name = (row && opt(row, "name")) ?? h.name;
    return {
      kind: "clientScript",
      ...(sysId ? { sys_id: sysId } : {}),
      ...(name ? { name } : {}),
      ...type,
    };
  }
  const resourceId = [h.targetId, h.definitionId].find(
    (i) => i && look.resources.has(i),
  );
  const marks = [h.type, h.definitionId, h.name, h.operation].join(" ");
  if (!resourceId && (h.property || /STATE/i.test(marks))) {
    return {
      kind: "state",
      ...(h.property
        ? { property: h.property, declared: look.states.has(h.property) }
        : {}),
      ...(h.name ? { name: h.name } : {}),
      ...type,
    };
  }
  if (
    resourceId ||
    /DATA_?BROKER|DATA_?RESOURCE|DATA_?OP/i.test(h.type ?? "")
  ) {
    const r = resourceId ? look.resources.get(resourceId) : undefined;
    const b = r?.broker ? look.brokers.get(r.broker) : undefined;
    const target = resourceId ?? h.targetId;
    return {
      kind: "brokerOperation",
      ...(target ? { dataResource: target } : {}),
      ...(h.operation ? { operation: h.operation } : {}),
      ...(r?.broker ? { broker: r.broker } : {}),
      ...(b?.name ? { brokerName: b.name } : {}),
      ...type,
    };
  }
  const ev = h.definitionId ? look.events.get(h.definitionId) : undefined;
  const name =
    (ev && (opt(ev, "name") ?? opt(ev, "label"))) ?? h.definitionId ?? h.name;
  if (name) {
    return {
      kind: "event",
      name,
      ...(ev ? { sys_id: str(ev, "sys_id") } : {}),
      ...type,
    };
  }
  return { kind: "unknown", ...type };
}

/**
 * Resolve each element's `definition.id` (N-26, UX-04): sys_ids against
 * sys_ux_lib_component and sys_ux_macroponent, tags against
 * sys_ux_lib_component.tag; an unknown `now-*` / `sn-*` tag is OOB by name.
 */
async function resolveComponents(
  ctx: ReadCtx,
  result: ExplainUiExperienceResult,
): Promise<void> {
  const used = new Map<string, Map<string, string[]>>();
  const all = new Set<string>();
  for (const m of result.macroponents) {
    const byId = new Map<string, string[]>();
    for (const el of allElements(m.composition.value?.elements ?? [])) {
      if (!el.component) continue;
      const list = byId.get(el.component) ?? [];
      list.push(el.elementId);
      byId.set(el.component, list);
      all.add(el.component);
    }
    used.set(m.sys_id, byId);
  }
  if (!all.size) return;
  const sysIds = [...all].filter((i) => isSysId(i));
  const tags = [...all].filter((i) => !isSysId(i));
  const libFields = ["sys_id", "name", "tag", "category"];
  const libRows = [
    ...(await boundedReadIn(
      ctx,
      "sys_ux_lib_component",
      "sys_id",
      sysIds,
      libFields,
    )),
    ...(await boundedReadIn(
      ctx,
      "sys_ux_lib_component",
      "tag",
      tags,
      libFields,
    )),
  ];
  const lib = new Map<string, SnRecord>();
  for (const r of libRows) {
    lib.set(str(r, "sys_id"), r);
    if (opt(r, "tag")) lib.set(str(r, "tag"), r);
  }
  const known = new Map<string, SnRecord>();
  const loaded = result.macroponents.map((m) => m.sys_id);
  const toRead = sysIds.filter((i) => !lib.has(i));
  for (const r of await boundedReadIn(
    ctx,
    "sys_ux_macroponent",
    "sys_id",
    toRead.filter((i) => !loaded.includes(i)),
    ["sys_id", "name", "category"],
  )) {
    known.set(str(r, "sys_id"), r);
  }
  for (const m of result.macroponents) {
    if (toRead.includes(m.sys_id)) {
      known.set(m.sys_id, {
        sys_id: m.sys_id,
        ...(m.name ? { name: m.name } : {}),
        ...(m.category ? { category: m.category } : {}),
      });
    }
  }
  for (const m of result.macroponents) {
    const comps: UxComponent[] = [];
    for (const [id, elements] of used.get(m.sys_id) ?? []) {
      const l = lib.get(id);
      const mp = known.get(id);
      if (l) {
        const tag = opt(l, "tag") ?? (isSysId(id) ? undefined : id);
        comps.push({
          id,
          kind: tag && OOB_TAG.test(tag) ? "oob" : "custom",
          sys_id: str(l, "sys_id"),
          ...(opt(l, "name") ? { name: opt(l, "name") } : {}),
          ...(tag ? { tag } : {}),
          ...(opt(l, "category") ? { category: opt(l, "category") } : {}),
          table: "sys_ux_lib_component",
          artifactType: "uib_component",
          elements,
        });
      } else if (mp) {
        comps.push({
          id,
          kind: "macroponent",
          sys_id: id,
          ...(opt(mp, "name") ? { name: opt(mp, "name") } : {}),
          ...(opt(mp, "category") ? { category: opt(mp, "category") } : {}),
          table: "sys_ux_macroponent",
          artifactType: "uib_macroponent",
          elements,
        });
      } else if (OOB_TAG.test(id)) {
        comps.push({ id, kind: "oob", tag: id, elements });
      } else {
        comps.push({ id, kind: "unresolved", elements });
      }
    }
    if (comps.length) m.components = comps;
  }
}

/** The root table could not be read: a degraded result, not a failure. */
async function degrade(
  result: ExplainUiExperienceResult,
  why: Unreadable,
  table: string,
): Promise<ExplainUiExperienceResult> {
  result.degraded = why;
  result.unreadable.push(why);
  result.caveats.push(
    `${table} could not be read (${why.status}): ${why.reason}`,
  );
  const available = await tableAvailable(table);
  if (available !== undefined) result.available = available;
  return result;
}
