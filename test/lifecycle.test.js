// E-9 — process lifecycle: the crash handlers (child-process and in-process),
// dispose() and the HTTP transport's session-close path.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  dispose,
  registerDisposer,
  handleCrash,
  crashFields,
} from "../build/core/lifecycle.js";
import { cached, getSchemaCacheStats } from "../build/core/cache.js";
import { pluginCall, pluginAvailability } from "../build/api/plugin.js";
import {
  _dispatcherCacheSize,
  _setUndiciLoader,
  getDispatcher,
} from "../build/core/dispatcher.js";
import {
  getBreakerStats,
  getQueueStats,
  withSlot,
} from "../build/core/http-util.js";
import { snRequest } from "../build/core/http.js";
import {
  connectTransport,
  closeHttpTransport,
} from "../build/mcp/transport.js";
import { baselineEnv, withEnv, withFetch } from "./helpers.js";
import { join } from "node:path";

baselineEnv();

// ---------------------------------------------------------------------------
// Crash handlers — the real path, in a child process
// ---------------------------------------------------------------------------

const probe = join(import.meta.dirname, "./fixtures/crash-probe.mjs");

/** Run the crash probe; resolves with its exit code, streams and timings. */
function runProbe(mode) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = execFile(
      process.execPath,
      [probe, mode],
      {
        timeout: 5000,
        env: { ...process.env, SN_LOG_LEVEL: "info", SN_TRANSPORT: "stdio" },
      },
      (error, stdout, stderr) => {
        resolve({
          pid: child.pid,
          code: error ? error.code : 0,
          killed: Boolean(error?.killed),
          stdout,
          stderr,
          wallMs: Date.now() - started,
        });
      },
    );
  });
}

function assertCrashLine(result, errorPattern) {
  assert.equal(result.killed, false, "the probe must exit by itself");
  assert.equal(result.code, 1, `exit code (stderr: ${result.stderr})`);
  const lines = result.stderr.split("\n").filter((l) => l.trim() !== "");
  assert.equal(
    lines.length,
    1,
    `expected exactly one stderr line, got:\n${result.stderr}`,
  );
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.level, "error");
  assert.equal(entry.pid, result.pid);
  assert.equal(typeof entry.uptime, "number");
  assert.ok(entry.uptime >= 0 && entry.uptime < 10, `uptime ${entry.uptime}`);
  assert.equal(entry.transport, "stdio");
  assert.equal(entry.errorName, "Error");
  assert.match(entry.error, errorPattern);
  assert.equal("stack" in entry, false, "a crash line never carries a stack");
  // The handler's own latency (crash → exit) is what the 1 s budget bounds;
  // the flush wait is capped at 250 ms. Node start-up is excluded so a slow
  // CI runner cannot make this flaky.
  const timing = JSON.parse(result.stdout);
  assert.equal(timing.code, 1);
  assert.ok(
    timing.msSinceCrash < 1000,
    `handler took ${timing.msSinceCrash} ms`,
  );
  assert.ok(result.wallMs < 5000, `probe wall time ${result.wallMs} ms`);
  return entry;
}

test("an unhandled rejection logs one JSON error line and exits 1 within 1 s", async () => {
  const entry = assertCrashLine(
    await runProbe("rejection"),
    /injected rejection/,
  );
  assert.match(entry.message, /Unhandled promise rejection/);
});

test("an uncaught exception logs one JSON error line and exits 1 within 1 s", async () => {
  const entry = assertCrashLine(
    await runProbe("exception"),
    /injected exception/,
  );
  assert.match(entry.message, /Uncaught exception/);
});

// ---------------------------------------------------------------------------
// Crash handlers — in-process, with an injected exit
// ---------------------------------------------------------------------------

