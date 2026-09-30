/**
 * P-19 — domain analysers (project/SDK-PARITY.md §4 P-19): rules over the
 * Flow Designer, Service Portal, UI Builder and legacy-workflow metadata,
 * folded into `code_health` behind its opt-in `domains` switch.
 *
 * Flows (sys_hub_flow and its step tables, read the way explain_flow reads
 * them — P-10 / P-11):
 *   - `flow-run-as-system-protected` — an active flow running as System whose
 *     trigger or a step input names an H-11 protected table;
 *   - `flow-draft-differs` — the flow's latest snapshot is not its published
 *     (master) snapshot, from the pointers on the sys_hub_flow row;
 *   - `flow-unused-subflow` / `flow-unused-action` — a custom subflow or
 *     action no flow step calls;
 *   - `flow-integration-no-error-handling` — an integration action step
 *     (REST / SOAP / HTTP steps, integration-hub spokes) outside a Try block;
 *   - `flow-long-wait` — a wait-for-duration longer than `LONG_WAIT_SECONDS`.
 *
 * Portal:
 *   - `portal-public-data-widget` — a widget that is public, or placed on a
 *     public page, whose server script reads data with GlideRecord /
 *     GlideAggregate / GlideQuery / $sp.getRecord;
 *   - `portal-orphan-widget` / `portal-orphan-page` — not placed / not linked;
 *   - `portal-route-map-loop` — active route maps whose effective redirects
 *     form a cycle within one portal.
 *
 * UI Builder (the tables explain_ui_experience reads — P-14):
 *   - `uib-route-no-screen` — a custom route whose screen type has no screen
 *     (variant), so the route renders nothing;
 *   - `uib-screen-no-applicability` — a custom screen with no audience: it
 *     matches every user, and shadows any later variant of its screen type
 *     (`warn` when it does, `info` otherwise);
 *   - `uib-data-broker-no-acl` — a custom transform / scriptlet data broker
 *     with no `ux_data_broker` ACL (sys_security_acl `name` = broker sys_id).
 *
 * Legacy: `workflow-migration-candidate` — a wf_workflow still referenced by
 * a catalog item or an SLA definition.
 *
 * Bounds: the newest `limit` candidates per rule (the `limit` of code_health
 * `extended`), child reads capped at `DOMAIN_CHILD_MAX` rows per table and
 * chunked IN lists; a capped read marks the rule `truncated`. An unused /
 * orphan rule never reports a candidate whose callers were not fully read.
 * Every table here is `verified:false` (gate O-5): an unreadable one
 * (policy denial, ACL, missing plugin) makes the rules that need it
 * `available:false` with the reason — never a failure.
 */
import { protectedEntry } from "../core/policy.js";
import { ServiceNowError } from "../core/errors.js";
import { decodeValues, type StepInput } from "./explain-flow.js";
import { snString } from "./shared.js";
import { queryTable, type SnRecord } from "./table.js";

export type DomainSeverity = "error" | "warn" | "info";

export type DomainRuleId =
  | "flow-run-as-system-protected"
  | "flow-draft-differs"
  | "flow-unused-subflow"
  | "flow-unused-action"
  | "flow-integration-no-error-handling"
  | "flow-long-wait"
  | "portal-public-data-widget"
  | "portal-orphan-widget"
  | "portal-orphan-page"
  | "portal-route-map-loop"
  | "uib-route-no-screen"
  | "uib-screen-no-applicability"
  | "uib-data-broker-no-acl"
  | "workflow-migration-candidate";

export type DomainName = "flow" | "portal" | "uib" | "workflow";

export const DOMAIN_RULES: Record<
  DomainRuleId,
  { domain: DomainName; severity: DomainSeverity }
> = {
  "flow-run-as-system-protected": { domain: "flow", severity: "warn" },
  "flow-draft-differs": { domain: "flow", severity: "info" },
  "flow-unused-subflow": { domain: "flow", severity: "info" },
  "flow-unused-action": { domain: "flow", severity: "info" },
  "flow-integration-no-error-handling": { domain: "flow", severity: "warn" },
  "flow-long-wait": { domain: "flow", severity: "info" },
  "portal-public-data-widget": { domain: "portal", severity: "warn" },
  "portal-orphan-widget": { domain: "portal", severity: "info" },
  "portal-orphan-page": { domain: "portal", severity: "info" },
  "portal-route-map-loop": { domain: "portal", severity: "warn" },
  "uib-route-no-screen": { domain: "uib", severity: "warn" },
  "uib-screen-no-applicability": { domain: "uib", severity: "info" },
  "uib-data-broker-no-acl": { domain: "uib", severity: "warn" },
  "workflow-migration-candidate": { domain: "workflow", severity: "info" },
};

