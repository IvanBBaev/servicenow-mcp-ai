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
import { ServiceNowError } from "../core/errors.js";
import { trackProgress } from "../core/progress.js";
import { boundedRead, boundedReadIn, type ReadCtx } from "./bounded-read.js";
import { type SnRecord } from "./table.js";
import {
  type ExplainPortalOptions,
  type ExplainPortalResult,
  type Include,
  LAYOUT_PAGES,
  OPTIONS_CAVEAT,
  PORTAL_DEPTH,
  SAFE_ID,
  UNVERIFIED_CAVEAT,
} from "./portal-model.js";
import {
  buildLayout,
  byId,
  CSS_INCLUDE_FIELDS,
  degrade,
  groupBy,
  include,
  JS_INCLUDE_FIELDS,
  num,
  opt,
  PAGE_FIELDS,
  parseSchema,
  readLayout,
  readRoot,
  readRoutes,
  ROUTE_FIELDS,
  routeMap,
  type SchemaEntry,
  str,
  WIDGET_FIELDS,
} from "./portal-read.js";

export {
  PORTAL_DEPTH,
  LAYOUT_PAGES,
  type ExplainPortalOptions,
  type Ref,
  type InstanceOption,
  type PortalInstance,
  type PortalColumn,
  type PortalRow,
  type PortalContainer,
  type PortalPage,
  type PortalWidget,
  type Include,
  type PortalTheme,
  type PortalMenu,
  type RouteMap,
  type PortalCounts,
  type ExplainPortalResult,
} from "./portal-model.js";
export { portalMermaid, portalMarkdown } from "./portal-render.js";

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
  const ctx: ReadCtx = {
    caveats: [UNVERIFIED_CAVEAT],
    scope: "the tree",
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
  let pageRows: SnRecord[];
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
      const [theme] = await boundedRead(ctx, "sp_theme", `sys_id=${themeId}`, [
        "sys_id",
        "name",
        "header",
        "footer",
      ]);
      if (theme) {
        themeJs = await boundedRead(
          ctx,
          "m2m_sp_theme_js_include",
          `sp_theme=${themeId}^ORDERBYorder`,
          ["sys_id", "sp_js_include", "order"],
        );
        themeCss = await boundedRead(
          ctx,
          "m2m_sp_theme_css_include",
          `sp_theme=${themeId}^ORDERBYorder`,
          ["sys_id", "sp_css_include", "order"],
        );
        const hf = byId(
          await boundedReadIn(
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
      const [menu] = await boundedRead(
        ctx,
        "sp_instance_menu",
        `sys_id=${menuId}`,
        ["sys_id", "title"],
      );
      if (menu) {
        const items = await boundedRead(
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
    pageRows = await boundedReadIn(
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
  const widgetRows = await boundedReadIn(
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
  const depLinks = await boundedReadIn(
    ctx,
    "m2m_sp_widget_dependency",
    "sp_widget",
    wIds,
    ["sys_id", "sp_widget", "sp_dependency"],
  );
  const deps = byId(
    await boundedReadIn(
      ctx,
      "sp_dependency",
      "sys_id",
      depLinks.map((l) => str(l, "sp_dependency")),
      ["sys_id", "name", "module", "include_on_page_load"],
    ),
  );
  const depIds = [...deps.keys()];
  const depJs = await boundedReadIn(
    ctx,
    "m2m_sp_dependency_js_include",
    "sp_dependency",
    depIds,
    ["sys_id", "sp_dependency", "sp_js_include", "order"],
    { order: "order" },
  );
  const depCss = await boundedReadIn(
    ctx,
    "m2m_sp_dependency_css_include",
    "sp_dependency",
    depIds,
    ["sys_id", "sp_dependency", "sp_css_include", "order"],
    { order: "order" },
  );
  const jsRows = byId(
    await boundedReadIn(
      ctx,
      "sp_js_include",
      "sys_id",
      [...depJs, ...themeJs].map((r) => str(r, "sp_js_include")),
      JS_INCLUDE_FIELDS,
    ),
  );
  const cssRows = byId(
    await boundedReadIn(
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
  const providerLinks = await boundedReadIn(
    ctx,
    "m2m_sp_ng_pro_sp_widget",
    "sp_widget",
    wIds,
    ["sys_id", "sp_widget", "sp_angular_provider"],
  );
  const providers = byId(
    await boundedReadIn(
      ctx,
      "sp_angular_provider",
      "sys_id",
      providerLinks.map((l) => str(l, "sp_angular_provider")),
      ["sys_id", "name", "type"],
    ),
  );
  const templates = groupBy(
    await boundedReadIn(ctx, "sp_ng_template", "sp_widget", wIds, [
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
