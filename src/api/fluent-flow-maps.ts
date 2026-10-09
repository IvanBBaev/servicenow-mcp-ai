/**
 * P-27 mapping tables and pure helpers for the flow / playbook Fluent
 * emitters: SDK action and step indexes, pill / logic / trigger / column /
 * activity maps, the root fields each kind consumes and value formatting.
 */
import { type ExplainFlowKind, type FlowStep } from "./explain-flow.js";
import {
  code,
  call,
  lit,
  obj,
  render,
  tsString,
  type Expr,
  type Prop,
} from "./fluent-render.js";
import {
  SDK_ACTION_STEPS,
  SDK_CORE_ACTIONS,
  type CoreActionSpec,
} from "./fluent-sdk-actions.js";

export const ACTION_INSTANCE_V2 = "sys_hub_action_instance_v2";

/** Lower-case letters and digits only: the lookup form of a display name. */
export const norm = (s: string | undefined): string =>
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
export const CORE_ACTIONS = specIndex(SDK_CORE_ACTIONS);
export const CORE_STEPS = specIndex(SDK_ACTION_STEPS);

/** `wfa.dataPill()` FlowDataType by SDK input column kind (default `string`). */
export const PILL_TYPES: Readonly<Record<string, string>> = {
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
export const VARIABLE_PILL_TYPES: Readonly<Record<string, string>> = {
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
export const LOGIC: Readonly<
  Record<string, { role: LogicRole; call?: string }>
> = {
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
export const TRIGGERS: Readonly<Record<string, string>> = {
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
export const COLUMNS: Readonly<Record<string, string>> = {
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
export const ACTIVITIES: Readonly<Record<string, string>> = {
  instruction: "Instruction",
  form: "RecordForm",
  recordform: "RecordForm",
};

/** Playbook record triggers (`PlaybookTriggerTypes.*`), by normalised type / definition name. */
export const PB_TRIGGERS: Readonly<Record<string, string>> = {
  recordcreate: "RecordCreate",
  created: "RecordCreate",
  recordupdate: "RecordUpdate",
  updated: "RecordUpdate",
  recordcreateorupdate: "RecordCreateOrUpdate",
  createdorupdated: "RecordCreateOrUpdate",
};

/** Root fields each kind represents (emitted, or reported as instance state). */
export const ROOT_CONSUMED: Readonly<
  Record<ExplainFlowKind, readonly string[]>
> = {
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
export const STEP_REF_FIELD: Readonly<Record<FlowStep["kind"], string>> = {
  action: "action_type",
  logic: "logic_definition",
  subflow: "subflow",
  step: "step_type",
};

export const PAD = "    ";
export const pad = (depth: number): string => PAD.repeat(depth);

/**
 * The name of a callback parameter: `_`-prefixed when the body never reads it,
 * so a project built with noUnusedParameters (now-sdk build) accepts it.
 */
export const usedParam = (param: string, body: string): string =>
  !param || new RegExp(`\\b${param}\\b`).test(body) ? param : `_${param}`;

/** `(params) => ({…})`, the parameter named per {@link usedParam}. */
export const arrowObj = (e: Expr, depth: number): Expr => {
  const text = render(e, depth);
  return code(`(${usedParam("params", text)}) => (${text})`);
};

/** `wfa.dataPill(…)` path for a pill, or undefined when its root is unknown. */
export function pillPath(pill: string): string | undefined {
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
export function templateText(s: string): string {
  return s.replace(
    // eslint-disable-next-line no-control-regex
    /\\|`|\$\{|[\u0000-\u001f\u007f\u2028\u2029]/g,
    (c) =>
      TEMPLATE_ESCAPES[c] ??
      `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** A value as text, for the secret check. */
export function asText(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

export const PILL_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Logic inputs a `wfa.flowLogic` call consumes itself (not reported as dropped). */
export const LOGIC_CONSUMED: readonly string[] = [
  "condition",
  "items",
  "duration",
  "duration_type",
  "label",
];

/** `obj` with `key` set (replaced when present). */
export function withProp(e: Expr, key: string, value: Expr): Expr {
  if (e.k !== "obj") return e;
  return obj([...e.props.filter((p) => p.key !== key), { key, value }]);
}

/**
 * `Duration({…})` for a glide_duration value (`1970-01-DD hh:mm:ss`);
 * undefined when the text is not of that form.
 */
export function durationExpr(text: string): Expr | undefined {
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
export function typedDefault(
  col: string,
  v: string,
): string | number | boolean {
  if (col === "BooleanColumn" && (v === "true" || v === "false")) {
    return v === "true";
  }
  if (col === "IntegerColumn" && /^-?\d+$/.test(v)) return Number(v);
  return v;
}

/** Is `s` exactly one `{{…}}` data pill? */
export const isWholePill = (s: string): boolean =>
  /^\{\{[^{}]+\}\}$/.test(s.trim());
