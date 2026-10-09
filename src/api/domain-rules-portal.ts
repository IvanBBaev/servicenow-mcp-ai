import { IN_CHUNK } from "./shared.js";
import { type SnRecord } from "./table.js";
import { scriptCalls } from "./script-ast.js";
import {
  Collector,
  type Ctx,
  DOMAIN_CHILD_MAX,
  need,
  NEWEST,
  read,
  readIn,
  refOf,
  type Rows,
  SAFE_ID,
  str,
} from "./domain-rules-shared.js";

/**
 * P-19 Service Portal rules (`portal-*`).
 */

const DATA_READ =
  /\bnew\s+(GlideRecord|GlideAggregate|GlideQuery)\s*\(|\$sp\.getRecord\s*\(/;

const DATA_READ_CTORS = new Set([
  "GlideRecord",
  "GlideAggregate",
  "GlideQuery",
]);

/**
 * S-12: does a widget server script read records? Matched on the parsed
 * calls (a commented-out GlideRecord is not a read); the regex when the
 * script does not parse.
 */
function readsData(script: string): boolean {
  if (!script) return false;
  const calls = scriptCalls(script);
  if (!calls) return DATA_READ.test(script);
  return calls.some((c) =>
    c.kind === "new"
      ? c.object === undefined && DATA_READ_CTORS.has(c.name ?? "")
      : c.object === "$sp" && c.name === "getRecord",
  );
}

const WIDGET_FIELDS = [
  "sys_id",
  "id",
  "name",
  "public",
  "script",
  "template",
  "client_script",
  "link",
];

const PORTAL_PAGE_FIELDS = [
  "homepage",
  "login_page",
  "notfound_page",
  "kb_knowledge_page",
  "sc_catalog_page",
  "sc_category_page",
];

const truthy = (v: string): boolean => v === "true" || v === "1";

const quoted = (text: string, id: string): boolean =>
  !!id &&
  (text.includes(`'${id}'`) ||
    text.includes(`"${id}"`) ||
    new RegExp(
      `[?&]id=${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`,
    ).test(text));

export async function analysePortal(ctx: Ctx, out: Collector): Promise<void> {
  const { limit } = ctx;
  let widgets: Rows | null = null;
  const widgetText = (w: SnRecord): string =>
    ["script", "template", "client_script", "link"]
      .map((f) => str(w, f))
      .join("\n");

  // 1. Public widgets / widgets on public pages that read data.
  await out.run(["portal-public-data-widget"], async () => {
    widgets = need(
      ctx,
      await read(ctx, "sp_widget", NEWEST, WIDGET_FIELDS, limit),
      "sp_widget",
    );
    const pages = await read(
      ctx,
      "sp_page",
      `public=true^${NEWEST}`,
      ["sys_id", "id", "title"],
      limit,
    );
    const onPublic = new Map<string, string[]>();
    let capped = widgets.capped || !!pages?.capped;
    if (pages?.rows.length) {
      const inst = await readIn(
        ctx,
        "sp_instance",
        "sp_column.sp_row.sp_container.sp_page",
        pages.rows.map((p) => str(p, "sys_id")),
        ["sys_id", "sp_widget", "sp_column.sp_row.sp_container.sp_page"],
      );
      capped ||= !!inst?.capped;
      const pageId = new Map(
        pages.rows.map((p) => [
          str(p, "sys_id"),
          str(p, "id") || str(p, "sys_id"),
        ]),
      );
      for (const i of inst?.rows ?? []) {
        const w = str(i, "sp_widget");
        const p = pageId.get(str(i, "sp_column.sp_row.sp_container.sp_page"));
        if (!w || !p) continue;
        const list = onPublic.get(w) ?? [];
        if (!list.includes(p)) list.push(p);
        onPublic.set(w, list);
      }
      ctx.caveats.add(
        "portal-public-data-widget follows sp_instance → column → row → container → page by dot-walk: a widget in a nested row (a row inside a column) is not attributed to its page.",
      );
    }
    const known = new Map(widgets.rows.map((w) => [str(w, "sys_id"), w]));
    const missing = [...onPublic.keys()].filter((id) => !known.has(id));
    if (missing.length) {
      const extra = await readIn(
        ctx,
        "sp_widget",
        "sys_id",
        missing,
        WIDGET_FIELDS,
      );
      capped ||= !!extra?.capped;
      for (const w of extra?.rows ?? []) known.set(str(w, "sys_id"), w);
    }
    const candidates = [...known.values()].filter(
      (w) => truthy(str(w, "public")) || onPublic.has(str(w, "sys_id")),
    );
    out.scanned("portal-public-data-widget", candidates.length, capped);
    for (const w of candidates) {
      if (!readsData(str(w, "script"))) continue;
      const pagesOf = onPublic.get(str(w, "sys_id")) ?? [];
      const isPublic = truthy(str(w, "public"));
      out.add(
        "portal-public-data-widget",
        refOf("sp_widget", "sp_widget", w),
        `${isPublic ? "A public widget" : `A widget on public page(s) ${pagesOf.join(", ")}`} reads data server-side with GlideRecord / GlideAggregate / GlideQuery: anonymous visitors can reach that data unless the query is ACL-checked. Use GlideRecordSecure and require a login where the data is not public.`,
        {
          public: isPublic,
          ...(pagesOf.length ? { publicPages: pagesOf } : {}),
        },
      );
    }
  });

  // 2. Orphaned widgets.
  await out.run(["portal-orphan-widget"], async () => {
    const ws = need(
      ctx,
      widgets ?? (await read(ctx, "sp_widget", NEWEST, WIDGET_FIELDS, limit)),
      "sp_widget",
    );
    widgets = ws;
    out.scanned("portal-orphan-widget", ws.rows.length, ws.capped);
    if (!ws.rows.length) return;
    const ids = ws.rows.map((w) => str(w, "sys_id"));
    const placed = new Set<string>();
    const unknown = new Set<string>();
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK);
      const r = need(
        ctx,
        await read(
          ctx,
          "sp_instance",
          `sp_widgetIN${chunk.filter((id) => SAFE_ID.test(id)).join(",")}`,
          ["sp_widget"],
          DOMAIN_CHILD_MAX,
        ),
        "sp_instance",
      );
      for (const row of r.rows) placed.add(str(row, "sp_widget"));
      if (r.capped) for (const id of chunk) unknown.add(id);
    }
    if (unknown.size) out.scanned("portal-orphan-widget", 0, true);
    for (const w of ws.rows) {
      const id = str(w, "sys_id");
      if (placed.has(id) || unknown.has(id)) continue;
      const wid = str(w, "id");
      const embedded = ws.rows.some(
        (o) => o !== w && wid && quoted(widgetText(o), wid),
      );
      if (embedded) continue;
      out.add(
        "portal-orphan-widget",
        refOf("sp_widget", "sp_widget", w),
        "The widget is on no page (no sp_instance) and no swept widget embeds it by id: it may be unused. Confirm nothing embeds it ($sp.getWidget, <sp-widget>) before retiring it.",
      );
    }
  });

  // 3 and 4 share the route maps.
  let maps: Rows | null = null;
  await out.run(["portal-route-map-loop"], async () => {
    maps = need(
      ctx,
      await read(
        ctx,
        "sp_page_route_map",
        "active=true^ORDERBYorder",
        [
          "sys_id",
          "short_description",
          "route_from_page",
          "route_to_page",
          "portals",
          "order",
        ],
        DOMAIN_CHILD_MAX,
      ),
      "sp_page_route_map",
    );
    out.scanned("portal-route-map-loop", maps.rows.length, maps.capped);
    for (const loop of routeLoops(maps.rows)) {
      const first = loop.maps[0]!;
      out.add(
        "portal-route-map-loop",
        refOf(
          "sp_page_route_map",
          "sp_page_route_map",
          first,
          "short_description",
        ),
        `Active route maps redirect in a cycle (${loop.pages.join(" → ")})${loop.portal ? ` in portal ${loop.portal}` : " in every portal"}: a visitor to any of those pages never reaches a real one. Deactivate or re-target one of the maps.`,
        {
          maps: loop.maps.map((m) => str(m, "sys_id")),
          pages: loop.pages,
          ...(loop.portal ? { portal: loop.portal } : {}),
        },
      );
    }
    ctx.caveats.add(
      "portal-route-map-loop follows each page's first active route map (lowest order) per portal; roles on a route map are ignored, and whether the platform chains route maps is unverified (gate O-5).",
    );
  });

  // 4. Orphaned pages.
  await out.run(["portal-orphan-page"], async () => {
    const pages = need(
      ctx,
      await read(ctx, "sp_page", NEWEST, ["sys_id", "id", "title"], limit),
      "sp_page",
    );
    out.scanned("portal-orphan-page", pages.rows.length, pages.capped);
    if (!pages.rows.length) return;
    const linked = new Set<string>();
    let complete = true;
    const portals = await read(
      ctx,
      "sp_portal",
      "",
      ["sys_id", ...PORTAL_PAGE_FIELDS],
      DOMAIN_CHILD_MAX,
    );
    if (!portals || portals.capped) complete = false;
    for (const p of portals?.rows ?? []) {
      for (const f of PORTAL_PAGE_FIELDS) linked.add(str(p, f));
    }
    const ids = pages.rows.map((p) => str(p, "sys_id"));
    const items = await readIn(ctx, "sp_rectangle_menu_item", "sp_page", ids, [
      "sp_page",
    ]);
    if (!items || items.capped) complete = false;
    for (const r of items?.rows ?? []) linked.add(str(r, "sp_page"));
    const rm =
      maps ??
      (await read(
        ctx,
        "sp_page_route_map",
        "active=true^ORDERBYorder",
        ["sys_id", "route_from_page", "route_to_page"],
        DOMAIN_CHILD_MAX,
      ));
    if (!rm || rm.capped) complete = false;
    for (const m of rm?.rows ?? []) {
      linked.add(str(m, "route_from_page"));
      linked.add(str(m, "route_to_page"));
    }
    // Links by page id in widget code and menu URLs.
    const ws =
      widgets ?? (await read(ctx, "sp_widget", NEWEST, WIDGET_FIELDS, limit));
    const urls = await read(
      ctx,
      "sp_rectangle_menu_item",
      "urlLIKEid=",
      ["url"],
      DOMAIN_CHILD_MAX,
    );
    const text = [
      ...(ws?.rows ?? []).map(widgetText),
      ...(urls?.rows ?? []).map((u) => str(u, "url")),
    ].join("\n");
    if (!portals && !items && !rm) {
      need(
        ctx,
        null,
        "sp_portal",
        "sp_rectangle_menu_item",
        "sp_page_route_map",
      );
    }
    if (!complete) {
      // A partial reference read cannot prove a page unlinked.
      out.scanned("portal-orphan-page", 0, true);
      return;
    }
    for (const p of pages.rows) {
      if (linked.has(str(p, "sys_id"))) continue;
      if (quoted(text, str(p, "id"))) continue;
      out.add(
        "portal-orphan-page",
        refOf("sp_page", "sp_page", p, "id"),
        "No portal, menu item, route map or swept widget links this page: it is reachable only by a typed URL. Link it or retire it.",
      );
    }
    ctx.caveats.add(
      "portal-orphan-page searches the newest widgets' code and menu URLs for the page id; links from emails, knowledge articles or other scripts are not searched.",
    );
  });
}

