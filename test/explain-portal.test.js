// P-16 — servicenow_explain_portal: a fixture portal whose home page renders
// its full layout (container → row → column → instance, with a nested row),
// widget option values mapped against option_schema names, widget
// dependencies, theme / menu / route maps, unreadable and policy-denied
// tables as caveats, the depth cut-off, the Mermaid golden, and the
// markdown / file / page formats. Every read goes through withMetadataFetch.
// Regenerate the golden deliberately with `UPDATE_GOLDEN=1 npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runSpec } from "../build/mcp/define.js";
import {
  ALL_TOOLS,
  PACKAGES,
  resolveEnabledPackages,
} from "../build/mcp/registry.js";
import { lintMermaid } from "./mermaid-lint.js";
import {
  baselineEnv,
  jsonResponse,
  withEnv,
  withMetadataFetch,
} from "./helpers.js";

baselineEnv();

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "explain",
);

const id = (c) => c.repeat(32);
const PORTAL = id("a");
const HOME = id("b");
const LOGIN = id("c");
const CAT = id("d");
const THEME = id("e");
const MENU = id("f");
const W1 = id("1");
const W2 = id("2");
const HDR = "ab".repeat(16);
const FTR = "cd".repeat(16);

/** The fixture instance: table name → rows. */
function fixture() {
  return {
    sp_portal: [
      {
        sys_id: PORTAL,
        url_suffix: "acme",
        title: "Acme Portal",
        homepage: HOME,
        login_page: LOGIN,
        notfound_page: "",
        theme: THEME,
        sp_rectangle_menu: MENU,
      },
    ],
    sp_theme: [{ sys_id: THEME, name: "Acme Theme", header: HDR, footer: FTR }],
    sp_header_footer: [
      { sys_id: HDR, id: "acme-header", name: "Acme Header" },
      { sys_id: FTR, id: "acme-footer", name: "Acme Footer" },
    ],
    m2m_sp_theme_js_include: [
      { sys_id: "tj1", sp_theme: THEME, sp_js_include: id("7"), order: "100" },
    ],
    m2m_sp_theme_css_include: [
      { sys_id: "tc1", sp_theme: THEME, sp_css_include: id("8"), order: "100" },
    ],
    sp_js_include: [
      {
        sys_id: id("7"),
        display_name: "acme-analytics",
        source: "url",
        url: "https://cdn.example.com/a.js",
        sys_ui_script: "",
      },
      {
        sys_id: id("9"),
        display_name: "chart.js",
        source: "local",
        url: "",
        sys_ui_script: id("5"),
      },
    ],
    sp_css_include: [
      { sys_id: id("8"), name: "acme-fonts", source: "url", url: "f.css" },
      { sys_id: id("6"), name: "chart.css", source: "local", sp_css: id("4") },
    ],
    sp_instance_menu: [{ sys_id: MENU, title: "Acme Menu" }],
    sp_rectangle_menu_item: [
      {
        sys_id: "mi1",
        sp_rectangle_menu: MENU,
        label: "Home",
        type: "page",
        url: "",
        sp_page: HOME,
        order: "100",
      },
      {
        sys_id: "mi2",
        sp_rectangle_menu: MENU,
        label: "Catalog",
        type: "page",
        url: "",
        sp_page: CAT,
        order: "200",
      },
    ],
    sp_page_route_map: [
      {
        sys_id: "rm1",
        short_description: "Catalog to home",
        route_from_page: CAT,
        route_to_page: HOME,
        portals: PORTAL,
        active: "true",
        roles: "",
        order: "100",
      },
    ],
    sp_page: [
      {
        sys_id: HOME,
        id: "index",
        title: "Home",
        public: "true",
        roles: "",
        draft: "false",
      },
      {
        sys_id: LOGIN,
        id: "login",
        title: "Login",
        public: "true",
        roles: "",
        draft: "false",
      },
      {
        sys_id: CAT,
        id: "sc_home",
        title: "Catalog",
        public: "false",
        roles: "itil",
        draft: "false",
      },
    ],
    sp_container: [
      {
        sys_id: "c1",
        sp_page: HOME,
        name: "Main",
        order: "100",
        width: "container",
      },
      {
        sys_id: "c2",
        sp_page: LOGIN,
        name: "",
        order: "100",
        width: "container-fluid",
      },
    ],
    sp_row: [
      { sys_id: "r1", sp_container: "c1", sp_column: "", order: "100" },
      { sys_id: "r2", sp_container: "", sp_column: "col2", order: "100" },
      { sys_id: "r3", sp_container: "c2", sp_column: "", order: "100" },
    ],
    sp_column: [
      { sys_id: "col2", sp_row: "r1", size: "4", order: "200" },
      { sys_id: "col1", sp_row: "r1", size: "8", order: "100" },
      { sys_id: "col3", sp_row: "r2", size: "12", order: "100" },
      { sys_id: "col4", sp_row: "r3", size: "12", order: "100" },
    ],
    sp_instance: [
      {
        sys_id: "i1",
        sp_column: "col1",
        sp_widget: W1,
        title: "Welcome",
        order: "100",
        widget_parameters: JSON.stringify({
          title: "Hello",
          limit: { value: "5", displayValue: "5" },
          extra: true,
        }),
      },
      {
        sys_id: "i2",
        sp_column: "col3",
        sp_widget: W2,
        title: "",
        order: "100",
        widget_parameters: "{bad json",
      },
      {
        sys_id: "i3",
        sp_column: "col4",
        sp_widget: W2,
        title: "",
        order: "100",
        widget_parameters: "",
      },
    ],
    sp_widget: [
      {
        sys_id: W1,
        id: "acme-hello",
        name: "Hello World",
        data_table: "sp_instance",
        option_schema: JSON.stringify([
          { name: "title", label: "Title", type: "string" },
          {
            name: "limit",
            label: "Limit",
            type: "integer",
            default_value: "10",
          },
          { name: "color", type: "string" },
        ]),
      },
      {
        sys_id: W2,
        id: "login",
        name: "Login",
        data_table: "sp_instance",
        option_schema: "",
      },
    ],
    m2m_sp_widget_dependency: [
      { sys_id: "wd1", sp_widget: W1, sp_dependency: id("3") },
    ],
    sp_dependency: [
      {
        sys_id: id("3"),
        name: "Charts",
        module: "chartModule",
        include_on_page_load: "true",
      },
    ],
    m2m_sp_dependency_js_include: [
      {
        sys_id: "dj1",
        sp_dependency: id("3"),
        sp_js_include: id("9"),
        order: "1",
      },
    ],
    m2m_sp_dependency_css_include: [
      {
        sys_id: "dc1",
        sp_dependency: id("3"),
        sp_css_include: id("6"),
        order: "1",
      },
    ],
    m2m_sp_ng_pro_sp_widget: [
      { sys_id: "np1", sp_widget: W1, sp_angular_provider: id("0") },
    ],
    sp_angular_provider: [
      { sys_id: id("0"), name: "acmeTooltip", type: "directive" },
    ],
    sp_ng_template: [{ sys_id: "t1", id: "hello-item.html", sp_widget: W1 }],
    sys_db_object: [],
  };
}

