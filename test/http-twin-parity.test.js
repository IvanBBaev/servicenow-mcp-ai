import test from "node:test";
import assert from "node:assert/strict";

import { snRequest } from "../build/core/http.js";
import { jiraRequest } from "../build/core/jira/http.js";
import { getTelemetry } from "../build/core/http-util.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

baselineEnv();

// Drift guard for the twin HTTP clients (ARCH-10, Option L).
//
// snRequest (core/http.ts) and jiraRequest (core/jira/http.ts) already share the
// retry matrix, backoff, the per-host semaphore and telemetry via core/http-util,
// but each still owns a hand-written copy of the request loop. That loop drifted
// twice before it was reconciled (BUSINESS-REVIEW-2026-07 §8.2 finding 2: the
// timeout signal was once created before the concurrency slot, and the query
// join once emitted a double "?"). This file pins the behaviors that MUST stay
// identical between the twins, so a third silent divergence fails the gate instead
// of shipping. Everything that legitimately differs — auth model, error-body shape,
// X-Total-Count, extraHeaders — is out of scope here and covered by each client's
// own suite (http-retry.test.js, jira-http.test.js).

// Jira credentials so jiraRequest reaches the (mocked) network in the same tests
// that drive snRequest; the SN baseline is set by baselineEnv() above.
const JIRA = {
  JIRA_SITE: "mycompany",
  JIRA_EMAIL: "alice@example.com",
  JIRA_API_TOKEN: "tok",
};

// Thin adapters over the two clients: a single scenario runs against both. Each
// defaults a path but lets a scenario override method/path/params.
const CLIENTS = [
  {
    name: "servicenow",
    call: (args) => snRequest({ path: "/api/now/table/incident", ...args }),
  },
  {
    name: "jira",
    call: (args) => jiraRequest({ path: "/rest/api/3/issue/PROJ-1", ...args }),
  },
];

// Run one scenario against one client and report only the SHARED observables:
// how many times fetch was called, how many retries telemetry counted, and
// whether the call ultimately threw. The error *class* differs by design
// (ServiceNowError vs JiraError), so only the boolean is compared.
async function observe(client, scenario) {
  let threw = false;
  let calls = 0;
  let retries = 0;
  await withEnv({ ...JIRA, SN_MAX_RETRIES: scenario.maxRetries }, () =>
    withFetch(scenario.handler, async (c) => {
      freshRuntime();
      try {
        await client.call({ method: scenario.method });
      } catch {
        threw = true;
      }
      calls = c.length;
      retries = getTelemetry().retries;
    }),
  );
  return { calls, retries, threw };
}

// The retry/idempotency matrix both clients must implement identically. Status
// retries use "retry-after: 0" so they wait 0ms; only the one transport-error
// row pays a real backoff, keeping the file fast.
const MATRIX = [
  {
    title: "a GET transport error is retried once",
    method: "GET",
    maxRetries: "1",
    handler: (_u, _i, n) => {
      if (n === 1) throw new TypeError("fetch failed");
      return jsonResponse(200, {});
    },
    expect: { calls: 2, retries: 1, threw: false },
  },
  {
    title: "a POST transport error is never replayed",
    method: "POST",
    maxRetries: "2",
    handler: () => {
      throw new TypeError("socket hang up");
    },
    expect: { calls: 1, retries: 0, threw: true },
  },
  {
    title: "a 429 is retried on a POST (rejected before processing)",
    method: "POST",
    maxRetries: "1",
    handler: (_u, _i, n) =>
      n === 1
        ? jsonResponse(429, {}, { "retry-after": "0" })
        : jsonResponse(200, {}),
    expect: { calls: 2, retries: 1, threw: false },
  },
  {
    title: "a 503 is not retried on a POST (write may have landed)",
    method: "POST",
    maxRetries: "2",
    handler: () => jsonResponse(503, {}),
    expect: { calls: 1, retries: 0, threw: true },
  },
  {
    title: "a 503 is retried on a GET",
    method: "GET",
    maxRetries: "1",
    handler: (_u, _i, n) =>
      n === 1
        ? jsonResponse(503, {}, { "retry-after": "0" })
        : jsonResponse(200, {}),
    expect: { calls: 2, retries: 1, threw: false },
  },
  {
    title: "a GET exhausts maxRetries on repeated 503 then fails",
    method: "GET",
    maxRetries: "2",
    handler: () => jsonResponse(503, {}, { "retry-after": "0" }),
    expect: { calls: 3, retries: 2, threw: true },
  },
];

