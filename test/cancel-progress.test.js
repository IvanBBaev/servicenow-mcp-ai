import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { runSpec, defineTool } from "../build/mcp/define.js";
import { specs as instanceSpecs } from "../build/tools/instance.js";
import { specs as tableSpecs } from "../build/tools/table.js";
import { specs as batchSpecs } from "../build/tools/batch.js";
import { snRequest } from "../build/core/http.js";
import { logger } from "../build/core/logging.js";
import { ok } from "../build/mcp/result.js";
import { createProgressSink } from "../build/mcp/progress.js";
import {
  cancelledError,
  reportProgress,
  throwIfCancelled,
  trackProgress,
} from "../build/core/progress.js";
import {
  currentSignal,
  logContext,
  runWithCall,
  runWithProfile,
} from "../build/core/request-context.js";
import { getQueueStats } from "../build/core/http-util.js";
import {
  baselineEnv,
  fakeClock,
  flushAsync,
  freshRuntime,
  withEnv,
  withFetch,
  withFetchDouble,
  jsonResponse,
} from "./helpers.js";

// M-3: cancellation (extra.signal), progress notifications (progressToken)
// and the per-call log context.

const DOCS_DIR = path.join(os.tmpdir(), `servicenow-mcp-m3-${process.pid}`);
process.env.SN_DOCS_DIR = DOCS_DIR;

test.before(async () => {
  await fs.rm(DOCS_DIR, { recursive: true, force: true });
});

test.after(async () => {
  await fs.rm(DOCS_DIR, { recursive: true, force: true });
});

test.beforeEach(() => {
  baselineEnv();
  freshRuntime();
});

const spec = (specs, name) => specs.find((s) => s.name === name);
const snapshotSpec = spec(instanceSpecs, "servicenow_snapshot_instance");
const compareSpec = spec(instanceSpecs, "servicenow_compare_instances");
const querySpec = spec(tableSpecs, "servicenow_query_table");
const batchSpec = spec(batchSpecs, "servicenow_batch");

/** An instance that answers every table/stats read with an empty result. */
const emptyInstance = () => jsonResponse(200, { result: [] });

/** Parse a ToolResult's JSON payload. */
const payload = (result) => JSON.parse(result.content[0].text);

/** An `extra` with a progress token that records every notification sent. */
function progressExtra(token = "tok-1") {
  const sent = [];
  return {
    sent,
    extra: {
      requestId: 7,
      _meta: { progressToken: token },
      sendNotification: async (n) => {
        sent.push(n);
      },
    },
  };
}

/** Capture the stderr JSON log lines emitted during `fn`. */
async function captureLogs(fn) {
  const lines = [];
  const real = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    await fn();
  } finally {
    console.error = real;
  }
  return lines.map((l) => JSON.parse(l));
}

// --- cancellation ----------------------------------------------------------

/**
 * Let the event loop turn (real I/O included — the snapshot writes files)
 * until `done()` holds; bounded so a regression fails instead of hanging.
 */
async function waitFor(done, what, limit = 5_000) {
  for (let i = 0; i < limit && !done(); i++) await flushAsync(1);
  assert.ok(done(), `timed out waiting for ${what}`);
}

