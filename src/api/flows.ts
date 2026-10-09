import { queryTable } from "./table.js";
import { getTableChain } from "./meta.js";
import { listScripts } from "./scripts.js";
import { assertNoCaret, snString } from "./shared.js";
import {
  DOMAIN_CAVEAT,
  domainTraceFields,
  recordDomain,
} from "./domain-separation.js";
import { ServiceNowError } from "../core/errors.js";
import { MermaidDoc } from "./mermaid.js";
import {
  byOrder,
  type ChainEntry,
  MAX_LABEL,
  mlabel,
  OPERATION_FIELD,
  origin,
  type TableEventTrace,
  type TableOperation,
  type TraceLane,
} from "./flows-model.js";
import { collectLanes, normaliseLanes } from "./flows-lanes.js";

export {
  type TableOperation,
  TRACE_LANES,
  type TraceLane,
  type ChainEntry,
  type TableEventTrace,
} from "./flows-model.js";
export {
  type FlowKind,
  type FlowSummary,
  type ListFlowsOptions,
  listFlows,
  type FlowTrigger,
  type FlowStep,
  type FlowDetail,
  getFlow,
  type FlowRun,
  type FlowRunsOptions,
  getFlowRuns,
} from "./flows-designer.js";

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
        // N-12: absent without domain separation; the dot-walk is O-5.
        ...domainTraceFields(),
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
          ...recordDomain(r),
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
      fields: [
        "flow",
        "flow.name",
        "table_name",
        "condition",
        "trigger_type",
        // N-12: the flow's domain (the trigger's own is not what runs).
        ...domainTraceFields("flow."),
      ],
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
        ...recordDomain(r, "flow."),
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
      fields: ["sys_id", "name", "condition", ...domainTraceFields()],
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
      ...recordDomain(r),
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
        ...domainTraceFields(),
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
        ...recordDomain(r),
      }));
  } catch (e) {
    warnings.push(
      `notifications: ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
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
  if (chain.some((e) => e.domain)) warnings.push(DOMAIN_CAVEAT);
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
    if (chain.some((e) => e.domain)) warnings.push(DOMAIN_CAVEAT);
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
      ...recordDomain(rule),
    };
  });
  if (entries.some((e) => e.domain)) warnings.push(DOMAIN_CAVEAT);
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
