// N-57 (TK-35): response-size goldens. Each case runs one tool through
// runSpec against synthetic, anonymised ServiceNow payloads (a deterministic
// generator, `synthetic: true` until O-5) and pins what the result costs on
// the wire, `{textBytes, structuredBytes}` (core/metrics measureResultBytes).
// A change in either figure is a reviewed diff of
// test/fixtures/response-sizes.json: refresh it with UPDATE_GOLDEN=1.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

import { ALL_TOOLS } from "../build/mcp/registry.js";
import { buildOutputSchema, runSpec } from "../build/mcp/define.js";
import { measureResultBytes } from "../build/core/metrics.js";
import { baselineEnv, createFetchDouble, freshRuntime } from "./helpers.js";
import { INCIDENT_COLUMNS, incident, stamp, sysId } from "./synthetic.js";

const GOLDEN = new URL("./fixtures/response-sizes.json", import.meta.url);

// --- synthetic payloads -----------------------------------------------------

function dictionary(i) {
  const element = INCIDENT_COLUMNS[i];
  return {
    name: "incident",
    element,
    column_label: element.replace(/_/g, " "),
    internal_type: i % 9 === 0 ? "reference" : "string",
    mandatory: i % 13 === 0 ? "true" : "false",
    max_length: i % 9 === 0 ? "32" : "100",
    reference: i % 9 === 0 ? "sys_user" : "",
    default_value: "",
    read_only: "false",
    unique: "false",
  };
}

const BUSINESS_RULE_SCRIPT = [
  "(function executeRule(current, previous /*null when async*/) {",
  "  if (current.priority.changesTo('1')) {",
  "    var gr = new GlideRecord('sys_user_group');",
  "    if (gr.get(current.assignment_group)) {",
  "      gs.eventQueue('incident.p1.assigned', current, gr.getValue('manager'), '');",
  "    }",
  "  }",
  "  current.u_custom_020 = gs.getUserName();",
  "})(current, previous);",
].join("\n");

function businessRule(i) {
  return {
    sys_id: sysId("c3", i),
    name: `Synthetic rule ${i}`,
    collection: "incident",
    when: i % 2 ? "after" : "before",
    order: String(100 + i),
    active: "true",
    global: "true",
    action_insert: "true",
    action_update: "true",
    action_delete: "false",
    action_query: "false",
    advanced: "true",
    condition: "priority=1",
    filter_condition: "",
    script: BUSINESS_RULE_SCRIPT,
    description: `Synthetic business rule ${i}.`,
    sys_scope: "global",
    sys_package: "global",
    sys_domain: "global",
    sys_overrides: "",
    sys_updated_on: stamp(i),
    sys_updated_by: "synthetic.user",
    sys_created_on: stamp(i),
    sys_created_by: "synthetic.user",
  };
}

const named = (prefix, label) => (i) => ({
  sys_id: sysId(prefix, i),
  name: `Synthetic ${label} ${i}`,
  active: "true",
  description: `Synthetic ${label} ${i}, anonymised.`,
  state: i % 3 ? "in progress" : "complete",
  application: "global",
  "application.name": "Global",
  is_default: "false",
  sys_created_by: "synthetic.user",
  sys_updated_on: stamp(i),
});

const TABLE_ROWS = {
  incident: incident,
  sys_dictionary: dictionary,
  sys_script: businessRule,
  sys_update_set: named("d4", "update set"),
  sys_hub_flow: named("e5", "flow"),
  sys_atf_test: named("f6", "test"),
};

/** The rows a table read returns: `sysparm_limit` of them, at most 200. */
function tableRows(table, query) {
  const make = TABLE_ROWS[table];
  if (!make) return [];
  if (table === "sys_dictionary") {
    return INCIDENT_COLUMNS.map((_, i) => dictionary(i));
  }
  const limit = Math.min(Number(query.get("sysparm_limit") ?? 50), 200);
  return Array.from({ length: limit }, (_, i) => make(i + 1));
}

