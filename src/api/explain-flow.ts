/**
 * P-10 / P-13 — `explain_flow` (project/SDK-PARITY.md §4 P-10, P-13, §5(b)).
 *
 * `kind:"flow"` / `"subflow"` reads a Flow Designer definition as a tree:
 *
 *   sys_hub_flow → trigger (sys_hub_trigger_instance(_v2) +
 *                  sys_hub_trigger_definition)
 *               → steps: action / logic / subflow instances from the v1 and
 *                 `_v2` tables, nested by `ui_id` / `parent_ui_id`, siblings
 *                 by `order`, each with its `values` decoded (flow-values)
 *                 and data pills labelled from the flow's `label_cache`
 *               → inputs / outputs / variables, stages, run_as and roles
 *               → draft vs published (`master_snapshot`, `draftDiffers`)
 *               → opt-in: latest `sys_flow_context` runs + `sys_flow_log`
 *                 errors
 *
 * `kind:"action"` (P-11) reads a custom action definition the same way:
 * sys_hub_action_type_definition → inputs / outputs (sys_hub_action_input /
 * sys_hub_action_output) → its sys_hub_step_instance steps by `order`, each
 * with its `values` decoded.
 *
 * Calls (P-11): the action and subflow steps of a flow / subflow are
 * resolved to their callee — the action's steps, the subflow's own step
 * tree — `depth` levels down (`EXPLAIN_FLOW_DEPTH`), at most `CALLEES_MAX`
 * distinct callees, each read once. A callee already on the call path is a
 * cycle: it is marked, not expanded.
 *
 * `kind:"workflow"` reads a legacy workflow as a graph: wf_workflow →
 * published wf_workflow_version → wf_activity nodes + wf_transition edges
 * (labelled with their wf_condition), the wf_stage list, opt-in wf_context
 * runs and an opt-in migration report (catalog items and SLA definitions
 * that still reference it, running contexts). Without a sys_id the migration
 * report covers the whole instance.
 *
 * `kind:"playbook"` (P-12) reads a Process Automation Designer playbook:
 * sys_pd_process_definition → sys_pd_lane (by `order`) → sys_pd_activity per
 * lane (by `order`, labelled with its sys_pd_activity_definition), the
 * sys_pd_trigger_instance triggers, sys_pd_process_input / _output, the
 * sys_pd_timer_attributes timers of its activities, the sys_pd_process_variant
 * variants, and opt-in sys_pd_context runs with their sys_pd_activity_context
 * states. The sys_pd_* family is licensed (gate O-9): an instance without it
 * gives a not-available result (`available:false`), never an error.
 *
 * Bounds: `CHILD_LIMIT` rows per read, IN lists chunked, `EXPLAIN_FLOW_RUNS`
 * runs, `RUN_ERRORS` log rows per run, `TREE_DEPTH_MAX` nesting levels,
 * `INPUTS_PER_STEP` decoded inputs per step, `RAW_PREVIEW` characters of an
 * undecodable value. Every table here is `verified:false` (gate O-5): an
 * unreadable one (policy denial, ACL, missing plugin) becomes a caveat with
 * the table name and status — never a failure — and fields the instance did
 * not return are listed per table in `missingFields`. Every read reports a
 * progress tick and stops when the call is cancelled.
 */
import { detectFlowValues } from "../core/artifacts/flow-values.js";
import { decodeField } from "../core/artifacts/decoders.js";
import { ServiceNowError } from "../core/errors.js";
import { trackProgress, type ProgressTracker } from "../core/progress.js";
import { CHILD_LIMIT, tableAvailable } from "./artifacts.js";
import { MermaidDoc, ident, label, type Arrow, type Shape } from "./mermaid.js";
import { snString } from "./shared.js";
import { queryTable, type SnRecord } from "./table.js";

/** Call-expansion depth: default (a flow's calls one level down) and max. */
export const EXPLAIN_FLOW_DEPTH = { default: 1, max: 3 } as const;

/** Distinct callees (actions / subflows) expanded per explain. */
export const CALLEES_MAX = 20;

/** Latest runs read when `runs` is set (default when `runs:true`, max). */
export const EXPLAIN_FLOW_RUNS = { default: 5, max: 20 } as const;

/** Error log rows kept per run. */
export const RUN_ERRORS = 10;

/** Deepest step nesting followed (a cycle guard as much as a bound). */
export const TREE_DEPTH_MAX = 32;

/** Decoded inputs kept per step. */
export const INPUTS_PER_STEP = 50;

/** Characters of an undecodable `values` column returned raw. */
export const RAW_PREVIEW = 1000;

/** Ids per `fieldIN…` query (keeps the URL short). */
const IN_CHUNK = 100;

/** Statuses an unverified table degrades on instead of failing. */
const DEGRADE_STATUSES = new Set([400, 403, 404]);

/** A record id safe to splice into an encoded query. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const FLOW_CAVEAT =
  "Flow Designer tables are verified:false: which of the v1 / _v2 instance tables is authoritative per release, the values compression format, snapshot child-row keying and the label_cache shape have not been confirmed on a live instance (gate O-5).";

const WORKFLOW_CAVEAT =
  "Legacy workflow tables are verified:false: their table and field names come from the SDK inventory and have not been confirmed on a live instance (gate O-5).";

const ACTION_CAVEAT =
  "Action tables are verified:false: sys_hub_action_type_definition, sys_hub_action_input / sys_hub_action_output (keyed by model) and sys_hub_step_instance (keyed by action; label, step_type) come from the SDK inventory and have not been confirmed on a live instance (gate O-5).";

const PLAYBOOK_CAVEAT =
  "Playbook tables are verified:false: the sys_pd_* table and field names (lane / activity keying, trigger, timer and variant columns, sys_pd_context fields) come from the SDK inventory and have not been confirmed on a live instance (gates O-5, O-9).";

const PLAYBOOK_UNAVAILABLE =
  "Process Automation Designer (sys_pd_*) is not available on this instance: the playbook tables are absent or not readable. The family is licensed (gate O-9); install / license Process Automation Designer to explain playbooks.";

const LOG_LEVEL_CAVEAT =
  "sys_flow_log level values are unverified: rows whose level is 'error' (or 2) are reported as errors.";

export type ExplainFlowKind =
  | "flow"
  | "subflow"
  | "action"
  | "workflow"
  | "playbook";

export interface ExplainFlowOptions {
  sys_id?: string;
  kind?: ExplainFlowKind;
  /** Latest runs to read (0 = none). */
  runs?: number;
  /** Workflow only: the migration report. */
  migration?: boolean;
  /** Flow / subflow: call levels to expand (0 = none). */
  depth?: number;
}

export interface Unreadable {
  table: string;
  status?: number;
  reason: string;
}

export interface Ref {
  sys_id: string;
  name?: string;
}

export interface Pill {
  pill: string;
  label?: string;
}

export interface StepInput {
  name: string;
  label?: string;
  value?: unknown;
  displayValue?: string;
  pills?: Pill[];
}

/** A decoded `values` column. */
export interface DecodedValues {
  format: "empty" | "json" | "base64-gzip-json" | "unknown";
  decoded: boolean;
  bytes: number;
  /** Name / value pairs, when the value is a list of them. */
  inputs?: StepInput[];
  inputsOmitted?: number;
  /** Any other decoded shape, as is. */
  value?: unknown;
  /** Data pills found in `value` (when it is not a name / value list). */
  pills?: Pill[];
  reason?: string;
  raw?: string;
  rawTruncated?: boolean;
}

/** `step` is a step of an action definition (sys_hub_step_instance). */
export type StepKind = "action" | "logic" | "subflow" | "step";

/** What an action / subflow step calls, resolved (P-11). */
export interface Callee {
  kind: "action" | "subflow";
  sys_id: string;
  name?: string;
  /** The callee's steps (shared between call sites of the same callee). */
  steps: FlowStep[];
  /** The callee is already on the call path: not expanded. */
  cycle?: true;
}

export interface FlowStep {
  /** Position in the tree: "1", "2", "2.1", … */
  number: string;
  kind: StepKind;
  source: string;
  sys_id: string;
  ui_id?: string;
  parent_ui_id?: string;
  order: number;
  name: string;
  /** The action type, logic definition or called subflow. */
  ref?: Ref;
  comment?: string;
  values?: DecodedValues;
  children: FlowStep[];
  /** Children past TREE_DEPTH_MAX, not expanded. */
  childrenOmitted?: number;
  /** The resolved action / subflow this step calls. */
  callee?: Callee;
}

export interface FlowTrigger {
  sys_id: string;
  source: string;
  definition: (Ref & { type?: string }) | null;
  type?: string;
  table?: string;
  condition?: string;
  values?: DecodedValues;
}

export interface FlowVariable {
  sys_id: string;
  element: string;
  label?: string;
  type?: string;
  mandatory?: boolean;
  default?: string;
}

export interface Stage {
  sys_id: string;
  label: string;
  value?: string;
  order: number;
  duration?: string;
}

export interface FlowLogError {
  sys_id: string;
  level?: string;
  message: string;
  created?: string;
}

export interface Run {
  sys_id: string;
  name?: string;
  state?: string;
  started?: string;
  ended?: string;
  table?: string;
  record?: string;
  errors?: FlowLogError[];
  /** Playbook runs: sys_pd_activity_context rows per state. */
  activityStates?: Record<string, number>;
}

export interface Published {
  status?: string;
  master_snapshot?: string;
  latest_snapshot?: string;
  snapshotUpdated?: string;
  /** Steps read under the published snapshot (when its rows were found). */
  publishedSteps?: number;
  /** True when the draft definition differs from the published snapshot. */
  draftDiffers?: boolean;
  /** How `draftDiffers` was decided. */
  basis: "never-published" | "steps" | "snapshot-pointers";
}

export interface WfActivity {
  sys_id: string;
  name: string;
  order: number;
  definition?: Ref;
  x?: number;
  y?: number;
  conditions: Ref[];
}

export interface WfTransition {
  sys_id: string;
  from: string;
  to: string;
  condition?: Ref;
}

export interface MigrationEntry {
  sys_id: string;
  name?: string;
  catalogItems: Ref[];
  slaDefinitions: Ref[];
  runningContexts: number;
  /** Referenced or running: still in use, so migrate before retiring. */
  inUse: boolean;
}

export interface MigrationReport {
  scope: "workflow" | "instance";
  workflows: MigrationEntry[];
  note: string;
}

/** A playbook activity (sys_pd_activity) inside its lane. */
export interface PdActivity {
  /** Position: "<lane>.<activity>", e.g. "2.1". */
  number: string;
  sys_id: string;
  name: string;
  order: number;
  /** The sys_pd_activity_definition it instantiates. */
  definition?: Ref;
  condition?: string;
  /** Timers (sys_pd_timer_attributes) attached to this activity. */
  timers?: PdTimer[];
}

