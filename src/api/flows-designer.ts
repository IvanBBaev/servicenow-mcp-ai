import { queryTable, getRecord } from "./table.js";
import { assertNoCaret, snString } from "./shared.js";
import { ServiceNowError } from "../core/errors.js";

/**
 * FT-1 Flow Designer and legacy workflow reading, and FT-3 execution
 * evidence from `sys_flow_context`.
 */

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
