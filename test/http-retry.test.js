import test from "node:test";
import assert from "node:assert/strict";

import {
  queryTable,
  createRecord,
  ServiceNowError,
} from "../build/api/table.js";
import { getTelemetry } from "../build/core/http.js";
import {
  baselineEnv,
  fakeClock,
  freshRuntime,
  withEnv,
  withFetch,
  withFetchDouble,
  jsonResponse,
} from "./helpers.js";

baselineEnv();

test("telemetry counts requests, retries and errors by status (O-5)", async () => {
  freshRuntime();
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
  const host = t.perHost["dev00000.service-now.com"];
  assert.ok(host, "per-host breakdown must exist");
  assert.equal(host.requests, 2);
  assert.deepEqual(host.errors, { 403: 1 });
  freshRuntime();
});

test("the semaphore caps parallel requests at SN_MAX_CONCURRENT (O-4)", async (t) => {
  // E-6: the 15 ms "server time" runs on the fake clock.
  const clock = fakeClock(t);
  let inFlight = 0;
  let maxInFlight = 0;
  await withEnv({ SN_MAX_CONCURRENT: "2" }, () =>
    withFetchDouble(
      (d) =>
        d.route("GET", /\/api\/now\/table\/incident$/, () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          return new Promise((resolve) =>
            setTimeout(() => {
              inFlight -= 1;
              resolve({ json: { result: [] } });
            }, 15),
          );
        }),
      async (d) => {
        await clock.run(
          Promise.all(
            Array.from({ length: 6 }, () => queryTable({ table: "incident" })),
          ),
          { step: 5 },
        );
        assert.equal(d.calls.length, 6);
        // Three waves of two, 15 ms each.
        assert.ok(clock.elapsed() >= 45, `elapsed ${clock.elapsed()}`);
      },
    ),
  );
  assert.equal(maxInFlight, 2, "no more than SN_MAX_CONCURRENT in flight");
});

test("a GET transport error is retried", async (t) => {
  // E-6: the >= 500 ms backoff elapses on the fake clock, not the wall clock.
  const clock = fakeClock(t);
  await withEnv({ SN_MAX_RETRIES: "1" }, () =>
    withFetchDouble(
      (d) =>
        d.route("GET", /\/api\/now\/table\/incident$/, [
          { error: "fetch failed" },
          { json: { result: [] } },
        ]),
      async (d) => {
        const { records } = await clock.run(queryTable({ table: "incident" }));
        assert.equal(records.length, 0);
        assert.equal(d.calls.length, 2);
        const gap = d.calls[1].at - d.calls[0].at;
        assert.ok(gap >= 500 && gap < 800, `backoff ${gap}`);
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

test("a 503 is retried for GET but not for POST", async () => {
  await withEnv({ SN_MAX_RETRIES: "1" }, async () => {
    // GET: first 503, then success.
    await withFetch(
      (_url, _init, callNo) =>
        callNo === 1
          ? jsonResponse(503, {}, { "retry-after": "0" })
          : jsonResponse(200, { result: [] }),
      async (calls) => {
        await queryTable({ table: "incident" });
        assert.equal(calls.length, 2);
      },
    );
    // POST: a received 503 must surface immediately (the write may have landed).
    await withFetch(
      () => jsonResponse(503, { error: { message: "unavailable" } }),
      async (calls) => {
        await assert.rejects(
          createRecord("incident", { short_description: "x" }),
          (err) => err instanceof ServiceNowError && err.status === 503,
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

test("an unparseable Retry-After falls back to backoff and still retries (QA-4)", async (t) => {
  const clock = fakeClock(t);
  await withEnv({ SN_MAX_RETRIES: "1" }, () =>
    withFetchDouble(
      (d) =>
        d.route("GET", /\/api\/now\/table\/incident$/, [
          { status: 503, headers: { "retry-after": "not-a-date" }, json: {} },
          { json: { result: [] } },
        ]),
      async (d) => {
        const { records } = await clock.run(queryTable({ table: "incident" }));
        assert.deepEqual(records, []);
        assert.equal(
          d.calls.length,
          2,
          "the malformed Retry-After must not abort the retry",
        );
        const gap = d.calls[1].at - d.calls[0].at;
        assert.ok(gap >= 500 && gap < 800, `fell back to backoff (${gap})`);
      },
    ),
  );
});
