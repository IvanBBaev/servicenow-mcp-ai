import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ALL_TOOLS, registerAllTools } from "../build/mcp/registry.js";
import {
  defineTool,
  runSpec,
  buildOutputSchema,
  instanceParam,
} from "../build/mcp/define.js";
import { ok, okStructured, fail } from "../build/mcp/result.js";
import { currentRuntime } from "../build/core/runtime.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

/**
 * M-6 — outputSchema + token budget. The limits are named so a change is a
 * visible, reviewed edit.
 */

/** Longest tool description (characters). */
const MAX_DESCRIPTION_CHARS = 250;

/** Longest description of the automatic `instance` (profile) parameter. */
const MAX_INSTANCE_PARAM_CHARS = 30;

/**
 * Byte budget of a tools/list response (JSON.stringify of the tools array).
 * The roadmap targets are 45,000 (all) and 14,000 (core); the measured values
 * after M-6 were 124,050 (all, 86 tools) and 30,560 (core, 20 tools), so these
 * are the measured values rounded up to the next 1,000 — a ratchet that stops
 * growth. A new tool raises them in the same, reviewed change: batch 10
 * (document_instance, explain_portal; 88 tools) measured 127,239 (all).
 * Batch 11 (M-1, get_status v2 anchor keys in the core admin package)
 * measured 127,830 (all) and 31,151 (core): the core budget rises to 32,000.
 * Batch 11 (explain_flow; 89 tools) measured 129,083 (all) alone; the merged
 * batch 11 tree measured 129,674 (all) and 31,151 (core).
 * Batch 12 (S-16 document_instance depth) measured 129,954 (all) and 31,151 (core).
 * Batch 12 (P-11 explain_flow kind:"action" + depth) measured 129,926 (all)
 * and 31,151 (core): both stay within the budget.
 * Batch 12 (P-17 artifact_dependencies; 90 tools) measured 133,469 (all)
 * and 31,151 (core): the all budget rises to 134,000.
 * Batch 12 (M-5 list/enable/disable_package; 92 tools, 3 in the always-on admin package) measured 132,949 (all) and 34,426 (core).
 * The merged batch 12 tree (93 tools) measured 137,276 (all) and 34,426 (core).
 * H-3 (the automatic plan_token argument on six destructive-apply tools)
 * measured 137,894 (all) and 34,632 (core): the all budget rises to 139,000.
 * H-4 (change_conflicts apply + plan_token) measured 138,248 (all).
 * H-11 (servicenow_explain_policy, always-on admin; 94 tools) measured
 * 139,089 (all) and 35,473 (core): the budgets rise to 140,000 / 36,000.
 * H-3 remainder (expected_mod_count on update/delete_record) measured
 * 139,421 (all) and 35,805 (core): within the budget.
 * P-18 (code_health extended/limit, where_used extended, lint_script opt-in
 * types) measured 139,658 (all) and 35,805 (core): within the budget.
 * P-20 (types/scope on snapshot_instance and compare_instances, both in the
 * opt-in instance package) measured 140,142 (all) and 35,805 (core): the all
 * budget rises to 141,000.
 * P-21 (document_app detail) measured 140,292 (all): within the budget.
 * owner to restate (M-6 budget)
 */
const TOOLS_LIST_BUDGET_ALL = 141_000;
const TOOLS_LIST_BUDGET_CORE = 36_000;

