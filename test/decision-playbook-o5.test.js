// O-5 — the decision-table and playbook readers ask only for columns that the
// sys_dictionary of a live instance (the ven03019 PDI) has. A rename that
// drifts from the dictionary fails here, not on a customer instance. The
// output keys are unchanged; the explanations carry the registry flag (OD-4).
import test from "node:test";
import assert from "node:assert/strict";

import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import { explainFlow } from "../build/api/explain-flow.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const SYS = ["sys_id", "sys_created_on", "sys_updated_on"];

/** The PDI dictionary columns (own + inherited) of every table read here. */
const PDI_COLUMNS = {
  sys_pd_process_definition: [
    "label",
    "name",
    "status",
    "active",
    "description",
    "snapshot",
  ],
  sys_pd_lane: [
    "label",
    "name",
    "order",
    "process_definition",
    "condition_to_run",
    "lane_condition",
    "active",
  ],
  sys_pd_activity: [
    "lane",
    "order",
    "label",
    "name",
    "activity_definition",
    "condition_to_run",
    "active",
    "variant",
    "process_definition",
  ],
  sys_pd_activity_definition: ["label", "name"],
  sys_pd_timer_attributes: [
    "active",
    "duration_type",
    "process_definition",
    "source",
    "source_type",
    "timer_duration",
  ],
  sys_pd_trigger_instance: [
    "label",
    "name",
    "process_definition",
    "trigger_definition",
    "trigger_definition.name",
    "trigger_type",
    "trigger_type.name",
  ],
  sys_pd_process_input: [
    "model",
    "element",
    "label",
    "internal_type",
    "reference",
    "mandatory",
    "default_value",
    "order",
    "name",
  ],
  sys_pd_process_output: [
    "model",
    "element",
    "label",
    "internal_type",
    "reference",
    "mandatory",
    "default_value",
    "order",
    "name",
  ],
  sys_pd_process_variant: ["label", "condition", "order", "process_definition"],
  sys_pd_context: [
    "name",
    "label",
    "state",
    "input_table",
    "input_record",
    "process_definition",
    "process_definition.source",
  ],
  sys_pd_activity_context: ["context", "state", "activity", "lane"],
  sys_db_object: ["name"],
};

const PB = "5".repeat(32);
const ACT = "7".repeat(32);

function playbookMock() {
  const reads = [];
  const rows = {
    sys_pd_process_definition: [{ sys_id: PB, label: "Onboarding" }],
    sys_pd_lane: [{ sys_id: "l1", label: "Intake", order: "1" }],
    sys_pd_activity: [{ sys_id: ACT, lane: "l1", label: "Collect" }],
    sys_pd_timer_attributes: [
      {
        sys_id: "t1",
        source: ACT,
        duration_type: "explicit_duration",
        timer_duration: "1970-01-02 00:00:00",
      },
    ],
    sys_pd_trigger_instance: [
      {
        sys_id: "tr1",
        trigger_type: "tt1",
        "trigger_type.name": "record_create",
      },
    ],
    sys_pd_context: [
      {
        sys_id: "c1",
        state: "IN_PROGRESS",
        input_table: "incident",
        input_record: "i1",
      },
    ],
  };
  const handler = (url) => {
    const u = new URL(url);
    const table = u.pathname.match(/\/api\/now\/table\/([^/]+)/)[1];
    reads.push({
      table,
      query: u.searchParams.get("sysparm_query") ?? "",
      fields: u.searchParams.get("sysparm_fields")?.split(",") ?? [],
    });
    return jsonResponse(200, { result: rows[table] ?? [] });
  };
  return { handler, reads };
}

test("O-5: the playbook reader asks only for PDI dictionary columns", async () => {
  const mock = playbookMock();
  const res = await withFetch(mock.handler, () =>
    explainFlow({ sys_id: PB, kind: "playbook", runs: 5 }),
  );
  assert.ok(mock.reads.length >= 10);
  for (const { table, fields } of mock.reads) {
    const known = PDI_COLUMNS[table];
    assert.ok(known, `unexpected table ${table}`);
    for (const f of fields) {
      assert.ok(
        SYS.includes(f) || known.includes(f),
        `${table}.${f} is not a PDI column`,
      );
    }
  }
  const query = (t) => mock.reads.find((r) => r.table === t).query;
  // A run's process_definition is the snapshot it ran; its source is the PB.
  assert.match(
    query("sys_pd_context"),
    new RegExp(`^process_definition\\.source=${PB}\\^`),
  );
  assert.equal(query("sys_pd_timer_attributes"), `sourceIN${ACT}`);
  assert.equal(res.verified, true);
  assert.deepEqual(res.lanes[0].activities[0].timers, [
    {
      sys_id: "t1",
      activity: ACT,
      type: "explicit_duration",
      duration: "1970-01-02 00:00:00",
    },
  ]);
  assert.equal(res.triggers[0].type, "record_create");
  assert.deepEqual([res.runs[0].table, res.runs[0].record], ["incident", "i1"]);
});

test("O-5: decision tables ignore the columns the PDI does not have", async () => {
  const TABLE = "d".repeat(32);
  const tables = {
    // `table` is not a sys_decision column; only answer_table is.
    sys_decision: { sys_id: TABLE, name: "Routing", table: "incident" },
    sys_decision_input: [
      // var_dictionary's `name` is the variable table, never the element.
      {
        sys_id: "i1",
        model: TABLE,
        name: "var__m_sys_decision_input_x",
        label: "Priority",
        order: "1",
        type: "string",
      },
    ],
    sys_decision_question: [
      {
        sys_id: "q1",
        decision_table: TABLE,
        order: "1",
        name: "n",
        conditions: "a=1",
        result: "r",
      },
    ],
  };
  const handler = (url) => {
    const u = new URL(url);
    const m = u.pathname.match(/\/api\/now\/table\/([^/]+)(?:\/([^/]+))?$/);
    const value = tables[m[1]];
    if (m[2]) return jsonResponse(200, { result: value });
    return jsonResponse(200, { result: Array.isArray(value) ? value : [] });
  };
  freshRuntime();
  const res = await withEnv(
    { SN_SDK_MANAGED_SCOPES: undefined, SN_SDK_PROJECT_DIRS: "" },
    () =>
      withFetch(handler, () =>
        runSpec(
          ALL_TOOLS.find((s) => s.name === "servicenow_explain_artifact"),
          { artifactType: "decision_table", sys_id: TABLE },
        ),
      ),
  );
  assert.equal(res.isError, undefined, res.content?.[0]?.text);
  const x = res.structuredContent.explanation;
  assert.equal(x.answerTable, undefined);
  assert.deepEqual(x.inputs, [
    { sys_id: "i1", element: "", label: "Priority", order: "1" },
  ]);
  assert.deepEqual(x.rows, [{ sys_id: "q1", order: "1" }]);
  assert.equal(x.verified, true);
});
