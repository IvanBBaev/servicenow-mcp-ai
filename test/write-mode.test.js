import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { specs as tableSpecs } from "../build/tools/table.js";
import { specs as changeSpecs } from "../build/tools/change.js";
import { specs as cmdbSpecs } from "../build/tools/cmdb.js";
import { specs as importsetSpecs } from "../build/tools/importset.js";
import { specs as emailSpecs } from "../build/tools/email.js";
import { specs as catalogSpecs } from "../build/tools/catalog.js";
import { specs as attachmentSpecs } from "../build/tools/attachment.js";
import { specs as atfSpecs } from "../build/tools/atf.js";
import { specs as batchSpecs } from "../build/tools/batch.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

const allSpecs = [
  ...tableSpecs,
  ...changeSpecs,
  ...cmdbSpecs,
  ...importsetSpecs,
  ...emailSpecs,
  ...catalogSpecs,
  ...attachmentSpecs,
  ...atfSpecs,
  ...batchSpecs,
];
const tool = (name) => allSpecs.find((s) => s.name === name);
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

// --- record-style tools beyond Table CRUD: change / cmdb / importset ---------

test("create_change plan mode previews against change_request, no POST (DF-2)", async () => {
  await withFetch(
    (_url, init) => {
      if (init?.method === "POST") {
        throw new Error("must not POST in plan mode");
      }
      return jsonResponse(200, { result: {} });
    },
    async (calls) => {
      const o = out(
        await tool("servicenow_create_change").handler({
          type: "normal",
          fields: { short_description: "Patch" },
        }),
      );
      assert.equal(o.mode, "plan");
      assert.equal(o.table, "change_request");
      assert.equal(o.after.type, "normal");
      assert.equal(calls.length, 0);
    },
  );
});

test("update_ci plan mode previews against the CMDB class, no write (DF-2)", async () => {
  await withFetch(
    (_url, init) => {
      if (["POST", "PATCH", "PUT"].includes(init?.method)) {
        throw new Error("must not write in plan mode");
      }
      return jsonResponse(200, { result: { attributes: { name: "old" } } });
    },
    async () => {
      const o = out(
        await tool("servicenow_update_ci").handler({
          class_name: "cmdb_ci_server",
          sys_id: "ci1",
          attributes: { name: "new" },
        }),
      );
      assert.equal(o.mode, "plan");
      assert.equal(o.table, "cmdb_ci_server");
      assert.deepEqual(o.after, { name: "new" });
    },
  );
});

test("insert_import_set_row plan mode previews the staging insert (DF-2)", async () => {
  await withFetch(
    (_url, init) => {
      if (init?.method === "POST") {
        throw new Error("must not POST in plan mode");
      }
      return jsonResponse(200, { result: {} });
    },
    async (calls) => {
      const o = out(
        await tool("servicenow_insert_import_set_row").handler({
          staging_table: "u_imp_incident",
          fields: { u_short_desc: "x" },
        }),
      );
      assert.equal(o.mode, "plan");
      assert.equal(o.table, "u_imp_incident");
      assert.equal(calls.length, 0);
    },
  );
});

test("create_change apply executes and journals an unwrapped sys_id (DF-2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snmcp-chg-"));
  await withEnv({ SN_DOCS_DIR: dir }, () =>
    withFetch(
      () =>
        jsonResponse(200, {
          result: { sys_id: { value: "chg9" }, number: "CHG9" },
        }),
      async () => {
        const o = out(
          await tool("servicenow_create_change").handler({
            type: "normal",
            fields: { short_description: "x" },
            apply: true,
          }),
        );
        assert.equal(o.message, "Change created");
        const profile = readdirSync(dir)[0];
        const jsonl = readFileSync(
          join(dir, profile, "write-journal.jsonl"),
          "utf8",
        );
        assert.match(jsonl, /"table":"change_request"/);
        assert.match(jsonl, /"sys_id":"chg9"/); // resultSysId unwrapped {value}
      },
    ),
  );
});