/** One encoded-query term against a row. */
function matchTerm(row, term) {
  let m;
  if ((m = /^(\w+)IN(.*)$/.exec(term))) {
    return m[2].split(",").includes(String(row[m[1]] ?? ""));
  }
  if ((m = /^(\w+)LIKE(.*)$/.exec(term))) {
    return String(row[m[1]] ?? "").includes(m[2]);
  }
  if ((m = /^(\w+)ISEMPTY$/.exec(term))) return !row[m[1]];
  if ((m = /^(\w+)=(.*)$/.exec(term))) return String(row[m[1]] ?? "") === m[2];
  throw new Error(`unsupported term ${term}`);
}

/** A tiny encoded-query evaluator: `a^b^ORc^ORDERBYx` (OR binds tighter). */
function matches(row, query) {
  const body = query.split("^ORDERBY")[0];
  if (!body) return true;
  return body
    .split("^")
    .reduce((groups, part) => {
      if (part.startsWith("OR") && groups.length) {
        groups.at(-1).push(part.slice(2));
      } else groups.push([part]);
      return groups;
    }, [])
    .every((group) => group.some((t) => matchTerm(row, t)));
}

/**
 * A Table API mock over `tables`; `status[table]` answers that table with an
 * error. Records every table read in `reads`.
 */
