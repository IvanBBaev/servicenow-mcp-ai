// P-10 / P-13 — servicenow_explain_flow: a fixture flow with if/else,
// forEach, tryCatch and a subflow call (v1 and _v2 instance tables mixed),
// plain-JSON and base64 + gzip step values with data pills labelled from
// label_cache, draft vs published, opt-in runs with log errors; a legacy
// workflow whose Mermaid edges match its wf_transition rows one-to-one, its
// stages, runs and migration report (per workflow and instance-wide);
// unreadable and policy-denied tables as caveats; the Mermaid goldens and the
// markdown / file formats. P-11: a custom action (kind:"action") with its
// inputs, outputs and step instances; the flow's action / subflow calls
// expanded one level down by default, with the depth cap, the cycle guard and
// the distinct-callee cap. Every read goes through withMetadataFetch.
// Regenerate the goldens deliberately with `UPDATE_GOLDEN=1 npm test`.
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
import { gzipSync } from "node:zlib";
import fc from "fast-check";

import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS, PACKAGES } from "../build/mcp/registry.js";
import {
  decodeValues,
  EXPLAIN_FLOW_RUNS,
  pillLabels,
  RAW_PREVIEW,
  TREE_DEPTH_MAX,
} from "../build/api/explain-flow.js";
import { detectFlowValues } from "../build/core/artifacts/flow-values.js";
import { lintMermaid } from "./mermaid-lint.js";
import {
  assertMetadataUrl,
  baselineEnv,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const FIXTURES = path.join(import.meta.dirname, "fixtures", "explain");

const id = (c) => c.repeat(32);
const FLOW = id("a");
const SNAP = id("b");
const SNAP2 = id("c");
const TDEF = id("d");
const ROLE = id("e");
const SUB = id("f");
const WF = "0a".repeat(16);
const WF2 = "0b".repeat(16);
const V1 = "1a".repeat(16);
const V2 = "1b".repeat(16);
const [BEGIN, APPROVAL, APPROVED, REJECTED, END, OLD] = [
  "2a",
  "2b",
  "2c",
  "2d",
  "2e",
  "2f",
].map((p) => p.repeat(16));
const [C0, C1, C2] = ["3a", "3b", "3c"].map((p) => p.repeat(16));

const gz = (value) =>
  gzipSync(Buffer.from(JSON.stringify(value))).toString("base64");

const PILL = "Trigger_Record_Created.current.priority";

const step = (table, row) => ({ table, row });

/** The fixture flow's step rows, per table. */
function steps() {
  const list = [
    step("sys_hub_action_instance_v2", {
      sys_id: "act1",
      flow: FLOW,
      order: "100",
      ui_id: "u1",
      parent_ui_id: "",
      action_type: "at1",
      "action_type.name": "Look Up Record",
      values: JSON.stringify([
        {
          name: "table",
          value: "incident",
          parameter: { label: "Table" },
        },
        {
          name: "conditions",
          value: `priority={{${PILL}}}`,
          displayValue: "Priority is trigger priority",
        },
      ]),
    }),
    // The same ui_id in the v1 table: the _v2 row wins.
    step("sys_hub_action_instance", {
      sys_id: "act1v1",
      flow: FLOW,
      order: "100",
      ui_id: "u1",
      parent_ui_id: "",
      action_type: "at1",
      "action_type.name": "Look Up Record (v1)",
      values: "",
    }),
    step("sys_hub_flow_logic_instance_v2", {
      sys_id: "if1",
      flow: FLOW,
      order: "200",
      ui_id: "u2",
      parent_ui_id: "",
      logic_definition: "ld_if",
      "logic_definition.name": "If",
      values: JSON.stringify({ condition: `{{${PILL}}}=1` }),
    }),
    step("sys_hub_action_instance_v2", {
      sys_id: "act2",
      flow: FLOW,
      order: "100",
      ui_id: "u2a",
      parent_ui_id: "u2",
      action_type: "at2",
      "action_type.name": "Update Record",
      values: gz({
        inputs: [{ name: "state", value: "2", displayValue: "In Progress" }],
      }),
    }),
    step("sys_hub_flow_logic_instance_v2", {
      sys_id: "else1",
      flow: FLOW,
      order: "300",
      ui_id: "u3",
      parent_ui_id: "",
      logic_definition: "ld_else",
      "logic_definition.name": "Else",
      values: "",
    }),
    step("sys_hub_action_instance_v2", {
      sys_id: "act3",
      flow: FLOW,
      order: "100",
      ui_id: "u3a",
      parent_ui_id: "u3",
      action_type: "at3",
      "action_type.name": "Send Email",
      values: "",
    }),
    step("sys_hub_flow_logic_instance_v2", {
      sys_id: "each1",
      flow: FLOW,
      order: "400",
      ui_id: "u4",
      parent_ui_id: "",
      logic_definition: "ld_each",
      "logic_definition.name": "For Each",
      values: "",
    }),
    // A v1 subflow instance inside the forEach.
    step("sys_hub_sub_flow_instance", {
      sys_id: "sub1",
      flow: FLOW,
      order: "100",
      ui_id: "u4a",
      parent_ui_id: "u4",
      subflow: SUB,
      "subflow.name": "Notify Approvers",
      values: "",
    }),
    step("sys_hub_flow_logic_instance_v2", {
      sys_id: "try1",
      flow: FLOW,
      order: "500",
      ui_id: "u5",
      parent_ui_id: "",
      logic_definition: "ld_try",
      "logic_definition.name": "Try",
      values: "",
    }),
    step("sys_hub_action_instance_v2", {
      sys_id: "act4",
      flow: FLOW,
      order: "100",
      ui_id: "u5a",
      parent_ui_id: "u5",
      action_type: "at4",
      "action_type.name": "Create Task",
      values: "",
    }),
    step("sys_hub_flow_logic_instance_v2", {
      sys_id: "catch1",
      flow: FLOW,
      order: "600",
      ui_id: "u6",
      parent_ui_id: "",
      logic_definition: "ld_catch",
      "logic_definition.name": "Catch",
      values: "",
    }),
    step("sys_hub_action_instance_v2", {
      sys_id: "act5",
      flow: FLOW,
      order: "100",
      ui_id: "u6a",
      parent_ui_id: "u6",
      action_type: "at5",
      "action_type.name": "Log",
      comment: "log the failure",
      values: "%%not-a-values-payload%%",
    }),
    // The published snapshot has only the first step.
    step("sys_hub_action_instance_v2", {
      sys_id: "snapact1",
      flow: SNAP,
      order: "100",
      ui_id: "u1",
      parent_ui_id: "",
      action_type: "at1",
      "action_type.name": "Look Up Record",
      values: "",
    }),
  ];
  const out = {};
  for (const { table, row } of list) (out[table] ??= []).push(row);
  return out;
}

/** The fixture instance: table name → rows. */
function fixture() {
  return {
    sys_hub_flow: [
      {
        sys_id: FLOW,
        name: "Incident Triage",
        internal_name: "incident_triage",
        type: "flow",
        active: "true",
        status: "published",
        description: "Routes P1 incidents",
        run_as: "system",
        run_with_roles: ROLE,
        label_cache: JSON.stringify([
          { name: PILL, label: "Trigger > Incident > Priority" },
        ]),
        master_snapshot: SNAP,
        latest_snapshot: SNAP2,
      },
      {
        sys_id: SUB,
        name: "Notify Approvers",
        type: "subflow",
        active: "true",
        status: "draft",
        run_as: "user",
        run_with_roles: "",
        label_cache: "",
        master_snapshot: "",
        latest_snapshot: "",
      },
    ],
    sys_user_role: [{ sys_id: ROLE, name: "itil" }],
    sys_hub_trigger_instance_v2: [
      {
        sys_id: "trg1",
        flow: FLOW,
        trigger_definition: TDEF,
        trigger_type: "record_create",
        table: "incident",
        condition: "priority=1",
        values: "",
      },
    ],
    sys_hub_trigger_definition: [
      { sys_id: TDEF, name: "Created", type: "record_create" },
    ],
    ...steps(),
    sys_hub_flow_input: [
      {
        sys_id: "in1",
        model: FLOW,
        element: "override",
        label: "Override",
        internal_type: "boolean",
        mandatory: "false",
        default_value: "false",
        order: "1",
      },
    ],
    sys_hub_flow_output: [
      {
        sys_id: "out1",
        model: FLOW,
        element: "task",
        label: "Task",
        internal_type: "reference",
        mandatory: "true",
        default_value: "",
        order: "1",
      },
    ],
    sys_hub_flow_variable: [
      {
        sys_id: "var1",
        model: FLOW,
        element: "attempts",
        label: "Attempts",
        internal_type: "integer",
        mandatory: "false",
        default_value: "0",
        order: "1",
      },
    ],
    sys_hub_flow_stage: [
      {
        sys_id: "st1",
        flow: FLOW,
        label: "Triage",
        value: "triage",
        order: "1",
      },
      { sys_id: "st2", flow: FLOW, label: "Done", value: "done", order: "2" },
    ],
    // --- custom action "Create Task" (at4), called from the Try block ---
    sys_hub_action_type_definition: [
      {
        sys_id: "at4",
        name: "Create Task",
        internal_name: "x_acme_create_task",
        category: "Acme",
        access: "public",
        active: "true",
        description: "Creates a follow-up task",
      },
    ],
    sys_hub_action_input: [
      {
        sys_id: "ain1",
        model: "at4",
        name: "short_description",
        label: "Short description",
        internal_type: "string",
        mandatory: "true",
        order: "1",
      },
    ],
    sys_hub_action_output: [
      {
        sys_id: "aout1",
        model: "at4",
        element: "task",
        label: "Task",
        internal_type: "reference",
        mandatory: "false",
        order: "1",
      },
    ],
    // Out of order on purpose: the steps sort by `order`.
    sys_hub_step_instance: [
      {
        sys_id: "stp2",
        action: "at4",
        order: "200",
        label: "Create the task",
        step_type: "stt_create",
        "step_type.name": "Create Record",
        values: JSON.stringify([{ name: "table", value: "task" }]),
      },
      {
        sys_id: "stp1",
        action: "at4",
        order: "100",
        label: "",
        step_type: "stt_script",
        "step_type.name": "Script",
        comment: "build the description",
        values: "",
      },
    ],
    sys_hub_flow_snapshot: [
      { sys_id: SNAP, sys_updated_on: "2026-09-01 10:00:00" },
    ],
    sys_flow_context: [
      {
        sys_id: "ctx1",
        flow: FLOW,
        name: "Incident Triage",
        state: "COMPLETE",
        sys_created_on: "2026-09-20 08:00:00",
        source_table: "incident",
        source_record: "inc1",
      },
      {
        sys_id: "ctx2",
        flow: FLOW,
        name: "Incident Triage",
        state: "ERROR",
        sys_created_on: "2026-09-21 08:00:00",
        source_table: "incident",
        source_record: "inc2",
      },
    ],
    sys_flow_log: [
      {
        sys_id: "log1",
        context: "ctx2",
        level: "error",
        message: "Create Task failed: ACL",
        sys_created_on: "2026-09-21 08:00:01",
      },
      {
        sys_id: "log2",
        context: "ctx2",
        level: "info",
        message: "started",
        sys_created_on: "2026-09-21 08:00:00",
      },
    ],
    // --- legacy workflow ---
    wf_workflow: [
      {
        sys_id: WF,
        name: "Legacy Approval",
        table: "sc_req_item",
        description: "Manager approval",
        active: "true",
      },
      { sys_id: WF2, name: "Old SLA Flow", table: "task_sla", active: "true" },
    ],
    wf_workflow_version: [
      {
        sys_id: V1,
        workflow: WF,
        name: "Legacy Approval v1",
        published: "false",
        sys_updated_on: "2026-01-01 00:00:00",
      },
      {
        sys_id: V2,
        workflow: WF,
        name: "Legacy Approval v2",
        published: "true",
        sys_updated_on: "2026-02-01 00:00:00",
      },
    ],
    wf_activity: [
      ["Begin", BEGIN, "100", "10"],
      ["Approval - User", APPROVAL, "200", "20"],
      ["Set Approved", APPROVED, "300", "30"],
      ["Set Rejected", REJECTED, "300", "40"],
      ["End", END, "400", "50"],
    ]
      .map(([name, sys_id, order, y]) => ({
        sys_id,
        name,
        workflow_version: V2,
        activity_definition: `def_${name.split(" ")[0].toLowerCase()}`,
        "activity_definition.name": name.split(" ")[0],
        order,
        x: "100",
        y,
      }))
      .concat({
        sys_id: OLD,
        name: "Old Begin",
        workflow_version: V1,
        activity_definition: "def_begin",
        order: "100",
        x: "0",
        y: "0",
      }),
    wf_condition: [
      { sys_id: C0, activity: BEGIN, name: "Always", order: "1" },
      { sys_id: C1, activity: APPROVAL, name: "Approved", order: "1" },
      { sys_id: C2, activity: APPROVAL, name: "Rejected", order: "2" },
    ],
    wf_transition: [
      { sys_id: "t1", from: BEGIN, to: APPROVAL, condition: C0 },
      { sys_id: "t2", from: APPROVAL, to: APPROVED, condition: C1 },
      { sys_id: "t3", from: APPROVAL, to: REJECTED, condition: C2 },
      { sys_id: "t4", from: APPROVED, to: END, condition: "" },
      { sys_id: "t5", from: REJECTED, to: END, condition: "" },
      { sys_id: "t6", from: OLD, to: BEGIN, condition: "" },
    ],
    wf_stage: [
      {
        sys_id: "ws1",
        workflow_version: V2,
        name: "Waiting for Approval",
        value: "waiting",
        order: "1",
      },
      {
        sys_id: "ws2",
        workflow_version: V2,
        name: "Fulfilment",
        value: "fulfil",
        order: "2",
      },
    ],
    wf_context: [
      {
        sys_id: "wc1",
        workflow: WF,
        name: "Legacy Approval",
        state: "executing",
        started: "2026-09-20 08:00:00",
        table: "sc_req_item",
        id: "ritm1",
      },
      {
        sys_id: "wc2",
        workflow: WF,
        name: "Legacy Approval",
        state: "finished",
        started: "2026-09-10 08:00:00",
        ended: "2026-09-11 08:00:00",
        table: "sc_req_item",
        id: "ritm0",
      },
    ],
    sc_cat_item: [
      { sys_id: "cat1", name: "New Laptop", workflow: WF },
      { sys_id: "cat2", name: "Old Phone", workflow: WF2 },
      { sys_id: "cat3", name: "Flow-based Item", workflow: "" },
    ],
    contract_sla: [{ sys_id: "sla1", name: "P1 Resolve", workflow: WF }],
    sys_db_object: [{ name: "sys_hub_flow" }, { name: "wf_workflow" }],
  };
}

function matchTerm(row, term) {
  let m;
  if ((m = /^(\w+)IN(.*)$/.exec(term))) {
    return m[2].split(",").includes(String(row[m[1]] ?? ""));
  }
  if ((m = /^(\w+)ISNOTEMPTY$/.exec(term))) return !!row[m[1]];
  if ((m = /^(\w+)ISEMPTY$/.exec(term))) return !row[m[1]];
  if ((m = /^(\w+)=(.*)$/.exec(term))) return String(row[m[1]] ?? "") === m[2];
  throw new Error(`unsupported term ${term}`);
}

/** A tiny encoded-query evaluator: `a^b^ORc^ORDERBYx` (OR binds tighter). */
function matches(row, query) {
  const body = query.split("^ORDERBY")[0];
  if (!body || body.startsWith("ORDERBY")) return true;
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

const spec = ALL_TOOLS.find((s) => s.name === "servicenow_explain_flow");
const explain = (args, extra) => runSpec(spec, args, extra);
const payload = (result) => {
  assert.equal(result.isError, undefined, result.content[0].text);
  return JSON.parse(result.content[0].text);
};

/**
 * Definition tables the shared metadata allow-list does not cover (the _v2
 * Flow Designer tables carry a digit), plus the runtime tables explain_flow
 * reads only when `runs` or `migration` is asked for.
 */
const DEFINITION_EXTRA = /^sys_hub_[a-z0-9_]+$/;
const RUNTIME = new Set(["sys_flow_context", "sys_flow_log", "wf_context"]);

/** withMetadataFetch, plus the tables above; runtime ones only on opt-in. */
async function run(args, mock = instance(), extra) {
  const optIn = (args.runs ?? 0) > 0 || args.migration === true;
  return withFetch(
    (url, ...rest) => {
      const table = /\/api\/now\/table\/([^/?]+)/.exec(url)?.[1] ?? "";
      if (RUNTIME.has(table)) {
        assert.ok(optIn, `runtime table read without opt-in: ${table}`);
      } else if (!DEFINITION_EXTRA.test(table)) {
        assertMetadataUrl(url);
      }
      return mock.handler(url, ...rest);
    },
    () => explain(args, extra),
  );
}

const flat = (list) => list.flatMap((s) => [s, ...flat(s.children)]);

test("explain_flow lives in the flows package, read-only", () => {
  assert.ok(spec, "tool registered");
  assert.equal(spec.package, "flows");
  assert.equal(spec.annotations.readOnlyHint, true);
  assert.ok(spec.description.length <= 250);
  const flows = PACKAGES.find((p) => p.name === "flows");
  assert.ok(flows.tools.some((t) => t.name === "servicenow_explain_flow"));
});

test("the fixture flow renders its trigger and nested step tree", async () => {
  const res = payload(await run({ sys_id: FLOW }));
  assert.equal(res.kind, "flow");
  assert.equal(res.verified, false);
  assert.equal(res.name, "Incident Triage");
  assert.equal(res.flow.run_as, "system");
  assert.deepEqual(res.flow.run_with_roles, [{ sys_id: ROLE, name: "itil" }]);
  assert.equal(res.trigger.definition.name, "Created");
  assert.equal(res.trigger.table, "incident");
  assert.equal(res.trigger.condition, "priority=1");
  assert.equal(res.trigger.source, "sys_hub_trigger_instance_v2");
  assert.deepEqual(
    res.steps.map((s) => [s.number, s.kind, s.name]),
    [
      ["1", "action", "Look Up Record"],
      ["2", "logic", "If"],
      ["3", "logic", "Else"],
      ["4", "logic", "For Each"],
      ["5", "logic", "Try"],
      ["6", "logic", "Catch"],
    ],
  );
  assert.deepEqual(
    flat(res.steps)
      .filter((s) => s.number.includes("."))
      .map((s) => [s.number, s.kind, s.name]),
    [
      ["2.1", "action", "Update Record"],
      ["3.1", "action", "Send Email"],
      ["4.1", "subflow", "Notify Approvers"],
      ["5.1", "action", "Create Task"],
      ["6.1", "action", "Log"],
    ],
  );
  const sub = flat(res.steps).find((s) => s.kind === "subflow");
  assert.equal(sub.source, "sys_hub_sub_flow_instance");
  assert.deepEqual(sub.ref, { sys_id: SUB, name: "Notify Approvers" });
  assert.deepEqual(res.counts, {
    steps: 11,
    actions: 5,
    logic: 5,
    subflows: 1,
    inputs: 1,
    outputs: 1,
    variables: 1,
    stages: 2,
    activities: 0,
    transitions: 0,
    runs: 0,
    callees: 6,
  });
  assert.ok(
    res.caveats.some((c) =>
      /action steps were found in both sys_hub_action_instance_v2 and sys_hub_action_instance/.test(
        c,
      ),
    ),
  );
  assert.deepEqual(
    res.inputs.map((v) => [v.element, v.type, v.mandatory]),
    [["override", "boolean", false]],
  );
  assert.equal(res.outputs[0].mandatory, true);
  assert.equal(res.variables[0].default, "0");
  assert.deepEqual(
    res.stages.map((s) => s.label),
    ["Triage", "Done"],
  );
  assert.equal(res.runs, undefined);
});

test("step values decode from JSON and base64 + gzip with labelled pills", async () => {
  const res = payload(await run({ sys_id: FLOW }));
  const all = flat(res.steps);
  const lookUp = all.find((s) => s.sys_id === "act1");
  assert.equal(lookUp.values.format, "json");
  assert.deepEqual(lookUp.values.inputs[0], {
    name: "table",
    label: "Table",
    value: "incident",
  });
  assert.deepEqual(lookUp.values.inputs[1].pills, [
    { pill: PILL, label: "Trigger > Incident > Priority" },
  ]);
  assert.equal(
    lookUp.values.inputs[1].displayValue,
    "Priority is trigger priority",
  );
  const update = all.find((s) => s.sys_id === "act2");
  assert.equal(update.values.format, "base64-gzip-json");
  assert.deepEqual(update.values.inputs, [
    { name: "state", value: "2", displayValue: "In Progress" },
  ]);
  const cond = all.find((s) => s.sys_id === "if1");
  assert.deepEqual(cond.values.value, { condition: `{{${PILL}}}=1` });
  assert.equal(cond.values.pills[0].label, "Trigger > Incident > Priority");
  const log = all.find((s) => s.sys_id === "act5");
  assert.equal(log.values.decoded, false);
  assert.equal(log.values.format, "unknown");
  assert.equal(log.values.raw, "%%not-a-values-payload%%");
  assert.match(log.values.reason, /24 bytes returned raw/);
  assert.equal(log.comment, "log the failure");
  const email = all.find((s) => s.sys_id === "act3");
  assert.equal(email.values, undefined);
});

test("draft vs published compares the snapshot's steps", async () => {
  const res = payload(await run({ sys_id: FLOW }));
  assert.deepEqual(res.published, {
    status: "published",
    master_snapshot: SNAP,
    latest_snapshot: SNAP2,
    snapshotUpdated: "2026-09-01 10:00:00",
    publishedSteps: 1,
    draftDiffers: true,
    basis: "steps",
  });
  // Same steps under the snapshot: the draft matches.
  const tables = fixture();
  const same = steps();
  for (const [table, rows] of Object.entries(same)) {
    tables[table] = [
      ...rows.filter((r) => r.flow === FLOW),
      ...rows.filter((r) => r.flow === FLOW).map((r) => ({ ...r, flow: SNAP })),
    ];
  }
  const matching = payload(await run({ sys_id: FLOW }, instance(tables)));
  assert.equal(matching.published.draftDiffers, false);
  // No snapshot rows: fall back to the snapshot pointers.
  const bare = fixture();
  bare.sys_hub_action_instance_v2 = bare.sys_hub_action_instance_v2.filter(
    (r) => r.flow !== SNAP,
  );
  const pointers = payload(await run({ sys_id: FLOW }, instance(bare)));
  assert.equal(pointers.published.basis, "snapshot-pointers");
  assert.equal(pointers.published.draftDiffers, true);
  assert.ok(
    pointers.caveats.some((c) => /No step rows were found under/.test(c)),
  );
});

test("a never-published subflow says so", async () => {
  const res = payload(await run({ sys_id: SUB, kind: "subflow" }));
  assert.equal(res.kind, "subflow");
  assert.equal(res.published.basis, "never-published");
  assert.equal(res.published.draftDiffers, undefined);
  assert.equal(res.trigger, null);
  assert.deepEqual(res.steps, []);
  assert.deepEqual(res.flow.run_with_roles, []);
  assert.ok(res.caveats.some((c) => /never been published/.test(c)));
  // A kind mismatch is a caveat, not a failure.
  const mismatch = payload(await run({ sys_id: SUB }));
  assert.ok(mismatch.caveats.some((c) => /is a subflow, not a flow/.test(c)));
});

test("opt-in runs carry the error log rows", async () => {
  const res = payload(await run({ sys_id: FLOW, runs: 5 }));
  assert.equal(res.counts.runs, 2);
  const failed = res.runs.find((r) => r.sys_id === "ctx2");
  assert.equal(failed.state, "ERROR");
  assert.equal(failed.record, "inc2");
  assert.deepEqual(
    failed.errors.map((e) => e.message),
    ["Create Task failed: ACL"],
  );
  assert.deepEqual(res.runs.find((r) => r.sys_id === "ctx1").errors, []);
  assert.ok(res.caveats.some((c) => /sys_flow_log level values/.test(c)));
});

test("orphans, cycles and deep nesting are bounded with caveats", async () => {
  const tables = fixture();
  tables.sys_hub_action_instance_v2.push(
    {
      sys_id: "orph",
      flow: FLOW,
      order: "900",
      ui_id: "uo",
      parent_ui_id: "ghost",
      action_type: "at9",
      "action_type.name": "Orphan",
    },
    {
      sys_id: "cy1",
      flow: FLOW,
      order: "1",
      ui_id: "cy1",
      parent_ui_id: "cy2",
      action_type: "at9",
    },
    {
      sys_id: "cy2",
      flow: FLOW,
      order: "2",
      ui_id: "cy2",
      parent_ui_id: "cy1",
      action_type: "at9",
    },
  );
  const deep = TREE_DEPTH_MAX + 2;
  for (let i = 0; i < deep; i++) {
    tables.sys_hub_action_instance_v2.push({
      sys_id: `d${i}`,
      flow: FLOW,
      order: "1",
      ui_id: `d${i}`,
      parent_ui_id: i ? `d${i - 1}` : "",
      action_type: "at9",
    });
  }
  const res = payload(await run({ sys_id: FLOW }, instance(tables)));
  const top = res.steps.map((s) => s.sys_id);
  assert.ok(top.includes("orph"));
  assert.ok(top.includes("cy1") && top.includes("cy2"));
  assert.ok(res.caveats.some((c) => /parent_ui_id that was not read/.test(c)));
  assert.ok(res.caveats.some((c) => /form a parent_ui_id cycle/.test(c)));
  assert.ok(
    res.caveats.some((c) =>
      new RegExp(`deeper than ${TREE_DEPTH_MAX} levels`).test(c),
    ),
  );
  const cut = flat(res.steps).find((s) => s.childrenOmitted);
  assert.equal(cut.number.split(".").length, TREE_DEPTH_MAX);
  // Unnamed steps fall back to their reference.
  assert.equal(res.steps.find((s) => s.sys_id === "cy1").name, "at9");
});

test("decodeValues and pillLabels never throw and bound their output", () => {
  assert.equal(decodeValues("", new Map()), undefined);
  const big = "x".repeat(RAW_PREVIEW + 10);
  const raw = decodeValues(big, new Map());
  assert.equal(raw.raw.length, RAW_PREVIEW);
  assert.equal(raw.rawTruncated, true);
  const many = Array.from({ length: 60 }, (_, i) => ({ name: `n${i}` }));
  const cut = decodeValues(JSON.stringify(many), new Map());
  assert.equal(cut.inputs.length, 50);
  assert.equal(cut.inputsOmitted, 10);
  assert.equal(decodeValues("null", new Map()).value, undefined);
  assert.deepEqual(
    [...pillLabels(JSON.stringify({ a: "A", b: { label: "B" }, c: 3 }))],
    [
      ["a", "A"],
      ["b", "B"],
    ],
  );
  assert.equal(pillLabels("not json").size, 0);
  assert.equal(pillLabels("").size, 0);
  assert.equal(pillLabels('[1, null, {"name": 1}]').size, 0);
});

test("the flow Mermaid tree matches its golden", async () => {
  const res = payload(await run({ sys_id: FLOW, format: "mermaid" }));
  lintMermaid(res.mermaid);
  assert.equal(res.mermaidTruncated, undefined);
  assert.equal(res.verified, false);
  assert.equal(res.kind, "flow");
  const file = path.join(FIXTURES, "flow.mmd");
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, `${res.mermaid}\n`);
  } else {
    assert.equal(`${res.mermaid}\n`, readFileSync(file, "utf8"));
  }
});

