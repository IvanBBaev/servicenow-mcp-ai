import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Ready-made MCP prompts that orchestrate the ServiceNow tools into common
 * workflows. Prompts are always available (like resources); the steps they
 * describe use whichever tools are enabled by SN_TOOL_PACKAGES. Each prompt
 * insists the model read real values from the instance rather than inventing
 * them.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "servicenow_incident_triage",
    {
      title: "Triage a ServiceNow incident",
      description:
        "Guide the assistant through triaging an incident: summarise, assess priority, " +
        "categorise, find similar incidents and recommend next steps.",
      argsSchema: {
        incident: z
          .string()
          .describe("Incident number (e.g. INC0012345) or sys_id."),
      },
    },
    ({ incident }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Triage ServiceNow incident ${incident}. Use the servicenow_* tools and read every value from the instance — do not invent field values.`,
              "",
              `1. Fetch the incident. If ${incident} looks like a 32-char sys_id use servicenow_get_record on 'incident'; otherwise servicenow_query_table on 'incident' with query number=${incident}. Retrieve short_description, description, priority, urgency, impact, state, category, subcategory, assignment_group, caller_id, opened_at.`,
              "2. Summarise the issue in 2-3 sentences.",
              "3. Assess whether priority/urgency/impact are appropriate and recommend changes if needed.",
              "4. Suggest the correct category/subcategory and assignment group.",
              "5. Find similar resolved incidents (servicenow_query_table on 'incident' with a short_descriptionLIKE<keyword> query and state IN 6,7) and note how they were resolved.",
              "6. Recommend concrete next steps for the assignee.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "servicenow_change_impact_analysis",
    {
      title: "Analyse a ServiceNow change",
      description:
        "Guide the assistant through impact analysis for a change request: affected CIs, " +
        "schedule conflicts, related changes and a go/no-go recommendation.",
      argsSchema: {
        change: z
          .string()
          .describe("Change number (e.g. CHG0030001) or sys_id."),
      },
    },
    ({ change }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Perform an impact analysis for ServiceNow change ${change}. Use the servicenow_* tools and read all values from the instance.`,
              "",
              `1. Fetch the change. Prefer servicenow_get_change (if the 'change' package is enabled); otherwise servicenow_query_table on 'change_request' with number=${change}. Capture type, risk, impact, state, start_date, end_date, short_description and description.`,
              "2. Summarise what the change does and its scheduling window.",
              "3. Identify affected configuration items: servicenow_query_table on 'task_ci' for this change, and/or servicenow_list_cis for the relevant class. Flag business-critical CIs.",
              "4. Check schedule conflicts with servicenow_change_conflicts (do not recalculate unless asked).",
              "5. List related or overlapping changes in the same window (servicenow_query_table on 'change_request').",
              "6. Give an overall risk summary and a go/no-go recommendation with mitigations.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "servicenow_document_table",
    {
      title: "Document a ServiceNow table",
      description:
        "Orchestrate schema, automation and diagram tools to produce and save durable " +
        "Markdown documentation for a table.",
      argsSchema: {
        table: z.string().describe("Table to document, e.g. 'incident'."),
      },
    },
    ({ table }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Produce durable documentation for the ServiceNow table '${table}', then save it. Use the servicenow_* tools.`,
              "",
              `1. Check for existing docs first: servicenow_docs_read tables/${table}.md (update rather than duplicate if it exists).`,
              `2. Get the schema: servicenow_describe_table ${table}.`,
              `3. Get the automation overview: servicenow_table_logic ${table}.`,
              `4. Generate an ER diagram: servicenow_generate_er_diagram with [${table}] plus its key referenced tables.`,
              `5. Generate the record lifecycle: servicenow_generate_table_flow ${table}.`,
              `6. Write tables/${table}.md via servicenow_docs_write containing: purpose, a key-fields table (from the schema), the ER diagram and flow inside \`\`\`mermaid blocks, and a summary of business rules, client scripts, UI policies and ACLs.`,
              "Read every value from the instance; do not fabricate fields, scripts or relationships.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
