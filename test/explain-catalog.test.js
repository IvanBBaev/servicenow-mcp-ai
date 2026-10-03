// P-8 — catalog, quality, AI and application descriptors (SDK-PARITY §4.9 –
// §4.12): every new row lists and explains, a catalog item explains its
// variables in order with their question_choice values, its variable sets,
// catalog client scripts and UI policies, and the licensed families (sn_aia_*,
// sn_nowassist_skill_*) answer available:false without an error when their
// tables are absent. Regenerate the goldens with `UPDATE_GOLDEN=1 npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { artifactTypeCatalog } from "../build/api/artifacts.js";
import {
  getArtifactType,
  validateArtifactTypes,
} from "../build/core/artifacts/registry.js";
import { SCRIPT_TYPE_NAMES } from "../build/api/scripts.js";
import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

baselineEnv();

const SDK_OFF = { SN_SDK_MANAGED_SCOPES: undefined, SN_SDK_PROJECT_DIRS: "" };
const APP_ID = "a".repeat(32);
const id = (c) => c.repeat(32 / c.length);

const FIXTURES = path.join(import.meta.dirname, "fixtures", "explain");

/** Compare parsed JSON so prettier formatting of the golden does not matter. */
function golden(name, actual) {
  const file = path.join(FIXTURES, `${name}.json`);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  assert.deepEqual(actual, JSON.parse(readFileSync(file, "utf8")), name);
}

const tool = (name) => ALL_TOOLS.find((s) => s.name === name);
const call = (name, args) => runSpec(tool(name), args);

/** The P-8 rows, their table and their §4 group. */
const P8_TYPES = {
  catalog_item: ["sc_cat_item", "catalog"],
  record_producer: ["sc_cat_item_producer", "catalog"],
  variable_set: ["item_option_new_set", "catalog"],
  catalog_variable: ["item_option_new", "catalog"],
  catalog_ui_policy: ["catalog_ui_policy", "catalog"],
  atf_test: ["sys_atf_test", "quality"],
  atf_test_suite: ["sys_atf_test_suite", "quality"],
  linter_check: ["scan_linter_check", "quality"],
  script_only_check: ["scan_script_only_check", "quality"],
  column_type_check: ["scan_column_type_check", "quality"],
  table_check: ["scan_table_check", "quality"],
  assessment: ["asmt_metric_type", "quality"],
  risk_assessment: ["change_risk_asmt", "quality"],
  ai_agent: ["sn_aia_agent", "ai"],
  ai_agentic_workflow: ["sn_aia_usecase", "ai"],
  now_assist_skill: ["sn_nowassist_skill_config", "ai"],
  application: ["sys_app", "application"],
  app_dependency: ["sys_scope_dependency", "application"],
  customer_update: ["sys_update_xml", "application"],
  source_control: ["sys_repo_config", "application"],
};

/** Encoded-query clauses the artefact reader sends, applied to fixture rows. */
function filterRows(rows, query) {
  let out = [...rows];
  let orderBy;
  for (const clause of (query ?? "").split("^").filter(Boolean)) {
    if (clause.startsWith("ORDERBY")) {
      orderBy = clause.slice(7);
      continue;
    }
    let m = clause.match(/^(\w+)ISEMPTY$/);
    if (m) {
      out = out.filter((r) => !r[m[1]]);
      continue;
    }
    m = clause.match(/^(\w+)IN(.*)$/);
    if (m) {
      const values = m[2].split(",");
      out = out.filter((r) => values.includes(String(r[m[1]] ?? "")));
      continue;
    }
    m = clause.match(/^(\w+)=(.*)$/);
    assert.ok(m, `unsupported clause ${clause}`);
    out = out.filter((r) => String(r[m[1]] ?? "") === m[2]);
  }
  if (orderBy) {
    out.sort((a, b) => Number(a[orderBy]) - Number(b[orderBy]));
  }
  return out;
}

/**
 * Table API mock that records every request and FILTERS array tables by the
 * encoded query. `tables[name]` is a record (primary read by sys_id), an
 * array of rows, or `(searchParams, sysId) => Response`. Unknown: no rows.
 */
