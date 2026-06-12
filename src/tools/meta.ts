import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listTables, describeTable } from "../api/meta.js";
import { ok } from "../mcp/result.js";
import { runTool } from "./util.js";

export function registerMetaTools(server: McpServer): void {
  server.registerTool(
    "servicenow_list_tables",
    {
      title: "List ServiceNow tables",
      description:
        "List tables from sys_db_object, optionally filtered by a name or label fragment.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe("Case-insensitive fragment to match in name or label."),
      },
    },
    async ({ filter }) =>
      runTool("servicenow_list_tables", {}, async () => {
        const tables = await listTables(filter);
        return ok({ count: tables.length, tables });
      }),
  );

  server.registerTool(
    "servicenow_describe_table",
    {
      title: "Describe ServiceNow table",
      description:
        "List a table's columns (name, label, type, mandatory, reference) from sys_dictionary.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        table: z.string().describe("Table name to describe, e.g. 'incident'."),
      },
    },
    async ({ table }) =>
      runTool("servicenow_describe_table", { table }, async () => {
        const columns = await describeTable(table);
        return ok({ table, count: columns.length, columns });
      }),
  );
}
