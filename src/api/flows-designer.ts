import { queryTable, getRecord } from "./table.js";
import { assertNoCaret, snString } from "./shared.js";
import { ServiceNowError } from "../core/errors.js";
import {
  TRIGGER_V1,
  TRIGGER_V2,
  V1_INPUTS,
  v1Inputs,
  v1TableQuery,
  v2Inputs,
} from "./flow-triggers.js";

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
    // O-5: `active` lives on wf_workflow_version, not wf_workflow.
    const clauses: string[] = [];
    if (opts.active !== undefined) {
      const activeIds = await publishedActiveWorkflows();
      if (opts.active && activeIds.length === 0) {
        return { kind, count: 0, flows: [] };
      }
      if (activeIds.length) {
        clauses.push(
          `sys_id${opts.active ? "IN" : "NOT IN"}${activeIds.join(",")}`,
        );
      }
    }
    if (opts.table?.trim()) clauses.push(`table=${opts.table.trim()}`);
    if (opts.name?.trim()) clauses.push(`nameLIKE${opts.name.trim()}`);
    clauses.push("ORDERBYname");
    const { records } = await queryTable({
      table: "wf_workflow",
      query: clauses.join("^"),
      fields: ["sys_id", "name", "description", "table"],
      displayValue: "false",
      limit: opts.limit ?? 50,
    });
    const active = await publishedVersions(
      records.map((r) => snString(r.sys_id)),
    );
    const flows = records.map((r) => ({
      kind,
      sys_id: snString(r.sys_id),
      name: snString(r.name),
      active: active.get(snString(r.sys_id))?.active || undefined,
      description: snString(r.description) || undefined,
      table: snString(r.table) || undefined,
    }));
    return { kind, count: flows.length, flows };
  }

  // Flow Designer: a table filter means "flows whose trigger is on that table".
  let flowIdFilter = "";
  if (opts.table?.trim()) {
    const ids = await flowIdsOnTable(opts.table.trim());
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
      "description",
      "table",
    ]);
    // O-5: active / condition are on the published version, and wf_activity
    // hangs off that version (no `workflow` or `order` column), so steps
    // follow the canvas: top to bottom, then left to right.
    const version = (await publishedVersions([sysId])).get(sysId);
    const { records: activities } = version
      ? await queryTable({
          table: "wf_activity",
          query: `workflow_version=${version.sys_id}^ORDERBYy^ORDERBYx`,
          fields: ["name", "activity_definition"],
          displayValue: "false",
          limit: 200,
        })
      : { records: [] };
    return {
      kind,
      sys_id: snString(wf.sys_id),
      name: snString(wf.name),
      active: version?.active || undefined,
      description: snString(wf.description) || undefined,
      trigger: {
        table: snString(wf.table) || undefined,
        condition: version?.condition || undefined,
      },
      steps: activities.map((a) => ({
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
    trigger = await readTrigger(sysId);
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

interface WorkflowVersion {
  sys_id: string;
  active: string;
  condition: string;
}

/** The published wf_workflow_version of each workflow. */
async function publishedVersions(
  ids: string[],
): Promise<Map<string, WorkflowVersion>> {
  const out = new Map<string, WorkflowVersion>();
  if (ids.length === 0) return out;
  const { records } = await queryTable({
    table: "wf_workflow_version",
    query: `published=true^workflowIN${ids.join(",")}`,
    fields: ["sys_id", "workflow", "active", "condition"],
    displayValue: "false",
    limit: ids.length * 2,
  });
  for (const r of records) {
    out.set(snString(r.workflow), {
      sys_id: snString(r.sys_id),
      active: snString(r.active),
      condition: snString(r.condition),
    });
  }
  return out;
}

/** Workflows whose published version is active. */
async function publishedActiveWorkflows(): Promise<string[]> {
  const { records } = await queryTable({
    table: "wf_workflow_version",
    query: "published=true^active=true",
    fields: ["workflow"],
    displayValue: "false",
    limit: 1000,
  });
  return [...new Set(records.map((r) => snString(r.workflow)))].filter(Boolean);
}

/** Flows with a trigger (v1 or v2) whose `table` input is this table. */
async function flowIdsOnTable(table: string): Promise<string[]> {
  const { records: vars } = await queryTable({
    table: V1_INPUTS.table,
    query: v1TableQuery([table]),
    fields: [...V1_INPUTS.fields],
    displayValue: "false",
    limit: 500,
  });
  const ids = new Set<string>();
  const v1 = [...v1Inputs(vars).keys()];
  if (v1.length) {
    const { records } = await queryTable({
      table: TRIGGER_V1,
      query: `sys_idIN${v1.join(",")}`,
      fields: ["flow"],
      displayValue: "false",
      limit: 500,
    });
    for (const r of records) ids.add(snString(r.flow));
  }
  const { records: v2 } = await queryTable({
    table: TRIGGER_V2,
    query: "",
    fields: ["flow", "trigger_inputs"],
    displayValue: "false",
    limit: 500,
  });
  for (const r of v2) {
    if (v2Inputs(r.trigger_inputs).table === table) ids.add(snString(r.flow));
  }
  ids.delete("");
  return [...ids];
}

/** The flow's first trigger: v2 first, then v1 with its sys_variable_value inputs. */
async function readTrigger(flowId: string): Promise<FlowTrigger | undefined> {
  for (const table of [TRIGGER_V2, TRIGGER_V1]) {
    const { records } = await queryTable({
      table,
      query: `flow=${flowId}`,
      fields: ["sys_id", "trigger_type", "trigger_inputs"],
      displayValue: "false",
      limit: 1,
    });
    const t = records[0];
    if (!t) continue;
    let inputs = v2Inputs(t.trigger_inputs);
    if (table === TRIGGER_V1) {
      const { records: vars } = await queryTable({
        table: V1_INPUTS.table,
        query: `${V1_INPUTS.prefix}^document_key=${snString(t.sys_id)}`,
        fields: [...V1_INPUTS.fields],
        displayValue: "false",
        limit: 50,
      });
      inputs = { ...inputs, ...v1Inputs(vars).get(snString(t.sys_id)) };
    }
    return {
      table: inputs.table || undefined,
      type: snString(t.trigger_type) || undefined,
      condition: inputs.condition || undefined,
      when: inputs.trigger_strategy || undefined,
    };
  }
  return undefined;
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
  /** Record sys_id (source_record) the flow ran against. */
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
    clauses.push(`source_record=${opts.record.trim()}`);
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
      "source_table",
      "source_record",
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
    table: snString(r.source_table) || undefined,
    recordId: snString(r.source_record) || undefined,
    started: snString(r.sys_created_on) || undefined,
    updated: snString(r.sys_updated_on) || undefined,
  }));
  return { count: runs.length, runs };
}
