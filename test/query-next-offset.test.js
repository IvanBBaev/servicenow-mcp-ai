// N-40 — a paged query_table read names the offset of the next page
// (`next_offset`) while the instance has more rows, and a page cut by
// SN_MAX_RESULT_CHARS names the offset right after the rows it kept.
import test from "node:test";
import assert from "node:assert/strict";

import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const queryTable = ALL_TOOLS.find((s) => s.name === "servicenow_query_table");

/** An incident table of `total` rows answering offset/limit like the Table API. */
function instance(total, seen = []) {
  return (url) => {
    const u = new URL(url);
    seen.push(u);
    const offset = Number(u.searchParams.get("sysparm_offset") ?? 0);
    const limit = Number(u.searchParams.get("sysparm_limit") ?? 10);
    const rows = [];
    for (let i = offset; i < Math.min(total, offset + limit); i++) {
      rows.push({ sys_id: String(i).padStart(32, "0"), number: `INC${i}` });
    }
    const counted = u.searchParams.get("sysparm_no_count") !== "true";
    return jsonResponse(
      200,
      { result: rows },
      counted ? { "X-Total-Count": String(total) } : {},
    );
  };
}

async function call(args, total, env = {}) {
  freshRuntime();
  const seen = [];
  const res = await withEnv(env, () =>
    withFetch(instance(total, seen), () => runSpec(queryTable, args)),
  );
  assert.ok(!res.isError, res.content[0].text);
  return { body: JSON.parse(res.content[0].text), seen };
}

test("N-40: next_offset is offset + limit while the instance has more", async () => {
  const { body, seen } = await call(
    { table: "incident", limit: 5, offset: 10 },
    30,
  );
  assert.equal(seen[0].searchParams.get("sysparm_offset"), "10");
  assert.equal(body.count, 5);
  assert.equal(body.total, 30);
  assert.equal(body.next_offset, 15);
});

test("N-40: no next_offset on the last page or a fetchAll read", async () => {
  const last = await call({ table: "incident", limit: 5, offset: 25 }, 30);
  assert.equal(last.body.count, 5);
  assert.equal("next_offset" in last.body, false);

  const short = await call({ table: "incident", limit: 10 }, 3);
  assert.equal("next_offset" in short.body, false);

  const all = await call({ table: "incident", fetchAll: true }, 12);
  assert.equal(all.body.count, 12);
  assert.equal("next_offset" in all.body, false);
});

test("N-40: without a count, only a full page names the next offset", async () => {
  const full = await call({ table: "incident", limit: 5, noCount: true }, 30);
  assert.equal(full.body.total, undefined);
  assert.equal(full.body.next_offset, 5);

  const partial = await call(
    { table: "incident", limit: 5, offset: 28, noCount: true },
    30,
  );
  assert.equal(partial.body.count, 2);
  assert.equal("next_offset" in partial.body, false);
});

test("N-40: a size-truncated page continues right after the kept rows", async () => {
  const { body } = await call(
    { table: "incident", limit: 20, offset: 40 },
    100,
    {
      SN_MAX_RESULT_CHARS: "900",
      SN_OVERSIZE_TO_FILE: "false",
    },
  );
  assert.equal(body.truncated, true);
  assert.ok(body.returned > 0 && body.returned < 20, String(body.returned));
  assert.equal(body.next_offset, 40 + body.returned);
  assert.match(
    body.note,
    new RegExp(`continue with offset:${40 + body.returned}`),
  );
});

test("N-40: next_offset rides along in the csv and table formats", async () => {
  const csv = await call({ table: "incident", limit: 5, format: "csv" }, 30);
  assert.equal(csv.body.format, "csv");
  assert.equal(csv.body.next_offset, 5);

  const table = await call(
    { table: "incident", limit: 5, format: "table" },
    30,
  );
  assert.deepEqual(table.body.columns, ["sys_id", "number"]);
  assert.equal(table.body.next_offset, 5);
});
