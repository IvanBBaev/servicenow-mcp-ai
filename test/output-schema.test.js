import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { listPublishedTools, measureSurface, PROFILES } from "./surface.js";

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
 * Batch 12 (P-17 get_artifact_dependencies; 90 tools) measured 133,469 (all)
 * and 31,151 (core): the all budget rises to 134,000.
 * Batch 12 (M-5 list/enable/disable_package; 92 tools, 3 in the always-on admin package) measured 132,949 (all) and 34,426 (core).
 * The merged batch 12 tree (93 tools) measured 137,276 (all) and 34,426 (core).
 * H-3 (the automatic plan_token argument on six destructive-apply tools)
 * measured 137,894 (all) and 34,632 (core): the all budget rises to 139,000.
 * H-4 (check_change_conflicts apply + plan_token) measured 138,248 (all).
 * H-11 (servicenow_explain_policy, always-on admin; 94 tools) measured
 * 139,089 (all) and 35,473 (core): the budgets rise to 140,000 / 36,000.
 * H-3 remainder (expected_mod_count on update/delete_record) measured
 * 139,421 (all) and 35,805 (core): within the budget.
 * P-18 (check_code_health extended/limit, where_used extended, lint_script opt-in
 * types) measured 139,658 (all) and 35,805 (core): within the budget.
 * P-20 (types/scope on snapshot_instance and compare_instances, both in the
 * opt-in instance package) measured 140,142 (all) and 35,805 (core): the all
 * budget rises to 141,000.
 * P-21 (document_app detail) measured 140,292 (all): within the budget.
 * P-23 (servicenow_upsert_artifact in the opt-in artifacts package; 95
 * tools) measured 143,644 (all) and 35,805 (core): the all budget
 * rises to 144,000.
 * P-24/P-25 (children[].parent for nested artefact children, flow toggle
 * wording) and P-14 / P-15 (servicenow_explain_ui_experience in the opt-in ui
 * package, P-19 UIB / P-21 UIB describe text) together measured about 146,000
 * (all): the all budget rises to 146,500.
 * P-26 (servicenow_generate_fluent in the opt-in artifacts package; 97
 * tools) measured 148,384 (all) and 35,805 (core): the all budget rises to
 * 148,500.
 * E-2 (zod 4: the SDK converts the schemas with zod's own toJSONSchema —
 * `propertyNames` on every record, an inlined `$ref`, the safe-integer
 * `maximum` of `.int()`) measured 150,175 (all) and 36,224 (core): the
 * budgets rise to 151,000 / 36,500.
 * M-7 (tool naming v3: renamed tools, `values` / `sys_id` / `table`
 * parameters, the always-published `class_name` deprecated alias on the CMDB
 * tools) measured 150,916 (all) and 36,158 (core): within the budget. The
 * legacy alias tools (SN_LEGACY_TOOL_NAMES=1, off by default and not
 * budgeted) add about 20 KB to `all`.
 * N-0 option (b), 2026-10-03: description-text byte reclaim (no name, type,
 * enum, required-ness, outputSchema or annotation change) measured 135,881
 * (all, 97 tools; was 150,916) and 32,737 (core; was 36,158). The constants
 * below are unchanged: restating them is owner gate O-10.
 * N-57 step 1, 2026-10-05: the budgets moved to
 * `test/fixtures/token-budgets.json` and were lowered (tightened only, no
 * wire change) to the measured 135,956 (all) and 32,737 (core), rounded up
 * to 256 B, so the N-54 outputSchema growth is measured instead of hiding in
 * ~15 KB of dead headroom. Raising a budget is still owner gate O-10.
 * N-57, 2026-10-05: one budget per test/surface.js profile (core, all,
 * all+tasks, all+legacy), measured 32,737 / 135,991 / 137,343 / 154,621;
 * the tasks and legacy surfaces were not budgeted before. A budget more than
 * `slackPct` above its measurement fails the ratchet test.
 * N-54, 2026-10-09 (owner, O-10: up to +4 KB on `all`, `core` unchanged): 31
 * opt-in tools gain an outputSchema from the shared shapes in
 * `src/mcp/output-shapes.ts`, measured 28,546 / 123,278 / 124,648 / 140,167
 * (all +3,831 B; core +0 B): the budgets become 28,672 / 123,392 / 124,672 /
 * 140,288. The 29 tools left without one are in
 * `test/fixtures/output-shape-register.json`.
 * N-36, 2026-10-09 (owner): `servicenow_find_tools` joins every profile,
 * +761 B each: 29,440 / 124,160 / 125,440 / 141,056.
 * N-54, 2026-10-09 (owner, O-10: about +1 KB more on `all`, `core`
 * unchanged): the 7 stable-shape tools that were past the first allowance
 * gain an outputSchema (ATF runs, docs store, upsert_artifact), measured
 * 29,307 / 125,182 / 126,552 / 142,759 (all +1,143 B; core +0 B): the budgets
 * become 29,440 / 125,184 / 126,720 / 142,848. `explain_portal` moves to the
 * register as a delivery tool (inline JSON or a file reference).
 * N-5, 2026-10-09 (owner, O-10: up to +4 KB on `all` for the N-5 / N-16 /
 * N-1 / N-22 opt-in wiring, `core` unchanged): `servicenow_get_task_context`
 * in the opt-in history package, measured 29,307 / 126,041 / 127,411 /
 * 143,618 (all +859 B; core +0 B): the budgets become 29,440 / 126,208 /
 * 127,488 / 143,872.
 * N-60, 2026-10-09 (owner, O-10 (c)): the published outputSchema is shallow
 * (top-level names, types and `required`; the full shape stays in the
 * manifest, the tool docs and the tool reference), measured 26,583 / 116,580
 * / 117,950 / 133,111 (all −9,461 B; core −2,724 B): the budgets ratchet down
 * to 26,624 / 116,736 / 118,016 / 133,120. The N-5 / N-16 / N-1 / N-22
 * allowance above is still counted as growth from here.
 * N-1, 2026-10-09 (same N-5 / N-16 / N-1 / N-22 allowance):
 * `servicenow_review_upgrade` in the opt-in instance package, measured
 * 26,583 / 117,388 / 118,758 / 133,919 (all +808 B; core +0 B): the budgets
 * become 26,624 / 117,504 / 118,784 / 134,144.
 * N-16, 2026-10-09 (same allowance): `with_results` on
 * `servicenow_list_atf_tests` / `servicenow_list_atf_suites`, measured
 * 26,583 / 117,682 / 119,052 / 134,213 (all +294 B; core +0 B): the budgets
 * become 26,624 / 117,760 / 119,296 / 134,400.
 * N-22, 2026-10-09 (same allowance; 2,131 B of it used in all):
 * `role_history` on `servicenow_lookup_directory` and the `access_review`
 * kind of `servicenow_document_instance`, measured 26,583 / 117,852 /
 * 119,222 / 134,383 (all +170 B; core +0 B): `all` becomes 118,016, the
 * others still fit.
 *
 * N-15, 2026-10-09 (owner: core may grow one 256 B step for it): `explain`
 * on `servicenow_query_table` (core), measured 26,719 / 117,988 / 119,358 /
 * 134,519 (+136 B on every profile): `core` becomes 26,880, `all+tasks`
 * 119,552 and `all+legacy` 134,656; `all` still fits 118,016.
 * N-7, 2026-10-09 (owner: one 256 B step on `all`): `kind` (`app` | `i18n`)
 * and `language` on `servicenow_document_app` (opt-in docs package),
 * measured 26,719 / 118,225 / 119,595 / 134,756 (all +227 B; core +0 B):
 * the budgets become 26,880 / 118,272 / 119,808 / 134,912.
 * ADR 0010, 2026-10-10 (B15): `servicenow_generate_fluent` leaves the opt-in
 * artifacts package (100 tools), measured 27,084 / 119,204 / 120,574 /
 * 135,914: the budgets ratchet down to 27,136 / 119,296 / 120,576 / 135,936.
 */