/** A playbook lane (sys_pd_lane) with its activities in order. */
export interface PdLane {
  number: string;
  sys_id: string;
  name: string;
  order: number;
  condition?: string;
  activities: PdActivity[];
}

export interface PdTrigger {
  sys_id: string;
  name?: string;
  definition?: Ref;
  type?: string;
  table?: string;
  condition?: string;
}

export interface PdTimer {
  sys_id: string;
  activity?: string;
  name?: string;
  type?: string;
  duration?: string;
}

export interface PdVariant {
  sys_id: string;
  name: string;
  active?: boolean;
  condition?: string;
  order?: number;
}

export interface ExplainFlowCounts {
  steps: number;
  actions: number;
  logic: number;
  subflows: number;
  inputs: number;
  outputs: number;
  variables: number;
  stages: number;
  activities: number;
  transitions: number;
  runs: number;
  /** Distinct callees expanded. */
  callees: number;
  /** Playbook only. */
  lanes?: number;
  triggers?: number;
  timers?: number;
  variants?: number;
}

export interface ExplainFlowResult {
  kind: ExplainFlowKind;
  sys_id?: string;
  name?: string;
  /** Flow / subflow header. */
  flow?: {
    sys_id: string;
    name?: string;
    internal_name?: string;
    type?: string;
    active?: boolean;
    status?: string;
    description?: string;
    run_as?: string;
    run_with_roles: Ref[];
  };
  /** Action definition header (kind:"action"). */
  action?: {
    sys_id: string;
    name?: string;
    internal_name?: string;
    category?: string;
    access?: string;
    active?: boolean;
    description?: string;
  };
  trigger?: FlowTrigger | null;
  steps?: FlowStep[];
  inputs?: FlowVariable[];
  outputs?: FlowVariable[];
  variables?: FlowVariable[];
  published?: Published;
  /** Workflow header. */
  workflow?: {
    sys_id: string;
    name?: string;
    table?: string;
    description?: string;
    active?: boolean;
  };
  version?: {
    sys_id: string;
    name?: string;
    published: boolean;
    updated?: string;
  } | null;
  activities?: WfActivity[];
  transitions?: WfTransition[];
  /** Playbook header (kind:"playbook"). */
  playbook?: {
    sys_id: string;
    name?: string;
    internal_name?: string;
    table?: string;
    status?: string;
    active?: boolean;
    description?: string;
  };
  lanes?: PdLane[];
  triggers?: PdTrigger[];
  variants?: PdVariant[];
  stages?: Stage[];
  runs?: Run[];
  migration?: MigrationReport;
  counts: ExplainFlowCounts;
  verified: false;
  caveats: string[];
  unreadable: Unreadable[];
  missingFields?: Record<string, string[]>;
  /** Set when the root table itself could not be read. */
  degraded?: Unreadable;
  available?: boolean;
}

// --- bounded reads (the P-16 pattern) -----------------------------------------

interface Ctx {
  caveats: string[];
  unreadable: Unreadable[];
  missing: Record<string, string[]>;
  progress: ProgressTracker;
}

function degradeStatus(error: unknown): number | undefined {
  if (!(error instanceof ServiceNowError)) return undefined;
  return error.status !== undefined && DEGRADE_STATUSES.has(error.status)
    ? error.status
    : undefined;
}

function noteMissing(
  ctx: Ctx,
  table: string,
  fields: string[],
  rows: SnRecord[],
): void {
  if (!rows.length) return;
  const missing = fields.filter((f) => rows.every((r) => !(f in r)));
  if (!missing.length) return;
  const seen = new Set(ctx.missing[table] ?? []);
  for (const f of missing) seen.add(f);
  ctx.missing[table] = [...seen];
}

/**
 * One bounded read. A degradable instance error (400 / 403 / 404, which
 * includes a policy denial) is recorded as a caveat and yields no rows.
 */
async function read(
  ctx: Ctx,
  table: string,
  query: string,
  fields: string[],
  limit = CHILD_LIMIT,
): Promise<SnRecord[]> {
  ctx.progress.tick(table);
  if (ctx.unreadable.some((u) => u.table === table)) return [];
  try {
    const { records, total } = await queryTable({
      table,
      query,
      fields,
      limit,
      displayValue: "false",
    });
    if (
      limit === CHILD_LIMIT &&
      records.length >= limit &&
      (total === undefined || total > records.length)
    ) {
      ctx.caveats.push(
        `${table}: read capped at ${CHILD_LIMIT} rows; the result may be incomplete.`,
      );
    }
    noteMissing(ctx, table, fields, records);
    return records;
  } catch (error) {
    const status = degradeStatus(error);
    if (status === undefined) throw error;
    const reason = (error as Error).message;
    ctx.unreadable.push({ table, status, reason });
    ctx.caveats.push(
      `${table} could not be read (${status}): ${reason} That part is omitted.`,
    );
    return [];
  }
}

/** `field IN ids` over chunks of `IN_CHUNK`, capped at `CHILD_LIMIT` rows. */
async function readIn(
  ctx: Ctx,
  table: string,
  field: string,
  ids: Iterable<string>,
  fields: string[],
  suffix = "",
): Promise<SnRecord[]> {
  const list = [...new Set(ids)].filter((id) => SAFE_ID.test(id));
  const out: SnRecord[] = [];
  for (let i = 0; i < list.length; i += IN_CHUNK) {
    const chunk = list.slice(i, i + IN_CHUNK);
    out.push(
      ...(await read(
        ctx,
        table,
        `${field}IN${chunk.join(",")}${suffix}`,
        fields,
      )),
    );
    if (out.length >= CHILD_LIMIT) {
      if (i + IN_CHUNK < list.length) {
        ctx.caveats.push(
          `${table}: stopped after ${out.length} rows; the result may be incomplete.`,
        );
      }
      break;
    }
  }
  return out;
}

/** Read the root record by sys_id; an unreadable table degrades. */
async function readRoot(
  ctx: Ctx,
  table: string,
  sysId: string,
  fields: string[],
): Promise<{ row: SnRecord } | { unreadable: Unreadable }> {
  ctx.progress.tick(table);
  let records: SnRecord[];
  try {
    ({ records } = await queryTable({
      table,
      query: `sys_id=${sysId}`,
      fields,
      limit: 1,
      displayValue: "false",
    }));
  } catch (error) {
    const status = degradeStatus(error);
    if (status === undefined) throw error;
    return { unreadable: { table, status, reason: (error as Error).message } };
  }
  if (!records.length) {
    throw new ServiceNowError(
      `No ${table} record matches sys_id '${sysId}'.`,
      404,
      undefined,
      {
        hint:
          table === "wf_workflow"
            ? "Pass a wf_workflow sys_id with kind:'workflow' (servicenow_list_flows kind:'workflow' lists them)."
            : table === "sys_hub_action_type_definition"
              ? "Pass a sys_hub_action_type_definition sys_id with kind:'action' (a flow's action steps carry it as ref)."
              : table === "sys_pd_process_definition"
                ? "Pass a sys_pd_process_definition sys_id with kind:'playbook'."
                : "Pass a sys_hub_flow sys_id (servicenow_list_flows lists them); use kind:'workflow' for a legacy workflow.",
      },
    );
  }
  noteMissing(ctx, table, fields, records);
  return { row: records[0]! };
}

/** The root table could not be read: a degraded result, not a failure. */
async function degrade(
  result: ExplainFlowResult,
  why: Unreadable,
): Promise<ExplainFlowResult> {
  result.degraded = why;
  result.unreadable.push(why);
  result.caveats.push(
    `${why.table} could not be read (${why.status}): ${why.reason}`,
  );
  const available = await tableAvailable(why.table);
  if (available !== undefined) result.available = available;
  return result;
}

const str = (row: SnRecord, field: string): string => snString(row[field]);
const opt = (row: SnRecord, field: string): string | undefined =>
  str(row, field) || undefined;
const num = (row: SnRecord, field: string): number => {
  const n = Number(str(row, field));
  return Number.isFinite(n) ? n : 0;
};
const optNum = (row: SnRecord, field: string): number | undefined => {
  const text = str(row, field);
  const n = Number(text);
  return text && Number.isFinite(n) ? n : undefined;
};
const bool = (row: SnRecord, field: string): boolean | undefined => {
  const v = str(row, field);
  return v ? v === "true" || v === "1" : undefined;
};
const ref = (row: SnRecord, field: string): Ref | undefined => {
  const sys_id = str(row, field);
  if (!sys_id) return undefined;
  const name = opt(row, `${field}.name`);
  return name ? { sys_id, name } : { sys_id };
};

// --- values and data pills ------------------------------------------------------

const PILL = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * `label_cache` as pill name → label. The JSON shape is unverified (O-5):
 * a list of `{name, label}` or an object keyed by pill name (string or
 * `{label}` values) are both read.
 */
export function pillLabels(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw.trim()) return out;
  const d = decodeField("json", raw);
  if (!d.decoded) return out;
  const v = d.value;
  if (Array.isArray(v)) {
    for (const e of v) {
      if (e && typeof e === "object") {
        const name = (e as Record<string, unknown>).name;
        const lab = (e as Record<string, unknown>).label;
        if (typeof name === "string" && typeof lab === "string") {
          out.set(name, lab);
        }
      }
    }
  } else if (v && typeof v === "object") {
    for (const [name, e] of Object.entries(v as Record<string, unknown>)) {
      if (typeof e === "string") out.set(name, e);
      else if (e && typeof e === "object") {
        const lab = (e as Record<string, unknown>).label;
        if (typeof lab === "string") out.set(name, lab);
      }
    }
  }
  return out;
}

function pillsIn(value: unknown, labels: Map<string, string>): Pill[] {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return [];
  const seen = new Map<string, Pill>();
  for (const m of text.matchAll(PILL)) {
    const pill = m[1]!;
    if (seen.has(pill)) continue;
    const lab = labels.get(pill);
    seen.set(pill, lab ? { pill, label: lab } : { pill });
  }
  return [...seen.values()];
}

function inputOf(
  e: Record<string, unknown>,
  labels: Map<string, string>,
): StepInput {
  const input: StepInput = { name: String(e.name) };
  const param = e.parameter;
  const lab =
    param && typeof param === "object"
      ? (param as Record<string, unknown>).label
      : e.label;
  if (typeof lab === "string" && lab) input.label = lab;
  if (e.value !== undefined) input.value = e.value;
  if (typeof e.displayValue === "string" && e.displayValue) {
    input.displayValue = e.displayValue;
  }
  const pills = pillsIn(e.value, labels);
  if (pills.length) input.pills = pills;
  return input;
}

const isNamed = (e: unknown): e is Record<string, unknown> =>
  !!e &&
  typeof e === "object" &&
  typeof (e as Record<string, unknown>).name === "string";

/**
 * Decode a `values` column (flow-values detection) into name / value inputs
 * with labelled data pills. Never throws.
 */
