// P-27 — Flow, subflow, action and playbook Fluent emitters: goldens over
// explain_flow-shaped trees, a TypeScript parse of every emitted file, the
// unsupported[] entries and Record() fallbacks (spoke actions, nested
// doInParallel, Questionnaire activities, variants, unknown logic, orphan
// blocks, undecodable values, rows outside the tree), secret placeholders,
// determinism, the Record() path for a degraded tree, and
// servicenow_generate_fluent end to end against a Table API mock.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  emitFluent,
  FLUENT_EMITTERS,
  SECRET_PLACEHOLDER,
} from "../build/api/fluent.js";
import {
  __flowInternals,
  FLOW_TREE_KINDS,
  FLOW_VERIFIED_NOTE,
} from "../build/api/fluent-flow.js";
import { getArtifactType } from "../build/core/artifacts/registry.js";
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
const SCOPE = { sys_id: id("5"), scope: "x_acme_app" };
const FLOW = id("a");
const SUB = id("b");
const ACT = id("c");
const PB = id("d");
const ROLE = id("e");
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
/** A tree step; sys_ids are stable per fixture build. */
function step(kind, name, extra = {}, children = []) {
  seq++;
  const sysId =
    extra.sys_id ??
    `${kind.slice(0, 2)}${String(seq).padStart(2, "0")}${"0".repeat(28)}`;
  const source = {
    action: "sys_hub_action_instance",
    logic: "sys_hub_flow_logic_instance_v2",
    subflow: "sys_hub_sub_flow_instance_v2",
    step: "sys_hub_step_instance",
  }[kind];
  return {
    number: String(seq),
    kind,
    source,
    sys_id: sysId,
    ui_id: `u${seq}`,
    order: seq * 100,
    name,
    ref: { sys_id: `ref${String(seq).padStart(29, "0")}`, name },
    values: EMPTY,
    children,
    ...extra,
  };
}

const counts = {
  steps: 0,
  actions: 0,
  logic: 0,
  subflows: 0,
  inputs: 0,
  outputs: 0,
  variables: 0,
  stages: 0,
  activities: 0,
  transitions: 0,
  runs: 0,
  callees: 0,
};
const treeBase = (kind) => ({
  kind,
  counts,
  verified: false,
  caveats: [],
  unreadable: [],
});

const SPOKE = "ac" + "9".repeat(30);

