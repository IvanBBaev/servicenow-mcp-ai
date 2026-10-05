import test from "node:test";
import assert from "node:assert/strict";

import {
  ARTIFACT_GROUPS,
  ARTIFACT_TYPES,
  PERFORMANCE_ANALYTICS,
  SDK_BASELINE,
  SDK_APIS,
  SDK_NEXT_APIS,
  DECODER_IDS,
  getArtifactType,
  validateArtifactTypes,
} from "../build/core/artifacts/registry.js";
import {
  SCRIPT_TYPES,
  SCRIPT_TYPE_NAMES,
  OPT_IN_SCRIPT_TYPES,
  OPT_IN_SCRIPT_TYPE_NAMES,
} from "../build/api/scripts.js";

/**
 * P-1 — the artefact registry. The literal below is the pre-P-1
 * `SCRIPT_TYPES` from src/api/scripts.ts, frozen here so the derived view can
 * never drift from what list_scripts / search_code / where_used / snapshot /
 * compare read today.
 */
const LEGACY_SCRIPT_TYPES = {
  business_rule: {
    table: "sys_script",
    nameField: "name",
    appliesToField: "collection",
    // `global` marks the rules that run on every table (S-1: the table-flow
    // diagram lists them alongside the inherited ones).
    metaFields: [
      "collection",
      "global",
      "when",
      "order",
      "active",
      "condition",
    ],
    scriptFields: ["script"],
  },
  script_include: {
    table: "sys_script_include",
    nameField: "name",
    metaFields: ["api_name", "client_callable", "access", "active"],
    scriptFields: ["script"],
  },
  client_script: {
    table: "sys_script_client",
    nameField: "name",
    appliesToField: "table",
    metaFields: ["table", "type", "ui_type", "field", "active"],
    scriptFields: ["script"],
  },
  ui_policy: {
    table: "sys_ui_policy",
    nameField: "short_description",
    appliesToField: "table",
    metaFields: ["table", "active", "run_scripts"],
    scriptFields: ["script_true", "script_false"],
  },
  ui_action: {
    table: "sys_ui_action",
    nameField: "name",
    appliesToField: "table",
    metaFields: ["table", "action_name", "active", "client", "order"],
    scriptFields: ["script"],
  },
  scheduled_job: {
    table: "sysauto_script",
    nameField: "name",
    metaFields: ["active", "run_type", "run_time"],
    scriptFields: ["script"],
  },
  transform: {
    table: "sys_transform_script",
    nameField: "map",
    metaFields: ["map", "when", "order"],
    scriptFields: ["script"],
  },
  rest_operation: {
    table: "sys_ws_operation",
    nameField: "name",
    metaFields: [
      "web_service_definition",
      "http_method",
      "operation_uri",
      "active",
    ],
    scriptFields: ["operation_script"],
  },
  acl: {
    table: "sys_security_acl",
    nameField: "name",
    metaFields: ["operation", "type", "active", "admin_overrides"],
    scriptFields: ["script"],
  },
};
const LEGACY_NAMES = Object.keys(LEGACY_SCRIPT_TYPES);

test("SCRIPT_TYPES view starts with the pre-registry literal, keys in order", () => {
  // S-4 appends the widened types; the nine original ones stay first and
  // byte-identical, so every existing script kind reads exactly as before.
  const legacyView = Object.fromEntries(
    Object.entries(SCRIPT_TYPES).slice(0, LEGACY_NAMES.length),
  );
  assert.deepEqual(legacyView, LEGACY_SCRIPT_TYPES);
  assert.deepEqual(
    SCRIPT_TYPE_NAMES.slice(0, LEGACY_NAMES.length),
    LEGACY_NAMES,
  );
  // Same serialised form, key order within each descriptor included.
  assert.equal(JSON.stringify(legacyView), JSON.stringify(LEGACY_SCRIPT_TYPES));
});