export function decodeValues(
  raw: string,
  labels: Map<string, string>,
): DecodedValues | undefined {
  if (!raw) return undefined;
  const d = detectFlowValues(raw);
  if (!d.decoded) {
    return {
      format: d.format,
      decoded: false,
      bytes: d.bytes,
      reason: d.reason,
      raw: raw.slice(0, RAW_PREVIEW),
      ...(raw.length > RAW_PREVIEW ? { rawTruncated: true } : {}),
    };
  }
  const out: DecodedValues = {
    format: d.format,
    decoded: true,
    bytes: d.bytes,
  };
  let list: unknown = d.value;
  if (
    list &&
    typeof list === "object" &&
    !Array.isArray(list) &&
    Array.isArray((list as Record<string, unknown>).inputs)
  ) {
    list = (list as Record<string, unknown>).inputs;
  }
  if (Array.isArray(list) && list.length && list.every(isNamed)) {
    out.inputs = list.slice(0, INPUTS_PER_STEP).map((e) => inputOf(e, labels));
    if (list.length > INPUTS_PER_STEP) {
      out.inputsOmitted = list.length - INPUTS_PER_STEP;
    }
  } else if (d.value !== null) {
    out.value = d.value;
    const pills = pillsIn(d.value, labels);
    if (pills.length) out.pills = pills;
  }
  return out;
}

// --- flow / subflow ------------------------------------------------------------

const FLOW_FIELDS = [
  "sys_id",
  "name",
  "internal_name",
  "type",
  "active",
  "status",
  "description",
  "run_as",
  "run_with_roles",
  "label_cache",
  "master_snapshot",
  "latest_snapshot",
];

const STEP_BASE = [
  "sys_id",
  "flow",
  "order",
  "ui_id",
  "parent_ui_id",
  "comment",
  "values",
];

/** The step tables: `_v2` first, so a `_v2` row wins a `ui_id` clash. */
const STEP_TABLES: { table: string; kind: StepKind; refField: string }[] = [
  {
    table: "sys_hub_action_instance_v2",
    kind: "action",
    refField: "action_type",
  },
  { table: "sys_hub_action_instance", kind: "action", refField: "action_type" },
  {
    table: "sys_hub_flow_logic_instance_v2",
    kind: "logic",
    refField: "logic_definition",
  },
  { table: "sys_hub_flow_logic", kind: "logic", refField: "logic_definition" },
  {
    table: "sys_hub_sub_flow_instance_v2",
    kind: "subflow",
    refField: "subflow",
  },
  { table: "sys_hub_sub_flow_instance", kind: "subflow", refField: "subflow" },
];

const TRIGGER_TABLES = [
  "sys_hub_trigger_instance_v2",
  "sys_hub_trigger_instance",
];
const TRIGGER_FIELDS = [
  "sys_id",
  "flow",
  "trigger_definition",
  "trigger_type",
  "table",
  "condition",
  "values",
];

const VAR_FIELDS = [
  "sys_id",
  "model",
  "element",
  "label",
  "internal_type",
  "mandatory",
  "default_value",
  "order",
];

interface RawStep {
  kind: StepKind;
  source: string;
  row: SnRecord;
  key: string;
}

/** Read the step rows of a flow (or of a snapshot) from all six tables. */
async function readSteps(ctx: Ctx, owner: string): Promise<RawStep[]> {
  const out: RawStep[] = [];
  const keys = new Set<string>();
  const byKind = new Map<StepKind, Set<string>>();
  for (const t of STEP_TABLES) {
    const fields = [...STEP_BASE, t.refField, `${t.refField}.name`];
    const rows = await read(ctx, t.table, `flow=${owner}^ORDERBYorder`, fields);
    if (rows.length) {
      const tables = byKind.get(t.kind) ?? new Set<string>();
      tables.add(t.table);
      byKind.set(t.kind, tables);
    }
    for (const row of rows) {
      const key = str(row, "ui_id") || str(row, "sys_id");
      if (keys.has(key)) continue;
      keys.add(key);
      out.push({ kind: t.kind, source: t.table, row, key });
    }
  }
  for (const [kind, tables] of byKind) {
    if (tables.size > 1) {
      ctx.caveats.push(
        `${kind} steps were found in both ${[...tables].join(" and ")}; the _v2 row wins when both carry the same ui_id.`,
      );
    }
  }
  return out;
}

/** Build the ordered step tree from `ui_id` / `parent_ui_id`. */
function buildTree(
  ctx: Ctx,
  raw: RawStep[],
  labels: Map<string, string>,
): FlowStep[] {
  const refField = (kind: StepKind): string =>
    kind === "action"
      ? "action_type"
      : kind === "logic"
        ? "logic_definition"
        : "subflow";
  const steps = raw.map(({ kind, source, row }): FlowStep => {
    const r = ref(row, refField(kind));
    const values = decodeValues(str(row, "values"), labels);
    return {
      number: "",
      kind,
      source,
      sys_id: str(row, "sys_id"),
      ...(opt(row, "ui_id") ? { ui_id: str(row, "ui_id") } : {}),
      ...(opt(row, "parent_ui_id")
        ? { parent_ui_id: str(row, "parent_ui_id") }
        : {}),
      order: num(row, "order"),
      name: r?.name ?? r?.sys_id ?? `(${kind})`,
      ...(r ? { ref: r } : {}),
      ...(opt(row, "comment") ? { comment: str(row, "comment") } : {}),
      ...(values ? { values } : {}),
      children: [],
    };
  });
  const byUi = new Map<string, FlowStep>();
  for (const s of steps) if (s.ui_id) byUi.set(s.ui_id, s);
  const roots: FlowStep[] = [];
  let orphans = 0;
  for (const s of steps) {
    const parent = s.parent_ui_id ? byUi.get(s.parent_ui_id) : undefined;
    if (parent && parent !== s) parent.children.push(s);
    else {
      if (s.parent_ui_id) orphans++;
      roots.push(s);
    }
  }
  if (orphans) {
    ctx.caveats.push(
      `${orphans} step(s) name a parent_ui_id that was not read; they are shown at the top level.`,
    );
  }
  // Number the tree from the roots; anything unreached sits in a cycle.
  const reached = new Set<FlowStep>();
  let cut = 0;
  const walk = (list: FlowStep[], prefix: string, depth: number): void => {
    list.sort((a, b) => a.order - b.order);
    list.forEach((s, i) => {
      reached.add(s);
      s.number = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
      if (depth >= TREE_DEPTH_MAX && s.children.length) {
        s.childrenOmitted = s.children.length;
        cut += s.children.length;
        s.children = [];
        return;
      }
      walk(s.children, s.number, depth + 1);
    });
  };
  walk(roots, "", 1);
  const cyclic = steps.filter((s) => !reached.has(s));
  if (cyclic.length) {
    for (const s of cyclic) s.children = [];
    ctx.caveats.push(
      `${cyclic.length} step(s) form a parent_ui_id cycle; they are shown at the top level without children.`,
    );
    const start = roots.length;
    roots.push(...cyclic);
    cyclic.forEach((s, i) => {
      s.number = `${start + i + 1}`;
    });
  }
  if (cut) {
    ctx.caveats.push(
      `Steps nested deeper than ${TREE_DEPTH_MAX} levels are not expanded (${cut} omitted).`,
    );
  }
  return roots;
}

function* allSteps(list: FlowStep[]): Generator<FlowStep> {
  for (const s of list) {
    yield s;
    yield* allSteps(s.children);
  }
}

/** Order-sensitive fingerprint of a step tree (for draft vs published). */
function signature(list: FlowStep[]): string {
  return [...allSteps(list)]
    .map(
      (s) =>
        `${s.number}|${s.kind}|${s.ref?.sys_id ?? ""}|${s.values?.decoded ? JSON.stringify(s.values.inputs ?? s.values.value ?? null) : (s.values?.raw ?? "")}`,
    )
    .join("\n");
}

function variable(row: SnRecord): FlowVariable {
  return {
    sys_id: str(row, "sys_id"),
    element: str(row, "element") || str(row, "name"),
    ...(opt(row, "label") ? { label: str(row, "label") } : {}),
    ...(opt(row, "internal_type") ? { type: str(row, "internal_type") } : {}),
    ...(bool(row, "mandatory") !== undefined
      ? { mandatory: bool(row, "mandatory") }
      : {}),
    ...(opt(row, "default_value")
      ? { default: str(row, "default_value") }
      : {}),
  };
}

async function readVariables(
  ctx: Ctx,
  table: string,
  flowId: string,
  fields = VAR_FIELDS,
): Promise<FlowVariable[]> {
  const rows = await read(ctx, table, `model=${flowId}^ORDERBYorder`, fields);
  return rows.map(variable);
}

async function readTrigger(
  ctx: Ctx,
  flowId: string,
  labels: Map<string, string>,
): Promise<FlowTrigger | null> {
  let found: { row: SnRecord; source: string } | undefined;
  let extra = 0;
  for (const table of TRIGGER_TABLES) {
    const rows = await read(ctx, table, `flow=${flowId}`, TRIGGER_FIELDS, 5);
    if (!rows.length) continue;
    if (found) extra += rows.length;
    else {
      found = { row: rows[0]!, source: table };
      extra += rows.length - 1;
    }
  }
  if (!found) return null;
  if (extra) {
    ctx.caveats.push(
      `${extra} more trigger instance row(s) found; the first (${found.source}) is shown.`,
    );
  }
  const { row, source } = found;
  const defId = str(row, "trigger_definition");
  let definition: FlowTrigger["definition"] = null;
  if (defId) {
    const defs = await readIn(
      ctx,
      "sys_hub_trigger_definition",
      "sys_id",
      [defId],
      ["sys_id", "name", "type"],
    );
    const d = defs[0];
    definition = d
      ? {
          sys_id: defId,
          ...(opt(d, "name") ? { name: str(d, "name") } : {}),
          ...(opt(d, "type") ? { type: str(d, "type") } : {}),
        }
      : { sys_id: defId };
  }
  const values = decodeValues(str(row, "values"), labels);
  return {
    sys_id: str(row, "sys_id"),
    source,
    definition,
    ...(opt(row, "trigger_type") ? { type: str(row, "trigger_type") } : {}),
    ...(opt(row, "table") ? { table: str(row, "table") } : {}),
    ...(opt(row, "condition") ? { condition: str(row, "condition") } : {}),
    ...(values ? { values } : {}),
  };
}

async function readRoles(ctx: Ctx, raw: string): Promise<Ref[]> {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return [];
  const ids = parts.filter((p) => /^[0-9a-f]{32}$/.test(p));
  const names = new Map<string, string>();
  if (ids.length) {
    for (const r of await readIn(ctx, "sys_user_role", "sys_id", ids, [
      "sys_id",
      "name",
    ])) {
      names.set(str(r, "sys_id"), str(r, "name"));
    }
  }
  return parts.map((p) =>
    names.get(p) ? { sys_id: p, name: names.get(p) } : { sys_id: p },
  );
}