function tableMock(tables, calls = []) {
  return (url) => {
    const u = new URL(url);
    const m = u.pathname.match(/\/api\/now\/table\/([^/]+)(?:\/([^/]+))?$/);
    assert.ok(m, `unexpected request ${url}`);
    const query = u.searchParams.get("sysparm_query");
    calls.push({ table: m[1], id: m[2], query });
    if (m[1] === "sys_scope") {
      return jsonResponse(200, {
        result: [{ sys_id: APP_ID, scope: "x_acme_app" }],
      });
    }
    const value = tables[m[1]];
    if (typeof value === "function") return value(u.searchParams, m[2]);
    if (m[2]) {
      if (!value || Array.isArray(value)) {
        return jsonResponse(404, { error: { message: "No Record found" } });
      }
      return jsonResponse(200, { result: value });
    }
    if (Array.isArray(value)) {
      return jsonResponse(200, { result: filterRows(value, query) });
    }
    return jsonResponse(200, { result: value ? [value] : [] });
  };
}

async function run(name, tables, args, calls) {
  freshRuntime();
  return withEnv(SDK_OFF, () =>
    withFetch(tableMock(tables, calls), async () => {
      const res = await call(name, args);
      if (res.isError) return { error: res.content[0].text };
      assert.deepEqual(res.structuredContent, JSON.parse(res.content[0].text));
      return res.structuredContent;
    }),
  );
}

const invalidTable = (table) => () =>
  jsonResponse(400, { error: { message: `Invalid table ${table}` } });

// -- the catalog-item fixture ---------------------------------------------------

const ITEM = id("1c");
const SET = id("5c");
const V_MODEL = id("2c");
const V_REASON = id("3c");
const V_COST = id("4c");
const POLICY = id("ac");

const CATALOG = {
  sc_cat_item: {
    sys_id: ITEM,
    name: "Acme laptop",
    short_description: "Request a laptop.",
    active: "true",
    sys_scope: APP_ID,
  },
  item_option_new: [
    {
      sys_id: V_MODEL,
      cat_item: ITEM,
      variable_set: "",
      name: "model",
      question_text: "Model",
      order: "200",
      type: "5",
      mandatory: "true",
    },
    {
      sys_id: V_REASON,
      cat_item: ITEM,
      variable_set: "",
      name: "reason",
      question_text: "Why do you need it?",
      order: "100",
      type: "2",
      mandatory: "false",
    },
    {
      sys_id: V_COST,
      cat_item: "",
      variable_set: SET,
      name: "cost_center",
      question_text: "Cost center",
      order: "10",
      type: "8",
    },
    // Another item's variable: never part of this form.
    {
      sys_id: id("9c"),
      cat_item: id("ff"),
      variable_set: "",
      name: "other",
      order: "1",
      type: "6",
    },
  ],
  io_set_item: [
    { sys_id: id("6c"), sc_cat_item: ITEM, variable_set: SET, order: "300" },
  ],
  item_option_new_set: [
    { sys_id: SET, title: "Cost details", internal_name: "cost_details" },
  ],
  question_choice: [
    {
      sys_id: id("d1"),
      question: V_MODEL,
      value: "pro",
      text: "Pro",
      order: "20",
    },
    {
      sys_id: id("d2"),
      question: V_MODEL,
      value: "air",
      text: "Air",
      order: "10",
    },
    {
      sys_id: id("d3"),
      question: V_MODEL,
      value: "old",
      text: "Legacy",
      order: "30",
      inactive: "true",
    },
    { sys_id: id("d4"), question: id("9c"), value: "x", text: "X", order: "1" },
  ],
  catalog_script_client: [
    {
      sys_id: id("7c"),
      cat_item: ITEM,
      variable_set: "",
      name: "Model hint",
      type: "onChange",
      cat_variable: `IO:${V_MODEL}`,
      ui_type: "10",
      active: "true",
      script: "function onChange() {}",
    },
    {
      sys_id: id("8c"),
      cat_item: "",
      variable_set: SET,
      name: "Cost check",
      type: "onSubmit",
      ui_type: "0",
      active: "true",
      script: "function onSubmit() { return true; }",
    },
  ],
  catalog_ui_policy: [
    {
      sys_id: POLICY,
      catalog_item: ITEM,
      variable_set: "",
      short_description: "Explain a pro order",
      catalog_conditions: `IO:${V_MODEL}=pro^EQ`,
      reverse_if_false: "true",
      on_load: "true",
      order: "100",
      active: "true",
    },
  ],
  catalog_ui_policy_action: [
    {
      sys_id: id("bc"),
      ui_policy: POLICY,
      catalog_variable: `IO:${V_REASON}`,
      visible: "true",
      mandatory: "true",
      disabled: "ignore",
    },
  ],
  sc_cat_item_category: [
    { sys_id: id("e1"), sc_cat_item: ITEM, sc_category: id("e2") },
  ],
  sc_cat_item_user_criteria_mtom: invalidTable(
    "sc_cat_item_user_criteria_mtom",
  ),
};

