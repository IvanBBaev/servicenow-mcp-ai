/**
 * `explain_flow` Flow Designer readers: `kind:"flow"` / `"subflow"`
 * (trigger, step tree, variables, roles, runs) and `kind:"action"` with
 * the P-11 call expansion.
 */
import { boundedRead, boundedReadIn, type ReadCtx } from "./bounded-read.js";
import { type SnRecord } from "./table.js";
import { isSysId } from "../core/sys-id.js";
import {
  ACTION_CAVEAT,
  type Callee,
  CALLEES_MAX,
  EXPLAIN_FLOW_DEPTH,
  type ExplainFlowResult,
  type FlowStep,
  type FlowTrigger,
  type FlowVariable,
  LOG_LEVEL_CAVEAT,
  type Published,
  type Ref,
  type Run,
  RUN_ERRORS,
  SAFE_ID,
  type StepKind,
  TREE_DEPTH_MAX,
} from "./explain-flow-model.js";
import {
  bool,
  decodeValues,
  degrade,
  num,
  opt,
  pillLabels,
  readRoot,
  ref,
  stage,
  str,
} from "./explain-flow-read.js";

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

export const VAR_FIELDS = [
  "sys_id",
  "model",
  "element",
  "label",
  "internal_type",
  "reference",
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
async function readSteps(ctx: ReadCtx, owner: string): Promise<RawStep[]> {
  const out: RawStep[] = [];
  const keys = new Set<string>();
  const byKind = new Map<StepKind, Set<string>>();
  for (const t of STEP_TABLES) {
    const fields = [...STEP_BASE, t.refField, `${t.refField}.name`];
    const rows = await boundedRead(
      ctx,
      t.table,
      `flow=${owner}^ORDERBYorder`,
      fields,
    );
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
  ctx: ReadCtx,
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
    ...(opt(row, "reference") ? { reference: str(row, "reference") } : {}),
    ...(bool(row, "mandatory") !== undefined
      ? { mandatory: bool(row, "mandatory") }
      : {}),
    ...(opt(row, "default_value")
      ? { default: str(row, "default_value") }
      : {}),
  };
}

export async function readVariables(
  ctx: ReadCtx,
  table: string,
  flowId: string,
  fields = VAR_FIELDS,
): Promise<FlowVariable[]> {
  const rows = await boundedRead(
    ctx,
    table,
    `model=${flowId}^ORDERBYorder`,
    fields,
  );
  return rows.map(variable);
}

async function readTrigger(
  ctx: ReadCtx,
  flowId: string,
  labels: Map<string, string>,
): Promise<FlowTrigger | null> {
  let found: { row: SnRecord; source: string } | undefined;
  let extra = 0;
  for (const table of TRIGGER_TABLES) {
    const rows = await boundedRead(
      ctx,
      table,
      `flow=${flowId}`,
      TRIGGER_FIELDS,
      5,
    );
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
    const defs = await boundedReadIn(
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

async function readRoles(ctx: ReadCtx, raw: string): Promise<Ref[]> {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return [];
  const ids = parts.filter((p) => isSysId(p));
  const names = new Map<string, string>();
  if (ids.length) {
    for (const r of await boundedReadIn(ctx, "sys_user_role", "sys_id", ids, [
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
  ctx: ReadCtx,
  flowId: string,
  limit: number,
): Promise<Run[]> {
  const rows = await boundedRead(
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
  const logs = await boundedReadIn(
    ctx,
    "sys_flow_log",
    "context",
    runs.map((r) => r.sys_id),
    ["sys_id", "context", "level", "message", "sys_created_on"],
    { suffix: "^ORDERBYDESCsys_created_on" },
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

export async function explainFlowDefinition(
  ctx: ReadCtx,
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
    await boundedRead(ctx, "sys_hub_flow_stage", `flow=${sysId}^ORDERBYorder`, [
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
    const snap = await boundedRead(
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
  ctx: ReadCtx,
  actionIds: string[],
): Promise<Map<string, FlowStep[]>> {
  if (!ctx.caveats.includes(ACTION_CAVEAT)) ctx.caveats.push(ACTION_CAVEAT);
  const rows = await boundedReadIn(
    ctx,
    "sys_hub_step_instance",
    "action",
    actionIds,
    ACTION_STEP_FIELDS,
    { suffix: "^ORDERBYorder" },
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
  ctx: ReadCtx,
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
        await boundedReadIn(
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

export async function explainActionDefinition(
  ctx: ReadCtx,
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
