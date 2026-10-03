import { z } from "zod";
import {
  ARTIFACT_LINT_LIMIT,
  ARTIFACT_LINT_LIMIT_MAX,
  lintScript,
  lintTable,
  codeHealth,
} from "../api/codecheck.js";
import { OPT_IN_SCRIPT_TYPE_NAMES, SCRIPT_TYPE_NAMES } from "../api/scripts.js";
import { ok } from "../mcp/result.js";
import {
  defineTool,
  sysId,
  tableName,
  type AnyToolSpec,
} from "../mcp/define.js";

// P-18: lint_script takes the opt-in registry types (UI Builder, portal) too.
const scriptType = z.enum([
  ...SCRIPT_TYPE_NAMES,
  ...OPT_IN_SCRIPT_TYPE_NAMES,
] as [string, ...string[]]);

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
      "Run deterministic code-quality rules over one script artefact (hard-coded sys_ids/URLs, unbounded or in-loop GlideRecord, eval, gs.sleep, setWorkflow(false), client-side GlideRecord, …). Returns findings with rule, severity, line and fix hint.",
    package: "codecheck",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: {
      type: z.string(),
      sys_id: z.string(),
      results: z.array(z.unknown()),
    },
    input: {
      type: scriptType.describe("Script type (default and opt-in types)."),
      sys_id: sysId().describe("sys_id of the script record."),
    },
    logFields: (args) => ({ type: args.type }),
    handler: ({ type, sys_id }) => lintScript(type, sys_id).then(ok),
  }),

  defineTool({
    name: "servicenow_lint_table",
    title: "Lint a table's scripts",
    description:
      "Lint every active business rule, client script and UI policy of a table (via describe_table_logic), " +
      "returning per-script findings and a severity summary.",
    package: "codecheck",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: {
      table: z.string(),
      scriptCount: z.number(),
      findingCount: z.number(),
      results: z.array(z.unknown()),
      warnings: z.array(z.unknown()),
    },
    input: {
      table: tableName().describe("Table to lint, e.g. 'incident'."),
    },
    logFields: (args) => ({ table: args.table }),
    handler: ({ table }) => lintTable(table).then(ok),
  }),

  defineTool({
    name: "servicenow_check_code_health",
    title: "Code health report",
    description:
      "Code-health report: script counts by type, ACL security scan (open, public-role, scripted, elevated ACLs, public REST/UI pages, tables without ACL), lint for a table, and new/fixed findings vs a stored baseline. Writes <profile>/code-health.md.",
    package: "codecheck",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: {
      scope: z.string(),
      generatedAt: z.string(),
      reportFile: z.string().optional(),
      warnings: z.array(z.unknown()),
    },
    input: {
      scope: tableName()
        .optional()
        .describe(
          "Table to lint in depth, e.g. 'incident'. Omit for an instance-wide inventory.",
        ),
      extended: z
        .boolean()
        .optional()
        .describe(
          "Also count the opt-in types and lint every registry script type instance-wide (newest `limit` per type).",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(ARTIFACT_LINT_LIMIT_MAX)
        .optional()
        .describe(
          `Records per type for extended, candidates per rule for domains (default ${ARTIFACT_LINT_LIMIT}).`,
        ),
      domains: z
        .boolean()
        .optional()
        .describe(
          "Also run the flow, Service Portal, UI Builder and legacy-workflow analysers (run-as-System on protected tables, unused subflows/actions, unguarded integration steps, long waits, public data widgets, orphans, route-map loops, UIB routes without a screen, screens without audience, brokers without ACL, workflows to migrate).",
        ),
      update_baseline: z
        .boolean()
        .optional()
        .describe(
          "Reset the baseline (<profile>/code-health.baseline.json) to this run; otherwise the first run records it and later runs report new/fixed findings against it.",
        ),
    },
    logFields: (args) => ({ scope: args.scope ?? "instance" }),
    handler: ({ scope, extended, domains, limit, update_baseline }) =>
      codeHealth(scope, {
        extended,
        domains,
        limit,
        updateBaseline: update_baseline,
      }).then(ok),
  }),
];