// -- registry -----------------------------------------------------------------

test("P-8: every catalog / quality / AI / application row is registered and unverified", () => {
  for (const [type, [table, group]] of Object.entries(P8_TYPES)) {
    const t = getArtifactType(type);
    assert.ok(t, `missing ${type}`);
    assert.equal(t.table, table, type);
    assert.equal(t.group, group, type);
    assert.equal(t.verified, false, `${type} must stay verified:false (O-5)`);
    assert.equal(t.scriptTools, undefined, `${type} joins no script tool`);
    assert.equal(t.scriptToolsOptIn, undefined, type);
    assert.ok(!SCRIPT_TYPE_NAMES.includes(type), type);
    assert.ok(t.tiers.includes("R"), type);
  }
  // The delivery rows are read-only; the rest are explained too.
  for (const type of ["customer_update", "source_control"]) {
    assert.deepEqual(getArtifactType(type).tiers, ["R"], type);
  }
  assert.deepEqual(getArtifactType("catalog_item").tiers, ["R", "X"]);
  // The catalog client scripts stay in the script tools and are explained.
  const ccs = getArtifactType("catalog_client_script");
  assert.equal(ccs.scriptTools, true);
  assert.deepEqual(ccs.tiers, ["R", "X", "A", "S"]);
  assert.ok(SCRIPT_TYPE_NAMES.includes("catalog_client_script"));

  const children = (type) =>
    getArtifactType(type).children.map((c) =>
      [c.table, c.parentField, c.parentTable].filter(Boolean).join(":"),
    );
  assert.deepEqual(children("catalog_item"), [
    "item_option_new:cat_item",
    "io_set_item:sc_cat_item",
    "item_option_new_set:sys_id:io_set_item",
    "item_option_new:variable_set:io_set_item",
    "question_choice:question:item_option_new",
    "catalog_script_client:cat_item",
    "catalog_ui_policy:catalog_item",
    "catalog_script_client:variable_set:io_set_item",
    "catalog_ui_policy:variable_set:io_set_item",
    "catalog_ui_policy_action:ui_policy:catalog_ui_policy",
    "sc_cat_item_category:sc_cat_item",
    "sc_cat_item_user_criteria_mtom:sc_cat_item",
  ]);
  assert.deepEqual(
    children("record_producer"),
    children("catalog_item"),
    "a record producer is a catalog item form",
  );
  assert.deepEqual(children("atf_test"), ["sys_atf_step:test"]);
  assert.deepEqual(children("atf_test_suite"), [
    "sys_atf_test_suite_test:test_suite",
  ]);
  assert.deepEqual(children("ai_agent"), [
    "sn_aia_agent_config:agent",
    "sn_aia_agent_tool_m2m:agent",
    "sn_aia_tool:sys_id:sn_aia_agent_tool_m2m",
    "sn_aia_trigger_configuration:agent",
    "sn_aia_version:agent",
  ]);
  assert.deepEqual(validateArtifactTypes(), []);

  // The licensed families say which plugin they need.
  for (const type of ["ai_agent", "ai_agentic_workflow", "now_assist_skill"]) {
    assert.ok(getArtifactType(type).licensed, type);
  }
  const catalog = artifactTypeCatalog().types;
  assert.match(catalog.find((t) => t.type === "ai_agent").licensed, /sn_aia/);
  assert.equal(
    catalog.find((t) => t.type === "catalog_item").licensed,
    undefined,
  );
});

