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
 *   `wfa.action(action.core.*, …)` steps, `wfa.flowLogic.*` logic (if /
 *   elseIf / else, forEach, tryCatch, doInParallel, doUntil and the leaf
 *   blocks), `wfa.subflow(…)` calls, inputs / outputs / flow variables as
 *   column constructors, stages, and `wfa.dataPill(…)` for data pills;
 * - `PlaybookDefinition({…})` with lanes, activities
 *   (`ActivityDefinitions.Core.*`), timers, triggers and inputs / outputs.
 *
 * Every construct it cannot express — spoke / custom actions outside
 * `action.core`, nested doInParallel, playbook Questionnaire activities,
 * variants, unknown logic / trigger / activity / column types, undecodable
 * step values, rows the tree does not represent — gets an explicit
 * `unsupported[]` entry and a `Record()` fallback for that node or row, placed
 * after the main call: never silent loss.
 *
 * The SDK signatures are an assumption: the names follow SDK-PARITY and the
 * SDK baseline (4.12.2, owner gate O-7), nothing is type-checked against the
 * SDK, and the output says `verified:false` (the P-29 oracle waits for O-7).
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
  lit,
  obj,
  oneLine,
  render,
  tsKey,
  tsString,
  type Expr,
  type Prop,
} from "./fluent-render.js";
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
  "The Flow / Subflow / Action / PlaybookDefinition emitter is verified:false: trigger.*, action.core.*, wfa.*, ActivityDefinitions.Core.* and the column shapes follow the SDK-PARITY names, not checked SDK signatures (the P-29 oracle waits for owner gate O-7).";

/**
 * What the flow emitter needs from the P-26 core (`fluent.ts`): passed in so
 * this file imports only types from it.
 */
