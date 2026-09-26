import { z } from "zod";
import {
  listScripts,
  getScript,
  searchCode,
  tableLogic,
  SCRIPT_TYPE_NAMES,
  OPT_IN_SCRIPT_TYPE_NAMES,
  MAX_HITS_PER_ARTEFACT,
} from "../api/scripts.js";
import { whereUsed } from "../api/whereused.js";
import { ok } from "../mcp/result.js";
import {
  defineTool,
  encodedQuery,
  shortText,
  sysId,
  tableName,
  type AnyToolSpec,
} from "../mcp/define.js";

// The opt-in types (P-9) are valid only when named explicitly: passing one as
// `type` is the opt-in. The default search sweep never reaches them.
const scriptType = z.enum([
  ...SCRIPT_TYPE_NAMES,
  ...OPT_IN_SCRIPT_TYPE_NAMES,
] as [string, ...string[]]);

const TYPE_LIST =
  `${SCRIPT_TYPE_NAMES.join(", ")}; opt-in (read only on request): ` +
  OPT_IN_SCRIPT_TYPE_NAMES.join(", ");

const scopeInput = shortText()
  .optional()
  .describe(
    "Restrict to one application scope: its namespace (e.g. 'global', 'x_acme_app') or its sys_scope sys_id.",
  );

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_list_scripts",
    title: "List ServiceNow scripts",
    description:
      "List script artefacts of one type as compact metadata (no source code); 'type' lists the standard and opt-in types. Filter by applied table, name fragment, active flag, or a raw encoded query.",
    package: "scripts",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: {
      type: z.string(),
      count: z.number(),
      scripts: z.array(z.unknown()),
    },
    input: {
      type: scriptType.describe(`Script type. One of: ${TYPE_LIST}.`),
      table: tableName()
        .optional()
        .describe(
          "Table the script applies to (e.g. 'incident'); ignored for types with no table.",
        ),
      name: shortText()
        .optional()
        .describe("Case-insensitive fragment to match in the name."),
      active: z.boolean().optional().describe("Filter by the active flag."),
      query: encodedQuery()
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
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: { type: z.string(), table: z.string(), record: z.unknown() },
    input: {
      type: scriptType.describe(`Script type. One of: ${TYPE_LIST}.`),
      sys_id: sysId().describe("sys_id of the script record."),
    },
    logFields: (args) => ({ type: args.type, sys_id: args.sys_id }),
    handler: ({ type, sys_id }) => getScript(type, sys_id).then(ok),
  }),

  defineTool({
    name: "servicenow_search_code",
    title: "Search ServiceNow code",
    description: `Search script source for a literal substring across one or all script types. One entry per artefact: a snippet plus matching lines with one line of context (max ${MAX_HITS_PER_ARTEFACT}; hitCount is the total), not whole scripts. Answers 'where is X used?'.`,
    package: "scripts",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: {
      count: z.number(),
      matches: z.array(z.unknown()),
      unreadable: z.array(z.unknown()).optional(),
    },
    input: {
      text: shortText(1000).describe(
        "Substring to search for in script source.",
      ),
      type: scriptType
        .optional()
        .describe(`Restrict to one type. One of: ${TYPE_LIST}.`),
      table: tableName()
        .optional()
        .describe("Restrict to scripts applied to this table."),
      scope: scopeInput,
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum matches across all types (default 50)."),
      extended: z
        .boolean()
        .optional()
        .describe(
          "Without 'type': also search the opt-in types (UI Builder client scripts and data brokers, portal Angular providers, templates, themes, CSS, search sources) after the default ones. Default false.",
        ),
    },
    // Log only the length: search text can contain personal data (see the
    // logging ground rule about raw queries).
    logFields: (args) => ({
      textLength: args.text.length,
      type: args.type,
      scope: args.scope,
      ...(args.extended ? { extended: true } : {}),
    }),
    handler: (args) => searchCode(args).then(ok),
  }),

  defineTool({
    name: "servicenow_table_logic",
    title: "Explain ServiceNow table logic",
    description:
      "Assemble the automation that runs on a table: business rules (ordered by " +
      "when+order), client scripts, UI policies, UI actions and ACLs. Metadata only.",
    package: "scripts",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: {
      table: z.string(),
      businessRules: z.array(z.unknown()),
      clientScripts: z.array(z.unknown()),
      uiPolicies: z.array(z.unknown()),
      uiActions: z.array(z.unknown()),
      acls: z.array(z.unknown()),
    },
    input: {
      table: tableName().describe("Table to analyse, e.g. 'incident'."),
    },
    logFields: (args) => ({ table: args.table }),
    handler: ({ table }) => tableLogic(table).then(ok),
  }),

  defineTool({
    name: "servicenow_where_used",
    title: "Where used",
    description:
      "Find references to a table, field (table.field) or script: matching lines in script sources, rules/ACLs attached to a table, and structural config (reference fields, layouts, variables, flow inputs, reports). Optional scope filter and Mermaid graph.",
    package: "scripts",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: {
      kind: z.string(),
      name: z.string(),
      count: z.number(),
      references: z.array(z.unknown()),
      caveats: z.array(z.unknown()),
    },
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
      scope: scopeInput,
      structural: z
        .boolean()
        .optional()
        .describe(
          "Also search configuration structurally (dictionary references, layouts, catalog variables, flow inputs, reports). Default true; false skips those reads.",
        ),
    },
    logFields: (args) => ({ kind: args.kind, scope: args.scope }),
    handler: ({ kind, name, mermaid, scope, structural }) =>
      whereUsed(kind, name, { mermaid, scope, structural }).then(ok),
  }),
];
