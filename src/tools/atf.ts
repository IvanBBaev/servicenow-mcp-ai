import { z } from "zod";
import {
  listAtfTests,
  listAtfSuites,
  runAtfTest,
  runAtfSuite,
  getAtfResult,
} from "../api/atf.js";
import { ok } from "../mcp/result.js";
import { defineTool, type AnyToolSpec } from "../mcp/define.js";
import { shouldApply, planPreview, applyInput } from "../mcp/write-mode.js";
import { appendWriteJournal } from "../core/write-journal.js";

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
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {
      active: z.boolean().optional().describe("Filter by the active flag."),
      query: z.string().optional().describe("Extra encoded query."),
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
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {
      active: z.boolean().optional().describe("Filter by the active flag."),
      query: z.string().optional().describe("Extra encoded query."),
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
      "Run a single ATF test through the CI/CD API. EXECUTES CODE on the instance — use only on a " +
      "non-production instance with the sn_cicd plugin active. Returns an execution id to poll with " +
      "servicenow_get_atf_result.",
    package: "atf",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    input: {
      test_sys_id: z
        .string()
        .describe("sys_id of the ATF test (sys_atf_test)."),
      apply: applyInput,
    },
    handler: async ({ test_sys_id, apply }) => {
      if (!shouldApply(apply)) {
        return planPreview({
          action: "execute",
          table: "sys_atf_test",
          sys_id: test_sys_id,
          after: { run: "ATF test" },
        });
      }
      const result = await runAtfTest(test_sys_id);
      appendWriteJournal({
        action: "execute",
        table: "sys_atf_test",
        sys_id: test_sys_id,
      });
      return ok(result);
    },
  }),

  defineTool({
    name: "servicenow_run_atf_suite",
    title: "Run an ATF suite",
    description:
      "Run an ATF test suite through the CI/CD API. EXECUTES CODE on the instance. Returns an " +
      "execution id to poll with servicenow_get_atf_result.",
    package: "atf",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    input: {
      suite_sys_id: z
        .string()
        .describe("sys_id of the ATF test suite (sys_atf_test_suite)."),
      apply: applyInput,
    },
    handler: async ({ suite_sys_id, apply }) => {
      if (!shouldApply(apply)) {
        return planPreview({
          action: "execute",
          table: "sys_atf_test_suite",
          sys_id: suite_sys_id,
          after: { run: "ATF suite" },
        });
      }
      const result = await runAtfSuite(suite_sys_id);
      appendWriteJournal({
        action: "execute",
        table: "sys_atf_test_suite",
        sys_id: suite_sys_id,
      });
      return ok(result);
    },
  }),

  defineTool({
    name: "servicenow_get_atf_result",
    title: "Get ATF run result",
    description:
      "Poll an ATF run by its execution id: status, percent complete and message (CI/CD progress API).",
    package: "atf",
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {
      execution_id: z
        .string()
        .describe("The execution/progress id returned by a run tool."),
    },
    handler: ({ execution_id }) => getAtfResult(execution_id).then(ok),
  }),
];
