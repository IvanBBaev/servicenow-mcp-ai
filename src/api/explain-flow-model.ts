/**
 * `explain_flow` result model: bounds, caveats and the result shapes shared
 * by the per-kind readers and the renderers in `src/api/explain-flow.ts`.
 */
import { type Unreadable } from "./bounded-read.js";

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

/** A record id safe to splice into an encoded query. */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const FLOW_CAVEAT =
  "Flow Designer tables are verified:false: which of the v1 / _v2 instance tables is authoritative per release, the values compression format, snapshot child-row keying and the label_cache shape have not been confirmed on a live instance (gate O-5).";

export const WORKFLOW_CAVEAT =
  "Legacy workflow tables are verified:false: their table and field names come from the SDK inventory and have not been confirmed on a live instance (gate O-5).";

export const ACTION_CAVEAT =
  "Action tables are verified:false: sys_hub_action_type_definition, sys_hub_action_input / sys_hub_action_output (keyed by model) and sys_hub_step_instance (keyed by action; label, step_type) come from the SDK inventory and have not been confirmed on a live instance (gate O-5).";

export const PLAYBOOK_CAVEAT =
  "Playbook tables are verified:false: the sys_pd_* table and field names (lane / activity keying, trigger, timer and variant columns, sys_pd_context fields) come from the SDK inventory and have not been confirmed on a live instance (gates O-5, O-9).";

export const PLAYBOOK_UNAVAILABLE =
  "Process Automation Designer (sys_pd_*) is not available on this instance: the playbook tables are absent or not readable. The family is licensed (gate O-9); install / license Process Automation Designer to explain playbooks.";

export const LOG_LEVEL_CAVEAT =
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
  /** Referenced table of a `reference` variable. */
  reference?: string;
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
