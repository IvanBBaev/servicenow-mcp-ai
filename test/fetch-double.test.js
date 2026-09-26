import test from "node:test";
import assert from "node:assert/strict";

import { queryTable } from "../build/api/table.js";
import { getTelemetry } from "../build/core/http.js";
import {
  baselineEnv,
  createFetchDouble,
  fakeClock,
  freshRuntime,
  realFetch,
  withEnv,
  withFetchDouble,
} from "./helpers.js";

// E-6 / L9-01: the contract of the fetch double v2 and the fake clock, plus
// retry paths driven end-to-end on virtual time.

baselineEnv();

const TABLE = /^\/api\/now\/table\/incident$/;

test.beforeEach(() => {
  freshRuntime();
});

test("routes match by method and path, in registration order", async () => {
  const double = createFetchDouble()
    .route("GET", TABLE, { json: { result: [{ a: 1 }] } })
    .route("POST", "/api/now/table/incident", { status: 201, json: { ok: 1 } })
    .route("*", /\/api\/now\/stats\//, { json: { result: {} } });
  const get = await double.fetch(
    "https://h.example/api/now/table/incident?x=1",
  );
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("content-type"), "application/json");
  assert.deepEqual(await get.json(), { result: [{ a: 1 }] });
  const post = await double.fetch("https://h.example/api/now/table/incident", {
    method: "post",
    headers: { "X-Custom": "yes" },
    body: '{"n":1}',
    dispatcher: "d1",
  });
  assert.equal(post.status, 201);
  const stats = await double.fetch("https://h.example/api/now/stats/task", {
    method: "DELETE",
  });
  assert.equal(stats.status, 200);

  assert.equal(double.calls.length, 3);
  const [c1, c2] = double.calls;
  assert.equal(c1.n, 1);
  assert.equal(c1.path, "/api/now/table/incident");
  assert.equal(c1.query.get("x"), "1");
  assert.equal(c2.method, "POST");
  assert.equal(c2.headers["x-custom"], "yes", "header names are lower-cased");
  assert.equal(c2.body, '{"n":1}');
  assert.equal(c2.dispatcher, "d1");
  assert.equal(double.callsTo("GET", TABLE).length, 1);
  assert.equal(double.callsTo("*", /incident/).length, 2);
});

test("an unmatched request answers 501 and is listed, a fallback answers instead", async () => {
  const double = createFetchDouble();
  const res = await double.fetch("https://h.example/api/nope");
  assert.equal(res.status, 501);
  assert.match(
    (await res.json()).error.message,
    /no route for GET \/api\/nope/,
  );
  assert.equal(double.unmatched.length, 1);

  const withFallback = createFetchDouble({ fallback: { status: 404 } });
  assert.equal((await withFallback.fetch("https://h.example/x")).status, 404);
  assert.equal(withFallback.unmatched.length, 0);
});

test("an array responder answers in turn and repeats its last entry", async () => {
  const double = createFetchDouble().route("GET", /.*/, [
    { status: 503, headers: { "retry-after": "2" } },
    { status: 200, body: "second" },
  ]);
  const a = await double.fetch("https://h.example/a");
  assert.equal(a.status, 503);
  assert.equal(a.headers.get("retry-after"), "2");
  assert.equal(
    await (await double.fetch("https://h.example/b")).text(),
    "second",
  );
  assert.equal(
    await (await double.fetch("https://h.example/c")).text(),
    "second",
  );
});

test("a function responder sees the call and its hit number; a throw fails the fetch", async () => {
  const double = createFetchDouble()
    .route("GET", "/boom", () => {
      throw new TypeError("fetch failed");
    })
    .route("GET", /.*/, (call, hit) => ({
      json: { path: call.path, hit },
    }));
  assert.deepEqual(await (await double.fetch("https://h.example/p")).json(), {
    path: "/p",
    hit: 1,
  });
  assert.deepEqual(await (await double.fetch("https://h.example/q")).json(), {
    path: "/q",
    hit: 2,
  });
  await assert.rejects(double.fetch("https://h.example/boom"), TypeError);
  // `error` in a spec does the same declaratively.
  const failing = createFetchDouble().route("*", /.*/, {
    error: "socket hang up",
  });
  await assert.rejects(failing.fetch("https://h.example/"), /socket hang up/);
  // A Response instance passes through, and 204 never carries a body.
  const passthrough = createFetchDouble()
    .route("GET", "/r", () => new Response("raw", { status: 202 }))
    .route("GET", "/empty", { status: 204, body: "ignored" });
  assert.equal(
    await (await passthrough.fetch("https://h.example/r")).text(),
    "raw",
  );
  assert.equal((await passthrough.fetch("https://h.example/empty")).body, null);
});

test("delayMs waits on the mocked clock and `at` records virtual time", async (t) => {
  const clock = fakeClock(t, { now: 1_000 });
  const double = createFetchDouble().route("GET", /.*/, {
    delayMs: 5_000,
    json: { late: true },
  });
  let done = false;
  const pending = double.fetch("https://h.example/slow").then((r) => {
    done = true;
    return r;
  });
  await clock.flush();
  clock.tick(4_999);
  await clock.flush();
  assert.equal(done, false, "not answered before the delay elapses");
  clock.tick(1);
  const res = await pending;
  assert.deepEqual(await res.json(), { late: true });
  assert.equal(double.calls[0].at, 1_000);
  assert.equal(clock.elapsed(), 5_000);
});

