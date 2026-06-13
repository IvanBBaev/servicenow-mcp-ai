import test from "node:test";
import assert from "node:assert/strict";

import { insertImportSetRow, getImportSetRow } from "../build/api/importset.js";
import { ServiceNowError } from "../build/core/errors.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

test("insertImportSetRow POSTs the row to the staging table and returns the transform result", async () => {
  await withFetch(
    (url, init) => {
      assert.equal(init.method, "POST");
      assert.match(url, /\/api\/now\/import\/u_imp_inc$/);
      assert.deepEqual(JSON.parse(init.body), {
        u_number: "INC1",
        u_state: "1",
      });
      return jsonResponse(200, {
        result: {
          import_set: "ISET0001",
          staging_table: "u_imp_inc",
          result: [{ table: "incident", sys_id: "rec1", status: "inserted" }],
        },
      });
    },
    async (calls) => {
      const out = await insertImportSetRow("u_imp_inc", {
        u_number: "INC1",
        u_state: "1",
      });
      assert.equal(out.result.import_set, "ISET0001");
      assert.equal(out.result.staging_table, "u_imp_inc");
      assert.equal(calls.length, 1);
    },
  );
});

test("getImportSetRow reads a previously inserted staging row by sys_id", async () => {
  await withFetch(
    (url, init) => {
      assert.equal(init.method, "GET");
      assert.match(url, /\/api\/now\/import\/u_imp_inc\/stage1$/);
      return jsonResponse(200, {
        result: { staging_table: "u_imp_inc", sys_row_error: "" },
      });
    },
    async (calls) => {
      const out = await getImportSetRow("u_imp_inc", "stage1");
      assert.equal(out.result.staging_table, "u_imp_inc");
      assert.equal(calls.length, 1);
    },
  );
});

test("insertImportSetRow is blocked in read-only mode before any request", async () => {
  await withEnv({ SN_READONLY: "true" }, () =>
    withFetch(
      () => {
        throw new Error("fetch must not run in read-only mode");
      },
      async (calls) => {
        await assert.rejects(
          insertImportSetRow("u_imp_inc", { u_number: "INC2" }),
          (err) => err instanceof ServiceNowError && err.status === 403,
        );
        assert.equal(calls.length, 0);
      },
    ),
  );
});

test("insertImportSetRow honours the table deny list", async () => {
  await withEnv({ SN_TABLES_DENY: "u_imp_inc" }, () =>
    withFetch(
      () => {
        throw new Error("fetch must not run for a denied staging table");
      },
      async (calls) => {
        await assert.rejects(
          insertImportSetRow("u_imp_inc", { u_number: "INC3" }),
          (err) => err instanceof ServiceNowError,
        );
        assert.equal(calls.length, 0);
      },
    ),
  );
});
