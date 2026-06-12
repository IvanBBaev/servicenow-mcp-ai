import test from "node:test";
import assert from "node:assert/strict";

import { runBatch } from "../build/api/batch.js";
import { ServiceNowError } from "../build/errors.js";
import { baselineEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

const b64 = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");

test("encodes sub-request bodies and decodes serviced responses", async () => {
  await withFetch(
    (url, init) => {
      assert.match(url, /\/api\/now\/v1\/batch$/);
      const payload = JSON.parse(init.body);
      assert.equal(payload.rest_requests.length, 2);
      // The POST sub-request carries a base64-encoded JSON body.
      const post = payload.rest_requests.find((r) => r.method === "POST");
      const decoded = JSON.parse(
        Buffer.from(post.body, "base64").toString("utf8"),
      );
      assert.deepEqual(decoded, { short_description: "x" });
      return jsonResponse(200, {
        serviced_requests: [
          { id: "1", status_code: 200, body: b64({ result: [{ n: 1 }] }) },
          { id: "2", status_code: 201, body: b64({ result: { sys_id: "abc" } }) },
        ],
        unserviced_requests: [],
      });
    },
    async (calls) => {
      const results = await runBatch([
        { method: "GET", url: "/api/now/table/incident?sysparm_limit=1" },
        { method: "POST", url: "/api/now/table/incident", body: { short_description: "x" } },
      ]);
      assert.equal(calls.length, 1);
      assert.equal(results.length, 2);
      assert.deepEqual(results[0].body, { result: [{ n: 1 }] });
      assert.equal(results[1].statusCode, 201);
      assert.deepEqual(results[1].body, { result: { sys_id: "abc" } });
    },
  );
});

test("read-only mode blocks a write sub-request before any request", async () => {
  process.env.SN_READONLY = "true";
  try {
    await withFetch(
      () => {
        throw new Error("fetch should not be called in read-only mode");
      },
      async (calls) => {
        await assert.rejects(
          runBatch([{ method: "POST", url: "/api/now/table/incident", body: {} }]),
          (err) => err instanceof ServiceNowError && err.status === 403,
        );
        assert.equal(calls.length, 0);
      },
    );
  } finally {
    delete process.env.SN_READONLY;
  }
});

test("a denied table blocks a sub-request that targets it", async () => {
  process.env.SN_TABLES_DENY = "sys_user";
  try {
    await withFetch(
      () => {
        throw new Error("fetch should not be called for a denied table");
      },
      async (calls) => {
        await assert.rejects(
          runBatch([{ method: "GET", url: "/api/now/table/sys_user" }]),
          (err) => err instanceof ServiceNowError && err.status === 403,
        );
        assert.equal(calls.length, 0);
      },
    );
  } finally {
    delete process.env.SN_TABLES_DENY;
  }
});

test("the deny list also covers stats, import and cmdb sub-request URLs", async () => {
  process.env.SN_TABLES_DENY = "incident,u_imp_load,cmdb_ci_server";
  try {
    await withFetch(
      () => {
        throw new Error("fetch should not be called for a denied table");
      },
      async (calls) => {
        for (const url of [
          "/api/now/stats/incident?sysparm_count=true",
          "/api/now/v1/stats/incident",
          "/api/now/import/u_imp_load",
          "/api/now/cmdb/instance/cmdb_ci_server",
          "/api/now/cmdb/instance/cmdb_ci_server/abc123",
        ]) {
          await assert.rejects(
            runBatch([{ method: "GET", url }]),
            (err) => err instanceof ServiceNowError && err.status === 403,
            `expected policy rejection for ${url}`,
          );
        }
        assert.equal(calls.length, 0);
      },
    );
  } finally {
    delete process.env.SN_TABLES_DENY;
  }
});

test("unserviced sub-requests are surfaced as errors", async () => {
  await withFetch(
    () =>
      jsonResponse(200, {
        serviced_requests: [],
        unserviced_requests: [{ id: "1", error_message: "boom" }],
      }),
    async () => {
      const results = await runBatch([
        { method: "GET", url: "/api/now/table/incident" },
      ]);
      assert.equal(results.length, 1);
      assert.equal(results[0].error, "boom");
    },
  );
});

test("an empty batch is rejected", async () => {
  await assert.rejects(
    runBatch([]),
    (err) => err instanceof ServiceNowError,
  );
});

test("sub-requests outside /api/ are rejected before any network call", async () => {
  await withFetch(
    () => {
      throw new Error("fetch must not be called for non-API paths");
    },
    async (calls) => {
      for (const url of ["/oauth_token.do", "/login.do", "/nav_to.do", "api/now/table/incident"]) {
        await assert.rejects(
          runBatch([{ method: "GET", url }]),
          (err) => err instanceof ServiceNowError && /\/api\//.test(err.message),
          `expected rejection for ${url}`,
        );
      }
      assert.equal(calls.length, 0);
    },
  );
});
