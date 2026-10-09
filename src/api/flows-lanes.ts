import { queryTable } from "./table.js";
import { snString } from "./shared.js";
import { ServiceNowError } from "../core/errors.js";
import {
  byOrder,
  type ChainEntry,
  origin,
  type TableOperation,
  TRACE_LANES,
  type TraceLane,
} from "./flows-model.js";

/**
 * S-5 opt-in trace lanes: client scripts, UI policies, data policies, SLA
 * definitions, event script actions, transform maps and scheduled jobs.
 */

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
export function normaliseLanes(
  lanes: readonly string[] | undefined,
): TraceLane[] {
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
export async function collectLanes(
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