/** Flush promise callbacks until `probe()` stops changing (max `limit` rounds). */
async function settle(probe, limit = 200) {
  let last = probe();
  let stable = 0;
  for (let i = 0; i < limit && stable < 5; i++) {
    await flushAsync(1);
    const now = probe();
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
}

test("a cancelled snapshot stops issuing requests within one retry window", async (t) => {
  // E-6: this test used to race a real 20 ms abort timer against the >= 500 ms
  // retry backoff and assert a wall-clock bound (< 500 ms), which failed under
  // load. On the fake clock the backoff cannot elapse at all: every read that
  // needs no timer completes, the third request stays parked in its backoff,
  // and the abort must end the call without any virtual time passing.
  const clock = fakeClock(t);
  const controller = new AbortController();
  await withEnv({ SN_MAX_RETRIES: "3" }, () =>
    withFetchDouble(
      (d) =>
        d.route("*", /.*/, (call) =>
          call.n === 3
            ? { status: 503, json: { error: { message: "busy" } } }
            : { json: { result: [] } },
        ),
      async (d) => {
        let result;
        const pending = runSpec(
          snapshotSpec,
          { tables: ["incident", "task"] },
          { signal: controller.signal },
        ).then((r) => (result = r));
        await waitFor(() => d.calls.length >= 3, "the failing third request");
        await settle(() => d.calls.length);
        assert.equal(result, undefined, "the retry backoff is still pending");
        const atAbort = d.calls.length;
        controller.abort();
        // The abort alone ends the call — the clock never moves.
        await waitFor(() => result !== undefined, "the cancelled result");
        await pending;
        assert.equal(clock.elapsed(), 0, "ended inside the retry window");
        assert.equal(result.isError, true);
        assert.equal(payload(result).code, "CANCELLED");
        assert.match(payload(result).hint, /cancelled/);
        // S-7: sections fan out, so other units may have read on while the
        // third request waited — but nothing is sent after the abort.
        assert.equal(
          d.calls.length,
          atAbort,
          "no request after the cancellation",
        );
        // Nothing trickles out later either, even once every backoff and
        // Retry-After window has long passed.
        clock.tick(60_000);
        await settle(() => d.calls.length);
        assert.equal(d.calls.length, atAbort);
      },
    ),
  );
});

test("a snapshot cancelled between sections fails fast instead of warning", async () => {
  const controller = new AbortController();
  await withFetch(
    (url, _init, n) => {
      if (n === 1) controller.abort();
      return emptyInstance(url);
    },
    async (calls) => {
      const result = await runSpec(
        snapshotSpec,
        { tables: ["incident"] },
        { signal: controller.signal },
      );
      assert.equal(result.isError, true);
      assert.equal(payload(result).code, "CANCELLED");
      // At most one in-flight read per fan-out slot (S-7), none after.
      assert.ok(calls.length <= 4, `${calls.length} requests`);
    },
  );
});

test("an already-aborted signal sends no request at all", async () => {
  const controller = new AbortController();
  controller.abort();
  await withFetch(emptyInstance, async (calls) => {
    const result = await runSpec(
      querySpec,
      { table: "incident" },
      { signal: controller.signal },
    );
    assert.equal(payload(result).code, "CANCELLED");
    assert.equal(calls.length, 0);
  });
});

test("a request waiting in the host queue is released by the abort", async () => {
  await withEnv({ SN_MAX_CONCURRENT: "1" }, async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    await withFetch(
      async () => {
        await gate;
        return jsonResponse(200, { result: [] });
      },
      async (calls) => {
        const first = snRequest({ method: "GET", path: "/api/now/table/a" });
        const controller = new AbortController();
        const second = snRequest({
          method: "GET",
          path: "/api/now/table/b",
          signal: controller.signal,
        });
        // Abort once the second request is parked in the queue — no timer.
        for (let i = 0; i < 100; i++) {
          if (getQueueStats()["dev00000.service-now.com"]?.queued === 1) break;
          await flushAsync(1);
        }
        assert.deepEqual(getQueueStats()["dev00000.service-now.com"], {
          active: 1,
          queued: 1,
        });
        controller.abort();
        await assert.rejects(second, (err) => err.code === "CANCELLED");
        release();
        await first;
        assert.equal(calls.length, 1, "the queued request never ran");
      },
    );
  });
});

test("the call signal is the default for snRequest; outside a call there is none", async () => {
  assert.equal(currentSignal(), undefined);
  const controller = new AbortController();
  await runWithCall(
    { requestId: "r", tool: "t", signal: controller.signal },
    async () => {
      assert.equal(currentSignal(), controller.signal);
      controller.abort();
      await withFetch(emptyInstance, async (calls) => {
        await assert.rejects(
          snRequest({ method: "GET", path: "/api/now/table/x" }),
          (err) => err.code === "CANCELLED",
        );
        assert.equal(calls.length, 0);
      });
    },
  );
});

test("throwIfCancelled and trackProgress check the call signal", async () => {
  // Outside a call both are inert.
  throwIfCancelled();
  const idle = trackProgress(2);
  idle.tick("one");
  assert.equal(idle.done, 1);
  reportProgress({ progress: 1 });

  const controller = new AbortController();
  const seen = [];
  await runWithCall(
    {
      requestId: "r",
      tool: "t",
      signal: controller.signal,
      progress: (u) => seen.push(u),
    },
    async () => {
      const p = trackProgress();
      p.tick();
      p.tick("two", 2);
      controller.abort();
      assert.throws(
        () => p.tick("three"),
        (err) => err.code === "CANCELLED",
      );
      assert.throws(
        () => throwIfCancelled(),
        (err) => err.code === "CANCELLED",
      );
      assert.equal(p.done, 3);
    },
  );
  assert.deepEqual(seen, [{ progress: 1 }, { progress: 3, message: "two" }]);
  assert.equal(cancelledError("x").message, "x");
});

