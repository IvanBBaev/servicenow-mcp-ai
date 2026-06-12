import test from "node:test";
import assert from "node:assert/strict";

import { okQueryResult } from "../build/mcp/result.js";
import { withEnv } from "./helpers.js";

const parse = (res) => JSON.parse(res.content[0].text);

test("okQueryResult passes small results through untouched", () => {
  const payload = parse(okQueryResult([{ a: 1 }], 1));
  assert.equal(payload.count, 1);
  assert.equal(payload.total, 1);
  assert.equal(payload.truncated, undefined);
  assert.deepEqual(payload.records, [{ a: 1 }]);
});

test("output is compact by default; SN_RESULT_PRETTY=true indents (О-2)", async () => {
  const compact = okQueryResult([{ a: 1 }]).content[0].text;
  assert.ok(!compact.includes("\n"), "default output must be single-line");

  await withEnv({ SN_RESULT_PRETTY: "true" }, () => {
    const pretty = okQueryResult([{ a: 1 }]).content[0].text;
    assert.ok(pretty.includes("\n  "), "pretty output must be indented");
  });
});

test("okQueryResult truncates oversized sets and explains how to narrow", async () => {
  await withEnv({ SN_MAX_RESULT_CHARS: "400" }, async () => {
    const records = Array.from({ length: 16 }, (_, i) => ({
      i,
      pad: "x".repeat(40),
    }));
    const res = okQueryResult(records, 160);
    const payload = parse(res);
    assert.equal(payload.truncated, true);
    assert.equal(payload.count, 16);
    assert.equal(payload.total, 160);
    assert.ok(payload.returned > 0 && payload.returned < 16);
    assert.equal(payload.records.length, payload.returned);
    assert.ok(res.content[0].text.length <= 400, "stays within the limit");
    assert.match(payload.note, /Narrow the query/);
  });
});

test("okQueryResult degrades to zero records when even one is too large", async () => {
  await withEnv({ SN_MAX_RESULT_CHARS: "50" }, async () => {
    const payload = parse(okQueryResult([{ big: "y".repeat(500) }]));
    assert.equal(payload.truncated, true);
    assert.equal(payload.returned, 0);
    assert.equal(payload.records, undefined);
  });
});
