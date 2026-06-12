import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listChanges,
  getChange,
  createChange,
  updateChange,
  changeConflicts,
} from "../api/change.js";
import { ok } from "../mcp/result.js";
import { runTool } from "./util.js";

const changeFields = z
  .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .describe(
    'Change field name/value pairs, e.g. { "short_description": "Patch DB", "risk": "low" }.',
  );

export function registerChangeTools(server: McpServer): void {
  server.registerTool(
    "servicenow_list_changes",
    {
      title: "List change requests",
      description:
        "List change requests through the Change Management API. Supports an encoded query, field selection and paging.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Encoded query (sysparm_query)."),
        fields: z.array(z.string()).optional().describe("Columns to return."),
        limit: z.number().int().positive().max(1000).optional(),
        offset: z.number().int().nonnegative().optional(),
      },
    },
    async ({ query, fields, limit, offset }) =>
      runTool("servicenow_list_changes", {}, async () => {
        const result = await listChanges({ query, fields, limit, offset });
        return ok({ result });
      }),
  );

  server.registerTool(
    "servicenow_get_change",
    {
      title: "Get change request",
      description: "Get a single change request by sys_id.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        sys_id: z.string().describe("sys_id of the change request."),
      },
    },
    async ({ sys_id }) =>
      runTool("servicenow_get_change", {}, async () => {
        const result = await getChange(sys_id);
        return ok({ result });
      }),
  );

  server.registerTool(
    "servicenow_create_change",
    {
      title: "Create change request",
      description:
        "Create a normal, standard or emergency change. Standard changes require a template_id.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: z
          .enum(["normal", "standard", "emergency"])
          .describe("Change type."),
        template_id: z
          .string()
          .optional()
          .describe("Standard change template sys_id (required for standard)."),
        fields: changeFields.optional(),
      },
    },
    async ({ type, template_id, fields }) =>
      runTool("servicenow_create_change", { type }, async () => {
        const result = await createChange({
          type,
          templateId: template_id,
          fields,
        });
        return ok({ message: "Change created", result });
      }),
  );

  server.registerTool(
    "servicenow_update_change",
    {
      title: "Update change request",
      description: "Update fields on a change request by sys_id.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        sys_id: z.string().describe("sys_id of the change request."),
        fields: changeFields,
      },
    },
    async ({ sys_id, fields }) =>
      runTool("servicenow_update_change", {}, async () => {
        const result = await updateChange(sys_id, fields);
        return ok({ message: "Change updated", result });
      }),
  );

  server.registerTool(
    "servicenow_change_conflicts",
    {
      title: "Change schedule conflicts",
      description:
        "Read schedule conflicts for a change, or recalculate them (calculate=true). Recalculation is a write and is blocked in read-only mode.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        sys_id: z.string().describe("sys_id of the change request."),
        calculate: z
          .boolean()
          .optional()
          .describe("When true, recalculate conflicts (POST) instead of reading."),
      },
    },
    async ({ sys_id, calculate }) =>
      runTool("servicenow_change_conflicts", { calculate }, async () => {
        const result = await changeConflicts(sys_id, calculate ?? false);
        return ok({ result });
      }),
  );
}
