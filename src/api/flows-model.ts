import { label } from "./mermaid.js";

/**
 * Table-event trace model: operations, lanes, chain entries and the shared
 * label / origin / ordering helpers (split out of `src/api/flows.ts`).
 */

/**
 * Flow intelligence (Phase 8, package `flows`, read-only). Three read-only
 * views built entirely on the Table API — no new ServiceNow API surface:
 *
 * - FT-2 `traceTableEvent`: a deterministic *simulation* — the ordered chain of
 *   what ServiceNow would run for a table + operation (display → before → after
 *   → async business rules, then flows/workflows, then notifications), each with
 *   its condition. Answers "if I update an incident, what runs and in what
 *   order?" without executing anything.
 * - FT-1 `listFlows` / `getFlow`: a structured view of Flow Designer
 *   (`sys_hub_flow`) and legacy workflows (`wf_workflow`).
 * - FT-3 `getFlowRuns`: execution evidence from `sys_flow_context`.
 *
 * Chain, global and operation semantics (S-1): the platform runs the business
 * rules of every parent table in the inheritance chain (an `incident` insert
 * runs `task` rules) plus every rule flagged `global=true`, all interleaved by
 * `order` — so the trace resolves the chain through `getTableChain` first and
 * queries `collection IN chain OR global`, marking each entry with the table it
 * comes from (`table`, `inherited_from`, `global`). Flow triggers and
 * notifications are resolved across the chain too and filtered by the traced
 * operation (a `record_create` trigger does not fire on an update; an
 * event-driven notification may fire on anything), and legacy workflows only
 * start on insert/update. Nothing record-triggered is listed for `query`.
 *
 * Opt-in lanes (S-5): `lanes` widens the trace past the server-side core with
 * the client side (client scripts, UI policies), data policies, event script
 * actions, SLA definitions, and the two sources that write into the table on
 * their own (transform maps, scheduled jobs). Each lane is off unless named,
 * so a call without `lanes` returns exactly what it did before.
 *
 * Everything goes through the existing api/ layer, so auth, SSRF and table
 * policy apply unchanged.
 */

export type TableOperation = "insert" | "update" | "delete" | "query";

export const OPERATION_FIELD: Record<TableOperation, string> = {
  insert: "action_insert",
  update: "action_update",
  delete: "action_delete",
  query: "action_query",
};

/**
 * Opt-in trace lanes (S-5), in the order the trace emits them:
 * - `transform_map` — transform maps targeting the table (an import writes it);
 * - `scheduled_job` — scheduled script jobs whose script names the table (a
 *   text match, so a heuristic);
 * - `client` — client scripts and UI policies (the form side);
 * - `data_policy` — data policies, enforced on every server-side write;
 * - `sla` — SLA definitions, evaluated after the write;
 * - `event_script` — script actions of the events registered on the table.
 */
export const TRACE_LANES = [
  "transform_map",
  "scheduled_job",
  "client",
  "data_policy",
  "sla",
  "event_script",
] as const;

export type TraceLane = (typeof TRACE_LANES)[number];

export interface ChainEntry {
  /** Execution phase, in the order ServiceNow runs them. */
  phase:
    | "transform_map"
    | "scheduled_job"
    | "display"
    | "client"
    | "data_policy"
    | "before"
    | "database"
    | "after"
    | "async"
    | "sla"
    | "flow"
    | "workflow"
    | "notification"
    | "event_script";
  type: string;
  name: string;
  order?: number;
  /** Encoded condition / filter, when the artefact declares one. */
  condition?: string;
  sys_id?: string;
  /**
   * Table the artefact is defined on. Differs from the traced table for an
   * inherited artefact; a global business rule carries `"global"`.
   */
  table?: string;
  /**
   * Set when the artefact belongs to a parent of the traced table — e.g.
   * `"task"` for a rule an incident trace picked up from `task`. Absent for
   * the traced table's own artefacts and for global rules.
   */
  inherited_from?: string;
  /** True for a business rule flagged `global=true` (runs on every table). */
  global?: boolean;
  /**
   * N-12: the domain a domain-specific rule belongs to (never `global`);
   * absent on an instance without domain separation.
   */
  domain?: string;
  /** N-12: sys_id of the rule this domain-specific copy overrides. */
  overrides?: string;
}

export interface TableEventTrace {
  table: string;
  /** Inheritance chain the trace covers, child first (e.g. incident, task). */
  tables: string[];
  operation: TableOperation;
  /** The opt-in lanes the trace covers (S-5); absent when none was asked. */
  lanes?: TraceLane[];
  chain: ChainEntry[];
  mermaid: string;
  /** Nodes left out by SN_DIAGRAM_MAX_NODES (ID-26); absent when none. */
  truncated?: number;
  warnings: string[];
}

/** Longest node label Mermaid gets; longer names are cut. */
export const MAX_LABEL = 60;

/** Mermaid-safe node label (quotes/brackets break the parser). */
export function mlabel(text: string): string {
  return label(text, MAX_LABEL);
}

/**
 * Where an artefact comes from, relative to the traced table: `table` is the
 * defining table, `inherited_from` is set only for a parent table, and a
 * global rule is flagged `global` (its `collection` is "global").
 */
export function origin(
  traced: string,
  table: string,
  isGlobal = false,
): Pick<ChainEntry, "table" | "inherited_from" | "global"> {
  if (isGlobal) return { table: table || "global", global: true };
  return {
    table: table || undefined,
    inherited_from: table && table !== traced ? table : undefined,
  };
}

/**
 * Stable sort by numeric `order`, entries without one last. The instance
 * already orders the result, but the sort keeps the chain deterministic when
 * a paged or faked backend does not.
 */
export function byOrder(entries: ChainEntry[]): ChainEntry[] {
  const rank = (e: ChainEntry): number =>
    e.order !== undefined && Number.isFinite(e.order)
      ? e.order
      : Number.POSITIVE_INFINITY;
  return [...entries].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
}
