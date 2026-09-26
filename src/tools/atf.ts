import { z } from "zod";
import {
  listAtfTests,
  listAtfSuites,
  runAtfTest,
  runAtfSuite,
  getAtfResult,
  waitForAtfRun,
  type AtfRun,
} from "../api/atf.js";
import { ok } from "../mcp/result.js";
import {
  defineTool,
  encodedQuery,
  sysId,
  type AnyToolSpec,
} from "../mcp/define.js";
import { shouldApply, planPreview, applyInput } from "../mcp/write-mode.js";
import { journaledWrite } from "../core/write-journal.js";

/** S-10: optional wait for the run to finish (non-breaking; default 0 = no wait). */
const waitSeconds = z
  .number()
  .int()
  .nonnegative()
  .max(300)
  .optional()
  .describe(
    "Wait up to this many seconds for the run to finish, polling its progress (default 0: return at once). On timeout the result has wait.state 'running' and wait.tracker, the id to poll with servicenow_get_atf_result.",
  );

/** Return the run as is, or waited on when `wait_seconds` is set. */
async function maybeWait(run: AtfRun, seconds: number | undefined) {
  return seconds ? waitForAtfRun(run, seconds * 1000) : run;
}

/**
 * ATF package (Phase 8): list and run Automated Test Framework tests/suites via
 * the CI/CD API. The run tools execute code on the instance — they are not
 * read-only, and this package is never in the default profile. Enable it
 * explicitly (SN_TOOL_PACKAGES=…,atf) on a non-production instance.
 */
export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_list_atf_tests",
    title: "List ATF tests",
    description:
      "List Automated Test Framework tests (sys_atf_test) as metadata: name, active flag, description.",
    package: "atf",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: { count: z.number(), tests: z.array(z.unknown()) },
    input: {
      active: z.boolean().optional().describe("Filter by the active flag."),
      query: encodedQuery().optional().describe("Extra encoded query."),
      limit: z.number().int().positive().max(1000).optional(),
    },
    handler: (args) =>
      listAtfTests(args).then((tests) => ok({ count: tests.length, tests })),
  }),

  defineTool({
    name: "servicenow_list_atf_suites",
    title: "List ATF suites",
    description:
      "List Automated Test Framework test suites (sys_atf_test_suite) as metadata.",
    package: "atf",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: { count: z.number(), suites: z.array(z.unknown()) },
    input: {
      active: z.boolean().optional().describe("Filter by the active flag."),
      query: encodedQuery().optional().describe("Extra encoded query."),
      limit: z.number().int().positive().max(1000).optional(),
    },
    handler: (args) =>
      listAtfSuites(args).then((suites) =>
        ok({ count: suites.length, suites }),
      ),
  }),

  defineTool({
    name: "servicenow_run_atf_test",
    title: "Run an ATF test",
    description:
      "Run one ATF test through the CI/CD API. EXECUTES CODE on the instance — non-production only, sn_cicd plugin required. Returns an execution id to poll with servicenow_get_atf_result, or pass wait_seconds to wait for the result.",
    package: "atf",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    input: {
      test_sys_id: sysId().describe("sys_id of the ATF test (sys_atf_test)."),
      wait_seconds: waitSeconds,
      apply: applyInput,
    },
    handler: async ({ test_sys_id, wait_seconds, apply }) => {
      if (!shouldApply(apply)) {
        return planPreview({
          action: "execute",
          table: "sys_atf_test",
          sys_id: test_sys_id,
          after: { run: "ATF test" },
        });
      }
      const result = await journaledWrite(
        {
          action: "execute",
          table: "sys_atf_test",
          sys_id: test_sys_id,
        },
        () => runAtfTest(test_sys_id),
      );
      return ok(await maybeWait(result, wait_seconds));
    },
  }),

  defineTool({
    name: "servicenow_run_atf_suite",
    title: "Run an ATF suite",
    description:
      "Run an ATF test suite through the CI/CD API. EXECUTES CODE on the instance. Returns an " +
      "execution id to poll with servicenow_get_atf_result, or pass wait_seconds to wait for the result.",
    package: "atf",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    input: {
      suite_sys_id: sysId().describe(
        "sys_id of the ATF test suite (sys_atf_test_suite).",
      ),
      wait_seconds: waitSeconds,
      apply: applyInput,
    },
    handler: async ({ suite_sys_id, wait_seconds, apply }) => {
      if (!shouldApply(apply)) {
        return planPreview({
          action: "execute",
          table: "sys_atf_test_suite",
          sys_id: suite_sys_id,
          after: { run: "ATF suite" },
        });
      }
      const result = await journaledWrite(
        {
          action: "execute",
          table: "sys_atf_test_suite",
          sys_id: suite_sys_id,
        },
        () => runAtfSuite(suite_sys_id),
      );
      return ok(await maybeWait(result, wait_seconds));
    },
  }),

  defineTool({
    name: "servicenow_get_atf_result",
    title: "Get ATF run result",
    description:
      "Poll an ATF run by its execution id: status, percent complete and message (CI/CD progress API).",
    package: "atf",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: {
      executionId: z.string().optional(),
      status: z.string().optional(),
      percentComplete: z.number().optional(),
    },
    input: {
      execution_id: sysId().describe(
        "The execution/progress id returned by a run tool.",
      ),
    },
    handler: ({ execution_id }) => getAtfResult(execution_id).then(ok),
  }),
];
