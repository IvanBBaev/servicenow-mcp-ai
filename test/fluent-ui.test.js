// P-28 — portal, workspace and catalog Fluent emitters: goldens over
// registry-shaped inputs, a TypeScript parse of every emitted .ts file,
// determinism under shuffled children, secret placeholders, the unsupported[]
// reporting of rows that do not fit the tree, UI Builder internals staying
// Record(), and servicenow_generate_fluent end to end with the unverified
// warning.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { emitFluent, SECRET_PLACEHOLDER } from "../build/api/fluent.js";
import {
  UI_EMITTERS,
  UI_VERIFIED_NOTE,
  uiFallbackReason,
} from "../build/api/fluent-ui.js";
import {
  ARTIFACT_TYPES,
  getArtifactType,
} from "../build/core/artifacts/registry.js";
import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fluent",
);
const SDK_OFF = { SN_SDK_MANAGED_SCOPES: undefined, SN_SDK_PROJECT_DIRS: "" };
const NO_REDACT = { SN_REDACT_FIELDS: undefined, SN_REDACT_PII: undefined };

const id = (c) => c.repeat(32);
/** A distinct 32-char sys_id from a short tag (hex, deterministic). */
const sid = (tag) => tag.padEnd(32, "0");
const SCOPE = { sys_id: id("5"), scope: "x_acme_app" };
const S = SCOPE.sys_id;

const child = (table, parentField, records, extra = {}) => ({
  table,
  parentField,
  verified: false,
  count: records.length,
  records,
  ...extra,
});
const one = (type, record, children = []) => ({
  type,
  sources: [{ scope: SCOPE, record: { sys_scope: S, ...record }, children }],
});

const WIDGET = sid("a1");
const PAGE = sid("b1");
const ITEM = sid("c1");
const SET = sid("c2");