const isErrorLevel = (level: string): boolean =>
  /^(error|2)$/i.test(level.trim());

async function readFlowRuns(
  ctx: Ctx,
  flowId: string,
  limit: number,
): Promise<Run[]> {
  const rows = await read(
    ctx,
    "sys_flow_context",
    `flow=${flowId}^ORDERBYDESCsys_created_on`,
    [
      "sys_id",
      "name",
      "state",
      "sys_created_on",
      "ended",
      "source_table",
      "source_record",
    ],
    limit,
  );
  const runs = rows.map(
    (r): Run => ({
      sys_id: str(r, "sys_id"),
      ...(opt(r, "name") ? { name: str(r, "name") } : {}),
      ...(opt(r, "state") ? { state: str(r, "state") } : {}),
      ...(opt(r, "sys_created_on")
        ? { started: str(r, "sys_created_on") }
        : {}),
      ...(opt(r, "ended") ? { ended: str(r, "ended") } : {}),
      ...(opt(r, "source_table") ? { table: str(r, "source_table") } : {}),
      ...(opt(r, "source_record") ? { record: str(r, "source_record") } : {}),
      errors: [],
    }),
  );
  if (!runs.length) return runs;
  ctx.caveats.push(LOG_LEVEL_CAVEAT);
  const logs = await readIn(
    ctx,
    "sys_flow_log",
    "context",
    runs.map((r) => r.sys_id),
    ["sys_id", "context", "level", "message", "sys_created_on"],
    "^ORDERBYDESCsys_created_on",
  );
  const byRun = new Map(runs.map((r) => [r.sys_id, r]));
  for (const log of logs) {
    const run = byRun.get(str(log, "context"));
    if (!run || !isErrorLevel(str(log, "level"))) continue;
    if (run.errors!.length >= RUN_ERRORS) continue;
    run.errors!.push({
      sys_id: str(log, "sys_id"),
      level: str(log, "level"),
      message: str(log, "message"),
      ...(opt(log, "sys_created_on")
        ? { created: str(log, "sys_created_on") }
        : {}),
    });
  }
  return runs;
}

async function explainFlowDefinition(
  ctx: Ctx,
  result: ExplainFlowResult,
  sysId: string,
  kind: "flow" | "subflow",
  runs: number,
  depth: number,
): Promise<ExplainFlowResult> {
  const root = await readRoot(ctx, "sys_hub_flow", sysId, FLOW_FIELDS);
  if ("unreadable" in root) return degrade(result, root.unreadable);
  const row = root.row;
  const type = opt(row, "type");
  if (type && type !== kind) {
    ctx.caveats.push(
      `sys_hub_flow ${sysId} is a ${type}, not a ${kind}; it is explained as found.`,
    );
  }
  const labels = pillLabels(str(row, "label_cache"));
  result.name = opt(row, "name");
  result.flow = {
    sys_id: sysId,
    ...(opt(row, "name") ? { name: str(row, "name") } : {}),
    ...(opt(row, "internal_name")
      ? { internal_name: str(row, "internal_name") }
      : {}),
    ...(type ? { type } : {}),
    ...(bool(row, "active") !== undefined
      ? { active: bool(row, "active") }
      : {}),
    ...(opt(row, "status") ? { status: str(row, "status") } : {}),
    ...(opt(row, "description")
      ? { description: str(row, "description") }
      : {}),
    ...(opt(row, "run_as") ? { run_as: str(row, "run_as") } : {}),
    run_with_roles: await readRoles(ctx, str(row, "run_with_roles")),
  };

  result.trigger = await readTrigger(ctx, sysId, labels);
  const steps = buildTree(ctx, await readSteps(ctx, sysId), labels);
  result.steps = steps;
  result.inputs = await readVariables(ctx, "sys_hub_flow_input", sysId);
  result.outputs = await readVariables(ctx, "sys_hub_flow_output", sysId);
  result.variables = await readVariables(ctx, "sys_hub_flow_variable", sysId);
  result.stages = (
    await read(ctx, "sys_hub_flow_stage", `flow=${sysId}^ORDERBYorder`, [
      "sys_id",
      "label",
      "value",
      "order",
      "duration",
    ])
  ).map(stage);

  // Draft vs published.
  const master = opt(row, "master_snapshot");
  const latest = opt(row, "latest_snapshot");
  const published: Published = {
    ...(opt(row, "status") ? { status: str(row, "status") } : {}),
    ...(master ? { master_snapshot: master } : {}),
    ...(latest ? { latest_snapshot: latest } : {}),
    basis: "never-published",
  };
  if (master && SAFE_ID.test(master) && master !== sysId) {
    const snap = await read(
      ctx,
      "sys_hub_flow_snapshot",
      `sys_id=${master}`,
      ["sys_id", "sys_updated_on"],
      1,
    );
    if (snap[0] && opt(snap[0], "sys_updated_on")) {
      published.snapshotUpdated = str(snap[0], "sys_updated_on");
    }
    const snapSteps = await readSteps(ctx, master);
    if (snapSteps.length) {
      const tree = buildTree({ ...ctx, caveats: [] }, snapSteps, labels);
      published.publishedSteps = [...allSteps(tree)].length;
      published.draftDiffers = signature(tree) !== signature(steps);
      published.basis = "steps";
    } else {
      published.draftDiffers = !!latest && latest !== master;
      published.basis = "snapshot-pointers";
      ctx.caveats.push(
        "No step rows were found under the published snapshot (snapshot child-row keying is unverified); draftDiffers compares latest_snapshot with master_snapshot only.",
      );
    }
  } else if (master === sysId) {
    published.draftDiffers = !!latest && latest !== master;
    published.basis = "snapshot-pointers";
  } else {
    ctx.caveats.push(
      "The flow has no master_snapshot: it has never been published (or the field was not returned).",
    );
  }
  result.published = published;

  if (runs > 0) result.runs = await readFlowRuns(ctx, sysId, runs);
  const callees = await expandCalls(ctx, steps, sysId, depth);

  const all = [...allSteps(steps)];
  result.counts = {
    ...result.counts,
    steps: all.length,
    actions: all.filter((s) => s.kind === "action").length,
    logic: all.filter((s) => s.kind === "logic").length,
    subflows: all.filter((s) => s.kind === "subflow").length,
    inputs: result.inputs.length,
    outputs: result.outputs.length,
    variables: result.variables.length,
    stages: result.stages.length,
    runs: result.runs?.length ?? 0,
    callees,
  };
  return result;
}

function stage(row: SnRecord): Stage {
  return {
    sys_id: str(row, "sys_id"),
    label: str(row, "label") || str(row, "name") || str(row, "value"),
    ...(opt(row, "value") ? { value: str(row, "value") } : {}),
    order: num(row, "order"),
    ...(opt(row, "duration") ? { duration: str(row, "duration") } : {}),
  };
}

// --- legacy workflow -----------------------------------------------------------

const WF_FIELDS = ["sys_id", "name", "table", "description", "active"];
const VERSION_FIELDS = [
  "sys_id",
  "workflow",
  "name",
  "published",
  "sys_updated_on",
];
const ACTIVITY_FIELDS = [
  "sys_id",
  "name",
  "workflow_version",
  "activity_definition",
  "activity_definition.name",
  "order",
  "x",
  "y",
];

async function readWorkflowRuns(
  ctx: Ctx,
  wfId: string,
  limit: number,
): Promise<Run[]> {
  const rows = await read(
    ctx,
    "wf_context",
    `workflow=${wfId}^ORDERBYDESCsys_created_on`,
    ["sys_id", "name", "state", "started", "ended", "table", "id"],
    limit,
  );
  return rows.map(
    (r): Run => ({
      sys_id: str(r, "sys_id"),
      ...(opt(r, "name") ? { name: str(r, "name") } : {}),
      ...(opt(r, "state") ? { state: str(r, "state") } : {}),
      ...(opt(r, "started") ? { started: str(r, "started") } : {}),
      ...(opt(r, "ended") ? { ended: str(r, "ended") } : {}),
      ...(opt(r, "table") ? { table: str(r, "table") } : {}),
      ...(opt(r, "id") ? { record: str(r, "id") } : {}),
    }),
  );
}

const MIGRATION_NOTE =
  "Workflows still referenced by a catalog item (sc_cat_item.workflow) or an SLA definition (contract_sla.workflow), or with executing wf_context rows, are in use: move those references to a flow and let the contexts finish before retiring the workflow.";

const refOf = (r: SnRecord): Ref =>
  opt(r, "name")
    ? { sys_id: str(r, "sys_id"), name: str(r, "name") }
    : { sys_id: str(r, "sys_id") };

/** The migration report for one workflow, or (no id) for the instance. */
async function migrationReport(
  ctx: Ctx,
  wfId: string | undefined,
  wfName?: string,
): Promise<MigrationReport> {
  const scope = wfId ? `workflow=${wfId}` : "workflowISNOTEMPTY";
  const items = await read(ctx, "sc_cat_item", scope, [
    "sys_id",
    "name",
    "workflow",
  ]);
  const slas = await read(ctx, "contract_sla", scope, [
    "sys_id",
    "name",
    "workflow",
  ]);
  const running = await read(
    ctx,
    "wf_context",
    `${wfId ? `workflow=${wfId}^` : ""}state=executing`,
    ["sys_id", "workflow"],
  );
  const entries = new Map<string, MigrationEntry>();
  const entry = (id: string): MigrationEntry => {
    let e = entries.get(id);
    if (!e) {
      e = {
        sys_id: id,
        catalogItems: [],
        slaDefinitions: [],
        runningContexts: 0,
        inUse: false,
      };
      entries.set(id, e);
    }
    return e;
  };
  if (wfId) entry(wfId);
  const owner = (r: SnRecord): string | undefined => {
    const id = wfId ?? str(r, "workflow");
    return id && (!wfId || !str(r, "workflow") || str(r, "workflow") === wfId)
      ? id
      : undefined;
  };
  for (const r of items) {
    const id = owner(r);
    if (id) entry(id).catalogItems.push(refOf(r));
  }
  for (const r of slas) {
    const id = owner(r);
    if (id) entry(id).slaDefinitions.push(refOf(r));
  }
  for (const r of running) {
    const id = owner(r);
    if (id) entry(id).runningContexts++;
  }
  if (wfId && wfName) entry(wfId).name = wfName;
  if (!wfId && entries.size) {
    for (const w of await readIn(ctx, "wf_workflow", "sys_id", entries.keys(), [
      "sys_id",
      "name",
    ])) {
      const e = entries.get(str(w, "sys_id"));
      if (e && opt(w, "name")) e.name = str(w, "name");
    }
  }
  const workflows = [...entries.values()];
  for (const e of workflows) {
    e.inUse =
      e.catalogItems.length + e.slaDefinitions.length + e.runningContexts > 0;
  }
  const weight = (e: MigrationEntry): number =>
    e.catalogItems.length + e.slaDefinitions.length + e.runningContexts;
  workflows.sort(
    (a, b) =>
      weight(b) - weight(a) ||
      (a.name ?? a.sys_id).localeCompare(b.name ?? b.sys_id),
  );
  return {
    scope: wfId ? "workflow" : "instance",
    workflows,
    note: MIGRATION_NOTE,
  };
}

