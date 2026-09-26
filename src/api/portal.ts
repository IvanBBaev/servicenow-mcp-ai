/**
 * P-16 — `explain_portal` (project/SDK-PARITY.md §4 P-16, §5(d) tier X).
 *
 * Reads a Service Portal (or one portal page) as a tree:
 *
 *   sp_portal → pages → sp_container → sp_row → sp_column → sp_instance
 *             → sp_widget → dependencies (sp_dependency + its JS / CSS
 *               includes, Angular providers, ng-templates)
 *
 * plus the portal's theme (header / footer, theme includes), its menu and the
 * page route maps (`sp_page_route_map`). Every instance's `widget_parameters`
 * goes through the registry decoders and its values are mapped against the
 * widget's `option_schema` names.
 *
 * Bounds: at most `CHILD_LIMIT` rows per read, IN lists chunked, full layout
 * for `LAYOUT_PAGES` pages, nested rows (a row inside a column) followed to
 * `depth` levels. Every SP table is `verified:false` in the registry (gate
 * O-5), so an unreadable table (policy denial, ACL, missing plugin) becomes a
 * caveat with the table name and status — never a failure — and fields the
 * instance did not return are listed per table in `missingFields`.
 *
 * All reads are metadata only: no widget scripts, templates or CSS bodies.
 */
import { decodeField } from "../core/artifacts/decoders.js";
import { ServiceNowError } from "../core/errors.js";
import { trackProgress, type ProgressTracker } from "../core/progress.js";
import { CHILD_LIMIT, tableAvailable } from "./artifacts.js";
import { MermaidDoc, ident, label } from "./mermaid.js";
import { snString } from "./shared.js";
import { keyQuery, queryTable, type SnRecord } from "./table.js";

/** Default and maximum nested-row depth (a row inside a column). */
export const PORTAL_DEPTH = { default: 3, max: 6 } as const;

/** Pages whose full layout is read; the others are listed with a summary. */
export const LAYOUT_PAGES = 5;

/** Ids per `fieldIN…` query (keeps the URL short). */
const IN_CHUNK = 100;

/** Statuses an unverified SP table degrades on instead of failing. */
const DEGRADE_STATUSES = new Set([400, 403, 404]);

const SYS_ID = /^[0-9a-f]{32}$/;

/**
 * A record id safe to splice into an encoded query (no `^`, `,` or spaces).
 * Ids read back from the instance are checked too, so a malformed reference
 * can never widen a query.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const UNVERIFIED_CAVEAT =
  "Service Portal tables are verified:false: their table and field names come from the SDK inventory and have not been confirmed on a live instance (gate O-5).";

const OPTIONS_CAVEAT =
  "Widget options are read from widget_parameters only; some classic options (title, glyph, color, size) may live in sp_instance columns instead.";

export interface ExplainPortalOptions {
  /** Portal url_suffix or sys_id. */
  portal?: string;
  /** Page id or sys_id (explains that page only). */
  page?: string;
  /** Nested-row depth. */
  depth?: number;
}

export interface Unreadable {
  table: string;
  status?: number;
  reason: string;
}

export interface Ref {
  sys_id: string;
  name?: string;
}

export interface InstanceOption {
  name: string;
  label?: string;
  type?: string;
  set: boolean;
  value?: unknown;
  default?: unknown;
}

export interface PortalInstance {
  sys_id: string;
  order: number;
  title?: string;
  widget: Ref | null;
  /** Whether `widget_parameters` decoded (absent when it was empty). */
  parametersDecoded?: boolean;
  parametersReason?: string;
  /** Raw `widget_parameters` when it did not decode. */
  parametersRaw?: string;
  options: InstanceOption[];
  /** Parameter keys the widget's option_schema does not declare. */
  unknownOptions?: Record<string, unknown>;
}

export interface PortalColumn {
  sys_id: string;
  order: number;
  size?: string;
  instances: PortalInstance[];
  rows: PortalRow[];
  /** Nested rows past `depth`, not expanded. */
  rowsOmitted?: number;
}

export interface PortalRow {
  sys_id: string;
  order: number;
  columns: PortalColumn[];
}

export interface PortalContainer {
  sys_id: string;
  order: number;
  name?: string;
  width?: string;
  rows: PortalRow[];
}

export interface PortalPage {
  sys_id: string;
  id: string;
  title?: string;
  public?: string;
  roles?: string;
  /** Why the page is in the tree: homepage, login_page, menu, route_map, … */
  roles_in_portal: string[];
  layout?: PortalContainer[];
  layoutOmitted?: boolean;
}

export interface PortalWidget {
  sys_id: string;
  id?: string;
  name?: string;
  data_table?: string;
  optionSchema: { name: string; label?: string; type?: string }[];
  optionSchemaDecoded?: boolean;
  instances: number;
  dependencies: {
    sys_id: string;
    name?: string;
    module?: string;
    include_on_page_load?: string;
    jsIncludes: Include[];
    cssIncludes: Include[];
  }[];
  providers: { sys_id: string; name?: string; type?: string }[];
  templates: { sys_id: string; id?: string }[];
}

export interface Include {
  sys_id: string;
  name?: string;
  source?: string;
  url?: string;
  ref?: string;
}

export interface PortalTheme {
  sys_id: string;
  name?: string;
  header: { sys_id: string; id?: string; name?: string } | null;
  footer: { sys_id: string; id?: string; name?: string } | null;
  jsIncludes: Include[];
  cssIncludes: Include[];
}