/** Capture the logger's stderr lines while `fn` runs. */
async function captureStderr(fn) {
  const lines = [];
  const original = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

test("handleCrash: one structured line through the logger, then exit(1) after the flush", async () => {
  let code;
  const lines = await captureStderr(() =>
    withEnv(
      { SN_LOG_LEVEL: "info", SN_TRANSPORT: "http" },
      () =>
        new Promise((resolve) =>
          handleCrash("uncaughtException", new Error("in-process"), (c) => {
            code = c;
            resolve();
          }),
        ),
    ),
  );
  assert.equal(code, 1);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.level, "error");
  assert.match(entry.message, /Uncaught exception/);
  assert.equal(entry.pid, process.pid);
  assert.equal(entry.transport, "http");
  assert.equal(entry.errorName, "Error");
  assert.equal(entry.error, "in-process");
});

test("crashFields: non-Error reasons are stringified, long messages are bounded, no stack", () => {
  const plain = crashFields("just a string");
  assert.equal(plain.errorName, "string");
  assert.equal(plain.error, "just a string");
  assert.equal(typeof plain.pid, "number");
  assert.equal(typeof plain.uptime, "number");
  assert.equal("stack" in plain, false);

  const huge = crashFields(new RangeError("x".repeat(5000)));
  assert.equal(huge.errorName, "RangeError");
  assert.equal(huge.error.length, 2001);
  assert.ok(huge.error.endsWith("…"));
});

// ---------------------------------------------------------------------------
// dispose()
// ---------------------------------------------------------------------------

const activeTimeouts = () =>
  process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

test("dispose(): drops the schema cache (+ counters) and plugin availability; idempotent and shared", async () => {
  let loads = 0;
  const load = async () => {
    loads += 1;
    return "v";
  };
  await cached("lifecycle:key", load);
  await cached("lifecycle:key", load);
  assert.equal(loads, 1);
  assert.ok(getSchemaCacheStats().hits >= 1);
  await pluginCall("lifecycle_api", async () => "ok");
  assert.equal(pluginAvailability().lifecycle_api, "available");

  const timeoutsBefore = activeTimeouts();
  const first = dispose();
  const second = dispose();
  assert.equal(first, second, "concurrent calls share one run");
  await first;
  await dispose(); // a second, sequential run is harmless

  assert.deepEqual(pluginAvailability(), {});
  const stats = getSchemaCacheStats();
  assert.equal(stats.size, 0);
  assert.equal(stats.hits, 0);
  assert.equal(stats.misses, 0);
  await cached("lifecycle:key", load);
  assert.equal(loads, 2, "the entry was dropped and recomputed");
  assert.equal(activeTimeouts(), timeoutsBefore, "no timers left behind");
});

