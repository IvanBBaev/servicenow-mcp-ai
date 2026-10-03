/**
 * P-27 — Flow, subflow, action and playbook Fluent emitters
 * (project/SDK-PARITY.md §5, P5).
 *
 * `servicenow_generate_fluent` reads the P-10…P-12 `explain_flow` tree of a
 * flow / subflow / custom action / playbook (`attachFlowTrees`) and this file
 * turns it into one `.now.ts`:
 *
 * - `Flow({…}, wfa.trigger(trigger.*, …), (params) => { … })`, `Subflow({…},
 *   (params) => { … })` and `Action({…}, (params) => { … })` with
 *   `wfa.action(action.core.*, …)` / `wfa.actionStep(actionStep.*, …)` steps
 *   (typed when the inputs match the SDK definition, else the untyped sys_id
 *   form), `wfa.flowLogic.*` logic (if / elseIf / else, forEach, tryCatch,
 *   doInParallel, doTheFollowing + until and the leaf blocks), `wfa.subflow(…)`
 *   calls, inputs / outputs / flow variables as column constructors,
 *   `FlowStage()` stages, and typed `wfa.dataPill(…, type)` for data pills;
 * - `PlaybookDefinition(config, { triggers }, { lanes })` with
 *   `wfa.playbook.lane(…)` / `wfa.playbook.activity(ActivityDefinitions.Core.*,
 *   …)` and `wfa.playbook.trigger(PlaybookTriggerTypes.*, …)`.
 *
 * Every construct it cannot express — spoke / custom actions outside
 * `action.core`, nested doInParallel, playbook Questionnaire activities,
 * variants, unknown logic / trigger / activity / column types, undecodable
 * step values, rows the tree does not represent — gets an explicit
 * `unsupported[]` entry and a `Record()` fallback for that node or row, placed
 * after the main call: never silent loss.
 *
 * P-29: the output is type-checked against the pinned @servicenow/sdk 4.12.2
 * (`npm run fluent:verify`, owner gate O-7); the action.core / actionStep input
 * tables come from `scripts/gen-fluent-actions.mjs`.
 * Output is deterministic: the tree is already ordered (order, then name) and
 * nothing here depends on time or locale. Secrets are replaced through the
 * P-26 hooks.
 */
import type { ArtifactType } from "../core/artifacts/registry.js";
import {
  explainFlow,
  type DecodedValues,
  type ExplainFlowKind,
  type ExplainFlowResult,
  type FlowStep,
  type FlowTrigger,
  type FlowVariable,
  type PdActivity,
  type PdTimer,
  type Stage,
  type StepInput,
} from "./explain-flow.js";
import type { FluentSource, FluentUnsupported } from "./fluent.js";
import {
  arr,
  code,
  call,
  lit,
  obj,
  oneLine,
  render,
  tsKey,
  tsString,
  type Expr,
  type Prop,
} from "./fluent-render.js";
import {
  SDK_ACTION_STEPS,
  SDK_CORE_ACTIONS,
  type CoreActionSpec,
} from "./fluent-sdk-actions.js";
import { snString } from "./shared.js";
import type { SnRecord } from "./table.js";

/** Registry types with a P-27 emitter, and the `explain_flow` kind they read. */
export const FLOW_TREE_KINDS: Readonly<Record<string, ExplainFlowKind>> = {
  flow: "flow",
  subflow: "subflow",
  flow_action: "action",
  playbook: "playbook",
};

/** The warning every P-27 run carries. */
export const FLOW_VERIFIED_NOTE =
  "The Flow / Subflow / Action / PlaybookDefinition shapes are type-checked against @servicenow/sdk 4.12.2 (npm run fluent:verify); instance behaviour (P-29 / O-5) is not verified: review before deploying.";

/**
 * What the flow emitter needs from the P-26 core (`fluent.ts`): passed in so
 * this file imports only types from it.
 */
export interface FlowEmitHooks {
  /** A unique `Now.ID` key, registered in the run's keys fragment. */
  key(base: string, sysId: string, table: string): string;
  /** Point a registered key at another table (the one the SDK writes). */
  retable(key: string, table: string): void;
  unsupported(entry: FluentUnsupported): void;
  /** Is this field / value a secret (descriptor, name pattern, redaction rules)? */
  isSecret(field: string, value: string): boolean;
  /** The placeholder property for a secret (counts it). */
  secretProp(key: string): Prop;
  /** Set, non-system fields of `rec` outside `consumed` (and the scope field), sorted. */
  unmapped(rec: SnRecord, consumed: readonly string[]): string[];
  /** A raw child row as `Record()`, through the P-26 child path. */
  childRecord(table: string, row: SnRecord, key: string): string;
  /** `Record({ $id, table, data })`. */
  recordCall(key: string, table: string, data: Prop[]): string;
  /** The provenance header of a generated file. */
  header(lines: string[]): string;
  file(path: string, content: string): void;
}

const ACTION_INSTANCE_V2 = "sys_hub_action_instance_v2";

/** Lower-case letters and digits only: the lookup form of a display name. */
const norm = (s: string | undefined): string =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** `{ normalised name or export name: [export name, spec] }` of an SDK table. */
function specIndex(
  table: Readonly<Record<string, CoreActionSpec>>,
): ReadonlyMap<string, readonly [string, CoreActionSpec]> {
  const m = new Map<string, readonly [string, CoreActionSpec]>();
  for (const [exp, spec] of Object.entries(table)) {
    m.set(norm(spec.name), [exp, spec]);
    if (!m.has(norm(exp))) m.set(norm(exp), [exp, spec]);
  }
  return m;
}

/** Core actions (`action.core.*`) and action steps (`actionStep.*`). */
const CORE_ACTIONS = specIndex(SDK_CORE_ACTIONS);
const CORE_STEPS = specIndex(SDK_ACTION_STEPS);

/** `wfa.dataPill()` FlowDataType by SDK input column kind (default `string`). */
const PILL_TYPES: Readonly<Record<string, string>> = {
  ApprovalRules: "approval_rules",
  Boolean: "boolean",
  Choice: "choice",
  Conditions: "conditions",
  DateTime: "glide_date_time",
  DocumentId: "document_id",
  Duration: "glide_duration",
  FieldName: "field_name",
  Html: "html",
  Integer: "integer",
  Records: "records",
  Reference: "reference",
  ScheduleDateTime: "schedule_date_time",
  SlushBucket: "slushbucket",
  String: "string",
  TableName: "table_name",
  TemplateValue: "template_value",
};

/** `wfa.dataPill()` FlowDataType by flow variable `internal_type`. */
const VARIABLE_PILL_TYPES: Readonly<Record<string, string>> = {
  boolean: "boolean",
  choice: "choice",
  decimal: "decimal",
  glide_date: "date",
  glide_date_time: "glide_date_time",
  integer: "integer",
  reference: "reference",
  string: "string",
};

type LogicRole =
  | "if"
  | "elseIf"
  | "else"
  | "forEach"
  | "try"
  | "catch"
  | "parallel"
  | "path"
  | "doUntil"
  | "leaf";

/** Flow logic by normalised logic-definition name. */
const LOGIC: Readonly<Record<string, { role: LogicRole; call?: string }>> = {
  if: { role: "if" },
  elseif: { role: "elseIf" },
  else: { role: "else" },
  foreach: { role: "forEach" },
  try: { role: "try" },
  catch: { role: "catch" },
  dothefollowinginparallel: { role: "parallel" },
  parallel: { role: "parallel" },
  path: { role: "path" },
  branch: { role: "path" },
  dothefollowinguntil: { role: "doUntil" },
  dountil: { role: "doUntil" },
  endflow: { role: "leaf", call: "endFlow" },
  exitloop: { role: "leaf", call: "exitLoop" },
  skipiteration: { role: "leaf", call: "skipIteration" },
  waitforaduration: { role: "leaf", call: "waitForADuration" },
  setflowvariables: { role: "leaf", call: "setFlowVariables" },
  assignsubflowoutputs: { role: "leaf", call: "assignSubflowOutputs" },
};

