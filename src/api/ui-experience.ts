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
 *       (sys_ux_data_broker_transform / _scriptlet) → their `ux_data_broker`
 *       ACLs
 *
 * and, for workspaces (P-15), the experience's page properties, the
 * dashboards and list menus they reference (`par_dashboard` → tabs →
 * widgets; `sys_ux_list_menu_config` → categories → lists), the audience
 * (`sys_ux_applicability`, with roles) of screens and lists, and the form
 * action layouts of the experience's application scope.
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
 * The tool reaches the full depth through `format: "file"` (the JSON lands in
 * exports/, not in the context); a dedicated `detail` input waits for the
 * tools/list budget (O-10). Prop, binding and handler shapes are
 * verified:false until O-5.
 */
import { decodeField } from "../core/artifacts/decoders.js";
import {
  compositionTree,
  dataResources,
  eventMappings,
  eventWiring,
  stateProperties,
  type CompositionTree,
  type UibBindingKind,
  type UibDataResource,
  type UibElement,
  type UibEventHandler,
  type UibEventWiring,
  type UibProp,
  type UibStateProperty,
} from "../core/artifacts/uib-composition.js";
import { ServiceNowError } from "../core/errors.js";
import { trackProgress, type ProgressTracker } from "../core/progress.js";
import { CHILD_LIMIT, tableAvailable } from "./artifacts.js";
import { MermaidDoc, ident, label } from "./mermaid.js";
import { snString } from "./shared.js";
import { keyQuery, queryTable, type SnRecord } from "./table.js";

/** Ids per `fieldIN…` query (keeps the URL short). */
const IN_CHUNK = 100;

/** Statuses an unverified UIB table degrades on instead of failing. */
const DEGRADE_STATUSES = new Set([400, 403, 404]);

const SYS_ID = /^[0-9a-f]{32}$/;

/** A record id safe to splice into an encoded query. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Characters of an undecodable JSON column echoed back raw. */
const RAW_MAX = 2000;

const UNVERIFIED_CAVEAT =
  "UI Builder and Next Experience tables are verified:false: their table and field names, and the JSON shapes of macroponent columns, come from the SDK inventory and have not been confirmed on a live instance (gate O-5).";

const LINK_CAVEAT =
  "Dashboards and list menus are found through sys_id values in the experience's page properties, and form action layouts through the experience's application scope; both links are unverified (gate O-5).";

/** N-26 depth levels of {@link explainUiExperience}. */
export const UI_EXPERIENCE_DETAILS = [
  "elements",
  "bindings",
  "events",
  "scripts",
] as const;
export type UiExperienceDetail = (typeof UI_EXPERIENCE_DETAILS)[number];

/** Characters of one script body kept with `detail: "scripts"`. */
export const UI_SCRIPT_MAX = 100_000;

const DETAIL_CAVEAT =
  "Element props, binding expressions, event handler targets and component resolution read UI Builder JSON shapes (propertyValues, typed bindings, handler definition / targetId / operationName) that have not been confirmed on a live instance (gate O-5).";

export interface ExplainUiExperienceOptions {
  /** sys_ux_page_registry sys_id. */
  sys_id?: string;
  /** sys_ux_page_registry path (e.g. 'now/sow'). */
  path?: string;
  /** N-26: opt-in depth (one level or several); none by default. */
  detail?: UiExperienceDetail | readonly UiExperienceDetail[];
}

export interface Unreadable {
  table: string;
  status?: number;
  reason: string;
}

/** A decoded JSON column: its reading, or the raw value when it did not. */
export interface DecodedColumn<T> {
  decoded: boolean;
  value?: T;
  reason?: string;
  raw?: string;
}

export interface UxApplicability {
  sys_id: string;
  name?: string;
  roles: string[];
  active?: string;
}

export interface UxScreen {
  sys_id: string;
  name?: string;
  order: number;
  macroponent?: string;
  applicability?: string;
  active?: string;
}

export interface UxRoute {
  sys_id: string;
  name?: string;
  route_type?: string;
  screen_type?: string;
  parent_macroponent?: string;
  order: number;
  /** Screen variants of the route's screen type, in evaluation order. */
  screens: UxScreen[];
}

