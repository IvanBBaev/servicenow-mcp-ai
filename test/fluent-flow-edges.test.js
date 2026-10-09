// P-27 flow emitter edge cases: typed core-action inputs (Boolean, Integer,
// TemplateValue, non-string values), Record() fallbacks for unresolved or
// undecodable steps, subflow calls, orphan logic blocks, Do-until, leaf
// limits, unmapped / undecodable triggers, reference columns without a table
// and non-explicit stage durations. Small hand-built explain_flow trees.
import test from "node:test";
import assert from "node:assert/strict";

import { emitFluent } from "../build/api/fluent.js";
import { getArtifactType } from "../build/core/artifacts/registry.js";
import { baselineEnv } from "./helpers.js";

baselineEnv();

const id = (c) => c.repeat(32);
const SCOPE = { sys_id: id("5"), scope: "x_acme_app" };
const FLOW = id("a");
const PILL = "Trigger_Record_Created.current.priority";
const EMPTY = { format: "empty", decoded: true, bytes: 0 };
const json = (value) => ({ format: "json", decoded: true, bytes: 10, value });
const inputs = (list) => ({
  format: "json",
  decoded: true,
  bytes: 10,
  inputs: list.map(([name, value]) => ({ name, value })),
});

let seq = 0;
function step(kind, name, extra = {}, children = []) {
  seq++;
  const source = {
    action: "sys_hub_action_instance",
    logic: "sys_hub_flow_logic_instance_v2",
    subflow: "sys_hub_sub_flow_instance_v2",
  }[kind];
  return {
    number: String(seq),
    kind,
    source,
    sys_id: `${kind.slice(0, 2)}${String(seq).padStart(2, "0")}${"0".repeat(28)}`,
    ui_id: `u${seq}`,
    order: seq * 100,
    name,
    ref: { sys_id: `ref${String(seq).padStart(29, "0")}`, name },
    values: EMPTY,
    children,
    ...extra,
  };
}

const TRIGGER = {
  sys_id: "tr" + "0".repeat(30),
  source: "sys_hub_trigger_instance_v2",
  definition: { sys_id: id("1"), name: "Created", type: "record_create" },
  type: "record_create",
  table: "incident",
  values: EMPTY,
};

/** Emit a flow (or subflow) built from `steps` plus tree overrides. */
function emit(steps, over = {}, kind = "flow") {
  const tree = {
    kind,
    counts: {},
    verified: false,
    caveats: [],
    unreadable: [],
    sys_id: FLOW,
    name: "Edge Flow",
    flow: {
      sys_id: FLOW,
      name: "Edge Flow",
      internal_name: "edge_flow",
      type: kind,
      active: true,
      run_with_roles: [],
    },
    trigger: kind === "flow" ? TRIGGER : null,
    steps,
    inputs: [],
    outputs: [],
    variables: [],
    stages: [],
    ...over,
  };
  const sources = [
    {
      scope: SCOPE,
      record: {
        sys_id: FLOW,
        name: "Edge Flow",
        internal_name: "edge_flow",
        type: kind,
        active: "true",
        sys_scope: SCOPE.sys_id,
      },
      children: [],
      flowTree: tree,
    },
  ];
  const b = emitFluent(getArtifactType(kind), sources, kind, null);
  const text = b.files.find((f) => f.path.endsWith(".now.ts")).content;
  return { b, text, reasons: b.unsupported.map((u) => u.reason) };
}

const has = (reasons, re) =>
  assert.ok(
    reasons.some((r) => re.test(r)),
    `no unsupported entry matching ${re} in\n${reasons.join("\n")}`,
  );