// --- progress ----------------------------------------------------------------

test("createProgressSink throttles, keeps progress monotonic and flushes the tail", async () => {
  let clock = 1000;
  const sent = [];
  const { sink, flush } = createProgressSink(
    "tok",
    async (n) => sent.push(n.params),
    250,
    () => clock,
  );
  sink({ progress: 1, total: 10 }); // first: sent
  sink({ progress: 2, total: 10 }); // throttled, pending
  sink({ progress: 2, total: 10 }); // not increasing: dropped
  clock += 300;
  sink({ progress: 3, total: 10, message: "m" }); // interval passed: sent
  sink({ progress: 1, total: 10 }); // going backwards: dropped
  sink({ progress: 4, total: 10 }); // throttled, pending
  flush(); // sends the pending 4
  flush(); // nothing left
  sink({ progress: 10, total: 10 }); // completion: always sent
  assert.deepEqual(sent, [
    { progressToken: "tok", progress: 1, total: 10 },
    { progressToken: "tok", progress: 3, total: 10, message: "m" },
    { progressToken: "tok", progress: 4, total: 10 },
    { progressToken: "tok", progress: 10, total: 10 },
  ]);
});

test("a failing sendNotification never breaks the tool call", async () => {
  const { sink, flush } = createProgressSink(1, () => {
    throw new Error("transport closed");
  });
  sink({ progress: 1 });
  const rejecting = createProgressSink(2, async () => {
    throw new Error("transport closed");
  });
  rejecting.sink({ progress: 1 });
  flush();
  await new Promise((r) => setImmediate(r));
});

test("snapshot emits progress only when the call carries a token", async () => {
  const { sent, extra } = progressExtra();
  await withFetch(emptyInstance, async () => {
    const withToken = await runSpec(
      snapshotSpec,
      { tables: ["incident"] },
      extra,
    );
    assert.notEqual(withToken.isError, true);
  });
  assert.ok(sent.length >= 2, `sent ${sent.length}`);
  for (const n of sent) {
    assert.equal(n.method, "notifications/progress");
    assert.equal(n.params.progressToken, "tok-1");
  }
  const values = sent.map((n) => n.params.progress);
  assert.deepEqual(
    values,
    [...values].sort((a, b) => a - b),
  );
  const last = sent.at(-1).params;
  assert.equal(last.progress, last.total, "the final update completes");

  // No token (or no sendNotification): silent.
  let noToken = 0;
  await withFetch(emptyInstance, () =>
    runSpec(snapshotSpec, {}, { sendNotification: async () => noToken++ }),
  );
  await withFetch(emptyInstance, () =>
    runSpec(snapshotSpec, {}, { _meta: { progressToken: "t" } }),
  );
  assert.equal(noToken, 0);
});

test("compare_instances reports its steps against a fixed total", async () => {
  await withEnv(
    {
      SN_PROFILE_PROD_INSTANCE: "prod99999.service-now.com",
      SN_PROFILE_PROD_USER: "prod.user",
      SN_PROFILE_PROD_PASSWORD: "pr0d",
    },
    async () => {
      const { sent, extra } = progressExtra("cmp");
      await withFetch(emptyInstance, async () => {
        const result = await runSpec(
          compareSpec,
          { a: "default", b: "prod" },
          extra,
        );
        assert.notEqual(result.isError, true, result.content[0].text);
      });
      assert.ok(sent.length >= 2);
      const last = sent.at(-1).params;
      assert.equal(last.total, 9);
      assert.equal(last.progress, 9);
      assert.equal(last.message, "report");
    },
  );
});

test("a fetchAll query reports records fetched against X-Total-Count", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ n: i }));
  const { sent, extra } = progressExtra("q");
  await withFetch(
    (url) => {
      const u = new URL(url);
      const limit = Number(u.searchParams.get("sysparm_limit"));
      const offset = Number(u.searchParams.get("sysparm_offset") ?? "0");
      return jsonResponse(
        200,
        { result: rows.slice(offset, offset + limit) },
        { "x-total-count": String(rows.length) },
      );
    },
    async () => {
      const result = await runSpec(
        querySpec,
        { table: "incident", fetchAll: true, limit: 2 },
        extra,
      );
      assert.notEqual(result.isError, true, result.content[0].text);
    },
  );
  assert.ok(sent.length >= 2, `sent ${sent.length}`);
  const last = sent.at(-1).params;
  assert.equal(last.progress, 5);
  assert.equal(last.total, 5);
  assert.match(last.message, /5 incident record\(s\) fetched/);
});