const TOKEN_BUDGETS = JSON.parse(
  readFileSync(
    new URL("./fixtures/token-budgets.json", import.meta.url),
    "utf8",
  ),
);

/** The published tools for a package selection (test/surface.js pins env). */
const listTools = (packages) =>
  listPublishedTools({ SN_TOOL_PACKAGES: packages });

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

test("tools/list stays within the byte budget of every profile", async () => {
  assert.deepEqual(
    Object.keys(TOKEN_BUDGETS.profiles).sort(),
    Object.keys(PROFILES).sort(),
    "every measured profile has a budget",
  );
  const all = await measureSurface("all");
  assert.equal(all.tools, ALL_TOOLS.length);
  for (const [profile, budget] of Object.entries(TOKEN_BUDGETS.profiles)) {
    const { bytes } = await measureSurface(profile);
    assert.ok(bytes <= budget, `${profile}: ${bytes} > ${budget} (O-10)`);
  }
});

test("tools/list budget is tight (ratchet down)", async () => {
  // N-57: a saving cannot sit as headroom. Run `npm run tokens:budget --
  // --write` to lower the fixture after a change that shrinks the surface.
  const floor = 1 - TOKEN_BUDGETS.slackPct / 100;
  for (const [profile, budget] of Object.entries(TOKEN_BUDGETS.profiles)) {
    const { bytes } = await measureSurface(profile);
    assert.ok(
      bytes >= Math.floor(budget * floor),
      `${profile}: ${bytes} is more than ${TOKEN_BUDGETS.slackPct}% under its budget ${budget}; run npm run tokens:budget -- --write`,
    );
  }
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
    // E-2: zod 4 writes the passthrough as `{}` (any value) where the zod 3
    // converter wrote `true` — the same JSON Schema meaning.
    assert.deepEqual(tool.outputSchema.additionalProperties, {}, tool.name);
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
    "servicenow_check_code_health",
  ]) {
    assert.ok(withOutput.has(name), `${name} declares an output shape`);
  }
});