async function listTools(packages) {
  return withEnv({ SN_TOOL_PACKAGES: packages }, async () => {
    const server = new McpServer({ name: "budget-test", version: "0.0.0" });
    registerAllTools(server, currentRuntime());
    const client = new Client({ name: "budget-client", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      return (await client.listTools()).tools;
    } finally {
      await client.close();
      await server.close();
    }
  });
}

async function withClient(fn) {
  const server = new McpServer({ name: "m6-test", version: "0.0.0" });
  registerAllTools(server, currentRuntime());
  const client = new Client({ name: "m6-client", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const fakeTool = (handler) =>
  defineTool({
    name: "servicenow_m6_fake",
    title: "M-6 fake",
    description: "Test double.",
    package: "table",
    annotations,
    input: {},
    output: { n: z.number() },
    handler,
  });

test("every tool description stays within the M-6 cap", () => {
  const over = ALL_TOOLS.filter(
    (t) => t.description.length > MAX_DESCRIPTION_CHARS,
  ).map((t) => `${t.name} (${t.description.length})`);
  assert.deepEqual(over, [], `descriptions over ${MAX_DESCRIPTION_CHARS}`);
});

test("the automatic instance parameter description is short", () => {
  assert.ok(
    instanceParam.description.length <= MAX_INSTANCE_PARAM_CHARS,
    instanceParam.description,
  );
});

test("tools/list stays within the byte budget (all and core)", async () => {
  const all = await listTools("all");
  const core = await listTools(undefined);
  assert.equal(all.length, ALL_TOOLS.length);
  const allBytes = JSON.stringify(all).length;
  const coreBytes = JSON.stringify(core).length;
  assert.ok(
    allBytes <= TOOLS_LIST_BUDGET_ALL,
    `all: ${allBytes} > ${TOOLS_LIST_BUDGET_ALL}`,
  );
  assert.ok(
    coreBytes <= TOOLS_LIST_BUDGET_CORE,
    `core: ${coreBytes} > ${TOOLS_LIST_BUDGET_CORE}`,
  );
});

test("tools with an output shape publish a permissive outputSchema", async () => {
  const tools = await listTools("all");
  const withOutput = new Set(
    ALL_TOOLS.filter((s) => s.output).map((s) => s.name),
  );
  for (const tool of tools) {
    if (!withOutput.has(tool.name)) {
      assert.equal(tool.outputSchema, undefined, tool.name);
      continue;
    }
    assert.equal(tool.outputSchema?.type, "object", tool.name);
    assert.equal(tool.outputSchema.additionalProperties, true, tool.name);
  }
  for (const name of [
    "servicenow_get_status",
    "servicenow_list_instances",
    "servicenow_check_capabilities",
    "servicenow_describe_table",
    "servicenow_list_tables",
    "servicenow_query_table",
    "servicenow_get_record",
    "servicenow_aggregate",
    "servicenow_list_scripts",
    "servicenow_list_flows",
    "servicenow_lint_script",
    "servicenow_code_health",
  ]) {
    assert.ok(withOutput.has(name), `${name} declares an output shape`);
  }
});

test("buildOutputSchema is a passthrough object (extra keys are kept)", () => {
  const spec = fakeTool(() => ok({ n: 1 }));
  const parsed = buildOutputSchema(spec).parse({ n: 1, extra: "kept" });
  assert.deepEqual(parsed, { n: 1, extra: "kept" });
  assert.equal(
    buildOutputSchema({ ...spec, output: undefined }),
    undefined,
    "no output shape, no outputSchema",
  );
});

test("runSpec parses a JSON success into structuredContent", async () => {
  const res = await runSpec(
    fakeTool(() => ok({ n: 2, more: true })),
    {},
  );
  assert.deepEqual(res.structuredContent, { n: 2, more: true });
  assert.equal(JSON.parse(res.content[0].text).n, 2, "text content stays");
});

test("runSpec keeps an okStructured payload as it is", async () => {
  const res = await runSpec(
    fakeTool(() => okStructured({ n: 3 })),
    {},
  );
  assert.deepEqual(res.structuredContent, { n: 3 });
});

test("an error result never carries structuredContent", async () => {
  const failed = await runSpec(
    fakeTool(() => fail(new Error("boom"))),
    {},
  );
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent, undefined);
  const flagged = await runSpec(
    fakeTool(() => ({ ...okStructured({ n: 4 }), isError: true })),
    {},
  );
  assert.equal(flagged.isError, true);
  assert.equal(flagged.structuredContent, undefined, "stripped");
  const thrown = await runSpec(
    fakeTool(() => {
      throw new Error("thrown");
    }),
    {},
  );
  assert.equal(thrown.structuredContent, undefined);
});

test("a non-object payload gets no structuredContent", async () => {
  const res = await runSpec(
    fakeTool(() => ok([1, 2])),
    {},
  );
  assert.equal(res.structuredContent, undefined);
});

test("query_table json, csv and file payloads pass the SDK output validation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sn-m6-"));
  try {
    await withEnv({ SN_TOOL_PACKAGES: "all", SN_DOCS_DIR: dir }, () =>
      withClient((client) =>
        withFetch(
          () =>
            jsonResponse(
              200,
              { result: [{ number: "INC001", sys_id: "a1" }] },
              { "x-total-count": "1" },
            ),
          async () => {
            for (const format of ["json", "csv", "file"]) {
              const res = await client.callTool({
                name: "servicenow_query_table",
                arguments: { table: "incident", format },
              });
              assert.ok(!res.isError, `${format}: ${res.content[0].text}`);
              assert.equal(
                typeof res.structuredContent,
                "object",
                `${format} carries structuredContent`,
              );
              assert.deepEqual(
                res.structuredContent,
                JSON.parse(res.content[0].text),
                `${format}: structuredContent mirrors the text`,
              );
            }
          },
        ),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an error over the SDK carries no structuredContent", async () => {
  await withEnv({ SN_TOOL_PACKAGES: "all" }, () =>
    withClient((client) =>
      withFetch(
        () => jsonResponse(403, { error: { message: "denied" } }),
        async () => {
          const res = await client.callTool({
            name: "servicenow_list_tables",
            arguments: {},
          });
          assert.equal(res.isError, true);
          assert.equal(res.structuredContent, undefined);
        },
      ),
    ),
  );
});