async function explainWorkflow(
  ctx: Ctx,
  result: ExplainFlowResult,
  sysId: string | undefined,
  runs: number,
  migration: boolean,
): Promise<ExplainFlowResult> {
  if (!sysId) {
    result.migration = await migrationReport(ctx, undefined);
    return result;
  }
  const root = await readRoot(ctx, "wf_workflow", sysId, WF_FIELDS);
  if ("unreadable" in root) return degrade(result, root.unreadable);
  const row = root.row;
  result.name = opt(row, "name");
  result.workflow = {
    sys_id: sysId,
    ...(opt(row, "name") ? { name: str(row, "name") } : {}),
    ...(opt(row, "table") ? { table: str(row, "table") } : {}),
    ...(opt(row, "description")
      ? { description: str(row, "description") }
      : {}),
    ...(bool(row, "active") !== undefined
      ? { active: bool(row, "active") }
      : {}),
  };

  const versions = await read(
    ctx,
    "wf_workflow_version",
    `workflow=${sysId}^ORDERBYDESCsys_updated_on`,
    VERSION_FIELDS,
    20,
  );
  const pub = versions.find((v) => bool(v, "published") === true);
  const chosen = pub ?? versions[0];
  if (!pub && chosen) {
    ctx.caveats.push(
      "The workflow has no published wf_workflow_version; the latest version is shown.",
    );
  }
  result.version = chosen
    ? {
        sys_id: str(chosen, "sys_id"),
        ...(opt(chosen, "name") ? { name: str(chosen, "name") } : {}),
        published: bool(chosen, "published") === true,
        ...(opt(chosen, "sys_updated_on")
          ? { updated: str(chosen, "sys_updated_on") }
          : {}),
      }
    : null;
  const versionId = result.version?.sys_id;

  let activityRows: SnRecord[] = [];
  if (versionId && SAFE_ID.test(versionId)) {
    activityRows = (
      await read(
        ctx,
        "wf_activity",
        `workflow_version=${versionId}^ORDERBYorder`,
        ACTIVITY_FIELDS,
      )
    ).filter(
      (a) =>
        !str(a, "workflow_version") || str(a, "workflow_version") === versionId,
    );
  }
  if (!activityRows.length) {
    // The registry keys activities by `workflow` (unverified, O-5).
    activityRows = await read(
      ctx,
      "wf_activity",
      `workflow=${sysId}^ORDERBYorder`,
      [...ACTIVITY_FIELDS, "workflow"],
    );
    if (activityRows.length && versionId) {
      ctx.caveats.push(
        "No wf_activity rows were found under the chosen version; activities were read by workflow instead.",
      );
    }
  }
  const activityIds = activityRows.map((a) => str(a, "sys_id"));
  const conditionRows = activityIds.length
    ? await readIn(
        ctx,
        "wf_condition",
        "activity",
        activityIds,
        ["sys_id", "activity", "name", "order"],
        "^ORDERBYorder",
      )
    : [];
  const conditions = new Map(conditionRows.map((c) => [str(c, "sys_id"), c]));
  const byActivity = new Map<string, Ref[]>();
  for (const c of conditionRows) {
    const list = byActivity.get(str(c, "activity")) ?? [];
    list.push(refOf(c));
    byActivity.set(str(c, "activity"), list);
  }
  const activities = activityRows
    .map(
      (a): WfActivity => ({
        sys_id: str(a, "sys_id"),
        name: str(a, "name") || str(a, "sys_id"),
        order: num(a, "order"),
        ...(ref(a, "activity_definition")
          ? { definition: ref(a, "activity_definition") }
          : {}),
        ...(optNum(a, "x") !== undefined ? { x: optNum(a, "x") } : {}),
        ...(optNum(a, "y") !== undefined ? { y: optNum(a, "y") } : {}),
        conditions: byActivity.get(str(a, "sys_id")) ?? [],
      }),
    )
    .sort(
      (a, b) =>
        a.order - b.order ||
        (a.y ?? 0) - (b.y ?? 0) ||
        (a.x ?? 0) - (b.x ?? 0) ||
        a.name.localeCompare(b.name),
    );
  result.activities = activities;

  const transitionRows = activityIds.length
    ? await readIn(ctx, "wf_transition", "from", activityIds, [
        "sys_id",
        "from",
        "to",
        "condition",
      ])
    : [];
  result.transitions = transitionRows.map((t): WfTransition => {
    const cid = str(t, "condition");
    const c = cid ? conditions.get(cid) : undefined;
    return {
      sys_id: str(t, "sys_id"),
      from: str(t, "from"),
      to: str(t, "to"),
      ...(cid ? { condition: c ? refOf(c) : { sys_id: cid } } : {}),
    };
  });
  const known = new Set(activityIds);
  const dangling = result.transitions.filter((t) => !known.has(t.to)).length;
  if (dangling) {
    ctx.caveats.push(
      `${dangling} transition(s) lead to an activity that was not read; the diagram shows it by sys_id.`,
    );
  }

  result.stages =
    versionId && SAFE_ID.test(versionId)
      ? (
          await read(
            ctx,
            "wf_stage",
            `workflow_version=${versionId}^ORDERBYorder`,
            ["sys_id", "name", "value", "order", "duration"],
          )
        ).map(stage)
      : [];

  if (runs > 0) result.runs = await readWorkflowRuns(ctx, sysId, runs);
  if (migration) {
    result.migration = await migrationReport(ctx, sysId, result.name);
  }
  result.counts = {
    ...result.counts,
    stages: result.stages.length,
    activities: activities.length,
    transitions: result.transitions.length,
    runs: result.runs?.length ?? 0,
  };
  return result;
}

// --- actions and calls (P-11) ----------------------------------------------------

const ACTION_FIELDS = [
  "sys_id",
  "name",
  "internal_name",
  "category",
  "access",
  "active",
  "description",
];

const ACTION_STEP_FIELDS = [
  "sys_id",
  "action",
  "order",
  "label",
  "comment",
  "step_type",
  "step_type.name",
  "values",
];

const ACTION_VAR_FIELDS = [...VAR_FIELDS, "name"];

/** The sys_hub_step_instance steps of each action, by `order`. */
async function readActionSteps(
  ctx: Ctx,
  actionIds: string[],
): Promise<Map<string, FlowStep[]>> {
  if (!ctx.caveats.includes(ACTION_CAVEAT)) ctx.caveats.push(ACTION_CAVEAT);
  const rows = await readIn(
    ctx,
    "sys_hub_step_instance",
    "action",
    actionIds,
    ACTION_STEP_FIELDS,
    "^ORDERBYorder",
  );
  const out = new Map<string, FlowStep[]>();
  for (const row of rows) {
    const r = ref(row, "step_type");
    const values = decodeValues(str(row, "values"), new Map());
    const list = out.get(str(row, "action")) ?? [];
    list.push({
      number: "",
      kind: "step",
      source: "sys_hub_step_instance",
      sys_id: str(row, "sys_id"),
      order: num(row, "order"),
      name: opt(row, "label") ?? r?.name ?? r?.sys_id ?? "(step)",
      ...(r ? { ref: r } : {}),
      ...(opt(row, "comment") ? { comment: str(row, "comment") } : {}),
      ...(values ? { values } : {}),
      children: [],
    });
    out.set(str(row, "action"), list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => a.order - b.order);
    list.forEach((s, i) => {
      s.number = `${i + 1}`;
    });
  }
  return out;
}

interface Call {
  step: FlowStep;
  kind: "action" | "subflow";
  id: string;
  /** Callee ids from the root down to the step's owner. */
  path: string[];
}

/** The action / subflow calls in a step tree. */
function callsIn(steps: FlowStep[], path: string[]): Call[] {
  const out: Call[] = [];
  for (const step of allSteps(steps)) {
    const id = step.ref?.sys_id;
    if (
      (step.kind === "action" || step.kind === "subflow") &&
      id &&
      SAFE_ID.test(id)
    ) {
      out.push({ step, kind: step.kind, id, path });
    }
  }
  return out;
}

/**
 * Resolve the calls of a step tree `depth` levels down: action steps get the
 * action's step instances, subflow steps the subflow's own step tree. Each
 * callee is read once (level by level, actions in one IN read) and shared
 * between its call sites; a callee on its own call path is marked as a
 * cycle. Returns the number of distinct callees expanded.
 */
async function expandCalls(
  ctx: Ctx,
  steps: FlowStep[],
  rootId: string,
  depth: number,
): Promise<number> {
  const memo = new Map<string, Callee>();
  let frontier = depth > 0 ? callsIn(steps, [rootId]) : [];
  let cycles = 0;
  let skipped = 0;
  for (let level = 1; level <= depth && frontier.length; level++) {
    const live = frontier.filter((c) => {
      if (!c.path.includes(c.id)) return true;
      c.step.callee = {
        kind: c.kind,
        sys_id: c.id,
        ...(c.step.ref?.name ? { name: c.step.ref.name } : {}),
        steps: [],
        cycle: true,
      };
      cycles++;
      return false;
    });
    // New callees, capped at CALLEES_MAX distinct ones.
    const fresh = new Map<string, Call>();
    for (const c of live) {
      const key = `${c.kind}:${c.id}`;
      if (memo.has(key) || fresh.has(key)) continue;
      if (memo.size + fresh.size >= CALLEES_MAX) continue;
      fresh.set(key, c);
    }
    const actions = [...fresh.values()].filter((c) => c.kind === "action");
    const subflows = [...fresh.values()].filter((c) => c.kind === "subflow");
    const actionSteps = actions.length
      ? await readActionSteps(
          ctx,
          actions.map((c) => c.id),
        )
      : new Map<string, FlowStep[]>();
    for (const c of actions) {
      memo.set(`action:${c.id}`, {
        kind: "action",
        sys_id: c.id,
        ...(c.step.ref?.name ? { name: c.step.ref.name } : {}),
        steps: actionSteps.get(c.id) ?? [],
      });
    }
    const flows = new Map(
      (
        await readIn(
          ctx,
          "sys_hub_flow",
          "sys_id",
          subflows.map((c) => c.id),
          ["sys_id", "name", "label_cache"],
        )
      ).map((r) => [str(r, "sys_id"), r]),
    );
    for (const c of subflows) {
      const row = flows.get(c.id);
      const labels = pillLabels(row ? str(row, "label_cache") : "");
      const name = (row && opt(row, "name")) ?? c.step.ref?.name;
      memo.set(`subflow:${c.id}`, {
        kind: "subflow",
        sys_id: c.id,
        ...(name ? { name } : {}),
        steps: buildTree(ctx, await readSteps(ctx, c.id), labels),
      });
    }
    // Attach; a callee's own calls go one level further, once.
    const next: Call[] = [];
    for (const c of live) {
      const callee = memo.get(`${c.kind}:${c.id}`);
      if (!callee) {
        skipped++;
        continue;
      }
      c.step.callee = callee;
      if (fresh.get(`${c.kind}:${c.id}`) === c) {
        next.push(...callsIn(callee.steps, [...c.path, c.id]));
      }
    }
    frontier = next;
  }
  if (cycles) {
    ctx.caveats.push(
      `${cycles} call(s) reach a subflow / action already on their call path (a cycle); they are marked cycle:true and not expanded.`,
    );
  }
  if (skipped) {
    ctx.caveats.push(
      `Only ${CALLEES_MAX} distinct callees are expanded; ${skipped} further call(s) are not.`,
    );
  }
  if (frontier.length) {
    ctx.caveats.push(
      `${frontier.length} call(s) nested deeper than depth ${depth} are not expanded (max ${EXPLAIN_FLOW_DEPTH.max}).`,
    );
  }
  return memo.size;
}