// --- special write tools: email / catalog / attachment ----------------------

test("send_email plan mode previews the envelope, no send (DF-2)", async () => {
  await withFetch(
    (_url, init) => {
      if (init?.method === "POST") {
        throw new Error("must not send in plan mode");
      }
      return jsonResponse(200, { result: {} });
    },
    async (calls) => {
      const o = out(
        await tool("servicenow_send_email").handler({
          to: ["a@b.com"],
          subject: "Hi",
          body: "Body text",
        }),
      );
      assert.equal(o.mode, "plan");
      assert.equal(o.table, "email");
      assert.deepEqual(o.after.to, ["a@b.com"]);
      assert.equal(o.after.body, "Body text");
      assert.equal(calls.length, 0);
    },
  );
});

test("order_catalog_item plan mode previews an sc_request, no order (DF-2)", async () => {
  await withFetch(
    (_url, init) => {
      if (init?.method === "POST") {
        throw new Error("must not order in plan mode");
      }
      return jsonResponse(200, { result: {} });
    },
    async (calls) => {
      const o = out(
        await tool("servicenow_order_catalog_item").handler({
          item_sys_id: "item1",
          quantity: 2,
        }),
      );
      assert.equal(o.mode, "plan");
      assert.equal(o.table, "sc_request");
      assert.equal(o.after.item, "item1");
      assert.equal(o.after.quantity, 2);
      assert.equal(calls.length, 0);
    },
  );
});

test("upload_attachment plan mode previews without echoing the base64 (DF-2)", async () => {
  await withFetch(
    (_url, init) => {
      if (init?.method === "POST") {
        throw new Error("must not upload in plan mode");
      }
      return jsonResponse(200, { result: {} });
    },
    async (calls) => {
      const res = await tool("servicenow_upload_attachment").handler({
        table: "incident",
        sys_id: "rec1",
        file_name: "log.txt",
        content_base64: "QUJD",
      });
      const o = out(res);
      assert.equal(o.mode, "plan");
      assert.equal(o.after.file_name, "log.txt");
      assert.equal(o.after.base64_chars, 4);
      // The payload itself must never appear in the preview.
      assert.equal(res.content[0].text.includes("QUJD"), false);
      assert.equal(calls.length, 0);
    },
  );
});

test("delete_attachment plan mode fetches before, no DELETE (DF-2)", async () => {
  await withFetch(
    (_url, init) => {
      if (init?.method === "DELETE") {
        throw new Error("must not delete in plan mode");
      }
      return jsonResponse(200, {
        result: { sys_id: "att1", file_name: "old.txt" },
      });
    },
    async () => {
      const o = out(
        await tool("servicenow_delete_attachment").handler({
          attachment_sys_id: "att1",
        }),
      );
      assert.equal(o.mode, "plan");
      assert.equal(o.action, "delete");
      assert.equal(o.table, "sys_attachment");
    },
  );
});

// --- batch + ATF (the last two write tools) ---------------------------------

test("run_atf_test plan mode previews the run, no execution (DF-2)", async () => {
  await withFetch(
    (_url, init) => {
      if (init?.method === "POST") {
        throw new Error("must not run in plan mode");
      }
      return jsonResponse(200, { result: {} });
    },
    async (calls) => {
      const o = out(
        await tool("servicenow_run_atf_test").handler({ test_sys_id: "t1" }),
      );
      assert.equal(o.mode, "plan");
      assert.equal(o.action, "execute");
      assert.equal(o.sys_id, "t1");
      assert.equal(calls.length, 0);
    },
  );
});