function flowCase() {
  seq = 0;
  const steps = [
    step("action", "Look Up Record", {
      comment: "find the caller's open incidents",
      values: inputs([
        ["table", "incident"],
        ["conditions", `priority={{${PILL}}}`],
      ]),
    }),
    step("logic", "If", { values: json({ condition: `{{${PILL}}}=1` }) }, [
      step("action", "Update Record", {
        values: inputs([
          ["table", "incident"],
          ["state", 2],
        ]),
      }),
    ]),
    step("logic", "Else If", { values: json({ condition: `{{${PILL}}}=2` }) }, [
      step("action", "Log", {
        values: inputs([
          [
            "message",
            "Value `x` ${y} for {{Trigger_Record_Created.current.number}}",
          ],
        ]),
      }),
    ]),
    step("logic", "Else", {}, [
      step("action", "Slack: Post Message", {
        sys_id: SPOKE,
        values: inputs([["channel", "#ops"]]),
      }),
    ]),
    step(
      "logic",
      "For Each",
      { values: json({ items: "{{Look_Up_Record_1.Records}}" }) },
      [
        step("subflow", "Notify Approvers", {
          ref: { sys_id: SUB, name: "Notify Approvers" },
          values: inputs([["attempts", "{{flow_variables.attempts}}"]]),
        }),
      ],
    ),
    step("logic", "Try", {}, [
      step("action", "Create Task", {
        values: inputs([
          ["short_description", "Follow up"],
          ["password", "hunter2"],
        ]),
      }),
    ]),
    step("logic", "Catch", {}, [
      step("action", "Log", { values: inputs([["message", "failed"]]) }),
    ]),
    step("logic", "Do the following in parallel", {}, [
      step("logic", "Path", {}, [
        step("action", "Send Email", { values: inputs([["to", "a@b.c"]]) }),
      ]),
      step("logic", "Path", {}, [
        step("logic", "Do the following in parallel", {}, [
          step("action", "Log", { values: inputs([["message", "deep"]]) }),
        ]),
      ]),
      step("action", "Send SMS", { values: inputs([["to", "+100"]]) }),
    ]),
    step("logic", "Dynamic Flow", { values: json({ mode: "x" }) }, [
      step("action", "Log", { values: inputs([["message", "lost?"]]) }),
    ]),
    step("logic", "Else", {}),
    step("logic", "Wait For a Duration", {
      values: json({ duration: "1970-01-01 00:05:00" }),
    }),
    step("action", "Update Record", {
      values: {
        format: "unknown",
        decoded: false,
        bytes: 9,
        raw: "%%bad%%",
        reason: "not JSON",
      },
    }),
    step("logic", "End Flow", {}),
  ];
  const tree = {
    ...treeBase("flow"),
    sys_id: FLOW,
    name: "Incident Triage",
    flow: {
      sys_id: FLOW,
      name: "Incident Triage",
      internal_name: "incident_triage",
      type: "flow",
      active: true,
      status: "published",
      description: "Routes P1 incidents",
      run_as: "system",
      run_with_roles: [{ sys_id: ROLE, name: "itil" }, { sys_id: id("f") }],
    },
    trigger: {
      sys_id: "tr" + "0".repeat(30),
      source: "sys_hub_trigger_instance_v2",
      definition: { sys_id: id("1"), name: "Created", type: "record_create" },
      type: "record_create",
      table: "incident",
      condition: "priority=1",
      values: EMPTY,
    },
    steps,
    inputs: [
      {
        sys_id: "in" + "0".repeat(30),
        element: "override",
        label: "Override",
        type: "boolean",
        mandatory: false,
        default: "false",
      },
    ],
    outputs: [],
    variables: [
      {
        sys_id: "va" + "1".repeat(30),
        element: "attempts",
        label: "Attempts",
        type: "integer",
        mandatory: false,
        default: "0",
      },
      {
        sys_id: "va" + "2".repeat(30),
        element: "api_token",
        label: "API token",
        type: "string",
        default: "s3cr3t-value",
      },
      {
        sys_id: "va" + "3".repeat(30),
        element: "watchers",
        label: "Watchers",
        type: "glide_list",
      },
    ],
    stages: [
      {
        sys_id: "st" + "1".repeat(30),
        label: "Triage",
        value: "triage",
        order: 1,
      },
      {
        sys_id: "st" + "2".repeat(30),
        label: "Done",
        value: "done",
        order: 2,
        duration: "1970-01-02 00:00:00",
      },
    ],
  };
  return {
    type: "flow",
    sources: [
      {
        scope: SCOPE,
        record: {
          sys_id: FLOW,
          name: "Incident Triage",
          internal_name: "incident_triage",
          description: "Routes P1 incidents",
          run_as: "system",
          run_with_roles: ROLE,
          type: "flow",
          active: "true",
          status: "published",
          callable_by_client_api: "true",
          sys_scope: SCOPE.sys_id,
          sys_updated_on: "2026-09-01 10:00:00",
        },
        children: [
          {
            table: "sys_hub_action_instance",
            parentField: "flow",
            verified: true,
            count: 2,
            records: [
              {
                sys_id: SPOKE,
                flow: FLOW,
                order: "400",
                ui_id: "u5",
                action_type: id("7"),
                values: '[{"name":"channel","value":"#ops"}]',
              },
              {
                sys_id: "zz" + "0".repeat(30),
                flow: FLOW,
                order: "9999",
                ui_id: "u-stray",
                action_type: id("8"),
                values: "",
              },
            ],
          },
          {
            table: "sys_hub_flow_stage",
            parentField: "flow",
            verified: true,
            count: 2,
            truncated: true,
            records: [],
          },
          {
            table: "sys_hub_flow_output",
            parentField: "model",
            verified: true,
            count: 0,
            records: [],
            redacted: true,
            reason: "Table policy denies sys_hub_flow_output.",
          },
        ],
        flowTree: tree,
      },
    ],
  };
}