/** Registry-shaped inputs (what getArtifactFor returns), one per golden. */
const CASES = {
  ui_sp_widget: one(
    "sp_widget",
    {
      sys_id: WIDGET,
      id: "acme-hello",
      name: "Acme hello",
      category: "custom",
      controller_as: "c",
      public: "false",
      roles: "itil, admin",
      has_preview: "true",
      option_schema: '[{"name":"title","type":"string","label":"Title"}]',
      demo_data: "not json",
      template: "<div>{{c.data.msg}}</div>",
      script: "data.msg = 'hi';",
      client_script: "api.controller = function() {};",
      css: ".x { color: red; }",
      link: "function link(scope) {}",
      internal_notes: "kept? no, reported",
    },
    [
      child("sp_ng_template", "sp_widget", [
        {
          sys_id: sid("a2"),
          sp_widget: WIDGET,
          id: "acme-row.html",
          template: "<li>{{item}}</li>",
        },
      ]),
      child("m2m_sp_widget_dependency", "sp_widget", [
        { sys_id: sid("a3"), sp_widget: WIDGET, sp_dependency: sid("d1") },
        { sys_id: sid("a4"), sp_widget: WIDGET, sp_dependency: "" },
      ]),
      child("m2m_sp_ng_pro_sp_widget", "sp_widget", [
        {
          sys_id: sid("a5"),
          sp_widget: WIDGET,
          sp_angular_provider: sid("d2"),
        },
      ]),
    ],
  ),
  ui_sp_header_footer: one("sp_header_footer", {
    sys_id: sid("a6"),
    id: "acme-header",
    name: "Acme header",
    template: "<header></header>",
    script: "data.user = gs.getUserName();",
  }),
  ui_sp_page: one(
    "sp_page",
    {
      sys_id: PAGE,
      id: "acme_home",
      title: "Acme home",
      public: "true",
      css: ".home { margin: 0; }",
    },
    [
      child("sp_container", "sp_page", [
        {
          sys_id: sid("b2"),
          sp_page: PAGE,
          name: "Main",
          width: "container",
          order: "1",
        },
      ]),
      child("sp_row", "sp_container", [
        { sys_id: sid("b3"), sp_container: sid("b2"), order: "1" },
        // An orphan: its container is not on this page.
        { sys_id: sid("b9"), sp_container: sid("ff"), order: "2" },
      ]),
      child("sp_column", "sp_row", [
        { sys_id: sid("b5"), sp_row: sid("b3"), size: "6", order: "2" },
        { sys_id: sid("b4"), sp_row: sid("b3"), size: "6", order: "1" },
      ]),
      child("sp_instance", "sp_column", [
        {
          sys_id: sid("b6"),
          sp_column: sid("b4"),
          sp_widget: WIDGET,
          widget_parameters: '{"title":"Hello","limit":5}',
          title: "Hello",
          order: "1",
          active: "true",
        },
      ]),
    ],
  ),
  ui_sp_portal: one("sp_portal", {
    sys_id: sid("e1"),
    title: "Acme portal",
    url_suffix: "acme",
    homepage: PAGE,
    theme: sid("e2"),
    sp_rectangle_menu: sid("e3"),
    default: "false",
    quick_start_config: '{"steps":[]}',
    css_variables: "$brand: #123;",
  }),
  ui_sp_theme: one(
    "sp_theme",
    {
      sys_id: sid("e2"),
      name: "Acme theme",
      css_variables: "$navbar: #000;",
      header: sid("a6"),
      navbarfixed: "true",
    },
    [
      child("m2m_sp_theme_js_include", "sp_theme", [
        {
          sys_id: sid("e4"),
          sp_theme: sid("e2"),
          sp_js_include: sid("e5"),
          order: "200",
        },
        {
          sys_id: sid("e6"),
          sp_theme: sid("e2"),
          sp_js_include: sid("e7"),
          order: "100",
        },
      ]),
      child("m2m_sp_theme_css_include", "sp_theme", [
        {
          sys_id: sid("e8"),
          sp_theme: sid("e2"),
          sp_css_include: sid("e9"),
          order: "100",
        },
      ]),
    ],
  ),
  ui_sp_menu: one(
    "sp_menu",
    {
      sys_id: sid("e3"),
      title: "Acme menu",
      sp_widget: sid("f1"),
      order: "10",
    },
    [
      child("sp_rectangle_menu_item", "sp_rectangle_menu", [
        {
          sys_id: sid("f2"),
          sp_rectangle_menu: sid("e3"),
          label: "Home",
          type: "page",
          sp_page: PAGE,
          order: "100",
        },
        {
          sys_id: sid("f3"),
          sp_rectangle_menu: sid("e3"),
          label: "Docs",
          type: "url",
          url: "https://example.com/docs",
          order: "200",
        },
      ]),
    ],
  ),
  ui_sp_page_route_map: one("sp_page_route_map", {
    sys_id: sid("f4"),
    short_description: "Route form to acme",
    route_from_page: sid("f5"),
    route_to_page: PAGE,
    portals: `${sid("e1")},${sid("e0")}`,
    active: "true",
    order: "100",
  }),
  ui_workspace: one(
    "workspace",
    {
      sys_id: sid("10"),
      title: "Acme workspace",
      path: "acme",
      active: "true",
      root_macroponent: sid("11"),
      admin_panel: sid("12"),
    },
    [
      child("sys_ux_page_property", "page", [
        {
          sys_id: sid("13"),
          page: sid("10"),
          name: "chrome_toolbar",
          value: '{"items":[]}',
          type: "json",
        },
      ]),
    ],
  ),
  ui_dashboard: one(
    "dashboard",
    { sys_id: sid("20"), name: "Acme dashboard", active: "true" },
    [
      child("par_dashboard_tab", "dashboard", [
        {
          sys_id: sid("21"),
          dashboard: sid("20"),
          name: "Overview",
          order: "1",
        },
      ]),
      child("par_dashboard_widget", "tab", [
        {
          sys_id: sid("22"),
          tab: sid("21"),
          component: "sn-chart",
          h: "4",
          w: "6",
        },
      ]),
      child("par_dashboard_permission", "dashboard", [
        {
          sys_id: sid("23"),
          dashboard: sid("20"),
          role: "itil",
          owner: "false",
        },
      ]),
    ],
  ),
  ui_list_menu: one(
    "ux_list_menu_config",
    { sys_id: sid("30"), name: "Acme lists", description: "Lists" },
    [
      child("sys_ux_list_category", "configuration", [
        {
          sys_id: sid("31"),
          configuration: sid("30"),
          title: "Open",
          order: "1",
        },
      ]),
      child("sys_ux_list", "category", [
        {
          sys_id: sid("32"),
          category: sid("31"),
          title: "Open incidents",
          table: "incident",
          condition: "active=true",
          order: "1",
        },
      ]),
    ],
  ),
  ui_applicability: one(
    "ux_applicability",
    { sys_id: sid("40"), name: "Agents", active: "true", roles: "itil" },
    [
      child("sys_ux_applicability_m2m_list", "applicability", [
        { sys_id: sid("41"), applicability: sid("40"), list: sid("32") },
      ]),
    ],
  ),
  ui_catalog_item: one(
    "catalog_item",
    {
      sys_id: ITEM,
      name: "Acme laptop",
      short_description: "Request a laptop",
      active: "true",
      category: sid("c3"),
      sc_catalogs: sid("c4"),
      price: "1200",
      no_quantity: "true",
    },
    [
      child("item_option_new", "cat_item", [
        {
          sys_id: sid("c5"),
          cat_item: ITEM,
          name: "model",
          type: "5",
          question_text: "Model",
          order: "100",
          mandatory: "true",
        },
        {
          sys_id: sid("c6"),
          cat_item: ITEM,
          name: "justification",
          type: "2",
          question_text: "Why?",
          order: "200",
        },
        {
          sys_id: sid("c7"),
          cat_item: ITEM,
          name: "model",
          type: "6",
          question_text: "Model (again)",
          order: "300",
        },
        {
          sys_id: sid("c8"),
          cat_item: ITEM,
          name: "odd",
          type: "99",
          question_text: "Unknown type",
          order: "400",
        },
      ]),
      child("question_choice", "question", [
        {
          sys_id: sid("c9"),
          question: sid("c5"),
          value: "pro",
          text: "Pro",
          order: "2",
        },
        {
          sys_id: sid("ca"),
          question: sid("c5"),
          value: "air",
          text: "Air",
          order: "1",
        },
        {
          sys_id: sid("cb"),
          question: sid("d9"),
          value: "x",
          text: "Set choice",
          order: "1",
        },
      ]),
      child("io_set_item", "sc_cat_item", [
        {
          sys_id: sid("cc"),
          sc_cat_item: ITEM,
          variable_set: SET,
          order: "100",
        },
      ]),
      child(
        "item_option_new_set",
        "sys_id",
        [
          {
            sys_id: SET,
            title: "Delivery",
            internal_name: "delivery",
            order: "100",
          },
        ],
        { parentTable: "io_set_item" },
      ),
      child(
        "item_option_new",
        "variable_set",
        [
          {
            sys_id: sid("d9"),
            variable_set: SET,
            name: "location",
            type: "3",
            question_text: "Where?",
            order: "100",
          },
        ],
        { parentTable: "io_set_item" },
      ),
      child("catalog_script_client", "cat_item", [
        {
          sys_id: sid("cd"),
          cat_item: ITEM,
          name: "Model onChange",
          applies_to: "item",
          type: "onChange",
          cat_variable: "IO:" + sid("c5"),
          ui_type: "10",
          active: "true",
          script: "function onChange() {}",
        },
      ]),
      child(
        "catalog_script_client",
        "variable_set",
        [
          {
            sys_id: sid("ce"),
            variable_set: SET,
            name: "Delivery onLoad",
            applies_to: "set",
            type: "onLoad",
            ui_type: "0",
            script: "function onLoad() {}",
          },
        ],
        { parentTable: "io_set_item" },
      ),
      child("catalog_ui_policy", "catalog_item", [
        {
          sys_id: sid("cf"),
          catalog_item: ITEM,
          short_description: "Hide justification",
          catalog_conditions: "IO:" + sid("c5") + "=air^EQ",
          on_load: "true",
          reverse_if_false: "true",
          order: "100",
        },
      ]),
      child("catalog_ui_policy", "variable_set", [], {
        parentTable: "io_set_item",
        redacted: true,
      }),
      child("catalog_ui_policy_action", "ui_policy", [
        {
          sys_id: sid("d1"),
          ui_policy: sid("cf"),
          catalog_variable: "IO:" + sid("c6"),
          visible: "false",
          mandatory: "ignore",
        },
      ]),
      child("sc_cat_item_category", "sc_cat_item", [
        { sys_id: sid("d2"), sc_cat_item: ITEM, sc_category: sid("c3") },
      ]),
      child(
        "sc_cat_item_user_criteria_mtom",
        "sc_cat_item",
        [{ sys_id: sid("d3"), sc_cat_item: ITEM, user_criteria: sid("d4") }],
        { truncated: true },
      ),
    ],
  ),
  ui_record_producer: one(
    "record_producer",
    {
      sys_id: sid("50"),
      name: "Report outage",
      table_name: "incident",
      script: "current.impact = 1;",
      redirect_url: "generated_record",
    },
    [
      child("item_option_new", "cat_item", [
        {
          sys_id: sid("51"),
          cat_item: sid("50"),
          name: "summary",
          type: "6",
          question_text: "Summary",
          map_to_field: "true",
          field: "short_description",
        },
      ]),
    ],
  ),
  ui_variable_set: one(
    "variable_set",
    { sys_id: SET, title: "Delivery", internal_name: "delivery" },
    [
      child("item_option_new", "variable_set", [
        {
          sys_id: sid("d9"),
          variable_set: SET,
          name: "location",
          type: "3",
          question_text: "Where?",
        },
      ]),
      child("io_set_item", "variable_set", [
        { sys_id: sid("cc"), sc_cat_item: ITEM, variable_set: SET },
      ]),
    ],
  ),
  ui_catalog_client_script: one("catalog_client_script", {
    sys_id: sid("60"),
    name: "Standalone onLoad",
    applies_to: "item",
    cat_item: ITEM,
    type: "onLoad",
    ui_type: "1",
    script: "function onLoad() { g_form.setValue('x', 1); }",
  }),
  ui_catalog_ui_policy: one(
    "catalog_ui_policy",
    {
      sys_id: sid("70"),
      short_description: "Make model mandatory",
      catalog_item: ITEM,
      script_true: "function onCondition() {}",
      run_scripts: "true",
    },
    [
      child("catalog_ui_policy_action", "ui_policy", [
        {
          sys_id: sid("71"),
          ui_policy: sid("70"),
          catalog_variable: "IO:" + sid("c5"),
          mandatory: "true",
        },
      ]),
    ],
  ),
};

