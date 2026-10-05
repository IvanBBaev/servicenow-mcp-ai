import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { ok, okQueryResult, okStructured, fail } from "../build/mcp/result.js";
import {
  capResult,
  csvRowEnds,
  supportsFileFormat,
} from "../build/mcp/result-cap.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
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

test("capResult leaves errors alone", () => {
  const error = fail("x".repeat(500), { code: "INTERNAL_ERROR" });
  assert.equal(capResult(error, { maxChars: 50 }), error);
});

test("csvRowEnds keeps a quoted newline inside its row", () => {
  const csv = 'a,b\n1,"x\ny"\n2,z';
  const ends = csvRowEnds(csv);
  assert.equal(ends.length, 3);
  assert.equal(csv.slice(0, ends[1]), 'a,b\n1,"x\ny"');
  assert.equal(ends[2], csv.length);
});

test("a CSV payload keeps its header and whole rows", () => {
  const body = ["sys_id,short_description"];
  for (let i = 0; i < 200; i++)
    body.push(`id${i},"line one\nline ""two"" ${i}"`);
  const res = ok({ format: "csv", rows: 200, content: body.join("\n") });
  const capped = parse(capResult(res, { maxChars: 2_000 }));
  assert.ok(JSON.stringify(capped).length <= 2_000);
  assert.equal(capped.format, "csv");
  assert.equal(capped.rows, 200);
  assert.equal(capped.truncated, true);
  const kept = Number(/content: (\d+) of 200 rows/.exec(capped.note)?.[1]);
  assert.ok(kept > 0);
  // Header plus `kept` complete rows: the text is a prefix ending on a row.
  assert.ok(capped.content.startsWith("sys_id,short_description\n"));
  assert.equal(capped.content, body.slice(0, kept + 1).join("\n"));
});

test("a long string keeps a prefix once no array is left", () => {
  const script = "gs.info('x');\n".repeat(400);
  const res = ok({ sys_id: "abc", name: "SI", script, items: rows(3) });
  const capped = parse(capResult(res, { maxChars: 1_500 }));
  assert.ok(JSON.stringify(capped).length <= 1_500);
  assert.equal(capped.sys_id, "abc");
  assert.ok(script.startsWith(capped.script));
  assert.match(capped.note, /script: \d+ of 5600 chars/);
});

test("a Mermaid diagram is never cut (S-11 returns it whole)", () => {
  const mermaid = `erDiagram\n${"  a ||--o{ b : x\n".repeat(300)}`;
  const res = ok({ mermaid, note: "over the cap" });
  assert.equal(parse(capResult(res, { maxChars: 1_000 })).mermaid, mermaid);
});

test("a top-level array keeps its leading items and adds a note block", () => {
  const items = rows(60);
  const capped = capResult(ok(items), { maxChars: 1_500 });
  assert.equal(capped.content.length, 2);
  const kept = JSON.parse(capped.content[0].text);
  assert.ok(kept.length > 0 && kept.length < 60);
  assert.deepEqual(kept, items.slice(0, kept.length));
  assert.match(
    capped.content[1].text,
    new RegExp(`\\(array\\): ${kept.length} of 60 items`),
  );
  assert.ok(
    capped.content[0].text.length + capped.content[1].text.length <= 1_500,
  );
});

test("non-JSON text keeps whole leading lines, or a prefix of one line", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `| row ${i} | value |`);
  const text = lines.join("\n");
  const capped = capResult(
    { content: [{ type: "text", text }] },
    { maxChars: 600 },
  );
  assert.equal(capped.content.length, 2);
  const body = capped.content[0].text;
  assert.ok(lines.slice(0, body.split("\n").length).join("\n") === body);
  assert.match(capped.content[1].text, /\(text\): \d+ of 100 lines/);
  assert.ok(body.length + capped.content[1].text.length <= 600);

  const one = "y".repeat(5_000);
  const cut = capResult(
    { content: [{ type: "text", text: one }] },
    { maxChars: 600 },
  );
  assert.ok(cut.content[0].text.length > 0);
  assert.match(cut.content[1].text, /\(text\): \d+ of 5000 chars/);
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

test("query_table format:csv is capped by whole rows (N-61)", async () => {
  const spec = ALL_TOOLS.find((t) => t.name === "servicenow_query_table");
  const result = Array.from({ length: 300 }, (_, i) => ({
    sys_id: `s${String(i).padStart(3, "0")}`,
    short_description: `Row ${i}, with a comma`,
  }));
  await withEnv({ SN_MAX_RESULT_CHARS: "4000" }, () =>
    withFetch(
      () => jsonResponse(200, { result }, { "X-Total-Count": "300" }),
      async () => {
        const res = await runSpec(spec, {
          table: "incident",
          format: "csv",
          fields: ["sys_id", "short_description"],
          limit: 300,
        });
        const payload = parse(res);
        assert.ok(res.content[0].text.length <= 4_000);
        assert.equal(payload.truncated, true);
        const rowsKept = payload.content.split("\n");
        // The CSV opens with a UTF-8 BOM for spreadsheet apps.
        assert.equal(rowsKept[0], "\uFEFFsys_id,short_description");
        assert.equal(
          rowsKept.at(-1),
          `s${String(rowsKept.length - 2).padStart(3, "0")},"Row ${rowsKept.length - 2}, with a comma"`,
        );
        assert.match(payload.note, /content: \d+ of 300 rows/);
      },
    ),
  );
});
