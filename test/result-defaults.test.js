// N-61 (O-21 (b)) — the result-size defaults: a 48,000-character budget, the
// automatic file result on, and an unfiltered list_tables capped at 200.
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MAX_RESULT_CHARS,
  getMaxResultChars,
  oversizeToFile,
} from "../build/core/settings.js";
import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import { LIST_TABLES_DEFAULT_LIMIT } from "../build/tools/meta.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

baselineEnv();
test.beforeEach(() => freshRuntime());

const listTables = ALL_TOOLS.find((s) => s.name === "servicenow_list_tables");
const tables = (n) =>
  Array.from({ length: n }, (_, i) => ({
    name: `u_t${String(i).padStart(4, "0")}`,
    label: `T ${i}`,
    "super_class.name": "",
  }));
const sysDbObject = (all) => (url) => {
  const u = new URL(url);
  const limit = Number(u.searchParams.get("sysparm_limit") ?? all.length);
  const offset = Number(u.searchParams.get("sysparm_offset") ?? "0");
  const q = u.searchParams.get("sysparm_query") ?? "";
  const like = /nameLIKE([^^]+)/.exec(q)?.[1];
  const hit = like ? all.filter((t) => t.name.includes(like)) : all;
  return jsonResponse(
    200,
    { result: hit.slice(offset, offset + limit) },
    {
      "X-Total-Count": String(hit.length),
    },
  );
};

test("the result budget is 48,000 characters and the file result is on", async () => {
  assert.equal(DEFAULT_MAX_RESULT_CHARS, 48_000);
  assert.equal(getMaxResultChars(), 48_000);
  assert.equal(oversizeToFile(), true);
  await withEnv(
    { SN_OVERSIZE_TO_FILE: "false", SN_MAX_RESULT_CHARS: "100000" },
    () => {
      assert.equal(oversizeToFile(), false);
      assert.equal(getMaxResultChars(), 100_000);
    },
  );
});

test("an unfiltered list_tables returns the first 200 tables with a hint", async () => {
  assert.equal(LIST_TABLES_DEFAULT_LIMIT, 200);
  await withFetch(sysDbObject(tables(250)), async () => {
    const res = await runSpec(listTables, {});
    assert.notEqual(res.isError, true, res.content[0].text);
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.count, 200);
    assert.equal(body.total, 250);
    assert.equal(body.truncated, true);
    assert.equal(body.tables.length, 200);
    assert.equal(body.tables[199].name, "u_t0199");
    assert.match(body.note, /first 200 of 250 tables.*filter/);
    assert.deepEqual(res.structuredContent, body);
  });
});

test("a filtered or small list_tables is returned whole", async () => {
  await withFetch(sysDbObject(tables(250)), async () => {
    const body = JSON.parse(
      (await runSpec(listTables, { filter: "u_t01" })).content[0].text,
    );
    assert.equal(body.count, 100);
    assert.equal(body.truncated, undefined);
  });
  freshRuntime();
  await withFetch(sysDbObject(tables(20)), async () => {
    const body = JSON.parse((await runSpec(listTables, {})).content[0].text);
    assert.equal(body.count, 20);
    assert.equal(body.note, undefined);
  });
});
