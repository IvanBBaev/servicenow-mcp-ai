import { type Unreadable } from "./bounded-read.js";

/**
 * P-16 `explain_portal` model: bounds, caveats and the result types
 * (split out of `src/api/portal.ts`).
 */

/** Default and maximum nested-row depth (a row inside a column). */
export const PORTAL_DEPTH = { default: 3, max: 6 } as const;

/** Pages whose full layout is read; the others are listed with a summary. */
export const LAYOUT_PAGES = 5;

/**
 * A record id safe to splice into an encoded query (no `^`, `,` or spaces).
 * Ids read back from the instance are checked too, so a malformed reference
 * can never widen a query.
 */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const UNVERIFIED_CAVEAT =
  "Service Portal tables are verified:false: their table and field names come from the SDK inventory and have not been confirmed on a live instance (gate O-5).";

export const OPTIONS_CAVEAT =
  "Widget options are read from widget_parameters only; some classic options (title, glyph, color, size) may live in sp_instance columns instead.";

export interface ExplainPortalOptions {
  /** Portal url_suffix or sys_id. */
  portal?: string;
  /** Page id or sys_id (explains that page only). */
  page?: string;
  /** Nested-row depth. */
  depth?: number;
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