function synthetic(call) {
  const table = /^\/api\/now\/table\/([^/]+)(?:\/([^/]+))?$/.exec(call.path);
  if (table) {
    const [, name, id] = table;
    if (id) {
      const make = TABLE_ROWS[name];
      return { json: { result: make ? make(1) : {} } };
    }
    if (name === "sys_db_object") {
      return {
        json: { result: [{ name: "incident", "super_class.name": "task" }] },
      };
    }
    return { json: { result: tableRows(name, call.query) } };
  }
  if (call.path.startsWith("/api/now/stats/")) {
    return {
      json: {
        result: ["1", "2", "3", "4", "5"].map((priority, i) => ({
          groupby_fields: [{ field: "priority", value: priority }],
          stats: { count: String(40 - i * 7) },
        })),
      },
    };
  }
  return { status: 404, json: { error: { message: "not synthetic" } } };
}

// --- cases ------------------------------------------------------------------

const ID = sysId("a1", 1);
const RULE = sysId("c3", 1);

/** One case per row: a key, the tool and its arguments. */
const CASES = [
  [
    "query_table.incident-100-columns",
    "servicenow_query_table",
    { table: "incident", limit: 1 },
  ],
  [
    "query_table.incident-200-rows",
    "servicenow_query_table",
    { table: "incident", limit: 200 },
  ],
  [
    "get_record.incident-100-columns",
    "servicenow_get_record",
    { table: "incident", sys_id: ID },
  ],
  [
    "describe_table.incident",
    "servicenow_describe_table",
    { table: "incident" },
  ],
  [
    "get_artifact.business_rule",
    "servicenow_get_artifact",
    { artifactType: "business_rule", sys_id: RULE },
  ],
  [
    "explain_artifact.business_rule",
    "servicenow_explain_artifact",
    { artifactType: "business_rule", sys_id: RULE },
  ],
  [
    "aggregate.group_by",
    "servicenow_aggregate",
    { table: "incident", group_by: ["priority"], count: true },
  ],
  ["list_update_sets", "servicenow_list_update_sets", {}],
  ["list_flows", "servicenow_list_flows", {}],
  ["list_atf_tests", "servicenow_list_atf_tests", {}],
  [
    "list_scripts.business_rule",
    "servicenow_list_scripts",
    { type: "business_rule" },
  ],
];

async function measure(name, args) {
  const spec = ALL_TOOLS.find((t) => t.name === name);
  assert.ok(spec, `${name} is registered`);
  baselineEnv();
  freshRuntime();
  const double = createFetchDouble({ fallback: synthetic }).install();
  try {
    const result = await runSpec(spec, args);
    return { spec, result };
  } finally {
    double.restore();
  }
}

const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
const measured = {};

for (const [key, name, args] of CASES) {
  test(`response size: ${key}`, async () => {
    const { spec, result } = await measure(name, args);
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    if (result.structuredContent !== undefined) {
      const parsed = buildOutputSchema(spec)?.safeParse(
        result.structuredContent,
      );
      assert.ok(parsed?.success ?? true, JSON.stringify(parsed?.error?.issues));
    }
    const { text, structured } = measureResultBytes(result);
    measured[key] = {
      tool: name,
      textBytes: text,
      structuredBytes: structured,
    };
    if (process.env.UPDATE_GOLDEN === "1") return;
    assert.deepEqual(
      measured[key],
      golden.cases[key],
      `${key}: response size changed; review it and refresh with UPDATE_GOLDEN=1`,
    );
  });
}

test("response-size goldens have no stale case", () => {
  if (process.env.UPDATE_GOLDEN === "1") return;
  assert.deepEqual(
    Object.keys(golden.cases).sort(),
    CASES.map(([key]) => key).sort(),
  );
});

test.after(() => {
  if (process.env.UPDATE_GOLDEN !== "1") return;
  const out = { synthetic: true, cases: {} };
  for (const [key] of CASES) out.cases[key] = measured[key];
  writeFileSync(GOLDEN, `${JSON.stringify(out, null, 2)}\n`);
});