// -- list + explain for every row ---------------------------------------------

test("P-8: list_artifacts and explain_artifact work for every new row", async () => {
  for (const [type, [table]] of Object.entries(P8_TYPES)) {
    const t = getArtifactType(type);
    const record = {
      sys_id: id("1"),
      ...Object.fromEntries(t.keyFields.map((f) => [f, `k_${f}`])),
      [t.nameField]: `A ${type}`,
      sys_scope: APP_ID,
    };
    const list = await run(
      "servicenow_list_artifacts",
      { [table]: [record] },
      { artifactType: type },
    );
    assert.equal(list.error, undefined, `${type}: ${list.error}`);
    assert.equal(list.count, 1, type);
    assert.equal(list.artifacts[0].name, `A ${type}`, type);

    const calls = [];
    const ex = await run(
      "servicenow_explain_artifact",
      { [table]: record },
      { artifactType: type, sys_id: id("1") },
      calls,
    );
    assert.equal(ex.error, undefined, `${type}: ${ex.error}`);
    assert.match(ex.summary, new RegExp(`^${type} 'A ${type}'`), type);
    assert.equal(ex.children.length, t.children.length, type);
    const read = new Set(calls.map((c) => c.table));
    for (const c of t.children.filter((c) => !c.parentTable && !c.parentKey)) {
      assert.ok(read.has(c.table), `${type}: ${c.table} not read`);
    }
  }
});

// -- the catalog item explain ---------------------------------------------------