/** Flow triggers (`trigger.*`), by normalised trigger type / definition name. */
const TRIGGERS: Readonly<Record<string, string>> = {
  recordcreate: "record.created",
  created: "record.created",
  recordupdate: "record.updated",
  updated: "record.updated",
  recordcreateorupdate: "record.createdOrUpdated",
  createdorupdated: "record.createdOrUpdated",
  daily: "scheduled.daily",
  weekly: "scheduled.weekly",
  monthly: "scheduled.monthly",
  repeat: "scheduled.repeat",
  runonce: "scheduled.runOnce",
  inboundemail: "application.inboundEmail",
  servicecatalog: "application.serviceCatalog",
  slatask: "application.slaTask",
};

/** Column constructors (`@servicenow/sdk/core`) by variable `internal_type`. */
const COLUMNS: Readonly<Record<string, string>> = {
  boolean: "BooleanColumn",
  choice: "ChoiceColumn",
  decimal: "DecimalColumn",
  glide_date: "DateColumn",
  glide_date_time: "DateTimeColumn",
  integer: "IntegerColumn",
  reference: "ReferenceColumn",
  string: "StringColumn",
};

/** Core playbook activity definitions (`ActivityDefinitions.Core.*`). */
const ACTIVITIES: Readonly<Record<string, string>> = {
  instruction: "Instruction",
  form: "RecordForm",
  recordform: "RecordForm",
};

/** Playbook record triggers (`PlaybookTriggerTypes.*`), by normalised type / definition name. */
const PB_TRIGGERS: Readonly<Record<string, string>> = {
  recordcreate: "RecordCreate",
  created: "RecordCreate",
  recordupdate: "RecordUpdate",
  updated: "RecordUpdate",
  recordcreateorupdate: "RecordCreateOrUpdate",
  createdorupdated: "RecordCreateOrUpdate",
};

/** Root fields each kind represents (emitted, or reported as instance state). */
const ROOT_CONSUMED: Readonly<Record<ExplainFlowKind, readonly string[]>> = {
  flow: [
    "name",
    "internal_name",
    "description",
    "run_as",
    "run_with_roles",
    "type",
    "active",
    "status",
    "label_cache",
    "master_snapshot",
    "latest_snapshot",
  ],
  subflow: [
    "name",
    "internal_name",
    "description",
    "run_as",
    "run_with_roles",
    "type",
    "active",
    "status",
    "label_cache",
    "master_snapshot",
    "latest_snapshot",
  ],
  action: [
    "name",
    "internal_name",
    "description",
    "category",
    "access",
    "active",
  ],
  playbook: ["label", "name", "table", "description", "status", "active"],
  workflow: [],
};

/** Reference column of a synthesised step row, by step kind. */
const STEP_REF_FIELD: Readonly<Record<FlowStep["kind"], string>> = {
  action: "action_type",
  logic: "logic_definition",
  subflow: "subflow",
  step: "step_type",
};

const PAD = "    ";
const pad = (depth: number): string => PAD.repeat(depth);

/**
 * The name of a callback parameter: `_`-prefixed when the body never reads it,
 * so a project built with noUnusedParameters (now-sdk build) accepts it.
 */
const usedParam = (param: string, body: string): string =>
  !param || new RegExp(`\\b${param}\\b`).test(body) ? param : `_${param}`;

/** `(params) => ({…})`, the parameter named per {@link usedParam}. */
const arrowObj = (e: Expr, depth: number): Expr => {
  const text = render(e, depth);
  return code(`(${usedParam("params", text)}) => (${text})`);
};

/** `wfa.dataPill(…)` path for a pill, or undefined when its root is unknown. */
function pillPath(pill: string): string | undefined {
  const segs = pill.split(".").filter(Boolean);
  if (segs.length < 2) return undefined;
  const head = (segs[0] ?? "").toLowerCase();
  let root: string;
  if (/^trigger(_|$)/.test(head)) root = "params.trigger";
  else if (["flow_variables", "flow_variable", "flowvariables"].includes(head))
    root = "params.flowVariables";
  else if (["subflow_inputs", "action_inputs", "inputs"].includes(head))
    root = "params.inputs";
  else return undefined;
  return (
    root +
    segs
      .slice(1)
      .map((s) => (/^[A-Za-z_$][\w$]*$/.test(s) ? `.${s}` : `[${tsString(s)}]`))
      .join("")
  );
}

const TEMPLATE_ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  "`": "\\`",
  "${": "\\${",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/** The body of a template literal that is safe for any input. */