interface RouteLoop {
  portal?: string;
  maps: SnRecord[];
  pages: string[];
}

/** Cycles among the effective route maps of each portal context. */
export function routeLoops(rows: SnRecord[]): RouteLoop[] {
  const portalsOf = (m: SnRecord): string[] =>
    str(m, "portals")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
  const contexts = new Set<string>([""]);
  for (const m of rows) for (const p of portalsOf(m)) contexts.add(p);
  const loops: RouteLoop[] = [];
  const seen = new Set<string>();
  for (const ctx of contexts) {
    // The first map (lowest order) per source page wins.
    const next = new Map<string, SnRecord>();
    const sorted = [...rows].sort(
      (a, b) => Number(str(a, "order")) - Number(str(b, "order")),
    );
    for (const m of sorted) {
      const ps = portalsOf(m);
      if (ps.length && (!ctx || !ps.includes(ctx))) continue;
      const from = str(m, "route_from_page");
      if (from && str(m, "route_to_page") && !next.has(from)) next.set(from, m);
    }
    const done = new Set<string>();
    for (const start of next.keys()) {
      const path: string[] = [];
      const onPath = new Map<string, number>();
      let page: string | undefined = start;
      while (page && next.has(page) && !done.has(page)) {
        if (onPath.has(page)) {
          const cyclePages = path.slice(onPath.get(page));
          const cycleMaps = cyclePages.map((p) => next.get(p)!);
          const key = cycleMaps
            .map((m) => str(m, "sys_id"))
            .sort()
            .join(",");
          if (!seen.has(key)) {
            seen.add(key);
            // The all-portals context runs first, so a cycle of global maps
            // is reported once, without a portal.
            const global = cycleMaps.every((m) => !portalsOf(m).length);
            loops.push({
              ...(global ? {} : { portal: ctx }),
              maps: cycleMaps,
              pages: [...cyclePages, page],
            });
          }
          break;
        }
        onPath.set(page, path.length);
        path.push(page);
        page = str(next.get(page)!, "route_to_page");
      }
      for (const p of path) done.add(p);
    }
  }
  return loops;
}