function instance(tables = fixture(), status = {}) {
  const reads = [];
  const handler = (url) => {
    const u = new URL(url);
    const m = u.pathname.match(/\/api\/now\/table\/([^/]+)$/);
    assert.ok(m, `unexpected request ${url}`);
    const table = m[1];
    reads.push(table);
    if (status[table]) {
      return jsonResponse(status[table], {
        error: { message: `denied ${table}`, detail: "ACL" },
      });
    }
    const query = u.searchParams.get("sysparm_query") ?? "";
    const fields = u.searchParams.get("sysparm_fields")?.split(",");
    const limit = Number(u.searchParams.get("sysparm_limit") ?? 1000);
    const rows = (tables[table] ?? [])
      .filter((r) => matches(r, query))
      .slice(0, limit)
      .map((r) =>
        fields
          ? Object.fromEntries(
              fields.filter((f) => f in r).map((f) => [f, r[f]]),
            )
          : r,
      );
    return jsonResponse(200, { result: rows });
  };
  return { handler, reads };
}

const spec = ALL_TOOLS.find((s) => s.name === "servicenow_explain_portal");
const explain = (args, extra) => runSpec(spec, args, extra);
const payload = (result) => {
  assert.equal(result.isError, undefined, result.content[0].text);
  return JSON.parse(result.content[0].text);
};

async function run(args, mock = instance(), extra) {
  return withMetadataFetch(mock.handler, () => explain(args, extra));
}

test("explain_portal lives in the opt-in ui package", () => {
  assert.ok(spec, "tool registered");
  assert.equal(spec.package, "ui");
  assert.equal(spec.annotations.readOnlyHint, true);
  const ui = PACKAGES.find((p) => p.name === "ui");
  assert.deepEqual(
    ui.tools.map((t) => t.name),
    ["servicenow_explain_portal", "servicenow_explain_ui_experience"],
  );
  for (const profile of ["core", "reader", "developer"]) {
    assert.equal(resolveEnabledPackages([profile]).has("ui"), false, profile);
  }
  assert.equal(resolveEnabledPackages(["all"]).has("ui"), true);
  assert.equal(PACKAGES.at(-1).name, "admin");
});

test("the fixture portal home page renders its full layout", async () => {
  const res = payload(await run({ portal: "acme" }));
  assert.equal(res.mode, "portal");
  assert.equal(res.verified, false);
  assert.equal(res.portal.title, "Acme Portal");
  assert.deepEqual(
    res.pages.map((p) => [p.id, p.roles_in_portal]),
    [
      ["index", ["homepage", "menu", "route_to"]],
      ["login", ["login_page"]],
      ["sc_home", ["menu", "route_from"]],
    ],
  );
  const home = res.pages[0];
  assert.equal(home.layout.length, 1);
  const [container] = home.layout;
  assert.equal(container.name, "Main");
  assert.equal(container.width, "container");
  const [row] = container.rows;
  assert.deepEqual(
    row.columns.map((c) => [c.sys_id, c.size]),
    [
      ["col1", "8"],
      ["col2", "4"],
    ],
  );
  const [col1, col2] = row.columns;
  assert.equal(col1.instances[0].widget.name, "Hello World");
  assert.equal(col1.instances[0].title, "Welcome");
  // The nested row inside column 2.
  assert.equal(col2.instances.length, 0);
  assert.equal(col2.rows[0].sys_id, "r2");
  assert.equal(col2.rows[0].columns[0].instances[0].widget.name, "Login");
  // A page with no containers still reports an (empty) layout.
  assert.deepEqual(res.pages[2].layout, []);
  assert.deepEqual(res.counts, {
    pages: 3,
    containers: 2,
    rows: 3,
    columns: 4,
    instances: 3,
    widgets: 2,
    dependencies: 1,
  });
});

