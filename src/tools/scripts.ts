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

// N-0: the enum already lists every value; the description names only the opt-in ones.
const OPT_IN_NOTE = `opt-in (read only when named): ${OPT_IN_SCRIPT_TYPE_NAMES.join(", ")}`;

const scopeInput = shortText()
  .optional()
  .describe("One scope: namespace (e.g. 'x_acme_app') or sys_id.");

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_list_scripts",
    title: "List ServiceNow scripts",
    description:
      "List script artefacts of one type as metadata (no source). Filter by table, name, active or encoded query.",
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
      type: scriptType.describe(`Script type; ${OPT_IN_NOTE}.`),
      table: tableName()
        .optional()
        .describe("Applied table (types that have one)."),
      name: shortText().optional().describe("Case-insensitive name fragment."),
      active: z.boolean().optional().describe("Filter by the active flag."),
      query: encodedQuery()
        .optional()
        .describe("Encoded query ANDed with the filters."),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max rows (default 50)."),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Rows to skip (paging)."),
    },
    logFields: (args) => ({ type: args.type }),
    handler: (args) => listScripts(args).then(ok),
  }),

  defineTool({
    name: "servicenow_get_script",
    title: "Get ServiceNow script",
    description:
      "Read one script artefact in full: source code and execution context.",
    package: "scripts",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: {
      type: z.string(),
      table: z.string(),
      record: z.unknown().optional(),
    },
    input: {
      type: scriptType.describe(`Script type; ${OPT_IN_NOTE}.`),
      sys_id: sysId().describe("Script sys_id."),
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
      text: shortText(1000).describe("Substring to search for."),
      type: scriptType.optional().describe(`One type; ${OPT_IN_NOTE}.`),
      table: tableName()
        .optional()
        .describe("Only scripts applied to this table."),
      scope: scopeInput,
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max matches over all types (default 50)."),
      extended: z
        .boolean()
        .optional()
        .describe(
          "Without 'type': also search the opt-in types after the default ones (default false).",
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
    name: "servicenow_describe_table_logic",
    title: "Explain ServiceNow table logic",
    description:
      "The automation on a table: business rules (by when+order), client scripts, " +
      "UI policies, UI actions, ACLs. Metadata only.",
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
      "Find references to a table, field (table.field) or script: matching script lines, rules/ACLs on a table, structural config (reference fields, layouts, variables, flow inputs, reports). Optional scope and Mermaid graph.",
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
        .describe("A table, a field, or a script/script-include name."),
      name: z
        .string()
        .describe("Name to find usages of (table, table.field or script)."),
      mermaid: z
        .boolean()
        .optional()
        .describe("Also render a Mermaid reference graph."),
      scope: scopeInput,
      structural: z
        .boolean()
        .optional()
        .describe("Also search configuration structurally (default true)."),
      extended: z
        .boolean()
        .optional()
        .describe("Also search the opt-in UIB / portal script types."),
    },
    logFields: (args) => ({ kind: args.kind, scope: args.scope }),
    handler: ({ kind, name, mermaid, scope, structural, extended }) =>
      whereUsed(kind, name, { mermaid, scope, structural, extended }).then(ok),
  }),
];
