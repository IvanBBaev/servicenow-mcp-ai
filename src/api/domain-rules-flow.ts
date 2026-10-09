import { protectedEntry } from "../core/policy.js";
import { decodeValues, type StepInput } from "./explain-flow.js";
import { IN_CHUNK } from "./shared.js";
import { type SnRecord } from "./table.js";
import {
  Collector,
  type Ctx,
  DOMAIN_CHILD_MAX,
  type DomainRef,
  type DomainRuleId,
  LONG_WAIT_SECONDS,
  need,
  NEWEST,
  NOT_OOB,
  read,
  readIn,
  readPair,
  refOf,
  type Rows,
  SAFE_ID,
  str,
  Unavailable,
} from "./domain-rules-shared.js";

/**
 * P-19 Flow Designer rules (`flow-*`).
 */

const FLOW_FIELDS = [
  "sys_id",
  "name",
  "type",
  "active",
  "run_as",
  "master_snapshot",
  "latest_snapshot",
];

const ACTION_TABLES = ["sys_hub_action_instance_v2", "sys_hub_action_instance"];

const LOGIC_TABLES = ["sys_hub_flow_logic_instance_v2", "sys_hub_flow_logic"];

const SUBFLOW_TABLES = [
  "sys_hub_sub_flow_instance_v2",
  "sys_hub_sub_flow_instance",
];

const TRIGGER_TABLES = [
  "sys_hub_trigger_instance_v2",
  "sys_hub_trigger_instance",
];

const STEP_FIELDS = ["sys_id", "flow", "ui_id", "parent_ui_id", "values"];

interface Step {
  kind: "action" | "logic";
  row: SnRecord;
  flow: string;
  name: string;
  refId: string;
  ui: string;
  parent: string;
}

/** Action and logic steps of the given flows, `_v2` winning a ui_id clash. */
async function readFlowSteps(
  ctx: Ctx,
  flowIds: string[],
): Promise<{ steps: Step[]; capped: boolean }> {
  const actions = need(
    ctx,
    await readPair(ctx, ACTION_TABLES, "flow", flowIds, [
      ...STEP_FIELDS,
      "action_type",
      "action_type.name",
    ]),
    ...ACTION_TABLES,
  );
  const logic = need(
    ctx,
    await readPair(ctx, LOGIC_TABLES, "flow", flowIds, [
      ...STEP_FIELDS,
      "logic_definition",
      "logic_definition.name",
    ]),
    ...LOGIC_TABLES,
  );
  const seen = new Set<string>();
  const steps: Step[] = [];
  const push = (kind: Step["kind"], row: SnRecord, refField: string) => {
    const flow = str(row, "flow");
    const ui = str(row, "ui_id") || str(row, "sys_id");
    const key = `${flow}|${ui}`;
    if (seen.has(key)) return;
    seen.add(key);
    steps.push({
      kind,
      row,
      flow,
      name: str(row, `${refField}.name`),
      refId: str(row, refField),
      ui,
      parent: str(row, "parent_ui_id"),
    });
  };
  for (const r of actions.rows) push("action", r, "action_type");
  for (const r of logic.rows) push("logic", r, "logic_definition");
  return { steps, capped: actions.capped || logic.capped };
}

const inputsOf = (row: SnRecord): StepInput[] =>
  decodeValues(str(row, "values"), new Map())?.inputs ?? [];

/** Table names a step's decoded inputs name. */
function tablesIn(inputs: StepInput[]): string[] {
  const out: string[] = [];
  for (const i of inputs) {
    if (!/^(table|table_name|tablename)$/i.test(i.name)) continue;
    const v = typeof i.value === "string" ? i.value.trim() : "";
    if (/^[a-z0-9_]{1,80}$/i.test(v)) out.push(v.toLowerCase());
  }
  return out;
}

/**
 * Seconds of a duration value, or undefined when it is not a literal (a data
 * pill, a schedule, an unknown shape). Reads a glide_duration
 * (`1970-01-02 03:00:00`), `N days HH:MM:SS`, ISO 8601 `P…T…` and plain
 * seconds.
 */