/** Candidates per rule (default / max) — the code_health `limit`. */
export const DOMAIN_LIMIT = { default: 50, max: 200 } as const;

/** Rows read per child table (summed over IN chunks). */
export const DOMAIN_CHILD_MAX = 500;

/** Findings returned (the counts cover all of them). */
export const DOMAIN_FINDINGS_TOP = 100;

/** A wait-for-duration above this many seconds is a long wait (1 day). */
export const LONG_WAIT_SECONDS = 86_400;

/** Ids per `fieldIN…` query (keeps the URL short). */
const IN_CHUNK = 100;

/** A record id safe to splice into an encoded query. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Custom candidates only: OOB spokes and store apps live in `sn_*` scopes. */
const NOT_OOB = "sys_scope.scopeNOT LIKEsn_";

const NEWEST = "ORDERBYDESCsys_updated_on";

export interface DomainRef {
  /** Registry artefact type (servicenow_explain_artifact takes it). */
  artifactType: string;
  table: string;
  sys_id: string;
  name?: string;
}

export interface DomainFinding {
  rule: DomainRuleId;
  severity: DomainSeverity;
  domain: DomainName;
  ref: DomainRef;
  message: string;
  details?: Record<string, unknown>;
}

export interface DomainRuleCheck {
  available: boolean;
  unavailableReason?: string;
  /** Candidates the rule examined. */
  scanned: number;
  findings: number;
  /** A read stopped at its cap; the rule may have missed findings. */
  truncated?: boolean;
}

export interface DomainAnalysis {
  limit: number;
  findingCount: number;
  bySeverity: Record<DomainSeverity, number>;
  rules: Record<DomainRuleId, DomainRuleCheck>;
  /** Errors first, at most DOMAIN_FINDINGS_TOP. */
  findings: DomainFinding[];
  findingsOmitted?: number;
  caveats: string[];
  warnings: string[];
}

// --- reads -----------------------------------------------------------------------

class Unavailable extends Error {}

interface Ctx {
  limit: number;
  caveats: Set<string>;
  warnings: string[];
  /** Table → why it could not be read. */
  unreadable: Map<string, string>;
}

interface Rows {
  rows: SnRecord[];
  capped: boolean;
}

const str = (row: SnRecord, field: string): string => snString(row[field]);

/**
 * One bounded read (`max` rows). An instance or policy error on a table is
 * remembered: that table then reads as `null` for every later rule.
 */
async function read(
  ctx: Ctx,
  table: string,
  query: string,
  fields: string[],
  max: number,
): Promise<Rows | null> {
  if (ctx.unreadable.has(table)) return null;
  try {
    const { records } = await queryTable({
      table,
      query,
      fields,
      limit: max + 1,
      displayValue: "false",
    });
    return { rows: records.slice(0, max), capped: records.length > max };
  } catch (error) {
    if (!(error instanceof ServiceNowError)) throw error;
    ctx.unreadable.set(
      table,
      `${table} could not be read${error.status ? ` (${error.status})` : ""}: ${error.message}`,
    );
    return null;
  }
}

/** `field IN ids` over chunks, at most `DOMAIN_CHILD_MAX` rows in all. */
async function readIn(
  ctx: Ctx,
  table: string,
  field: string,
  ids: Iterable<string>,
  fields: string[],
  suffix = "",
): Promise<Rows | null> {
  const list = [...new Set(ids)].filter((id) => SAFE_ID.test(id));
  const out: Rows = { rows: [], capped: false };
  for (let i = 0; i < list.length; i += IN_CHUNK) {
    const room = DOMAIN_CHILD_MAX - out.rows.length;
    if (room <= 0) {
      out.capped = true;
      break;
    }
    const chunk = list.slice(i, i + IN_CHUNK);
    const r = await read(
      ctx,
      table,
      `${field}IN${chunk.join(",")}${suffix}`,
      fields,
      room,
    );
    if (!r) return out.rows.length ? { ...out, capped: true } : null;
    out.rows.push(...r.rows);
    if (r.capped) {
      out.capped = true;
      break;
    }
  }
  return out;
}