function emitCase(name, rules = null) {
  const c = CASES[name];
  return emitFluent(getArtifactType(c.type), c.sources, c.type, rules);
}

function bundleText(b) {
  const parts = b.files.map((f) => `=== ${f.path}\n${f.content}`);
  parts.push(
    `=== (unsupported)\n${JSON.stringify(b.unsupported, null, 2)}\n` +
      `=== (secretsReplaced) ${b.secretsReplaced}\n`,
  );
  return parts.join("\n");
}

function golden(name, actual) {
  const file = path.join(FIXTURES, `${name}.golden.txt`);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  assert.equal(
    actual,
    readFileSync(file, "utf8"),
    `${name} drifted; regenerate deliberately with UPDATE_GOLDEN=1`,
  );
}

function parseErrors(file, content) {
  const sf = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return (sf.parseDiagnostics ?? []).map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, "\n"),
  );
}

const mainOf = (b) =>
  b.files.find((f) => f.path.endsWith(".now.ts") && !f.path.includes("keys"))
    .content;

for (const name of Object.keys(CASES)) {
  test(`fluent-ui golden: ${name}`, () => {
    golden(name, bundleText(emitCase(name)));
  });
}

test("every P-28 emitted .ts file parses as TypeScript", () => {
  for (const name of Object.keys(CASES)) {
    for (const f of emitCase(name).files) {
      if (!f.path.endsWith(".ts")) continue;
      assert.deepEqual(parseErrors(f.path, f.content), [], `${name} ${f.path}`);
    }
  }
  assert.notDeepEqual(parseErrors("x.ts", "SPPage({ a: 'b', "), []);
});