/** A script body (N-26, `detail: "scripts"`). */
export interface UxScriptBody {
  script?: string;
  /** Characters cut past UI_SCRIPT_MAX. */
  scriptTruncated?: number;
}

/**
 * N-26 (UX-04): what an element's `definition.id` renders. `oob` is a
 * `now-*` / `sn-*` component (by its tag, with or without a
 * sys_ux_lib_component row), `custom` any other sys_ux_lib_component,
 * `macroponent` a nested sys_ux_macroponent. `artifactType` is the registry
 * type to pass to get_artifact / explain_artifact.
 */
export interface UxComponent {
  id: string;
  kind: "oob" | "custom" | "macroponent" | "unresolved";
  sys_id?: string;
  name?: string;
  tag?: string;
  category?: string;
  table?: string;
  artifactType?: "uib_component" | "uib_macroponent";
  /** Elements of this macroponent that render it. */
  elements: string[];
}

/** N-26 (UX-02): one binding expression and what it resolves to. */
export interface UxBinding {
  elementId: string;
  prop: string;
  source: UibProp["source"];
  kind: UibBindingKind;
  expression: string;
  resolves?: {
    /** `@data.<dataResource>.…` */
    dataResource?: string;
    broker?: string;
    brokerName?: string;
    /** `@state.<state>` */
    state?: string;
    /** Whether the state property is declared on the macroponent. */
    declared?: boolean;
    /** `@context.<path>`: page context, resolved at run time. */
    context?: string;
  };
}

/** N-26 (UX-03): what one handler does. */
export interface UxEventTarget {
  kind: "clientScript" | "brokerOperation" | "state" | "event" | "unknown";
  name?: string;
  sys_id?: string;
  /** The handler's own `type`, as read. */
  type?: string;
  dataResource?: string;
  operation?: string;
  broker?: string;
  brokerName?: string;
  property?: string;
  declared?: boolean;
}

/** N-26 (UX-03): source element → event → handler targets. */
export interface UxEventChain {
  source: string;
  /** The composition element the source names, when found. */
  element?: string;
  component?: string;
  event?: string;
  targets: UxEventTarget[];
}

export interface UxMacroponent {
  sys_id: string;
  name?: string;
  category?: string;
  composition: DecodedColumn<CompositionTree>;
  data: DecodedColumn<UibDataResource[]>;
  state: DecodedColumn<UibStateProperty[]>;
  events: DecodedColumn<UibEventWiring[]>;
  clientScripts: ({
    sys_id: string;
    name?: string;
    type?: string;
  } & UxScriptBody)[];
  /** N-26 `elements`: components rendered by this macroponent. */
  components?: UxComponent[];
  /** N-26 `bindings`. */
  bindings?: UxBinding[];
  /** N-26 `events`. */
  eventChains?: UxEventChain[];
}

export interface UxDataBroker extends UxScriptBody {
  sys_id: string;
  table: string;
  name?: string;
  mutates_server_data?: string;
  acls: {
    sys_id: string;
    name?: string;
    operation?: string;
    active?: string;
  }[];
}

export interface UxDashboard {
  sys_id: string;
  name?: string;
  active?: string;
  tabs: {
    sys_id: string;
    name?: string;
    order: number;
    widgets: { sys_id: string; name?: string; component?: string }[];
  }[];
}

export interface UxListMenu {
  sys_id: string;
  name?: string;
  active?: string;
  categories: {
    sys_id: string;
    title?: string;
    order: number;
    lists: {
      sys_id: string;
      title?: string;
      table?: string;
      condition?: string;
      order: number;
      applicability: string[];
    }[];
  }[];
}

export interface UxFormActionLayout {
  sys_id: string;
  name?: string;
  table?: string;
  items: {
    sys_id: string;
    order: number;
    form_action?: string;
    label?: string;
    action?: string;
    applicability?: string;
  }[];
}

export interface UxProperty {
  sys_id: string;
  name: string;
  type?: string;
  value?: unknown;
}

export interface UxCounts {
  routes: number;
  screens: number;
  macroponents: number;
  elements: number;
  dataResources: number;
  clientScripts: number;
  dataBrokers: number;
  acls: number;
  applicabilities: number;
  dashboards: number;
  listMenus: number;
  lists: number;
  formActionLayouts: number;
}