test("the nine legacy types are verified; every S-4 addition is not", () => {
  const exposed = ARTIFACT_TYPES.filter((t) => t.scriptTools).map(
    (t) => t.type,
  );
  assert.deepEqual(exposed, SCRIPT_TYPE_NAMES);
  assert.deepEqual(exposed.slice(0, LEGACY_NAMES.length), LEGACY_NAMES);
  for (const type of exposed) {
    assert.equal(
      getArtifactType(type).verified,
      LEGACY_NAMES.includes(type),
      type,
    );
  }
});

test("S-4: every widened table is reachable by the script tools", () => {
  const byTable = new Map(
    ARTIFACT_TYPES.filter((t) => t.scriptTools).map((t) => [t.table, t]),
  );
  for (const table of [
    "sp_widget",
    "sys_ui_page",
    "sys_ui_script",
    "sys_ui_macro",
    "sys_processor",
    "sys_script_email",
    "sys_script_fix",
    "sys_script_validator",
    "sys_ws_operation",
    "sys_rest_message_fn",
    "sys_data_source",
    "sys_transform_map",
    "sys_transform_entry",
    "sys_transform_script",
    "sysevent_script_action",
    "catalog_script_client",
    "sys_dictionary",
  ]) {
    const t = byTable.get(table);
    assert.ok(t, table);
    assert.ok(t.scriptFields.length > 0, table);
  }
  assert.deepEqual(getArtifactType("sp_widget").scriptFields, [
    "script",
    "client_script",
    "link",
    "css",
  ]);
  assert.deepEqual(getArtifactType("dictionary_script").scriptFields, [
    "calculation",
    "default_value",
  ]);
  // sys_dictionary is shared with the schema tools: the script view is
  // narrowed to calculated fields and javascript: defaults.
  assert.match(getArtifactType("dictionary_script").baseQuery, /virtual=true/);
  // sys_ws_definition has no script of its own; its operations do.
  assert.equal(getArtifactType("rest_api").scriptTools, undefined);
});

test("client / markup fields drive the lint scope", () => {
  assert.deepEqual(getArtifactType("client_script").clientFields, ["script"]);
  assert.deepEqual(getArtifactType("ui_policy").clientFields, [
    "script_true",
    "script_false",
  ]);
  assert.deepEqual(getArtifactType("sp_widget").markupFields, ["css"]);
  assert.deepEqual(getArtifactType("ui_page").markupFields, ["html"]);
  for (const type of LEGACY_NAMES) {
    assert.equal(getArtifactType(type).markupFields, undefined, type);
    assert.equal(getArtifactType(type).baseQuery, undefined, type);
  }
});

test("the registry validates clean", () => {
  assert.deepEqual(validateArtifactTypes(), []);
});

test("type ids are unique", () => {
  const ids = ARTIFACT_TYPES.map((t) => t.type);
  assert.equal(new Set(ids).size, ids.length);
});

test("every child declares its parent reference field", () => {
  for (const t of ARTIFACT_TYPES) {
    for (const c of t.children) {
      assert.ok(c.parentField, `${t.type} > ${c.table}`);
    }
  }
});

test("every jsonFields decoder id is declared", () => {
  for (const t of ARTIFACT_TYPES) {
    const fields = [
      ...t.jsonFields,
      ...t.children.flatMap((c) => c.jsonFields ?? []),
    ];
    for (const j of fields) {
      assert.ok(DECODER_IDS.includes(j.decoder), `${t.type}.${j.field}`);
    }
  }
});

test("every sdkApi is on the baseline list; SDK_BASELINE is 4.12.2", () => {
  assert.equal(SDK_BASELINE, "4.12.2");
  assert.equal(new Set(SDK_APIS).size, SDK_APIS.length);
  assert.ok(!SDK_APIS.includes("DatabaseView"), "next-only API on baseline");
  assert.deepEqual([...SDK_NEXT_APIS], ["DatabaseView"]);
  for (const t of ARTIFACT_TYPES) {
    if (SDK_NEXT_APIS.includes(t.sdkApi)) {
      // SDK-PARITY §2 rule 4: next-only APIs stay unverified and never G.
      assert.equal(t.verified, false, t.type);
      assert.ok(!t.tiers.includes("G"), t.type);
      continue;
    }
    assert.ok(
      t.sdkApi === "none" || SDK_APIS.includes(t.sdkApi),
      `${t.type}: ${t.sdkApi}`,
    );
  }
  const view = getArtifactType("database_view");
  assert.equal(view.sdkApi, "DatabaseView");
  assert.equal(view.table, "sys_db_view");
  assert.equal(view.children[0].table, "sys_db_view_table");
});

