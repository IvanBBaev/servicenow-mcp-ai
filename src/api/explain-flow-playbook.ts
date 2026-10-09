/**
 * `explain_flow` `kind:"playbook"` (P-12): a Process Automation Designer
 * playbook — lanes, activities, triggers, timers, variants and runs.
 */
import { boundedRead, boundedReadIn, type ReadCtx } from "./bounded-read.js";
import { type SnRecord } from "./table.js";
import { readVariables, VAR_FIELDS } from "./explain-flow-hub.js";
import {
  bool,
  degrade,
  num,
  opt,
  optNum,
  readRoot,
  ref,
  str,
} from "./explain-flow-read.js";
import {
  type ExplainFlowResult,
  type PdActivity,
  type PdLane,
  type PdTimer,
  type PdTrigger,
  type PdVariant,
  PLAYBOOK_UNAVAILABLE,
  type Run,
} from "./explain-flow-model.js";

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
  ctx: ReadCtx,
  pdId: string,
  limit: number,
): Promise<Run[]> {
  const rows = await boundedRead(
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
  const acts = await boundedReadIn(
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

export async function explainPlaybook(
  ctx: ReadCtx,
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
    await boundedRead(
      ctx,
      "sys_pd_lane",
      `process_definition=${sysId}^ORDERBYorder`,
      LANE_FIELDS,
    )
  ).sort((a, b) => num(a, "order") - num(b, "order"));
  const activityRows = laneRows.length
    ? await boundedReadIn(
        ctx,
        "sys_pd_activity",
        "lane",
        laneRows.map((l) => str(l, "sys_id")),
        PD_ACTIVITY_FIELDS,
        { suffix: "^ORDERBYorder" },
      )
    : [];
  const defIds = activityRows
    .map((a) => str(a, "activity_definition"))
    .filter(Boolean);
  const defs = new Map(
    (defIds.length
      ? await boundedReadIn(
          ctx,
          "sys_pd_activity_definition",
          "sys_id",
          defIds,
          ["sys_id", "label", "name"],
        )
      : []
    ).map((d) => [str(d, "sys_id"), labelOf(d)]),
  );
  const activityIds = activityRows.map((a) => str(a, "sys_id"));
  const timers = (
    activityIds.length
      ? await boundedReadIn(
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
    await boundedRead(
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
    await boundedRead(
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