/** N-54: the tools without an outputSchema, each with a reason. */
const OUTPUT_REGISTER = JSON.parse(
  readFileSync(
    new URL("./fixtures/output-shape-register.json", import.meta.url),
    "utf8",
  ),
);

test("every tool without an outputSchema is in the register, which only shrinks", async () => {
  const missing = (await listTools("all"))
    .filter((t) => !t.outputSchema)
    .map((t) => t.name)
    .sort();
  const listed = Object.keys(OUTPUT_REGISTER.tools).sort();
  assert.deepEqual(
    listed,
    missing,
    "the register lists exactly the tools without an outputSchema",
  );
  assert.ok(
    listed.length <= OUTPUT_REGISTER.ceiling,
    `${listed.length} entries exceed the ceiling ${OUTPUT_REGISTER.ceiling}`,
  );
  assert.equal(
    OUTPUT_REGISTER.ceiling,
    listed.length,
    "lower the ceiling to the register size",
  );
  for (const [name, reason] of Object.entries(OUTPUT_REGISTER.tools)) {
    assert.ok(OUTPUT_REGISTER.reasons[reason], `${name}: unknown reason`);
  }
});

test("the shared N-54 output shapes pass the SDK output validation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sn-n54-"));
  const id = "a".repeat(32);
  const calls = [
    ["servicenow_get_change", { sys_id: id }],
    ["servicenow_list_catalogs", {}],
    ["servicenow_create_change", { type: "normal" }],
    ["servicenow_create_change", { type: "normal", apply: true }],
    ["servicenow_get_properties", { prefix: "glide" }],
    ["servicenow_list_ci_relations", { sys_id: id }],
    ["servicenow_lookup_directory", { kind: "user", term: "abel" }],
    ["servicenow_get_record_history", { table: "incident", sys_id: id }],
    ["servicenow_list_writes", {}],
    ["servicenow_write_doc", { path: "n54.md", content: "# N-54" }],
    ["servicenow_read_doc", { path: "n54.md" }],
    ["servicenow_list_docs", {}],
    ["servicenow_search_docs", { text: "N-54" }],
    ["servicenow_run_atf_test", { sys_id: id }],
  ];
  try {
    await withEnv({ SN_TOOL_PACKAGES: "all", SN_DOCS_DIR: dir }, () =>
      withClient((client) =>
        withFetch(
          () =>
            jsonResponse(
              200,
              { result: [{ sys_id: id, name: "glide.x", value: "1" }] },
              { "x-total-count": "1" },
            ),
          async () => {
            for (const [name, args] of calls) {
              const res = await client.callTool({ name, arguments: args });
              assert.ok(!res.isError, `${name}: ${res.content[0].text}`);
              assert.deepEqual(
                res.structuredContent,
                JSON.parse(res.content[0].text),
                `${name}: structuredContent mirrors the text`,
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