export interface PortalMenu {
  sys_id: string;
  title?: string;
  items: {
    sys_id: string;
    label?: string;
    type?: string;
    url?: string;
    page?: string;
    order: number;
  }[];
}

export interface RouteMap {
  sys_id: string;
  short_description?: string;
  route_from_page?: string;
  route_to_page?: string;
  active?: string;
  roles?: string;
}

export interface PortalCounts {
  pages: number;
  containers: number;
  rows: number;
  columns: number;
  instances: number;
  widgets: number;
  dependencies: number;
}

export interface ExplainPortalResult {
  mode: "portal" | "page";
  portal?: {
    sys_id: string;
    url_suffix?: string;
    title?: string;
    homepage?: string;
    login_page?: string;
    notfound_page?: string;
  };
  theme?: PortalTheme | null;
  menu?: PortalMenu | null;
  pages: PortalPage[];
  widgets: PortalWidget[];
  routeMaps: RouteMap[];
  counts: PortalCounts;
  depth: number;
  verified: false;
  caveats: string[];
  unreadable: Unreadable[];
  missingFields?: Record<string, string[]>;
  /** Set when the root table itself could not be read. */
  degraded?: Unreadable;
  available?: boolean;
}

/** Read state shared by every step: caveats, progress and field checks. */
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
  limit = CHILD_LIMIT,
): Promise<SnRecord[]> {
  ctx.progress.tick(table);
  if (ctx.unreadable.some((u) => u.table === table)) return [];
  try {
    const { records, total } = await queryTable({
      table,
      query,
      fields,
      limit,
      displayValue: "false",
    });
    if (
      records.length >= limit &&
      (total === undefined || total > records.length) &&
      limit === CHILD_LIMIT
    ) {
      ctx.caveats.push(
        `${table}: read capped at ${CHILD_LIMIT} rows; the tree may be incomplete.`,
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
      `${table} could not be read (${status}): ${reason} That part of the tree is omitted.`,
    );
    return [];
  }
}

/** `field IN ids` over chunks of `IN_CHUNK`, capped at `CHILD_LIMIT` rows. */
async function readIn(
  ctx: Ctx,
  table: string,
  field: string,
  ids: Iterable<string>,
  fields: string[],
  order?: string,
): Promise<SnRecord[]> {
  const list = [...new Set(ids)].filter((id) => SAFE_ID.test(id));
  const out: SnRecord[] = [];
  for (let i = 0; i < list.length; i += IN_CHUNK) {
    const chunk = list.slice(i, i + IN_CHUNK);
    const query = `${field}IN${chunk.join(",")}${order ? `^ORDERBY${order}` : ""}`;
    out.push(...(await read(ctx, table, query, fields)));
    if (out.length >= CHILD_LIMIT) {
      if (i + IN_CHUNK < list.length) {
        ctx.caveats.push(
          `${table}: stopped after ${out.length} rows; the tree may be incomplete.`,
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

const byId = (rows: SnRecord[]): Map<string, SnRecord> =>
  new Map(rows.map((r) => [str(r, "sys_id"), r]));

/** Unwrap `{value, displayValue}` parameter values to the raw value. */
function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if ("value" in v) return v.value;
  }
  return value;
}

interface SchemaEntry {
  name: string;
  label?: string;
  type?: string;
  default?: unknown;
}

/** Decode a widget's `option_schema` into its option names. */
function parseSchema(raw: string): {
  entries: SchemaEntry[];
  decoded?: boolean;
} {
  if (!raw.trim()) return { entries: [] };
  const decoded = decodeField("json", raw);
  if (!decoded.decoded || !Array.isArray(decoded.value)) {
    return { entries: [], decoded: false };
  }
  const entries: SchemaEntry[] = [];
  for (const item of decoded.value as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.name !== "string" || !o.name) continue;
    entries.push({
      name: o.name,
      ...(typeof o.label === "string" ? { label: o.label } : {}),
      ...(typeof o.type === "string" ? { type: o.type } : {}),
      ...("default_value" in o ? { default: o.default_value } : {}),
    });
  }
  return { entries, decoded: true };
}

/** Map one instance's `widget_parameters` against the widget's schema. */
function mapOptions(
  raw: string,
  schema: SchemaEntry[],
): Pick<
  PortalInstance,
  | "options"
  | "unknownOptions"
  | "parametersDecoded"
  | "parametersReason"
  | "parametersRaw"
> {
  let params: Record<string, unknown> = {};
  const out: ReturnType<typeof mapOptions> = { options: [] };
  if (raw.trim()) {
    const decoded = decodeField("json", raw);
    if (
      decoded.decoded &&
      decoded.value &&
      typeof decoded.value === "object" &&
      !Array.isArray(decoded.value)
    ) {
      params = decoded.value as Record<string, unknown>;
      out.parametersDecoded = true;
    } else {
      out.parametersDecoded = false;
      out.parametersReason = decoded.decoded
        ? "widget_parameters is not a JSON object."
        : decoded.reason;
      out.parametersRaw = raw.slice(0, 2000);
    }
  }
  const known = new Set<string>();
  for (const entry of schema) {
    known.add(entry.name);
    const set = Object.prototype.hasOwnProperty.call(params, entry.name);
    out.options.push({
      name: entry.name,
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.type ? { type: entry.type } : {}),
      set,
      ...(set ? { value: unwrap(params[entry.name]) } : {}),
      ...(entry.default !== undefined && entry.default !== ""
        ? { default: entry.default }
        : {}),
    });
  }
  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!known.has(key)) unknown[key] = unwrap(value);
  }
  if (Object.keys(unknown).length) out.unknownOptions = unknown;
  return out;
}