test("widget option values match option_schema names", async () => {
  const res = payload(await run({ portal: PORTAL }));
  const inst = res.pages[0].layout[0].rows[0].columns[0].instances[0];
  assert.equal(inst.parametersDecoded, true);
  assert.deepEqual(inst.options, [
    {
      name: "title",
      label: "Title",
      type: "string",
      set: true,
      value: "Hello",
    },
    {
      name: "limit",
      label: "Limit",
      type: "integer",
      set: true,
      value: "5",
      default: "10",
    },
    { name: "color", type: "string", set: false },
  ]);
  assert.deepEqual(inst.unknownOptions, { extra: true });
  const w1 = res.widgets.find((w) => w.id === "acme-hello");
  assert.deepEqual(
    w1.optionSchema.map((o) => o.name),
    inst.options.map((o) => o.name),
  );
  // Undecodable parameters stay raw and never fail the call.
  const bad =
    res.pages[0].layout[0].rows[0].columns[1].rows[0].columns[0].instances[0];
  assert.equal(bad.parametersDecoded, false);
  assert.equal(bad.parametersRaw, "{bad json");
  assert.ok(bad.parametersReason);
  assert.deepEqual(bad.options, []);
  assert.ok(res.caveats.some((c) => /widget_parameters only/.test(c)));
});

test("widget dependencies, theme, menu and route maps are resolved", async () => {
  const res = payload(await run({ portal: "acme" }));
  const w1 = res.widgets.find((w) => w.id === "acme-hello");
  assert.equal(w1.instances, 1);
  assert.deepEqual(w1.dependencies, [
    {
      sys_id: id("3"),
      name: "Charts",
      module: "chartModule",
      include_on_page_load: "true",
      jsIncludes: [
        { sys_id: id("9"), name: "chart.js", source: "local", ref: id("5") },
      ],
      cssIncludes: [
        { sys_id: id("6"), name: "chart.css", source: "local", ref: id("4") },
      ],
    },
  ]);
  assert.deepEqual(w1.providers, [
    { sys_id: id("0"), name: "acmeTooltip", type: "directive" },
  ]);
  assert.deepEqual(w1.templates, [{ sys_id: "t1", id: "hello-item.html" }]);
  const w2 = res.widgets.find((w) => w.id === "login");
  assert.equal(w2.instances, 2);
  assert.deepEqual(w2.optionSchema, []);
  assert.equal(res.theme.name, "Acme Theme");
  assert.equal(res.theme.header.name, "Acme Header");
  assert.equal(res.theme.footer.id, "acme-footer");
  assert.equal(res.theme.jsIncludes[0].url, "https://cdn.example.com/a.js");
  assert.equal(res.theme.cssIncludes[0].name, "acme-fonts");
  assert.deepEqual(
    res.menu.items.map((i) => [i.label, i.page]),
    [
      ["Home", HOME],
      ["Catalog", CAT],
    ],
  );
  assert.deepEqual(res.routeMaps, [
    {
      sys_id: "rm1",
      short_description: "Catalog to home",
      route_from_page: CAT,
      route_to_page: HOME,
      active: "true",
    },
  ]);
  // The instance returned no widget `script` etc. — metadata fields only.
  assert.equal(res.missingFields, undefined);
});

test("an unreadable table becomes a caveat, never a failure", async () => {
  const mock = instance(fixture(), {
    sp_angular_provider: 403,
    m2m_sp_widget_dependency: 400,
  });
  const res = payload(await run({ portal: "acme" }, mock));
  const w1 = res.widgets.find((w) => w.id === "acme-hello");
  assert.deepEqual(w1.dependencies, []);
  assert.deepEqual(w1.providers, [{ sys_id: id("0") }]);
  assert.deepEqual(
    res.unreadable.map((u) => [u.table, u.status]),
    [
      ["m2m_sp_widget_dependency", 400],
      ["sp_angular_provider", 403],
    ],
  );
  assert.ok(
    res.caveats.some((c) =>
      /^sp_angular_provider could not be read \(403\)/.test(c),
    ),
  );
  // The layout is intact.
  assert.equal(res.counts.instances, 3);
});