/** Read a v1 / `_v2` table pair; null only when both are unreadable. */
async function readPair(
  ctx: Ctx,
  tables: string[],
  field: string,
  ids: Iterable<string>,
  fields: string[],
): Promise<(Rows & { source: Map<SnRecord, string> }) | null> {
  const list = [...ids];
  const out = {
    rows: [] as SnRecord[],
    capped: false,
    source: new Map<SnRecord, string>(),
  };
  let any = false;
  for (const t of tables) {
    const r = await readIn(ctx, t, field, list, fields);
    if (!r) continue;
    any = true;
    for (const row of r.rows) out.source.set(row, t);
    out.rows.push(...r.rows);
    out.capped ||= r.capped;
  }
  return any ? out : null;
}

function need<T>(ctx: Ctx, value: T | null, ...tables: string[]): T {
  if (value !== null) return value;
  const why = tables
    .map((t) => ctx.unreadable.get(t))
    .filter((w): w is string => !!w);
  throw new Unavailable(why.join(" ") || `${tables.join(" / ")} unreadable.`);
}

// --- findings bookkeeping ---------------------------------------------------------

class Collector {
  readonly findings: DomainFinding[] = [];
  readonly rules = {} as Record<DomainRuleId, DomainRuleCheck>;

  constructor() {
    for (const id of Object.keys(DOMAIN_RULES) as DomainRuleId[]) {
      this.rules[id] = { available: true, scanned: 0, findings: 0 };
    }
  }

  add(
    rule: DomainRuleId,
    ref: DomainRef,
    message: string,
    details?: Record<string, unknown>,
    severity = DOMAIN_RULES[rule].severity,
  ): void {
    this.findings.push({
      rule,
      severity,
      domain: DOMAIN_RULES[rule].domain,
      ref,
      message,
      ...(details ? { details } : {}),
    });
    this.rules[rule].findings++;
  }

  scanned(rule: DomainRuleId, n: number, truncated = false): void {
    this.rules[rule].scanned += n;
    if (truncated) this.rules[rule].truncated = true;
  }

  unavailable(rules: DomainRuleId[], reason: string): void {
    for (const r of rules) {
      this.rules[r] = {
        available: false,
        unavailableReason: reason,
        scanned: this.rules[r].scanned,
        findings: 0,
      };
    }
    this.findings.splice(
      0,
      this.findings.length,
      ...this.findings.filter((f) => !rules.includes(f.rule)),
    );
  }

  /** Run one rule group; an unreadable table disables that group only. */
  async run(rules: DomainRuleId[], fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      if (error instanceof Unavailable) {
        this.unavailable(rules, error.message);
        return;
      }
      throw error;
    }
  }
}

const refOf = (
  artifactType: string,
  table: string,
  row: SnRecord,
  nameField = "name",
): DomainRef => {
  const name = str(row, nameField);
  return {
    artifactType,
    table,
    sys_id: str(row, "sys_id"),
    ...(name ? { name } : {}),
  };
};

// --- flows ------------------------------------------------------------------------

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