test("catalog_item explain: variables in order with their question_choice values", async () => {
  const calls = [];
  const ex = await run(
    "servicenow_explain_artifact",
    CATALOG,
    { artifactType: "catalog_item", sys_id: ITEM },
    calls,
  );
  assert.equal(ex.error, undefined, ex.error);
  const x = ex.explanation;
  assert.equal(x.kind, "catalog-form");

  // The item's own variables, by `order`, then the set's.
  assert.deepEqual(
    x.variables.map((v) => [v.order, v.name, v.typeName, v.mandatory]),
    [
      ["100", "reason", "Multi Line Text", false],
      ["200", "model", "Select Box", true],
    ],
  );
  assert.deepEqual(
    x.variables[1].choices.map((c) => [c.value, c.text]),
    [
      ["air", "Air"],
      ["pro", "Pro"],
      ["old", "Legacy"],
    ],
  );
  assert.equal(x.variables[1].choices[2].inactive, true);
  assert.deepEqual(x.variables[0].choices, []);
  assert.deepEqual(x.variableSets, [
    {
      sys_id: SET,
      order: "300",
      title: "Cost details",
      variables: ["cost_center"],
    },
  ]);
  assert.deepEqual(
    x.setVariables.map((v) => v.name),
    ["cost_center"],
  );
  assert.ok(
    !JSON.stringify(x).includes('"other"'),
    "a foreign variable leaked",
  );

  // Client scripts resolve `IO:<sys_id>` to the variable name.
  assert.deepEqual(
    x.clientScripts.map((c) => [c.name, c.type, c.variable, c.uiType]),
    [
      ["Model hint", "onChange", "model", "all UIs"],
      ["Cost check", "onSubmit", undefined, "desktop"],
    ],
  );
  assert.equal(x.clientScripts[1].variableSet, SET);
  // UI policies: the condition and what each action does to a variable.
  assert.deepEqual(x.uiPolicies[0].effects, [
    {
      variable: "reason",
      whenTrue: ["visible", "mandatory"],
      whenFalse: ["hidden", "optional"],
    },
  ]);
  assert.equal(x.uiPolicies[0].condition, `IO:${V_MODEL}=pro^EQ`);

  const lines = x.lines.join("\n");
  assert.ok(
    lines.indexOf("100 reason") < lines.indexOf("200 model"),
    "variables out of order",
  );
  assert.match(
    lines,
    /200 model "Model" \[Select Box, mandatory\]: air="Air", pro="Pro", old="Legacy" \(inactive\)/,
  );
  assert.match(lines, /Variable set 'Cost details' \(order 300\): 1 variable/);
  assert.match(
    lines,
    /reason visible, mandatory\. Otherwise: reason hidden, optional\./,
  );
  assert.match(
    lines,
    /sc_cat_item_user_criteria_mtom was not read: rejected by the instance \(400\)/,
  );

  // The queries behind it: direct and set variables, then all their choices.
  const q = (table) =>
    calls.filter((c) => c.table === table).map((c) => c.query);
  assert.deepEqual(q("item_option_new"), [
    `cat_item=${ITEM}^ORDERBYorder`,
    `variable_set=${SET}^ORDERBYorder`,
  ]);
  assert.deepEqual(q("item_option_new_set"), [`sys_id=${SET}`]);
  assert.deepEqual(q("question_choice"), [
    `questionIN${V_REASON},${V_MODEL},${V_COST}^ORDERBYorder`,
  ]);
  assert.deepEqual(q("catalog_script_client"), [
    `cat_item=${ITEM}`,
    `variable_set=${SET}`,
  ]);
  assert.deepEqual(q("catalog_ui_policy"), [
    `catalog_item=${ITEM}^ORDERBYorder`,
    `variable_set=${SET}^ORDERBYorder`,
  ]);
  assert.deepEqual(q("catalog_ui_policy_action"), [`ui_policy=${POLICY}`]);

  // An absent child table degrades that child only.
  const mtom = ex.children.find(
    (c) => c.table === "sc_cat_item_user_criteria_mtom",
  );
  assert.equal(mtom.status, 400);
  assert.equal(
    ex.children.find((c) => c.table === "sc_cat_item_category").count,
    1,
  );

  golden("catalog_form", x);
});

test("record_producer explains the same form; variable_set explains its own variables", async () => {
  const producer = await run(
    "servicenow_explain_artifact",
    {
      ...CATALOG,
      sc_cat_item_producer: {
        ...CATALOG.sc_cat_item,
        table_name: "incident",
        script: "current.short_description = producer.reason;",
      },
    },
    { artifactType: "record_producer", sys_id: ITEM },
  );
  assert.equal(producer.error, undefined, producer.error);
  assert.match(
    producer.explanation.lines[0],
    /^Record producer 'Acme laptop': 3 variable/,
  );
  assert.equal(producer.fields.table_name, "incident");

  const calls = [];
  const set = await run(
    "servicenow_explain_artifact",
    {
      ...CATALOG,
      item_option_new_set: {
        sys_id: SET,
        title: "Cost details",
        sys_scope: APP_ID,
      },
    },
    { artifactType: "variable_set", sys_id: SET },
    calls,
  );
  assert.equal(set.error, undefined, set.error);
  assert.equal(set.name, "Cost details");
  assert.equal(set.explanation.variableSets, undefined);
  assert.deepEqual(
    set.explanation.variables.map((v) => v.name),
    ["cost_center"],
  );
  assert.deepEqual(
    set.explanation.clientScripts.map((c) => c.name),
    ["Cost check"],
  );
  assert.equal(
    calls.find((c) => c.table === "io_set_item").query,
    `variable_set=${SET}^ORDERBYorder`,
  );
});