const PAGE_FIELDS = ["sys_id", "id", "title", "public", "roles", "draft"];
const CONTAINER_FIELDS = ["sys_id", "sp_page", "name", "order", "width"];
const ROW_FIELDS = ["sys_id", "sp_container", "sp_column", "order"];
const COLUMN_FIELDS = ["sys_id", "sp_row", "size", "order"];
const INSTANCE_FIELDS = [
  "sys_id",
  "sp_column",
  "sp_widget",
  "widget_parameters",
  "title",
  "order",
];
const WIDGET_FIELDS = ["sys_id", "id", "name", "option_schema", "data_table"];

/** Raw layout rows of a set of pages, read level by level. */
interface LayoutRows {
  containers: SnRecord[];
  rows: SnRecord[];
  columns: SnRecord[];
  instances: SnRecord[];
  /** Column sys_id → nested rows not expanded (depth cut-off). */
  omitted: Map<string, number>;
}

async function readLayout(
  ctx: Ctx,
  pageIds: string[],
  depth: number,
): Promise<LayoutRows> {
  const out: LayoutRows = {
    containers: [],
    rows: [],
    columns: [],
    instances: [],
    omitted: new Map(),
  };
  out.containers = await readIn(
    ctx,
    "sp_container",
    "sp_page",
    pageIds,
    CONTAINER_FIELDS,
    "order",
  );
  if (!out.containers.length) return out;
  const seen = new Set<string>();
  let level = (
    await readIn(
      ctx,
      "sp_row",
      "sp_container",
      out.containers.map((c) => str(c, "sys_id")),
      ROW_FIELDS,
      "order",
    )
  ).filter((r) => !str(r, "sp_column"));
  for (let d = 1; level.length; d++) {
    level = level.filter((r) => !seen.has(str(r, "sys_id")));
    for (const r of level) seen.add(str(r, "sys_id"));
    out.rows.push(...level);
    if (!level.length) break;
    const columns = await readIn(
      ctx,
      "sp_column",
      "sp_row",
      level.map((r) => str(r, "sys_id")),
      COLUMN_FIELDS,
      "order",
    );
    out.columns.push(...columns);
    const colIds = columns.map((c) => str(c, "sys_id"));
    out.instances.push(
      ...(await readIn(
        ctx,
        "sp_instance",
        "sp_column",
        colIds,
        INSTANCE_FIELDS,
        "order",
      )),
    );
    const nested = await readIn(
      ctx,
      "sp_row",
      "sp_column",
      colIds,
      ROW_FIELDS,
      "order",
    );
    if (d >= depth) {
      if (nested.length) {
        for (const [col, rows] of groupBy(nested, "sp_column")) {
          out.omitted.set(col, rows.length);
        }
        ctx.caveats.push(
          `${nested.length} nested row(s) below depth ${depth} were not expanded; raise 'depth' (max ${PORTAL_DEPTH.max}) to read them.`,
        );
      }
      break;
    }
    level = nested;
  }
  return out;
}

function buildLayout(
  layout: LayoutRows,
  pageId: string,
  widgets: Map<string, SnRecord>,
  schemas: Map<string, SchemaEntry[]>,
): PortalContainer[] {
  const rowsByContainer = groupBy(layout.rows, "sp_container");
  const rowsByColumn = groupBy(layout.rows, "sp_column");
  const colsByRow = groupBy(layout.columns, "sp_row");
  const instByCol = groupBy(layout.instances, "sp_column");
  const visited = new Set<string>();

  const instance = (row: SnRecord): PortalInstance => {
    const widgetId = str(row, "sp_widget");
    const widget = widgetId ? widgets.get(widgetId) : undefined;
    return {
      sys_id: str(row, "sys_id"),
      order: num(row, "order"),
      ...(opt(row, "title") ? { title: opt(row, "title") } : {}),
      widget: widgetId
        ? {
            sys_id: widgetId,
            ...(widget
              ? { name: opt(widget, "name") ?? opt(widget, "id") }
              : {}),
          }
        : null,
      ...mapOptions(str(row, "widget_parameters"), schemas.get(widgetId) ?? []),
    };
  };
  const column = (row: SnRecord): PortalColumn => {
    const id = str(row, "sys_id");
    const omitted = layout.omitted.get(id);
    return {
      sys_id: id,
      order: num(row, "order"),
      ...(opt(row, "size") ? { size: opt(row, "size") } : {}),
      instances: (instByCol.get(id) ?? []).map(instance).sort(byOrder),
      rows: (rowsByColumn.get(id) ?? []).flatMap(rowOf).sort(byOrder),
      ...(omitted ? { rowsOmitted: omitted } : {}),
    };
  };
  const rowOf = (row: SnRecord): PortalRow[] => {
    const id = str(row, "sys_id");
    if (visited.has(id)) return [];
    visited.add(id);
    return [
      {
        sys_id: id,
        order: num(row, "order"),
        columns: (colsByRow.get(id) ?? []).map(column).sort(byOrder),
      },
    ];
  };
  return layout.containers
    .filter((c) => str(c, "sp_page") === pageId)
    .map((c) => ({
      sys_id: str(c, "sys_id"),
      order: num(c, "order"),
      ...(opt(c, "name") ? { name: opt(c, "name") } : {}),
      ...(opt(c, "width") ? { width: opt(c, "width") } : {}),
      rows: (rowsByContainer.get(str(c, "sys_id")) ?? [])
        .filter((r) => !str(r, "sp_column"))
        .flatMap(rowOf)
        .sort(byOrder),
    }))
    .sort(byOrder);
}

