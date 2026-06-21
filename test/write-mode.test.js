import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { specs } from "../build/tools/table.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

const tool = (name) => specs.find((s) => s.name === name);
const out = (res) => JSON.parse(res.content[0].text);

test("create_record in plan mode previews without mutating (DF-2)", async () => {
  await withFetch(
    (_url, init) => {
      if (init?.method === "POST")
        throw new Error("must not POST in plan mode");
      return jsonResponse(200, { result: {} });
    },
    async (calls) => {
      const res = await tool("servicenow_create_record").handler({
        table: "incident",
        fields: { short_description: "x" },
      });
      const o = out(res);
      assert.equal(o.mode, "plan");
      assert.equal(o.action, "create");
      assert.deepEqual(o.after, { short_description: "x" });
      assert.equal(calls.length, 0); // nothing fetched at all
    },
  );
});

test("update_record plan mode fetches 'before' and previews, no PATCH (DF-2)", async () => {
  await withFetch(
    (_url, init) => {
      if (init?.method === "PATCH")
        throw new Error("must not PATCH in plan mode");
      return jsonResponse(200, { result: { sys_id: "s1", state: "1" } });
    },
    async () => {
      const o = out(
        await tool("servicenow_update_record").handler({
          table: "incident",
          sys_id: "s1",
          fields: { state: "2" },
        }),
      );
      assert.equal(o.mode, "plan");
      assert.equal(o.before.state, "1");
      assert.deepEqual(o.after, { state: "2" });
    },
  );
});

test("delete_record plan mode fetches 'before' and previews, no DELETE (DF-2)", async () => {
  await withFetch(
    (_url, init) => {
      if (init?.method === "DELETE") {
        throw new Error("must not DELETE in plan mode");
      }
      return jsonResponse(200, { result: { sys_id: "s1", number: "INC1" } });
    },
    async () => {
      const o = out(
        await tool("servicenow_delete_record").handler({
          table: "incident",
          sys_id: "s1",
        }),
      );
      assert.equal(o.mode, "plan");
      assert.equal(o.action, "delete");
      assert.equal(o.before.number, "INC1");
    },
  );
});

test("apply:true executes the write and appends to the audit journal (DF-2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snmcp-journal-"));
  await withEnv({ SN_DOCS_DIR: dir }, () =>
    withFetch(
      () => jsonResponse(201, { result: { sys_id: "abc123", number: "INC1" } }),
      async () => {
        const o = out(
          await tool("servicenow_create_record").handler({
            table: "incident",
            fields: { short_description: "x" },
            apply: true,
          }),
        );
        assert.equal(o.message, "Record created");
        assert.equal(o.record.sys_id, "abc123");
        // The journal recorded the applied mutation.
        const profile = readdirSync(dir)[0];
        const jsonl = readFileSync(
          join(dir, profile, "write-journal.jsonl"),
          "utf8",
        );
        assert.match(jsonl, /"action":"create"/);
        assert.match(jsonl, /"sys_id":"abc123"/);
        assert.match(jsonl, /"table":"incident"/);
      },
    ),
  );
});

test("SN_WRITE_MODE=apply executes without an explicit apply flag (DF-2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snmcp-applymode-"));
  await withEnv({ SN_WRITE_MODE: "apply", SN_DOCS_DIR: dir }, () =>
    withFetch(
      (_url, init) => {
        assert.equal(init?.method, "POST");
        return jsonResponse(201, { result: { sys_id: "x" } });
      },
      async (calls) => {
        await tool("servicenow_create_record").handler({
          table: "incident",
          fields: { a: "b" },
        });
        assert.equal(calls.length, 1); // it actually executed
      },
    ),
  );
});