export function durationSeconds(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!v || v.includes("{{")) return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(v);
  if (m) {
    const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
    return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : undefined;
  }
  m = /^(?:(\d+)\s*days?\s*)?(\d{1,2}):(\d{2}):(\d{2})$/i.exec(v);
  if (m) return +(m[1] ?? 0) * 86_400 + +m[2]! * 3600 + +m[3]! * 60 + +m[4]!;
  m =
    /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
      v,
    );
  if (m && v.length > 1 && !/T$/i.test(v)) {
    return (
      +(m[1] ?? 0) * 604_800 +
      +(m[2] ?? 0) * 86_400 +
      +(m[3] ?? 0) * 3600 +
      +(m[4] ?? 0) * 60 +
      +(m[5] ?? 0)
    );
  }
  return undefined;
}

/** Name / step-type patterns that make an action an integration. */
const INTEGRATION_NAME = /\b(rest|soap|http|graphql|jdbc)\b|integration\s*hub/i;

const INTEGRATION_STEP =
  /\b(rest|soap|http|graphql|jdbc|powershell|ssh|sftp)\b|\bmid\b/i;

const INTEGRATION_SCOPE = /^sn_.*spoke/i;

const TRY_LOGIC = /\btry\b/i;

const WAIT_DURATION = /wait.*duration|duration.*wait/i;

