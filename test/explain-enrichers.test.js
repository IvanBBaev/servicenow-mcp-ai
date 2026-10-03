// P-7 — core / server-logic / classic-UI descriptors (SDK-PARITY §4.1–§4.3):
// every new row lists and explains, value-linked children (`parentKey`,
// `alsoMatch`) build the right queries, an absent table answers
// available:false, and the type-specific explain enrichers (state model,
// choice table, UI / data policy field effects) against golden fixtures.
// Regenerate the goldens deliberately with `UPDATE_GOLDEN=1 npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { explainArtifactFor } from "../build/api/explain-artifact.js";
import { tableAvailable } from "../build/api/artifacts.js";
import { getExplainer, registerExplainer } from "../build/api/explainers.js";
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
const id = (c) => c.repeat(32);

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

/** The P-7 rows (SDK-PARITY §4.1 – §4.3) and the table each one reads. */
const P7_TYPES = {
  table: "sys_db_object",
  choice_set: "sys_choice_set",
  state_model: "sttrm_model",
  property: "sys_properties",
  user_preference: "sys_user_preference",
  role: "sys_user_role",
  cross_scope_privilege: "sys_scope_privilege",
  user_criteria: "user_criteria",
  field_style: "sys_ui_style",
  schedule: "cmn_schedule",
  event: "sysevent_register",
  relationship: "sys_relationship",
  ldap_server: "ldap_server_config",
  js_module: "sys_module",
  rest_message: "sys_rest_message",
  graphql_api: "sys_graphql_schema",
  alias: "sys_alias",
  alias_template: "sys_alias_templates",
  retry_policy: "sys_retry_policy",
  data_lookup: "dl_definition",
  email_notification: "sysevent_email_action",
  inbound_email_action: "sysevent_in_email_action",
  sla: "contract_sla",
  data_policy: "sys_data_policy2",
  workspace_form_action: "sys_ux_form_action",
  form: "sys_ui_form",
  ui_section: "sys_ui_section",
  list: "sys_ui_list",
  application_menu: "sys_app_application",
  ui_view: "sys_ui_view",
  list_control: "sys_ui_list_control",
};

/**
 * Table API mock that records every request. `tables[name]` is a record
 * (primary read by sys_id) or an array of rows (queries); a function gets
 * `(searchParams, sysId)` and returns a Response. Unknown tables: no rows.
 */