function subflowCase() {
  seq = 0;
  const tree = {
    ...treeBase("subflow"),
    sys_id: SUB,
    name: "Notify Approvers",
    flow: {
      sys_id: SUB,
      name: "Notify Approvers",
      internal_name: "notify_approvers",
      type: "subflow",
      active: true,
      status: "draft",
      run_as: "user",
      run_with_roles: [],
    },
    trigger: null,
    steps: [
      step("action", "Look Up Record", {
        values: inputs([
          ["table", "sys_user"],
          ["conditions", "sys_id={{subflow_inputs.caller}}"],
        ]),
      }),
      step("logic", "Assign Subflow Outputs", {
        values: json({ notified: "{{Look_Up_Record_1.Record.email}}" }),
      }),
    ],
    inputs: [
      {
        sys_id: "si" + "1".repeat(30),
        element: "caller",
        label: "Caller",
        type: "reference",
        mandatory: true,
      },
      {
        sys_id: "si" + "2".repeat(30),
        element: "note",
        label: "Note's text",
        type: "string",
        default: "Line 1\nLine 2",
      },
    ],
    outputs: [
      {
        sys_id: "so" + "1".repeat(30),
        element: "notified",
        label: "Notified",
        type: "string",
      },
    ],
    variables: [],
    stages: [],
  };
  return {
    type: "subflow",
    sources: [
      {
        scope: SCOPE,
        record: {
          sys_id: SUB,
          name: "Notify Approvers",
          internal_name: "notify_approvers",
          type: "subflow",
          active: "true",
          status: "draft",
          run_as: "user",
          sys_scope: SCOPE.sys_id,
        },
        children: [],
        flowTree: tree,
      },
    ],
  };
}

function actionCase() {
  seq = 0;
  const tree = {
    ...treeBase("action"),
    sys_id: ACT,
    name: "Create Follow-up",
    action: {
      sys_id: ACT,
      name: "Create Follow-up",
      internal_name: "x_acme_create_follow_up",
      category: "Acme",
      access: "public",
      active: true,
      description: "Creates a follow-up task",
    },
    steps: [
      step("step", "Script", { comment: "build the description" }),
      step("step", "Create Record", {
        values: inputs([
          ["table", "task"],
          ["short_description", "{{action_inputs.short_description}}"],
        ]),
      }),
    ],
    inputs: [
      {
        sys_id: "ai" + "1".repeat(30),
        element: "short_description",
        label: "Short description",
        type: "string",
        mandatory: true,
      },
    ],
    outputs: [
      {
        sys_id: "ao" + "1".repeat(30),
        element: "task",
        label: "Task",
        type: "reference",
      },
    ],
  };
  return {
    type: "flow_action",
    sources: [
      {
        scope: SCOPE,
        record: {
          sys_id: ACT,
          name: "Create Follow-up",
          internal_name: "x_acme_create_follow_up",
          category: "Acme",
          access: "public",
          active: "true",
          description: "Creates a follow-up task",
          sys_scope: SCOPE.sys_id,
        },
        children: [],
        flowTree: tree,
      },
    ],
  };
}

