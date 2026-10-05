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

const GOLDEN = new URL("./fixtures/response-sizes.json", import.meta.url);

// --- synthetic payloads -----------------------------------------------------

const sysId = (prefix, i) =>
  `${prefix}${String(i).padStart(32 - prefix.length, "0")}`;
const stamp = (i) =>
  `2026-0${1 + (i % 9)}-${String(10 + (i % 18)).padStart(2, "0")} 08:${String(i % 60).padStart(2, "0")}:00`;

/** The 100 columns of the synthetic incident, base fields first. */
const INCIDENT_COLUMNS = [
  "sys_id",
  "number",
  "short_description",
  "description",
  "state",
  "priority",
  "impact",
  "urgency",
  "category",
  "subcategory",
  "assignment_group",
  "assigned_to",
  "caller_id",
  "opened_at",
  "opened_by",
  "sys_created_on",
  "sys_created_by",
  "sys_updated_on",
  "sys_updated_by",
  "sys_mod_count",
];
for (let n = INCIDENT_COLUMNS.length; n < 100; n += 1) {
  INCIDENT_COLUMNS.push(`u_custom_${String(n).padStart(3, "0")}`);
}

function incident(i) {
  const row = {};
  for (const column of INCIDENT_COLUMNS) {
    switch (column) {
      case "sys_id":
        row[column] = sysId("a1", i);
        break;
      case "number":
        row[column] = `INC${String(10_000 + i).padStart(7, "0")}`;
        break;
      case "short_description":
        row[column] = `Synthetic incident ${i}: service degraded`;
        break;
      case "description":
        row[column] =
          `Synthetic description ${i}. Users report slow responses on the portal; ` +
          "the issue reproduces in two regions.";
        break;
      case "state":
      case "priority":
      case "impact":
      case "urgency":
        row[column] = String(1 + (i % 3));
        break;
      case "assignment_group":
      case "assigned_to":
      case "caller_id":
      case "opened_by":
        row[column] = sysId("b2", i % 7);
        break;
      case "opened_at":
      case "sys_created_on":
      case "sys_updated_on":
        row[column] = stamp(i);
        break;
      case "sys_created_by":
      case "sys_updated_by":
        row[column] = "synthetic.user";
        break;
      case "sys_mod_count":
        row[column] = String(i % 11);
        break;
      default:
        row[column] = i % 4 === 0 ? "" : `value ${column.slice(-3)}-${i}`;
    }
  }
  return row;
}

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