for (const scenario of MATRIX) {
  test(`twin parity — ${scenario.title}`, async () => {
    const sn = await observe(CLIENTS[0], scenario);
    const jira = await observe(CLIENTS[1], scenario);
    assert.deepEqual(sn, scenario.expect, `servicenow: ${scenario.title}`);
    assert.deepEqual(jira, scenario.expect, `jira: ${scenario.title}`);
    assert.deepEqual(sn, jira, `twins diverged: ${scenario.title}`);
  });
}

test("twin parity — params join with & when the path already carries a query", async () => {
  const cases = [
    {
      client: CLIENTS[0],
      path: "/api/now/table/incident?sysparm_limit=1",
      params: new URLSearchParams({ sysparm_fields: "number" }),
    },
    {
      client: CLIENTS[1],
      path: "/rest/api/3/search?expand=names",
      params: new URLSearchParams({ jql: "x" }),
    },
  ];
  for (const c of cases) {
    await withEnv({ ...JIRA, SN_MAX_RETRIES: "0" }, () =>
      withFetch(
        () => jsonResponse(200, {}),
        async (calls) => {
          await c.client.call({
            method: "GET",
            path: c.path,
            params: c.params,
          });
          const url = calls[0].url;
          const qMarks = (url.match(/\?/g) || []).length;
          assert.equal(qMarks, 1, `exactly one "?" expected in ${url}`);
          assert.ok(url.includes("&"), `params must append with "&" in ${url}`);
        },
      ),
    );
  }
});

test("twin parity — queue time is not billed to the per-request timeout (§8.2 finding 2)", async () => {
  const HANG_MS = 150;
  const TIMEOUT_MS = 50;
  // A mock that behaves like real fetch on an already-aborted signal: if the
  // timeout fired before fetch ran, reject. In the correct code the second
  // request's timeout starts only when it acquires the slot, so it never aborts.
  const handler = async (_url, init, callNo) => {
    if (init.signal?.aborted) {
      const err = new Error("aborted by timeout");
      err.name = "TimeoutError";
      throw err;
    }
    if (callNo === 1) {
      await new Promise((r) => setTimeout(r, HANG_MS)); // hog the only slot
      return jsonResponse(200, {});
    }
    return jsonResponse(200, {}); // the queued request, once it finally runs
  };
  for (const client of CLIENTS) {
    await withEnv(
      {
        ...JIRA,
        SN_MAX_CONCURRENT: "1",
        SN_TIMEOUT_MS: String(TIMEOUT_MS),
        // The queue wait limit defaults to SN_TIMEOUT_MS (H-10); lift it so
        // this test keeps measuring the per-attempt clock, not the wait line.
        SN_QUEUE_TIMEOUT_MS: "1000",
        SN_MAX_RETRIES: "0",
      },
      () =>
        withFetch(handler, async () => {
          // Two requests, one slot: the second waits ~HANG_MS (> TIMEOUT_MS) for
          // the slot. Its timeout budget must start on slot acquisition, not on
          // enqueue — otherwise the wait alone would abort it.
          const results = await Promise.allSettled([
            client.call({ method: "GET" }),
            client.call({ method: "GET" }),
          ]);
          for (const r of results) {
            assert.equal(
              r.status,
              "fulfilled",
              `${client.name}: a queued request must not time out while waiting for the slot`,
            );
          }
        }),
    );
  }
});