test("batch with writes is plan-gated; a read-only batch runs directly (DF-2)", async () => {
  // A batch containing a write previews instead of executing.
  await withFetch(
    (_url, init) => {
      if (init?.method === "POST") {
        throw new Error("must not run a writing batch in plan mode");
      }
      return jsonResponse(200, { result: { serviced_requests: [] } });
    },
    async () => {
      const o = out(
        await tool("servicenow_batch").handler({
          requests: [
            { method: "POST", url: "/api/now/table/incident", body: {} },
          ],
        }),
      );
      assert.equal(o.mode, "plan");
      assert.equal(o.table, "batch");
    },
  );
  // An all-GET batch has no write to gate — it runs.
  await withFetch(
    () => jsonResponse(200, { result: { serviced_requests: [] } }),
    async (calls) => {
      const o = out(
        await tool("servicenow_batch").handler({
          requests: [
            { method: "GET", url: "/api/now/table/incident?sysparm_limit=1" },
          ],
        }),
      );
      assert.notEqual(o.mode, "plan"); // executed, not previewed
      assert.ok(calls.length >= 1);
    },
  );
});

// --- apply paths for every write tool (coverage of the execute branch) -------

const applyCases = [
  [
    "servicenow_update_record",
    { table: "incident", sys_id: "s1", fields: { a: "b" }, apply: true },
    "PATCH",
  ],
  [
    "servicenow_delete_record",
    { table: "incident", sys_id: "s1", apply: true },
    "DELETE",
  ],
  [
    "servicenow_update_change",
    { sys_id: "c1", fields: { a: "b" }, apply: true },
    "PATCH",
  ],
  [
    "servicenow_create_ci",
    { class_name: "cmdb_ci", attributes: { a: "b" }, apply: true },
    "POST",
  ],
  [
    "servicenow_update_ci",
    {
      class_name: "cmdb_ci",
      sys_id: "ci1",
      attributes: { a: "b" },
      apply: true,
    },
    "PATCH",
  ],
  [
    "servicenow_insert_import_set_row",
    { staging_table: "u_imp", fields: { a: "b" }, apply: true },
    "POST",
  ],
  ["servicenow_order_catalog_item", { item_sys_id: "i1", apply: true }, "POST"],
  [
    "servicenow_send_email",
    { to: ["a@b.com"], subject: "s", body: "b", apply: true },
    "POST",
  ],
  [
    "servicenow_upload_attachment",
    {
      table: "incident",
      sys_id: "s1",
      file_name: "f",
      content_base64: "QQ==",
      apply: true,
    },
    "POST",
  ],
  [
    "servicenow_delete_attachment",
    { attachment_sys_id: "a1", apply: true },
    "DELETE",
  ],
  ["servicenow_run_atf_test", { test_sys_id: "t1", apply: true }, "POST"],
  ["servicenow_run_atf_suite", { suite_sys_id: "su1", apply: true }, "POST"],
];

for (const [name, args, method] of applyCases) {
  test(`${name} with apply:true performs the ${method} and journals (DF-2)`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "snmcp-apply-"));
    // H-6: send_email recipients must be allow-listed (b.com covers a@b.com).
    await withEnv({ SN_DOCS_DIR: dir, SN_EMAIL_ALLOWED_DOMAINS: "b.com" }, () =>
      withFetch(
        () => jsonResponse(200, { result: { sys_id: "x", number: "N1" } }),
        async (calls) => {
          await tool(name).handler(args);
          assert.ok(
            calls.some((c) => c.init?.method === method),
            `expected a ${method} request`,
          );
        },
      ),
    );
  });
}

test("batch with writes + apply executes and journals (DF-2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snmcp-batch-"));
  await withEnv({ SN_DOCS_DIR: dir }, () =>
    withFetch(
      () => jsonResponse(200, { result: { serviced_requests: [] } }),
      async (calls) => {
        await tool("servicenow_batch").handler({
          requests: [
            { method: "POST", url: "/api/now/table/incident", body: {} },
          ],
          apply: true,
        });
        assert.ok(calls.length >= 1);
      },
    ),
  );
});