test("the workflow graph, stages and runtime are read from the published version", async () => {
  const res = payload(await run({ sys_id: WF, kind: "workflow", runs: 5 }));
  assert.equal(res.kind, "workflow");
  assert.equal(res.workflow.table, "sc_req_item");
  assert.deepEqual(res.version, {
    sys_id: V2,
    name: "Legacy Approval v2",
    published: true,
    updated: "2026-02-01 00:00:00",
  });
  assert.deepEqual(
    res.activities.map((a) => a.name),
    ["Begin", "Approval - User", "Set Approved", "Set Rejected", "End"],
  );
  assert.deepEqual(
    res.activities[1].conditions.map((c) => c.name),
    ["Approved", "Rejected"],
  );
  assert.equal(res.activities[0].definition.name, "Begin");
  assert.equal(res.transitions.length, 5);
  assert.deepEqual(
    res.stages.map((s) => s.label),
    ["Waiting for Approval", "Fulfilment"],
  );
  assert.deepEqual(
    res.runs.map((r) => [r.sys_id, r.state, r.record]),
    [
      ["wc1", "executing", "ritm1"],
      ["wc2", "finished", "ritm0"],
    ],
  );
  assert.equal(res.migration, undefined);
  assert.equal(res.counts.activities, 5);
  assert.equal(res.counts.transitions, 5);
});