test("an abort during the delay rejects with the signal's reason", async (t) => {
  const clock = fakeClock(t);
  const double = createFetchDouble()
    .route("GET", "/slow", { delayMs: 60_000 })
    .route("GET", "/hang", { hang: true })
    .route("GET", "/stubborn", { delayMs: 100, abortable: false });
  const controller = new AbortController();
  const slow = double.fetch("https://h.example/slow", {
    signal: controller.signal,
  });
  const hang = double.fetch("https://h.example/hang", {
    signal: controller.signal,
  });
  const stubborn = double.fetch("https://h.example/stubborn", {
    signal: controller.signal,
  });
  await clock.flush();
  controller.abort(new DOMException("stop", "AbortError"));
  await assert.rejects(slow, { name: "AbortError", message: "stop" });
  await assert.rejects(hang, { name: "AbortError" });
  // `abortable: false` finishes its delay regardless.
  const res = await clock.run(stubborn);
  assert.equal(res.status, 200);
  // An already-aborted signal fails at once.
  await assert.rejects(
    double.fetch("https://h.example/slow", { signal: controller.signal }),
    { name: "AbortError" },
  );
});

test("a streamed body arrives chunk by chunk on the clock", async (t) => {
  const clock = fakeClock(t);
  const double = createFetchDouble().route("GET", /.*/, {
    headers: { "content-type": "text/plain" },
    stream: ["alpha,", new TextEncoder().encode("beta,"), "gamma"],
    chunkDelayMs: 1_000,
  });
  const res = await double.fetch("https://h.example/stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  assert.equal(decoder.decode(first.value), "alpha,");
  let second;
  const reading = reader.read().then((r) => (second = r));
  await clock.flush();
  assert.equal(second, undefined, "the second chunk waits for the clock");
  clock.tick(1_000);
  await reading;
  assert.equal(decoder.decode(second.value), "beta,");
  const rest = await clock.run(reader.read());
  assert.equal(decoder.decode(rest.value), "gamma");
  assert.equal((await reader.read()).done, true);
});

test("an abort mid-stream errors the body", async (t) => {
  const clock = fakeClock(t);
  const controller = new AbortController();
  const double = createFetchDouble().route("GET", /.*/, {
    stream: ["a", "b"],
    chunkDelayMs: 500,
  });
  const res = await double.fetch("https://h.example/", {
    signal: controller.signal,
  });
  const reader = res.body.getReader();
  await reader.read();
  const next = reader.read();
  await clock.flush();
  controller.abort();
  await assert.rejects(next, { name: "AbortError" });
});

test("withFetchDouble installs the double and restores the real fetch", async () => {
  await withFetchDouble(
    (d) => d.route("GET", /.*/, { json: { ok: true } }),
    async (d) => {
      assert.equal(globalThis.fetch, d.fetch);
    },
  );
  assert.equal(globalThis.fetch, realFetch);
  await assert.rejects(
    withFetchDouble(null, async () => {
      throw new Error("inner");
    }),
    /inner/,
  );
  assert.equal(globalThis.fetch, realFetch);
});

test("fakeClock.run fails a promise that never settles instead of hanging", async (t) => {
  const clock = fakeClock(t);
  await assert.rejects(
    clock.run(new Promise(() => {}), { step: 1_000, maxMs: 3_000 }),
    /still pending after 3000 ms/,
  );
});

// --- retry paths on virtual time ------------------------------------------

test("a GET retries a 503 after exponential backoff, never before (virtual time)", async (t) => {
  const clock = fakeClock(t);
  await withEnv({ SN_MAX_RETRIES: "2" }, () =>
    withFetchDouble(
      (d) =>
        d.route("GET", TABLE, [
          { status: 503, json: { error: { message: "busy" } } },
          { status: 503, json: { error: { message: "busy" } } },
          { json: { result: [{ n: 1 }] } },
        ]),
      async (d) => {
        const { records } = await clock.run(queryTable({ table: "incident" }), {
          step: 50,
        });
        assert.equal(records.length, 1);
        assert.equal(d.calls.length, 3);
        // backoffMs(n) = min(500·2^(n-1), 8000) + jitter in [0, 250).
        const gap1 = d.calls[1].at - d.calls[0].at;
        const gap2 = d.calls[2].at - d.calls[1].at;
        assert.ok(gap1 >= 500 && gap1 < 800, `first backoff ${gap1}`);
        assert.ok(gap2 >= 1000 && gap2 < 1300, `second backoff ${gap2}`);
        assert.equal(getTelemetry().retries, 2);
      },
    ),
  );
});

test("a numeric Retry-After is waited out exactly on the clock", async (t) => {
  const clock = fakeClock(t);
  await withEnv({ SN_MAX_RETRIES: "1" }, () =>
    withFetchDouble(
      (d) =>
        d.route("GET", TABLE, [
          { status: 429, headers: { "retry-after": "3" }, json: {} },
          { json: { result: [] } },
        ]),
      async (d) => {
        await clock.run(queryTable({ table: "incident" }), { step: 100 });
        const gap = d.calls[1].at - d.calls[0].at;
        assert.ok(gap >= 3_000 && gap < 3_100, `waited ${gap}`);
      },
    ),
  );
});

test("a Retry-After past SN_DEADLINE_MS fails fast with DEADLINE_EXCEEDED and no second call", async (t) => {
  const clock = fakeClock(t);
  await withEnv(
    {
      SN_MAX_RETRIES: "3",
      SN_DEADLINE_MS: "2000",
      SN_RETRY_AFTER_MAX_MS: "60000",
    },
    () =>
      withFetchDouble(
        (d) =>
          d.route("GET", TABLE, {
            status: 503,
            headers: { "retry-after": "30" },
            json: {},
          }),
        async (d) => {
          await assert.rejects(
            clock.run(queryTable({ table: "incident" })),
            (err) => err.code === "DEADLINE_EXCEEDED",
          );
          assert.equal(d.calls.length, 1);
          assert.equal(clock.elapsed(), 0, "no virtual time was spent waiting");
        },
      ),
  );
});