test("seeded breadth: the P-1 representative types are registered", () => {
  const tables = new Set(ARTIFACT_TYPES.map((t) => t.table));
  const childTables = new Set(
    ARTIFACT_TYPES.flatMap((t) => t.children.map((c) => c.table)),
  );
  for (const table of [
    "sp_widget",
    "sp_page",
    "sp_portal",
    "sys_ui_page",
    "sys_ui_policy",
    "sys_ui_action",
    "sys_ux_macroponent",
    "sys_ux_page_registry",
    "sys_hub_flow",
    "wf_workflow",
    "sc_cat_item",
    "sys_ws_definition",
    "sys_ws_operation",
    "sys_script_fix",
    "sys_script_email",
    "sys_transform_map",
  ]) {
    assert.ok(tables.has(table), table);
  }
  for (const table of [
    "sys_ui_policy_action",
    "sys_hub_action_instance",
    "sys_hub_flow_logic_instance_v2",
    "sp_instance",
  ]) {
    assert.ok(childTables.has(table), table);
  }
  assert.equal(
    getArtifactType("ui_policy").children[0].parentField,
    "ui_policy",
  );
  assert.equal(getArtifactType("nope"), undefined);
});

test("validateArtifactTypes reports every kind of defect", () => {
  const good = getArtifactType("sp_page");
  const bad = [
    // sp_page's layout references sp_widget: keep that target registered.
    getArtifactType("sp_widget"),
    // …and sp_widget's Angular-provider link references sp_angular_provider.
    getArtifactType("sp_angular_provider"),
    { ...good, type: "dup" },
    { ...good, type: "dup" },
    {
      ...good,
      type: "broken",
      group: "nowhere",
      sdkApi: "NotAnApi",
      nameField: "",
      jsonFields: [{ field: "x", decoder: "yaml", writable: false }],
      refFields: [{ field: "r", table: "t", type: "ghost" }],
      children: [
        { table: "c1", parentField: "" },
        {
          table: "c2",
          parentField: "p",
          parentTable: "later",
          jsonFields: [{ field: "y", decoder: "xml", writable: true }],
          refFields: [{ field: "q", table: "t", type: "ghost" }],
        },
        { table: "later", parentField: "p" },
      ],
    },
    { ...good, type: "noapi", sdkApi: "none", sdkSince: "4.0" },
    { ...good, type: "scripty", scriptTools: true, scriptFields: [] },
    { ...good, type: "optin", scriptToolsOptIn: true, scriptFields: [] },
    {
      ...good,
      type: "both",
      scriptTools: true,
      scriptToolsOptIn: true,
      scriptFields: ["script"],
    },
    {
      ...good,
      type: "stray",
      scriptFields: ["script"],
      clientFields: ["client_script"],
      markupFields: ["css"],
    },
    { ...good, type: "early", sdkApi: "DatabaseView", verified: true },
    { ...good, type: "early-g", sdkApi: "DatabaseView", tiers: ["R", "G"] },
    { ...good, type: "early-ok", sdkApi: "DatabaseView", tiers: [] },
  ];
  const problems = validateArtifactTypes(bad);
  const expect = [
    /^dup: duplicate type$/,
    /broken: unknown group 'nowhere'/,
    /broken: sdkApi 'NotAnApi' is not on the baseline/,
    /broken: table, nameField and keyFields are required/,
    /broken: unknown decoder 'yaml' on x/,
    /broken: r references unknown type ghost/,
    /broken > c1: missing parentField/,
    /broken > c2: parentTable later is not declared before it/,
    /broken > c2: unknown decoder 'xml' on y/,
    /broken > c2: q references unknown type ghost/,
    /noapi: sdkSince set but sdkApi is 'none'/,
    /scripty: a script-tools type needs scriptFields/,
    /optin: an opt-in script type needs scriptFields/,
    /both: scriptTools and scriptToolsOptIn are exclusive/,
    /stray: client_script is not one of its scriptFields/,
    /stray: css is not one of its scriptFields/,
    /^early: next-only sdkApi 'DatabaseView' must be verified:false/,
    /^early-g: next-only sdkApi 'DatabaseView' must be verified:false/,
  ];
  for (const re of expect) {
    assert.ok(
      problems.some((p) => re.test(p)),
      `${re} not in ${problems.join(" | ")}`,
    );
  }
  assert.equal(problems.length, expect.length);
});