test("the workflow Mermaid edges match the transition rows one-to-one", async () => {
  const res = payload(
    await run({ sys_id: WF, kind: "workflow", format: "mermaid" }),
  );
  lintMermaid(res.mermaid);
  const edges = res.mermaid
    .split("\n")
    .map((l) => /^\s*a_(\w+) -->(?:\|"([^"]*)"\|)? a_(\w+)$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[3], m[2] ?? ""]);
  const rows = fixture()
    .wf_transition.filter((t) => t.from !== OLD)
    .map((t) => [
      t.from,
      t.to,
      fixture().wf_condition.find((c) => c.sys_id === t.condition)?.name ?? "",
    ]);
  assert.deepEqual(edges, rows);
  // Every edge end is a declared activity node.
  for (const [from, to] of edges) {
    assert.match(res.mermaid, new RegExp(`a_${from}\\["`));
    assert.match(res.mermaid, new RegExp(`a_${to}\\["`));
  }
  const file = path.join(FIXTURES, "workflow.mmd");
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, `${res.mermaid}\n`);
  } else {
    assert.equal(`${res.mermaid}\n`, readFileSync(file, "utf8"));
  }
});

test("a workflow without a published version or version-keyed activities degrades gracefully", async () => {
  const tables = fixture();
  tables.wf_workflow_version = tables.wf_workflow_version.map((v) => ({
    ...v,
    published: "false",
  }));
  tables.wf_activity = tables.wf_activity.map((a) => {
    const rest = { ...a };
    delete rest.workflow_version;
    return { ...rest, workflow: WF };
  });
  tables.wf_transition.push({
    sys_id: "t7",
    from: END,
    to: "zz",
    condition: "",
  });
  const res = payload(
    await run({ sys_id: WF, kind: "workflow" }, instance(tables)),
  );
  assert.equal(res.version.published, false);
  assert.ok(
    res.caveats.some((c) => /no published wf_workflow_version/.test(c)),
  );
  assert.ok(
    res.caveats.some((c) => /activities were read by workflow/.test(c)),
  );
  assert.equal(res.activities.length, 6);
  assert.ok(
    res.caveats.some((c) => /1 transition\(s\) lead to an activity/.test(c)),
  );
  const md = payload(
    await run(
      { sys_id: WF, kind: "workflow", format: "mermaid" },
      instance(tables),
    ),
  );
  lintMermaid(md.mermaid);
  assert.match(md.mermaid, /a_zz\["Activity zz"\]/);
});