export async function analyseFlows(ctx: Ctx, out: Collector): Promise<void> {
  const { limit } = ctx;

  // 1. run_as System + protected tables.
  await out.run(["flow-run-as-system-protected"], async () => {
    const flows = need(
      ctx,
      await read(
        ctx,
        "sys_hub_flow",
        `run_as=system^active=true^${NEWEST}`,
        FLOW_FIELDS,
        limit,
      ),
      "sys_hub_flow",
    );
    out.scanned(
      "flow-run-as-system-protected",
      flows.rows.length,
      flows.capped,
    );
    if (!flows.rows.length) return;
    const ids = flows.rows.map((r) => str(r, "sys_id"));
    const { steps, capped } = await readFlowSteps(ctx, ids);
    const triggers = await readPair(ctx, TRIGGER_TABLES, "flow", ids, [
      "sys_id",
      "flow",
      "table",
      "values",
    ]);
    if (capped || triggers?.capped) {
      out.scanned("flow-run-as-system-protected", 0, true);
    }
    const hits = new Map<
      string,
      { table: string; entry: string; via: string }[]
    >();
    const note = (flow: string, table: string, via: string) => {
      const entry = protectedEntry(table);
      if (!entry) return;
      const list = hits.get(flow) ?? [];
      if (!list.some((h) => h.table === table && h.via === via)) {
        list.push({ table, entry, via });
      }
      hits.set(flow, list);
    };
    for (const t of triggers?.rows ?? []) {
      const flow = str(t, "flow");
      const own = str(t, "table").trim().toLowerCase();
      if (own) note(flow, own, "trigger");
      for (const tb of tablesIn(inputsOf(t))) note(flow, tb, "trigger");
    }
    for (const s of steps) {
      if (s.kind !== "action") continue;
      for (const tb of tablesIn(inputsOf(s.row))) {
        note(s.flow, tb, `step ${s.name || s.refId || s.ui}`);
      }
    }
    for (const f of flows.rows) {
      const list = hits.get(str(f, "sys_id"));
      if (!list?.length) continue;
      const tables = [...new Set(list.map((h) => h.table))];
      out.add(
        "flow-run-as-system-protected",
        refOf(
          str(f, "type") === "subflow" ? "subflow" : "flow",
          "sys_hub_flow",
          f,
        ),
        `Runs as System and touches protected table(s) ${tables.join(", ")}; an unprivileged trigger then acts with full rights on security, identity or code tables. Run as the initiating user, or narrow the flow.`,
        { tables: list },
      );
    }
  });

  // 2–4 share the newest active flows and subflows and their steps.
  await out.run(
    [
      "flow-draft-differs",
      "flow-integration-no-error-handling",
      "flow-long-wait",
    ],
    async () => {
      const flows = need(
        ctx,
        await read(
          ctx,
          "sys_hub_flow",
          `active=true^${NEWEST}`,
          FLOW_FIELDS,
          limit,
        ),
        "sys_hub_flow",
      );
      const byId = new Map(flows.rows.map((f) => [str(f, "sys_id"), f]));
      const flowRef = (id: string): DomainRef => {
        const f = byId.get(id)!;
        return refOf(
          str(f, "type") === "subflow" ? "subflow" : "flow",
          "sys_hub_flow",
          f,
        );
      };

      // Draft vs published, from the snapshot pointers already read.
      out.scanned("flow-draft-differs", flows.rows.length, flows.capped);
      for (const f of flows.rows) {
        const master = str(f, "master_snapshot");
        const latest = str(f, "latest_snapshot");
        if (master && latest && master !== latest) {
          out.add(
            "flow-draft-differs",
            flowRef(str(f, "sys_id")),
            "The latest snapshot is not the published one: the draft has unpublished changes (or the published version is stale). Publish or discard the draft.",
            {
              master_snapshot: master,
              latest_snapshot: latest,
              basis: "snapshot-pointers",
            },
          );
        }
      }
      ctx.caveats.add(
        "flow-draft-differs compares latest_snapshot with master_snapshot only; the step-by-step comparison (servicenow_explain_flow published.draftDiffers) is not run per flow in the sweep, and the snapshot authority is unverified (gate O-5).",
      );

      if (!flows.rows.length) return;
      const { steps, capped } = await readFlowSteps(ctx, [...byId.keys()]);
      out.scanned(
        "flow-integration-no-error-handling",
        flows.rows.length,
        flows.capped || capped,
      );
      out.scanned("flow-long-wait", flows.rows.length, flows.capped || capped);

      // Long waits.
      for (const s of steps) {
        if (s.kind !== "logic" || !WAIT_DURATION.test(s.name)) continue;
        for (const i of inputsOf(s.row)) {
          if (!/duration/i.test(i.name)) continue;
          const secs = durationSeconds(i.value);
          if (secs === undefined || secs <= LONG_WAIT_SECONDS) continue;
          out.add(
            "flow-long-wait",
            flowRef(s.flow),
            `Waits ${Math.round((secs / 3600) * 10) / 10} h in '${s.name}' (over ${LONG_WAIT_SECONDS / 3600} h): the flow context stays open that long and runs against the definition of the day it started. Prefer a scheduled trigger or a wait for a condition.`,
            { step: s.row.sys_id, seconds: secs },
          );
          break;
        }
      }

      // Integration steps without a Try around them.
      const actionIds = [
        ...new Set(
          steps.filter((s) => s.kind === "action").map((s) => s.refId),
        ),
      ];
      const integration = new Set<string>();
      if (actionIds.length) {
        const defs = await readIn(
          ctx,
          "sys_hub_action_type_definition",
          "sys_id",
          actionIds,
          ["sys_id", "name", "internal_name", "sys_scope.scope"],
        );
        for (const d of defs?.rows ?? []) {
          if (
            INTEGRATION_NAME.test(str(d, "name")) ||
            INTEGRATION_NAME.test(str(d, "internal_name")) ||
            INTEGRATION_SCOPE.test(str(d, "sys_scope.scope"))
          ) {
            integration.add(str(d, "sys_id"));
          }
        }
        const stepRows = await readIn(
          ctx,
          "sys_hub_step_instance",
          "action",
          actionIds,
          ["sys_id", "action", "step_type", "step_type.name"],
        );
        if (defs?.capped || stepRows?.capped) {
          out.scanned("flow-integration-no-error-handling", 0, true);
        }
        for (const r of stepRows?.rows ?? []) {
          if (INTEGRATION_STEP.test(str(r, "step_type.name"))) {
            integration.add(str(r, "action"));
          }
        }
        if (!defs && !stepRows) {
          throw new Unavailable(
            [
              ctx.unreadable.get("sys_hub_action_type_definition"),
              ctx.unreadable.get("sys_hub_step_instance"),
            ].join(" "),
          );
        }
      }
      const byUi = new Map<string, Step>();
      for (const s of steps) byUi.set(`${s.flow}|${s.ui}`, s);
      const guarded = (s: Step): boolean => {
        let parent = s.parent;
        for (let hops = 0; parent && hops < 64; hops++) {
          const p = byUi.get(`${s.flow}|${parent}`);
          if (!p) return false;
          if (p.kind === "logic" && TRY_LOGIC.test(p.name)) return true;
          parent = p.parent;
        }
        return false;
      };
      const unguarded = new Map<string, string[]>();
      for (const s of steps) {
        if (s.kind !== "action" || !integration.has(s.refId) || guarded(s)) {
          continue;
        }
        const list = unguarded.get(s.flow) ?? [];
        list.push(s.name || s.refId);
        unguarded.set(s.flow, list);
      }
      for (const [flow, names] of unguarded) {
        out.add(
          "flow-integration-no-error-handling",
          flowRef(flow),
          `Integration step(s) ${[...new Set(names)].join(", ")} run outside a Try block: a remote failure ends the flow in error with nothing handling it. Wrap them in Try / Catch (or add an error handler).`,
          { steps: names },
        );
      }
      ctx.caveats.add(
        "flow-integration-no-error-handling looks for a Try flow-logic ancestor only; a flow-level error handler and an action's own error evaluation are not read (unverified fields, gate O-5).",
      );
    },
  );

  // 5. Unused subflows and actions.
  await out.run(["flow-unused-subflow"], async () => {
    const subs = need(
      ctx,
      await read(
        ctx,
        "sys_hub_flow",
        `type=subflow^${NOT_OOB}^${NEWEST}`,
        ["sys_id", "name", "internal_name"],
        limit,
      ),
      "sys_hub_flow",
    );
    await unused(ctx, out, "flow-unused-subflow", subs, {
      artifactType: "subflow",
      table: "sys_hub_flow",
      callers: SUBFLOW_TABLES,
      field: "subflow",
      what: "subflow",
    });
  });
  await out.run(["flow-unused-action"], async () => {
    const acts = need(
      ctx,
      await read(
        ctx,
        "sys_hub_action_type_definition",
        `${NOT_OOB}^${NEWEST}`,
        ["sys_id", "name", "internal_name"],
        limit,
      ),
      "sys_hub_action_type_definition",
    );
    await unused(ctx, out, "flow-unused-action", acts, {
      artifactType: "flow_action",
      table: "sys_hub_action_type_definition",
      callers: ACTION_TABLES,
      field: "action_type",
      what: "action",
    });
  });
  ctx.caveats.add(
    "flow-unused-subflow / flow-unused-action count flow steps (drafts and snapshots) as callers only; a call from a script (sn_fd.FlowAPI) is not searched. Candidates are the newest custom ones (scopes not containing 'sn_').",
  );
}

