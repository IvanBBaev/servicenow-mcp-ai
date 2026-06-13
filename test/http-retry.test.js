import test from "node:test";
import assert from "node:assert/strict";

import {
  queryTable,
  createRecord,
  ServiceNowError,
} from "../build/api/table.js";
import { getTelemetry, _resetTelemetry } from "../build/core/http.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

test("telemetry counts requests, retries and errors by status (О-5)", async () => {
  _resetTelemetry();
  await withEnv({ SN_MAX_RETRIES: "1" }, () =>
    withFetch(
      (_url, _init, callNo) =>
        callNo === 1
          ? jsonResponse(429, {}, { "retry-after": "0" })
          : jsonResponse(200, { result: [] }),
      async () => {
        await queryTable({ table: "incident" });
      },
    ),
  );
  await withFetch(
    () => jsonResponse(403, { error: { message: "denied" } }),
    async () => {
      await assert.rejects(queryTable({ table: "incident" }));
    },
  );

  const t = getTelemetry();
  assert.equal(t.requests, 2);
  assert.equal(t.retries, 1);
  assert.deepEqual(t.errors, { 403: 1 });
  assert.ok(t.totalMs >= 0);
  // S2-2: the same counters are broken down per host.
  const host = t.perHost["ven03019.service-now.com"];
  assert.ok(host, "per-host breakdown must exist");
  assert.equal(host.requests, 2);
  assert.deepEqual(host.errors, { 403: 1 });
  _resetTelemetry();
});

test("the semaphore caps parallel requests at SN_MAX_CONCURRENT (О-4)", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  await withEnv({ SN_MAX_CONCURRENT: "2" }, () =>
    withFetch(
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight -= 1;
        return jsonResponse(200, { result: [] });
      },
      async () => {
        await Promise.all(
          Array.from({ length: 6 }, () => queryTable({ table: "incident" })),
        );
      },
    ),
  );
  assert.equal(maxInFlight, 2, "no more than SN_MAX_CONCURRENT in flight");
});

test("a GET transport error is retried", async () => {
  await withEnv({ SN_MAX_RETRIES: "1" }, () =>
    withFetch(
      (_url, _init, callNo) => {
        if (callNo === 1) throw new TypeError("fetch failed");
        return jsonResponse(200, { result: [] });
      },
      async (calls) => {
        const { records } = await queryTable({ table: "incident" });
        assert.equal(records.length, 0);
        assert.equal(calls.length, 2);
      },
    ),
  );
});

test("a POST transport error is NOT retried (outcome unknown)", async () => {
  await withEnv({ SN_MAX_RETRIES: "2" }, () =>
    withFetch(
      () => {
        throw new TypeError("socket hang up");
      },
      async (calls) => {
        await assert.rejects(
          createRecord("incident", { short_description: "x" }),
          /Could not reach ServiceNow/,
        );
        assert.equal(calls.length, 1);
      },
    ),
  );
});

test("Retry-After given as an HTTP date is honoured", async () => {
  await withEnv({ SN_MAX_RETRIES: "1" }, () =>
    withFetch(
      (_url, _init, callNo) =>
        callNo === 1
          ? jsonResponse(
              429,
              { error: { message: "slow down" } },
              // A date in the past => zero wait, keeps the test fast.
              { "retry-after": new Date(Date.now() - 1000).toUTCString() },
            )
          : jsonResponse(200, { result: [{ ok: true }] }),
      async (calls) => {
        const { records } = await queryTable({ table: "incident" });
        assert.equal(records.length, 1);
        assert.equal(calls.length, 2);
      },
    ),
  );
});

test("a 502 is retried for GET but not for POST", async () => {
  await withEnv({ SN_MAX_RETRIES: "1" }, async () => {
    // GET: first 502, then success.
    await withFetch(
      (_url, _init, callNo) =>
        callNo === 1
          ? jsonResponse(502, {}, { "retry-after": "0" })
          : jsonResponse(200, { result: [] }),
      async (calls) => {
        await queryTable({ table: "incident" });
        assert.equal(calls.length, 2);
      },
    );
    // POST: a received 502 must surface immediately (the write may have landed).
    await withFetch(
      () => jsonResponse(502, { error: { message: "bad gateway" } }),
      async (calls) => {
        await assert.rejects(
          createRecord("incident", { short_description: "x" }),
          (err) => err instanceof ServiceNowError && err.status === 502,
        );
        assert.equal(calls.length, 1);
      },
    );
  });
});

test("a 401 under Basic auth surfaces immediately — only OAuth re-auths (QA-3)", async () => {
  // baselineEnv() is Basic auth; the 401 re-auth path is gated on OAuth mode.
  await withEnv({ SN_MAX_RETRIES: "2" }, () =>
    withFetch(
      () => jsonResponse(401, { error: { message: "unauthorized" } }),
      async (calls) => {
        await assert.rejects(
          queryTable({ table: "incident" }),
          (err) => err instanceof ServiceNowError && err.status === 401,
        );
        assert.equal(calls.length, 1, "Basic 401 must not retry");
      },
    ),
  );
});

test("an unparseable Retry-After falls back to backoff and still retries (QA-4)", async () => {
  await withEnv({ SN_MAX_RETRIES: "1" }, () =>
    withFetch(
      (_url, _init, callNo) =>
        callNo === 1
          ? jsonResponse(503, {}, { "retry-after": "not-a-date" })
          : jsonResponse(200, { result: [] }),
      async (calls) => {
        const { records } = await queryTable({ table: "incident" });
        assert.deepEqual(records, []);
        assert.equal(
          calls.length,
          2,
          "the malformed Retry-After must not abort the retry",
        );
      },
    ),
  );
});
