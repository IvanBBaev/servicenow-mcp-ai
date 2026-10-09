/**
 * `explain_flow` `kind:"workflow"`: a legacy workflow as a graph, its runs
 * and the migration report.
 */
import { boundedRead, boundedReadIn, type ReadCtx } from "./bounded-read.js";
import { type SnRecord } from "./table.js";
import {
  type ExplainFlowResult,
  type MigrationEntry,
  type MigrationReport,
  type Ref,
  type Run,
  SAFE_ID,
  type WfActivity,
  type WfTransition,
} from "./explain-flow-model.js";
import {
  bool,
  degrade,
  num,
  opt,
  optNum,
  readRoot,
  ref,
  stage,
  str,
} from "./explain-flow-read.js";

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
  ctx: ReadCtx,
  wfId: string,
  limit: number,
): Promise<Run[]> {
  const rows = await boundedRead(
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
  ctx: ReadCtx,
  wfId: string | undefined,
  wfName?: string,
): Promise<MigrationReport> {
  const scope = wfId ? `workflow=${wfId}` : "workflowISNOTEMPTY";
  const items = await boundedRead(ctx, "sc_cat_item", scope, [
    "sys_id",
    "name",
    "workflow",
  ]);
  const slas = await boundedRead(ctx, "contract_sla", scope, [
    "sys_id",
    "name",
    "workflow",
  ]);
  const running = await boundedRead(
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
    for (const w of await boundedReadIn(
      ctx,
      "wf_workflow",
      "sys_id",
      entries.keys(),
      ["sys_id", "name"],
    )) {
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

export async function explainWorkflow(
  ctx: ReadCtx,
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

  const versions = await boundedRead(
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
      await boundedRead(
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
    activityRows = await boundedRead(
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
    ? await boundedReadIn(
        ctx,
        "wf_condition",
        "activity",
        activityIds,
        ["sys_id", "activity", "name", "order"],
        { suffix: "^ORDERBYorder" },
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
    ? await boundedReadIn(ctx, "wf_transition", "from", activityIds, [
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
          await boundedRead(
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