test("the migration report covers one workflow or the whole instance", async () => {
  const one = payload(
    await run({ sys_id: WF, kind: "workflow", migration: true }),
  );
  assert.equal(one.migration.scope, "workflow");
  assert.deepEqual(one.migration.workflows, [
    {
      sys_id: WF,
      name: "Legacy Approval",
      catalogItems: [{ sys_id: "cat1", name: "New Laptop" }],
      slaDefinitions: [{ sys_id: "sla1", name: "P1 Resolve" }],
      runningContexts: 1,
      inUse: true,
    },
  ]);
  const all = payload(await run({ kind: "workflow", migration: true }));
  assert.equal(all.sys_id, undefined);
  assert.equal(all.migration.scope, "instance");
  assert.deepEqual(
    all.migration.workflows.map((w) => [
      w.name,
      w.catalogItems.length,
      w.slaDefinitions.length,
      w.runningContexts,
    ]),
    [
      ["Legacy Approval", 1, 1, 1],
      ["Old SLA Flow", 1, 0, 0],
    ],
  );
  const md = payload(
    await run({ kind: "workflow", migration: true, format: "markdown" }),
  );
  assert.match(md.markdown, /## Migration report \(instance\)/);
  assert.match(md.markdown, /\*\*Old SLA Flow\*\*: in use/);
  assert.doesNotMatch(md.markdown, /```mermaid/);
  // migration on a flow is ignored with a caveat.
  const flow = payload(await run({ sys_id: FLOW, migration: true }));
  assert.equal(flow.migration, undefined);
  assert.ok(
    flow.caveats.some((c) => /migration applies to kind:'workflow'/.test(c)),
  );
});

test("an unreadable table becomes a caveat, never a failure", async () => {
  const mock = instance(fixture(), {
    sys_hub_flow_logic_instance_v2: 403,
    sys_hub_trigger_definition: 404,
  });
  const res = payload(await run({ sys_id: FLOW }, mock));
  assert.deepEqual(
    res.unreadable.map((u) => [u.table, u.status]),
    [
      ["sys_hub_trigger_definition", 404],
      ["sys_hub_flow_logic_instance_v2", 403],
    ],
  );
  assert.deepEqual(res.trigger.definition, { sys_id: TDEF });
  assert.ok(
    res.caveats.some((c) =>
      /^sys_hub_flow_logic_instance_v2 could not be read \(403\)/.test(c),
    ),
  );
  // Children of the unread logic blocks surface at the top level.
  assert.equal(res.counts.logic, 0);
  assert.ok(res.caveats.some((c) => /parent_ui_id that was not read/.test(c)));
});

test("a policy-denied table is a caveat and is never requested", async () => {
  const mock = instance();
  const res = await withEnv(
    { SN_TABLES_DENY: "sys_flow_log,wf_condition" },
    async () => [
      payload(await run({ sys_id: FLOW, runs: 2 }, mock)),
      payload(await run({ sys_id: WF, kind: "workflow" }, mock)),
    ],
  );
  assert.equal(res[0].unreadable[0].table, "sys_flow_log");
  assert.match(res[0].unreadable[0].reason, /SN_TABLES_DENY/);
  assert.equal(res[1].unreadable[0].table, "wf_condition");
  assert.equal(res[1].transitions[0].condition.sys_id, C0);
  assert.equal(res[1].transitions[0].condition.name, undefined);
  assert.equal(mock.reads.includes("sys_flow_log"), false);
  assert.equal(mock.reads.includes("wf_condition"), false);
});

test("markdown renders the tree, values, variables, runs and caveats", async () => {
  const res = payload(await run({ sys_id: FLOW, runs: 2, format: "markdown" }));
  const md = res.markdown;
  assert.match(md, /^# Flow Incident Triage/);
  assert.match(
    md,
    /11 step\(s\): 5 action\(s\), 5 logic, 1 subflow call\(s\); 6 callee\(s\) expanded\. verified:false\./,
  );
  assert.match(md, /- Run with roles: itil/);
  assert.match(md, /- Published: yes — the draft differs/);
  assert.match(
    md,
    /## Trigger\n\n- Trigger: Created · incident\n- Condition: priority=1/,
  );
  assert.match(
    md,
    / {2}- \*\*2\.1 Update Record\*\* _\(action\)_\n {4}- state = In Progress/,
  );
  assert.match(
    md,
    /pills: Trigger_Record_Created\.current\.priority = Trigger > Incident > Priority/,
  );
  assert.match(md, /_values not decoded \(24 bytes\)/);
  assert.match(md, /## Inputs\n\n\| Name \| Label \| Type \| Mandatory \|/);
  assert.match(md, /## Latest runs/);
  assert.match(md, / {2}- error: Create Task failed: ACL/);
  assert.match(md, /```mermaid\nflowchart TD/);
  assert.match(md, /## Caveats\n\n- Flow Designer tables are verified:false/);
  const wf = payload(
    await run({
      sys_id: WF,
      kind: "workflow",
      runs: 1,
      migration: true,
      format: "markdown",
    }),
  );
  assert.match(wf.markdown, /^# Workflow Legacy Approval/);
  assert.match(
    wf.markdown,
    /5 activity\(ies\), 5 transition\(s\), 2 stage\(s\)/,
  );
  assert.match(
    wf.markdown,
    /- \*\*Approval - User\*\* \(Approval\)\n {2}- Approved → Set Approved\n {2}- Rejected → Set Rejected/,
  );
  assert.match(wf.markdown, /- Version: Legacy Approval v2 \(published\)/);
  assert.match(wf.markdown, /## Stages\n\n- Waiting for Approval \(waiting\)/);
  assert.match(
    wf.markdown,
    / {2}- catalog item New Laptop\n {2}- SLA P1 Resolve/,
  );
  const sub = payload(
    await run({ sys_id: SUB, kind: "subflow", format: "markdown" }),
  );
  assert.match(sub.markdown, /^# Subflow Notify Approvers/);
  assert.match(sub.markdown, /_No steps found\._/);
  assert.match(sub.markdown, /- Published: never/);
});

test("format:file writes the full JSON with the diagram", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sn-p10-"));
  try {
    const res = await withEnv({ SN_DOCS_DIR: dir }, () =>
      run({ sys_id: FLOW, format: "file" }),
    );
    const out = payload(res);
    assert.equal(out.format, "file");
    assert.equal(out.kind, "flow");
    assert.equal(out.steps_count, 6);
    const written = JSON.parse(readFileSync(out.file, "utf8"));
    assert.equal(written.flow.name, "Incident Triage");
    assert.match(written.mermaid, /^flowchart TD/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a capped diagram carries the mermaidTruncated signal", async () => {
  for (const args of [
    { sys_id: FLOW, format: "mermaid" },
    { sys_id: WF, kind: "workflow", format: "mermaid" },
  ]) {
    const out = payload(
      await withEnv({ SN_DIAGRAM_MAX_NODES: "3" }, () => run(args)),
    );
    assert.ok(out.mermaidTruncated > 0);
    lintMermaid(out.mermaid);
  }
});

test("invalid arguments and a missing record fail cleanly", async () => {
  const none = await run({});
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /Pass 'sys_id'/);
  const noMigration = await run({ kind: "workflow" });
  assert.equal(noMigration.isError, true);
  const missing = await run({ sys_id: id("9") });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /No sys_hub_flow record matches/);
  const missingWf = await run({ sys_id: id("9"), kind: "workflow" });
  assert.match(missingWf.content[0].text, /No wf_workflow record matches/);
  // The registered schema rejects out-of-range runs; the API clamps anyway.
  assert.equal(spec.input.runs.safeParse(99).success, false);
  assert.equal(spec.input.runs.safeParse(EXPLAIN_FLOW_RUNS.max).success, true);
  const clamped = payload(await run({ sys_id: FLOW, runs: 99 }));
  assert.ok(clamped.runs.length <= EXPLAIN_FLOW_RUNS.max);
});

test("an unreadable root table degrades with availability", async () => {
  const res = payload(
    await run({ sys_id: FLOW }, instance(fixture(), { sys_hub_flow: 403 })),
  );
  assert.equal(res.degraded.table, "sys_hub_flow");
  assert.equal(res.degraded.status, 403);
  assert.equal(res.available, true);
  assert.equal(res.steps, undefined);
  const wf = payload(
    await run(
      { sys_id: WF, kind: "workflow" },
      instance(fixture(), { wf_workflow: 404, sys_db_object: 403 }),
    ),
  );
  assert.equal(wf.degraded.table, "wf_workflow");
  assert.equal(wf.available, undefined);
  const boom = await run(
    { sys_id: FLOW },
    instance(fixture(), { sys_hub_flow_input: 500 }),
  );
  assert.equal(boom.isError, true);
});

test("progress is reported per read and a cancelled call stops", async () => {
  const sent = [];
  const extra = {
    requestId: 1,
    _meta: { progressToken: "p10" },
    sendNotification: async (n) => {
      sent.push(n);
    },
  };
  payload(await run({ sys_id: FLOW }, instance(), extra));
  assert.ok(sent.length > 0);
  assert.equal(sent[0].params.progressToken, "p10");
  const controller = new AbortController();
  controller.abort();
  const mock = instance();
  const res = await run({ sys_id: FLOW }, mock, { signal: controller.signal });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /cancel/i);
  assert.deepEqual(mock.reads, []);
});

// --- P-11: custom actions and call expansion -----------------------------------

test("P-11 acceptance: a flow calling a custom action shows its steps one level down", async () => {
  const mock = instance();
  const res = payload(await run({ sys_id: FLOW }, mock));
  const call = flat(res.steps).find((s) => s.sys_id === "act4");
  assert.equal(call.number, "5.1");
  assert.equal(call.callee.kind, "action");
  assert.equal(call.callee.sys_id, "at4");
  assert.equal(call.callee.name, "Create Task");
  assert.deepEqual(
    call.callee.steps.map((s) => [s.number, s.kind, s.name, s.ref?.name]),
    [
      ["1", "step", "Script", "Script"],
      ["2", "step", "Create the task", "Create Record"],
    ],
  );
  assert.equal(call.callee.steps[0].source, "sys_hub_step_instance");
  assert.equal(call.callee.steps[0].comment, "build the description");
  assert.deepEqual(call.callee.steps[1].values.inputs, [
    { name: "table", value: "task" },
  ]);
  // Actions without step rows resolve to an empty callee; the subflow too.
  const email = flat(res.steps).find((s) => s.sys_id === "act3");
  assert.deepEqual(email.callee.steps, []);
  const sub = flat(res.steps).find((s) => s.sys_id === "sub1");
  assert.deepEqual(
    [sub.callee.kind, sub.callee.name, sub.callee.steps],
    ["subflow", "Notify Approvers", []],
  );
  // Callee steps do not count as the flow's own steps.
  assert.equal(res.counts.steps, 11);
  // Every action is read in one IN query.
  assert.equal(
    mock.reads.filter((t) => t === "sys_hub_step_instance").length,
    1,
  );
  assert.ok(
    res.caveats.some((c) => /Action tables are verified:false/.test(c)),
  );
  // depth:0 expands nothing and reads no action table.
  const none = instance();
  const flatRes = payload(await run({ sys_id: FLOW, depth: 0 }, none));
  assert.equal(flatRes.counts.callees, 0);
  assert.ok(flat(flatRes.steps).every((s) => s.callee === undefined));
  assert.ok(!none.reads.includes("sys_hub_step_instance"));
});

/** A subflow SUB whose own steps call the action at4 and SUB itself. */
function recursive() {
  const tables = fixture();
  tables.sys_hub_action_instance_v2.push({
    sys_id: "subact",
    flow: SUB,
    order: "100",
    ui_id: "v1",
    parent_ui_id: "",
    action_type: "at4",
    "action_type.name": "Create Task",
    values: "",
  });
  tables.sys_hub_sub_flow_instance.push({
    sys_id: "self",
    flow: SUB,
    order: "200",
    ui_id: "v2",
    parent_ui_id: "",
    subflow: SUB,
    "subflow.name": "Notify Approvers",
    values: "",
  });
  return tables;
}

test("P-11: subflow calls resolve recursively with a depth cap and a cycle guard", async () => {
  // depth 1: the subflow's own calls are not expanded.
  const one = payload(await run({ sys_id: FLOW }, instance(recursive())));
  const sub = flat(one.steps).find((s) => s.sys_id === "sub1");
  assert.deepEqual(
    sub.callee.steps.map((s) => [s.number, s.kind, s.name]),
    [
      ["1", "action", "Create Task"],
      ["2", "subflow", "Notify Approvers"],
    ],
  );
  assert.equal(sub.callee.steps[1].callee, undefined);
  assert.ok(
    one.caveats.some((c) =>
      /2 call\(s\) nested deeper than depth 1 are not expanded \(max 3\)/.test(
        c,
      ),
    ),
  );
  // depth 2: the action inside the subflow expands; SUB calling itself is a
  // cycle, marked and not expanded.
  const two = payload(
    await run({ sys_id: FLOW, depth: 2 }, instance(recursive())),
  );
  const [inner, self] = flat(two.steps).find((s) => s.sys_id === "sub1").callee
    .steps;
  assert.deepEqual(
    inner.callee.steps.map((s) => s.name),
    ["Script", "Create the task"],
  );
  assert.equal(self.callee.cycle, true);
  assert.deepEqual(self.callee.steps, []);
  assert.ok(
    two.caveats.some((c) => /1 call\(s\) reach .* \(a cycle\)/.test(c)),
  );
  assert.ok(!two.caveats.some((c) => /nested deeper/.test(c)));
  // A subflow explained on its own: calling itself is a cycle at level 1.
  const alone = payload(
    await run({ sys_id: SUB, kind: "subflow" }, instance(recursive())),
  );
  assert.equal(alone.steps[1].callee.cycle, true);
  assert.equal(alone.counts.callees, 1);
  // Mermaid and markdown show the callees and the cycle.
  const mmd = payload(
    await run(
      { sys_id: FLOW, depth: 2, format: "mermaid" },
      instance(recursive()),
    ),
  ).mermaid;
  lintMermaid(mmd);
  assert.match(mmd, /s_sub1 -\.-> c\d+_subact\["1 Create Task"\]/);
  assert.match(mmd, /-\.-> c\d+\[\/"Subflow: Notify Approvers \(cycle\)"\/\]/);
  const md = payload(
    await run(
      { sys_id: FLOW, depth: 2, format: "markdown" },
      instance(recursive()),
    ),
  ).markdown;
  assert.match(md, /callee\(s\) expanded\. verified:false\./);
  assert.match(
    md,
    / {6}- ↳ calls Subflow: Notify Approvers _\(cycle — not expanded\)_/,
  );
  assert.match(md, / {2}- ↳ calls Action: Send Email _\(no steps found\)_/);
  // The schema bounds depth; the API clamps anyway.
  assert.equal(spec.input.depth.safeParse(4).success, false);
  const clamped = payload(
    await run({ sys_id: FLOW, depth: 99 }, instance(recursive())),
  );
  assert.equal(clamped.counts.callees, 6);
});

test("P-11: distinct callees are capped and an unreadable action table degrades", async () => {
  const tables = fixture();
  for (let i = 0; i < 25; i++) {
    tables.sys_hub_action_instance_v2.push({
      sys_id: `many${i}`,
      flow: FLOW,
      order: String(1000 + i),
      ui_id: `m${i}`,
      parent_ui_id: "",
      action_type: `atx${i}`,
      "action_type.name": `Action ${i}`,
      values: "",
    });
  }
  const res = payload(await run({ sys_id: FLOW }, instance(tables)));
  assert.equal(res.counts.callees, 20);
  assert.ok(
    res.caveats.some((c) =>
      /Only 20 distinct callees are expanded; 11 further call\(s\) are not/.test(
        c,
      ),
    ),
  );
  const denied = payload(
    await run(
      { sys_id: FLOW },
      instance(fixture(), { sys_hub_step_instance: 403 }),
    ),
  );
  assert.deepEqual(
    flat(denied.steps).find((s) => s.sys_id === "act4").callee.steps,
    [],
  );
  assert.ok(denied.unreadable.some((u) => u.table === "sys_hub_step_instance"));
});

test("P-11: kind:'action' explains a custom action definition", async () => {
  const res = payload(await run({ sys_id: "at4", kind: "action", runs: 2 }));
  assert.equal(res.kind, "action");
  assert.equal(res.verified, false);
  assert.equal(res.name, "Create Task");
  assert.deepEqual(res.action, {
    sys_id: "at4",
    name: "Create Task",
    internal_name: "x_acme_create_task",
    category: "Acme",
    access: "public",
    active: true,
    description: "Creates a follow-up task",
  });
  // An input without an element falls back to its name.
  assert.deepEqual(
    res.inputs.map((v) => [v.element, v.type, v.mandatory]),
    [["short_description", "string", true]],
  );
  assert.equal(res.outputs[0].element, "task");
  assert.deepEqual(
    res.steps.map((s) => [s.number, s.name]),
    [
      ["1", "Script"],
      ["2", "Create the task"],
    ],
  );
  assert.equal(res.counts.steps, 2);
  assert.equal(res.counts.inputs, 1);
  assert.equal(res.runs, undefined);
  assert.ok(res.caveats.some((c) => /runs applies to flows/.test(c)));
  assert.equal(
    res.caveats.filter((c) => /Action tables are verified:false/.test(c))
      .length,
    1,
  );
  const md = payload(
    await run({ sys_id: "at4", kind: "action", format: "markdown" }),
  ).markdown;
  assert.match(md, /^# Action Create Task/);
  assert.match(
    md,
    /2 step\(s\), 1 input\(s\), 1 output\(s\)\. verified:false\./,
  );
  assert.match(md, /- Internal name: x_acme_create_task\n- Category: Acme/);
  assert.match(
    md,
    /- \*\*2 Create the task\*\* _\(step\)_\n {2}- table = task/,
  );
  assert.match(md, /## Outputs/);
  // A missing action has its own hint; an unreadable table degrades.
  const missing = await run({ sys_id: "nope", kind: "action" });
  assert.equal(missing.isError, true);
  assert.match(
    missing.content[0].text,
    /No sys_hub_action_type_definition record matches/,
  );
  const degraded = payload(
    await run(
      { sys_id: "at4", kind: "action" },
      instance(fixture(), { sys_hub_action_type_definition: 403 }),
    ),
  );
  assert.equal(degraded.degraded.table, "sys_hub_action_type_definition");
  assert.equal(degraded.steps, undefined);
});

test("the action Mermaid tree matches its golden", async () => {
  const res = payload(
    await run({ sys_id: "at4", kind: "action", format: "mermaid" }),
  );
  lintMermaid(res.mermaid);
  const file = path.join(FIXTURES, "action.mmd");
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, `${res.mermaid}\n`);
  } else {
    assert.equal(`${res.mermaid}\n`, readFileSync(file, "utf8"));
  }
});

// --- flow-values decoder: property tests ---------------------------------------

test("property: detectFlowValues never throws and always counts bytes", () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.string(), fc.base64String(), fc.string({ unit: "grapheme" })),
      (raw) => {
        const res = detectFlowValues(raw);
        assert.equal(res.bytes, Buffer.byteLength(raw, "utf8"));
        assert.equal(typeof res.decoded, "boolean");
        if (!res.decoded) {
          assert.equal(res.format, "unknown");
          assert.match(res.reason, new RegExp(`${res.bytes} bytes`));
        }
      },
    ),
    { numRuns: 1000 },
  );
});