async function explainActionDefinition(
  ctx: Ctx,
  result: ExplainFlowResult,
  sysId: string,
): Promise<ExplainFlowResult> {
  ctx.caveats.push(ACTION_CAVEAT);
  const root = await readRoot(
    ctx,
    "sys_hub_action_type_definition",
    sysId,
    ACTION_FIELDS,
  );
  if ("unreadable" in root) return degrade(result, root.unreadable);
  const row = root.row;
  result.name = opt(row, "name");
  result.action = {
    sys_id: sysId,
    ...(opt(row, "name") ? { name: str(row, "name") } : {}),
    ...(opt(row, "internal_name")
      ? { internal_name: str(row, "internal_name") }
      : {}),
    ...(opt(row, "category") ? { category: str(row, "category") } : {}),
    ...(opt(row, "access") ? { access: str(row, "access") } : {}),
    ...(bool(row, "active") !== undefined
      ? { active: bool(row, "active") }
      : {}),
    ...(opt(row, "description")
      ? { description: str(row, "description") }
      : {}),
  };
  result.inputs = await readVariables(
    ctx,
    "sys_hub_action_input",
    sysId,
    ACTION_VAR_FIELDS,
  );
  result.outputs = await readVariables(
    ctx,
    "sys_hub_action_output",
    sysId,
    ACTION_VAR_FIELDS,
  );
  result.steps = (await readActionSteps(ctx, [sysId])).get(sysId) ?? [];
  result.counts = {
    ...result.counts,
    steps: result.steps.length,
    inputs: result.inputs.length,
    outputs: result.outputs.length,
  };
  return result;
}

// --- playbooks (P-12) ------------------------------------------------------------

const PD_FIELDS = [
  "sys_id",
  "label",
  "name",
  "table",
  "status",
  "active",
  "description",
];

const LANE_FIELDS = [
  "sys_id",
  "process_definition",
  "label",
  "name",
  "order",
  "condition",
];

const PD_ACTIVITY_FIELDS = [
  "sys_id",
  "lane",
  "label",
  "name",
  "order",
  "activity_definition",
  "condition",
];

const PD_TRIGGER_FIELDS = [
  "sys_id",
  "process_definition",
  "name",
  "trigger_definition",
  "trigger_definition.name",
  "trigger_type",
  "table",
  "condition",
];

const TIMER_FIELDS = ["sys_id", "activity", "name", "type", "duration"];

const VARIANT_FIELDS = [
  "sys_id",
  "process_definition",
  "label",
  "name",
  "active",
  "condition",
  "order",
];

const PD_VAR_FIELDS = [...VAR_FIELDS, "name"];

/** `label`, else `name`, else the sys_id. */
const labelOf = (row: SnRecord): string =>
  opt(row, "label") ?? opt(row, "name") ?? str(row, "sys_id");

async function readPlaybookRuns(
  ctx: Ctx,
  pdId: string,
  limit: number,
): Promise<Run[]> {
  const rows = await read(
    ctx,
    "sys_pd_context",
    `process_definition=${pdId}^ORDERBYDESCsys_created_on`,
    ["sys_id", "name", "state", "sys_created_on", "ended", "table", "document"],
    limit,
  );
  const runs = rows.map(
    (r): Run => ({
      sys_id: str(r, "sys_id"),
      ...(opt(r, "name") ? { name: str(r, "name") } : {}),
      ...(opt(r, "state") ? { state: str(r, "state") } : {}),
      ...(opt(r, "sys_created_on")
        ? { started: str(r, "sys_created_on") }
        : {}),
      ...(opt(r, "ended") ? { ended: str(r, "ended") } : {}),
      ...(opt(r, "table") ? { table: str(r, "table") } : {}),
      ...(opt(r, "document") ? { record: str(r, "document") } : {}),
    }),
  );
  if (!runs.length) return runs;
  const acts = await readIn(
    ctx,
    "sys_pd_activity_context",
    "context",
    runs.map((r) => r.sys_id),
    ["sys_id", "context", "state"],
  );
  const byRun = new Map(runs.map((r) => [r.sys_id, r]));
  for (const a of acts) {
    const run = byRun.get(str(a, "context"));
    if (!run) continue;
    const state = opt(a, "state") ?? "unknown";
    const states = (run.activityStates ??= {});
    states[state] = (states[state] ?? 0) + 1;
  }
  return runs;
}

async function explainPlaybook(
  ctx: Ctx,
  result: ExplainFlowResult,
  sysId: string,
  runs: number,
): Promise<ExplainFlowResult> {
  const root = await readRoot(
    ctx,
    "sys_pd_process_definition",
    sysId,
    PD_FIELDS,
  );
  if ("unreadable" in root) {
    // An absent (unlicensed) family answers 400 "invalid table" or is
    // missing from sys_db_object: say so plainly (O-9).
    const out = await degrade(result, root.unreadable);
    if (out.available === false || root.unreadable.status === 400) {
      out.available = false;
      ctx.caveats.push(PLAYBOOK_UNAVAILABLE);
    }
    return out;
  }
  const row = root.row;
  const name = labelOf(row);
  result.name = name;
  result.playbook = {
    sys_id: sysId,
    name,
    ...(opt(row, "label") && opt(row, "name")
      ? { internal_name: str(row, "name") }
      : {}),
    ...(opt(row, "table") ? { table: str(row, "table") } : {}),
    ...(opt(row, "status") ? { status: str(row, "status") } : {}),
    ...(bool(row, "active") !== undefined
      ? { active: bool(row, "active") }
      : {}),
    ...(opt(row, "description")
      ? { description: str(row, "description") }
      : {}),
  };

  const laneRows = (
    await read(
      ctx,
      "sys_pd_lane",
      `process_definition=${sysId}^ORDERBYorder`,
      LANE_FIELDS,
    )
  ).sort((a, b) => num(a, "order") - num(b, "order"));
  const activityRows = laneRows.length
    ? await readIn(
        ctx,
        "sys_pd_activity",
        "lane",
        laneRows.map((l) => str(l, "sys_id")),
        PD_ACTIVITY_FIELDS,
        "^ORDERBYorder",
      )
    : [];
  const defIds = activityRows
    .map((a) => str(a, "activity_definition"))
    .filter(Boolean);
  const defs = new Map(
    (defIds.length
      ? await readIn(ctx, "sys_pd_activity_definition", "sys_id", defIds, [
          "sys_id",
          "label",
          "name",
        ])
      : []
    ).map((d) => [str(d, "sys_id"), labelOf(d)]),
  );
  const activityIds = activityRows.map((a) => str(a, "sys_id"));
  const timers = (
    activityIds.length
      ? await readIn(
          ctx,
          "sys_pd_timer_attributes",
          "activity",
          activityIds,
          TIMER_FIELDS,
        )
      : []
  ).map(
    (t): PdTimer => ({
      sys_id: str(t, "sys_id"),
      activity: str(t, "activity"),
      ...(opt(t, "name") ? { name: str(t, "name") } : {}),
      ...(opt(t, "type") ? { type: str(t, "type") } : {}),
      ...(opt(t, "duration") ? { duration: str(t, "duration") } : {}),
    }),
  );
  // Read by `activity IN (...)`, so every timer belongs to one activity.
  const timersOf = new Map<string, PdTimer[]>();
  for (const t of timers) {
    const list = timersOf.get(t.activity!) ?? [];
    list.push(t);
    timersOf.set(t.activity!, list);
  }

  const byLane = new Map<string, SnRecord[]>();
  for (const a of activityRows) {
    const list = byLane.get(str(a, "lane")) ?? [];
    list.push(a);
    byLane.set(str(a, "lane"), list);
  }
  result.lanes = laneRows.map((l, i): PdLane => {
    const number = `${i + 1}`;
    const acts = (byLane.get(str(l, "sys_id")) ?? []).sort(
      (a, b) =>
        num(a, "order") - num(b, "order") ||
        labelOf(a).localeCompare(labelOf(b)),
    );
    return {
      number,
      sys_id: str(l, "sys_id"),
      name: labelOf(l),
      order: num(l, "order"),
      ...(opt(l, "condition") ? { condition: str(l, "condition") } : {}),
      activities: acts.map((a, j): PdActivity => {
        const defId = str(a, "activity_definition");
        const defName = defs.get(defId);
        const own = timersOf.get(str(a, "sys_id"));
        return {
          number: `${number}.${j + 1}`,
          sys_id: str(a, "sys_id"),
          name: labelOf(a),
          order: num(a, "order"),
          ...(defId
            ? {
                definition: defName
                  ? { sys_id: defId, name: defName }
                  : { sys_id: defId },
              }
            : {}),
          ...(opt(a, "condition") ? { condition: str(a, "condition") } : {}),
          ...(own ? { timers: own } : {}),
        };
      }),
    };
  });

  result.triggers = (
    await read(
      ctx,
      "sys_pd_trigger_instance",
      `process_definition=${sysId}`,
      PD_TRIGGER_FIELDS,
    )
  ).map(
    (t): PdTrigger => ({
      sys_id: str(t, "sys_id"),
      ...(opt(t, "name") ? { name: str(t, "name") } : {}),
      ...(ref(t, "trigger_definition")
        ? { definition: ref(t, "trigger_definition") }
        : {}),
      ...(opt(t, "trigger_type") ? { type: str(t, "trigger_type") } : {}),
      ...(opt(t, "table") ? { table: str(t, "table") } : {}),
      ...(opt(t, "condition") ? { condition: str(t, "condition") } : {}),
    }),
  );
  result.inputs = await readVariables(
    ctx,
    "sys_pd_process_input",
    sysId,
    PD_VAR_FIELDS,
  );
  result.outputs = await readVariables(
    ctx,
    "sys_pd_process_output",
    sysId,
    PD_VAR_FIELDS,
  );
  result.variants = (
    await read(
      ctx,
      "sys_pd_process_variant",
      `process_definition=${sysId}^ORDERBYorder`,
      VARIANT_FIELDS,
    )
  ).map(
    (v): PdVariant => ({
      sys_id: str(v, "sys_id"),
      name: labelOf(v),
      ...(bool(v, "active") !== undefined ? { active: bool(v, "active") } : {}),
      ...(opt(v, "condition") ? { condition: str(v, "condition") } : {}),
      ...(optNum(v, "order") !== undefined
        ? { order: optNum(v, "order") }
        : {}),
    }),
  );
  if (runs > 0) result.runs = await readPlaybookRuns(ctx, sysId, runs);

  result.counts = {
    ...result.counts,
    activities: activityRows.length,
    inputs: result.inputs.length,
    outputs: result.outputs.length,
    runs: result.runs?.length ?? 0,
    lanes: result.lanes.length,
    triggers: result.triggers.length,
    timers: timers.length,
    variants: result.variants.length,
  };
  return result;
}

