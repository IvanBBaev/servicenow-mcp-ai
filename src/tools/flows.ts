import { z } from "zod";
import {
  TRACE_LANES,
  traceTableEvent,
  listFlows,
  getFlow,
  getFlowRuns,
} from "../api/flows.js";
import {
  EXPLAIN_FLOW_DEPTH,
  EXPLAIN_FLOW_RUNS,
  explainFlow,
  flowMarkdown,
  flowMermaid,
} from "../api/explain-flow.js";
import { deliverDiagram, deliverJson } from "../mcp/file-result.js";
import { ok } from "../mcp/result.js";
import {
  defineTool,
  shortText,
  sysId,
  tableName,
  type AnyToolSpec,
} from "../mcp/define.js";

/**
 * Opt-in trace lanes (S-5), shared with `servicenow_generate_table_flow`.
 * The enum bounds every item; the array holds each lane at most once.
 */
export const lanesArg = z
  .array(z.enum(TRACE_LANES))
  .max(TRACE_LANES.length)
  .optional()
  .describe(
    "Opt-in extra lanes: transform_map (maps targeting the table), scheduled_job (script jobs " +
      "naming the table — a text match), client (client scripts + UI policies), data_policy, " +
      "sla (SLA definitions), event_script (script actions of the table's registered events). " +
      "Omit for business rules, flows, workflows and notifications only.",
  );

/**
 * Flow intelligence package (Phase 8): read-only views of what would run on a
 * table (deterministic trace), what Flow Designer / workflows are configured,
 * and what actually ran. All over the Table API.
 */
