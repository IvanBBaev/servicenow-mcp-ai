import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listScripts,
  getScript,
  searchCode,
  tableLogic,
  SCRIPT_TYPE_NAMES,
} from "../api/scripts.js";
import { ok } from "../result.js";
import { runTool } from "./util.js";

const scriptType = z.enum(
  SCRIPT_TYPE_NAMES as [string, ...string[]],
);

const TYPE_LIST = SCRIPT_TYPE_NAMES.join(", ");

export function registerScriptTools(server: McpServer): void {
  server.registerTool(
    "servicenow_list_scripts",
    {
      title: "List ServiceNow scripts",
      description:
        "List script artefacts of one type as compact metadata (no source code). " +
        `Types: ${TYPE_LIST}. Filter by applied table, name fragment, active flag, ` +
        "or a raw encoded query.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        type: scriptType.describe(`Script type. One of: ${TYPE_LIST}.`),
        table: z
          .string()
          .optional()
          .describe(
            "Table the script applies to (e.g. 'incident'); ignored for types with no table.",
          ),
        name: z
          .string()
          .optional()
          .describe("Case-insensitive fragment to match in the name."),
        active: z
          .boolean()
          .optional()
          .describe("Filter by the active flag."),
        query: z
          .string()
          .optional()
          .describe("Extra raw encoded query, ANDed with the other filters."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum rows to return (default 50)."),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Row offset for paging."),
      },
    },
    async (args) =>
      runTool("servicenow_list_scripts", { type: args.type }, () =>
        listScripts(args).then(ok),
      ),
  );

  server.registerTool(
    "servicenow_get_script",
    {
      title: "Get ServiceNow script",
      description:
        "Read one script artefact in full, including its source code and execution context.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        type: scriptType.describe(`Script type. One of: ${TYPE_LIST}.`),
        sys_id: z.string().describe("sys_id of the script record."),
      },
    },
    async ({ type, sys_id }) =>
      runTool("servicenow_get_script", { type, sys_id }, () =>
        getScript(type, sys_id).then(ok),
      ),
  );

  server.registerTool(
    "servicenow_search_code",
    {
      title: "Search ServiceNow code",
      description:
        "Search script source for a literal substring across one or all script types. " +
        "Returns a short snippet per match (not whole scripts). Answers 'where is X used?'.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        text: z.string().describe("Substring to search for in script source."),
        type: scriptType
          .optional()
          .describe(`Restrict to one type. One of: ${TYPE_LIST}.`),
        table: z
          .string()
          .optional()
          .describe("Restrict to scripts applied to this table."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum matches across all types (default 50)."),
      },
    },
    async (args) =>
      runTool("servicenow_search_code", { text: args.text }, () =>
        searchCode(args).then(ok),
      ),
  );

  server.registerTool(
    "servicenow_table_logic",
    {
      title: "Explain ServiceNow table logic",
      description:
        "Assemble the automation that runs on a table: business rules (ordered by " +
        "when+order), client scripts, UI policies, UI actions and ACLs. Metadata only.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        table: z.string().describe("Table to analyse, e.g. 'incident'."),
      },
    },
    async ({ table }) =>
      runTool("servicenow_table_logic", { table }, () =>
        tableLogic(table).then(ok),
      ),
  );
}