async function analyseFlows(ctx: Ctx, out: Collector): Promise<void> {
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

// --- portal -----------------------------------------------------------------------

const DATA_READ =
  /\bnew\s+(GlideRecord|GlideAggregate|GlideQuery)\s*\(|\$sp\.getRecord\s*\(/;
const WIDGET_FIELDS = [
  "sys_id",
  "id",
  "name",
  "public",
  "script",
  "template",
  "client_script",
  "link",
];
const PORTAL_PAGE_FIELDS = [
  "homepage",
  "login_page",
  "notfound_page",
  "kb_knowledge_page",
  "sc_catalog_page",
  "sc_category_page",
];
const truthy = (v: string): boolean => v === "true" || v === "1";

const quoted = (text: string, id: string): boolean =>
  !!id &&
  (text.includes(`'${id}'`) ||
    text.includes(`"${id}"`) ||
    new RegExp(
      `[?&]id=${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`,
    ).test(text));

async function analysePortal(ctx: Ctx, out: Collector): Promise<void> {
  const { limit } = ctx;
  let widgets: Rows | null = null;
  const widgetText = (w: SnRecord): string =>
    ["script", "template", "client_script", "link"]
      .map((f) => str(w, f))
      .join("\n");

  // 1. Public widgets / widgets on public pages that read data.
  await out.run(["portal-public-data-widget"], async () => {
    widgets = need(
      ctx,
      await read(ctx, "sp_widget", NEWEST, WIDGET_FIELDS, limit),
      "sp_widget",
    );
    const pages = await read(
      ctx,
      "sp_page",
      `public=true^${NEWEST}`,
      ["sys_id", "id", "title"],
      limit,
    );
    const onPublic = new Map<string, string[]>();
    let capped = widgets.capped || !!pages?.capped;
    if (pages?.rows.length) {
      const inst = await readIn(
        ctx,
        "sp_instance",
        "sp_column.sp_row.sp_container.sp_page",
        pages.rows.map((p) => str(p, "sys_id")),
        ["sys_id", "sp_widget", "sp_column.sp_row.sp_container.sp_page"],
      );
      capped ||= !!inst?.capped;
      const pageId = new Map(
        pages.rows.map((p) => [
          str(p, "sys_id"),
          str(p, "id") || str(p, "sys_id"),
        ]),
      );
      for (const i of inst?.rows ?? []) {
        const w = str(i, "sp_widget");
        const p = pageId.get(str(i, "sp_column.sp_row.sp_container.sp_page"));
        if (!w || !p) continue;
        const list = onPublic.get(w) ?? [];
        if (!list.includes(p)) list.push(p);
        onPublic.set(w, list);
      }
      ctx.caveats.add(
        "portal-public-data-widget follows sp_instance → column → row → container → page by dot-walk: a widget in a nested row (a row inside a column) is not attributed to its page.",
      );
    }
    const known = new Map(widgets.rows.map((w) => [str(w, "sys_id"), w]));
    const missing = [...onPublic.keys()].filter((id) => !known.has(id));
    if (missing.length) {
      const extra = await readIn(
        ctx,
        "sp_widget",
        "sys_id",
        missing,
        WIDGET_FIELDS,
      );
      capped ||= !!extra?.capped;
      for (const w of extra?.rows ?? []) known.set(str(w, "sys_id"), w);
    }
    const candidates = [...known.values()].filter(
      (w) => truthy(str(w, "public")) || onPublic.has(str(w, "sys_id")),
    );
    out.scanned("portal-public-data-widget", candidates.length, capped);
    for (const w of candidates) {
      if (!DATA_READ.test(str(w, "script"))) continue;
      const pagesOf = onPublic.get(str(w, "sys_id")) ?? [];
      const isPublic = truthy(str(w, "public"));
      out.add(
        "portal-public-data-widget",
        refOf("sp_widget", "sp_widget", w),
        `${isPublic ? "A public widget" : `A widget on public page(s) ${pagesOf.join(", ")}`} reads data server-side with GlideRecord / GlideAggregate / GlideQuery: anonymous visitors can reach that data unless the query is ACL-checked. Use GlideRecordSecure and require a login where the data is not public.`,
        {
          public: isPublic,
          ...(pagesOf.length ? { publicPages: pagesOf } : {}),
        },
      );
    }
  });

  // 2. Orphaned widgets.
  await out.run(["portal-orphan-widget"], async () => {
    const ws = need(
      ctx,
      widgets ?? (await read(ctx, "sp_widget", NEWEST, WIDGET_FIELDS, limit)),
      "sp_widget",
    );
    widgets = ws;
    out.scanned("portal-orphan-widget", ws.rows.length, ws.capped);
    if (!ws.rows.length) return;
    const ids = ws.rows.map((w) => str(w, "sys_id"));
    const placed = new Set<string>();
    const unknown = new Set<string>();
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK);
      const r = need(
        ctx,
        await read(
          ctx,
          "sp_instance",
          `sp_widgetIN${chunk.filter((id) => SAFE_ID.test(id)).join(",")}`,
          ["sp_widget"],
          DOMAIN_CHILD_MAX,
        ),
        "sp_instance",
      );
      for (const row of r.rows) placed.add(str(row, "sp_widget"));
      if (r.capped) for (const id of chunk) unknown.add(id);
    }
    if (unknown.size) out.scanned("portal-orphan-widget", 0, true);
    for (const w of ws.rows) {
      const id = str(w, "sys_id");
      if (placed.has(id) || unknown.has(id)) continue;
      const wid = str(w, "id");
      const embedded = ws.rows.some(
        (o) => o !== w && wid && quoted(widgetText(o), wid),
      );
      if (embedded) continue;
      out.add(
        "portal-orphan-widget",
        refOf("sp_widget", "sp_widget", w),
        "The widget is on no page (no sp_instance) and no swept widget embeds it by id: it may be unused. Confirm nothing embeds it ($sp.getWidget, <sp-widget>) before retiring it.",
      );
    }
  });

  // 3 and 4 share the route maps.
  let maps: Rows | null = null;
  await out.run(["portal-route-map-loop"], async () => {
    maps = need(
      ctx,
      await read(
        ctx,
        "sp_page_route_map",
        "active=true^ORDERBYorder",
        [
          "sys_id",
          "short_description",
          "route_from_page",
          "route_to_page",
          "portals",
          "order",
        ],
        DOMAIN_CHILD_MAX,
      ),
      "sp_page_route_map",
    );
    out.scanned("portal-route-map-loop", maps.rows.length, maps.capped);
    for (const loop of routeLoops(maps.rows)) {
      const first = loop.maps[0]!;
      out.add(
        "portal-route-map-loop",
        refOf(
          "sp_page_route_map",
          "sp_page_route_map",
          first,
          "short_description",
        ),
        `Active route maps redirect in a cycle (${loop.pages.join(" → ")})${loop.portal ? ` in portal ${loop.portal}` : " in every portal"}: a visitor to any of those pages never reaches a real one. Deactivate or re-target one of the maps.`,
        {
          maps: loop.maps.map((m) => str(m, "sys_id")),
          pages: loop.pages,
          ...(loop.portal ? { portal: loop.portal } : {}),
        },
      );
    }
    ctx.caveats.add(
      "portal-route-map-loop follows each page's first active route map (lowest order) per portal; roles on a route map are ignored, and whether the platform chains route maps is unverified (gate O-5).",
    );
  });

  // 4. Orphaned pages.
  await out.run(["portal-orphan-page"], async () => {
    const pages = need(
      ctx,
      await read(ctx, "sp_page", NEWEST, ["sys_id", "id", "title"], limit),
      "sp_page",
    );
    out.scanned("portal-orphan-page", pages.rows.length, pages.capped);
    if (!pages.rows.length) return;
    const linked = new Set<string>();
    let complete = true;
    const portals = await read(
      ctx,
      "sp_portal",
      "",
      ["sys_id", ...PORTAL_PAGE_FIELDS],
      DOMAIN_CHILD_MAX,
    );
    if (!portals || portals.capped) complete = false;
    for (const p of portals?.rows ?? []) {
      for (const f of PORTAL_PAGE_FIELDS) linked.add(str(p, f));
    }
    const ids = pages.rows.map((p) => str(p, "sys_id"));
    const items = await readIn(ctx, "sp_rectangle_menu_item", "sp_page", ids, [
      "sp_page",
    ]);
    if (!items || items.capped) complete = false;
    for (const r of items?.rows ?? []) linked.add(str(r, "sp_page"));
    const rm =
      maps ??
      (await read(
        ctx,
        "sp_page_route_map",
        "active=true^ORDERBYorder",
        ["sys_id", "route_from_page", "route_to_page"],
        DOMAIN_CHILD_MAX,
      ));
    if (!rm || rm.capped) complete = false;
    for (const m of rm?.rows ?? []) {
      linked.add(str(m, "route_from_page"));
      linked.add(str(m, "route_to_page"));
    }
    // Links by page id in widget code and menu URLs.
    const ws =
      widgets ?? (await read(ctx, "sp_widget", NEWEST, WIDGET_FIELDS, limit));
    const urls = await read(
      ctx,
      "sp_rectangle_menu_item",
      "urlLIKEid=",
      ["url"],
      DOMAIN_CHILD_MAX,
    );
    const text = [
      ...(ws?.rows ?? []).map(widgetText),
      ...(urls?.rows ?? []).map((u) => str(u, "url")),
    ].join("\n");
    if (!portals && !items && !rm) {
      need(
        ctx,
        null,
        "sp_portal",
        "sp_rectangle_menu_item",
        "sp_page_route_map",
      );
    }
    if (!complete) {
      // A partial reference read cannot prove a page unlinked.
      out.scanned("portal-orphan-page", 0, true);
      return;
    }
    for (const p of pages.rows) {
      if (linked.has(str(p, "sys_id"))) continue;
      if (quoted(text, str(p, "id"))) continue;
      out.add(
        "portal-orphan-page",
        refOf("sp_page", "sp_page", p, "id"),
        "No portal, menu item, route map or swept widget links this page: it is reachable only by a typed URL. Link it or retire it.",
      );
    }
    ctx.caveats.add(
      "portal-orphan-page searches the newest widgets' code and menu URLs for the page id; links from emails, knowledge articles or other scripts are not searched.",
    );
  });
}

interface RouteLoop {
  portal?: string;
  maps: SnRecord[];
  pages: string[];
}

/** Cycles among the effective route maps of each portal context. */
export function routeLoops(rows: SnRecord[]): RouteLoop[] {
  const portalsOf = (m: SnRecord): string[] =>
    str(m, "portals")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
  const contexts = new Set<string>([""]);
  for (const m of rows) for (const p of portalsOf(m)) contexts.add(p);
  const loops: RouteLoop[] = [];
  const seen = new Set<string>();
  for (const ctx of contexts) {
    // The first map (lowest order) per source page wins.
    const next = new Map<string, SnRecord>();
    const sorted = [...rows].sort(
      (a, b) => Number(str(a, "order")) - Number(str(b, "order")),
    );
    for (const m of sorted) {
      const ps = portalsOf(m);
      if (ps.length && (!ctx || !ps.includes(ctx))) continue;
      const from = str(m, "route_from_page");
      if (from && str(m, "route_to_page") && !next.has(from)) next.set(from, m);
    }
    const done = new Set<string>();
    for (const start of next.keys()) {
      const path: string[] = [];
      const onPath = new Map<string, number>();
      let page: string | undefined = start;
      while (page && next.has(page) && !done.has(page)) {
        if (onPath.has(page)) {
          const cyclePages = path.slice(onPath.get(page));
          const cycleMaps = cyclePages.map((p) => next.get(p)!);
          const key = cycleMaps
            .map((m) => str(m, "sys_id"))
            .sort()
            .join(",");
          if (!seen.has(key)) {
            seen.add(key);
            // The all-portals context runs first, so a cycle of global maps
            // is reported once, without a portal.
            const global = cycleMaps.every((m) => !portalsOf(m).length);
            loops.push({
              ...(global ? {} : { portal: ctx }),
              maps: cycleMaps,
              pages: [...cyclePages, page],
            });
          }
          break;
        }
        onPath.set(page, path.length);
        path.push(page);
        page = str(next.get(page)!, "route_to_page");
      }
      for (const p of path) done.add(p);
    }
  }
  return loops;
}

// --- UI Builder ---------------------------------------------------------------------

const BROKER_TABLES = [
  ["sys_ux_data_broker_transform", "uib_data_broker_transform"],
  ["sys_ux_data_broker_scriptlet", "uib_data_broker_scriptlet"],
] as const;

async function analyseUib(ctx: Ctx, out: Collector): Promise<void> {
  const { limit } = ctx;

  // 1. Routes whose screen type has no screen.
  await out.run(["uib-route-no-screen"], async () => {
    const routes = need(
      ctx,
      await read(
        ctx,
        "sys_ux_app_route",
        `${NOT_OOB}^${NEWEST}`,
        ["sys_id", "name", "route_type", "screen_type", "app_config"],
        limit,
      ),
      "sys_ux_app_route",
    );
    out.scanned("uib-route-no-screen", routes.rows.length, routes.capped);
    const types = routes.rows.map((r) => str(r, "screen_type")).filter(Boolean);
    const screens = types.length
      ? need(
          ctx,
          await readIn(ctx, "sys_ux_screen", "screen_type", types, [
            "screen_type",
          ]),
          "sys_ux_screen",
        )
      : { rows: [], capped: false };
    // A capped screen read leaves every type unknown: report nothing.
    if (screens.capped) {
      out.scanned("uib-route-no-screen", 0, true);
      return;
    }
    const withScreen = new Set(screens.rows.map((r) => str(r, "screen_type")));
    for (const r of routes.rows) {
      const type = str(r, "screen_type");
      if (type && withScreen.has(type)) continue;
      out.add(
        "uib-route-no-screen",
        refOf("uib_route", "sys_ux_app_route", r),
        type
          ? "The route's screen type has no screen (variant): navigating to it renders nothing. Add a screen or remove the route."
          : "The route has no screen type: navigating to it renders nothing.",
        {
          ...(type ? { screenType: type } : {}),
          ...(str(r, "app_config") ? { appConfig: str(r, "app_config") } : {}),
        },
      );
    }
  });

  // 2. Screens with no applicability (audience).
  await out.run(["uib-screen-no-applicability"], async () => {
    const screens = need(
      ctx,
      await read(
        ctx,
        "sys_ux_screen",
        `applicabilityISEMPTY^${NOT_OOB}^${NEWEST}`,
        ["sys_id", "name", "screen_type", "order"],
        limit,
      ),
      "sys_ux_screen",
    );
    out.scanned(
      "uib-screen-no-applicability",
      screens.rows.length,
      screens.capped,
    );
    const types = screens.rows
      .map((r) => str(r, "screen_type"))
      .filter(Boolean);
    const siblings = types.length
      ? await readIn(ctx, "sys_ux_screen", "screen_type", types, [
          "sys_id",
          "screen_type",
          "order",
        ])
      : { rows: [], capped: false };
    if (!siblings || siblings.capped) {
      out.scanned("uib-screen-no-applicability", 0, true);
    }
    const byType = new Map<string, SnRecord[]>();
    for (const r of siblings?.rows ?? []) {
      const list = byType.get(str(r, "screen_type")) ?? [];
      list.push(r);
      byType.set(str(r, "screen_type"), list);
    }
    const order = (r: SnRecord): number => {
      const n = Number(str(r, "order"));
      return Number.isFinite(n) ? n : 0;
    };
    for (const r of screens.rows) {
      const shadowed = (byType.get(str(r, "screen_type")) ?? []).filter(
        (x) => str(x, "sys_id") !== str(r, "sys_id") && order(x) > order(r),
      ).length;
      out.add(
        "uib-screen-no-applicability",
        refOf("uib_screen", "sys_ux_screen", r),
        shadowed
          ? `The screen has no applicability, so it matches every user and shadows ${shadowed} later variant(s) of its screen type. Give it an audience or move it last.`
          : "The screen has no applicability: every user sees it. Confirm it is the intended default variant.",
        { order: order(r), shadowedVariants: shadowed },
        shadowed ? "warn" : "info",
      );
    }
  });

  // 3. Transform / scriptlet data brokers with no ux_data_broker ACL.
  await out.run(["uib-data-broker-no-acl"], async () => {
    const brokers: { row: SnRecord; table: string; type: string }[] = [];
    let capped = false;
    let any = false;
    for (const [table, type] of BROKER_TABLES) {
      const r = await read(
        ctx,
        table,
        `${NOT_OOB}^${NEWEST}`,
        ["sys_id", "name"],
        limit,
      );
      if (!r) continue;
      any = true;
      capped ||= r.capped;
      for (const row of r.rows) brokers.push({ row, table, type });
    }
    if (!any) need(ctx, null, ...BROKER_TABLES.map(([t]) => t));
    out.scanned("uib-data-broker-no-acl", brokers.length, capped);
    if (!brokers.length) return;
    const acls = need(
      ctx,
      await readIn(
        ctx,
        "sys_security_acl",
        "name",
        brokers.map((b) => str(b.row, "sys_id")),
        ["name"],
        "^type=ux_data_broker",
      ),
      "sys_security_acl",
    );
    // A capped ACL read cannot prove a broker has none: report nothing.
    if (acls.capped) {
      out.scanned("uib-data-broker-no-acl", 0, true);
      return;
    }
    const guarded = new Set(acls.rows.map((r) => str(r, "name")));
    for (const b of brokers) {
      if (guarded.has(str(b.row, "sys_id"))) continue;
      out.add(
        "uib-data-broker-no-acl",
        refOf(b.type, b.table, b.row),
        "No ux_data_broker ACL names this data broker: depending on the release it either cannot execute for non-admin users or runs unguarded. Add an ACL of type ux_data_broker with the broker's sys_id as its name.",
      );
    }
  });
}

// --- legacy workflows -----------------------------------------------------------------

async function analyseWorkflows(ctx: Ctx, out: Collector): Promise<void> {
  await out.run(["workflow-migration-candidate"], async () => {
    const fields = ["sys_id", "name", "workflow", "workflow.name"];
    const items = await read(
      ctx,
      "sc_cat_item",
      `workflowISNOTEMPTY^${NEWEST}`,
      fields,
      DOMAIN_CHILD_MAX,
    );
    const slas = await read(
      ctx,
      "contract_sla",
      `workflowISNOTEMPTY^${NEWEST}`,
      fields,
      DOMAIN_CHILD_MAX,
    );
    if (!items && !slas) need(ctx, null, "sc_cat_item", "contract_sla");
    const byWf = new Map<
      string,
      { name?: string; catalogItems: string[]; slaDefinitions: string[] }
    >();
    const add = (r: SnRecord, key: "catalogItems" | "slaDefinitions") => {
      const wf = str(r, "workflow");
      if (!wf) return;
      const e = byWf.get(wf) ?? { catalogItems: [], slaDefinitions: [] };
      if (!e.name && str(r, "workflow.name")) e.name = str(r, "workflow.name");
      e[key].push(str(r, "name") || str(r, "sys_id"));
      byWf.set(wf, e);
    };
    for (const r of items?.rows ?? []) add(r, "catalogItems");
    for (const r of slas?.rows ?? []) add(r, "slaDefinitions");
    const truncated = !!items?.capped || !!slas?.capped;
    out.scanned(
      "workflow-migration-candidate",
      (items?.rows.length ?? 0) + (slas?.rows.length ?? 0),
      truncated,
    );
    const ordered = [...byWf.entries()].sort(
      ([, a], [, b]) =>
        b.catalogItems.length +
        b.slaDefinitions.length -
        (a.catalogItems.length + a.slaDefinitions.length),
    );
    for (const [id, e] of ordered.slice(0, ctx.limit)) {
      const parts = [
        e.catalogItems.length ? `${e.catalogItems.length} catalog item(s)` : "",
        e.slaDefinitions.length
          ? `${e.slaDefinitions.length} SLA definition(s)`
          : "",
      ].filter(Boolean);
      out.add(
        "workflow-migration-candidate",
        {
          artifactType: "workflow",
          table: "wf_workflow",
          sys_id: id,
          ...(e.name ? { name: e.name } : {}),
        },
        `Legacy workflow still referenced by ${parts.join(" and ")}: a migration candidate for Flow Designer (servicenow_explain_flow kind:'workflow' migration:true lists the references and running contexts).`,
        {
          catalogItems: e.catalogItems.slice(0, 20),
          slaDefinitions: e.slaDefinitions.slice(0, 20),
        },
      );
    }
    if (ordered.length > ctx.limit)
      out.scanned("workflow-migration-candidate", 0, true);
  });
}

// --- entry point --------------------------------------------------------------------

const SEVERITY_ORDER: Record<DomainSeverity, number> = {
  error: 0,
  warn: 1,
  info: 2,
};

/**
 * Run the flow, portal, UI Builder and legacy-workflow rules. Never throws for an
 * unreadable table; an unexpected error propagates to the caller
 * (code_health turns it into a warning).
 */
export async function analyseDomains(
  opts: { limit?: number } = {},
): Promise<DomainAnalysis> {
  const limit = Math.min(
    Math.max(1, Math.trunc(opts.limit ?? DOMAIN_LIMIT.default)),
    DOMAIN_LIMIT.max,
  );
  const ctx: Ctx = {
    limit,
    caveats: new Set(),
    warnings: [],
    unreadable: new Map(),
  };
  const out = new Collector();
  await analyseFlows(ctx, out);
  await analysePortal(ctx, out);
  await analyseUib(ctx, out);
  await analyseWorkflows(ctx, out);
  ctx.caveats.add(
    "Flow Designer, Service Portal, UI Builder and workflow tables are verified:false: their field names come from the SDK inventory and have not been confirmed on a live instance (gate O-5).",
  );
  for (const [, why] of ctx.unreadable) ctx.warnings.push(why);

  const bySeverity: Record<DomainSeverity, number> = {
    error: 0,
    warn: 0,
    info: 0,
  };
  for (const f of out.findings) bySeverity[f.severity]++;
  const sorted = [...out.findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.rule.localeCompare(b.rule),
  );
  return {
    limit,
    findingCount: out.findings.length,
    bySeverity,
    rules: out.rules,
    findings: sorted.slice(0, DOMAIN_FINDINGS_TOP),
    ...(sorted.length > DOMAIN_FINDINGS_TOP
      ? { findingsOmitted: sorted.length - DOMAIN_FINDINGS_TOP }
      : {}),
    caveats: [...ctx.caveats],
    warnings: ctx.warnings,
  };
}