function tableMock(tables, calls = []) {
  return (url) => {
    const u = new URL(url);
    const m = u.pathname.match(/\/api\/now\/table\/([^/]+)(?:\/([^/]+))?$/);
    assert.ok(m, `unexpected request ${url}`);
    calls.push({
      table: m[1],
      id: m[2],
      query: u.searchParams.get("sysparm_query"),
    });
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
    return jsonResponse(200, {
      result: Array.isArray(value) ? value : value ? [value] : [],
    });
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

// -- registry -----------------------------------------------------------------

test("P-7: every core / server / classic-UI row is registered, unverified, script-tools free", () => {
  for (const [type, table] of Object.entries(P7_TYPES)) {
    const t = getArtifactType(type);
    assert.ok(t, `missing ${type}`);
    assert.equal(t.table, table, type);
    assert.equal(t.verified, false, `${type} must stay verified:false (O-5)`);
    assert.ok(["core", "server", "classic-ui"].includes(t.group), type);
    assert.equal(
      t.scriptTools,
      undefined,
      `${type} must not join the script tools`,
    );
    assert.deepEqual(t.tiers, ["R", "X"], type);
  }
  // The script tools scan exactly what they scanned before P-7.
  for (const type of Object.keys(P7_TYPES)) {
    assert.ok(!SCRIPT_TYPE_NAMES.includes(type), type);
  }
  // SDK-PARITY §4 children the rows declare.
  const children = (type) => getArtifactType(type).children.map((c) => c.table);
  assert.deepEqual(children("table"), [
    "sys_dictionary",
    "sys_dictionary_override",
    "sys_documentation",
    "sys_choice",
  ]);
  assert.deepEqual(children("state_model"), [
    "sttrm_state",
    "sttrm_state_transition",
    "sttrm_transition_condition",
  ]);
  assert.deepEqual(children("acl"), ["sys_security_acl_role"]);
  assert.deepEqual(children("role"), ["sys_user_role_contains"]);
  assert.deepEqual(children("data_policy"), ["sys_data_policy_rule"]);
  assert.deepEqual(children("form"), ["sys_ui_form_section", "sys_ui_element"]);
  assert.deepEqual(children("list"), ["sys_ui_list_element"]);
  assert.deepEqual(children("application_menu"), ["sys_app_module"]);
  assert.deepEqual(children("ui_view"), ["sysrule_view"]);
  assert.equal(getArtifactType("ldap_server").secretFields[0], "password");
  assert.deepEqual(validateArtifactTypes(), []);
});

test("validateArtifactTypes: empty value links and a nested alsoMatch are defects", () => {
  const good = getArtifactType("choice_set");
  const problems = validateArtifactTypes([
    getArtifactType("table"),
    {
      ...good,
      type: "links",
      children: [
        { table: "a", parentField: "p", parentKey: "" },
        {
          table: "b",
          parentField: "p",
          alsoMatch: [{ field: "", parentKey: "x" }],
        },
        {
          table: "c",
          parentField: "p",
          parentTable: "a",
          alsoMatch: [{ field: "f", parentKey: "g" }],
        },
        {
          table: "d",
          parentField: "p",
          alsoMatch: [{ field: "f", parentKey: "" }],
        },
      ],
    },
  ]);
  assert.deepEqual(problems, [
    "links > a: empty parentKey or alsoMatch field",
    "links > b: empty parentKey or alsoMatch field",
    "links > c: alsoMatch needs the primary table as parent",
    "links > d: empty parentKey or alsoMatch field",
  ]);
});

// -- list + explain for every row ------------------------------------------------

test("P-7: list_artifacts and explain_artifact work for every new row", async () => {
  for (const [type, table] of Object.entries(P7_TYPES)) {
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
    assert.equal(list.verified, false, type);

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
    // Every child table is queried (the mock returns no rows, so nested
    // children have no parents and are skipped).
    const read = new Set(calls.map((c) => c.table));
    for (const c of t.children.filter((c) => !c.parentTable)) {
      assert.ok(read.has(c.table), `${type}: ${c.table} not read`);
    }
  }
});

// -- value-linked children -------------------------------------------------------

test("value-linked children: table by name, choice set by name + element, form elements by section", async () => {
  let calls = [];
  await run(
    "servicenow_get_artifact",
    {
      sys_db_object: {
        sys_id: id("1"),
        name: "x_acme_task",
        sys_scope: APP_ID,
      },
    },
    { artifactType: "table", sys_id: id("1") },
    calls,
  );
  assert.deepEqual(
    calls
      .filter((c) => c.table.startsWith("sys_d") || c.table === "sys_choice")
      .map((c) => [c.table, c.query]),
    [
      ["sys_db_object", null],
      ["sys_dictionary", "name=x_acme_task^ORDERBYelement"],
      ["sys_dictionary_override", "name=x_acme_task"],
      ["sys_documentation", "name=x_acme_task^ORDERBYelement"],
      ["sys_choice", "name=x_acme_task^ORDERBYelement"],
    ],
  );

  calls = [];
  await run(
    "servicenow_get_artifact",
    {
      sys_choice_set: {
        sys_id: id("1"),
        name: "incident",
        element: "",
        sys_scope: APP_ID,
      },
    },
    { artifactType: "choice_set", sys_id: id("1") },
    calls,
  );
  assert.equal(
    calls.find((c) => c.table === "sys_choice").query,
    "name=incident^elementISEMPTY^ORDERBYsequence",
  );

  calls = [];
  const got = await run(
    "servicenow_get_artifact",
    {
      sys_ui_form: {
        sys_id: id("1"),
        name: "incident",
        view: id("2"),
        sys_scope: APP_ID,
      },
      sys_ui_form_section: [
        {
          sys_id: id("3"),
          sys_ui_form: id("1"),
          sys_ui_section: id("5"),
          position: "0",
        },
        {
          sys_id: id("4"),
          sys_ui_form: id("1"),
          sys_ui_section: id("6"),
          position: "1",
        },
      ],
      sys_ui_element: [
        { sys_id: id("7"), sys_ui_section: id("5"), element: "number" },
      ],
    },
    { artifactType: "form", sys_id: id("1") },
    calls,
  );
  assert.equal(
    calls.find((c) => c.table === "sys_ui_element").query,
    `sys_ui_sectionIN${id("5")},${id("6")}^ORDERBYposition`,
  );
  assert.equal(got.children[1].count, 1);

  // A parent value that would widen the query is never sent.
  calls = [];
  const unsafe = await run(
    "servicenow_get_artifact",
    {
      sys_choice_set: {
        sys_id: id("1"),
        name: "incident^ORactive=true",
        element: "state",
        sys_scope: APP_ID,
      },
      sys_db_object: {
        sys_id: id("1"),
        name: "x\nevil",
        sys_scope: APP_ID,
      },
    },
    { artifactType: "choice_set", sys_id: id("1") },
    calls,
  );
  assert.ok(!calls.some((c) => c.table === "sys_choice"));
  assert.equal(unsafe.children[0].count, 0);

  calls = [];
  await run(
    "servicenow_get_artifact",
    {
      sys_choice_set: {
        sys_id: id("1"),
        name: "incident",
        element: "state\r",
        sys_scope: APP_ID,
      },
    },
    { artifactType: "choice_set", sys_id: id("1") },
    calls,
  );
  assert.ok(!calls.some((c) => c.table === "sys_choice"));
});

// -- availability ------------------------------------------------------------------

const invalidTable = () =>
  jsonResponse(400, { error: { message: "Invalid table sys_graphql_schema" } });

test("availability: an absent table answers available:false on list, get and explain", async () => {
  const absent = { sys_graphql_schema: invalidTable, sys_db_object: [] };
  const list = await run("servicenow_list_artifacts", absent, {
    artifactType: "graphql_api",
  });
  assert.equal(list.count, 0);
  assert.equal(list.degraded.status, 400);
  assert.equal(list.available, false);

  const get = await run("servicenow_get_artifact", absent, {
    artifactType: "graphql_api",
    sys_id: id("1"),
  });
  assert.equal(get.record, null);
  assert.equal(get.available, false);

  const calls = [];
  const ex = await run(
    "servicenow_explain_artifact",
    { sys_db_object: [] }, // the primary read 404s: no such table
    { artifactType: "state_model", sys_id: id("1") },
    calls,
  );
  assert.equal(ex.available, false);
  assert.equal(ex.degraded.status, 404);
  assert.match(ex.summary, /could not be read/);
  assert.equal(
    calls.find((c) => c.table === "sys_db_object").query,
    "name=sttrm_model",
  );
});

test("availability: a present table is available:true; a 404 there is a real not-found", async () => {
  const present = {
    sys_graphql_schema: invalidTable,
    sys_db_object: [{ name: "sys_graphql_schema" }],
  };
  const list = await run("servicenow_list_artifacts", present, {
    artifactType: "graphql_api",
  });
  assert.equal(list.available, true);

  const get = await run(
    "servicenow_get_artifact",
    { sys_db_object: [{ name: "sttrm_model" }] },
    { artifactType: "state_model", sys_id: id("1") },
  );
  assert.match(get.error, /No Record found/);
});

test("availability: a probe that cannot answer leaves the field out", async () => {
  const denied = {
    sys_graphql_schema: invalidTable,
    sys_db_object: () => jsonResponse(403, { error: { message: "denied" } }),
  };
  const list = await run("servicenow_list_artifacts", denied, {
    artifactType: "graphql_api",
  });
  assert.equal(list.degraded.status, 400);
  assert.ok(!("available" in list));

  const get = await run(
    "servicenow_get_artifact",
    { sys_db_object: denied.sys_db_object },
    { artifactType: "state_model", sys_id: id("1") },
  );
  assert.match(get.error, /No Record found/);

  freshRuntime();
  await withEnv({ SN_TABLES_DENY: "sys_db_object" }, () =>
    withFetch(tableMock({}), async () => {
      assert.equal(await tableAvailable("sttrm_model"), undefined);
    }),
  );
});

// -- enrichers: goldens ----------------------------------------------------------

async function explainGolden(name, artifactType, tables) {
  const out = await run("servicenow_explain_artifact", tables, {
    artifactType,
    sys_id: id("1"),
  });
  assert.equal(out.error, undefined, out.error);
  golden(name, out);
  return out;
}

test("explain golden — state model transitions", async () => {
  const out = await explainGolden("state_model", "state_model", {
    sttrm_model: {
      sys_id: id("1"),
      name: "Acme task lifecycle",
      table: "x_acme_task",
      state_field: "state",
      sys_scope: APP_ID,
    },
    sttrm_state: [
      { sys_id: id("2"), model: id("1"), state_value: "1", label: "New" },
      {
        sys_id: id("3"),
        model: id("1"),
        state_value: "2",
        label: "Work in progress",
      },
      { sys_id: id("4"), model: id("1"), state_value: "3", label: "Closed" },
    ],
    sttrm_state_transition: [
      {
        sys_id: id("5"),
        model: id("1"),
        from_state: id("2"),
        to_state: id("3"),
      },
      {
        sys_id: id("6"),
        model: id("1"),
        name: "Close",
        from_state: id("3"),
        to_state: "3",
      },
      { sys_id: id("7"), model: id("1"), from_state: "", to_state: "9" },
    ],
    sttrm_transition_condition: [
      {
        sys_id: id("8"),
        transition: id("6"),
        condition: "close_notesISNOTEMPTY",
      },
      { sys_id: id("9"), transition: id("6"), condition: "" },
    ],
  });
  assert.deepEqual(out.explanation.lines.slice(2), [
    "New (1) -> Work in progress (2)",
    "Work in progress (2) -> Closed (3) when close_notesISNOTEMPTY",
    "(any) -> 9",
  ]);
});

test("explain golden — choice set as a choice table", async () => {
  const out = await explainGolden("choice_set", "choice_set", {
    sys_choice_set: {
      sys_id: id("1"),
      name: "incident",
      element: "priority",
      sys_scope: APP_ID,
    },
    sys_choice: [
      {
        sys_id: id("2"),
        name: "incident",
        element: "priority",
        value: "2",
        label: "High",
        sequence: "2",
      },
      {
        sys_id: id("3"),
        name: "incident",
        element: "priority",
        value: "1",
        label: "Critical",
        sequence: "1",
      },
      {
        sys_id: id("4"),
        name: "incident",
        element: "priority",
        value: "5",
        label: "Planning",
        sequence: "",
        inactive: "true",
        dependent_value: "x",
        language: "de",
      },
      {
        sys_id: id("5"),
        name: "incident",
        element: "priority",
        value: "4",
        label: "Low",
        sequence: "",
      },
    ],
  });
  assert.deepEqual(
    out.explanation.elements[0].choices.map((c) => c.value),
    ["1", "2", "4", "5"],
  );
});

test("explain golden — data policy field effects", async () => {
  await explainGolden("data_policy", "data_policy", {
    sys_data_policy2: {
      sys_id: id("1"),
      short_description: "Resolved incidents need close fields",
      model_table: "incident",
      conditions: "state=6",
      reverse_if_false: "true",
      apply_import_set: "true",
      apply_soap: "false",
      use_as_ui_policy: "true",
      active: "true",
      sys_scope: APP_ID,
    },
    sys_data_policy_rule: [
      {
        sys_id: id("2"),
        sys_data_policy: id("1"),
        field: "close_code",
        mandatory: "true",
        disabled: "ignore",
      },
      {
        sys_id: id("3"),
        sys_data_policy: id("1"),
        field: "number",
        mandatory: "ignore",
        disabled: "true",
      },
      {
        sys_id: id("4"),
        sys_data_policy: id("1"),
        field: "notes",
        mandatory: "ignore",
        disabled: "ignore",
      },
    ],
  });
});

test("field effects: ui policy without reverse, not on load; data policy with no flags", async () => {
  const ui = await run(
    "servicenow_explain_artifact",
    {
      sys_ui_policy: {
        sys_id: id("1"),
        short_description: "Lock",
        table: "incident",
        on_load: "false",
        reverse_if_false: "false",
        sys_scope: APP_ID,
      },
      sys_ui_policy_action: [
        {
          sys_id: id("2"),
          ui_policy: id("1"),
          field: "short_description",
          disabled: "true",
          cleared: "true",
          visible: "true",
        },
      ],
    },
    { artifactType: "ui_policy", sys_id: id("1") },
  );
  assert.deepEqual(ui.explanation.lines, [
    "Always on incident: short_description visible, read-only, cleared.",
    "Not applied on form load, only on field change.",
  ]);
  assert.equal(ui.explanation.condition, null);

  const dp = await run(
    "servicenow_explain_artifact",
    {
      sys_data_policy2: {
        sys_id: id("1"),
        short_description: "Empty",
        sys_scope: APP_ID,
      },
      sys_data_policy_rule: () =>
        jsonResponse(403, { error: { message: "no" } }),
    },
    { artifactType: "data_policy", sys_id: id("1") },
  );
  assert.deepEqual(dp.explanation.lines, [
    "Always: no field changes.",
    "Import set, web service and UI policy flags are all off.",
    "sys_data_policy_rule was not read: rejected by the instance (403).",
  ]);
});

test("choice table: a table's own choices; none read means no explanation", async () => {
  const withChoices = await run(
    "servicenow_explain_artifact",
    {
      sys_db_object: {
        sys_id: id("1"),
        name: "x_acme_task",
        sys_scope: APP_ID,
      },
      sys_choice: [
        {
          sys_id: id("2"),
          name: "x_acme_task",
          element: "state",
          value: "1",
          label: "Open",
          sequence: "1",
        },
        {
          sys_id: id("3"),
          name: "x_acme_task",
          element: "impact",
          value: "1",
          label: "High",
          sequence: "1",
        },
      ],
    },
    { artifactType: "table", sys_id: id("1") },
  );
  assert.deepEqual(withChoices.explanation.lines, [
    "2 choice(s) on 2 element(s) of x_acme_task.",
    'impact: 1="High"',
    'state: 1="Open"',
  ]);

  const none = await run(
    "servicenow_explain_artifact",
    {
      sys_db_object: {
        sys_id: id("1"),
        name: "x_acme_task",
        sys_scope: APP_ID,
      },
    },
    { artifactType: "table", sys_id: id("1") },
  );
  assert.ok(!("explanation" in none));

  const denied = await withEnv({ SN_TABLES_DENY: "sys_choice" }, () =>
    run(
      "servicenow_explain_artifact",
      {
        sys_db_object: {
          sys_id: id("1"),
          name: "x_acme_task",
          sys_scope: APP_ID,
        },
      },
      { artifactType: "table", sys_id: id("1") },
    ),
  );
  assert.deepEqual(denied.explanation.lines, [
    "0 choice(s) on 0 element(s) of x_acme_task.",
    "sys_choice was not read: denied by the table policy.",
  ]);
});

test("state model: unread children are named", async () => {
  const out = await withEnv({ SN_TABLES_DENY: "sttrm_state_transition" }, () =>
    run(
      "servicenow_explain_artifact",
      { sttrm_model: { sys_id: id("1"), name: "Bare", sys_scope: APP_ID } },
      { artifactType: "state_model", sys_id: id("1") },
    ),
  );
  assert.deepEqual(out.explanation.lines, [
    "State model 'Bare': 0 state(s), 0 transition(s).",
    "sttrm_state_transition was not read: denied by the table policy.",
    "sttrm_transition_condition was not read: Parent table sttrm_state_transition was not read.",
  ]);
});

// -- the enricher hook -------------------------------------------------------------

test("enricher hook: pluggable, guarded and budget-capped", async () => {
  const t = getArtifactType("property");
  assert.equal(getExplainer("property"), undefined);
  const tables = {
    sys_properties: { sys_id: id("1"), name: "x_acme.flag", sys_scope: APP_ID },
  };
  const explain = () =>
    withEnv(SDK_OFF, () =>
      withFetch(tableMock(tables), () =>
        explainArtifactFor(t, { sys_id: id("1") }),
      ),
    );

  let restore = registerExplainer("property", ({ record }) => ({
    kind: "custom",
    lines: [`property ${record.name}`],
  }));
  try {
    freshRuntime();
    assert.deepEqual((await explain()).explanation, {
      kind: "custom",
      lines: ["property x_acme.flag"],
    });
  } finally {
    restore();
  }
  assert.equal(getExplainer("property"), undefined);

  restore = registerExplainer("property", () => {
    throw new Error("boom");
  });
  try {
    freshRuntime();
    assert.deepEqual((await explain()).explanation, {
      kind: "error",
      lines: ["The property explainer failed: boom"],
    });
  } finally {
    restore();
  }

  // An oversized explanation keeps its kind and the lines that fit.
  restore = registerExplainer("property", () => ({
    kind: "big",
    lines: Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(80)}`),
    blob: "y".repeat(20000),
  }));
  try {
    freshRuntime();
    const out = await withEnv({ SN_MAX_RESULT_CHARS: "10000" }, explain);
    assert.equal(out.explanation.kind, "big");
    assert.equal(out.explanation.truncated, true);
    assert.ok(out.explanation.chars > 20000);
    assert.ok(out.explanation.lines.length > 0);
    assert.ok(out.explanation.lines.length < 400);
    assert.ok(JSON.stringify(out.explanation).length < 5000);
  } finally {
    restore();
  }

  // An explainer answering undefined adds nothing; a replaced one comes back.
  const original = getExplainer("ui_policy");
  restore = registerExplainer("ui_policy", () => undefined);
  restore();
  assert.equal(getExplainer("ui_policy"), original);
});