test("every UI emitter is a registry type whose sdkApi it calls", () => {
  for (const [type, e] of Object.entries(UI_EMITTERS)) {
    const t = getArtifactType(type);
    assert.ok(t, `${type} is a registry type`);
    assert.equal(e.api, t.sdkApi, type);
    assert.ok(
      ["portal", "next-experience", "catalog"].includes(t.group),
      `${type} ${t.group}`,
    );
  }
  // Every portal / workspace / catalog type with a real SDK API has an emitter.
  const missing = ARTIFACT_TYPES.filter(
    (t) =>
      ["portal", "next-experience", "catalog"].includes(t.group) &&
      t.sdkApi &&
      t.sdkApi !== "Record" &&
      t.sdkApi !== "none" &&
      t.type !== "sp_ng_template" &&
      !UI_EMITTERS[t.type],
  ).map((t) => t.type);
  assert.deepEqual(missing, []);
  // Every covered case uses its own API as a call.
  for (const name of Object.keys(CASES)) {
    const type = CASES[name].type;
    assert.match(
      mainOf(emitCase(name)),
      new RegExp(`^${UI_EMITTERS[type].api}\\(\\{`, "m"),
      name,
    );
  }
});

test("the SPPage layout tree nests containers, rows, columns and instances in order", () => {
  const text = mainOf(emitCase("ui_sp_page"));
  const at = (s) => text.indexOf(s);
  assert.ok(at("containers: [") < at("rows: ["));
  assert.ok(at("rows: [") < at("columns: ["));
  assert.ok(at("columns: [") < at("instances: ["));
  // Columns in order-field order, not input order.
  assert.ok(
    at(`sp_column_${sid("b4").slice(0, 8)}`) <
      at(`sp_column_${sid("b5").slice(0, 8)}`),
  );
  assert.match(text, /widget: Now\.ref\('sp_widget', 'a1/);
  assert.match(text, /widgetParameters: '\{"title":"Hello","limit":5\}',/);
  // The orphan row is not lost: Record() plus an unsupported[] entry.
  const b = emitCase("ui_sp_page");
  assert.match(text, /\/\/ child of sp_page_acme_home: sp_row\nRecord\(/);
  // SPPage takes no $id: its key is not declared (it would build as a DELETE).
  assert.ok(!b.keys.some((k) => k.table === "sp_page"));
  assert.match(
    text,
    /SPPage takes no \$id: now-sdk build gives the page a new sys_id/,
  );
  assert.deepEqual(
    b.unsupported.map((u) => [u.kind, u.table]),
    [["child", "sp_row"]],
  );
});

test("SPWidget sidecars, templates, dependencies and unmapped fields", () => {
  const b = emitCase("ui_sp_widget");
  assert.deepEqual(
    b.files.map((f) => f.path).filter((p) => !p.endsWith(".ts")),
    [
      "sp_widget_acme_hello.client_script.client.js",
      "sp_widget_acme_hello.css.css",
      "sp_widget_acme_hello.link.client.js",
      "sp_widget_acme_hello.script.server.js",
      "sp_widget_acme_hello.template.html",
      `sp_widget_acme_hello__sp_ng_template_${sid("a2").slice(0, 8)}.template.html`,
    ],
  );
  const text = mainOf(b);
  assert.match(text, /roles: \['itil', 'admin'\]/);
  assert.match(text, /demoData: 'not json'/);
  assert.match(text, /optionSchema: \[\n/);
  assert.match(text, /dependencies: \[Now\.ref\('sp_dependency', 'd1/);
  // internal_notes has no property; the dependency row without a target is a Record().
  assert.deepEqual(
    b.unsupported.map((u) => [u.kind, u.table, u.field ?? ""]),
    [
      ["field", "sp_widget", "internal_notes"],
      ["child", "m2m_sp_widget_dependency", ""],
    ],
  );
});

test("CatalogItem: typed variables, choices, sets, logic and every leftover reported", () => {
  const b = emitCase("ui_catalog_item");
  const text = mainOf(b);
  assert.match(text, /model: SelectBoxVariable\(\{/);
  assert.match(text, /justification: MultiLineTextVariable\(\{/);
  assert.match(text, /model_2: SingleLineTextVariable\(\{/);
  assert.match(text, /location: MultipleChoiceVariable\(\{/);
  // Choices in order-field order.
  assert.ok(text.indexOf("air: {") < text.indexOf("pro: {"));
  // Call order: item, its script, its policy, then the set.
  const order = [
    "CatalogItem({",
    "CatalogClientScript({\n    $id: Now.ID['catalog_client_script_model_onchange']",
    "CatalogUiPolicy({",
    "VariableSet({",
    "CatalogClientScript({\n    $id: Now.ID['catalog_client_script_delivery_onload']",
  ].map((s) => text.indexOf(s));
  assert.ok(
    order.every((i) => i >= 0),
    JSON.stringify(order),
  );
  assert.deepEqual(
    [...order].sort((x, y) => x - y),
    order,
  );
  assert.match(text, /uiType: 'all'/);
  assert.match(text, /variableSet: Now\.ref\('item_option_new_set', 'c2/);
  assert.match(
    text,
    /\/\/ child of catalog_item_acme_laptop: item_option_new\nRecord\(/,
  );
  assert.deepEqual(
    b.unsupported.map((u) => [u.kind, u.table, u.field ?? ""]),
    [
      ["field", "sc_cat_item", "price"],
      ["field", "item_option_new", "name"],
      ["api", "item_option_new", ""],
      ["child", "catalog_ui_policy", ""],
      ["child", "sc_cat_item_user_criteria_mtom", ""],
    ],
  );
  // The SDK's CatalogItem has no price property (only the price flags).
  assert.match(b.unsupported[0].reason, /No CatalogItem property .* price/);
  assert.match(b.unsupported[1].reason, /Duplicate variable name 'model'/);
  assert.match(b.unsupported[2].reason, /Variable type '99'/);
  assert.match(b.unsupported[3].reason, /redacted/);
  assert.match(b.unsupported[4].reason, /Only the first 1 child rows/);
});

test("a workspace references its UI Builder internals and reports them", () => {
  const b = emitCase("ui_workspace");
  const text = mainOf(b);
  // The SDK's Workspace has no root macroponent / admin panel property.
  assert.doesNotMatch(text, /rootMacroponent/);
  assert.deepEqual(
    b.unsupported.map((u) => [u.kind, u.table, u.field ?? ""]),
    [
      ["field", "sys_ux_page_registry", "admin_panel"],
      ["field", "sys_ux_page_registry", "root_macroponent"],
      ["api", "sys_ux_macroponent", ""],
      ["api", "sys_ux_app_config", ""],
      ["child", "sys_ux_page_property", ""],
    ],
  );
  assert.match(b.unsupported[2].reason, /uib_macroponent/);
});

test("UI Builder and Angular-template types stay Record() with an unsupported[] entry", () => {
  for (const t of ARTIFACT_TYPES.filter((x) => x.group === "uib")) {
    assert.equal(UI_EMITTERS[t.type], undefined, t.type);
    assert.match(uiFallbackReason(t), /no Fluent API/, t.type);
  }
  const tpl = getArtifactType("sp_ng_template");
  assert.match(uiFallbackReason(tpl), /SPWidget/);
  const b = emitFluent(
    tpl,
    [
      {
        scope: SCOPE,
        record: {
          sys_id: sid("a2"),
          id: "x.html",
          sp_widget: WIDGET,
          template: "<i></i>",
        },
      },
    ],
    "sp_ng_template",
    null,
  );
  assert.match(mainOf(b), /^Record\(\{/m);
  assert.deepEqual(
    b.unsupported.map((u) => u.kind),
    ["api"],
  );
});

test("P-28 output is deterministic: child order and field order do not matter", () => {
  for (const name of ["ui_catalog_item", "ui_sp_page", "ui_dashboard"]) {
    const c = CASES[name];
    const t = getArtifactType(c.type);
    const rev = (r) => Object.fromEntries(Object.entries(r).reverse());
    const shuffled = c.sources.map((s) => ({
      ...s,
      record: rev(s.record),
      children: [...s.children]
        .reverse()
        .map((ch) => ({ ...ch, records: [...ch.records].reverse().map(rev) })),
    }));
    assert.deepEqual(
      emitFluent(t, shuffled, c.type, null),
      emitFluent(t, c.sources, c.type, null),
      name,
    );
  }
});

test("secrets become the credential placeholder in P-28 output", () => {
  const b = emitCase("ui_sp_page", { fields: new Set(["title"]), pii: false });
  const text = b.files.map((f) => f.content).join("\n");
  assert.ok(!text.includes("'Acme home'"));
  assert.match(text, new RegExp(`title: '${SECRET_PLACEHOLDER}'`));
  // The page title and the widget instance title (a nested row) both.
  assert.equal(
    text.match(new RegExp(`title: '${SECRET_PLACEHOLDER}'`, "g")).length,
    2,
  );
  assert.equal(b.secretsReplaced, 2);

  // A credential-like field name inside a passthrough structure.
  const t = getArtifactType("dashboard");
  const d = emitFluent(
    t,
    [
      {
        scope: SCOPE,
        record: { sys_id: sid("20"), name: "D" },
        children: [
          child("par_dashboard_tab", "dashboard", [
            { sys_id: sid("21"), dashboard: sid("20"), name: "T" },
          ]),
          child("par_dashboard_widget", "tab", [
            {
              sys_id: sid("22"),
              tab: sid("21"),
              component: "sn-chart",
              component_props: '{"client_secret":"shh"}',
            },
          ]),
        ],
      },
    ],
    "dashboard",
    null,
  );
  const body = d.files.map((f) => f.content).join("\n");
  assert.ok(!body.includes("shh"));
  assert.equal(d.secretsReplaced, 1);
});

const tool = ALL_TOOLS.find((s) => s.name === "servicenow_generate_fluent");
const rows = (result) => jsonResponse(200, { result });

test("generate_fluent over a P-28 type: dedicated emitter and the verified-shape note", async () => {
  freshRuntime();
  const rec = {
    sys_id: sid("80"),
    name: "acmeFactory",
    type: "factory",
    script: "function acmeFactory() { return {}; }",
    sys_scope: S,
  };
  const mock = (url) => {
    const u = new URL(url);
    const m = u.pathname.match(/\/api\/now\/table\/([^/]+)(?:\/([^/]+))?$/);
    assert.ok(m, `unexpected request ${url}`);
    if (m[1] === "sp_angular_provider") return rows(m[2] ? rec : [rec]);
    if (m[1] === "sys_scope") return rows([SCOPE]);
    return jsonResponse(404, { error: { message: "no route" } });
  };
  await withEnv({ ...SDK_OFF, ...NO_REDACT }, () =>
    withFetch(mock, async () => {
      const res = await runSpec(tool, {
        artifactType: "sp_angular_provider",
        sys_id: rec.sys_id,
      });
      assert.equal(res.isError, undefined, res.content?.[0]?.text);
      const body = res.structuredContent;
      assert.equal(body.emitter, "dedicated");
      assert.equal(body.sdkApi, "SPAngularProvider");
      assert.ok(body.warnings.includes(UI_VERIFIED_NOTE));
      const main = body.files.find((f) => f.path.endsWith(".now.ts"));
      assert.match(main.content, /^SPAngularProvider\(\{/m);
      assert.match(
        main.content,
        /script: Now\.include\('\.\/sp_angular_provider_acmefactory\.script\.client\.js'\)/,
      );
    }),
  );
});