test("a plain (non-fetchAll) query sends no progress", async () => {
  const { sent, extra } = progressExtra();
  await withFetch(emptyInstance, () =>
    runSpec(querySpec, { table: "incident" }, extra),
  );
  assert.equal(sent.length, 0);
});

test("batch reports the start and the serviced count", async () => {
  const { sent, extra } = progressExtra("b");
  await withFetch(
    () =>
      jsonResponse(200, {
        serviced_requests: [
          {
            id: "1",
            status_code: 200,
            body: Buffer.from('{"result":[]}').toString("base64"),
          },
        ],
        unserviced_requests: [],
      }),
    async () => {
      const result = await runSpec(
        batchSpec,
        { requests: [{ method: "GET", url: "/api/now/table/incident" }] },
        extra,
      );
      assert.notEqual(result.isError, true, result.content[0].text);
    },
  );
  assert.deepEqual(
    sent.map((n) => n.params),
    [
      {
        progressToken: "b",
        progress: 0,
        total: 1,
        message: "sending 1 sub-request(s)",
      },
      {
        progressToken: "b",
        progress: 1,
        total: 1,
        message: "1 serviced, 0 not serviced",
      },
    ],
  );
});

// --- log context -------------------------------------------------------------

const loggingSpec = defineTool({
  name: "servicenow_m3_probe",
  title: "probe",
  description: "Test-only tool that logs from inside its handler.",
  package: "test",
  annotations: { readOnlyHint: true },
  input: { note: z.string().optional() },
  handler: async () => {
    logger.info("inside handler", { extra: 1 });
    logger.info("override", { tool: "explicit" });
    return ok({ fine: true });
  },
});

test("every log line of a tool call carries profile, requestId, sessionId and tool", async () => {
  const entries = await captureLogs(() =>
    withEnv({ SN_LOG_LEVEL: "info" }, () =>
      runSpec(loggingSpec, {}, { requestId: 42, sessionId: "sess-1" }),
    ),
  );
  const inside = entries.find((e) => e.message === "inside handler");
  assert.equal(inside.requestId, "42");
  assert.equal(inside.sessionId, "sess-1");
  assert.equal(inside.tool, "servicenow_m3_probe");
  assert.equal(inside.profile, "default");
  assert.equal(inside.extra, 1);
  const done = entries.find((e) => e.message.endsWith("done"));
  assert.equal(done.requestId, "42");
  assert.equal(done.tool, "servicenow_m3_probe");
  // Explicit fields win over the context.
  assert.equal(entries.find((e) => e.message === "override").tool, "explicit");
});

test("a call without a JSON-RPC id gets a local request id; no session is omitted", async () => {
  const entries = await captureLogs(() =>
    withEnv({ SN_LOG_LEVEL: "info" }, () => runSpec(loggingSpec, {})),
  );
  const inside = entries.find((e) => e.message === "inside handler");
  assert.match(inside.requestId, /^local-/);
  assert.equal("sessionId" in inside, false);
});

test("outside a tool call log lines carry no call context", async () => {
  assert.equal(logContext(), undefined);
  const entries = await captureLogs(() =>
    withEnv({ SN_LOG_LEVEL: "info" }, () => logger.info("idle")),
  );
  assert.equal("requestId" in entries[0], false);
  assert.equal("tool" in entries[0], false);
});

test("an explicit per-request profile wins over the call's profile", async () => {
  await runWithCall({ requestId: "r", tool: "t", profile: "dev" }, () => {
    assert.equal(logContext().profile, "dev");
    return runWithProfile("prod", () => {
      assert.equal(logContext().profile, "prod");
    });
  });
});

test("a cancelled call logs as cancelled, not failed", async () => {
  const controller = new AbortController();
  controller.abort();
  const entries = await captureLogs(() =>
    withEnv({ SN_LOG_LEVEL: "info" }, () =>
      withFetch(emptyInstance, () =>
        runSpec(
          querySpec,
          { table: "incident" },
          { signal: controller.signal },
        ),
      ),
    ),
  );
  assert.ok(
    entries.some((e) => e.message === "tool servicenow_query_table cancelled"),
    JSON.stringify(entries.map((e) => e.message)),
  );
});