export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_trace_table_event",
    title: "Trace a table event",
    description:
      "Trace what would run for a table operation, in order, without executing: display/before/after/async business rules (inherited and global too), flows, workflows, notifications, with conditions and a Mermaid flowchart. 'lanes' adds more.",
    package: "flows",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: {
      table: z.string(),
      tables: z.array(z.unknown()),
      chain: z.array(z.unknown()),
      mermaid: z.string(),
      warnings: z.array(z.unknown()),
    },
    input: {
      table: tableName().describe("Table to trace, e.g. 'incident'."),
      operation: z
        .enum(["insert", "update", "delete", "query"])
        .describe("The database operation to simulate."),
      lanes: lanesArg,
    },
    logFields: (args) => ({
      table: args.table,
      operation: args.operation,
      lanes: args.lanes,
    }),
    handler: ({ table, operation, lanes }) =>
      traceTableEvent(table, operation, { lanes }).then(ok),
  }),

  defineTool({
    name: "servicenow_list_flows",
    title: "List flows",
    description:
      "List Flow Designer flows (sys_hub_flow) or legacy workflows (kind: 'workflow') as compact " +
      "metadata. Filter by applied table, active flag or a name fragment.",
    package: "flows",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: {
      kind: z.string(),
      count: z.number(),
      flows: z.array(z.unknown()),
    },
    input: {
      kind: z
        .enum(["flow", "workflow"])
        .optional()
        .describe("'flow' (Flow Designer, default) or 'workflow' (legacy)."),
      table: tableName()
        .optional()
        .describe("Only flows triggered on this table."),
      active: z.boolean().optional().describe("Filter by the active flag."),
      name: shortText()
        .optional()
        .describe("Case-insensitive fragment to match in the name."),
      limit: z.number().int().positive().max(1000).optional(),
    },
    logFields: (args) => ({ kind: args.kind ?? "flow" }),
    handler: (args) => listFlows(args).then(ok),
  }),

  defineTool({
    name: "servicenow_get_flow",
    title: "Get flow detail",
    description:
      "Get a structured view of one flow or workflow: its trigger (table/condition/when) and ordered " +
      "steps. Not a full decompilation — enough to reason about the logic.",
    package: "flows",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: {
      kind: z.string(),
      sys_id: z.string(),
      name: z.string(),
      steps: z.array(z.unknown()),
    },
    input: {
      sys_id: sysId().describe("sys_id of the flow or workflow."),
      kind: z
        .enum(["flow", "workflow"])
        .optional()
        .describe("'flow' (default) or 'workflow'."),
    },
    logFields: (args) => ({ kind: args.kind ?? "flow" }),
    handler: ({ sys_id, kind }) => getFlow(sys_id, kind).then(ok),
  }),

  defineTool({
    name: "servicenow_get_flow_runs",
    title: "Get flow run history",
    description:
      "Read flow execution evidence from sys_flow_context — by flow sys_id or by the record (document) " +
      "it ran against: when it started, its state and the outcome.",
    package: "flows",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: { count: z.number(), runs: z.array(z.unknown()) },
    input: {
      flow: sysId().optional().describe("Flow sys_id to scope by."),
      record: sysId()
        .optional()
        .describe("Record sys_id the flow ran against (document_id)."),
      limit: z.number().int().positive().max(1000).optional(),
    },
    handler: (args) => getFlowRuns(args).then(ok),
  }),

  defineTool({
    name: "servicenow_explain_flow",
    title: "Explain a flow or workflow",
    description:
      "Explain a flow/subflow (trigger, step tree, decoded inputs and pills, calls expanded), a custom action (inputs, outputs, steps), a legacy workflow (activity graph, migration report) or a playbook (lanes). Opt-in runs.",
    package: "flows",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: {
      kind: z.string(),
      sys_id: z.string().optional(),
      verified: z.boolean(),
    },
    input: {
      sys_id: sysId()
        .optional()
        .describe(
          "sys_hub_flow (flow/subflow), sys_hub_action_type_definition (action), wf_workflow (workflow) or sys_pd_process_definition (playbook) sys_id. Required unless kind:'workflow' with migration:true.",
        ),
      kind: z
        .enum(["flow", "subflow", "action", "workflow", "playbook"])
        .optional()
        .describe(
          "'flow' (default), 'subflow', 'action' (custom action), 'workflow' (legacy) or 'playbook' (PAD).",
        ),
      runs: z
        .number()
        .int()
        .min(0)
        .max(EXPLAIN_FLOW_RUNS.max)
        .optional()
        .describe(
          "Latest runs to include (sys_flow_context + sys_flow_log errors, wf_context or sys_pd_context). Default 0.",
        ),
      depth: z
        .number()
        .int()
        .min(0)
        .max(EXPLAIN_FLOW_DEPTH.max)
        .optional()
        .describe(
          "Flow/subflow: levels of subflow/action calls to expand (0 = none). Default 1.",
        ),
      migration: z
        .boolean()
        .optional()
        .describe(
          "Workflow only: report catalog items / SLA definitions that reference it and running contexts.",
        ),
      format: z
        .enum(["json", "markdown", "mermaid", "file"])
        .optional()
        .describe(
          "'json' (default) the tree; 'markdown' a report with the Mermaid diagram; 'mermaid' the diagram only; 'file' the full JSON (diagram included) written to exports/ with a summary returned.",
        ),
    },
    logFields: (args) => ({
      kind: args.kind ?? "flow",
      runs: args.runs,
      depth: args.depth,
      migration: args.migration,
      format: args.format,
    }),
    handler: async ({ sys_id, kind, runs, depth, migration, format }) => {
      const result = await explainFlow({
        sys_id,
        kind,
        runs,
        depth,
        migration,
      });
      const name = `${result.kind}-${sys_id ?? "migration"}`;
      if (format === "json" || format === undefined) {
        return deliverJson(result, name, "json");
      }
      const { mermaid, truncated } = flowMermaid(result);
      const signal = truncated > 0 ? { mermaidTruncated: truncated } : {};
      const summary = {
        kind: result.kind,
        ...(result.sys_id ? { sys_id: result.sys_id } : {}),
        counts: result.counts,
        verified: result.verified,
        caveats: result.caveats,
        ...signal,
      };
      if (format === "mermaid") {
        return deliverDiagram({ ...summary, mermaid }, name, "inline");
      }
      if (format === "markdown") {
        return ok({ ...summary, markdown: flowMarkdown(result, mermaid) });
      }
      return deliverJson({ ...result, ...signal, mermaid }, name, "file");
    },
  }),
];