test("catalog_variable and catalog_ui_policy explain on their own", async () => {
  const variable = await run(
    "servicenow_explain_artifact",
    {
      ...CATALOG,
      item_option_new: { ...CATALOG.item_option_new[0], sys_scope: APP_ID },
      question_choice: CATALOG.question_choice,
    },
    { artifactType: "catalog_variable", sys_id: V_MODEL },
  );
  assert.equal(variable.error, undefined, variable.error);
  assert.equal(variable.explanation.kind, "catalog-variable");
  assert.deepEqual(
    variable.explanation.variable.choices.map((c) => c.value),
    ["air", "pro", "old"],
  );

  const policy = await run(
    "servicenow_explain_artifact",
    {
      ...CATALOG,
      catalog_ui_policy: { ...CATALOG.catalog_ui_policy[0], sys_scope: APP_ID },
    },
    { artifactType: "catalog_ui_policy", sys_id: POLICY },
  );
  assert.equal(policy.error, undefined, policy.error);
  assert.equal(policy.explanation.kind, "field-effects");
  assert.deepEqual(policy.explanation.effects, [
    {
      field: V_REASON,
      whenTrue: ["visible", "mandatory"],
      whenFalse: ["hidden", "optional"],
    },
  ]);
  assert.equal(policy.explanation.condition, `IO:${V_MODEL}=pro^EQ`);
});

// -- licensed families ----------------------------------------------------------

test("licensed families: absent sn_aia_* / sn_nowassist_skill_* tables answer available:false, no error", async () => {
  for (const type of ["ai_agent", "ai_agentic_workflow", "now_assist_skill"]) {
    const t = getArtifactType(type);
    const absent = { [t.table]: invalidTable(t.table), sys_db_object: [] };
    const list = await run("servicenow_list_artifacts", absent, {
      artifactType: type,
    });
    assert.equal(list.error, undefined, `${type}: ${list.error}`);
    assert.equal(list.count, 0, type);
    assert.equal(list.available, false, type);
    assert.equal(list.requires, t.licensed, type);

    const get = await run("servicenow_get_artifact", absent, {
      artifactType: type,
      sys_id: id("1"),
    });
    assert.equal(get.error, undefined, `${type}: ${get.error}`);
    assert.equal(get.record, null, type);
    assert.equal(get.available, false, type);

    // A 404 on the record read of an absent table is not a "not found".
    const ex = await run(
      "servicenow_explain_artifact",
      { sys_db_object: [] },
      { artifactType: type, sys_id: id("1") },
    );
    assert.equal(ex.error, undefined, `${type}: ${ex.error}`);
    assert.equal(ex.available, false, type);
    assert.equal(ex.requires, t.licensed, type);
    assert.match(ex.summary, /is not installed on this instance; it requires/);
  }

  // Present: available:true, and no `requires`.
  const present = await run(
    "servicenow_list_artifacts",
    {
      sn_aia_agent: invalidTable("sn_aia_agent"),
      sys_db_object: [{ name: "sn_aia_agent" }],
    },
    { artifactType: "ai_agent" },
  );
  assert.equal(present.available, true);
  assert.equal(present.requires, undefined);
});

test("licensed families: an agent whose child tables are absent degrades those children only", async () => {
  const ex = await run(
    "servicenow_explain_artifact",
    {
      sn_aia_agent: {
        sys_id: id("1e"),
        name: "Triage",
        active: "true",
        sys_scope: APP_ID,
      },
      sn_aia_agent_config: invalidTable("sn_aia_agent_config"),
      sn_aia_agent_tool_m2m: [
        { sys_id: id("2e"), agent: id("1e"), tool: id("3e") },
      ],
      sn_aia_tool: [{ sys_id: id("3e"), name: "Lookup" }],
      sn_aia_version: () =>
        jsonResponse(403, { error: { message: "User Not Authorized" } }),
    },
    { artifactType: "ai_agent", sys_id: id("1e") },
  );
  assert.equal(ex.error, undefined, ex.error);
  const child = (table) => ex.children.find((c) => c.table === table);
  assert.equal(child("sn_aia_agent_config").status, 400);
  assert.equal(child("sn_aia_version").status, 403);
  assert.equal(child("sn_aia_tool").count, 1);
  assert.equal(child("sn_aia_tool").items[0].name, "Lookup");
});