function templateText(s: string): string {
  return s.replace(
    // eslint-disable-next-line no-control-regex
    /\\|`|\$\{|[\u0000-\u001f\u007f\u2028\u2029]/g,
    (c) =>
      TEMPLATE_ESCAPES[c] ??
      `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** A value as text, for the secret check. */
function asText(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

const PILL_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Logic inputs a `wfa.flowLogic` call consumes itself (not reported as dropped). */
const LOGIC_CONSUMED: readonly string[] = [
  "condition",
  "items",
  "duration",
  "duration_type",
  "label",
];

/** `obj` with `key` set (replaced when present). */
function withProp(e: Expr, key: string, value: Expr): Expr {
  if (e.k !== "obj") return e;
  return obj([...e.props.filter((p) => p.key !== key), { key, value }]);
}

/**
 * `Duration({…})` for a glide_duration value (`1970-01-DD hh:mm:ss`);
 * undefined when the text is not of that form.
 */
function durationExpr(text: string): Expr | undefined {
  const m = /^1970-01-(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(text.trim());
  if (!m) return undefined;
  const parts: Prop[] = [];
  const add = (key: string, n: number) => {
    if (n > 0) parts.push({ key, value: lit(n) });
  };
  add("days", Number(m[1]) - 1);
  add("hours", Number(m[2]));
  add("minutes", Number(m[3]));
  add("seconds", Number(m[4]));
  if (!parts.length) return undefined;
  return call("Duration", obj(parts));
}

/** A column default coerced to its column's value type. */
function typedDefault(col: string, v: string): string | number | boolean {
  if (col === "BooleanColumn" && (v === "true" || v === "false")) {
    return v === "true";
  }
  if (col === "IntegerColumn" && /^-?\d+$/.test(v)) return Number(v);
  return v;
}

/** Is `s` exactly one `{{…}}` data pill? */
const isWholePill = (s: string): boolean => /^\{\{[^{}]+\}\}$/.test(s.trim());

/** Mutable state of one flow / playbook file. */
class FlowEmit {
  /** `@servicenow/sdk/automation` imports. */
  readonly automation = new Set<string>();
  /** `@servicenow/sdk/core` imports. */
  readonly core = new Set<string>();
  readonly notes: string[] = [];
  /** `Record()` fallbacks, emitted after the main call. */
  readonly fallbacks: string[] = [];
  /** Raw child rows by sys_id, and the ones the tree represented. */
  readonly rows = new Map<string, { table: string; row: SnRecord }>();
  readonly seen = new Set<string>();
  /** Open If / For Each / Do the following / Do in parallel blocks: the SDK accepts endFlow only inside one. */
  private endFlowScopes = 0;
  /** The table of each node key, for the `unsupported[]` entries of its values. */
  private readonly keyTables = new Map<string, string>();
  readonly rootId: string;

  constructor(
    readonly h: FlowEmitHooks,
    readonly t: ArtifactType,
    readonly src: FluentSource,
    readonly key: string,
    readonly tree: ExplainFlowResult,
  ) {
    this.rootId = snString(src.record!.sys_id);
    for (const child of src.children ?? []) {
      if (child.redacted || child.error !== undefined || child.reason) {
        h.unsupported({
          kind: "child",
          table: child.table,
          key,
          sys_id: this.rootId,
          reason: `Child table not emitted: ${child.reason ?? child.error ?? "redacted"}`,
        });
        continue;
      }
      if (child.truncated) {
        h.unsupported({
          kind: "child",
          table: child.table,
          key,
          sys_id: this.rootId,
          reason: `Only the first ${child.count} child rows were read and emitted.`,
        });
      }
      for (const row of child.records) {
        const id = snString(row.sys_id);
        if (id && !this.rows.has(id)) {
          this.rows.set(id, { table: child.table, row });
        }
      }
    }
  }

  /** A node key under this file's key. */
  nodeKey(kind: string, sysId: string, table: string): string {
    const k = this.h.key(
      `${this.key}__${kind}_${
        sysId
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .slice(0, 8) || "node"
      }`,
      sysId,
      table,
    );
    this.keyTables.set(k, table);
    return k;
  }

  idProp(k: string): Prop {
    return { key: "$id", value: code(`Now.ID[${tsString(k)}]`) };
  }

  /** A field value as an expression: data pills become `wfa.dataPill(…)`. */
  value(v: unknown, field: string, nodeKey: string, sysId: string): Expr {
    if (typeof v === "string") return this.stringValue(v, nodeKey, sysId);
    if (typeof v === "number" || typeof v === "boolean") return lit(v);
    if (v === null || v === undefined) return code("null");
    if (Array.isArray(v)) {
      return arr(v.map((x) => this.value(x, field, nodeKey, sysId)));
    }
    if (typeof v === "object") {
      return obj(
        Object.entries(v as Record<string, unknown>).map(([k, x]) =>
          this.prop(k, x, nodeKey, sysId),
        ),
      );
    }
    return code("null");
  }

  /** One input property, with the secret check. */
  prop(name: string, v: unknown, nodeKey: string, sysId: string): Prop {
    if (this.h.isSecret(name, asText(v))) return this.h.secretProp(name);
    return { key: name, value: this.value(v, name, nodeKey, sysId) };
  }

  /** The `wfa.dataPill()` type of a pill path: a known variable / input's, else `fallback`. */
  pillType(path: string, fallback: string): string {
    const m = /^params\.(flowVariables|inputs)\.([A-Za-z_$][\w$]*)$/.exec(path);
    if (!m) return fallback;
    const list =
      m[1] === "flowVariables" ? this.tree.variables : this.tree.inputs;
    const v = list?.find((x) => x.element === m[2]);
    return (v?.type && VARIABLE_PILL_TYPES[v.type]) || fallback;
  }

  /**
   * A string with data pills: a whole pill is `wfa.dataPill(path, type)`,
   * embedded pills become a template literal.
   */
  stringValue(
    s: string,
    nodeKey: string,
    sysId: string,
    type = "string",
  ): Expr {
    const pills = [...s.matchAll(PILL_RE)];
    if (!pills.length) return lit(s);
    const whole = pills.length === 1 && pills[0]?.[0] === s;
    let out = "";
    let last = 0;
    for (const m of pills) {
      const inner = m[1] ?? "";
      const path = pillPath(inner);
      out += templateText(s.slice(last, m.index));
      if (path) {
        this.automation.add("wfa");
        const pill = `wfa.dataPill(${path}, ${tsString(this.pillType(path, whole ? type : "string"))})`;
        if (whole) return code(pill);
        out += `\${${pill}}`;
      } else {
        this.h.unsupported({
          kind: "field",
          table: this.keyTables.get(nodeKey) ?? this.t.table,
          key: nodeKey,
          sys_id: sysId,
          reason: `Data pill {{${inner}}} has no known wfa.dataPill() root; kept as its {{…}} text.`,
        });
        out += templateText(m[0]);
      }
      last = m.index + m[0].length;
    }
    out += templateText(s.slice(last));
    return code(`\`${out}\``);
  }

  /** The raw `[name, value]` inputs of decoded step values; undefined = not decodable. */
  rawInputs(
    values: DecodedValues | undefined,
  ): Array<[string, unknown]> | undefined {
    if (!values || values.format === "empty") return [];
    if (!values.decoded || values.inputsOmitted) return undefined;
    if (values.inputs) {
      return values.inputs.map((i: StepInput) => [i.name, i.value ?? ""]);
    }
    const v = values.value;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.entries(v as Record<string, unknown>);
    }
    if (v === undefined || v === null || v === "") return [];
    return [["values", v]];
  }

  /** The input properties of decoded step values; undefined = not decodable. */
  inputs(
    values: DecodedValues | undefined,
    nodeKey: string,
    sysId: string,
  ): Prop[] | undefined {
    return this.rawInputs(values)?.map(([k, v]) =>
      this.prop(k, v, nodeKey, sysId),
    );
  }

  /** A typed action input, coerced to its SDK column kind. */
  typedProp(
    name: string,
    kind: string,
    v: unknown,
    nodeKey: string,
    sysId: string,
  ): Prop {
    if (this.h.isSecret(name, asText(v))) return this.h.secretProp(name);
    if (typeof v !== "string") {
      return { key: name, value: this.value(v, name, nodeKey, sysId) };
    }
    const t = v.trim();
    let value: Expr;
    if (kind === "Boolean" && (t === "true" || t === "false")) {
      value = lit(t === "true");
    } else if (kind === "Integer" && /^-?\d+$/.test(t)) {
      value = lit(Number(t));
    } else if (kind === "TemplateValue" && !isWholePill(v)) {
      value = this.templateValue(v, nodeKey, sysId) ?? lit(v);
    } else {
      value = this.stringValue(v, nodeKey, sysId, PILL_TYPES[kind] ?? "string");
    }
    return { key: name, value };
  }

  /** `a=b^c=d` as `TemplateValue({ a: …, c: … })`; undefined when not of that form. */
  templateValue(s: string, nodeKey: string, sysId: string): Expr | undefined {
    const props: Prop[] = [];
    for (const part of s.split("^")) {
      if (part === "" || part === "EQ") continue;
      const eq = part.indexOf("=");
      if (eq <= 0) return undefined;
      const field = part.slice(0, eq);
      if (!/^[a-z_][a-z0-9_]*$/i.test(field)) return undefined;
      props.push(this.prop(field, part.slice(eq + 1), nodeKey, sysId));
    }
    if (!props.length) return undefined;
    return call("TemplateValue", obj(props));
  }

  // --- fallbacks ---------------------------------------------------------------

  /** A tree node as `Record()`: its raw row when read, else synthesised from the tree. */
  fallbackRow(
    table: string,
    sysId: string,
    nodeKey: string,
    synth: () => Prop[],
    label: string,
  ): void {
    this.seen.add(sysId);
    this.core.add("Record");
    const raw = this.rows.get(sysId);
    const call = raw
      ? this.h.childRecord(raw.table, raw.row, nodeKey)
      : this.h.recordCall(nodeKey, table, synth());
    this.fallbacks.push(
      `// unsupported in ${this.key}: ${oneLine(label)}\n${call}`,
    );
  }

  /** A step and its whole subtree as `Record()` rows, with `unsupported[]` entries. */
  fallbackStep(
    s: FlowStep,
    reason: string,
    lines: string[],
    depth: number,
    k?: string,
  ): void {
    const top = k ?? this.nodeKey(s.kind, s.sys_id, s.source);
    lines.push(
      `${pad(depth)}// step ${s.number} '${oneLine(s.name)}': emitted as Record() below (${oneLine(reason)})`,
    );
    const walk = (n: FlowStep, nk: string, why: string) => {
      this.h.unsupported({
        kind: "api",
        table: n.source,
        key: nk,
        sys_id: n.sys_id,
        reason: why,
      });
      this.fallbackRow(
        n.source,
        n.sys_id,
        nk,
        () => this.synthStep(n, nk),
        `step ${n.number} '${n.name}': ${why}`,
      );
      for (const c of n.children) {
        walk(
          c,
          this.nodeKey(c.kind, c.sys_id, c.source),
          `Inside unsupported step ${s.number}; emitted as Record().`,
        );
      }
    };
    walk(s, top, reason);
  }

  /** `Record()` data for a step the raw rows do not hold. */
  synthStep(s: FlowStep, nk: string): Prop[] {
    const parentField = s.kind === "step" ? "action" : "flow";
    const data: Prop[] = [
      {
        key: parentField,
        value: code(
          `Now.ref(${tsString(this.t.table)}, ${tsString(this.rootId.toLowerCase())})`,
        ),
      },
      { key: "order", value: lit(String(s.order)) },
    ];
    if (s.ui_id) data.push({ key: "ui_id", value: lit(s.ui_id) });
    if (s.parent_ui_id) {
      data.push({ key: "parent_ui_id", value: lit(s.parent_ui_id) });
    }
    if (s.ref)
      data.push({ key: STEP_REF_FIELD[s.kind], value: lit(s.ref.sys_id) });
    if (s.comment) data.push({ key: "comment", value: lit(s.comment) });
    const v = s.values;
    if (v && v.format !== "empty") {
      let text: string;
      if (v.raw !== undefined) text = v.raw;
      else if (v.inputs) {
        text = JSON.stringify(
          v.inputs.map((i) => ({
            name: i.name,
            value: this.h.isSecret(i.name, asText(i.value))
              ? this.secretText(i.name)
              : i.value,
          })),
        );
      } else text = JSON.stringify(v.value ?? null);
      data.push({ key: "values", value: lit(text) });
    }
    void nk;
    return data.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  secretText(name: string): string {
    const p = this.h.secretProp(name);
    return p.value.k === "lit" ? String(p.value.v) : "";
  }

  /** `Record()` data from a flat tree object (variables, stages, triggers, variants). */
  synthFlat(
    parentField: string,
    fields: Record<string, unknown>,
    skip: readonly string[] = ["sys_id"],
    parent: readonly [table: string, sysId: string] = [
      this.t.table,
      this.rootId,
    ],
  ): Prop[] {
    const data: Prop[] = [
      {
        key: parentField,
        value: code(
          `Now.ref(${tsString(parent[0])}, ${tsString(parent[1].toLowerCase())})`,
        ),
      },
    ];
    for (const [k, v] of Object.entries(fields)) {
      if (skip.includes(k) || v === undefined || v === "") continue;
      const text = typeof v === "string" ? v : JSON.stringify(v);
      data.push(
        this.h.isSecret(k, text)
          ? this.h.secretProp(k)
          : {
              key: k,
              value: lit(
                typeof v === "object" ? text : (v as string | number | boolean),
              ),
            },
      );
    }
    return data.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  // --- variables, stages -----------------------------------------------------------

  /**
   * `{ name: XColumn({…}) }` for inputs / outputs / variables; unknown types
   * fall back.
   */
  columns(
    list: FlowVariable[] | undefined,
    table: string,
    what: string,
  ): Expr | undefined {
    if (!list?.length) return undefined;
    const props: Prop[] = [];
    for (const v of list) {
      this.seen.add(v.sys_id);
      const col = v.type ? COLUMNS[v.type] : undefined;
      const k = this.nodeKey(what, v.sys_id, table);
      if (!col) {
        const reason = `${what} '${v.element}': ${v.type ? `type '${v.type}' has no column constructor mapped` : "no type"}; emitted as Record().`;
        this.h.unsupported({
          kind: "field",
          table,
          key: k,
          sys_id: v.sys_id,
          field: v.element,
          reason,
        });
        this.fallbackRow(
          table,
          v.sys_id,
          k,
          () => this.synthFlat("model", { ...v }),
          reason,
        );
        continue;
      }
      const refTable =
        col === "ReferenceColumn"
          ? v.reference || asText(this.rows.get(v.sys_id)?.row.reference)
          : "";
      if (col === "ReferenceColumn" && !refTable) {
        const reason = `${what} '${v.element}': reference column without a reference table; emitted as Record().`;
        this.h.unsupported({
          kind: "field",
          table,
          key: k,
          sys_id: v.sys_id,
          field: v.element,
          reason,
        });
        this.fallbackRow(
          table,
          v.sys_id,
          k,
          () => this.synthFlat("model", { ...v }),
          reason,
        );
        continue;
      }
      this.core.add(col);
      const args: Prop[] = [];
      if (refTable) {
        args.push({ key: "referenceTable", value: lit(refTable) });
      }
      if (v.label) args.push({ key: "label", value: lit(v.label) });
      if (v.mandatory !== undefined) {
        args.push({ key: "mandatory", value: lit(v.mandatory) });
      }
      if (v.default !== undefined && v.default !== "") {
        args.push(
          this.h.isSecret(v.element, v.default)
            ? this.h.secretProp("default")
            : { key: "default", value: lit(typedDefault(col, v.default)) },
        );
      }
      props.push({
        key: v.element,
        value: call(col, obj(args)),
      });
    }
    return props.length ? obj(props) : undefined;
  }

  /** `{ key: FlowStage({…}) }` for the flow's stages. */
  stages(list: Stage[] | undefined): Expr | undefined {
    if (!list?.length) return undefined;
    this.automation.add("FlowStage");
    return obj(
      list.map((s) => {
        this.seen.add(s.sys_id);
        this.nodeKey("stage", s.sys_id, "sys_hub_flow_stage");
        const value = s.value || s.label;
        const d = s.duration ? durationExpr(s.duration) : undefined;
        if (s.duration && !d) {
          this.h.unsupported({
            kind: "field",
            table: "sys_hub_flow_stage",
            sys_id: s.sys_id,
            field: "duration",
            reason: `Stage '${s.label}': duration '${s.duration}' is not an explicit duration; not emitted.`,
          });
        }
        return {
          key: value,
          value: call(
            "FlowStage",
            obj([
              { key: "label", value: lit(s.label) },
              { key: "value", value: lit(value) },
              ...(d ? [{ key: "duration", value: d }] : []),
            ]),
          ),
        };
      }),
    );
  }

  // --- steps -------------------------------------------------------------------------

  /** Statements for a list of sibling steps. */
  steps(list: FlowStep[], depth: number, inParallel: boolean): string[] {
    const lines: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      this.seen.add(s.sys_id);
      if (s.childrenOmitted) {
        this.h.unsupported({
          kind: "child",
          table: s.source,
          sys_id: s.sys_id,
          reason: `Step ${s.number}: ${s.childrenOmitted} nested step(s) past the tree depth cap are not in the tree.`,
        });
      }
      if (s.comment) lines.push(`${pad(depth)}// ${oneLine(s.comment)}`);
      if (s.kind === "action" || s.kind === "step") {
        this.action(s, lines, depth);
      } else if (s.kind === "subflow") {
        this.subflow(s, lines, depth);
      } else {
        i = this.logic(list, i, lines, depth, inParallel);
      }
    }
    return lines;
  }

  action(s: FlowStep, lines: string[], depth: number): void {
    const name = s.ref?.name ?? s.name;
    const hit = (s.kind === "step" ? CORE_STEPS : CORE_ACTIONS).get(norm(name));
    const k = this.nodeKey(s.kind, s.sys_id, s.source);
    if (!hit) {
      return this.fallbackStep(
        s,
        s.kind === "step"
          ? `action step type '${name}' has no actionStep mapping`
          : `'${name}' is a spoke or custom action outside action.core`,
        lines,
        depth,
        k,
      );
    }
    const raw = this.rawInputs(s.values);
    if (!raw) {
      return this.fallbackStep(s, this.undecoded(s.values), lines, depth, k);
    }
    if (s.children.length) {
      return this.fallbackStep(
        s,
        "an action step with nested steps",
        lines,
        depth,
        k,
      );
    }
    const [exp, spec] = hit;
    // now-sdk build resolves an action step by its built-in definition sys_id;
    // a step whose definition is a copy under the same name has no Fluent form.
    const defId = s.ref?.sys_id.toLowerCase();
    if (s.kind === "step" && defId && defId !== spec.sysId) {
      return this.fallbackStep(
        s,
        `step definition ${defId} is not the built-in '${spec.name}' (${spec.sysId})`,
        lines,
        depth,
        k,
      );
    }
    // now-sdk build writes wfa.action as sys_hub_action_instance_v2; a key on
    // the legacy table would make it mint a new sys_id (P-29 oracle).
    if (s.kind !== "step") this.h.retable(k, ACTION_INSTANCE_V2);
    const fn = s.kind === "step" ? "actionStep" : "action";
    const ref = s.kind === "step" ? `actionStep.${exp}` : `action.core.${exp}`;
    const unknown = raw
      .map(([n]) => n)
      .filter((n) => !spec.inputs[n] || spec.inputs[n]?.hidden);
    const missing = Object.entries(spec.inputs)
      .filter(
        ([n, i]) => i.mandatory && !i.hidden && !raw.some(([r]) => r === n),
      )
      .map(([n]) => n);
    this.automation.add("wfa");
    const cfg = render(obj([this.idProp(k)]), depth);
    if (!unknown.length && !missing.length) {
      this.automation.add(fn);
      const props = raw.map(([n, v]) =>
        this.typedProp(n, spec.inputs[n]?.kind ?? "String", v, k, s.sys_id),
      );
      lines.push(
        `${pad(depth)}wfa.${fn}(${ref}, ${cfg}, ${render(obj(props), depth)})`,
      );
      return;
    }
    const why = [
      ...(unknown.length
        ? [`input(s) ${unknown.join(", ")} not in ${ref}`]
        : []),
      ...(missing.length ? [`mandatory ${missing.join(", ")} not set`] : []),
    ].join("; ");
    const props = raw.map(([n, v]) => this.prop(n, v, k, s.sys_id));
    // The untyped forms: an action by its definition sys_id, a step by its
    // built-in name (now-sdk build resolves only those for actionStep).
    const target =
      s.kind === "step"
        ? spec.name
        : (s.ref?.sys_id ?? spec.sysId).toLowerCase();
    lines.push(
      `${pad(depth)}// ${ref} by ${s.kind === "step" ? "name" : "sys_id"} (untyped inputs): ${oneLine(why)}`,
      `${pad(depth)}wfa.${fn}(${tsString(target)}, ${cfg}, ${render(obj(props), depth)})`,
    );
  }

  undecoded(v: DecodedValues | undefined): string {
    if (v?.inputsOmitted) {
      return `${v.inputsOmitted} input(s) past the per-step cap are not in the tree`;
    }
    return `its values could not be decoded${v?.reason ? ` (${v.reason})` : ""}`;
  }

  subflow(s: FlowStep, lines: string[], depth: number): void {
    const k = this.nodeKey("subflow", s.sys_id, s.source);
    const inputs = this.inputs(s.values, k, s.sys_id);
    if (!s.ref || !inputs || s.children.length) {
      return this.fallbackStep(
        s,
        !s.ref
          ? "the called subflow is not resolved"
          : !inputs
            ? this.undecoded(s.values)
            : "a subflow call with nested steps",
        lines,
        depth,
        k,
      );
    }
    this.automation.add("wfa");
    lines.push(
      `${pad(depth)}// TODO: pass the imported Subflow() '${oneLine(s.ref.name ?? s.ref.sys_id)}' instead of its sys_id for typed inputs`,
      `${pad(depth)}wfa.subflow(${tsString(s.ref.sys_id.toLowerCase())}, ${render(obj([this.idProp(k)]), depth)}, ${render(obj(inputs), depth)})`,
    );
  }

  /**
   * The config of a logic block: `$id` plus the decoded inputs named in
   * `keep`; any other input is reported. Undefined when not decodable.
   */
  logicConfig(
    s: FlowStep,
    k: string,
    keep: readonly string[] = [],
  ): { cfg: Expr; raw: Map<string, unknown> } | undefined {
    const raw = this.rawInputs(s.values);
    if (!raw) return undefined;
    const props: Prop[] = [this.idProp(k)];
    const all = new Map(raw);
    for (const [n, v] of raw) {
      if (keep.includes(n)) {
        props.push(this.prop(n, v, k, s.sys_id));
      } else if (!LOGIC_CONSUMED.includes(n) && asText(v) !== "") {
        this.h.unsupported({
          kind: "field",
          table: s.source,
          key: k,
          sys_id: s.sys_id,
          field: n,
          reason: `Logic input '${n}' has no wfa.flowLogic config property; not emitted.`,
        });
      }
    }
    return { cfg: obj(props), raw: all };
  }

  /** A block body: `() => {…}` (or with a parameter). */
  block(
    children: FlowStep[],
    depth: number,
    inParallel: boolean,
    param = "",
    tail: string[] = [],
    endFlowScope = true,
  ): string {
    if (endFlowScope) this.endFlowScopes++;
    let body: string[];
    try {
      body = [
        ...this.steps(children, depth + 1, inParallel),
        ...tail.map((t) => `${pad(depth + 1)}${t}`),
      ];
    } finally {
      if (endFlowScope) this.endFlowScopes--;
    }
    const arg = usedParam(param, body.join("\n"));
    return body.length
      ? `(${arg}) => {\n${body.join("\n")}\n${pad(depth)}}`
      : `(${arg}) => {}`;
  }

  /** A condition value of a logic input (pills kept), or undefined when empty. */
  condition(v: unknown, k: string, sysId: string): Expr | undefined {
    const t = asText(v);
    return t ? this.stringValue(t, k, sysId) : undefined;
  }

  /** One logic step (and the siblings it chains); returns the last index consumed. */
  logic(
    list: FlowStep[],
    i: number,
    lines: string[],
    depth: number,
    inParallel: boolean,
  ): number {
    const s = list[i]!;
    const spec = LOGIC[norm(s.ref?.name ?? s.name)];
    const k = this.nodeKey("logic", s.sys_id, s.source);
    const unsupported = (why: string): number => {
      this.fallbackStep(s, why, lines, depth, k);
      return i;
    };
    if (!spec) {
      return unsupported(
        `logic '${s.ref?.name ?? s.name}' has no wfa.flowLogic mapping`,
      );
    }
    const keep =
      spec.role === "if" || spec.role === "elseIf"
        ? ["label"]
        : spec.role === "doUntil"
          ? ["label"]
          : [];
    const lc = this.logicConfig(s, k, keep);
    if (!lc) return unsupported(this.undecoded(s.values));
    const { raw } = lc;
    let cfg = lc.cfg;
    const p = pad(depth);
    this.automation.add("wfa");
    switch (spec.role) {
      case "if": {
        const cond = this.condition(raw.get("condition"), k, s.sys_id);
        if (!cond) return unsupported("an If without a condition");
        cfg = withProp(cfg, "condition", cond);
        lines.push(
          `${p}wfa.flowLogic.if(${render(cfg, depth)}, ${this.block(s.children, depth, inParallel)})`,
        );
        let j = i + 1;
        for (; j < list.length; j++) {
          const n = list[j]!;
          const role = LOGIC[norm(n.ref?.name ?? n.name)]?.role;
          if (role !== "elseIf" && role !== "else") break;
          const nk = this.nodeKey("logic", n.sys_id, n.source);
          const nl = this.logicConfig(
            n,
            nk,
            role === "elseIf" ? ["label"] : [],
          );
          if (!nl) break;
          let ncfg = nl.cfg;
          if (role === "elseIf") {
            const nc = this.condition(nl.raw.get("condition"), nk, n.sys_id);
            if (!nc) break;
            ncfg = withProp(ncfg, "condition", nc);
          }
          this.seen.add(n.sys_id);
          if (n.comment) lines.push(`${p}// ${oneLine(n.comment)}`);
          lines.push(
            `${p}wfa.flowLogic.${role}(${render(ncfg, depth)}, ${this.block(n.children, depth, inParallel)})`,
          );
          if (role === "else") {
            j++;
            break;
          }
        }
        return j - 1;
      }
      case "elseIf":
      case "else":
        return unsupported(`'${s.name}' without a preceding If`);
      case "catch":
        return unsupported("'Catch' without a preceding Try");
      case "path":
        return unsupported(
          "a parallel path outside 'Do the following in parallel'",
        );
      case "forEach": {
        const items = asText(raw.get("items"));
        if (!items) return unsupported("a For Each without items");
        const itemsExpr = this.stringValue(items, k, s.sys_id, "records");
        lines.push(
          `${p}wfa.flowLogic.forEach(${render(itemsExpr, depth)}, ${render(cfg, depth)}, ${this.block(s.children, depth, inParallel, "item")})`,
        );
        return i;
      }
      case "doUntil": {
        const cond = this.condition(raw.get("condition"), k, s.sys_id);
        if (!cond)
          return unsupported("a Do the following until without a condition");
        lines.push(
          `${p}wfa.flowLogic.doTheFollowing(${render(cfg, depth)}, ${this.block(s.children, depth, inParallel, "", [`wfa.flowLogic.until(${render(cond, depth + 1)})`])})`,
        );
        return i;
      }
      case "try": {
        const next = list[i + 1];
        const hasCatch =
          next !== undefined &&
          LOGIC[norm(next.ref?.name ?? next.name)]?.role === "catch";
        let catchBlock = "() => {}";
        if (hasCatch) {
          this.seen.add(next.sys_id);
          // The Catch block's own key is registered so its sys_id is traceable.
          this.nodeKey("logic", next.sys_id, next.source);
          catchBlock = this.block(
            next.children,
            depth + 1,
            inParallel,
            "",
            [],
            false,
          );
        }
        lines.push(
          `${p}wfa.flowLogic.tryCatch(${render(cfg, depth)}, {\n${p}${PAD}try: ${this.block(s.children, depth + 1, inParallel, "", [], false)},\n${p}${PAD}catch: ${catchBlock},\n${p}})`,
        );
        return hasCatch ? i + 1 : i;
      }
      case "parallel": {
        if (inParallel)
          return unsupported("nested doInParallel is not supported");
        const branches = s.children.map((c) => {
          const role = LOGIC[norm(c.ref?.name ?? c.name)]?.role;
          if (role === "path") {
            this.seen.add(c.sys_id);
            this.nodeKey("logic", c.sys_id, c.source);
            return this.block(c.children, depth + 1, true);
          }
          return this.block([c], depth + 1, true);
        });
        const args = [render(cfg, depth + 1), ...branches].map(
          (a) => `${p}${PAD}${a},`,
        );
        lines.push(
          `${p}wfa.flowLogic.doInParallel(\n${args.join("\n")}\n${p})`,
        );
        return i;
      }
      case "leaf": {
        if (s.children.length) {
          return unsupported(`'${s.name}' with nested steps`);
        }
        if (spec.call === "endFlow" && !this.endFlowScopes) {
          return unsupported(
            "End Flow outside an If / For Each / Do the following / Do in parallel block (the SDK rejects wfa.flowLogic.endFlow there)",
          );
        }
        if (spec.call === "waitForADuration") {
          const d = durationExpr(asText(raw.get("duration")));
          if (!d)
            return unsupported(
              "a wait duration that is not an explicit duration",
            );
          cfg = withProp(
            withProp(cfg, "durationType", lit("explicit_duration")),
            "duration",
            d,
          );
        } else if (
          spec.call === "setFlowVariables" ||
          spec.call === "assignSubflowOutputs"
        ) {
          const target =
            spec.call === "setFlowVariables"
              ? "params.flowVariables"
              : "params.outputs";
          const values = [...raw]
            .filter(([n]) => !LOGIC_CONSUMED.includes(n))
            .map(([n, v]) => this.prop(n, v, k, s.sys_id));
          lines.push(
            `${p}wfa.flowLogic.${spec.call}(${render(obj([this.idProp(k)]), depth)}, ${target}, ${render(obj(values), depth)})`,
          );
          return i;
        }
        lines.push(`${p}wfa.flowLogic.${spec.call}(${render(cfg, depth)})`);
        return i;
      }
    }
  }

  // --- trigger -------------------------------------------------------------------------

  trigger(tr: FlowTrigger | null | undefined): string {
    if (!tr) {
      this.notes.push("The flow has no trigger in the instance tree.");
      return "undefined /* no trigger */";
    }
    this.seen.add(tr.sys_id);
    const table = tr.source || "sys_hub_trigger_instance";
    const k = this.nodeKey("trigger", tr.sys_id, table);
    const path =
      TRIGGERS[norm(tr.type)] ??
      TRIGGERS[norm(tr.definition?.type)] ??
      TRIGGERS[norm(tr.definition?.name)];
    const inputs = this.inputs(tr.values, k, tr.sys_id);
    if (!path || !inputs) {
      const label = tr.definition?.name ?? tr.type ?? tr.sys_id;
      const reason = !path
        ? `Trigger '${label}' has no trigger.* mapping; emitted as Record().`
        : `Trigger '${label}': ${this.undecoded(tr.values)}; emitted as Record().`;
      this.h.unsupported({
        kind: "api",
        table,
        key: k,
        sys_id: tr.sys_id,
        reason,
      });
      this.fallbackRow(
        table,
        tr.sys_id,
        k,
        () =>
          this.synthFlat("flow", {
            trigger_definition: tr.definition?.sys_id,
            trigger_type: tr.type,
            table: tr.table,
            condition: tr.condition,
          }),
        reason,
      );
      return "undefined /* trigger emitted as Record() below */";
    }
    this.automation.add("wfa");
    this.automation.add("trigger");
    const cfg: Prop[] = [];
    if (tr.table) cfg.push({ key: "table", value: lit(tr.table) });
    if (tr.condition) {
      cfg.push({
        key: "condition",
        value: this.stringValue(tr.condition, k, tr.sys_id),
      });
    }
    for (const p of inputs) {
      if (!cfg.some((c) => c.key === p.key)) cfg.push(p);
    }
    return `wfa.trigger(trigger.${path}, ${render(obj([this.idProp(k)]), 1)}, ${render(obj(cfg), 1)})`;
  }

  // --- the whole file ----------------------------------------------------------------

  /** Flow / Subflow / Action. */
  flowLike(kind: ExplainFlowKind): string {
    const tr = this.tree;
    const head = kind === "action" ? tr.action : tr.flow;
    const api = this.t.sdkApi;
    this.automation.add(api);
    const props: Prop[] = [
      this.idProp(this.key),
      { key: "name", value: lit(head?.name ?? this.src.name ?? "") },
    ];
    if (head?.internal_name) {
      props.push({ key: "internalName", value: lit(head.internal_name) });
    }
    if (head?.description) {
      props.push({ key: "description", value: lit(head.description) });
    }
    if (kind === "action") {
      const a = tr.action;
      if (a?.category) props.push({ key: "category", value: lit(a.category) });
      if (a?.access) props.push({ key: "access", value: lit(a.access) });
    } else {
      const f = tr.flow;
      if (f?.run_as) props.push({ key: "runAs", value: lit(f.run_as) });
      if (f?.run_with_roles.length) {
        props.push({
          key: "runWithRoles",
          value: arr(
            f.run_with_roles.map((r) =>
              r.name
                ? lit(r.name)
                : code(
                    `Now.ref('sys_user_role', ${tsString(r.sys_id.toLowerCase())})`,
                  ),
            ),
          ),
        });
      }
    }
    const ioTables: readonly [string, string] =
      kind === "action"
        ? ["sys_hub_action_input", "sys_hub_action_output"]
        : ["sys_hub_flow_input", "sys_hub_flow_output"];
    if (kind !== "flow") {
      const ins = this.columns(tr.inputs, ioTables[0], "input");
      if (ins) props.push({ key: "inputs", value: ins });
      const outs = this.columns(tr.outputs, ioTables[1], "output");
      if (outs) props.push({ key: "outputs", value: outs });
      // Action() requires both, even when empty.
      if (kind === "action") {
        if (!ins) props.push({ key: "inputs", value: obj([]) });
        if (!outs) props.push({ key: "outputs", value: obj([]) });
      }
    } else {
      for (const [list, table, what] of [
        [tr.inputs, ioTables[0], "input"],
        [tr.outputs, ioTables[1], "output"],
      ] as const) {
        for (const v of list ?? []) {
          this.seen.add(v.sys_id);
          const k = this.nodeKey(what, v.sys_id, table);
          const reason = `A flow has no ${what}s in Fluent; '${v.element}' emitted as Record().`;
          this.h.unsupported({
            kind: "field",
            table,
            key: k,
            sys_id: v.sys_id,
            field: v.element,
            reason,
          });
          this.fallbackRow(
            table,
            v.sys_id,
            k,
            () => this.synthFlat("model", { ...v }),
            reason,
          );
        }
      }
    }
    if (kind !== "action") {
      const vars = this.columns(
        tr.variables,
        "sys_hub_flow_variable",
        "variable",
      );
      if (vars) props.push({ key: "flowVariables", value: vars });
      const st = this.stages(tr.stages);
      if (st) props.push({ key: "stages", value: st });
    }
    const state = [
      tr.flow?.status ? `status ${tr.flow.status}` : "",
      head?.active !== undefined ? `active ${head.active}` : "",
    ].filter(Boolean);
    if (state.length) {
      this.notes.push(`Instance state (not emitted): ${state.join(", ")}.`);
    }

    const args = [`${PAD}${render(obj(props), 1)},`];
    if (kind === "flow") args.push(`${PAD}${this.trigger(tr.trigger)},`);
    const body = this.steps(tr.steps ?? [], 2, false);
    const params = usedParam("params", body.join("\n"));
    args.push(
      body.length
        ? `${PAD}(${params}) => {\n${body.join("\n")}\n${PAD}},`
        : `${PAD}(${params}) => {},`,
    );
    return `${api}(\n${args.join("\n")}\n)`;
  }

  /** PlaybookDefinition(config, { triggers }, { lanes }). */
  playbook(): string {
    const tr = this.tree;
    const head = tr.playbook;
    this.automation.add("PlaybookDefinition");
    this.automation.add("wfa");
    const props: Prop[] = [
      this.idProp(this.key),
      { key: "label", value: lit(head?.name ?? this.src.name ?? "") },
    ];
    if (head?.internal_name) {
      props.push({ key: "name", value: lit(head.internal_name) });
    }
    if (head?.table) props.push({ key: "parentTable", value: lit(head.table) });
    if (head?.description) {
      props.push({ key: "description", value: lit(head.description) });
    }
    const ins = this.columns(tr.inputs, "sys_pd_process_input", "input");
    if (ins) props.push({ key: "inputs", value: ins });
    const outs = this.columns(tr.outputs, "sys_pd_process_output", "output");
    if (outs) props.push({ key: "outputs", value: outs });
    const triggers: Expr[] = [];
    for (const g of tr.triggers ?? []) {
      this.seen.add(g.sys_id);
      const k = this.nodeKey("trigger", g.sys_id, "sys_pd_trigger_instance");
      const type =
        PB_TRIGGERS[norm(g.type)] ?? PB_TRIGGERS[norm(g.definition?.name)];
      if (!type || !g.table) {
        const reason = `Playbook trigger '${g.name ?? g.definition?.name ?? g.sys_id}': ${type ? "no table" : `type '${g.type ?? g.definition?.name ?? "none"}' has no PlaybookTriggerTypes record trigger`}; emitted as Record().`;
        this.h.unsupported({
          kind: "api",
          table: "sys_pd_trigger_instance",
          key: k,
          sys_id: g.sys_id,
          reason,
        });
        this.fallbackRow(
          "sys_pd_trigger_instance",
          g.sys_id,
          k,
          () =>
            this.synthFlat("process_definition", {
              name: g.name,
              type: g.type,
              table: g.table,
              condition: g.condition,
              trigger_definition: g.definition?.sys_id,
            }),
          reason,
        );
        continue;
      }
      this.automation.add("PlaybookTriggerTypes");
      const cfg: Prop[] = [this.idProp(k)];
      if (g.name) cfg.push({ key: "label", value: lit(g.name) });
      const inputs: Prop[] = [{ key: "table", value: lit(g.table) }];
      if (g.condition) {
        inputs.push({ key: "condition", value: lit(g.condition) });
      }
      triggers.push(
        code(
          `wfa.playbook.trigger(PlaybookTriggerTypes.${type}, ${render(obj(cfg), 3)}, ${render(obj(inputs), 3)})`,
        ),
      );
    }
    const lanes: Prop[] = (tr.lanes ?? []).map((lane) => {
      this.seen.add(lane.sys_id);
      const lk = this.nodeKey("lane", lane.sys_id, "sys_pd_lane");
      const acts: Prop[] = [];
      for (const a of lane.activities) {
        const e = this.activity(a, lane.sys_id);
        if (e) acts.push(e);
      }
      const config: Prop[] = [
        this.idProp(lk),
        { key: "label", value: lit(lane.name) },
        { key: "order", value: lit(lane.order) },
        { key: "startRule", value: code("wfa.playbook.run.Immediately()") },
        { key: "restartRule", value: lit("RUN_ALWAYS") },
      ];
      if (lane.condition) {
        config.push({ key: "conditionToRun", value: lit(lane.condition) });
      }
      return {
        key: lk,
        value: code(
          `wfa.playbook.lane(${render(
            obj([
              { key: "config", value: obj(config) },
              {
                key: "activities",
                value: arrowObj(obj(acts), 4),
              },
            ]),
            3,
          )})`,
        ),
      };
    });
    if (lanes.length) {
      this.notes.push(
        "Lane / activity startRule and restartRule are not in the explain_flow tree: emitted as Run.Immediately() / RUN_ALWAYS — review them.",
      );
    }
    for (const v of tr.variants ?? []) {
      const k = this.nodeKey("variant", v.sys_id, "sys_pd_process_variant");
      const reason = `Playbook variant '${v.name}' has no PlaybookDefinition property; emitted as Record().`;
      this.h.unsupported({
        kind: "api",
        table: "sys_pd_process_variant",
        key: k,
        sys_id: v.sys_id,
        reason,
      });
      this.fallbackRow(
        "sys_pd_process_variant",
        v.sys_id,
        k,
        () =>
          this.synthFlat("process_definition", {
            label: v.name,
            active: v.active,
            condition: v.condition,
            order: v.order,
          }),
        reason,
      );
    }
    const state = [
      head?.status ? `status ${head.status}` : "",
      head?.active !== undefined ? `active ${head.active}` : "",
    ].filter(Boolean);
    if (state.length) {
      this.notes.push(`Instance state (not emitted): ${state.join(", ")}.`);
    }
    const dependent = obj([{ key: "triggers", value: arr(triggers) }]);
    const body = obj([
      {
        key: "lanes",
        value: arrowObj(obj(lanes), 2),
      },
    ]);
    return `PlaybookDefinition(\n${PAD}${render(obj(props), 1)},\n${PAD}${render(dependent, 1)},\n${PAD}${render(body, 1)},\n)`;
  }

  /** One playbook activity (`key: wfa.playbook.activity(…)`), or undefined on fallback. */
  activity(a: PdActivity, laneId: string): Prop | undefined {
    this.seen.add(a.sys_id);
    const k = this.nodeKey("activity", a.sys_id, "sys_pd_activity");
    const defName = norm(a.definition?.name);
    const core = ACTIVITIES[defName];
    if (!core) {
      const reason =
        defName === "questionnaire"
          ? `Activity '${a.name}': playbook Questionnaire activities are not supported; emitted as Record().`
          : `Activity '${a.name}': definition '${a.definition?.name ?? a.definition?.sys_id ?? "none"}' has no ActivityDefinitions.Core mapping; emitted as Record().`;
      this.h.unsupported({
        kind: "api",
        table: "sys_pd_activity",
        key: k,
        sys_id: a.sys_id,
        reason,
      });
      this.fallbackRow(
        "sys_pd_activity",
        a.sys_id,
        k,
        () =>
          this.synthFlat(
            "lane",
            {
              label: a.name,
              order: String(a.order),
              activity_definition: a.definition?.sys_id,
              condition: a.condition,
            },
            ["sys_id"],
            ["sys_pd_lane", laneId],
          ),
        reason,
      );
      for (const tm of a.timers ?? []) {
        this.timerFallback(tm, a.sys_id, reason);
      }
      return undefined;
    }
    this.automation.add("ActivityDefinitions");
    const p: Prop[] = [
      this.idProp(k),
      { key: "label", value: lit(a.name) },
      { key: "order", value: lit(a.order) },
      { key: "startRule", value: code("wfa.playbook.run.Immediately()") },
      { key: "restartRule", value: lit("RUN_ALWAYS") },
    ];
    if (a.condition) p.push({ key: "conditionToRun", value: lit(a.condition) });
    let delayed = false;
    for (const tm of a.timers ?? []) {
      const d = delayed ? undefined : durationExpr(tm.duration ?? "");
      if (!d) {
        this.timerFallback(
          tm,
          a.sys_id,
          delayed
            ? "only one startWithDelay per activity"
            : `duration '${tm.duration ?? ""}' is not an explicit duration`,
        );
        continue;
      }
      delayed = true;
      this.seen.add(tm.sys_id);
      this.nodeKey("timer", tm.sys_id, "sys_pd_timer_attributes");
      p.push({
        key: "startWithDelay",
        value: obj([
          { key: "type", value: lit("explicit") },
          { key: "duration", value: d },
        ]),
      });
    }
    return {
      key: k,
      value: code(
        `wfa.playbook.activity(ActivityDefinitions.Core.${core}, ${render(obj(p), 5)})`,
      ),
    };
  }

  timerFallback(tm: PdTimer, activityId: string, reason: string): void {
    const k = this.nodeKey("timer", tm.sys_id, "sys_pd_timer_attributes");
    this.h.unsupported({
      kind: "api",
      table: "sys_pd_timer_attributes",
      key: k,
      sys_id: tm.sys_id,
      reason: `Timer not emitted as startWithDelay (${reason}); emitted as Record().`,
    });
    this.fallbackRow(
      "sys_pd_timer_attributes",
      tm.sys_id,
      k,
      () =>
        this.synthFlat(
          "activity",
          {
            name: tm.name,
            type: tm.type,
            duration: tm.duration,
          },
          ["sys_id", "activity"],
          ["sys_pd_activity", tm.activity ?? activityId],
        ),
      `timer ${tm.name ?? tm.sys_id}`,
    );
  }

  /** Raw child rows the tree did not represent: `Record()` rows, reported. */
  leftovers(): void {
    const rest = [...this.rows.entries()]
      .filter(([id]) => !this.seen.has(id))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [id, { table, row }] of rest) {
      const k = this.nodeKey("row", id, table);
      const reason =
        "Row not represented in the explain_flow tree; emitted as Record().";
      this.h.unsupported({ kind: "child", table, key: k, sys_id: id, reason });
      this.seen.add(id);
      this.core.add("Record");
      this.fallbacks.push(
        `// child of ${this.key}: ${table} (${reason})\n${this.h.childRecord(table, row, k)}`,
      );
    }
  }

  /** Root fields the emitter does not represent. */
  rootFields(kind: ExplainFlowKind): void {
    const unmapped = this.h.unmapped(this.src.record!, ROOT_CONSUMED[kind]);
    for (const field of unmapped) {
      this.h.unsupported({
        kind: "field",
        table: this.t.table,
        key: this.key,
        sys_id: this.rootId,
        field,
        reason: `No ${this.t.sdkApi} property is mapped for ${field}; not emitted.`,
      });
    }
    if (unmapped.length) {
      this.notes.push(
        `Not emitted (no ${this.t.sdkApi} property mapped): ${unmapped.join(", ")}.`,
      );
    }
  }

  file(main: string, kind: ExplainFlowKind): void {
    const name = this.tree.name ?? this.src.name ?? "";
    const scope = this.src.scope?.scope ?? this.src.scope?.sys_id ?? "unknown";
    const imports = [
      "import '@servicenow/sdk/global'",
      `import { ${[...this.automation].sort().join(", ")} } from '@servicenow/sdk/automation'`,
    ];
    if (this.core.size) {
      imports.push(
        `import { ${[...this.core].sort().join(", ")} } from '@servicenow/sdk/core'`,
      );
    }
    const lines = [
      this.h.header([
        `Source: ${this.t.table} ${this.rootId} '${name}' (scope ${scope}), from the explain_flow ${kind} tree.`,
        FLOW_VERIFIED_NOTE,
      ]),
      "",
      ...imports,
      "",
      ...(this.notes.length
        ? [...this.notes.map((n) => `// ${oneLine(n)}`), ""]
        : []),
      [main, ...this.fallbacks].join("\n\n"),
      "",
    ];
    this.h.file(`${this.key}.now.ts`, lines.join("\n"));
  }
}

/**
 * Emit one flow-group artefact from its attached `explain_flow` tree. Returns
 * false — with no side effect — when there is no usable tree (none attached,
 * degraded, playbooks unavailable, another kind), so the caller falls back to
 * the P-26 `Record()` form.
 */
export function emitFlowFile(
  h: FlowEmitHooks,
  t: ArtifactType,
  src: FluentSource,
  key: string,
): boolean {
  const kind = FLOW_TREE_KINDS[t.type];
  const tree = src.flowTree;
  if (!kind || !tree || !src.record) return false;
  if (tree.kind !== kind || tree.degraded || tree.available === false) {
    return false;
  }
  const e = new FlowEmit(h, t, src, key, tree);
  e.rootFields(kind);
  const main = kind === "playbook" ? e.playbook() : e.flowLike(kind);
  e.leftovers();
  e.file(main, kind);
  return true;
}

/**
 * Read the `explain_flow` tree of every flow-group source (no runs, no call
 * expansion) and attach it as `flowTree`. A failed read is a warning and
 * leaves the source on the `Record()` fallback; tree caveats become warnings.
 */
export async function attachFlowTrees(
  t: ArtifactType,
  sources: FluentSource[],
  warnings: string[],
): Promise<void> {
  const kind = FLOW_TREE_KINDS[t.type];
  if (!kind) return;
  warnings.push(FLOW_VERIFIED_NOTE);
  const seen = new Set<string>();
  for (const s of sources) {
    const id = s.record ? snString(s.record.sys_id) : "";
    if (!id) continue;
    try {
      const tree = await explainFlow({
        sys_id: id,
        kind,
        runs: 0,
        ...(kind === "playbook" ? {} : { depth: 0 }),
      });
      s.flowTree = tree;
      if (tree.degraded || tree.available === false) {
        warnings.push(
          `${s.name ?? id}: the ${kind} tree is unavailable; emitted as Record() rows.`,
        );
      }
      for (const c of tree.caveats) {
        if (seen.has(c)) continue;
        seen.add(c);
        warnings.push(`explain_flow: ${c}`);
      }
    } catch (error) {
      warnings.push(
        `${s.name ?? id}: the ${kind} tree could not be read (${error instanceof Error ? error.message : String(error)}); emitted as Record() rows.`,
      );
    }
  }
}

/** Exported for tests: the pill path mapping and the template escaping. */
export const __flowInternals = { pillPath, templateText, tsKey };
