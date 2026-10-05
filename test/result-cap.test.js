import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { ok, okQueryResult, okStructured, fail } from "../build/mcp/result.js";
import { capResult, supportsFileFormat } from "../build/mcp/result-cap.js";
import { defineTool, runSpec, buildOutputSchema } from "../build/mcp/define.js";
import { listChanges } from "../build/api/change.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

/**
 * N-61 — the universal, shape-preserving result cap (src/mcp/result-cap.ts)
 * and the result size bug fixes: binary-search truncation in okQueryResult and
 * the `list_changes` default limit.
 */

const parse = (res) => JSON.parse(res.content[0].text);
const rows = (n, pad = 40) =>
  Array.from({ length: n }, (_, i) => ({ i, pad: "x".repeat(pad) }));

/** The largest k for which `build(k)` serializes within `max` (brute force). */
function bestFit(build, n, max) {
  let best = 0;
  for (let k = 0; k <= n; k++) {
    if (JSON.stringify(build(k)).length <= max) best = k;
  }
  return best;
}

test("capResult passes a result within the limit through unchanged", () => {
  const res = ok({ items: rows(3) });
  assert.equal(capResult(res, { maxChars: 10_000 }), res);
});

test("capResult shrinks the largest array, keeps every key and says so", () => {
  const res = ok({
    plan_token: "tok-123",
    count: 50,
    meta: { small: [1, 2] },
    items: rows(50),
  });
  const capped = parse(capResult(res, { maxChars: 1_000 }));
  assert.equal(capped.plan_token, "tok-123");
  assert.equal(capped.count, 50);
  assert.deepEqual(capped.meta, { small: [1, 2] });
  assert.equal(capped.truncated, true);
  assert.match(capped.note, /items: \d+ of 50/);
  assert.match(capped.note, /Narrow the request/);
  assert.doesNotMatch(capped.note, /format:"file"/);
  assert.ok(JSON.stringify(capped).length <= 1_000);
});

test("capResult keeps the most items that fit (binary search, not halving)", () => {
  const max = 3_200;
  const items = rows(64);
  const capped = parse(capResult(ok({ items }), { maxChars: max }));
  // The note grows with the digits it prints, so compare against a brute
  // force over the final envelope.
  const kept = capped.items.length;
  const fitted = bestFit(
    (k) => ({ ...capped, items: items.slice(0, k) }),
    64,
    max,
  );
  assert.equal(kept, fitted);
  assert.ok(kept > 32, `kept ${kept}: halving would stop at 32 or less`);
});

test("capResult reaches nested arrays and appends to an existing note", () => {
  const res = ok({
    note: "Partial read.",
    result: { children: rows(40) },
  });
  const capped = parse(capResult(res, { maxChars: 800 }));
  assert.ok(capped.result.children.length < 40);
  assert.match(capped.note, /^Partial read\. Result too large/);
  assert.match(capped.note, /result\.children: \d+ of 40/);
});

test('capResult adds the format:"file" hint only when asked', () => {
  const capped = parse(
    capResult(ok({ items: rows(40) }), { maxChars: 600, fileHint: true }),
  );
  assert.match(capped.note, /format:"file"/);
});

test("capResult leaves errors, non-JSON text and top-level arrays alone", () => {
  const error = fail("x".repeat(500), { code: "INTERNAL_ERROR" });
  assert.equal(capResult(error, { maxChars: 50 }), error);
  const csv = { content: [{ type: "text", text: "a,b\n".repeat(200) }] };
  assert.equal(capResult(csv, { maxChars: 50 }), csv);
  const list = ok(rows(30));
  assert.equal(capResult(list, { maxChars: 50 }), list);
});

test("capResult keeps structuredContent in step with the text", () => {
  const capped = capResult(okStructured({ items: rows(40) }), {
    maxChars: 600,
  });
  assert.deepEqual(capped.structuredContent, parse(capped));
});

test("supportsFileFormat reads the tool's format enum", () => {
  assert.equal(supportsFileFormat({ format: z.enum(["json", "file"]) }), true);
  assert.equal(
    supportsFileFormat({ format: z.enum(["json", "csv"]).optional() }),
    false,
  );
  assert.equal(supportsFileFormat({}), false);
  assert.equal(supportsFileFormat(undefined), false);
});

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

test("runSpec caps a tool without an output schema", async () => {
  const spec = defineTool({
    name: "servicenow_n61_plain",
    title: "N-61 plain",
    description: "Test double.",
    package: "table",
    annotations,
    input: {},
    handler: async () => ok({ result: rows(200) }),
  });
  await withEnv({ SN_MAX_RESULT_CHARS: "2000" }, async () => {
    const res = await runSpec(spec, {});
    assert.ok(res.content[0].text.length <= 2_000);
    assert.equal(parse(res).truncated, true);
  });
});

test("a capped result still passes the tool's output schema", async () => {
  const spec = defineTool({
    name: "servicenow_n61_structured",
    title: "N-61 structured",
    description: "Test double.",
    package: "table",
    annotations,
    input: { format: z.enum(["json", "file"]).optional() },
    output: {
      plan_token: z.string(),
      total: z.number(),
      items: z.array(z.object({ i: z.number(), pad: z.string() })),
    },
    handler: async () => ok({ plan_token: "t", total: 300, items: rows(300) }),
  });
  await withEnv({ SN_MAX_RESULT_CHARS: "3000" }, async () => {
    const res = await runSpec(spec, {});
    assert.ok(res.structuredContent, "structuredContent present");
    const parsed = buildOutputSchema(spec).safeParse(res.structuredContent);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    assert.equal(res.structuredContent.truncated, true);
    assert.match(res.structuredContent.note, /format:"file"/);
    assert.ok(res.content[0].text.length <= 3_000);
  });
});

test("okQueryResult keeps the most records that fit (N-61)", async () => {
  await withEnv({ SN_MAX_RESULT_CHARS: "3200" }, async () => {
    const records = rows(64);
    const payload = parse(okQueryResult(records, 64));
    const fitted = bestFit(
      (k) => ({ ...payload, returned: k, records: records.slice(0, k) }),
      64,
      3_200,
    );
    assert.equal(payload.returned, fitted);
    assert.ok(payload.returned > 32);
  });
});

test("list_changes defaults to 10 rows and keeps an explicit limit", async () => {
  const seen = [];
  await withFetch(
    (url) => {
      seen.push(new URL(url).searchParams.get("sysparm_limit"));
      return jsonResponse(200, { result: [] });
    },
    async () => {
      await listChanges();
      await listChanges({ limit: 50 });
    },
  );
  assert.deepEqual(seen, ["10", "50"]);
});
