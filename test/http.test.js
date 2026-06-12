import test from "node:test";
import assert from "node:assert/strict";

import {
  queryTable,
  createRecord,
  ServiceNowError,
} from "../build/servicenow.js";
import { fail } from "../build/result.js";
import { baselineEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

test("queryTable returns records and X-Total-Count as total", async () => {
  await withFetch(
    (url) => {
      assert.match(url, /\/api\/now\/table\/incident/);
      return jsonResponse(200, { result: [{ number: "INC001" }] }, {
        "x-total-count": "42",
      });
    },
    async () => {
      const { records, total } = await queryTable({ table: "incident" });
      assert.equal(records.length, 1);
      assert.equal(total, 42);
    },
  );
});

test("sends a Basic Authorization header", async () => {
  await withFetch(
    (_url, init) => {
      const expected = `Basic ${Buffer.from("alice:s3cret").toString("base64")}`;
      assert.equal(init.headers.Authorization, expected);
      return jsonResponse(200, { result: [] });
    },
    async () => {
      await queryTable({ table: "incident" });
    },
  );
});

test("maps a non-2xx response to a ServiceNowError with status", async () => {
  await withFetch(
    () => jsonResponse(404, { error: { message: "No record found" } }),
    async () => {
      await assert.rejects(
        queryTable({ table: "incident" }),
        (err) =>
          err instanceof ServiceNowError &&
          err.status === 404 &&
          /No record found/.test(err.message),
      );
    },
  );
});

test("retries a 429 and then succeeds", async () => {
  process.env.SN_MAX_RETRIES = "1";
  try {
    await withFetch(
      (_url, _init, callNo) =>
        callNo === 1
          ? jsonResponse(429, { error: { message: "slow down" } }, {
              "retry-after": "0",
            })
          : jsonResponse(200, { result: [{ ok: true }] }),
      async (calls) => {
        const { records } = await queryTable({ table: "incident" });
        assert.equal(records.length, 1);
        assert.equal(calls.length, 2);
      },
    );
  } finally {
    process.env.SN_MAX_RETRIES = "0";
  }
});

test("read-only mode blocks writes before any request", async () => {
  process.env.SN_READONLY = "true";
  try {
    await withFetch(
      () => {
        throw new Error("fetch should not be called in read-only mode");
      },
      async (calls) => {
        await assert.rejects(
          createRecord("incident", { short_description: "x" }),
          (err) => err instanceof ServiceNowError && err.status === 403,
        );
        assert.equal(calls.length, 0);
      },
    );
  } finally {
    delete process.env.SN_READONLY;
  }
});

test("denied tables are refused before any request", async () => {
  process.env.SN_TABLES_DENY = "incident";
  try {
    await withFetch(
      () => {
        throw new Error("fetch should not be called for a denied table");
      },
      async (calls) => {
        await assert.rejects(
          queryTable({ table: "incident" }),
          (err) => err instanceof ServiceNowError && err.status === 403,
        );
        assert.equal(calls.length, 0);
      },
    );
  } finally {
    delete process.env.SN_TABLES_DENY;
  }
});

test("fail() emits a structured error payload for ServiceNowError", () => {
  const result = fail(
    new ServiceNowError("ACL exception", 403, {
      error: { message: "Insufficient rights" },
    }),
  );
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.error.status, 403);
  assert.equal(payload.error.message, "ACL exception");
  assert.equal(payload.error.snDetail.message, "Insufficient rights");
});
