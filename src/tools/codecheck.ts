import { z } from "zod";
import {
  ARTIFACT_LINT_LIMIT,
  ARTIFACT_LINT_LIMIT_MAX,
  lintScript,
  lintTable,
  codeHealth,
} from "../api/codecheck.js";
import {
  runInstanceScan,
  SCAN_RESULT_TABLE,
  type InstanceScanTarget,
} from "../api/instance-scan.js";
import { ServiceNowError } from "../core/errors.js";
import { journaledWrite } from "../core/write-journal.js";
import { OPT_IN_SCRIPT_TYPE_NAMES, SCRIPT_TYPE_NAMES } from "../api/scripts.js";
import { ok } from "../mcp/result.js";
import {
  defineTool,
  sysId,
  tableName,
  SYS_ID_SHAPE_RE,
  type AnyToolSpec,
} from "../mcp/define.js";
import { shouldApply, planPreview } from "../mcp/write-mode.js";

// P-18: lint_script takes the opt-in registry types (UI Builder, portal) too.
const scriptType = z.enum([
  ...SCRIPT_TYPE_NAMES,
  ...OPT_IN_SCRIPT_TYPE_NAMES,
] as [string, ...string[]]);

/**
 * N-3: the Instance Scan target of a `scan_run` call — a point scan needs the
 * record's table (`scope`) and `sys_id`, a suite scan the suite's `sys_id`.
 */
function scanTarget(
  run: "full" | "point" | "suite",
  scope: string | undefined,
  sysId: string | undefined,
): InstanceScanTarget {
  if (sysId !== undefined && !SYS_ID_SHAPE_RE.test(sysId))
    throw new ServiceNowError("sys_id must be a sys_id.", 400, undefined, {
      code: "INVALID_INPUT",
      hint: "Letters, digits, '_' or '-'; at most 32.",
    });
  if (run === "full") return { kind: "full" };
  if (sysId && run === "suite") return { kind: "suite", suiteSysId: sysId };
  if (sysId && scope) return { kind: "point", table: scope, sysId };
  throw new ServiceNowError(
    `scan_run "${run}" needs ${run === "point" ? "scope and sys_id" : "sys_id"}.`,
    400,
    undefined,
    {
      code: "INVALID_INPUT",
      hint: "point: scope = the record's table, sys_id = the record; suite: sys_id = the scan suite.",
    },
  );
}

/**
 * N-3: start an Instance Scan through the CI/CD API on the ATF rails — a
 * plan preview unless applied, then a journalled `execute` on `scan_result`.
 * The answer keeps the report's required fields; poll the progress id with
 * servicenow_get_atf_result. Refusal on a production-marked profile waits
 * for the H-11 marker (O-4).
 */
async function startScan(
  run: "full" | "point" | "suite",
  scope: string | undefined,
  sysId: string | undefined,
  apply: boolean | undefined,
) {
  const target = scanTarget(run, scope, sysId);
  const head = {
    scope: scope ?? "instance",
    generatedAt: new Date().toISOString(),
    warnings: [],
  };
  const record = target.kind === "full" ? undefined : sysId;
  if (!shouldApply(apply)) {
    return planPreview(
      {
        action: "execute",
        table: SCAN_RESULT_TABLE,
        ...(record ? { sys_id: record } : {}),
        after: { run: `Instance Scan (${run})` },
      },
      head,
    );
  }
  const started = await journaledWrite(
    {
      action: "execute",
      table: SCAN_RESULT_TABLE,
      ...(record ? { sys_id: record } : {}),
    },
    () => runInstanceScan(target),
  );
  return ok({ ...head, ...started });
}

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
      "Run deterministic code-quality rules on one script (hard-coded sys_ids, unbounded or in-loop GlideRecord, eval, …): findings with rule, severity, line, fix hint.",
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
      sys_id: sysId().describe("Script sys_id."),
    },
    logFields: (args) => ({ type: args.type }),
    handler: ({ type, sys_id }) => lintScript(type, sys_id).then(ok),
  }),

  defineTool({
    name: "servicenow_lint_table",
    title: "Lint a table's scripts",
    description:
      "Lint every active business rule, client script and UI policy of a table: " +
      "per-script findings and a severity summary.",
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
      "Code-health report: script counts, ACL scan, table lint, new/fixed findings vs baseline. Writes <profile>/code-health.md.",
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
        .describe("Table to lint; omit for an instance-wide inventory."),
      extended: z
        .boolean()
        .optional()
        .describe(
          "Also count opt-in types and lint every script type instance-wide (newest `limit`).",
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
          "Also run the flow, portal, UI Builder and legacy-workflow analysers.",
        ),
      update_baseline: z
        .boolean()
        .optional()
        .describe(
          "Reset the baseline to this run; otherwise new/fixed findings are reported against it.",
        ),
      scan_run: z
        .enum(["full", "point", "suite"])
        .optional()
        .describe("Run Instance Scan; point: scope+sys_id, suite: sys_id."),
      // Shape-checked in scanTarget: a schema pattern would not fit the budget.
      sys_id: z.string().max(32).optional().describe("Its target."),
      apply: z.boolean().optional().describe("true runs it."),
    },
    logFields: (args) => ({ scope: args.scope ?? "instance" }),
    handler: ({
      scope,
      extended,
      domains,
      limit,
      update_baseline,
      scan_run,
      sys_id,
      apply,
    }) =>
      scan_run
        ? startScan(scan_run, scope, sys_id, apply)
        : codeHealth(scope, {
            extended,
            domains,
            limit,
            updateBaseline: update_baseline,
          }).then(ok),
  }),
];