export interface ExplainUiExperienceResult {
  experience: {
    sys_id: string;
    title?: string;
    path?: string;
    root_macroponent?: string;
    admin_panel?: string;
    sys_scope?: string;
    active?: string;
  } | null;
  appConfig: { sys_id: string; name?: string; landing_path?: string } | null;
  properties: UxProperty[];
  routes: UxRoute[];
  macroponents: UxMacroponent[];
  dataBrokers: UxDataBroker[];
  /** Broker ids referenced by data resources but found in no broker table. */
  unresolvedBrokers: string[];
  applicabilities: UxApplicability[];
  dashboards: UxDashboard[];
  listMenus: UxListMenu[];
  formActionLayouts: UxFormActionLayout[];
  counts: UxCounts;
  /** N-26: the depth read, with its counts (only when `detail` is set). */
  detail?: {
    levels: UiExperienceDetail[];
    components: number;
    unresolvedComponents: number;
    bindings: number;
    eventChains: number;
    scripts: number;
  };
  verified: false;
  caveats: string[];
  unreadable: Unreadable[];
  missingFields?: Record<string, string[]>;
  /** Set when the root table itself could not be read. */
  degraded?: Unreadable;
  available?: boolean;
}

interface Ctx {
  caveats: string[];
  unreadable: Unreadable[];
  missing: Record<string, string[]>;
  progress: ProgressTracker;
}

function degradeStatus(error: unknown): number | undefined {
  if (!(error instanceof ServiceNowError)) return undefined;
  return error.status !== undefined && DEGRADE_STATUSES.has(error.status)
    ? error.status
    : undefined;
}

function noteMissing(
  ctx: Ctx,
  table: string,
  fields: string[],
  rows: SnRecord[],
): void {
  if (!rows.length) return;
  const missing = fields.filter((f) => rows.every((r) => !(f in r)));
  if (!missing.length) return;
  const seen = new Set(ctx.missing[table] ?? []);
  for (const f of missing) seen.add(f);
  ctx.missing[table] = [...seen];
}

/**
 * One bounded read. A degradable instance error (400 / 403 / 404, which
 * includes a policy denial) is recorded as a caveat and yields no rows.
 */
async function read(
  ctx: Ctx,
  table: string,
  query: string,
  fields: string[],
): Promise<SnRecord[]> {
  ctx.progress.tick(table);
  if (ctx.unreadable.some((u) => u.table === table)) return [];
  try {
    const { records, total } = await queryTable({
      table,
      query,
      fields,
      limit: CHILD_LIMIT,
      displayValue: "false",
    });
    if (
      records.length >= CHILD_LIMIT &&
      (total === undefined || total > records.length)
    ) {
      ctx.caveats.push(
        `${table}: read capped at ${CHILD_LIMIT} rows; the page map may be incomplete.`,
      );
    }
    noteMissing(ctx, table, fields, records);
    return records;
  } catch (error) {
    const status = degradeStatus(error);
    if (status === undefined) throw error;
    const reason = (error as Error).message;
    ctx.unreadable.push({ table, status, reason });
    ctx.caveats.push(
      `${table} could not be read (${status}): ${reason} That part of the page map is omitted.`,
    );
    return [];
  }
}

/**
 * `prefix^fieldIN ids` over chunks of `IN_CHUNK`, capped at `CHILD_LIMIT`
 * rows. Ids that are not SAFE_ID (a malformed reference) are dropped.
 */