test("core actions: Boolean, Integer and TemplateValue inputs are typed", () => {
  seq = 0;
  const { text } = emit([
    step("action", "Create Task", {
      values: inputs([
        ["task_table", "task"],
        ["wait", "true"],
        ["field_values", `short_description=Hi^priority={{${PILL}}}^EQ`],
      ]),
    }),
    step("action", "Create Task", {
      values: inputs([
        ["task_table", "task"],
        ["wait", ["a", { deep: null, n: 2 }]],
        ["field_values", "1bad=x"],
      ]),
    }),
    step("action", "Create Task", {
      values: inputs([
        ["task_table", "task"],
        ["field_values", "novalue"],
      ]),
    }),
    step("action", "Create Task", {
      values: inputs([
        ["task_table", "task"],
        ["field_values", "^EQ"],
      ]),
    }),
    step("action", "Look Up Records", {
      values: inputs([
        ["table", "incident"],
        ["max_results", "10"],
      ]),
    }),
    step("action", "Look Up Records", {
      values: inputs([
        ["table", "incident"],
        ["max_results", 7],
      ]),
    }),
  ]);
  assert.match(text, /wait: true/);
  assert.match(
    text,
    /field_values: TemplateValue\(\{[\s\S]*?short_description: 'Hi',[\s\S]*?priority: wfa\.dataPill\(/,
  );
  assert.match(text, /wait: \[\s*'a',\s*\{[\s\S]*?deep: null,[\s\S]*?n: 2/);
  assert.match(text, /field_values: '1bad=x'/);
  assert.match(text, /field_values: 'novalue'/);
  assert.match(text, /field_values: '\^EQ'/);
  assert.match(text, /max_results: 10/);
  assert.match(text, /max_results: 7/);
});

test("steps: depth caps, nested children, undecodable values and secrets fall back to Record()", () => {
  seq = 0;
  const { b, text, reasons } = emit([
    step("action", "Log", {
      childrenOmitted: 2,
      values: inputs([["message", "hi"]]),
    }),
    step("action", "Log", { values: inputs([["message", "outer"]]) }, [
      step("action", "Log", { values: inputs([["message", "inner"]]) }),
    ]),
    step("action", "Log", {
      values: { format: "json", decoded: true, bytes: 99, inputsOmitted: 3 },
    }),
    step("action", "Acme: Rotate Key", {
      parent_ui_id: "u0",
      values: inputs([
        ["password", "hunter2"],
        ["note", "plain"],
      ]),
    }),
    step("action", "Acme: Raw Values", { values: json("just-a-string") }),
    step("action", "Acme: Empty Values", { values: json("") }),
  ]);
  has(reasons, /2 nested step\(s\) past the tree depth cap/);
  has(reasons, /an action step with nested steps/);
  has(reasons, /3 input\(s\) past the per-step cap are not in the tree/);
  has(reasons, /'Acme: Rotate Key' is a spoke or custom action/);
  assert.match(text, /parent_ui_id: 'u0'/);
  assert.ok(!text.includes("hunter2"), "the secret is not emitted");
  assert.ok(b.secretsReplaced >= 1);
  assert.match(text, /values: '"just-a-string"'/);
});

test("subflow calls: unresolved, undecodable and nested calls fall back", () => {
  seq = 0;
  const { text, reasons } = emit([
    step("subflow", "Ghost", { ref: undefined }),
    step("subflow", "Broken", {
      values: { format: "unknown", decoded: false, bytes: 3, reason: "bad" },
    }),
    step("subflow", "Nested", {}, [step("action", "Log", {})]),
    step("subflow", "Notify", {
      ref: { sys_id: id("B"), name: "Notify" },
      values: inputs([["who", "admin"]]),
    }),
  ]);
  has(reasons, /the called subflow is not resolved/);
  has(reasons, /its values could not be decoded \(bad\)/);
  has(reasons, /a subflow call with nested steps/);
  assert.match(text, /wfa\.subflow\('b{32}'/);
});

test("logic: orphan blocks, Do until, leaf limits and flow variables", () => {
  seq = 0;
  const { text, reasons } = emit([
    step("logic", "If", { values: json({ condition: `{{${PILL}}}=1` }) }, [
      step("logic", "End Flow", {}),
    ]),
    step(
      "logic",
      "Else If",
      { values: json({ condition: `{{${PILL}}}=2`, label: "Two" }) },
      [],
    ),
    step("logic", "Catch", {}),
    step("logic", "Path", {}),
    step("logic", "Else If", {}),
    step("logic", "For Each", { values: json({ items: "" }) }),
    step("logic", "Do the following until", {}),
    step(
      "logic",
      "Do the following until",
      { values: json({ condition: `{{${PILL}}}=3` }) },
      [step("logic", "Exit Loop", {})],
    ),
    step("logic", "Exit Loop", {}, [step("action", "Log", {})]),
    step("logic", "End Flow", {}),
    step("logic", "Wait For a Duration", {
      values: json({ duration: "soon" }),
    }),
    step("logic", "Set Flow Variables", { values: json({ attempts: 3 }) }),
    step("logic", "If", { values: json({ condition: "x=1", extra: "y" }) }),
  ]);
  assert.match(text, /wfa\.flowLogic\.elseIf\(\{[\s\S]*?label: 'Two'/);
  has(reasons, /'Catch' without a preceding Try/);
  has(reasons, /a parallel path outside 'Do the following in parallel'/);
  has(reasons, /'Else If' without a preceding If/);
  has(reasons, /a For Each without items/);
  has(reasons, /a Do the following until without a condition/);
  assert.match(text, /wfa\.flowLogic\.doTheFollowing\(/);
  assert.match(text, /wfa\.flowLogic\.until\(/);
  has(reasons, /'Exit Loop' with nested steps/);
  has(reasons, /End Flow outside an If/);
  has(reasons, /a wait duration that is not an explicit duration/);
  assert.match(
    text,
    /wfa\.flowLogic\.setFlowVariables\([\s\S]*?params\.flowVariables, \{[\s\S]*?attempts: 3/,
  );
  has(reasons, /Logic input 'extra' has no wfa\.flowLogic config property/);
});

test("triggers: unmapped and undecodable fall back; decoded inputs join the config", () => {
  seq = 0;
  const unmapped = emit([], {
    trigger: {
      ...TRIGGER,
      definition: { sys_id: id("2"), name: "Custom Hook", type: "custom_hook" },
      type: "custom_hook",
    },
  });
  has(unmapped.reasons, /Trigger 'Custom Hook' has no trigger\.\* mapping/);
  assert.match(unmapped.text, /trigger emitted as Record\(\) below/);

  const undecoded = emit([], {
    trigger: {
      ...TRIGGER,
      values: { format: "unknown", decoded: false, bytes: 2, reason: "nope" },
    },
  });
  has(undecoded.reasons, /Trigger 'Created': its values could not be decoded/);

  const anonymous = emit([], {
    trigger: { sys_id: TRIGGER.sys_id, type: "mystery", values: EMPTY },
  });
  has(anonymous.reasons, /Trigger 'mystery' has no trigger\.\* mapping/);

  const withInputs = emit([], {
    trigger: {
      ...TRIGGER,
      condition: "priority=1",
      values: inputs([
        ["table", "ignored"],
        ["run_on_extended", "true"],
      ]),
    },
  });
  assert.match(withInputs.text, /table: 'incident'/);
  assert.match(withInputs.text, /run_on_extended: 'true'/);
  assert.ok(!withInputs.text.includes("ignored"));
});

test("columns and stages: reference without a table, non-explicit stage duration", () => {
  seq = 0;
  const sub = emit(
    [],
    {
      inputs: [
        {
          sys_id: "si" + "1".repeat(30),
          element: "caller",
          label: "Caller",
          type: "reference",
        },
      ],
    },
    "subflow",
  );
  has(sub.reasons, /'caller': reference column without a reference table/);

  const flow = emit([], {
    stages: [
      {
        sys_id: "st" + "1".repeat(30),
        label: "Triage",
        order: 1,
        duration: "two days",
      },
    ],
  });
  has(
    flow.reasons,
    /Stage 'Triage': duration 'two days' is not an explicit duration/,
  );
  assert.match(flow.text, /Triage: FlowStage\(/);
});
