import test from "node:test";
import assert from "node:assert/strict";

import { runBatch } from "../build/api/batch.js";
import { ServiceNowError } from "../build/core/errors.js";
import { baselineEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

const b64 = (obj) =>
  Buffer.from(JSON.stringify(obj), "utf8").toString("base64");

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
          {
            id: "2",
            status_code: 201,
            body: b64({ result: { sys_id: "abc" } }),
          },
        ],
        unserviced_requests: [],
      });
    },
    async (calls) => {
      const results = await runBatch([
        { method: "GET", url: "/api/now/table/incident?sysparm_limit=1" },
        {
          method: "POST",
          url: "/api/now/table/incident",
          body: { short_description: "x" },
        },
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
          runBatch([
            { method: "POST", url: "/api/now/table/incident", body: {} },
          ]),
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

test("a denied package blocks a plugin-API sub-request (ARCH-5)", async () => {
  process.env.SN_PACKAGES_DENY = "change";
  try {
    await withFetch(
      () => {
        throw new Error("fetch should not be called for a denied package");
      },
      async (calls) => {
        await assert.rejects(
          runBatch([
            { method: "POST", url: "/api/sn_chg_rest/change/normal", body: {} },
          ]),
          (err) =>
            err instanceof ServiceNowError &&
            err.status === 403 &&
            /SN_PACKAGES_DENY/.test(err.message),
        );
        assert.equal(calls.length, 0, "the batch never leaves the client");
      },
    );
  } finally {
    delete process.env.SN_PACKAGES_DENY;
  }
});

test("a read-only package blocks a write sub-request but allows reads (ARCH-5)", async () => {
  process.env.SN_PACKAGES_READONLY = "catalog";
  try {
    await withFetch(
      () =>
        jsonResponse(200, {
          serviced_requests: [{ id: "1", status_code: 200, body: "" }],
        }),
      async (calls) => {
        // A write to a read-only package is refused before sending.
        await assert.rejects(
          runBatch([
            {
              method: "POST",
              url: "/api/sn_sc/servicecatalog/items/abc/order_now",
              body: {},
            },
          ]),
          (err) =>
            err instanceof ServiceNowError &&
            err.status === 403 &&
            /SN_PACKAGES_READONLY/.test(err.message),
        );
        assert.equal(calls.length, 0, "the write never leaves the client");

        // A GET on the same read-only package still goes through.
        const ok = await runBatch([
          { method: "GET", url: "/api/sn_sc/servicecatalog/catalogs" },
        ]);
        assert.equal(calls.length, 1);
        assert.equal(ok.length, 1);
      },
    );
  } finally {
    delete process.env.SN_PACKAGES_READONLY;
  }
});

test("non-canonical paths cannot bypass the table/package guards (ARCH-5 hardening)", async () => {
  // ServiceNow's batch dispatcher normalizes //, /./ and /../ before routing,
  // so those must be refused before they reach a denied surface.
  process.env.SN_TABLES_DENY = "sys_user";
  process.env.SN_PACKAGES_DENY = "change";
  try {
    await withFetch(
      () => {
        throw new Error("fetch must not run for a non-canonical path");
      },
      async (calls) => {
        for (const url of [
          "/api/now//table/sys_user",
          "/api/now/./table/sys_user",
          "/api/now/x/../table/sys_user",
          "/api//sn_chg_rest/change/normal",
          "/api/now/x/../sn_chg_rest/change/normal",
          // Percent-encoded forms (a servlet may decode before routing).
          "/api/now/%2e%2e/table/sys_user",
          "/api/now/%2F/table/sys_user",
        ]) {
          await assert.rejects(
            runBatch([{ method: "GET", url }]),
            (err) =>
              err instanceof ServiceNowError &&
              err.status === 400 &&
              /non-canonical/.test(err.message),
            `expected rejection for ${url}`,
          );
        }
        assert.equal(calls.length, 0, "nothing is sent");
      },
    );
  } finally {
    delete process.env.SN_TABLES_DENY;
    delete process.env.SN_PACKAGES_DENY;
  }
});

test("a trailing slash is still a canonical path", async () => {
  await withFetch(
    () =>
      jsonResponse(200, {
        serviced_requests: [{ id: "1", status_code: 200, body: "" }],
      }),
    async (calls) => {
      const r = await runBatch([
        { method: "GET", url: "/api/now/table/incident/" },
      ]);
      assert.equal(calls.length, 1);
      assert.equal(r.length, 1);
    },
  );
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

test("unserviced error falls back to `error` then a default message (QA-5)", async () => {
  await withFetch(
    () =>
      jsonResponse(200, {
        serviced_requests: [],
        unserviced_requests: [
          { id: "1", error: "secondary detail" }, // no error_message → use error
          { id: "2" }, // neither field → default message
        ],
      }),
    async () => {
      const results = await runBatch([
        { method: "GET", url: "/api/now/table/incident" },
        { method: "GET", url: "/api/now/table/problem" },
      ]);
      assert.equal(results[0].error, "secondary detail");
      assert.equal(results[1].error, "Request was not serviced.");
    },
  );
});

test("an empty batch is rejected", async () => {
  await assert.rejects(runBatch([]), (err) => err instanceof ServiceNowError);
});

test("sub-requests outside /api/ are rejected before any network call", async () => {
  await withFetch(
    () => {
      throw new Error("fetch must not be called for non-API paths");
    },
    async (calls) => {
      for (const url of [
        "/oauth_token.do",
        "/login.do",
        "/nav_to.do",
        "api/now/table/incident",
      ]) {
        await assert.rejects(
          runBatch([{ method: "GET", url }]),
          (err) =>
            err instanceof ServiceNowError && /\/api\//.test(err.message),
          `expected rejection for ${url}`,
        );
      }
      assert.equal(calls.length, 0);
    },
  );
});