test("a policy-denied table is a caveat and is never requested", async () => {
  const mock = instance();
  const res = await withEnv({ SN_TABLES_DENY: "sp_theme,sp_ng_template" }, () =>
    run({ portal: "acme" }, mock),
  );
  const out = payload(res);
  assert.equal(out.theme, null);
  assert.deepEqual(out.widgets[0].templates, []);
  assert.deepEqual(
    out.unreadable.map((u) => u.table),
    ["sp_theme", "sp_ng_template"],
  );
  assert.match(out.unreadable[0].reason, /SN_TABLES_DENY/);
  assert.equal(mock.reads.includes("sp_theme"), false);
  assert.equal(mock.reads.includes("sp_ng_template"), false);
});

test("depth bounds nested rows and says so", async () => {
  const res = payload(await run({ portal: "acme", depth: 1 }));
  const col2 = res.pages[0].layout[0].rows[0].columns[1];
  assert.deepEqual(col2.rows, []);
  assert.equal(col2.rowsOmitted, 1);
  assert.equal(res.depth, 1);
  assert.ok(res.caveats.some((c) => /below depth 1/.test(c)));
  assert.equal(res.counts.instances, 2);
});

test("the Mermaid layout tree matches its golden", async () => {
  const res = payload(await run({ portal: "acme", format: "mermaid" }));
  lintMermaid(res.mermaid);
  assert.equal(res.mermaidTruncated, undefined);
  assert.equal(res.verified, false);
  const file = path.join(FIXTURES, "portal.mmd");
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, `${res.mermaid}\n`);
  } else {
    assert.equal(`${res.mermaid}\n`, readFileSync(file, "utf8"));
  }
});

test("a capped diagram carries the mermaidTruncated signal", async () => {
  const res = await withEnv({ SN_DIAGRAM_MAX_NODES: "5" }, () =>
    run({ portal: "acme", format: "mermaid" }),
  );
  const out = payload(res);
  assert.ok(out.mermaidTruncated > 0);
  assert.match(out.mermaid, /more_nodes\["\+\d+ more"\]/);
  lintMermaid(out.mermaid);
});

