import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { insertImportSetRow, getImportSetRow } from "../api/importset.js";
import { ok } from "../result.js";
import { runTool } from "./util.js";

const importFieldsSchema = z.record(
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

export function registerImportSetTools(server: McpServer): void {
  server.registerTool(
    "servicenow_insert_import_set_row",
    {
      title: "Insert ServiceNow import set row",
      description:
        "Insert a single row into a staging table and run its transform map. Returns the transform result.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        staging_table: z
          .string()
          .describe("Import staging table, e.g. 'u_imp_incident'."),
        fields: importFieldsSchema.describe(
          "Column name/value pairs for the staging row.",
        ),
      },
    },
    async ({ staging_table, fields }) =>
      runTool(
        "servicenow_insert_import_set_row",
        { staging_table },
        async () => {
          const result = await insertImportSetRow(staging_table, fields);
          return ok({ message: "Import set row inserted", result });
        },
      ),
  );

  server.registerTool(
    "servicenow_get_import_set_row",
    {
      title: "Get ServiceNow import set row result",
      description:
        "Read the transform outcome for a previously inserted staging row by its sys_id.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        staging_table: z.string().describe("Import staging table name."),
        sys_id: z.string().describe("sys_id of the staging row."),
      },
    },
    async ({ staging_table, sys_id }) =>
      runTool("servicenow_get_import_set_row", { staging_table }, async () => {
        const result = await getImportSetRow(staging_table, sys_id);
        return ok({ result });
      }),
  );
}
