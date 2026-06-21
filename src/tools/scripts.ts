import { z } from "zod";
import {
  listScripts,
  getScript,
  searchCode,
  tableLogic,
  SCRIPT_TYPE_NAMES,
} from "../api/scripts.js";
import { whereUsed } from "../api/whereused.js";
import { ok } from "../mcp/result.js";
import { defineTool, type AnyToolSpec } from "../mcp/define.js";

const scriptType = z.enum(SCRIPT_TYPE_NAMES as [string, ...string[]]);

const TYPE_LIST = SCRIPT_TYPE_NAMES.join(", ");

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_list_scripts",
    title: "List ServiceNow scripts",
    description:
      "List script artefacts of one type as compact metadata (no source code). " +
      `Types: ${TYPE_LIST}. Filter by applied table, name fragment, active flag, ` +
      "or a raw encoded query.",
    package: "scripts",
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {
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
      active: z.boolean().optional().describe("Filter by the active flag."),
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
    logFields: (args) => ({ type: args.type }),
    handler: (args) => listScripts(args).then(ok),
  }),

  defineTool({
    name: "servicenow_get_script",
    title: "Get ServiceNow script",
    description:
      "Read one script artefact in full, including its source code and execution context.",
    package: "scripts",
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {
      type: scriptType.describe(`Script type. One of: ${TYPE_LIST}.`),
      sys_id: z.string().describe("sys_id of the script record."),
    },
    logFields: (args) => ({ type: args.type, sys_id: args.sys_id }),
    handler: ({ type, sys_id }) => getScript(type, sys_id).then(ok),
  }),

  defineTool({
    name: "servicenow_search_code",
    title: "Search ServiceNow code",
    description:
      "Search script source for a literal substring across one or all script types. " +
      "Returns a short snippet per match (not whole scripts). Answers 'where is X used?'.",
    package: "scripts",
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {
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
    // Log only the length: search text can contain personal data (see the
    // logging ground rule about raw queries).
    logFields: (args) => ({ textLength: args.text.length, type: args.type }),
    handler: (args) => searchCode(args).then(ok),
  }),

  defineTool({
    name: "servicenow_table_logic",
    title: "Explain ServiceNow table logic",
    description:
      "Assemble the automation that runs on a table: business rules (ordered by " +
      "when+order), client scripts, UI policies, UI actions and ACLs. Metadata only.",
    package: "scripts",
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {
      table: z.string().describe("Table to analyse, e.g. 'incident'."),
    },
    logFields: (args) => ({ table: args.table }),
    handler: ({ table }) => tableLogic(table).then(ok),
  }),

  defineTool({
    name: "servicenow_where_used",
    title: "Where used",
    description:
      "Find where a table, field or script is referenced across the instance's code: textual references in every script source, plus (for a table) the business rules, client scripts, UI policies/actions and ACLs attached to it. Read-only; optionally renders a Mermaid reference graph.",
    package: "scripts",
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {
      kind: z
        .enum(["table", "field", "script"])
        .describe(
          "What to look up: a table, a field, or a script/script-include name.",
        ),
      name: z
        .string()
        .describe("The table/field/script name to find usages of."),
      mermaid: z
        .boolean()
        .optional()
        .describe("Also render a Mermaid reference graph."),
    },
    logFields: (args) => ({ kind: args.kind }),
    handler: ({ kind, name, mermaid }) =>
      whereUsed(kind, name, { mermaid }).then(ok),
  }),
];