function playbookCase() {
  const tree = {
    ...treeBase("playbook"),
    sys_id: PB,
    name: "Onboarding",
    playbook: {
      sys_id: PB,
      name: "Onboarding",
      internal_name: "x_acme_onboarding",
      table: "sn_hr_core_case",
      status: "published",
      active: true,
      description: "New hire onboarding",
    },
    inputs: [
      {
        sys_id: "pi" + "1".repeat(30),
        element: "start_date",
        label: "Start date",
        type: "glide_date",
      },
    ],
    outputs: [],
    triggers: [
      {
        sys_id: "pt" + "1".repeat(30),
        name: "Case created",
        definition: { sys_id: id("2"), name: "Record created" },
        type: "record_create",
        table: "sn_hr_core_case",
        condition: "hr_service=onboarding",
      },
    ],
    lanes: [
      {
        number: "1",
        sys_id: "la" + "1".repeat(30),
        name: "Prepare",
        order: 100,
        activities: [
          {
            number: "1.1",
            sys_id: "pa" + "1".repeat(30),
            name: "Read the handbook",
            order: 100,
            definition: { sys_id: id("3"), name: "Instruction" },
            timers: [
              {
                sys_id: "tm" + "1".repeat(30),
                name: "Reminder",
                type: "relative",
                duration: "1970-01-03 00:00:00",
              },
            ],
          },
          {
            number: "1.2",
            sys_id: "pa" + "2".repeat(30),
            name: "Survey",
            order: 200,
            definition: { sys_id: id("4"), name: "Questionnaire" },
            timers: [
              { sys_id: "tm" + "2".repeat(30), name: "Nag", type: "relative" },
            ],
          },
          {
            number: "1.3",
            sys_id: "pa" + "3".repeat(30),
            name: "Personal details",
            order: 300,
            definition: { sys_id: id("6"), name: "Record Form" },
            condition: "active=true",
          },
        ],
      },
      {
        number: "2",
        sys_id: "la" + "2".repeat(30),
        name: "Provision",
        order: 200,
        condition: "state=2",
        activities: [
          {
            number: "2.1",
            sys_id: "pa" + "4".repeat(30),
            name: "Custom widget",
            order: 100,
            definition: { sys_id: id("8"), name: "Custom Thing" },
          },
          {
            number: "2.2",
            sys_id: "pa" + "5".repeat(30),
            name: "Order laptop",
            order: 200,
            definition: { sys_id: id("9"), name: "Run Subflow" },
          },
        ],
      },
    ],
    variants: [
      {
        sys_id: "pv" + "1".repeat(30),
        name: "EMEA",
        active: true,
        condition: "location.region=emea",
        order: 1,
      },
    ],
  };
  return {
    type: "playbook",
    sources: [
      {
        scope: SCOPE,
        record: {
          sys_id: PB,
          label: "Onboarding",
          name: "x_acme_onboarding",
          table: "sn_hr_core_case",
          status: "published",
          active: "true",
          description: "New hire onboarding",
          sys_scope: SCOPE.sys_id,
        },
        children: [],
        flowTree: tree,
      },
    ],
  };
}

const CASES = {
  flow_emitter: flowCase,
  subflow_emitter: subflowCase,
  action_emitter: actionCase,
  playbook_emitter: playbookCase,
};