/**
 * P-9 — the Next Experience, UI Builder, Service Portal, Flow Designer and
 * legacy-workflow rows of SDK-PARITY §4.4 … §4.8, at the R tier.
 */
const P9_TYPES = {
  "next-experience": [
    "workspace",
    "dashboard",
    "ux_list_menu_config",
    "ux_applicability",
  ],
  uib: [
    "uib_app_config",
    "uib_route",
    "uib_screen_type",
    "uib_screen",
    "uib_macroponent",
    "uib_client_script",
    "uib_client_script_include",
    "uib_data_broker_transform",
    "uib_data_broker_scriptlet",
    "uib_event",
    "uib_component",
    "uib_theme",
    "uib_style",
    "uib_form_action",
    "uib_form_action_layout",
    "uib_composite_definition",
    // N-29 / N-30
    "uib_data_broker_rest",
    "uib_data_broker_graphql",
    "ux_declarative_action",
    "ux_declarative_action_definition",
    "ux_declarative_action_payload",
    "uib_app_theme",
    "aw_master_config",
    "aw_list",
  ],
  portal: [
    "sp_portal",
    "sp_page",
    "sp_ng_template",
    "sp_dependency",
    "sp_angular_provider",
    "sp_js_include",
    "sp_css_include",
    "sp_theme",
    "sp_menu",
    "sp_header_footer",
    "sp_page_route_map",
    "sp_css",
    "sp_search_source",
  ],
  flow: [
    "flow",
    "subflow",
    "flow_action",
    "flow_trigger_definition",
    "flow_context",
    "playbook",
    "playbook_context",
    "decision_table",
  ],
  workflow: ["workflow", "workflow_activity_definition", "workflow_context"],
};

test("P-9: every NX / UIB / portal / flow / workflow row is an unverified R-tier type", () => {
  for (const [group, types] of Object.entries(P9_TYPES)) {
    for (const type of types) {
      const t = getArtifactType(type);
      assert.ok(t, type);
      assert.equal(t.group, group, type);
      assert.equal(t.verified, false, type);
      // P-11 gave decision_table an explainer (X).
      assert.deepEqual(
        t.tiers,
        type === "decision_table" ? ["R", "X"] : ["R"],
        type,
      );
      // None of them joins the default script-tools view.
      assert.equal(t.scriptTools, undefined, type);
    }
  }
  // sp_widget keeps its S-4 script-tools tiers and fields.
  assert.deepEqual(getArtifactType("sp_widget").tiers, ["R", "A", "S"]);
});

test("N-29 / N-30: broker, declarative action, theme and AW rows stay out of the script tools", () => {
  // REST / GraphQL brokers: no script fields, the broker meta flag.
  for (const type of ["uib_data_broker_rest", "uib_data_broker_graphql"]) {
    const t = getArtifactType(type);
    assert.deepEqual(t.scriptFields, [], type);
    assert.deepEqual(t.metaFields, ["mutates_server_data"], type);
    assert.equal(t.jsonFields[0].field, "properties", type);
    assert.notEqual(t.scriptToolsOptIn, true, type);
  }
  const da = getArtifactType("ux_declarative_action");
  assert.equal(da.table, "sys_declarative_action_assignment");
  assert.deepEqual(da.scriptFields, ["server_script", "client_script"]);
  assert.deepEqual(da.clientFields, ["client_script"]);
  // A script field, but not a script-tools type (no enum growth).
  assert.notEqual(da.scriptToolsOptIn, true);
  const ref = (t, field) => t.refFields.find((r) => r.field === field);
  assert.equal(ref(da, "ui_component").type, "uib_component");
  assert.equal(ref(da, "action").type, "ux_declarative_action_definition");
  assert.equal(ref(da, "client_action").type, "ux_declarative_action_payload");
  assert.equal(ref(da, "workspace").type, "aw_master_config");
  assert.equal(
    ref(getArtifactType("uib_app_theme"), "theme").type,
    "uib_theme",
  );
  assert.equal(getArtifactType("aw_list").nameField, "title");
});

