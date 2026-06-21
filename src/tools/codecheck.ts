import { z } from "zod";
import { lintScript, lintTable, codeHealth } from "../api/codecheck.js";
import { SCRIPT_TYPE_NAMES } from "../api/scripts.js";
import { ok } from "../mcp/result.js";
import { defineTool, type AnyToolSpec } from "../mcp/define.js";

const scriptType = z.enum(SCRIPT_TYPE_NAMES as [string, ...string[]]);
const TYPE_LIST = SCRIPT_TYPE_NAMES.join(", ");

/**
 * Code checking package (Phase 8): deterministic local analysis of the
 * instance's scripts. Pulls the source through api/scripts.ts and applies a
 * fixed rule set — zero network beyond fetching the code.
 */
export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_lint_script",
    title: "Lint a script",
    description:
      "Run deterministic code-quality rules over one script artefact (hard-coded sys_ids/URLs, " +
      "unbounded or in-loop GlideRecord queries, eval, gs.sleep, setWorkflow(false), client-side " +
      "GlideRecord, sync getReference, …). Returns findings with rule, severity, line and a fix hint.",
    package: "codecheck",
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {
      type: scriptType.describe(`Script type. One of: ${TYPE_LIST}.`),
      sys_id: z.string().describe("sys_id of the script record."),
    },
    logFields: (args) => ({ type: args.type }),
    handler: ({ type, sys_id }) => lintScript(type, sys_id).then(ok),
  }),

  defineTool({
    name: "servicenow_lint_table",
    title: "Lint a table's scripts",
    description:
      "Lint every active business rule, client script and UI policy of a table (via table_logic), " +
      "returning per-script findings and a severity summary.",
    package: "codecheck",
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {
      table: z.string().describe("Table to lint, e.g. 'incident'."),
    },
    logFields: (args) => ({ table: args.table }),
    handler: ({ table }) => lintTable(table).then(ok),
  }),

  defineTool({
    name: "servicenow_code_health",
    title: "Code health report",
    description:
      "Aggregate code-health picture: script counts by type, a security scan of the access-control " +
      "layer (ACL scripts with eval/side-effects, roles-only ACLs — degrades gracefully if " +
      "sys_security_acl is unreadable), and (when a table scope is given) the lint findings by " +
      "severity with the top offenders. Writes a Markdown report to SN_DOCS_DIR/<profile>/code-health.md.",
    package: "codecheck",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      scope: z
        .string()
        .optional()
        .describe(
          "Table to lint in depth, e.g. 'incident'. Omit for an instance-wide inventory.",
        ),
    },
    logFields: (args) => ({ scope: args.scope ?? "instance" }),
    handler: ({ scope }) => codeHealth(scope).then(ok),
  }),
];
