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
import { ServiceNowError } from "../core/errors.js";
import { trackProgress } from "../core/progress.js";
import { type ReadCtx } from "./bounded-read.js";
import {
  EXPLAIN_FLOW_DEPTH,
  EXPLAIN_FLOW_RUNS,
  type ExplainFlowOptions,
  type ExplainFlowResult,
  FLOW_CAVEAT,
  PLAYBOOK_CAVEAT,
  SAFE_ID,
  WORKFLOW_CAVEAT,
} from "./explain-flow-model.js";
import { explainWorkflow } from "./explain-flow-workflow.js";
import {
  explainActionDefinition,
  explainFlowDefinition,
} from "./explain-flow-hub.js";
import { explainPlaybook } from "./explain-flow-playbook.js";

export {
  EXPLAIN_FLOW_DEPTH,
  CALLEES_MAX,
  EXPLAIN_FLOW_RUNS,
  RUN_ERRORS,
  TREE_DEPTH_MAX,
  INPUTS_PER_STEP,
  RAW_PREVIEW,
  type ExplainFlowKind,
  type ExplainFlowOptions,
  type Ref,
  type Pill,
  type StepInput,
  type DecodedValues,
  type StepKind,
  type Callee,
  type FlowStep,
  type FlowTrigger,
  type FlowVariable,
  type Stage,
  type FlowLogError,
  type Run,
  type Published,
  type WfActivity,
  type WfTransition,
  type MigrationEntry,
  type MigrationReport,
  type PdActivity,
  type PdLane,
  type PdTrigger,
  type PdTimer,
  type PdVariant,
  type ExplainFlowCounts,
  type ExplainFlowResult,
} from "./explain-flow-model.js";
export { pillLabels, decodeValues } from "./explain-flow-read.js";
export { flowMermaid, flowMarkdown } from "./explain-flow-render.js";

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
  const ctx: ReadCtx = {
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