test("P-9: the rows carry their child tables", () => {
  const children = (type) => getArtifactType(type).children.map((c) => c.table);
  assert.ok(children("workspace").includes("sys_ux_page_property"));
  assert.deepEqual(children("uib_macroponent"), ["sys_ux_client_script"]);
  assert.ok(children("uib_screen_type").includes("sys_ux_screen"));
  assert.ok(children("sp_widget").includes("m2m_sp_ng_pro_sp_widget"));
  assert.deepEqual(children("sp_dependency"), [
    "m2m_sp_dependency_js_include",
    "m2m_sp_dependency_css_include",
  ]);
  assert.deepEqual(children("sp_menu"), ["sp_rectangle_menu_item"]);
  // Flows and subflows share sys_hub_flow and one child list (FLW-4 … 8).
  assert.deepEqual(children("subflow"), children("flow"));
  assert.equal(getArtifactType("subflow").table, "sys_hub_flow");
  assert.equal(getArtifactType("subflow").baseQuery, "type=subflow");
  for (const table of [
    "sys_hub_trigger_instance",
    "sys_hub_action_instance",
    "sys_hub_flow_logic_instance_v2",
    "sys_hub_sub_flow_instance_v2",
    "sys_hub_flow_input",
    "sys_hub_flow_output",
    "sys_hub_flow_variable",
    "sys_hub_flow_stage",
  ]) {
    assert.ok(children("flow").includes(table), table);
  }
  assert.ok(children("flow_action").includes("sys_hub_step_instance"));
  assert.ok(children("flow_context").includes("sys_flow_log"));
  assert.ok(children("playbook").includes("sys_pd_activity"));
  assert.ok(children("decision_table").includes("sys_decision_question"));
  // wf_activity keeps parentField `workflow` (get_flow reads it the same way).
  const wf = getArtifactType("workflow").children;
  assert.equal(
    wf.find((c) => c.table === "wf_activity").parentField,
    "workflow",
  );
  assert.equal(
    wf.find((c) => c.table === "wf_condition").parentTable,
    "wf_activity",
  );
  assert.ok(wf.some((c) => c.table === "wf_stage"));
  assert.deepEqual(children("workflow_context"), [
    "wf_executing",
    "wf_history",
    "wf_log",
  ]);
});

test("P-9: script-bearing rows are opt-in script types, never in the default view", () => {
  assert.deepEqual(
    ARTIFACT_TYPES.filter((t) => t.scriptToolsOptIn).map((t) => t.type),
    OPT_IN_SCRIPT_TYPE_NAMES,
  );
  assert.deepEqual(OPT_IN_SCRIPT_TYPE_NAMES, [
    "uib_client_script",
    "uib_client_script_include",
    "uib_data_broker_transform",
    "uib_data_broker_scriptlet",
    "sp_ng_template",
    "sp_angular_provider",
    "sp_theme",
    "sp_css",
    "sp_search_source",
  ]);
  for (const name of OPT_IN_SCRIPT_TYPE_NAMES) {
    assert.ok(!SCRIPT_TYPE_NAMES.includes(name), name);
    assert.ok(OPT_IN_SCRIPT_TYPES[name].scriptFields.length > 0, name);
  }
  assert.deepEqual(OPT_IN_SCRIPT_TYPES.uib_client_script, {
    table: "sys_ux_client_script",
    nameField: "name",
    metaFields: ["macroponent", "type"],
    scriptFields: ["script"],
  });
  assert.deepEqual(getArtifactType("uib_client_script").clientFields, [
    "script",
  ]);
  assert.deepEqual(getArtifactType("sp_angular_provider").clientFields, [
    "script",
  ]);
  assert.deepEqual(getArtifactType("sp_ng_template").markupFields, [
    "template",
  ]);
});