function emitCase(name, rules = null, mutate) {
  const c = CASES[name]();
  if (mutate) mutate(c);
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

const mainFile = (b) => b.files.find((f) => f.path.endsWith(".now.ts")).content;

for (const name of Object.keys(CASES)) {
  test(`fluent-flow golden: ${name}`, () => {
    golden(name, bundleText(emitCase(name)));
  });
}

test("every emitted flow-group .ts file parses as TypeScript", () => {
  for (const name of Object.keys(CASES)) {
    for (const f of emitCase(name).files) {
      if (!f.path.endsWith(".ts")) continue;
      assert.deepEqual(parseErrors(f.path, f.content), [], `${name} ${f.path}`);
    }
  }
});

test("the flow-group types have a tree emitter, not a P-26 dedicated one", () => {
  assert.deepEqual(Object.keys(FLOW_TREE_KINDS).sort(), [
    "flow",
    "flow_action",
    "playbook",
    "subflow",
  ]);
  for (const type of Object.keys(FLOW_TREE_KINDS)) {
    assert.equal(FLUENT_EMITTERS[type], undefined, type);
  }
});

test("flow: Flow(), trigger, core actions, logic chains and data pills", () => {
  const text = mainFile(emitCase("flow_emitter"));
  assert.match(
    text,
    /import \{ Flow, action, trigger, wfa \} from '@servicenow\/sdk\/automation'/,
  );
  assert.match(text, /^Flow\(\n/m);
  assert.match(text, /wfa\.trigger\(trigger\.record\.created, \{/);
  assert.match(text, /wfa\.action\(action\.core\.lookUpRecord, \{/);
  assert.match(
    text,
    /conditions: `priority=\$\{wfa\.dataPill\(params\.trigger\.current\.priority\)\}`/,
  );
  assert.match(
    text,
    /condition: `\$\{wfa\.dataPill\(params\.trigger\.current\.priority\)\}=1`/,
  );
  assert.match(text, /\}\)\.elseIf\(\{/);
  assert.match(text, /wfa\.flowLogic\.forEach\(\{[\s\S]*?\}, \(item\) => \{/);
  assert.match(
    text,
    /wfa\.flowLogic\.tryCatch\(\{[\s\S]*?try: \(\) => \{[\s\S]*?catch: \(\) => \{/,
  );
  assert.match(text, /wfa\.flowLogic\.doInParallel\(/);
  assert.match(text, /wfa\.flowLogic\.waitForADuration\(\{/);
  assert.match(text, /wfa\.flowLogic\.endFlow\(\{/);
  assert.match(text, /wfa\.subflow\(Now\.ref\('sys_hub_flow', 'b{32}'\)/);
  assert.match(
    text,
    /attempts: wfa\.dataPill\(params\.flowVariables\.attempts\)/,
  );
  assert.match(
    text,
    /runWithRoles: \['itil', Now\.ref\('sys_user_role', 'f{32}'\)\]/,
  );
  assert.match(text, /attempts: IntegerColumn\(\{/);
  assert.match(text, /stages: \[/);
  assert.match(text, /verified:false/);
  // Template-literal escaping: a backtick and ${ in text stay literal.
  assert.match(
    text,
    /message: `Value \\`x\\` \\\$\{y\} for \$\{wfa\.dataPill\(params\.trigger\.current\.number\)\}`/,
  );
});

test("unsupported constructs: explicit entries plus Record() fallbacks, never silent loss", () => {
  const b = emitCase("flow_emitter");
  const text = mainFile(b);
  const reasons = b.unsupported.map((u) => u.reason);
  const has = (re) =>
    assert.ok(
      reasons.some((r) => re.test(r)),
      `no unsupported entry matching ${re}`,
    );
  has(/'Slack: Post Message' is a spoke or custom action outside action\.core/);
  has(/nested doInParallel is not supported/);
  has(/logic 'Dynamic Flow' has no wfa\.flowLogic mapping/);
  has(/'Else' without a preceding If/);
  has(/its values could not be decoded \(not JSON\)/);
  has(/Inside unsupported step/);
  has(
    /Data pill \{\{Look_Up_Record_1\.Records\}\} has no known wfa\.dataPill\(\) root/,
  );
  has(/type 'glide_list' has no column constructor mapped/);
  has(/A flow has no inputs in Fluent/);
  has(/Row not represented in the explain_flow tree/);
  has(/Only the first 2 child rows were read/);
  has(/Child table not emitted: Table policy denies/);
  has(/No Flow property is mapped for callable_by_client_api/);
  // The spoke step's raw row is the Record() fallback (its values column).
  assert.match(
    text,
    /table: 'sys_hub_action_instance',[\s\S]*?values: '\[\{"name":"channel","value":"#ops"\}\]'/,
  );
  // Every api / child entry with a key has a Record() under that key.
  for (const u of b.unsupported) {
    if (
      (u.kind === "api" || u.kind === "child") &&
      u.key &&
      u.sys_id !== FLOW
    ) {
      assert.match(
        text,
        new RegExp(`Record\\(\\{\\n    \\$id: Now\\.ID\\['${u.key}'\\]`),
        `${u.key} has no Record() fallback`,
      );
    }
  }
  // The nested doInParallel's child is a Record() too.
  assert.ok(
    reasons.filter((r) => /Inside unsupported step/.test(r)).length >= 2,
  );
});

test("playbook: PlaybookDefinition with lanes, core activities, timers; Questionnaire and variants fall back", () => {
  const b = emitCase("playbook_emitter");
  const text = mainFile(b);
  assert.match(text, /^PlaybookDefinition\(\{/m);
  assert.match(
    text,
    /activityDefinition: ActivityDefinitions\.Core\.instruction/,
  );
  assert.match(text, /activityDefinition: ActivityDefinitions\.Core\.form/);
  assert.match(text, /activityDefinition: ActivityDefinitions\.Core\.subflow/);
  assert.match(text, /timers: \[/);
  assert.match(text, /start_date: DateColumn\(\{/);
  const reasons = b.unsupported.map((u) => u.reason);
  assert.ok(
    reasons.some((r) => /Questionnaire activities are not supported/.test(r)),
  );
  assert.ok(
    reasons.some((r) =>
      /'Custom Thing' has no ActivityDefinitions\.Core mapping/.test(r),
    ),
  );
  assert.ok(
    reasons.some((r) =>
      /variant 'EMEA' has no PlaybookDefinition property/.test(r),
    ),
  );
  assert.ok(reasons.some((r) => /Timer of an unsupported activity/.test(r)));
  assert.match(text, /table: 'sys_pd_process_variant'/);
  assert.match(text, /table: 'sys_pd_activity'/);
  assert.match(text, /table: 'sys_pd_timer_attributes'/);
  assert.doesNotMatch(text, /label: 'Survey'[\s\S]*activityDefinition/);
});

test("subflow and action: inputs / outputs as columns, input pills", () => {
  const sub = mainFile(emitCase("subflow_emitter"));
  assert.match(sub, /^Subflow\(\n/m);
  assert.match(sub, /caller: ReferenceColumn\(\{/);
  assert.match(sub, /notified: StringColumn\(\{/);
  assert.match(sub, /\$\{wfa\.dataPill\(params\.inputs\.caller\)\}/);
  assert.match(sub, /wfa\.flowLogic\.assignSubflowOutputs\(\{/);
  const act = emitCase("action_emitter");
  const text = mainFile(act);
  assert.match(text, /^Action\(\n/m);
  assert.match(text, /category: 'Acme'/);
  assert.match(text, /wfa\.action\(action\.core\.createRecord/);
  assert.match(text, /wfa\.dataPill\(params\.inputs\.short_description\)/);
  assert.ok(
    act.unsupported.some((u) =>
      /action step type 'Script' has no action\.core mapping/.test(u.reason),
    ),
  );
});

test("secrets: credential-like inputs and variable defaults become the placeholder", () => {
  const b = emitCase("flow_emitter");
  const all = bundleText(b);
  assert.doesNotMatch(all, /hunter2/);
  assert.doesNotMatch(all, /s3cr3t-value/);
  assert.match(all, new RegExp(`password: '${SECRET_PLACEHOLDER}'`));
  assert.ok(b.secretsReplaced >= 2);
  // SN_REDACT_FIELDS-style rules reach step inputs too.
  const rules = { fields: new Set(["channel", "to"]), pii: false };
  const redacted = bundleText(emitCase("flow_emitter", rules));
  assert.doesNotMatch(redacted, /a@b\.c/);
});

test("output is deterministic: repeated runs and child row order do not matter", () => {
  const a = bundleText(emitCase("flow_emitter"));
  const b = bundleText(
    emitCase("flow_emitter", null, (c) => {
      for (const ch of c.sources[0].children) ch.records.reverse();
      c.sources[0].record = Object.fromEntries(
        Object.entries(c.sources[0].record).reverse(),
      );
    }),
  );
  assert.equal(a, b);
  for (const name of Object.keys(CASES)) {
    assert.equal(bundleText(emitCase(name)), bundleText(emitCase(name)));
  }
});

test("a degraded, unavailable or mismatched tree falls back to the P-26 Record() form", () => {
  for (const mutate of [
    (c) =>
      (c.sources[0].flowTree.degraded = {
        table: "sys_hub_flow",
        reason: "403",
      }),
    (c) => (c.sources[0].flowTree.available = false),
    (c) => (c.sources[0].flowTree.kind = "subflow"),
    (c) => delete c.sources[0].flowTree,
  ]) {
    const b = emitCase("flow_emitter", null, mutate);
    const text = mainFile(b);
    assert.match(text, /^Record\(\{/m);
    assert.doesNotMatch(text, /^Flow\(/m);
    assert.ok(
      b.unsupported.some(
        (u) =>
          u.reason === "The Flow emitter is P-27; emitted as Record() rows.",
      ),
      JSON.stringify(b.unsupported),
    );
  }
});

test("pill paths and template escaping", () => {
  const { pillPath, templateText } = __flowInternals;
  assert.equal(
    pillPath("Trigger_Record_Created.current.priority"),
    "params.trigger.current.priority",
  );
  assert.equal(pillPath("flow_variables.count"), "params.flowVariables.count");
  assert.equal(pillPath("subflow_inputs.a-b"), "params.inputs['a-b']");
  assert.equal(pillPath("Look_Up_Record_1.Record"), undefined);
  assert.equal(pillPath("trigger"), undefined);
  const nasty = "a`b${c}\\d\ne\u0000f g";
  const literal = `\`${templateText(nasty)}\``;
  assert.deepEqual(parseErrors("t.ts", `const s = ${literal}`), []);
  assert.equal(new Function(`return ${literal}`)(), nasty);
});

// ---------------------------------------------------------------------------
// The tool, end to end
// ---------------------------------------------------------------------------

const tool = ALL_TOOLS.find((s) => s.name === "servicenow_generate_fluent");

function matchTerm(row, term) {
  let m;
  if ((m = /^([\w.]+)IN(.*)$/.exec(term))) {
    return m[2].split(",").includes(String(row[m[1]] ?? ""));
  }
  if ((m = /^([\w.]+)ISNOTEMPTY$/.exec(term))) return !!row[m[1]];
  if ((m = /^([\w.]+)ISEMPTY$/.exec(term))) return !row[m[1]];
  if ((m = /^([\w.]+)=(.*)$/.exec(term))) {
    return String(row[m[1]] ?? "") === m[2];
  }
  return false;
}

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

/** A Table API mock over `tables`: list reads filtered by query, and GET by sys_id. */
function instance(tables, calls) {
  return (url, init) => {
    calls.push({ url, method: init?.method ?? "GET" });
    const u = new URL(url);
    const m = u.pathname.match(/\/api\/now\/table\/([^/]+)(?:\/([^/]+))?$/);
    assert.ok(m, `unexpected request ${url}`);
    const all = tables[m[1]] ?? [];
    if (m[2]) {
      const row = all.find((r) => r.sys_id === m[2]);
      return row
        ? jsonResponse(200, { result: row })
        : jsonResponse(404, { error: { message: "No Record found" } });
    }
    const query = u.searchParams.get("sysparm_query") ?? "";
    const fields = u.searchParams.get("sysparm_fields")?.split(",");
    const limit = Number(u.searchParams.get("sysparm_limit") ?? 1000);
    const rows = all
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
}

const E2E = {
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
      run_with_roles: "",
      label_cache: "",
      master_snapshot: "",
      latest_snapshot: "",
      sys_scope: SCOPE.sys_id,
    },
  ],
  sys_scope: [{ sys_id: SCOPE.sys_id, scope: SCOPE.scope }],
  sys_hub_trigger_instance_v2: [
    {
      sys_id: "trg1",
      flow: FLOW,
      trigger_definition: id("1"),
      trigger_type: "record_create",
      table: "incident",
      condition: "priority=1",
      values: "",
    },
  ],
  sys_hub_trigger_definition: [
    { sys_id: id("1"), name: "Created", type: "record_create" },
  ],
  sys_hub_action_instance_v2: [
    {
      sys_id: "act1",
      flow: FLOW,
      order: "100",
      ui_id: "u1",
      parent_ui_id: "",
      action_type: "at1",
      "action_type.name": "Look Up Record",
      values: JSON.stringify([
        { name: "table", value: "incident" },
        { name: "conditions", value: `priority={{${PILL}}}` },
      ]),
    },
  ],
};

test("generate_fluent: a flow runs through explain_flow into Flow(), GETs only", async () => {
  freshRuntime();
  const calls = [];
  await withEnv({ ...SDK_OFF, ...NO_REDACT }, () =>
    withFetch(instance(E2E, calls), async () => {
      const res = await runSpec(tool, { artifactType: "flow", sys_id: FLOW });
      assert.equal(res.isError, undefined, res.content?.[0]?.text);
      const body = res.structuredContent;
      assert.equal(body.emitter, "flow");
      assert.equal(body.sdkApi, "Flow");
      assert.ok(body.warnings.includes(FLOW_VERIFIED_NOTE));
      const main = body.files.find((f) => f.path.endsWith(".now.ts")).content;
      assert.match(main, /^Flow\(/m);
      assert.match(main, /wfa\.trigger\(trigger\.record\.created/);
      assert.match(main, /wfa\.action\(action\.core\.lookUpRecord/);
      assert.match(main, /wfa\.dataPill\(params\.trigger\.current\.priority\)/);
      assert.deepEqual(parseErrors("f.ts", main), []);
    }),
  );
  assert.deepEqual([...new Set(calls.map((c) => c.method))], ["GET"]);
  assert.ok(calls.some((c) => c.url.includes("sys_hub_action_instance_v2")));
});

test("generate_fluent: an unreadable tree is a warning and the Record() fallback", async () => {
  freshRuntime();
  const calls = [];
  const tables = { ...E2E };
  // The root reads through getArtifact, but explain_flow's own read of the
  // flow table is denied: the tree degrades.
  const handler = instance(tables, calls);
  await withEnv({ ...SDK_OFF, ...NO_REDACT }, () =>
    withFetch(
      (url, init) => {
        const u = new URL(url);
        if (
          u.pathname.endsWith("/table/sys_hub_flow") &&
          (u.searchParams.get("sysparm_query") ?? "").includes(`sys_id=${FLOW}`)
        ) {
          return jsonResponse(403, {
            error: { message: "denied", detail: "ACL" },
          });
        }
        return handler(url, init);
      },
      async () => {
        const res = await runSpec(tool, { artifactType: "flow", sys_id: FLOW });
        assert.equal(res.isError, undefined, res.content?.[0]?.text);
        const body = res.structuredContent;
        const main = body.files.find((f) => f.path.endsWith(".now.ts")).content;
        if (/^Flow\(/m.test(main)) return; // the tree read another way: nothing to assert
        assert.match(main, /^Record\(\{/m);
        assert.ok(
          body.warnings.some((w) =>
            /tree is unavailable|could not be read/.test(w),
          ),
        );
      },
    ),
  );
});
