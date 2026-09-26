import test from "node:test";
import assert from "node:assert/strict";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  createLogBridge,
  LOG_NOTIFY_MIN_BURST,
  LOG_SUPPRESSED_SUMMARY_MS,
} from "../build/mcp/log-bridge.js";
import {
  getLogNotifyRate,
  DEFAULT_LOG_NOTIFY_RATE,
} from "../build/core/settings.js";
import { withEnv } from "./helpers.js";

/** A fake low-level server that records what the bridge sends. */
function recordingServer({ sessionId, ignored } = {}) {
  const sent = [];
  return {
    sent,
    transport: sessionId ? { sessionId } : undefined,
    ...(ignored ? { isMessageIgnored: ignored } : {}),
    sendLoggingMessage(params, session) {
      sent.push({ ...params, session });
      return Promise.resolve();
    },
  };
}

test("getLogNotifyRate: default 20, 0 disables, invalid falls back", async () => {
  await withEnv({ SN_LOG_NOTIFY_RATE: undefined }, () =>
    assert.equal(getLogNotifyRate(), DEFAULT_LOG_NOTIFY_RATE),
  );
  await withEnv({ SN_LOG_NOTIFY_RATE: "0" }, () =>
    assert.equal(getLogNotifyRate(), 0),
  );
  await withEnv({ SN_LOG_NOTIFY_RATE: "5" }, () =>
    assert.equal(getLogNotifyRate(), 5),
  );
  await withEnv({ SN_LOG_NOTIFY_RATE: "-3" }, () =>
    assert.equal(getLogNotifyRate(), DEFAULT_LOG_NOTIFY_RATE),
  );
});

test("the bridge maps levels and sends the call's session id first, then the transport's", async () => {
  const server = recordingServer({ sessionId: "transport-sess" });
  const sink = createLogBridge(server);
  await withEnv({ SN_LOG_NOTIFY_RATE: undefined }, () => {
    sink("warn", "from a call", { sessionId: "call-sess", tool: "t" });
    sink("info", "outside a call");
    sink("error", "empty session field", { sessionId: "" });
  });
  assert.deepEqual(server.sent, [
    {
      level: "warning",
      data: { message: "from a call", sessionId: "call-sess", tool: "t" },
      session: "call-sess",
    },
    {
      level: "info",
      data: { message: "outside a call" },
      session: "transport-sess",
    },
    {
      level: "error",
      data: { message: "empty session field", sessionId: "" },
      session: "transport-sess",
    },
  ]);
});

test("a failing sendLoggingMessage is swallowed", async () => {
  const sink = createLogBridge({
    sendLoggingMessage: () => Promise.reject(new Error("closed")),
  });
  await withEnv({ SN_LOG_NOTIFY_RATE: undefined }, () => {
    assert.doesNotThrow(() => sink("info", "x"));
  });
  await new Promise((r) => setImmediate(r));
});

test("logging/setLevel is honoured for a session-bound transport (HTTP)", async () => {
  const server = new Server(
    { name: "t", version: "0" },
    { capabilities: { logging: {} } },
  );
  const client = new Client({ name: "c", version: "0" });
  const received = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    received.push(n.params);
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  // A Streamable HTTP transport carries its session id; the SDK keys the
  // level the client sets under it.
  serverTransport.sessionId = "http-session-1";
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await client.setLoggingLevel("warning");
    const sink = createLogBridge(server);
    await withEnv({ SN_LOG_NOTIFY_RATE: undefined }, () => {
      sink("info", "below the level");
      sink("debug", "below the level too");
      sink("warn", "at the level");
      sink("error", "above the level");
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      received.map((p) => p.data.message),
      ["at the level", "above the level"],
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("token bucket: 1000 debug lines → the burst plus one suppressed summary", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const server = recordingServer({ sessionId: "s1" });
  const sink = createLogBridge(server);
  await withEnv({ SN_LOG_NOTIFY_RATE: undefined }, () => {
    for (let i = 0; i < 1000; i++) sink("debug", `line ${i}`);
  });
  assert.equal(server.sent.length, LOG_NOTIFY_MIN_BURST);
  assert.ok(server.sent.every((m) => m.level === "debug"));

  await withEnv({ SN_LOG_NOTIFY_RATE: undefined }, () => {
    t.mock.timers.tick(LOG_SUPPRESSED_SUMMARY_MS);
  });
  assert.equal(server.sent.length, LOG_NOTIFY_MIN_BURST + 1);
  const summary = server.sent.at(-1);
  assert.equal(summary.level, "warning");
  assert.equal(summary.session, "s1");
  assert.equal(summary.data.suppressed, 1000 - LOG_NOTIFY_MIN_BURST);
  assert.match(summary.data.message, /950 log messages suppressed/);

  // A minute later the bucket is full again (refill 20/s, capped at the burst).
  await withEnv({ SN_LOG_NOTIFY_RATE: undefined }, () => {
    for (let i = 0; i < 60; i++) sink("info", `again ${i}`);
  });
  assert.equal(server.sent.length, LOG_NOTIFY_MIN_BURST + 1 + 50);

  // One second refills the rate's worth of tokens.
  t.mock.timers.tick(1000);
  const before = server.sent.length;
  await withEnv({ SN_LOG_NOTIFY_RATE: undefined }, () => {
    for (let i = 0; i < 30; i++) sink("info", `refill ${i}`);
  });
  assert.equal(server.sent.length - before, DEFAULT_LOG_NOTIFY_RATE);
});

test("token bucket: sessions have separate buckets; a summary with nothing suppressed is skipped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const server = recordingServer();
  const sink = createLogBridge(server);
  await withEnv({ SN_LOG_NOTIFY_RATE: "1" }, () => {
    for (let i = 0; i < 60; i++) sink("info", "a", { sessionId: "A" });
    for (let i = 0; i < 10; i++) sink("info", "b", { sessionId: "B" });
  });
  const bySession = (s) => server.sent.filter((m) => m.session === s).length;
  assert.equal(bySession("A"), LOG_NOTIFY_MIN_BURST);
  assert.equal(bySession("B"), 10);
  t.mock.timers.tick(LOG_SUPPRESSED_SUMMARY_MS);
  const summaries = server.sent.filter((m) => m.data.suppressed);
  assert.deepEqual(
    summaries.map((m) => [m.session, m.data.suppressed]),
    [["A", 10]],
  );
});

test("a rate above the minimum burst raises the burst", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const server = recordingServer();
  const sink = createLogBridge(server);
  await withEnv({ SN_LOG_NOTIFY_RATE: "200" }, () => {
    for (let i = 0; i < 500; i++) sink("debug", "x");
  });
  assert.equal(server.sent.length, 200);
});

test("SN_LOG_NOTIFY_RATE=0 turns the limit off", async () => {
  const server = recordingServer();
  const sink = createLogBridge(server);
  await withEnv({ SN_LOG_NOTIFY_RATE: "0" }, () => {
    for (let i = 0; i < 1000; i++) sink("debug", "x");
  });
  assert.equal(server.sent.length, 1000);
});

test("messages the client's level drops spend no token", async () => {
  const server = recordingServer({
    ignored: (level) => level === "debug",
  });
  const sink = createLogBridge(server);
  await withEnv({ SN_LOG_NOTIFY_RATE: undefined }, () => {
    for (let i = 0; i < 1000; i++) sink("debug", "dropped by the client");
    for (let i = 0; i < 10; i++) sink("info", "kept");
  });
  assert.equal(server.sent.length, 10);
  assert.ok(server.sent.every((m) => m.level === "info"));
});