/**
 * N-8 — reports and Performance Analytics (SDK-PARITY §4.13): read-only
 * seeds in the `reporting` group. O-5: verify on a live instance.
 */
const N8_TYPES = {
  report: ["sys_report", undefined],
  report_source: ["sys_report_source", undefined],
  pa_indicator: ["pa_indicators", PERFORMANCE_ANALYTICS],
  pa_indicator_source: ["pa_cubes", PERFORMANCE_ANALYTICS],
  pa_breakdown: ["pa_breakdowns", PERFORMANCE_ANALYTICS],
  pa_script: ["pa_scripts", PERFORMANCE_ANALYTICS],
  pa_dashboard: ["pa_dashboards", PERFORMANCE_ANALYTICS],
};

test("N-8: every report / PA row is an unverified R + X reporting type", () => {
  assert.ok(ARTIFACT_GROUPS.includes("reporting"));
  assert.deepEqual(
    ARTIFACT_TYPES.filter((t) => t.group === "reporting")
      .map((t) => t.type)
      .sort(),
    Object.keys(N8_TYPES).sort(),
  );
  for (const [type, [table, licensed]] of Object.entries(N8_TYPES)) {
    const t = getArtifactType(type);
    assert.ok(t, type);
    assert.equal(t.table, table, type);
    assert.equal(t.group, "reporting", type);
    assert.equal(t.sdkApi, "none", type);
    assert.equal(t.sdkSince, null, type);
    assert.equal(t.verified, false, type);
    assert.deepEqual(t.tiers, ["R", "X"], type);
    assert.equal(t.licensed, licensed, type);
    // No script-tools enum grows (tools/list budget).
    assert.equal(t.scriptTools, undefined, type);
    assert.equal(t.scriptToolsOptIn, undefined, type);
    assert.ok(!SCRIPT_TYPE_NAMES.includes(type), type);
    assert.ok(!OPT_IN_SCRIPT_TYPE_NAMES.includes(type), type);
  }
  assert.match(PERFORMANCE_ANALYTICS, /com\.snc\.pa/);
  assert.deepEqual(validateArtifactTypes(), []);
});

test("N-8: reports and PA rows carry the dependency edges and children", () => {
  const refs = (type) =>
    Object.fromEntries(
      getArtifactType(type).refFields.map((r) => [r.field, r.type ?? r.table]),
    );
  const report = getArtifactType("report");
  assert.equal(report.nameField, "title");
  assert.equal(report.appliesToField, "table");
  assert.ok(report.metaFields.includes("filter"));
  assert.equal(refs("report").report_source, "report_source");
  assert.deepEqual(
    report.children.map((c) => [c.table, c.parentField]),
    [["sys_report_users_groups", "report_id"]],
  );
  assert.equal(refs("pa_indicator").cube, "pa_indicator_source");
  assert.equal(refs("pa_indicator").script, "pa_script");
  assert.equal(
    getArtifactType("pa_indicator").children[0].refFields[0].type,
    "pa_breakdown",
  );
  assert.equal(
    getArtifactType("pa_indicator_source").appliesToField,
    "facts_table",
  );
  assert.deepEqual(getArtifactType("pa_script").scriptFields, ["script"]);
  assert.equal(
    getArtifactType("pa_breakdown").children[0].refFields[0].type,
    "pa_script",
  );
  // The PA dashboard links to its Next Experience twin (the P-9 `dashboard`).
  assert.equal(refs("pa_dashboard").experience_dashboard, "dashboard");
  assert.equal(refs("pa_dashboard").managed_breakdown, "pa_breakdown");
  assert.deepEqual(
    getArtifactType("pa_dashboard").children.map((c) => [
      c.table,
      c.parentField,
      c.parentTable,
      c.parentKey,
    ]),
    [
      ["pa_m2m_dashboard_tabs", "dashboard", undefined, undefined],
      ["pa_tabs", "sys_id", "pa_m2m_dashboard_tabs", "tab"],
    ],
  );
});
