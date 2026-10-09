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
 * P-29: the output is type-checked against the pinned @servicenow/sdk 4.13.6
 * (`npm run fluent:verify`, owner gate O-7); the action.core / actionStep input
 * tables come from `scripts/gen-fluent-actions.mjs`.
 * Output is deterministic: the tree is already ordered (order, then name) and
 * nothing here depends on time or locale. Secrets are replaced through the
 * P-26 hooks.
 */
import type { ArtifactType } from "../core/artifacts/registry.js";
import { explainFlow } from "./explain-flow.js";
import type { FluentSource } from "./fluent-emit.js";
import { tsKey } from "./fluent-render.js";
import { snString } from "./shared.js";
import { pillPath, templateText } from "./fluent-flow-maps.js";
import {
  FLOW_TREE_KINDS,
  FLOW_VERIFIED_NOTE,
  type FlowEmitHooks,
} from "./fluent-flow-base.js";
import { FlowDefEmit } from "./fluent-flow-def.js";
import { PlaybookEmit } from "./fluent-flow-playbook.js";

export {
  FLOW_TREE_KINDS,
  FLOW_VERIFIED_NOTE,
  type FlowEmitHooks,
} from "./fluent-flow-base.js";

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
  const e =
    kind === "playbook"
      ? new PlaybookEmit(h, t, src, key, tree)
      : new FlowDefEmit(h, t, src, key, tree);
  e.rootFields(kind);
  const main = e instanceof PlaybookEmit ? e.playbook() : e.flowLike(kind);
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
