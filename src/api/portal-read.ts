import { decodeField } from "../core/artifacts/decoders.js";
import { ServiceNowError } from "../core/errors.js";
import { tableAvailable } from "./artifacts.js";
import { snString, degradeStatus } from "./shared.js";
import {
  boundedRead,
  boundedReadIn,
  noteMissing,
  type ReadCtx,
  type Unreadable,
} from "./bounded-read.js";
import { keyQuery, queryTable, type SnRecord } from "./table.js";
import { isSysId } from "../core/sys-id.js";
import {
  type ExplainPortalResult,
  type Include,
  PORTAL_DEPTH,
  type PortalColumn,
  type PortalContainer,
  type PortalInstance,
  type PortalRow,
  type RouteMap,
  SAFE_ID,
} from "./portal-model.js";

/**
 * P-16 `explain_portal` readers: row helpers, widget option mapping, the
 * page layout, the portal root, route maps and degraded reads.
 */

export const str = (row: SnRecord, field: string): string =>
  snString(row[field]);

export const opt = (row: SnRecord, field: string): string | undefined =>
  str(row, field) || undefined;

export const num = (row: SnRecord, field: string): number => {
  const n = Number(str(row, field));
  return Number.isFinite(n) ? n : 0;
};

const byOrder = <T extends { order: number }>(a: T, b: T): number =>
  a.order - b.order;

export function groupBy(
  rows: SnRecord[],
  field: string,
): Map<string, SnRecord[]> {
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

export const byId = (rows: SnRecord[]): Map<string, SnRecord> =>
  new Map(rows.map((r) => [str(r, "sys_id"), r]));

/** Unwrap `{value, displayValue}` parameter values to the raw value. */
function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if ("value" in v) return v.value;
  }
  return value;
}

export interface SchemaEntry {
  name: string;
  label?: string;
  type?: string;
  default?: unknown;
}

/** Decode a widget's `option_schema` into its option names. */
export function parseSchema(raw: string): {
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

export const PAGE_FIELDS = [
  "sys_id",
  "id",
  "title",
  "public",
  "roles",
  "draft",
];

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

export const WIDGET_FIELDS = [
  "sys_id",
  "id",
  "name",
  "option_schema",
  "data_table",
];

/** Raw layout rows of a set of pages, read level by level. */
interface LayoutRows {
  containers: SnRecord[];
  rows: SnRecord[];
  columns: SnRecord[];
  instances: SnRecord[];
  /** Column sys_id → nested rows not expanded (depth cut-off). */
  omitted: Map<string, number>;
}

export async function readLayout(
  ctx: ReadCtx,
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
  out.containers = await boundedReadIn(
    ctx,
    "sp_container",
    "sp_page",
    pageIds,
    CONTAINER_FIELDS,
    { order: "order" },
  );
  if (!out.containers.length) return out;
  const seen = new Set<string>();
  let level = (
    await boundedReadIn(
      ctx,
      "sp_row",
      "sp_container",
      out.containers.map((c) => str(c, "sys_id")),
      ROW_FIELDS,
      { order: "order" },
    )
  ).filter((r) => !str(r, "sp_column"));
  for (let d = 1; level.length; d++) {
    level = level.filter((r) => !seen.has(str(r, "sys_id")));
    for (const r of level) seen.add(str(r, "sys_id"));
    out.rows.push(...level);
    if (!level.length) break;
    const columns = await boundedReadIn(
      ctx,
      "sp_column",
      "sp_row",
      level.map((r) => str(r, "sys_id")),
      COLUMN_FIELDS,
      { order: "order" },
    );
    out.columns.push(...columns);
    const colIds = columns.map((c) => str(c, "sys_id"));
    out.instances.push(
      ...(await boundedReadIn(
        ctx,
        "sp_instance",
        "sp_column",
        colIds,
        INSTANCE_FIELDS,
        { order: "order" },
      )),
    );
    const nested = await boundedReadIn(
      ctx,
      "sp_row",
      "sp_column",
      colIds,
      ROW_FIELDS,
      { order: "order" },
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

export function buildLayout(
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

export function include(
  row: SnRecord | undefined,
  id: string,
  ref: string,
): Include {
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

export const JS_INCLUDE_FIELDS = [
  "sys_id",
  "display_name",
  "source",
  "url",
  "sys_ui_script",
];

export const CSS_INCLUDE_FIELDS = ["sys_id", "name", "source", "url", "sp_css"];

/** Resolve the root: the portal or page record, by sys_id or natural key. */
export async function readRoot(
  ctx: ReadCtx,
  table: string,
  keyField: string,
  value: string,
  fields: string[],
): Promise<{ row: SnRecord } | { unreadable: Unreadable }> {
  const text = value.trim();
  const query = isSysId(text)
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
        `No ${table} record matches ${isSysId(text) ? "sys_id" : keyField} '${text}'.`,
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

export const ROUTE_FIELDS = [
  "sys_id",
  "short_description",
  "route_from_page",
  "route_to_page",
  "active",
  "roles",
  "order",
];

/** Route maps matching `query`, skipped when the root id is not query-safe. */
export async function readRoutes(
  ctx: ReadCtx,
  rootId: string,
  query: string,
  fields: string[],
): Promise<SnRecord[]> {
  return SAFE_ID.test(rootId)
    ? boundedRead(ctx, "sp_page_route_map", query, fields)
    : [];
}

export function routeMap(m: SnRecord): RouteMap {
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
export async function degrade(
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