async function unused(
  ctx: Ctx,
  out: Collector,
  rule: DomainRuleId,
  candidates: Rows,
  o: {
    artifactType: string;
    table: string;
    callers: string[];
    field: string;
    what: string;
  },
): Promise<void> {
  out.scanned(rule, candidates.rows.length, candidates.capped);
  if (!candidates.rows.length) return;
  const called = new Set<string>();
  const unknown = new Set<string>();
  const ids = candidates.rows.map((r) => str(r, "sys_id"));
  let readable = false;
  // Chunk by chunk, so a capped chunk only leaves its own ids unknown.
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    for (const t of o.callers) {
      const r = await read(
        ctx,
        t,
        `${o.field}IN${chunk.filter((id) => SAFE_ID.test(id)).join(",")}`,
        [o.field],
        DOMAIN_CHILD_MAX,
      );
      if (!r) continue;
      readable = true;
      for (const row of r.rows) called.add(str(row, o.field));
      if (r.capped) for (const id of chunk) unknown.add(id);
    }
  }
  if (!readable) need(ctx, null, ...o.callers);
  if (unknown.size) out.scanned(rule, 0, true);
  for (const row of candidates.rows) {
    const id = str(row, "sys_id");
    if (called.has(id) || unknown.has(id)) continue;
    out.add(
      rule,
      refOf(o.artifactType, o.table, row),
      `No flow or subflow step calls this ${o.what}: it may be dead code. Confirm no script starts it, then deactivate or delete it.`,
    );
  }
}