// --- entry point ---------------------------------------------------------------

/**
 * Explain a Flow Designer flow / subflow as a step tree, a custom action, a
 * legacy workflow as an activity graph (with an optional migration report)
 * or a playbook as lanes of activities.
 */
export async function explainFlow(
  opts: ExplainFlowOptions,
): Promise<ExplainFlowResult> {
  const kind = opts.kind ?? "flow";
  const sysId = opts.sys_id?.trim() || undefined;
  if (sysId === undefined && !(kind === "workflow" && opts.migration)) {
    throw new ServiceNowError(
      "Pass 'sys_id' (a sys_hub_flow, sys_hub_action_type_definition, wf_workflow or sys_pd_process_definition sys_id). Only kind:'workflow' with migration:true runs without one (the instance-wide migration report).",
      400,
    );
  }
  if (sysId !== undefined && !SAFE_ID.test(sysId)) {
    throw new ServiceNowError(`Invalid sys_id '${sysId}'.`, 400);
  }
  const runs = Math.min(
    Math.max(Math.trunc(opts.runs ?? 0), 0),
    EXPLAIN_FLOW_RUNS.max,
  );
  const depth = Math.min(
    Math.max(Math.trunc(opts.depth ?? EXPLAIN_FLOW_DEPTH.default), 0),
    EXPLAIN_FLOW_DEPTH.max,
  );
  const ctx: Ctx = {
    caveats: [
      kind === "workflow"
        ? WORKFLOW_CAVEAT
        : kind === "playbook"
          ? PLAYBOOK_CAVEAT
          : FLOW_CAVEAT,
    ],
    unreadable: [],
    missing: {},
    progress: trackProgress(),
  };
  const result: ExplainFlowResult = {
    kind,
    ...(sysId ? { sys_id: sysId } : {}),
    counts: {
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
    },
    verified: false,
    caveats: ctx.caveats,
    unreadable: ctx.unreadable,
  };
  if (kind === "playbook" && opts.depth !== undefined) {
    ctx.caveats.push("depth applies to flows / subflows only; it was ignored.");
  }
  if (kind !== "workflow" && opts.migration) {
    ctx.caveats.push(
      "migration applies to kind:'workflow' only; it was ignored.",
    );
  }
  if (kind === "action" && runs > 0) {
    ctx.caveats.push(
      "runs applies to flows / subflows / workflows only; it was ignored.",
    );
  }
  const out =
    kind === "workflow"
      ? await explainWorkflow(ctx, result, sysId, runs, !!opts.migration)
      : kind === "action"
        ? await explainActionDefinition(ctx, result, sysId!)
        : kind === "playbook"
          ? await explainPlaybook(ctx, result, sysId!, runs)
          : await explainFlowDefinition(ctx, result, sysId!, kind, runs, depth);
  if (Object.keys(ctx.missing).length) out.missingFields = ctx.missing;
  return out;
}

// --- renderers -------------------------------------------------------------------

const STEP_SHAPE: Record<StepKind, Shape> = {
  action: "rect",
  logic: "input",
  subflow: "db",
  step: "rect",
};

const HEADER: Record<Exclude<ExplainFlowKind, "workflow">, string> = {
  flow: "Flow",
  subflow: "Subflow",
  action: "Action",
  playbook: "Playbook",
};

const pdTriggerText = (t: PdTrigger): string =>
  `Trigger: ${t.name ?? t.definition?.name ?? t.type ?? t.definition?.sys_id ?? t.sys_id}${t.table ? ` · ${t.table}` : ""}`;

const timerText = (t: PdTimer): string =>
  `timer ${t.name ?? t.type ?? t.sys_id}${t.duration ? ` (${t.duration})` : ""}`;

/**
 * A playbook as Mermaid: the header, its triggers, and one subgraph per lane
 * holding that lane's activities chained by `order`. Lanes start from the
 * header with dotted edges — lane conditions and parallelism are not modelled
 * (unverified, O-5).
 */
function playbookMermaid(
  doc: MermaidDoc,
  result: ExplainFlowResult,
): { mermaid: string; truncated: number } {
  doc.node(
    "pb",
    label(`Playbook: ${result.playbook?.name ?? result.sys_id ?? ""}`, 100),
    "rect",
    { pinned: true },
  );
  (result.triggers ?? []).forEach((t, i) => {
    doc.edgeTo("pb", `t${i + 1}`, label(pdTriggerText(t), 100), {
      shape: "input",
      pinned: true,
    });
  });
  for (const lane of result.lanes ?? []) {
    const lid = `lane_${ident(lane.sys_id)}`;
    doc.open(lid, label(`${lane.number} ${lane.name}`, 80), "TB");
    let prev: string | undefined;
    for (const a of lane.activities) {
      const aid = `act_${ident(a.sys_id)}`;
      const text = `${a.number} ${a.name}${a.definition?.name ? ` · ${a.definition.name}` : ""}${a.timers?.length ? ` · ${a.timers.length} timer(s)` : ""}`;
      if (!doc.node(aid, label(text, 100))) continue;
      if (prev) doc.edge(prev, aid);
      prev = aid;
    }
    doc.close();
    doc.edge("pb", lid, "-.->");
  }
  return { mermaid: doc.render(), truncated: doc.truncated };
}

const calleeText = (c: Callee): string =>
  `${c.kind === "action" ? "Action" : "Subflow"}: ${c.name ?? c.sys_id}`;

const stepText = (s: FlowStep): string =>
  `${s.number} ${s.kind === "subflow" ? "Subflow: " : ""}${s.name}${s.comment ? ` · ${s.comment}` : ""}`;

const triggerText = (t: FlowTrigger): string =>
  `Trigger: ${t.definition?.name ?? t.type ?? t.definition?.sys_id ?? "unknown"}${t.table ? ` · ${t.table}` : ""}`;

/**
 * The flow as a Mermaid tree (flow → trigger → steps, logic blocks holding
 * their children) or the workflow as its activity graph with one edge per
 * wf_transition row. Capped by SN_DIAGRAM_MAX_NODES; `truncated` counts the
 * dropped nodes.
 */
export function flowMermaid(result: ExplainFlowResult): {
  mermaid: string;
  truncated: number;
} {
  const doc = new MermaidDoc("flowchart TD");
  if (result.kind === "playbook") return playbookMermaid(doc, result);
  if (result.kind === "workflow") {
    const emitted = new Set<string>();
    const nodeId = (id: string): string => `a_${ident(id)}`;
    doc.node(
      "wf",
      label(
        `Workflow: ${result.workflow?.name ?? result.sys_id ?? "instance"}`,
        100,
      ),
      "rect",
      { pinned: true },
    );
    const first = result.activities?.[0];
    if (first && doc.node(nodeId(first.sys_id), label(first.name, 80))) {
      emitted.add(first.sys_id);
      doc.edge("wf", nodeId(first.sys_id), "-.->");
    }
    for (const a of (result.activities ?? []).slice(1)) {
      if (doc.node(nodeId(a.sys_id), label(a.name, 80))) emitted.add(a.sys_id);
    }
    for (const t of result.transitions ?? []) {
      for (const end of [t.from, t.to]) {
        if (
          !emitted.has(end) &&
          !result.activities?.some((a) => a.sys_id === end)
        ) {
          if (doc.node(nodeId(end), label(`Activity ${end}`, 80))) {
            emitted.add(end);
          }
        }
      }
      if (!emitted.has(t.from) || !emitted.has(t.to)) continue;
      const cond = t.condition?.name;
      doc.line(
        cond
          ? `${nodeId(t.from)} -->|"${label(cond, 60)}"| ${nodeId(t.to)}`
          : `${nodeId(t.from)} --> ${nodeId(t.to)}`,
      );
    }
    return { mermaid: doc.render(), truncated: doc.truncated };
  }
  doc.node(
    "flow",
    label(
      `${HEADER[result.kind]}: ${result.flow?.name ?? result.action?.name ?? result.sys_id ?? ""}`,
      100,
    ),
    "rect",
    { pinned: true },
  );
  let root = "flow";
  if (result.trigger) {
    doc.edgeTo("flow", "trigger", label(triggerText(result.trigger), 100), {
      shape: "input",
      pinned: true,
    });
    root = "trigger";
  }
  // Callee steps hang off the calling step with dotted edges; a callee
  // shared by several call sites renders once per site (numbered ids).
  let called = 0;
  const walk = (
    from: string,
    list: FlowStep[],
    id: (s: FlowStep) => string,
    arrow: Arrow = "-->",
  ): void => {
    for (const s of list) {
      const sid = id(s);
      doc.edgeTo(from, sid, label(stepText(s), 100), {
        arrow,
        shape: STEP_SHAPE[s.kind],
      });
      walk(sid, s.children, id);
      const c = s.callee;
      if (!c) continue;
      const site = `c${++called}`;
      if (c.cycle) {
        doc.edgeTo(sid, site, label(`${calleeText(c)} (cycle)`, 100), {
          arrow: "-.->",
          shape: "input",
        });
      } else {
        walk(sid, c.steps, (x) => `${site}_${ident(x.sys_id)}`, "-.->");
      }
    }
  };
  walk(root, result.steps ?? [], (s) => `s_${ident(s.sys_id)}`);
  return { mermaid: doc.render(), truncated: doc.truncated };
}

const fmt = (v: unknown): string => {
  const text = typeof v === "string" ? v : JSON.stringify(v);
  const one = (text ?? "").replace(/[\r\n]+/g, " ");
  return one.length > 120 ? `${one.slice(0, 117)}...` : one;
};