test("property: JSON and base64 + gzip JSON values round-trip", () => {
  // A string holding an object/array is unwrapped as double-encoded JSON by
  // design (jsonDecoder), so it does not round-trip; it is excluded here.
  const value = fc
    .jsonValue()
    .filter((v) => !(typeof v === "string" && /^\s*[[{]/.test(v)));
  fc.assert(
    fc.property(value, fc.boolean(), (value, compressed) => {
      const json = JSON.stringify(value);
      const raw = compressed
        ? gzipSync(Buffer.from(json, "utf8")).toString("base64")
        : json;
      const res = detectFlowValues(raw);
      assert.equal(res.decoded, true);
      assert.equal(res.format, compressed ? "base64-gzip-json" : "json");
      assert.deepEqual(res.value, JSON.parse(json));
      assert.equal(res.bytes, Buffer.byteLength(raw, "utf8"));
    }),
    { numRuns: 500 },
  );
});

test("property: corrupt gzip and gzip of non-JSON stay decoded:false", () => {
  fc.assert(
    fc.property(fc.uint8Array({ minLength: 0, maxLength: 64 }), (tail) => {
      const header = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);
      const raw = Buffer.concat([header, Buffer.from(tail)]).toString("base64");
      const res = detectFlowValues(raw);
      assert.equal(res.decoded, false);
    }),
    { numRuns: 300 },
  );
  const notJson = gzipSync(Buffer.from("<xml/>")).toString("base64");
  const res = detectFlowValues(notJson);
  assert.equal(res.decoded, false);
  assert.match(res.reason, /not JSON/);
  assert.equal(detectFlowValues("").format, "empty");
});