export interface FlowEmitHooks {
  /** A unique `Now.ID` key, registered in the run's keys fragment. */
  key(base: string, sysId: string, table: string): string;
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

/** Lower-case letters and digits only: the lookup form of a display name. */
const norm = (s: string | undefined): string =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Core actions (`action.core.*`), by normalised action / step name. */
const CORE_ACTIONS: Readonly<Record<string, string>> = {
  askforapproval: "askForApproval",
  copyattachment: "copyAttachment",
  createcatalogtask: "createCatalogTask",
  createorupdaterecord: "createOrUpdateRecord",
  createrecord: "createRecord",
  createtask: "createTask",
  deleteattachment: "deleteAttachment",
  deleterecord: "deleteRecord",
  fireevent: "fireEvent",
  getattachmentsonrecord: "getAttachmentsOnRecord",
  getcatalogvariables: "getCatalogVariables",
  log: "log",
  lookuprecord: "lookUpRecord",
  lookuprecords: "lookUpRecords",
  sendemail: "sendEmail",
  sendnotification: "sendNotification",
  sendsms: "sendSms",
  updatemultiplerecords: "updateMultipleRecords",
  updaterecord: "updateRecord",
  waitforcondition: "waitForCondition",
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
  action: "action",
  approval: "approval",
  attachment: "attachment",
  form: "form",
  instruction: "instruction",
  recordform: "form",
  runaction: "action",
  runsubflow: "subflow",
  subflow: "subflow",
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

  stringValue(s: string, nodeKey: string, sysId: string): Expr {
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
        if (whole) return code(`wfa.dataPill(${path})`);
        out += `\${wfa.dataPill(${path})}`;
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

  /** The input properties of decoded step values; undefined = not decodable. */
  inputs(
    values: DecodedValues | undefined,
    nodeKey: string,
    sysId: string,
  ): Prop[] | undefined {
    if (!values || values.format === "empty") return [];
    if (!values.decoded || values.inputsOmitted) return undefined;
    if (values.inputs) {
      return values.inputs.map((i: StepInput) =>
        this.prop(i.name, i.value ?? "", nodeKey, sysId),
      );
    }
    const v = values.value;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.entries(v as Record<string, unknown>).map(([k, x]) =>
        this.prop(k, x, nodeKey, sysId),
      );
    }
    if (v === undefined || v === null || v === "") return [];
    return [this.prop("values", v, nodeKey, sysId)];
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
   * fall back. `depth` is the indent depth of the column entries themselves.
   */
  columns(
    list: FlowVariable[] | undefined,
    table: string,
    what: string,
    depth: number,
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
      this.core.add(col);
      const args: Prop[] = [];
      if (v.label) args.push({ key: "label", value: lit(v.label) });
      if (v.mandatory !== undefined) {
        args.push({ key: "mandatory", value: lit(v.mandatory) });
      }
      if (v.default !== undefined && v.default !== "") {
        args.push(
          this.h.isSecret(v.element, v.default)
            ? this.h.secretProp("default")
            : { key: "default", value: lit(v.default) },
        );
      }
      props.push({
        key: v.element,
        value: code(`${col}(${render(obj(args), depth)})`),
      });
    }
    return props.length ? obj(props) : undefined;
  }

  stages(list: Stage[] | undefined): Expr | undefined {
    if (!list?.length) return undefined;
    return arr(
      list.map((s) => {
        this.seen.add(s.sys_id);
        const k = this.nodeKey("stage", s.sys_id, "sys_hub_flow_stage");
        return obj([
          this.idProp(k),
          { key: "label", value: lit(s.label) },
          ...(s.value ? [{ key: "value", value: lit(s.value) }] : []),
          ...(s.duration ? [{ key: "duration", value: lit(s.duration) }] : []),
        ]);
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
    const core = CORE_ACTIONS[norm(s.ref?.name ?? s.name)];
    const k = this.nodeKey(s.kind, s.sys_id, s.source);
    if (!core) {
      return this.fallbackStep(
        s,
        s.kind === "step"
          ? `action step type '${s.ref?.name ?? s.name}' has no action.core mapping`
          : `'${s.ref?.name ?? s.name}' is a spoke or custom action outside action.core`,
        lines,
        depth,
        k,
      );
    }
    const inputs = this.inputs(s.values, k, s.sys_id);
    if (!inputs) {
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
    this.automation.add("wfa");
    this.automation.add("action");
    lines.push(
      `${pad(depth)}wfa.action(action.core.${core}, ${render(obj([this.idProp(k)]), depth)}, ${render(obj(inputs), depth)})`,
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
      `${pad(depth)}// TODO: replace Now.ref with the imported Subflow() '${oneLine(s.ref.name ?? s.ref.sys_id)}'`,
      `${pad(depth)}wfa.subflow(Now.ref('sys_hub_flow', ${tsString(s.ref.sys_id.toLowerCase())}), ${render(obj([this.idProp(k)]), depth)}, ${render(obj(inputs), depth)})`,
    );
  }

  /** The config object of a logic block: `$id` plus its decoded inputs. */
  logicConfig(s: FlowStep, k: string): Expr | undefined {
    const inputs = this.inputs(s.values, k, s.sys_id);
    return inputs ? obj([this.idProp(k), ...inputs]) : undefined;
  }

  /** A block body: `() => {…}` (or with a parameter). */
  block(
    children: FlowStep[],
    depth: number,
    inParallel: boolean,
    param = "",
  ): string {
    const body = this.steps(children, depth + 1, inParallel);
    return body.length
      ? `(${param}) => {\n${body.join("\n")}\n${pad(depth)}}`
      : `(${param}) => {}`;
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
    const cfg = this.logicConfig(s, k);
    if (!cfg) return unsupported(this.undecoded(s.values));
    const p = pad(depth);
    this.automation.add("wfa");
    switch (spec.role) {
      case "if": {
        let out = `${p}wfa.flowLogic.if(${render(cfg, depth)}, ${this.block(s.children, depth, inParallel)})`;
        let j = i + 1;
        for (; j < list.length; j++) {
          const n = list[j]!;
          const role = LOGIC[norm(n.ref?.name ?? n.name)]?.role;
          if (role !== "elseIf" && role !== "else") break;
          const nk = this.nodeKey("logic", n.sys_id, n.source);
          const ncfg = this.logicConfig(n, nk);
          if (!ncfg) break;
          this.seen.add(n.sys_id);
          if (n.comment) out += ` // ${oneLine(n.comment)}`;
          out += `.${role}(${render(ncfg, depth)}, ${this.block(n.children, depth, inParallel)})`;
          if (role === "else") {
            j++;
            break;
          }
        }
        lines.push(out);
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
      case "forEach":
        lines.push(
          `${p}wfa.flowLogic.forEach(${render(cfg, depth)}, ${this.block(s.children, depth, inParallel, "item")})`,
        );
        return i;
      case "doUntil":
        lines.push(
          `${p}wfa.flowLogic.doUntil(${render(cfg, depth)}, ${this.block(s.children, depth, inParallel)})`,
        );
        return i;
      case "try": {
        const next = list[i + 1];
        const hasCatch =
          next !== undefined &&
          LOGIC[norm(next.ref?.name ?? next.name)]?.role === "catch";
        let catchPart = "";
        if (hasCatch) {
          this.seen.add(next.sys_id);
          // The Catch block's own key is registered so its sys_id is traceable.
          this.nodeKey("logic", next.sys_id, next.source);
          catchPart = `\n${p}${PAD}catch: ${this.block(next.children, depth + 1, inParallel)},`;
        }
        lines.push(
          `${p}wfa.flowLogic.tryCatch(${render(cfg, depth)}, {\n${p}${PAD}try: ${this.block(s.children, depth + 1, inParallel)},${catchPart}\n${p}})`,
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
      case "leaf":
        if (s.children.length) {
          return unsupported(`'${s.name}' with nested steps`);
        }
        lines.push(`${p}wfa.flowLogic.${spec.call}(${render(cfg, depth)})`);
        return i;
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
      const ins = this.columns(tr.inputs, ioTables[0], "input", 3);
      if (ins) props.push({ key: "inputs", value: ins });
      const outs = this.columns(tr.outputs, ioTables[1], "output", 3);
      if (outs) props.push({ key: "outputs", value: outs });
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
        3,
      );
      if (vars) props.push({ key: "flowVariables", value: vars });
      const st = this.stages(tr.stages);
      if (st) props.push({ key: "stages", value: st });
    }
    const state = [
      head?.internal_name ? `internal_name ${head.internal_name}` : "",
      tr.flow?.status ? `status ${tr.flow.status}` : "",
      head?.active !== undefined ? `active ${head.active}` : "",
    ].filter(Boolean);
    if (state.length) {
      this.notes.push(`Instance state (not emitted): ${state.join(", ")}.`);
    }

    const args = [`${PAD}${render(obj(props), 1)},`];
    if (kind === "flow") args.push(`${PAD}${this.trigger(tr.trigger)},`);
    const body = this.steps(tr.steps ?? [], 2, false);
    args.push(
      body.length
        ? `${PAD}(params) => {\n${body.join("\n")}\n${PAD}},`
        : `${PAD}(params) => {},`,
    );
    return `${api}(\n${args.join("\n")}\n)`;
  }

  /** PlaybookDefinition. */
  playbook(): string {
    const tr = this.tree;
    const head = tr.playbook;
    this.automation.add("PlaybookDefinition");
    const props: Prop[] = [
      this.idProp(this.key),
      { key: "label", value: lit(head?.name ?? this.src.name ?? "") },
    ];
    if (head?.internal_name) {
      props.push({ key: "name", value: lit(head.internal_name) });
    }
    if (head?.table) props.push({ key: "table", value: lit(head.table) });
    if (head?.description) {
      props.push({ key: "description", value: lit(head.description) });
    }
    const ins = this.columns(tr.inputs, "sys_pd_process_input", "input", 2);
    if (ins) props.push({ key: "inputs", value: ins });
    const outs = this.columns(tr.outputs, "sys_pd_process_output", "output", 2);
    if (outs) props.push({ key: "outputs", value: outs });
    if (tr.triggers?.length) {
      props.push({
        key: "triggers",
        value: arr(
          tr.triggers.map((g) => {
            this.seen.add(g.sys_id);
            const k = this.nodeKey(
              "trigger",
              g.sys_id,
              "sys_pd_trigger_instance",
            );
            const p: Prop[] = [this.idProp(k)];
            if (g.name) p.push({ key: "name", value: lit(g.name) });
            if (g.type) p.push({ key: "type", value: lit(g.type) });
            if (g.definition) {
              p.push({
                key: "definition",
                value: code(
                  `Now.ref('sys_pd_trigger_definition', ${tsString(g.definition.sys_id.toLowerCase())})`,
                ),
                ...(g.definition.name ? { comment: g.definition.name } : {}),
              });
            }
            if (g.table) p.push({ key: "table", value: lit(g.table) });
            if (g.condition)
              p.push({ key: "condition", value: lit(g.condition) });
            return obj(p);
          }),
        ),
      });
    }
    const lanes = (tr.lanes ?? []).map((lane) => {
      this.seen.add(lane.sys_id);
      const lk = this.nodeKey("lane", lane.sys_id, "sys_pd_lane");
      const acts: Expr[] = [];
      for (const a of lane.activities) {
        const e = this.activity(a, lane.sys_id);
        if (e) acts.push(e);
      }
      return obj([
        this.idProp(lk),
        { key: "label", value: lit(lane.name) },
        ...(lane.condition
          ? [{ key: "condition", value: lit(lane.condition) }]
          : []),
        { key: "activities", value: arr(acts) },
      ]);
    });
    props.push({ key: "lanes", value: arr(lanes) });
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
    return `PlaybookDefinition(${render(obj(props))})`;
  }

  /** One playbook activity, or undefined when it falls back to `Record()`. */
  activity(a: PdActivity, laneId: string): Expr | undefined {
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
      {
        key: "activityDefinition",
        value: code(`ActivityDefinitions.Core.${core}`),
      },
    ];
    if (a.condition) p.push({ key: "condition", value: lit(a.condition) });
    if (a.timers?.length) {
      p.push({
        key: "timers",
        value: arr(
          a.timers.map((tm) => {
            const tk = this.nodeKey(
              "timer",
              tm.sys_id,
              "sys_pd_timer_attributes",
            );
            return obj([
              this.idProp(tk),
              ...(tm.name ? [{ key: "name", value: lit(tm.name) }] : []),
              ...(tm.type ? [{ key: "type", value: lit(tm.type) }] : []),
              ...(tm.duration
                ? [{ key: "duration", value: lit(tm.duration) }]
                : []),
            ]);
          }),
        ),
      });
    }
    return obj(p);
  }

  timerFallback(tm: PdTimer, activityId: string, reason: string): void {
    const k = this.nodeKey("timer", tm.sys_id, "sys_pd_timer_attributes");
    this.h.unsupported({
      kind: "api",
      table: "sys_pd_timer_attributes",
      key: k,
      sys_id: tm.sys_id,
      reason: `Timer of an unsupported activity (${reason})`,
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