function valuesLines(v: DecodedValues | undefined, indent: string): string[] {
  if (!v) return [];
  if (!v.decoded) {
    return [`${indent}- _values not decoded (${v.bytes} bytes): ${v.reason}_`];
  }
  const out: string[] = [];
  for (const i of v.inputs ?? []) {
    const pills = (i.pills ?? [])
      .map((p) => `${p.pill}${p.label ? ` = ${p.label}` : ""}`)
      .join("; ");
    out.push(
      `${indent}- ${i.label ?? i.name} = ${fmt(i.displayValue ?? i.value)}${pills ? ` _(pills: ${pills})_` : ""}`,
    );
  }
  if (v.inputsOmitted)
    out.push(`${indent}- _+${v.inputsOmitted} more input(s)_`);
  if (v.value !== undefined) out.push(`${indent}- ${fmt(v.value)}`);
  return out;
}

function variablesTable(
  title: string,
  list: FlowVariable[] | undefined,
): string[] {
  if (!list?.length) return [];
  const out = [
    "",
    `## ${title}`,
    "",
    "| Name | Label | Type | Mandatory |",
    "| --- | --- | --- | --- |",
  ];
  for (const v of list) {
    out.push(
      `| ${v.element} | ${v.label ?? ""} | ${v.type ?? ""} | ${v.mandatory ? "yes" : ""} |`,
    );
  }
  return out;
}

function runLines(runs: Run[] | undefined): string[] {
  if (!runs) return [];
  const out = ["", "## Latest runs", ""];
  if (!runs.length) out.push("_No runs found._");
  for (const r of runs) {
    out.push(
      `- ${r.started ?? "?"} · ${r.state ?? "?"}${r.table ? ` · ${r.table}` : ""}${r.record ? ` ${r.record}` : ""} (${r.sys_id})`,
    );
    for (const e of r.errors ?? []) out.push(`  - error: ${fmt(e.message)}`);
  }
  return out;
}

function migrationLines(m: MigrationReport | undefined): string[] {
  if (!m) return [];
  const out = ["", `## Migration report (${m.scope})`, "", m.note, ""];
  if (!m.workflows.length) out.push("_No workflow is referenced or running._");
  for (const w of m.workflows) {
    out.push(
      `- **${w.name ?? w.sys_id}**: ${w.inUse ? "in use" : "not referenced"} — ${w.catalogItems.length} catalog item(s), ${w.slaDefinitions.length} SLA definition(s), ${w.runningContexts} running context(s)`,
    );
    for (const c of w.catalogItems)
      out.push(`  - catalog item ${c.name ?? c.sys_id}`);
    for (const s of w.slaDefinitions) out.push(`  - SLA ${s.name ?? s.sys_id}`);
  }
  return out;
}

/** The playbook part of the Markdown report (header to runs). */
function playbookLines(result: ExplainFlowResult): string[] {
  const p = result.playbook;
  const c = result.counts;
  const out = [`# Playbook ${p?.name ?? result.sys_id}`, ""];
  if (!p) {
    out.push(
      result.available === false
        ? "_Process Automation Designer is not available on this instance._"
        : "_The playbook could not be read._",
    );
    return out;
  }
  out.push(
    `${c.lanes ?? 0} lane(s), ${c.activities} activity(ies), ${c.triggers ?? 0} trigger(s), ${c.timers ?? 0} timer(s), ${c.variants ?? 0} variant(s). verified:false.`,
    "",
  );
  if (p.internal_name) out.push(`- Internal name: ${p.internal_name}`);
  if (p.table) out.push(`- Table: ${p.table}`);
  if (p.status) out.push(`- Status: ${p.status}`);
  if (p.active !== undefined) out.push(`- Active: ${p.active}`);
  if (p.description) out.push(`- Description: ${fmt(p.description)}`);
  if (result.triggers?.length) {
    out.push("", "## Triggers", "");
    for (const t of result.triggers) {
      out.push(
        `- ${pdTriggerText(t)}${t.condition ? ` · condition: ${fmt(t.condition)}` : ""}`,
      );
    }
  }
  out.push("", "## Lanes", "");
  if (!result.lanes?.length) out.push("_No lanes found._");
  for (const lane of result.lanes ?? []) {
    out.push(
      `- **${lane.number} ${lane.name}**${lane.condition ? ` · condition: ${fmt(lane.condition)}` : ""}`,
    );
    if (!lane.activities.length) out.push("  - _No activities._");
    for (const a of lane.activities) {
      out.push(
        `  - ${a.number} ${a.name}${a.definition ? ` _(${a.definition.name ?? a.definition.sys_id})_` : ""}${a.condition ? ` · condition: ${fmt(a.condition)}` : ""}`,
      );
      for (const t of a.timers ?? []) out.push(`    - ${timerText(t)}`);
    }
  }
  out.push(
    ...variablesTable("Inputs", result.inputs),
    ...variablesTable("Outputs", result.outputs),
  );
  if (result.variants?.length) {
    out.push("", "## Variants", "");
    for (const v of result.variants) {
      out.push(
        `- ${v.name}${v.active === false ? " (inactive)" : ""}${v.condition ? ` · condition: ${fmt(v.condition)}` : ""}`,
      );
    }
  }
  const runs = runLines(result.runs);
  for (const r of result.runs ?? []) {
    const states = Object.entries(r.activityStates ?? {});
    if (!states.length) continue;
    const at = runs.findIndex((l) => l.endsWith(`(${r.sys_id})`));
    runs.splice(
      at + 1,
      0,
      `  - activities: ${states.map(([s, n]) => `${s} ${n}`).join(", ")}`,
    );
  }
  out.push(...runs);
  return out;
}

/** A readable report: header, trigger, steps / activities, diagram, caveats. */
export function flowMarkdown(
  result: ExplainFlowResult,
  mermaid: string,
): string {
  const out: string[] = [];
  const c = result.counts;
  if (result.kind === "workflow") {
    const w = result.workflow;
    out.push(
      `# Workflow ${w?.name ?? result.sys_id ?? "(instance migration report)"}`,
      "",
    );
    if (w) {
      out.push(
        `${c.activities} activity(ies), ${c.transitions} transition(s), ${c.stages} stage(s). verified:false.`,
      );
      if (w.table) out.push("", `- Table: ${w.table}`);
      if (w.active !== undefined) out.push(`- Active: ${w.active}`);
      if (result.version) {
        out.push(
          `- Version: ${result.version.name ?? result.version.sys_id}${result.version.published ? " (published)" : " (not published)"}`,
        );
      }
      out.push("", "## Activities", "");
      const names = new Map(
        (result.activities ?? []).map((a) => [a.sys_id, a.name]),
      );
      for (const a of result.activities ?? []) {
        out.push(
          `- **${a.name}**${a.definition?.name ? ` (${a.definition.name})` : ""}`,
        );
        for (const t of (result.transitions ?? []).filter(
          (x) => x.from === a.sys_id,
        )) {
          out.push(
            `  - ${t.condition?.name ?? "→"} → ${names.get(t.to) ?? t.to}`,
          );
        }
      }
      if (result.stages?.length) {
        out.push("", "## Stages", "");
        for (const s of result.stages)
          out.push(`- ${s.label}${s.value ? ` (${s.value})` : ""}`);
      }
    }
    out.push(...runLines(result.runs), ...migrationLines(result.migration));
  } else if (result.kind === "playbook") {
    out.push(...playbookLines(result));
  } else {
    const f = result.flow;
    const a = result.action;
    out.push(
      `# ${HEADER[result.kind]} ${f?.name ?? a?.name ?? result.sys_id}`,
      "",
    );
    out.push(
      result.kind === "action"
        ? `${c.steps} step(s), ${c.inputs} input(s), ${c.outputs} output(s). verified:false.`
        : `${c.steps} step(s): ${c.actions} action(s), ${c.logic} logic, ${c.subflows} subflow call(s)${c.callees ? `; ${c.callees} callee(s) expanded` : ""}. verified:false.`,
    );
    if (a) {
      out.push("");
      if (a.internal_name) out.push(`- Internal name: ${a.internal_name}`);
      if (a.category) out.push(`- Category: ${a.category}`);
      if (a.access) out.push(`- Access: ${a.access}`);
      if (a.active !== undefined) out.push(`- Active: ${a.active}`);
      if (a.description) out.push(`- Description: ${fmt(a.description)}`);
    }
    if (f) {
      out.push("");
      if (f.status) out.push(`- Status: ${f.status}`);
      if (f.active !== undefined) out.push(`- Active: ${f.active}`);
      if (f.run_as) out.push(`- Run as: ${f.run_as}`);
      if (f.run_with_roles.length) {
        out.push(
          `- Run with roles: ${f.run_with_roles.map((r) => r.name ?? r.sys_id).join(", ")}`,
        );
      }
      const p = result.published;
      if (p) {
        out.push(
          `- Published: ${p.basis === "never-published" ? "never" : p.draftDiffers ? "yes — the draft differs" : "yes — the draft matches"}`,
        );
      }
    }
    if (result.trigger) {
      out.push("", "## Trigger", "", `- ${triggerText(result.trigger)}`);
      if (result.trigger.condition)
        out.push(`- Condition: ${result.trigger.condition}`);
      out.push(...valuesLines(result.trigger.values, ""));
    }
    out.push("", "## Steps", "");
    const steps = (list: FlowStep[], indent: string): void => {
      for (const s of list) {
        out.push(`${indent}- **${stepText(s)}** _(${s.kind})_`);
        out.push(...valuesLines(s.values, `${indent}  `));
        steps(s.children, `${indent}  `);
        if (s.childrenOmitted)
          out.push(
            `${indent}  - _${s.childrenOmitted} nested step(s) not expanded_`,
          );
        const callee = s.callee;
        if (callee) {
          out.push(
            `${indent}  - ↳ calls ${calleeText(callee)}${callee.cycle ? " _(cycle — not expanded)_" : callee.steps.length ? "" : " _(no steps found)_"}`,
          );
          if (!callee.cycle) steps(callee.steps, `${indent}    `);
        }
      }
    };
    if (!result.steps?.length) out.push("_No steps found._");
    steps(result.steps ?? [], "");
    out.push(
      ...variablesTable("Inputs", result.inputs),
      ...variablesTable("Outputs", result.outputs),
      ...variablesTable("Variables", result.variables),
    );
    if (result.stages?.length) {
      out.push("", "## Stages", "");
      for (const s of result.stages)
        out.push(`- ${s.label}${s.value ? ` (${s.value})` : ""}`);
    }
    out.push(...runLines(result.runs));
  }
  if (result.kind !== "workflow" || result.workflow) {
    out.push("", "## Diagram", "", "```mermaid", mermaid, "```");
  }
  out.push("", "## Caveats", "");
  for (const cav of result.caveats) out.push(`- ${cav}`);
  for (const [table, fields] of Object.entries(result.missingFields ?? {})) {
    out.push(`- ${table}: fields not returned: ${fields.join(", ")}`);
  }
  return out.join("\n");
}
