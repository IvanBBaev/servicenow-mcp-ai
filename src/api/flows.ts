import { queryTable, getRecord } from "./table.js";
import { getTableChain } from "./meta.js";
import { listScripts } from "./scripts.js";
import { assertNoCaret, snString } from "./shared.js";
import { ServiceNowError } from "../core/errors.js";
import { label, MermaidDoc } from "./mermaid.js";

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

const OPERATION_FIELD: Record<TableOperation, string> = {
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
const MAX_LABEL = 60;

/** Mermaid-safe node label (quotes/brackets break the parser). */
function mlabel(text: string): string {
  return label(text, MAX_LABEL);
}

/**
 * Where an artefact comes from, relative to the traced table: `table` is the
 * defining table, `inherited_from` is set only for a parent table, and a
 * global rule is flagged `global` (its `collection` is "global").
 */
function origin(
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
function byOrder(entries: ChainEntry[]): ChainEntry[] {
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

/**
 * Business rules of one `when` phase across the inheritance chain (plus the
 * global ones) for the operation, in `order`. `tables` is child first, so
 * `tables[0]` is the traced table.
 */
async function businessRules(
  tables: string[],
  when: string,
  operation: TableOperation,
  warnings: string[],
): Promise<ChainEntry[]> {
  const traced = tables[0] ?? "";
  try {
    const { records } = await queryTable({
      table: "sys_script",
      // In an encoded query `^OR` binds to the clause right before it, so this
      // reads "(collection in chain OR global) AND active AND when AND action".
      query: `collectionIN${tables.join(",")}^ORglobal=true^active=true^when=${when}^${OPERATION_FIELD[operation]}=true^ORDERBYorder`,
      fields: [
        "sys_id",
        "name",
        "order",
        "when",
        "condition",
        "filter_condition",
        "collection",
        "global",
      ],
      displayValue: "false",
      limit: 500,
    });
    return byOrder(
      records.map((r) => {
        const collection = snString(r.collection);
        const isGlobal =
          snString(r.global) === "true" || collection === "global";
        return {
          phase: when as ChainEntry["phase"],
          type: "business_rule",
          name: snString(r.name),
          order: r.order !== undefined ? Number(snString(r.order)) : undefined,
          condition:
            snString(r.condition) || snString(r.filter_condition) || undefined,
          sys_id: snString(r.sys_id) || undefined,
          ...origin(traced, collection, isGlobal),
        };
      }),
    );
  } catch (e) {
    warnings.push(
      `business rules (${when}): ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
}

/** Record operations a Flow Designer trigger type can name. */
const TRIGGER_OPERATIONS: ReadonlyArray<readonly [RegExp, TableOperation]> = [
  [/create|insert/, "insert"],
  [/update/, "update"],
  [/delete/, "delete"],
];

/**
 * Whether a trigger of this type fires on the operation. A type that names a
 * record operation (`record_create`, `record_update`,
 * `record_create_or_update`, `record_delete`) is kept only when it names the
 * traced one; an empty or unrecognised type is always kept — never dropped
 * silently.
 */
function triggerFires(triggerType: string, operation: TableOperation): boolean {
  const type = triggerType.toLowerCase();
  const named = TRIGGER_OPERATIONS.filter(([re]) => re.test(type));
  return named.length === 0 || named.some(([, op]) => op === operation);
}

/**
 * Flow Designer flows triggered on the table or one of its parents (via
 * sys_hub_trigger_instance), filtered to the triggers that fire on the
 * operation. Nothing record-triggered fires on a read.
 */
async function flowsForTable(
  tables: string[],
  operation: TableOperation,
  warnings: string[],
): Promise<ChainEntry[]> {
  if (operation === "query") return [];
  const traced = tables[0] ?? "";
  try {
    const { records } = await queryTable({
      table: "sys_hub_trigger_instance",
      query: `table_nameIN${tables.join(",")}^flow.active=true`,
      fields: ["flow", "flow.name", "table_name", "condition", "trigger_type"],
      displayValue: "false",
      limit: 100,
    });
    return records
      .filter((r) => triggerFires(snString(r.trigger_type), operation))
      .map((r) => ({
        phase: "flow" as const,
        type: snString(r.trigger_type) || "flow",
        name: snString(r["flow.name"]) || snString(r.flow),
        condition: snString(r.condition) || undefined,
        sys_id: snString(r.flow) || undefined,
        ...origin(traced, snString(r.table_name)),
      }));
  } catch (e) {
    warnings.push(
      `flows: ${e instanceof Error ? e.message : String(e)} (Flow Designer may be unavailable)`,
    );
    return [];
  }
}

/**
 * Legacy workflows attached to the table itself. They start on insert/update
 * only, so a delete or query trace lists none.
 */
async function workflowsForTable(
  table: string,
  operation: TableOperation,
  warnings: string[],
): Promise<ChainEntry[]> {
  if (operation !== "insert" && operation !== "update") return [];
  try {
    const { records } = await queryTable({
      table: "wf_workflow",
      query: `table=${table}^active=true`,
      fields: ["sys_id", "name", "condition"],
      displayValue: "false",
      limit: 100,
    });
    return records.map((r) => ({
      phase: "workflow" as const,
      type: "workflow",
      name: snString(r.name),
      condition: snString(r.condition) || undefined,
      sys_id: snString(r.sys_id) || undefined,
      table,
    }));
  } catch (e) {
    warnings.push(`workflows: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * Whether a notification fires on the operation: on insert when
 * `action_insert` is set, on update when `action_update` is set, and always
 * when it is event-driven (an event can be fired by anything, including a
 * delete or a read).
 */
function notificationFires(
  r: Record<string, unknown>,
  operation: TableOperation,
): boolean {
  if (snString(r.event_name)) return true;
  if (operation === "insert") return snString(r.action_insert) === "true";
  if (operation === "update") return snString(r.action_update) === "true";
  return false;
}

/**
 * Notifications (sysevent_email_action) bound to the table or one of its
 * parents, filtered to the ones that fire on the operation.
 */
async function notificationsForTable(
  tables: string[],
  operation: TableOperation,
  warnings: string[],
): Promise<ChainEntry[]> {
  const traced = tables[0] ?? "";
  try {
    const { records } = await queryTable({
      table: "sysevent_email_action",
      query: `collectionIN${tables.join(",")}^active=true`,
      fields: [
        "sys_id",
        "name",
        "condition",
        "event_name",
        "collection",
        "action_insert",
        "action_update",
      ],
      displayValue: "false",
      limit: 100,
    });
    return records
      .filter((r) => notificationFires(r, operation))
      .map((r) => ({
        phase: "notification" as const,
        type: "notification",
        name: snString(r.name),
        condition:
          snString(r.condition) ||
          (snString(r.event_name) ? `on ${snString(r.event_name)}` : undefined),
        sys_id: snString(r.sys_id) || undefined,
        ...origin(traced, snString(r.collection)),
      }));
  } catch (e) {
    warnings.push(
      `notifications: ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// S-5 — opt-in lanes
// ---------------------------------------------------------------------------

/**
 * Run one lane query best-effort: a failure becomes a warning. The entries
 * come back sorted by `order`, then name, then sys_id, so the lane is stable
 * whatever order the instance returns — a snapshot compare of two traces
 * only differs when the configuration does.
 */
async function lane(
  name: string,
  warnings: string[],
  run: () => Promise<ChainEntry[]>,
): Promise<ChainEntry[]> {
  try {
    const key = (e: ChainEntry): string => `${e.name}\u0000${e.sys_id ?? ""}`;
    return byOrder(
      (await run()).sort((a, b) =>
        key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
      ),
    );
  } catch (e) {
    warnings.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * Whether a parent-table artefact applies to the traced table: its own
 * table's always do, a parent's only when its inherit flag is set.
 */
function applies(traced: string, table: string, inherit: unknown): boolean {
  return table === traced || snString(inherit) === "true";
}

/** A numeric `order`, or undefined when the record has none. */
function orderOf(r: Record<string, unknown>): number | undefined {
  const text = snString(r.order);
  return text ? Number(text) : undefined;
}

/**
 * Client lane: client scripts, then UI policies in `order`. A parent's entry
 * counts only when flagged inherited. A `query` trace keeps what runs on form
 * load; the lifecycle view (no operation) keeps everything.
 */
async function clientLane(
  tables: string[],
  operation: TableOperation | undefined,
  warnings: string[],
): Promise<ChainEntry[]> {
  const traced = tables[0] ?? "";
  const scripts = await lane("client scripts", warnings, async () => {
    const { records } = await queryTable({
      table: "sys_script_client",
      query: `tableIN${tables.join(",")}^active=true^ORDERBYname`,
      fields: ["sys_id", "name", "type", "field", "table", "inherited"],
      displayValue: "false",
      limit: 200,
    });
    return records
      .filter((r) => applies(traced, snString(r.table), r.inherited))
      .filter((r) => operation !== "query" || snString(r.type) === "onLoad")
      .map((r) => {
        const type = snString(r.type);
        const field = snString(r.field);
        return {
          phase: "client" as const,
          type: "client_script",
          name: snString(r.name),
          condition: type ? `${type}${field ? ` of ${field}` : ""}` : undefined,
          sys_id: snString(r.sys_id) || undefined,
          ...origin(traced, snString(r.table)),
        };
      });
  });
  const policies = await lane("UI policies", warnings, async () => {
    const { records } = await queryTable({
      table: "sys_ui_policy",
      query: `tableIN${tables.join(",")}^active=true^ORDERBYorder`,
      fields: [
        "sys_id",
        "short_description",
        "conditions",
        "table",
        "inherit",
        "order",
        "on_load",
      ],
      displayValue: "false",
      limit: 200,
    });
    return records
      .filter((r) => applies(traced, snString(r.table), r.inherit))
      .filter((r) => operation !== "query" || snString(r.on_load) === "true")
      .map((r) => ({
        phase: "client" as const,
        type: "ui_policy",
        name: snString(r.short_description),
        order: orderOf(r),
        condition: snString(r.conditions) || undefined,
        sys_id: snString(r.sys_id) || undefined,
        ...origin(traced, snString(r.table)),
      }));
  });
  return [...scripts, ...policies];
}

/** Data policies of the chain; enforced on a write, so none for delete/query. */
async function dataPolicyLane(
  tables: string[],
  operation: TableOperation | undefined,
  warnings: string[],
): Promise<ChainEntry[]> {
  if (operation === "delete" || operation === "query") return [];
  const traced = tables[0] ?? "";
  return lane("data policies", warnings, async () => {
    const { records } = await queryTable({
      table: "sys_data_policy2",
      query: `model_tableIN${tables.join(",")}^active=true^ORDERBYshort_description`,
      fields: [
        "sys_id",
        "short_description",
        "conditions",
        "model_table",
        "inherit",
      ],
      displayValue: "false",
      limit: 200,
    });
    return records
      .filter((r) => applies(traced, snString(r.model_table), r.inherit))
      .map((r) => ({
        phase: "data_policy" as const,
        type: "data_policy",
        name: snString(r.short_description),
        condition: snString(r.conditions) || undefined,
        sys_id: snString(r.sys_id) || undefined,
        ...origin(traced, snString(r.model_table)),
      }));
  });
}

/** SLA definitions on the chain; attached on insert/update only. */
async function slaLane(
  tables: string[],
  operation: TableOperation | undefined,
  warnings: string[],
): Promise<ChainEntry[]> {
  if (operation === "delete" || operation === "query") return [];
  const traced = tables[0] ?? "";
  return lane("SLA definitions", warnings, async () => {
    const { records } = await queryTable({
      table: "contract_sla",
      query: `collectionIN${tables.join(",")}^active=true^ORDERBYname`,
      fields: ["sys_id", "name", "collection", "start_condition"],
      displayValue: "false",
      limit: 200,
    });
    return records.map((r) => ({
      phase: "sla" as const,
      type: "sla",
      name: snString(r.name),
      condition: snString(r.start_condition) || undefined,
      sys_id: snString(r.sys_id) || undefined,
      ...origin(traced, snString(r.collection)),
    }));
  });
}

/**
 * Script actions (`sysevent_script_action`) of the events registered on the
 * chain (`sysevent_register`). Like an event-driven notification an event can
 * be fired by anything, so the lane is not filtered by operation.
 */
async function eventScriptLane(
  tables: string[],
  warnings: string[],
): Promise<ChainEntry[]> {
  const traced = tables[0] ?? "";
  return lane("event script actions", warnings, async () => {
    const { records: events } = await queryTable({
      table: "sysevent_register",
      query: `tableIN${tables.join(",")}`,
      fields: ["event_name", "table"],
      displayValue: "false",
      limit: 500,
    });
    const tableOf = new Map<string, string>();
    for (const e of events) {
      const name = snString(e.event_name);
      // An event name is embedded in an IN list — skip anything that would
      // split it or inject a clause.
      if (name && !/[,^]/.test(name) && !tableOf.has(name))
        tableOf.set(name, snString(e.table));
    }
    if (tableOf.size === 0) return [];
    const { records } = await queryTable({
      table: "sysevent_script_action",
      query: `event_nameIN${[...tableOf.keys()].join(",")}^active=true^ORDERBYorder`,
      fields: ["sys_id", "name", "event_name", "order"],
      displayValue: "false",
      limit: 200,
    });
    return records.map((r) => {
      const event = snString(r.event_name);
      return {
        phase: "event_script" as const,
        type: "script_action",
        name: snString(r.name),
        order: orderOf(r),
        condition: event ? `on ${event}` : undefined,
        sys_id: snString(r.sys_id) || undefined,
        ...origin(traced, tableOf.get(event) ?? ""),
      };
    });
  });
}

/**
 * Transform maps that target the table itself — an import inserts or updates
 * its records, so none for delete/query.
 */
async function transformMapLane(
  table: string,
  operation: TableOperation | undefined,
  warnings: string[],
): Promise<ChainEntry[]> {
  if (operation === "delete" || operation === "query") return [];
  return lane("transform maps", warnings, async () => {
    const { records } = await queryTable({
      table: "sys_transform_map",
      query: `target_table=${table}^active=true^ORDERBYname`,
      fields: ["sys_id", "name", "source_table"],
      displayValue: "false",
      limit: 200,
    });
    return records.map((r) => ({
      phase: "transform_map" as const,
      type: "transform_map",
      name: snString(r.name),
      condition: snString(r.source_table)
        ? `from ${snString(r.source_table)}`
        : undefined,
      sys_id: snString(r.sys_id) || undefined,
      table,
    }));
  });
}

/**
 * Active scheduled script jobs whose script mentions the table by name — a
 * text match (a heuristic: it can over- or under-report), not filtered by
 * operation because a job can do anything.
 */
async function scheduledJobLane(
  table: string,
  warnings: string[],
): Promise<ChainEntry[]> {
  return lane("scheduled jobs", warnings, async () => {
    const { records } = await queryTable({
      table: "sysauto_script",
      query: `active=true^scriptLIKE${table}^ORDERBYname`,
      fields: ["sys_id", "name", "run_type"],
      displayValue: "false",
      limit: 100,
    });
    return records.map((r) => ({
      phase: "scheduled_job" as const,
      type: "scheduled_job",
      name: snString(r.name),
      condition: snString(r.run_type) || undefined,
      sys_id: snString(r.sys_id) || undefined,
      table,
    }));
  });
}

/** Validate and de-duplicate `lanes`, keeping TRACE_LANES order. */
function normaliseLanes(lanes: readonly string[] | undefined): TraceLane[] {
  if (!lanes || lanes.length === 0) return [];
  for (const l of lanes) {
    if (!(TRACE_LANES as readonly string[]).includes(l)) {
      throw new ServiceNowError(
        `Unknown lane "${l}". Use ${TRACE_LANES.join(", ")}.`,
        400,
      );
    }
  }
  return TRACE_LANES.filter((l) => lanes.includes(l));
}

/** The opt-in lane entries, split by where they sit in the chain. */
async function collectLanes(
  t: string,
  tables: string[],
  operation: TableOperation | undefined,
  lanes: TraceLane[],
  warnings: string[],
): Promise<{ sources: ChainEntry[]; form: ChainEntry[]; post: ChainEntry[] }> {
  const on = (l: TraceLane): boolean => lanes.includes(l);
  const sources: ChainEntry[] = [];
  const form: ChainEntry[] = [];
  const post: ChainEntry[] = [];
  if (on("transform_map"))
    sources.push(...(await transformMapLane(t, operation, warnings)));
  if (on("scheduled_job"))
    sources.push(...(await scheduledJobLane(t, warnings)));
  if (on("client"))
    form.push(...(await clientLane(tables, operation, warnings)));
  if (on("data_policy"))
    form.push(...(await dataPolicyLane(tables, operation, warnings)));
  if (on("sla")) post.push(...(await slaLane(tables, operation, warnings)));
  if (on("event_script"))
    post.push(...(await eventScriptLane(tables, warnings)));
  return { sources, form, post };
}

/**
 * Node label for a chain entry: the Mermaid-safe name, plus ` · <parent>` for
 * an inherited artefact or ` · global` for a global rule. The name is cut
 * first so the whole label stays within MAX_LABEL.
 */
function nodeLabel(e: ChainEntry): string {
  const from = e.global ? "global" : e.inherited_from;
  if (!from) return mlabel(e.name);
  const suffix = ` · ${mlabel(from)}`;
  const name = mlabel(e.name)
    .slice(0, Math.max(0, MAX_LABEL - suffix.length))
    .trimEnd();
  return `${name}${suffix}`;
}

function buildMermaid(
  table: string,
  operation: TableOperation,
  chain: ChainEntry[],
): { mermaid: string; truncated: number } {
  const doc = new MermaidDoc("flowchart TD");
  doc.node("start", `${operation} on ${mlabel(table)}`, "input", {
    pinned: true,
  });
  const phases: ChainEntry["phase"][] = [
    "transform_map",
    "scheduled_job",
    "display",
    "client",
    "data_policy",
    "before",
    "database",
    "after",
    "async",
    "sla",
    "flow",
    "workflow",
    "notification",
    "event_script",
  ];
  let prev = "start";
  let nid = 0;
  for (const phase of phases) {
    const entries = chain.filter((c) => c.phase === phase);
    if (phase === "database") {
      doc.node("db", "database write", "db", { pinned: true });
      doc.edge(prev, "db");
      prev = "db";
      continue;
    }
    if (entries.length === 0) continue;
    const sub = `P_${phase}`;
    doc.open(sub, phase, "TB");
    let prevNode: string | undefined;
    for (const e of entries) {
      const id = `n${nid++}`;
      doc.node(id, nodeLabel(e));
      if (prevNode) doc.edge(prevNode, id);
      prevNode = id;
    }
    doc.close();
    doc.edge(prev, sub);
    prev = sub;
  }
  doc.edgeTo(prev, "done", "done", { shape: "terminal", pinned: true });
  return { mermaid: doc.render(), truncated: doc.truncated };
}

/**
 * The inheritance chain to trace, child first. Best-effort: when the
 * dictionary read fails the trace covers the table alone and says so.
 */
async function tableChain(
  table: string,
  warnings: string[],
): Promise<string[]> {
  try {
    return await getTableChain(table);
  } catch (e) {
    warnings.push(
      `table chain: ${e instanceof Error ? e.message : String(e)} — tracing ${table} alone`,
    );
    return [table];
  }
}

function assertOperation(operation: TableOperation): void {
  if (!OPERATION_FIELD[operation]) {
    throw new ServiceNowError(
      `Unknown operation "${operation}". Use insert, update, delete or query.`,
      400,
    );
  }
}

/**
 * The ordered chain for a table + operation, section by section. Opt-in lanes
 * (S-5) slot in where they run: the sources first, the form side and data
 * policies before the `before` rules, SLAs between the async rules and the
 * flows, and event script actions last.
 */
async function collectChain(
  t: string,
  tables: string[],
  operation: TableOperation,
  warnings: string[],
  lanes: TraceLane[] = [],
): Promise<ChainEntry[]> {
  const extra = await collectLanes(t, tables, operation, lanes, warnings);
  const chain: ChainEntry[] = [...extra.sources];
  // Display runs only on form load / query; include it for completeness.
  chain.push(...(await businessRules(tables, "display", operation, warnings)));
  chain.push(...extra.form);
  chain.push(...(await businessRules(tables, "before", operation, warnings)));
  chain.push({ phase: "database", type: "database", name: "database write" });
  chain.push(...(await businessRules(tables, "after", operation, warnings)));
  chain.push(...(await businessRules(tables, "async", operation, warnings)));
  chain.push(...extra.post.filter((e) => e.phase === "sla"));
  chain.push(...(await flowsForTable(tables, operation, warnings)));
  chain.push(...(await workflowsForTable(t, operation, warnings)));
  chain.push(...(await notificationsForTable(tables, operation, warnings)));
  chain.push(...extra.post.filter((e) => e.phase === "event_script"));
  return chain;
}

/**
 * FT-2 — deterministic trace of the automation a table operation triggers, in
 * execution order, across the table's inheritance chain and the global rules
 * (S-1). Each section is best-effort: a failing query becomes a warning
 * instead of sinking the whole trace. `lanes` opts into the S-5 lanes.
 */
export async function traceTableEvent(
  table: string,
  operation: TableOperation,
  opts: { lanes?: readonly TraceLane[] } = {},
): Promise<TableEventTrace> {
  const t = table.trim();
  assertNoCaret(t, "table");
  assertOperation(operation);
  const lanes = normaliseLanes(opts.lanes);
  const warnings: string[] = [];
  const tables = await tableChain(t, warnings);
  const chain = await collectChain(t, tables, operation, warnings, lanes);
  const diagram = buildMermaid(t, operation, chain);

  return {
    table: t,
    tables,
    operation,
    ...(lanes.length > 0 ? { lanes } : {}),
    chain,
    mermaid: diagram.mermaid,
    ...(diagram.truncated > 0 ? { truncated: diagram.truncated } : {}),
    warnings,
  };
}

/**
 * One entry of a table flow: a trace entry whose phase may also be a `when`
 * value the trace does not model (a lifecycle flow keeps whatever the
 * instance stores), plus the rule's `order` exactly as the instance returned
 * it, for the label.
 */
export interface TableFlowEntry extends Omit<ChainEntry, "phase"> {
  phase: string;
  order_text?: string;
}

export interface TableFlowTrace {
  table: string;
  tables: string[];
  /** Set when the flow covers one operation; absent for the lifecycle view. */
  operation?: TableOperation;
  /** The opt-in lanes the flow covers (S-5); absent when none was asked. */
  lanes?: TraceLane[];
  entries: TableFlowEntry[];
  /** Business-rule and automation entries (the database marker excluded). */
  count: number;
  warnings: string[];
}

/**
 * The data behind `generate_table_flow` (S-14, ID-06) — the diagram renders
 * this instead of running its own queries.
 *
 * - With an `operation`, it is the FT-2 trace for that operation: business
 *   rules filtered by the operation's `action_*` flag, then flows, workflows
 *   and notifications — every lane the trace gains appears in the diagram.
 * - Without one (the default, unchanged since S-1), it is the table's record
 *   lifecycle: every active business rule of the chain plus the global ones,
 *   in one query, grouped by `when`. A failing query fails the call, as it
 *   always has.
 *
 * `lanes` (S-5) adds the opt-in lanes to either view; in the lifecycle view
 * they are not filtered by any operation. A failing lane is a warning.
 */
export async function traceTableFlow(
  table: string,
  operation?: TableOperation,
  opts: { lanes?: readonly TraceLane[] } = {},
): Promise<TableFlowTrace> {
  const t = table.trim();
  if (!t) throw new ServiceNowError("A table name is required.", 400);
  // `t` is embedded raw into encoded queries (collectionIN…), so a stray `^`
  // would inject extra clauses (the K-5 / DEV-4 caret-injection class).
  assertNoCaret(t, "table");
  const lanes = normaliseLanes(opts.lanes);
  const laneField = lanes.length > 0 ? { lanes } : {};
  const warnings: string[] = [];
  const withOrderText = (e: ChainEntry): TableFlowEntry => ({
    ...e,
    order_text: e.order !== undefined ? String(e.order) : undefined,
  });

  if (operation !== undefined) {
    assertOperation(operation);
    const tables = await tableChain(t, warnings);
    const chain = await collectChain(t, tables, operation, warnings, lanes);
    return {
      table: t,
      tables,
      operation,
      ...laneField,
      entries: chain.map(withOrderText),
      count: chain.filter((e) => e.phase !== "database").length,
      warnings,
    };
  }

  // The lifecycle view: best-effort chain, silently the table alone.
  let tables: string[];
  try {
    tables = await getTableChain(t);
  } catch {
    tables = [t];
  }
  const { scripts } = await listScripts({
    type: "business_rule",
    // `^OR` binds to the clause right before it: (collection in chain OR
    // global) AND active.
    query: `collectionIN${tables.join(",")}^ORglobal=true^active=true^ORDERBYwhen^ORDERBYorder`,
    limit: 500,
  });
  const entries = scripts.map((rule): TableFlowEntry => {
    const collection = snString(rule.collection);
    const isGlobal =
      snString(rule.global) === "true" || collection === "global";
    const orderText =
      rule.order !== undefined ? snString(rule.order) : undefined;
    return {
      phase: snString(rule.when).toLowerCase() || "other",
      type: "business_rule",
      name: snString(rule.name),
      order: orderText ? Number(orderText) : undefined,
      order_text: orderText,
      sys_id: rule.sys_id || undefined,
      ...origin(t, collection, isGlobal),
    };
  });
  if (lanes.length === 0) {
    return { table: t, tables, entries, count: scripts.length, warnings };
  }
  // The lane entries join the rules; the diagram places each by its phase.
  const extra = await collectLanes(t, tables, undefined, lanes, warnings);
  const added = [...extra.sources, ...extra.form, ...extra.post].map(
    withOrderText,
  );
  return {
    table: t,
    tables,
    ...laneField,
    entries: [...entries, ...added],
    count: scripts.length + added.length,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// FT-1 — Flow Designer + legacy workflow reading
// ---------------------------------------------------------------------------

export type FlowKind = "flow" | "workflow";

export interface FlowSummary {
  kind: FlowKind;
  sys_id: string;
  name: string;
  active?: string;
  description?: string;
  table?: string;
}

export interface ListFlowsOptions {
  kind?: FlowKind;
  table?: string;
  active?: boolean;
  name?: string;
  limit?: number;
}

/** FT-1 — list Flow Designer flows (or legacy workflows) as compact metadata. */
export async function listFlows(
  opts: ListFlowsOptions = {},
): Promise<{ kind: FlowKind; count: number; flows: FlowSummary[] }> {
  const kind: FlowKind = opts.kind ?? "flow";
  if (opts.name?.trim()) assertNoCaret(opts.name, "name");
  if (opts.table?.trim()) assertNoCaret(opts.table, "table");

  if (kind === "workflow") {
    const clauses: string[] = [];
    if (opts.table?.trim()) clauses.push(`table=${opts.table.trim()}`);
    if (opts.active !== undefined) clauses.push(`active=${opts.active}`);
    if (opts.name?.trim()) clauses.push(`nameLIKE${opts.name.trim()}`);
    clauses.push("ORDERBYname");
    const { records } = await queryTable({
      table: "wf_workflow",
      query: clauses.join("^"),
      fields: ["sys_id", "name", "active", "description", "table"],
      displayValue: "false",
      limit: opts.limit ?? 50,
    });
    const flows = records.map((r) => ({
      kind,
      sys_id: snString(r.sys_id),
      name: snString(r.name),
      active: snString(r.active) || undefined,
      description: snString(r.description) || undefined,
      table: snString(r.table) || undefined,
    }));
    return { kind, count: flows.length, flows };
  }

  // Flow Designer: a table filter means "flows whose trigger is on that table".
  let flowIdFilter = "";
  if (opts.table?.trim()) {
    const { records } = await queryTable({
      table: "sys_hub_trigger_instance",
      query: `table_name=${opts.table.trim()}`,
      fields: ["flow"],
      displayValue: "false",
      limit: 500,
    });
    const ids = [
      ...new Set(records.map((r) => snString(r.flow)).filter(Boolean)),
    ];
    if (ids.length === 0) return { kind, count: 0, flows: [] };
    flowIdFilter = `sys_idIN${ids.join(",")}^`;
  }
  const clauses: string[] = [];
  if (opts.active !== undefined) clauses.push(`active=${opts.active}`);
  if (opts.name?.trim()) clauses.push(`nameLIKE${opts.name.trim()}`);
  clauses.push("ORDERBYname");
  const { records } = await queryTable({
    table: "sys_hub_flow",
    query: flowIdFilter + clauses.join("^"),
    fields: ["sys_id", "name", "active", "description"],
    displayValue: "false",
    limit: opts.limit ?? 50,
  });
  const flows = records.map((r) => ({
    kind,
    sys_id: snString(r.sys_id),
    name: snString(r.name),
    active: snString(r.active) || undefined,
    description: snString(r.description) || undefined,
  }));
  return { kind, count: flows.length, flows };
}

export interface FlowTrigger {
  table?: string;
  type?: string;
  condition?: string;
  when?: string;
}

export interface FlowStep {
  order?: number;
  action: string;
  type?: string;
}

export interface FlowDetail {
  kind: FlowKind;
  sys_id: string;
  name: string;
  active?: string;
  description?: string;
  trigger?: FlowTrigger;
  steps: FlowStep[];
}

/**
 * FT-1 — a structured view of one flow: its trigger and ordered steps. Not a
 * full decompilation — enough for a model to reason about the logic.
 */
export async function getFlow(
  sysId: string,
  kind: FlowKind = "flow",
): Promise<FlowDetail> {
  if (kind === "workflow") {
    const wf = await getRecord("wf_workflow", sysId, [
      "sys_id",
      "name",
      "active",
      "description",
      "table",
      "condition",
    ]);
    const { records: activities } = await queryTable({
      table: "wf_activity",
      query: `workflow=${sysId}^ORDERBYorder`,
      fields: ["name", "order", "activity_definition"],
      displayValue: "false",
      limit: 200,
    });
    return {
      kind,
      sys_id: snString(wf.sys_id),
      name: snString(wf.name),
      active: snString(wf.active) || undefined,
      description: snString(wf.description) || undefined,
      trigger: {
        table: snString(wf.table) || undefined,
        condition: snString(wf.condition) || undefined,
      },
      steps: activities.map((a) => ({
        order: a.order !== undefined ? Number(snString(a.order)) : undefined,
        action: snString(a.name),
        type: snString(a.activity_definition) || undefined,
      })),
    };
  }

  const flow = await getRecord("sys_hub_flow", sysId, [
    "sys_id",
    "name",
    "active",
    "description",
  ]);
  let trigger: FlowTrigger | undefined;
  try {
    const { records } = await queryTable({
      table: "sys_hub_trigger_instance",
      query: `flow=${sysId}`,
      fields: ["table_name", "trigger_type", "condition", "when_to_run"],
      displayValue: "false",
      limit: 1,
    });
    const t = records[0];
    if (t) {
      trigger = {
        table: snString(t.table_name) || undefined,
        type: snString(t.trigger_type) || undefined,
        condition: snString(t.condition) || undefined,
        when: snString(t.when_to_run) || undefined,
      };
    }
  } catch {
    // trigger optional
  }
  const { records: actions } = await queryTable({
    table: "sys_hub_action_instance",
    query: `flow=${sysId}^ORDERBYorder`,
    fields: ["order", "action_type", "action_type.name"],
    displayValue: "false",
    limit: 200,
  });
  return {
    kind,
    sys_id: snString(flow.sys_id),
    name: snString(flow.name),
    active: snString(flow.active) || undefined,
    description: snString(flow.description) || undefined,
    trigger,
    steps: actions.map((a) => ({
      order: a.order !== undefined ? Number(snString(a.order)) : undefined,
      action: snString(a["action_type.name"]) || snString(a.action_type),
      type: snString(a.action_type) || undefined,
    })),
  };
}

// ---------------------------------------------------------------------------
// FT-3 — execution evidence
// ---------------------------------------------------------------------------

export interface FlowRun {
  sys_id: string;
  name: string;
  state?: string;
  table?: string;
  recordId?: string;
  started?: string;
  updated?: string;
}

export interface FlowRunsOptions {
  /** Flow sys_id to scope by (matches sys_flow_context.flow). */
  flow?: string;
  /** Record sys_id (document_id) the flow ran against. */
  record?: string;
  limit?: number;
}

/**
 * FT-3 — flow execution history from `sys_flow_context`, by flow or by record.
 * Closes the loop on FT-2: did the flow that *should* run actually run, and
 * with what outcome?
 */
export async function getFlowRuns(
  opts: FlowRunsOptions = {},
): Promise<{ count: number; runs: FlowRun[] }> {
  const clauses: string[] = [];
  if (opts.flow?.trim()) {
    assertNoCaret(opts.flow, "flow");
    clauses.push(`flow=${opts.flow.trim()}`);
  }
  if (opts.record?.trim()) {
    assertNoCaret(opts.record, "record");
    clauses.push(`document_id=${opts.record.trim()}`);
  }
  if (clauses.length === 0) {
    throw new ServiceNowError(
      "getFlowRuns needs at least a flow or a record sys_id.",
      400,
    );
  }
  clauses.push("ORDERBYDESCsys_created_on");
  const { records } = await queryTable({
    table: "sys_flow_context",
    query: clauses.join("^"),
    fields: [
      "sys_id",
      "name",
      "state",
      "table",
      "document_id",
      "sys_created_on",
      "sys_updated_on",
    ],
    displayValue: "true",
    limit: opts.limit ?? 50,
  });
  const runs = records.map((r) => ({
    sys_id: snString(r.sys_id),
    name: snString(r.name),
    state: snString(r.state) || undefined,
    table: snString(r.table) || undefined,
    recordId: snString(r.document_id) || undefined,
    started: snString(r.sys_created_on) || undefined,
    updated: snString(r.sys_updated_on) || undefined,
  }));
  return { count: runs.length, runs };
}