test("markdown renders the tree, options, dependencies and caveats", async () => {
  const res = payload(await run({ portal: "acme", format: "markdown" }));
  const md = res.markdown;
  assert.match(md, /^# Portal Acme Portal \(\/acme\)/);
  assert.match(md, /## Theme/);
  assert.match(md, /## Menu Acme Menu/);
  assert.match(md, /### Home \(index\) · homepage, menu, route_to/);
  assert.match(md, /- \*\*Welcome · Hello World\*\*/);
  assert.match(md, /title = Hello/);
  assert.match(md, /extra = true _\(not in option_schema\)_/);
  assert.match(md, /widget_parameters did not decode/);
  assert.match(md, /Dependency Charts: chart\.js, chart\.css/);
  assert.match(md, /Angular provider acmeTooltip \(directive\)/);
  assert.match(md, /ng-template hello-item\.html/);
  assert.match(md, /Catalog to home: d{32} → b{32}/);
  assert.match(md, /```mermaid\nflowchart TD/);
  assert.match(md, /## Caveats\n\n- Service Portal tables are verified:false/);
  assert.deepEqual(Object.keys(res).sort(), [
    "caveats",
    "counts",
    "markdown",
    "mode",
    "verified",
  ]);
});

test("format:file writes the full JSON with the diagram", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sn-p16-"));
  try {
    const res = await withEnv({ SN_DOCS_DIR: dir }, () =>
      run({ portal: "acme", format: "file" }),
    );
    const out = payload(res);
    assert.equal(out.format, "file");
    assert.equal(out.pages_count, 3);
    const written = JSON.parse(readFileSync(out.file, "utf8"));
    assert.equal(written.portal.url_suffix, "acme");
    assert.match(written.mermaid, /^flowchart TD/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("page mode explains one page with its route maps", async () => {
  const res = payload(await run({ page: "index" }));
  assert.equal(res.mode, "page");
  assert.equal(res.portal, undefined);
  assert.deepEqual(
    res.pages.map((p) => [p.id, p.roles_in_portal]),
    [["index", ["page"]]],
  );
  assert.equal(res.pages[0].layout[0].rows[0].columns.length, 2);
  assert.equal(res.routeMaps.length, 1);
  const md = payload(await run({ page: "index", format: "markdown" })).markdown;
  assert.match(md, /^# Page Home \(index\) · page/);
  const mmd = payload(await run({ page: HOME, format: "mermaid" })).mermaid;
  lintMermaid(mmd);
  assert.match(mmd, /pg_b{32}\["Page: Home \(index\) · page"\]/);
});

test("more pages than the layout limit are listed without a layout", async () => {
  const tables = fixture();
  for (let n = 0; n < 5; n++) {
    const pid = `${n}`.repeat(1) + "e".repeat(31);
    tables.sp_page.push({ sys_id: pid, id: `p${n}`, title: `P${n}` });
    tables.sp_rectangle_menu_item.push({
      sys_id: `mx${n}`,
      sp_rectangle_menu: MENU,
      label: `P${n}`,
      sp_page: pid,
      order: `${300 + n}`,
    });
  }
  const res = payload(await run({ portal: "acme" }, instance(tables)));
  assert.equal(res.pages.length, 8);
  assert.equal(res.pages.filter((p) => p.layout).length, 5);
  assert.equal(res.pages.at(-1).layoutOmitted, true);
  assert.ok(res.caveats.some((c) => /8 pages found/.test(c)));
  const md = payload(
    await run({ portal: "acme", format: "markdown" }, instance(tables)),
  ).markdown;
  assert.match(md, /_Layout not read \(page limit\)\._/);
});

test("fields the instance did not return are listed per table", async () => {
  const tables = fixture();
  for (const c of tables.sp_column) delete c.size;
  const res = payload(await run({ portal: "acme" }, instance(tables)));
  assert.deepEqual(res.missingFields, { sp_column: ["size"] });
  const md = payload(
    await run({ portal: "acme", format: "markdown" }, instance(tables)),
  ).markdown;
  assert.match(md, /sp_column: fields not returned: size/);
});

test("invalid arguments and a missing portal fail cleanly", async () => {
  for (const args of [{}, { portal: "acme", page: "index" }]) {
    const res = await run(args);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /exactly one of 'portal'/);
  }
  const missing = await run({ portal: "nope" });
  assert.equal(missing.isError, true);
  assert.match(
    missing.content[0].text,
    /No sp_portal record matches url_suffix 'nope'/,
  );
  const caret = await run({ page: "a^b" });
  assert.equal(caret.isError, true);
});

test("an unreadable root table degrades with availability", async () => {
  const mock = instance(fixture(), { sp_portal: 400 });
  const res = payload(await run({ portal: "acme" }, mock));
  assert.equal(res.degraded.table, "sp_portal");
  assert.equal(res.degraded.status, 400);
  assert.equal(res.available, false);
  assert.deepEqual(res.pages, []);
  const page = payload(
    await run(
      { page: "index" },
      instance(fixture(), { sp_page: 403, sys_db_object: 403 }),
    ),
  );
  assert.equal(page.degraded.table, "sp_page");
  assert.equal(page.available, undefined);
  // A non-degradable instance error still fails.
  const boom = await run(
    { portal: "acme" },
    instance(fixture(), { sp_widget: 500 }),
  );
  assert.equal(boom.isError, true);
});

test("progress is reported per read and a cancelled call stops", async () => {
  const sent = [];
  const extra = {
    requestId: 1,
    _meta: { progressToken: "p16" },
    sendNotification: async (n) => {
      sent.push(n);
    },
  };
  payload(await run({ portal: "acme" }, instance(), extra));
  assert.ok(sent.length > 0);
  assert.equal(sent[0].params.progressToken, "p16");
  const controller = new AbortController();
  controller.abort();
  const mock = instance();
  const res = await run({ portal: "acme" }, mock, {
    signal: controller.signal,
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /cancel/i);
  assert.deepEqual(mock.reads, []);
});