async function readIn(
  ctx: Ctx,
  table: string,
  field: string,
  ids: Iterable<string>,
  fields: string[],
  opts: { order?: string; prefix?: string } = {},
): Promise<SnRecord[]> {
  const list = [...new Set(ids)].filter((id) => SAFE_ID.test(id));
  const out: SnRecord[] = [];
  for (let i = 0; i < list.length; i += IN_CHUNK) {
    const chunk = list.slice(i, i + IN_CHUNK);
    const query = `${opts.prefix ? `${opts.prefix}^` : ""}${field}IN${chunk.join(",")}${
      opts.order ? `^ORDERBY${opts.order}` : ""
    }`;
    out.push(...(await read(ctx, table, query, fields)));
    if (out.length >= CHILD_LIMIT) {
      if (i + IN_CHUNK < list.length) {
        ctx.caveats.push(
          `${table}: stopped after ${out.length} rows; the page map may be incomplete.`,
        );
      }
      break;
    }
  }
  return out;
}

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
  ctx: Ctx,
  value: string,
): Promise<{ row: SnRecord } | { unreadable: Unreadable }> {
  const table = "sys_ux_page_registry";
  const text = value.trim();
  const bySysId = SYS_ID.test(text);
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
  if (hasId && !SYS_ID.test(opts.sys_id!.trim())) {
    throw new ServiceNowError(
      "'sys_id' must be a 32-character sys_id; pass a path as 'path'.",
      400,
    );
  }
  const levels = detailLevels(opts.detail);
  const want = (l: UiExperienceDetail): boolean => levels.includes(l);
  const withProps = want("elements") || want("bindings");
  const ctx: Ctx = {
    caveats: [UNVERIFIED_CAVEAT],
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
  const propRows = await readIn(
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
    const cfg = await readIn(
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
    ? await readIn(
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
  const screenRows = await readIn(
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
  const macroRows = await readIn(
    ctx,
    "sys_ux_macroponent",
    "sys_id",
    macroIds,
    MACROPONENT_FIELDS,
  );
  const scriptRows = await readIn(
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
      if (d.broker && SYS_ID.test(d.broker)) brokerIds.add(d.broker);
    }
  }
  for (const table of [
    "sys_ux_data_broker_transform",
    "sys_ux_data_broker_scriptlet",
  ]) {
    const fields = [
      "sys_id",
      "name",
      ...(table === "sys_ux_data_broker_transform"
        ? ["mutates_server_data"]
        : []),
      ...(want("scripts") ? ["script"] : []),
    ];
    const rows = await readIn(ctx, table, "sys_id", brokerIds, fields);
    for (const b of rows) {
      result.dataBrokers.push({
        sys_id: str(b, "sys_id"),
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
      `${result.unresolvedBrokers.length} data resource broker(s) are not transform or scriptlet brokers (built-in, REST or GraphQL brokers are not read) or could not be found.`,
    );
  }
  if (found.size) {
    const aclRows = await readIn(
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

  // P-15: dashboards and list menus referenced by the page properties.
  if (referenced.size) {
    const dashRows = await readIn(ctx, "par_dashboard", "sys_id", referenced, [
      "sys_id",
      "name",
      "active",
    ]);
    const tabRows = await readIn(
      ctx,
      "par_dashboard_tab",
      "dashboard",
      ids(dashRows),
      ["sys_id", "dashboard", "name", "order"],
      { order: "order" },
    );
    const widgetRows = await readIn(
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

    const menuRows = await readIn(
      ctx,
      "sys_ux_list_menu_config",
      "sys_id",
      referenced,
      ["sys_id", "name", "active"],
    );
    const catRows = await readIn(
      ctx,
      "sys_ux_list_category",
      "configuration",
      ids(menuRows),
      ["sys_id", "configuration", "title", "order"],
      { order: "order" },
    );
    const listRows = await readIn(
      ctx,
      "sys_ux_list",
      "category",
      ids(catRows),
      ["sys_id", "category", "title", "table", "condition", "order"],
      { order: "order" },
    );
    const m2mRows = await readIn(
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
    const layoutRows = await read(
      ctx,
      "sys_ux_form_action_layout",
      `sys_scope=${scope}^ORDERBYname`,
      ["sys_id", "name", "table"],
    );
    formItems.push(
      ...(await readIn(
        ctx,
        "sys_ux_form_action_layout_item",
        "form_action_layout",
        ids(layoutRows),
        ["sys_id", "form_action_layout", "form_action", "order"],
        { order: "order" },
      )),
    );
    for (const a of await readIn(
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
  for (const a of await readIn(
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
  if (levels.length) {
    await readDetail(ctx, result, levels, macroRows, scriptRows);
  }
  if (Object.keys(ctx.missing).length) result.missingFields = ctx.missing;
  return result;
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
  ctx: Ctx,
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
            SYS_ID.test(h.definitionId) &&
            !scripts.has(h.definitionId)
          ) {
            eventIds.add(h.definitionId);
          }
        }
      }
    }
    const events = new Map(
      (
        await readIn(ctx, "sys_ux_event", "sys_id", eventIds, [
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
  ctx: Ctx,
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
  const sysIds = [...all].filter((i) => SYS_ID.test(i));
  const tags = [...all].filter((i) => !SYS_ID.test(i));
  const libFields = ["sys_id", "name", "tag", "category"];
  const libRows = [
    ...(await readIn(ctx, "sys_ux_lib_component", "sys_id", sysIds, libFields)),
    ...(await readIn(ctx, "sys_ux_lib_component", "tag", tags, libFields)),
  ];
  const lib = new Map<string, SnRecord>();
  for (const r of libRows) {
    lib.set(str(r, "sys_id"), r);
    if (opt(r, "tag")) lib.set(str(r, "tag"), r);
  }
  const known = new Map<string, SnRecord>();
  const loaded = result.macroponents.map((m) => m.sys_id);
  const toRead = sysIds.filter((i) => !lib.has(i));
  for (const r of await readIn(
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
        const tag = opt(l, "tag") ?? (SYS_ID.test(id) ? undefined : id);
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

const macroName = (
  result: ExplainUiExperienceResult,
  id: string | undefined,
): string => {
  if (!id) return "no macroponent";
  const m = result.macroponents.find((x) => x.sys_id === id);
  return m?.name ?? id;
};

const audience = (
  result: ExplainUiExperienceResult,
  id: string | undefined,
): string | undefined => {
  if (!id) return undefined;
  const a = result.applicabilities.find((x) => x.sys_id === id);
  if (!a) return id;
  return `${a.name ?? a.sys_id}${a.roles.length ? ` [${a.roles.join(", ")}]` : ""}`;
};

/**
 * The page map as a Mermaid flowchart (experience → routes → screen variants
 * → macroponents → data brokers, plus dashboards and list menus), capped by
 * SN_DIAGRAM_MAX_NODES; `truncated` counts the dropped nodes.
 */
export function uiExperienceMermaid(result: ExplainUiExperienceResult): {
  mermaid: string;
  truncated: number;
} {
  const doc = new MermaidDoc("flowchart TD");
  const e = result.experience;
  const root = "exp";
  doc.node(
    root,
    label(
      `Experience: ${e ? (e.title ?? e.sys_id) : "(unreadable)"}${e?.path ? ` /${e.path}` : ""}`,
    ),
    "rect",
    { pinned: true },
  );
  const macroNode = (from: string, id: string | undefined): void => {
    if (!id) return;
    const mid = `m_${ident(id)}`;
    doc.edgeTo(from, mid, label(`Macroponent: ${macroName(result, id)}`, 80), {
      arrow: "-.->",
    });
    const m = result.macroponents.find((x) => x.sys_id === id);
    for (const d of m?.data.value ?? []) {
      if (!d.broker) continue;
      const broker = result.dataBrokers.find((b) => b.sys_id === d.broker);
      doc.edgeTo(
        mid,
        `b_${ident(d.broker)}`,
        label(`Data: ${broker?.name ?? d.label ?? d.elementId}`, 80),
        { shape: "db" },
      );
    }
  };
  macroNode(root, e?.root_macroponent);
  let cfg = root;
  if (result.appConfig) {
    cfg = "cfg";
    doc.edgeTo(
      root,
      cfg,
      label(`App config: ${result.appConfig.name ?? result.appConfig.sys_id}`),
    );
  }
  for (const r of result.routes) {
    const rid = `r_${ident(r.sys_id)}`;
    doc.edgeTo(cfg, rid, label(`Route: ${r.name ?? r.sys_id}`, 80));
    if (!r.screens.length) {
      doc.edgeTo(rid, `none_${ident(r.sys_id)}`, "no screen", {
        arrow: "-.->",
      });
    }
    for (const s of r.screens) {
      const sid = `s_${ident(s.sys_id)}`;
      const who = audience(result, s.applicability);
      doc.edgeTo(
        rid,
        sid,
        label(
          `Variant ${s.order}: ${s.name ?? s.sys_id}${who ? ` · ${who}` : ""}`,
          100,
        ),
        { shape: "input" },
      );
      macroNode(sid, s.macroponent);
    }
  }
  for (const d of result.dashboards) {
    doc.edgeTo(
      root,
      `d_${ident(d.sys_id)}`,
      label(`Dashboard: ${d.name ?? d.sys_id} (${d.tabs.length} tab(s))`, 80),
      { arrow: "-.->" },
    );
  }
  for (const m of result.listMenus) {
    const lists = m.categories.reduce((n, c) => n + c.lists.length, 0);
    doc.edgeTo(
      root,
      `lm_${ident(m.sys_id)}`,
      label(`List menu: ${m.name ?? m.sys_id} (${lists} list(s))`, 80),
      { arrow: "-.->" },
    );
  }
  return { mermaid: doc.render(), truncated: doc.truncated };
}

function elementLines(
  elements: UibElement[],
  indent: string,
  out: string[],
): void {
  for (const el of elements) {
    out.push(
      `${indent}- ${el.label ? `${el.label} ` : ""}\`${el.elementId}\`${
        el.component ? ` → ${el.component}` : ""
      }${el.type ? ` (${el.type})` : ""}${el.hidden ? " _(hidden)_" : ""}`,
    );
    for (const slot of el.slots) {
      out.push(`${indent}  - slot ${slot.name}`);
      elementLines(slot.elements, `${indent}    `, out);
    }
  }
}

const targetText = (t: UxEventTarget): string => {
  switch (t.kind) {
    case "clientScript":
      return `client script ${t.name ?? t.sys_id ?? "?"}`;
    case "brokerOperation":
      return `${t.operation ?? "operation"} on ${t.dataResource ?? "?"}${
        t.brokerName ? ` (${t.brokerName})` : ""
      }`;
    case "state":
      return `set state ${t.property ?? t.name ?? "?"}${
        t.declared === false ? " _(undeclared)_" : ""
      }`;
    case "event":
      return `event ${t.name ?? "?"}`;
    default:
      return `?${t.type ? ` (${t.type})` : ""}`;
  }
};

/** N-26 sections of one macroponent; nothing when no detail was read. */
function detailLines(m: UxMacroponent, out: string[]): void {
  if (m.components?.length) {
    out.push("", "Components:");
    for (const c of m.components) {
      out.push(
        `- \`${c.id}\` → ${c.kind}${c.name ? ` ${c.name}` : ""}${
          c.artifactType ? ` [${c.artifactType}]` : ""
        } · ${c.elements.join(", ")}`,
      );
    }
  }
  if (m.bindings?.length) {
    out.push("", "Bindings:");
    for (const b of m.bindings) {
      const r = b.resolves;
      const to = r?.dataResource
        ? ` → ${r.brokerName ?? r.broker ?? r.dataResource}`
        : r?.state
          ? r.declared
            ? " → client state"
            : " → _undeclared state_"
          : r?.context
            ? " → page context"
            : "";
      out.push(`- \`${b.elementId}\`.${b.prop} = ${b.expression}${to}`);
    }
  }
  if (m.eventChains?.length) {
    out.push("", "Event chains:");
    for (const c of m.eventChains) {
      out.push(
        `- ${c.element ?? c.source}${c.event ? ` · ${c.event}` : ""} → ${
          c.targets.map(targetText).join("; ") || "?"
        }`,
      );
    }
  }
}

/**
 * N-26: the event flow of every macroponent as a Mermaid flowchart (source
 * element → event → handler target), capped by SN_DIAGRAM_MAX_NODES; empty
 * when no event chain was read.
 */
export function uiExperienceEventMermaid(result: ExplainUiExperienceResult): {
  mermaid: string;
  truncated: number;
} {
  const doc = new MermaidDoc("flowchart LR");
  const seen = new Set<string>();
  const declare = (id: string, text: string, shape?: "db" | "input"): void => {
    if (seen.has(id)) return;
    seen.add(id);
    doc.node(id, label(text, 80), shape);
  };
  let chains = 0;
  for (const m of result.macroponents) {
    const mid = ident(m.sys_id);
    for (const [i, c] of (m.eventChains ?? []).entries()) {
      chains += 1;
      const src = `src_${mid}_${ident(c.element ?? c.source)}`;
      declare(
        src,
        `${m.name ?? m.sys_id}: ${c.element ?? c.source}${c.component ? ` (${c.component})` : ""}`,
      );
      const ev = `ev_${mid}_${i}`;
      declare(ev, c.event ?? "event", "input");
      doc.edge(src, ev);
      for (const t of c.targets) {
        const tid =
          t.kind === "clientScript"
            ? `cs_${ident(t.sys_id ?? t.name ?? "x")}`
            : t.kind === "brokerOperation"
              ? `b_${ident(t.broker ?? `${mid}_${t.dataResource ?? "x"}`)}`
              : t.kind === "state"
                ? `st_${mid}_${ident(t.property ?? t.name ?? "x")}`
                : `t_${ident(t.name ?? t.type ?? "unknown")}`;
        declare(
          tid,
          t.kind === "brokerOperation"
            ? `Data: ${t.brokerName ?? t.dataResource ?? "?"}`
            : targetText(t).replace(/ _\(undeclared\)_/, " (undeclared)"),
          t.kind === "brokerOperation" ? "db" : undefined,
        );
        doc.edge(ev, tid);
      }
    }
  }
  return chains
    ? { mermaid: doc.render(), truncated: doc.truncated }
    : { mermaid: "", truncated: 0 };
}

const fmt = (v: unknown): string => {
  const text = typeof v === "string" ? v : JSON.stringify(v);
  const one = (text ?? "").replace(/[\r\n]+/g, " ");
  return one.length > 120 ? `${one.slice(0, 117)}...` : one;
};

/** A readable Markdown report of the page map (the diagram included). */
export function uiExperienceMarkdown(
  result: ExplainUiExperienceResult,
  mermaid: string,
): string {
  const out: string[] = [];
  const e = result.experience;
  out.push(
    `# Experience ${e ? (e.title ?? e.sys_id) : "(unreadable)"}${e?.path ? ` (/${e.path})` : ""}`,
    "",
  );
  const c = result.counts;
  out.push(
    `${c.routes} route(s), ${c.screens} screen variant(s), ${c.macroponents} macroponent(s), ${c.elements} element(s), ${c.dataResources} data resource(s), ${c.dataBrokers} data broker(s), ${c.acls} broker ACL(s), ${c.dashboards} dashboard(s), ${c.lists} list(s), ${c.formActionLayouts} form action layout(s). verified:false.`,
  );
  if (result.appConfig) {
    const a = result.appConfig;
    out.push(
      "",
      `App config: **${a.name ?? a.sys_id}**${a.landing_path ? ` (landing ${a.landing_path})` : ""}`,
    );
  }
  if (result.properties.length) {
    out.push("", "## Page properties", "");
    for (const p of result.properties) {
      out.push(
        `- ${p.name}${p.value !== undefined ? ` = ${fmt(p.value)}` : ""}`,
      );
    }
  }
  out.push("", "## Routes", "");
  if (!result.routes.length) out.push("_No routes read._");
  for (const r of result.routes) {
    out.push(
      `- **${r.name ?? r.sys_id}**${r.route_type ? ` (${r.route_type})` : ""}${
        r.screens.length ? "" : " _(no screen)_"
      }`,
    );
    for (const s of r.screens) {
      const who = audience(result, s.applicability);
      out.push(
        `  - Variant ${s.order}: ${s.name ?? s.sys_id} → ${macroName(result, s.macroponent)}${
          who ? ` · audience ${who}` : " · no applicability"
        }${s.active === "false" ? " _(inactive)_" : ""}`,
      );
    }
  }
  if (result.macroponents.length) {
    out.push("", "## Macroponents", "");
    for (const m of result.macroponents) {
      out.push(
        `### ${m.name ?? m.sys_id}${m.category ? ` (${m.category})` : ""}`,
        "",
      );
      if (m.composition.decoded) {
        const tree = m.composition.value!;
        out.push(`Component tree (${tree.count} element(s)):`);
        elementLines(tree.elements, "", out);
        if (tree.omitted) out.push(`- _${tree.omitted} element(s) omitted_`);
      } else {
        out.push(
          `_composition did not decode: ${m.composition.reason}_ (returned raw)`,
        );
      }
      const data = m.data.value ?? [];
      if (data.length) {
        out.push("", "Data resources:");
        for (const d of data) {
          const b = result.dataBrokers.find((x) => x.sys_id === d.broker);
          out.push(
            `- \`${d.elementId}\`${d.type ? ` (${d.type})` : ""} → ${b?.name ?? d.broker ?? "?"}`,
          );
        }
      } else if (!m.data.decoded) {
        out.push("", `_data did not decode: ${m.data.reason}_`);
      }
      if (m.state.value?.length) {
        out.push(
          "",
          `Client state: ${m.state.value
            .map((s) => `${s.name}${s.type ? ` (${s.type})` : ""}`)
            .join(", ")}`,
        );
      } else if (!m.state.decoded) {
        out.push("", `_state_properties did not decode: ${m.state.reason}_`);
      }
      if (m.events.value?.length) {
        out.push("", "Event wiring:");
        for (const w of m.events.value) {
          out.push(
            `- ${w.source}${w.event ? ` · ${w.event}` : ""} → ${w.handlers.join(", ") || "?"}`,
          );
        }
      } else if (!m.events.decoded) {
        out.push(
          "",
          `_internal_event_mappings did not decode: ${m.events.reason}_`,
        );
      }
      if (m.clientScripts.length) {
        out.push(
          "",
          `Client scripts: ${m.clientScripts
            .map((s) => `${s.name ?? s.sys_id}${s.type ? ` (${s.type})` : ""}`)
            .join(", ")}`,
        );
      }
      detailLines(m, out);
      out.push("");
    }
  }
  if (result.dataBrokers.length || result.unresolvedBrokers.length) {
    out.push("## Data brokers", "");
    for (const b of result.dataBrokers) {
      out.push(
        `- **${b.name ?? b.sys_id}** (${b.table})${
          b.mutates_server_data === "true" ? " · mutates server data" : ""
        } · ${b.acls.length ? `ACLs: ${b.acls.map((a) => a.operation ?? a.sys_id).join(", ")}` : "no ux_data_broker ACL"}`,
      );
    }
    for (const id of result.unresolvedBrokers) {
      out.push(`- ${id} _(not a transform / scriptlet broker, or not found)_`);
    }
    out.push("");
  }
  if (result.dashboards.length) {
    out.push("## Dashboards", "");
    for (const d of result.dashboards) {
      out.push(`- **${d.name ?? d.sys_id}**`);
      for (const t of d.tabs) {
        out.push(
          `  - Tab ${t.name ?? t.sys_id}: ${t.widgets.length} widget(s)${
            t.widgets.length
              ? ` (${t.widgets.map((w) => w.name ?? w.component ?? w.sys_id).join(", ")})`
              : ""
          }`,
        );
      }
    }
    out.push("");
  }
  if (result.listMenus.length) {
    out.push("## Lists", "");
    for (const m of result.listMenus) {
      out.push(`- **${m.name ?? m.sys_id}**`);
      for (const cat of m.categories) {
        out.push(`  - ${cat.title ?? cat.sys_id}`);
        for (const l of cat.lists) {
          const who = l.applicability
            .map((a) => audience(result, a))
            .filter(Boolean);
          out.push(
            `    - ${l.title ?? l.sys_id}${l.table ? ` (${l.table})` : ""}${
              who.length ? ` · audience ${who.join("; ")}` : ""
            }`,
          );
        }
      }
    }
    out.push("");
  }
  if (result.formActionLayouts.length) {
    out.push("## Form action layouts", "");
    for (const l of result.formActionLayouts) {
      out.push(`- **${l.name ?? l.sys_id}**${l.table ? ` (${l.table})` : ""}`);
      for (const i of l.items) {
        out.push(`  - ${i.order}: ${i.label ?? i.form_action ?? i.sys_id}`);
      }
    }
    out.push("");
  }
  out.push("## Page map", "", "```mermaid", mermaid, "```", "");
  out.push("## Caveats", "");
  for (const cav of result.caveats) out.push(`- ${cav}`);
  if (result.missingFields) {
    for (const [table, fields] of Object.entries(result.missingFields)) {
      out.push(`- ${table}: fields not returned: ${fields.join(", ")}`);
    }
  }
  return out.join("\n");
}