function include(row: SnRecord | undefined, id: string, ref: string): Include {
  if (!row) return { sys_id: id };
  return {
    sys_id: id,
    ...(opt(row, "display_name") || opt(row, "name")
      ? { name: opt(row, "display_name") ?? opt(row, "name") }
      : {}),
    ...(opt(row, "source") ? { source: opt(row, "source") } : {}),
    ...(opt(row, "url") ? { url: opt(row, "url") } : {}),
    ...(opt(row, ref) ? { ref: opt(row, ref) } : {}),
  };
}

const JS_INCLUDE_FIELDS = [
  "sys_id",
  "display_name",
  "source",
  "url",
  "sys_ui_script",
];
const CSS_INCLUDE_FIELDS = ["sys_id", "name", "source", "url", "sp_css"];

/** Resolve the root: the portal or page record, by sys_id or natural key. */
async function readRoot(
  ctx: Ctx,
  table: string,
  keyField: string,
  value: string,
  fields: string[],
): Promise<{ row: SnRecord } | { unreadable: Unreadable }> {
  const text = value.trim();
  const query = SYS_ID.test(text)
    ? `sys_id=${text}`
    : keyQuery({ [keyField]: text });
  ctx.progress.tick(table);
  try {
    const { records } = await queryTable({
      table,
      query,
      fields,
      limit: 2,
      displayValue: "false",
    });
    if (!records.length) {
      throw new ServiceNowError(
        `No ${table} record matches ${SYS_ID.test(text) ? "sys_id" : keyField} '${text}'.`,
        404,
        undefined,
        {
          hint:
            table === "sp_portal"
              ? "Pass the portal's url_suffix (e.g. 'sp', 'esc') or its sys_id."
              : "Pass the page's id (e.g. 'index') or its sys_id.",
        },
      );
    }
    if (records.length > 1) {
      ctx.caveats.push(
        `More than one ${table} record matches ${keyField} '${text}'; the first is explained.`,
      );
    }
    noteMissing(ctx, table, fields, records);
    return { row: records[0]! };
  } catch (error) {
    const status = degradeStatus(error);
    // A "no match" is a plain 404 of our own; only instance errors degrade.
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

/**
 * Explain a portal (`portal`) or a single portal page (`page`) as a layout
 * tree with widgets, dependencies, theme, menu and route maps.
 */
export async function explainPortal(
  opts: ExplainPortalOptions,
): Promise<ExplainPortalResult> {
  const hasPortal = !!opts.portal?.trim();
  const hasPage = !!opts.page?.trim();
  if (hasPortal === hasPage) {
    throw new ServiceNowError(
      "Pass exactly one of 'portal' (url_suffix or sys_id) or 'page' (page id or sys_id).",
      400,
    );
  }
  const depth = Math.min(
    Math.max(Math.trunc(opts.depth ?? PORTAL_DEPTH.default), 1),
    PORTAL_DEPTH.max,
  );
  const ctx: Ctx = {
    caveats: [UNVERIFIED_CAVEAT],
    unreadable: [],
    missing: {},
    progress: trackProgress(),
  };
  const result: ExplainPortalResult = {
    mode: hasPortal ? "portal" : "page",
    pages: [],
    widgets: [],
    routeMaps: [],
    counts: {
      pages: 0,
      containers: 0,
      rows: 0,
      columns: 0,
      instances: 0,
      widgets: 0,
      dependencies: 0,
    },
    depth,
    verified: false,
    caveats: ctx.caveats,
    unreadable: ctx.unreadable,
  };

  // Pages in the tree, in first-seen order, with why each is there.
  const pageRoles = new Map<string, string[]>();
  const addPage = (id: string, why: string): void => {
    if (!SAFE_ID.test(id)) return;
    const list = pageRoles.get(id) ?? [];
    if (!list.includes(why)) list.push(why);
    pageRoles.set(id, list);
  };
  let pageRows: SnRecord[] = [];
  let themeJs: SnRecord[] = [];
  let themeCss: SnRecord[] = [];

  if (hasPortal) {
    const root = await readRoot(ctx, "sp_portal", "url_suffix", opts.portal!, [
      "sys_id",
      "url_suffix",
      "title",
      "homepage",
      "login_page",
      "notfound_page",
      "theme",
      "sp_rectangle_menu",
    ]);
    if ("unreadable" in root) {
      return degrade(result, root.unreadable, "sp_portal");
    }
    const portal = root.row;
    const portalId = str(portal, "sys_id");
    result.portal = {
      sys_id: portalId,
      ...(opt(portal, "url_suffix")
        ? { url_suffix: opt(portal, "url_suffix") }
        : {}),
      ...(opt(portal, "title") ? { title: opt(portal, "title") } : {}),
      ...(opt(portal, "homepage") ? { homepage: opt(portal, "homepage") } : {}),
      ...(opt(portal, "login_page")
        ? { login_page: opt(portal, "login_page") }
        : {}),
      ...(opt(portal, "notfound_page")
        ? { notfound_page: opt(portal, "notfound_page") }
        : {}),
    };
    addPage(str(portal, "homepage"), "homepage");
    addPage(str(portal, "login_page"), "login_page");
    addPage(str(portal, "notfound_page"), "notfound_page");

    // Theme.
    const themeId = str(portal, "theme");
    result.theme = null;
    if (SAFE_ID.test(themeId)) {
      const [theme] = await read(ctx, "sp_theme", `sys_id=${themeId}`, [
        "sys_id",
        "name",
        "header",
        "footer",
      ]);
      if (theme) {
        themeJs = await read(
          ctx,
          "m2m_sp_theme_js_include",
          `sp_theme=${themeId}^ORDERBYorder`,
          ["sys_id", "sp_js_include", "order"],
        );
        themeCss = await read(
          ctx,
          "m2m_sp_theme_css_include",
          `sp_theme=${themeId}^ORDERBYorder`,
          ["sys_id", "sp_css_include", "order"],
        );
        const hf = byId(
          await readIn(
            ctx,
            "sp_header_footer",
            "sys_id",
            [str(theme, "header"), str(theme, "footer")].filter(Boolean),
            ["sys_id", "id", "name"],
          ),
        );
        const part = (id: string) =>
          SAFE_ID.test(id)
            ? {
                sys_id: id,
                ...(hf.get(id)
                  ? {
                      id: opt(hf.get(id)!, "id"),
                      name: opt(hf.get(id)!, "name"),
                    }
                  : {}),
              }
            : null;
        result.theme = {
          sys_id: themeId,
          ...(opt(theme, "name") ? { name: opt(theme, "name") } : {}),
          header: part(str(theme, "header")),
          footer: part(str(theme, "footer")),
          jsIncludes: [],
          cssIncludes: [],
        };
      }
    }

    // Menu.
    const menuId = str(portal, "sp_rectangle_menu");
    result.menu = null;
    if (SAFE_ID.test(menuId)) {
      const [menu] = await read(ctx, "sp_instance_menu", `sys_id=${menuId}`, [
        "sys_id",
        "title",
      ]);
      if (menu) {
        const items = await read(
          ctx,
          "sp_rectangle_menu_item",
          `sp_rectangle_menu=${menuId}^ORDERBYorder`,
          ["sys_id", "label", "type", "url", "sp_page", "order"],
        );
        for (const item of items) addPage(str(item, "sp_page"), "menu");
        result.menu = {
          sys_id: menuId,
          ...(opt(menu, "title") ? { title: opt(menu, "title") } : {}),
          items: items.map((i) => ({
            sys_id: str(i, "sys_id"),
            ...(opt(i, "label") ? { label: opt(i, "label") } : {}),
            ...(opt(i, "type") ? { type: opt(i, "type") } : {}),
            ...(opt(i, "url") ? { url: opt(i, "url") } : {}),
            ...(opt(i, "sp_page") ? { page: opt(i, "sp_page") } : {}),
            order: num(i, "order"),
          })),
        };
      }
    }

    // Route maps for this portal (or for every portal).
    const maps = await readRoutes(
      ctx,
      portalId,
      `portalsLIKE${portalId}^ORportalsISEMPTY^ORDERBYorder`,
      ROUTE_FIELDS,
    );
    result.routeMaps = maps.map(routeMap);
    for (const m of maps) {
      addPage(str(m, "route_from_page"), "route_from");
      addPage(str(m, "route_to_page"), "route_to");
    }
    pageRows = await readIn(
      ctx,
      "sp_page",
      "sys_id",
      pageRoles.keys(),
      PAGE_FIELDS,
    );
  } else {
    const root = await readRoot(ctx, "sp_page", "id", opts.page!, PAGE_FIELDS);
    if ("unreadable" in root) {
      return degrade(result, root.unreadable, "sp_page");
    }
    const page = root.row;
    const pageId = str(page, "sys_id");
    addPage(pageId, "page");
    pageRows = [page];
    const maps = await readRoutes(
      ctx,
      pageId,
      `route_from_page=${pageId}^ORroute_to_page=${pageId}^ORDERBYorder`,
      ROUTE_FIELDS,
    );
    result.routeMaps = maps.map(routeMap);
  }

  // Pages: summary for all, layout for the first LAYOUT_PAGES (homepage first).
  const pagesById = byId(pageRows);
  const ordered = [...pageRoles.keys()].filter((id) => pagesById.has(id));
  for (const id of pageRoles.keys()) {
    if (
      !pagesById.has(id) &&
      !ctx.unreadable.some((u) => u.table === "sp_page")
    ) {
      ctx.caveats.push(
        `Page ${id} is referenced but was not returned by sp_page.`,
      );
    }
  }
  const layoutIds = ordered.slice(0, LAYOUT_PAGES);
  if (ordered.length > LAYOUT_PAGES) {
    ctx.caveats.push(
      `${ordered.length} pages found; the layout is read for the first ${LAYOUT_PAGES} (homepage first), the others are listed only. Explain one with 'page'.`,
    );
  }
  const layout = await readLayout(ctx, layoutIds, depth);

  // Widgets used by the instances.
  const widgetIds = [
    ...new Set(
      layout.instances.map((i) => str(i, "sp_widget")).filter(Boolean),
    ),
  ];
  const widgetRows = await readIn(
    ctx,
    "sp_widget",
    "sys_id",
    widgetIds,
    WIDGET_FIELDS,
  );
  const widgets = byId(widgetRows);
  const schemas = new Map<string, SchemaEntry[]>();
  const schemaDecoded = new Map<string, boolean | undefined>();
  for (const w of widgetRows) {
    const parsed = parseSchema(str(w, "option_schema"));
    schemas.set(str(w, "sys_id"), parsed.entries);
    schemaDecoded.set(str(w, "sys_id"), parsed.decoded);
  }

  result.pages = ordered.map((id) => {
    const row = pagesById.get(id)!;
    return {
      sys_id: id,
      id: str(row, "id"),
      ...(opt(row, "title") ? { title: opt(row, "title") } : {}),
      ...(opt(row, "public") ? { public: opt(row, "public") } : {}),
      ...(opt(row, "roles") ? { roles: opt(row, "roles") } : {}),
      roles_in_portal: pageRoles.get(id) ?? [],
      ...(layoutIds.includes(id)
        ? { layout: buildLayout(layout, id, widgets, schemas) }
        : { layoutOmitted: true }),
    };
  });

  // Widget dependencies.
  const wIds = widgetRows.map((w) => str(w, "sys_id"));
  const depLinks = await readIn(
    ctx,
    "m2m_sp_widget_dependency",
    "sp_widget",
    wIds,
    ["sys_id", "sp_widget", "sp_dependency"],
  );
  const deps = byId(
    await readIn(
      ctx,
      "sp_dependency",
      "sys_id",
      depLinks.map((l) => str(l, "sp_dependency")),
      ["sys_id", "name", "module", "include_on_page_load"],
    ),
  );
  const depIds = [...deps.keys()];
  const depJs = await readIn(
    ctx,
    "m2m_sp_dependency_js_include",
    "sp_dependency",
    depIds,
    ["sys_id", "sp_dependency", "sp_js_include", "order"],
    "order",
  );
  const depCss = await readIn(
    ctx,
    "m2m_sp_dependency_css_include",
    "sp_dependency",
    depIds,
    ["sys_id", "sp_dependency", "sp_css_include", "order"],
    "order",
  );
  const jsRows = byId(
    await readIn(
      ctx,
      "sp_js_include",
      "sys_id",
      [...depJs, ...themeJs].map((r) => str(r, "sp_js_include")),
      JS_INCLUDE_FIELDS,
    ),
  );
  const cssRows = byId(
    await readIn(
      ctx,
      "sp_css_include",
      "sys_id",
      [...depCss, ...themeCss].map((r) => str(r, "sp_css_include")),
      CSS_INCLUDE_FIELDS,
    ),
  );
  const js = (id: string): Include =>
    include(jsRows.get(id), id, "sys_ui_script");
  const css = (id: string): Include => include(cssRows.get(id), id, "sp_css");
  if (result.theme) {
    result.theme.jsIncludes = themeJs.map((r) => js(str(r, "sp_js_include")));
    result.theme.cssIncludes = themeCss.map((r) =>
      css(str(r, "sp_css_include")),
    );
  }
  const providerLinks = await readIn(
    ctx,
    "m2m_sp_ng_pro_sp_widget",
    "sp_widget",
    wIds,
    ["sys_id", "sp_widget", "sp_angular_provider"],
  );
  const providers = byId(
    await readIn(
      ctx,
      "sp_angular_provider",
      "sys_id",
      providerLinks.map((l) => str(l, "sp_angular_provider")),
      ["sys_id", "name", "type"],
    ),
  );
  const templates = groupBy(
    await readIn(ctx, "sp_ng_template", "sp_widget", wIds, [
      "sys_id",
      "id",
      "sp_widget",
    ]),
    "sp_widget",
  );
  const depsByWidget = groupBy(depLinks, "sp_widget");
  const provByWidget = groupBy(providerLinks, "sp_widget");
  const jsByDep = groupBy(depJs, "sp_dependency");
  const cssByDep = groupBy(depCss, "sp_dependency");
  const useCount = new Map<string, number>();
  for (const i of layout.instances) {
    const w = str(i, "sp_widget");
    useCount.set(w, (useCount.get(w) ?? 0) + 1);
  }
  result.widgets = widgetRows.map((w) => {
    const id = str(w, "sys_id");
    const decoded = schemaDecoded.get(id);
    return {
      sys_id: id,
      ...(opt(w, "id") ? { id: opt(w, "id") } : {}),
      ...(opt(w, "name") ? { name: opt(w, "name") } : {}),
      ...(opt(w, "data_table") ? { data_table: opt(w, "data_table") } : {}),
      optionSchema: (schemas.get(id) ?? []).map(({ name, label, type }) => ({
        name,
        ...(label ? { label } : {}),
        ...(type ? { type } : {}),
      })),
      ...(decoded === undefined ? {} : { optionSchemaDecoded: decoded }),
      instances: useCount.get(id) ?? 0,
      dependencies: (depsByWidget.get(id) ?? []).map((l) => {
        const depId = str(l, "sp_dependency");
        const dep = deps.get(depId);
        return {
          sys_id: depId,
          ...(dep && opt(dep, "name") ? { name: opt(dep, "name") } : {}),
          ...(dep && opt(dep, "module") ? { module: opt(dep, "module") } : {}),
          ...(dep && opt(dep, "include_on_page_load")
            ? { include_on_page_load: opt(dep, "include_on_page_load") }
            : {}),
          jsIncludes: (jsByDep.get(depId) ?? []).map((r) =>
            js(str(r, "sp_js_include")),
          ),
          cssIncludes: (cssByDep.get(depId) ?? []).map((r) =>
            css(str(r, "sp_css_include")),
          ),
        };
      }),
      providers: (provByWidget.get(id) ?? []).map((l) => {
        const pid = str(l, "sp_angular_provider");
        const p = providers.get(pid);
        return {
          sys_id: pid,
          ...(p && opt(p, "name") ? { name: opt(p, "name") } : {}),
          ...(p && opt(p, "type") ? { type: opt(p, "type") } : {}),
        };
      }),
      templates: (templates.get(id) ?? []).map((t) => ({
        sys_id: str(t, "sys_id"),
        ...(opt(t, "id") ? { id: opt(t, "id") } : {}),
      })),
    };
  });
  for (const w of result.widgets) {
    if (w.optionSchemaDecoded === false) {
      ctx.caveats.push(
        `Widget ${w.id ?? w.sys_id}: option_schema did not decode as a JSON array; its instance options are listed as unknownOptions.`,
      );
    }
  }
  if (layout.instances.some((i) => str(i, "widget_parameters"))) {
    ctx.caveats.push(OPTIONS_CAVEAT);
  }

  result.counts = {
    pages: result.pages.length,
    containers: layout.containers.filter((c) =>
      layoutIds.includes(str(c, "sp_page")),
    ).length,
    rows: layout.rows.length,
    columns: layout.columns.length,
    instances: layout.instances.length,
    widgets: result.widgets.length,
    dependencies: deps.size,
  };
  if (Object.keys(ctx.missing).length) result.missingFields = ctx.missing;
  return result;
}

const ROUTE_FIELDS = [
  "sys_id",
  "short_description",
  "route_from_page",
  "route_to_page",
  "active",
  "roles",
  "order",
];

/** Route maps matching `query`, skipped when the root id is not query-safe. */
async function readRoutes(
  ctx: Ctx,
  rootId: string,
  query: string,
  fields: string[],
): Promise<SnRecord[]> {
  return SAFE_ID.test(rootId)
    ? read(ctx, "sp_page_route_map", query, fields)
    : [];
}

function routeMap(m: SnRecord): RouteMap {
  return {
    sys_id: str(m, "sys_id"),
    ...(opt(m, "short_description")
      ? { short_description: opt(m, "short_description") }
      : {}),
    ...(opt(m, "route_from_page")
      ? { route_from_page: opt(m, "route_from_page") }
      : {}),
    ...(opt(m, "route_to_page")
      ? { route_to_page: opt(m, "route_to_page") }
      : {}),
    ...(opt(m, "active") ? { active: opt(m, "active") } : {}),
    ...(opt(m, "roles") ? { roles: opt(m, "roles") } : {}),
  };
}

/** The root table could not be read: a degraded result, not a failure. */
async function degrade(
  result: ExplainPortalResult,
  why: Unreadable,
  table: string,
): Promise<ExplainPortalResult> {
  result.degraded = why;
  result.unreadable.push(why);
  result.caveats.push(
    `${table} could not be read (${why.status}): ${why.reason}`,
  );
  const available = await tableAvailable(table);
  if (available !== undefined) result.available = available;
  return result;
}

const pageLabel = (p: PortalPage): string =>
  `${p.title ? `${p.title} ` : ""}(${p.id || p.sys_id})${
    p.roles_in_portal.length ? ` · ${p.roles_in_portal.join(", ")}` : ""
  }`;

const instanceLabel = (i: PortalInstance): string => {
  const widget = i.widget ? (i.widget.name ?? i.widget.sys_id) : "no widget";
  return i.title ? `${i.title} · ${widget}` : widget;
};

/**
 * The layout tree as a Mermaid flowchart (portal → theme / menu / pages →
 * container → row → column → widget instance), capped by
 * SN_DIAGRAM_MAX_NODES; `truncated` counts the dropped nodes.
 */
export function portalMermaid(result: ExplainPortalResult): {
  mermaid: string;
  truncated: number;
} {
  const doc = new MermaidDoc("flowchart TD");
  let root: string | undefined;
  if (result.portal) {
    root = "portal";
    const p = result.portal;
    doc.node(
      root,
      label(
        `Portal: ${p.title ?? p.sys_id}${p.url_suffix ? ` /${p.url_suffix}` : ""}`,
      ),
      "rect",
      { pinned: true },
    );
    if (result.theme) {
      doc.edgeTo(
        root,
        "theme",
        label(`Theme: ${result.theme.name ?? result.theme.sys_id}`),
        {
          arrow: "-.->",
        },
      );
    }
    if (result.menu) {
      doc.edgeTo(
        root,
        "menu",
        label(`Menu: ${result.menu.title ?? result.menu.sys_id}`),
        {
          arrow: "-.->",
        },
      );
    }
  }
  const rowNodes = (from: string, rows: PortalRow[]): void => {
    for (const row of rows) {
      const rid = `r_${ident(row.sys_id)}`;
      doc.edgeTo(from, rid, "Row");
      for (const col of row.columns) {
        const cid = `col_${ident(col.sys_id)}`;
        doc.edgeTo(rid, cid, label(col.size ? `Column ${col.size}` : "Column"));
        for (const inst of col.instances) {
          doc.edgeTo(
            cid,
            `i_${ident(inst.sys_id)}`,
            label(instanceLabel(inst), 80),
            {
              shape: "input",
            },
          );
        }
        rowNodes(cid, col.rows);
        if (col.rowsOmitted) {
          doc.edgeTo(
            cid,
            `more_${ident(col.sys_id)}`,
            label(`+${col.rowsOmitted} nested row(s)`),
            {
              arrow: "-.->",
            },
          );
        }
      }
    }
  };
  for (const page of result.pages) {
    const pid = `pg_${ident(page.sys_id)}`;
    const text = label(`Page: ${pageLabel(page)}`, 100);
    if (root) doc.edgeTo(root, pid, text);
    else doc.node(pid, text, "rect", { pinned: true });
    for (const c of page.layout ?? []) {
      const cid = `c_${ident(c.sys_id)}`;
      doc.edgeTo(
        pid,
        cid,
        label(`Container${c.name ? `: ${c.name}` : ""}`, 80),
        {
          shape: "db",
        },
      );
      rowNodes(cid, c.rows);
    }
  }
  return { mermaid: doc.render(), truncated: doc.truncated };
}

const fmt = (v: unknown): string => {
  const text = typeof v === "string" ? v : JSON.stringify(v);
  const one = (text ?? "").replace(/[\r\n]+/g, " ");
  return one.length > 120 ? `${one.slice(0, 117)}...` : one;
};

/** A readable Markdown report of the tree (the Mermaid diagram included). */
export function portalMarkdown(
  result: ExplainPortalResult,
  mermaid: string,
): string {
  const out: string[] = [];
  const p = result.portal;
  if (p) {
    out.push(
      `# Portal ${p.title ?? p.sys_id}${p.url_suffix ? ` (/${p.url_suffix})` : ""}`,
    );
  } else {
    const page = result.pages[0];
    out.push(`# Page ${page ? pageLabel(page) : "(unreadable)"}`);
  }
  out.push("");
  const c = result.counts;
  out.push(
    `${c.pages} page(s), ${c.containers} container(s), ${c.rows} row(s), ${c.columns} column(s), ${c.instances} instance(s), ${c.widgets} widget(s), ${c.dependencies} dependency(ies). verified:false.`,
  );
  if (result.theme) {
    const t = result.theme;
    out.push("", "## Theme", "");
    out.push(`- **${t.name ?? t.sys_id}**`);
    if (t.header)
      out.push(`- Header: ${t.header.name ?? t.header.id ?? t.header.sys_id}`);
    if (t.footer)
      out.push(`- Footer: ${t.footer.name ?? t.footer.id ?? t.footer.sys_id}`);
    for (const i of t.jsIncludes)
      out.push(`- JS include: ${i.name ?? i.sys_id}`);
    for (const i of t.cssIncludes)
      out.push(`- CSS include: ${i.name ?? i.sys_id}`);
  }
  if (result.menu) {
    out.push("", `## Menu ${result.menu.title ?? result.menu.sys_id}`, "");
    for (const i of result.menu.items) {
      out.push(
        `- ${i.label ?? i.sys_id}${i.type ? ` (${i.type})` : ""}${i.url ? ` → ${i.url}` : ""}`,
      );
    }
  }
  out.push("", "## Pages", "");
  for (const page of result.pages) {
    out.push(`### ${pageLabel(page)}`, "");
    if (page.layoutOmitted) {
      out.push("_Layout not read (page limit)._", "");
      continue;
    }
    const rows = (list: PortalRow[], indent: string): void => {
      for (const row of list) {
        out.push(`${indent}- Row`);
        for (const col of row.columns) {
          out.push(`${indent}  - Column${col.size ? ` ${col.size}` : ""}`);
          for (const inst of col.instances) {
            out.push(`${indent}    - **${instanceLabel(inst)}**`);
            for (const o of inst.options.filter((x) => x.set)) {
              out.push(`${indent}      - ${o.name} = ${fmt(o.value)}`);
            }
            for (const [k, v] of Object.entries(inst.unknownOptions ?? {})) {
              out.push(
                `${indent}      - ${k} = ${fmt(v)} _(not in option_schema)_`,
              );
            }
            if (inst.parametersDecoded === false) {
              out.push(
                `${indent}      - _widget_parameters did not decode: ${inst.parametersReason}_`,
              );
            }
          }
          rows(col.rows, `${indent}    `);
          if (col.rowsOmitted) {
            out.push(
              `${indent}    - _${col.rowsOmitted} nested row(s) past depth_`,
            );
          }
        }
      }
    };
    for (const cont of page.layout ?? []) {
      out.push(
        `- Container${cont.name ? ` ${cont.name}` : ""}${cont.width ? ` (${cont.width})` : ""}`,
      );
      rows(cont.rows, "  ");
    }
    out.push("");
  }
  if (result.widgets.length) {
    out.push("## Widgets", "");
    for (const w of result.widgets) {
      out.push(
        `- **${w.name ?? w.id ?? w.sys_id}**${w.id ? ` (${w.id})` : ""}: ${w.instances} instance(s)`,
      );
      if (w.optionSchema.length) {
        out.push(
          `  - Options: ${w.optionSchema.map((o) => o.name).join(", ")}`,
        );
      }
      for (const d of w.dependencies) {
        const inc = [...d.jsIncludes, ...d.cssIncludes].map(
          (i) => i.name ?? i.sys_id,
        );
        out.push(
          `  - Dependency ${d.name ?? d.sys_id}${inc.length ? `: ${inc.join(", ")}` : ""}`,
        );
      }
      for (const pr of w.providers) {
        out.push(
          `  - Angular provider ${pr.name ?? pr.sys_id}${pr.type ? ` (${pr.type})` : ""}`,
        );
      }
      for (const t of w.templates)
        out.push(`  - ng-template ${t.id ?? t.sys_id}`);
    }
    out.push("");
  }
  if (result.routeMaps.length) {
    out.push("## Route maps", "");
    for (const m of result.routeMaps) {
      out.push(
        `- ${m.short_description ?? m.sys_id}: ${m.route_from_page ?? "?"} → ${m.route_to_page ?? "?"}${m.active === "false" ? " (inactive)" : ""}`,
      );
    }
    out.push("");
  }
  out.push("## Layout diagram", "", "```mermaid", mermaid, "```", "");
  out.push("## Caveats", "");
  for (const cav of result.caveats) out.push(`- ${cav}`);
  if (result.missingFields) {
    for (const [table, fields] of Object.entries(result.missingFields)) {
      out.push(`- ${table}: fields not returned: ${fields.join(", ")}`);
    }
  }
  return out.join("\n");
}