test("registerDisposer: runs on dispose, a throwing step is logged and skipped, unregister works", async () => {
  const calls = [];
  const unregisterA = registerDisposer(() => {
    calls.push("a");
    throw new Error("a failed");
  });
  const unregisterB = registerDisposer(async () => {
    calls.push("b");
  });
  try {
    const lines = await captureStderr(() =>
      withEnv({ SN_LOG_LEVEL: "warn" }, () => dispose()),
    );
    assert.deepEqual(calls, ["a", "b"]);
    const warn = lines
      .map((l) => JSON.parse(l))
      .find((e) => e.level === "warn");
    assert.ok(warn, "the failing step is logged");
    assert.match(warn.message, /dispose step failed/);
    assert.equal(warn.error, "a failed");
    assert.match(warn.step, /^registered#\d+$/);

    unregisterA();
    await dispose();
    assert.deepEqual(calls, ["a", "b", "b"]);
  } finally {
    unregisterA();
    unregisterB();
  }
});

test("dispose(): queued waiters fail with BUSY, breakers close, dispatchers are closed (H-10)", async () => {
  const HOST = "dev00000.service-now.com";
  // A stand-in for the optional undici module: records whether close() ran.
  class Agent {
    constructor() {
      this.closed = false;
    }
    close() {
      this.closed = true;
      return Promise.resolve();
    }
  }
  _setUndiciLoader(async () => ({ Agent, ProxyAgent: Agent }));
  try {
    await withEnv(
      {
        SN_INSTANCE: "dev00000",
        SN_USER: "u",
        SN_PASSWORD: "p",
        SN_MAX_CONCURRENT: "1",
        SN_QUEUE_TIMEOUT_MS: "60000",
        SN_MAX_RETRIES: "0",
        SN_BREAKER_THRESHOLD: "1",
        SN_HTTPS_PROXY: "http://proxy.example.com:3128",
      },
      async () => {
        // One cached proxy agent for the instance host.
        const agent = await getDispatcher(HOST);
        assert.equal(_dispatcherCacheSize(), 1);

        // One request holding the single slot, one waiting behind it.
        let release;
        const first = withSlot(
          "queue-host",
          () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        );
        const queued = withSlot("queue-host", async () => "never runs");
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(getQueueStats(), {
          "queue-host": { active: 1, queued: 1 },
        });

        // A transport failure trips the opt-in breaker for the instance.
        await withFetch(
          async () => {
            throw new Error("ECONNRESET");
          },
          () =>
            assert.rejects(
              snRequest({
                method: "GET",
                path: "/api/now/table/x",
                bypassQueue: true,
              }),
              /Could not reach ServiceNow/,
            ),
        );
        assert.equal(getBreakerStats()[HOST]?.open, true);

        await dispose();

        await assert.rejects(
          queued,
          (err) => err.name === "SlotBusyError" && err.reason === "drained",
        );
        assert.deepEqual(getQueueStats(), {});
        assert.deepEqual(getBreakerStats(), {});
        assert.equal(_dispatcherCacheSize(), 0);
        assert.equal(
          agent.closed,
          true,
          "the pool is closed, not just dropped",
        );

        release();
        await first;
      },
    );
  } finally {
    _setUndiciLoader(null);
    await dispose();
  }
});

// ---------------------------------------------------------------------------
// HTTP transport — session close runs dispose(), the listener can be stopped
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

test("HTTP transport: a session DELETE disposes the session runtime, not the shared caches; closeHttpTransport stops the listener", async () => {
  const port = await freePort();
  await withEnv(
    {
      SN_TRANSPORT: "http",
      SN_PORT: String(port),
      SN_HTTP_HOST: "127.0.0.1",
      SN_HTTP_TOKEN: undefined,
      SN_LOG_LEVEL: "error",
    },
    async () => {
      // H-7: one server per session, built on the session's own runtime.
      let sessionDisposed = 0;
      const servers = [];
      const factory = (runtime) => {
        runtime.onDispose(() => {
          sessionDisposed += 1;
        });
        const s = new McpServer({ name: "lifecycle-test", version: "0" });
        servers.push(s);
        return s;
      };
      assert.equal(await connectTransport(factory), "http");
      const url = `http://127.0.0.1:${port}/`;
      try {
        let loads = 0;
        await cached("lifecycle:http", async () => ++loads);

        const init = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "lifecycle-test", version: "0" },
            },
          }),
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(init.status, 200);
        const sessionId = init.headers.get("mcp-session-id");
        assert.ok(sessionId, "initialize returns a session id");
        await init.text(); // the SSE body ends once the response is sent

        const del = await fetch(url, {
          method: "DELETE",
          headers: { "mcp-session-id": sessionId },
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(del.status, 200);

        assert.equal(sessionDisposed, 1, "session close disposed its runtime");
        await cached("lifecycle:http", async () => ++loads);
        assert.equal(
          loads,
          1,
          "the process-scoped schema cache survives a session close",
        );
      } finally {
        for (const s of servers) await s.close().catch(() => undefined);
        await closeHttpTransport();
        await closeHttpTransport(); // no-op once nothing is listening
      }
      await assert.rejects(
        fetch(url, { method: "GET", signal: AbortSignal.timeout(2000) }),
        "the listener is closed",
      );
    },
  );
});

test("HTTP transport: a bind failure rejects start-up instead of crashing later", async () => {
  const port = await freePort();
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(port, "127.0.0.1", resolve));
  try {
    await withEnv(
      {
        SN_TRANSPORT: "http",
        SN_PORT: String(port),
        SN_HTTP_HOST: "127.0.0.1",
        SN_LOG_LEVEL: "error",
      },
      async () => {
        const server = new McpServer({ name: "lifecycle-test", version: "0" });
        try {
          await assert.rejects(connectTransport(server), /EADDRINUSE/);
        } finally {
          await server.close().catch(() => undefined);
          await closeHttpTransport();
        }
      },
    );
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});
