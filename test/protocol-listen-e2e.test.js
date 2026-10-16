// N-35 / listen — subscriptions/listen through the real entry point: each test
// spawns build/index.js with a sandboxed environment (no SN_* variables, no
// credentials, so nothing reaches a network) and speaks raw JSON-RPC, over
// stdio (newline-delimited) or the modern HTTP leg (SN_TRANSPORT=http, SSE).
// protocol-listen.test.js covers the guards in-process; these prove they are
// wired into production and that a shutdown ends an open listen stream with
// its completion result and cancellation, without waiting out the HTTP drain.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DRAIN_TIMEOUT_MS } from "../build/mcp/transport.js";
import { TASKS_EXTENSION } from "../build/mcp/tasks.js";

const MODERN = "2026-07-28";
const SUB_ID = "io.modelcontextprotocol/subscriptionId";
const ALL_LISTS = {
  toolsListChanged: true,
  promptsListChanged: true,
  resourcesListChanged: true,
};
const TEARDOWN_CANCEL = (requestId) => ({
  jsonrpc: "2.0",
  method: "notifications/cancelled",
  params: { requestId, reason: "Subscription closed by the server." },
});

const root = join(import.meta.dirname, "..");
const entry = join(root, "build", "index.js");
const sandbox = mkdtempSync(join(tmpdir(), "sn-listen-e2e-"));
test.after(() => rmSync(sandbox, { recursive: true, force: true }));

/** The parent environment minus every SN_* key, pointed at the sandbox. */
function cleanEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("SN_") && value !== undefined) env[key] = value;
  }
  return {
    ...env,
    HOME: sandbox,
    USERPROFILE: sandbox,
    XDG_CONFIG_HOME: join(sandbox, "config"),
    SN_ENV_FILE: join(sandbox, "does-not-exist.env"),
    SN_DOCS_DIR: join(sandbox, "docs"),
    SN_LOG_LEVEL: "warn",
    ...extra,
  };
}

const request = (id, method, params = {}, capabilities = {}) => ({
  jsonrpc: "2.0",
  id,
  method,
  params: {
    ...params,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN,
      "io.modelcontextprotocol/clientInfo": {
        name: "listen-e2e",
        version: "0",
      },
      "io.modelcontextprotocol/clientCapabilities": capabilities,
    },
  },
});

const listen = (id, notifications, capabilities) =>
  request(id, "subscriptions/listen", { notifications }, capabilities);

/** Asserts the -32021 refusal of a taskIds filter without the extension. */
function assertTasksRefusal(reply, id) {
  assert.equal(reply.id, id);
  assert.equal(reply.error.code, -32021);
  assert.deepEqual(reply.error.data, {
    requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
  });
}

/** Asserts a listen stream's completion result followed by its cancellation. */
function assertTeardown(messages, id) {
  const done = messages.findIndex((m) => m.id === id && m.result);
  assert.ok(
    done >= 0,
    `the listen request was answered: ${JSON.stringify(messages)}`,
  );
  assert.equal(messages[done].result.resultType, "complete");
  assert.equal(messages[done].result._meta[SUB_ID], id);
  assert.deepEqual(messages[done + 1], TEARDOWN_CANCEL(id));
}

/** The exit of a spawned server, with a guard against a hang. */
async function exitOf(child, ms = 10_000) {
  if (child.exitCode !== null) return child.exitCode;
  const timer = setTimeout(() => child.kill("SIGKILL"), ms);
  try {
    const [code] = await once(child, "exit");
    return code;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

/** Spawn the stdio entry; `next(pred)` resolves with the first match. */
function spawnStdio() {
  const child = spawn(process.execPath, [entry], {
    env: cleanEnv({ SN_TRANSPORT: "stdio" }),
    cwd: sandbox,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const received = [];
  const waiters = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let end = buffer.indexOf("\n");
    while (end !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf("\n");
      if (!line) continue;
      const message = JSON.parse(line);
      received.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.pred(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    }
  });
  const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
  const next = (pred, ms = 10_000) => {
    const seen = received.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out; got ${JSON.stringify(received)}`)),
        ms,
      );
      waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  };
  return { child, received, send, next };
}

test("listen e2e (stdio entry): a taskIds filter without the tasks extension is refused with -32021 and data.requiredCapabilities", async () => {
  const { child, received, send, next } = spawnStdio();
  try {
    send(request(1, "server/discover"));
    await next((m) => m.id === 1);
    send(listen(2, { toolsListChanged: true, taskIds: ["t-1"] }, {}));
    assertTasksRefusal(await next((m) => m.id === 2), 2);
    assert.ok(
      !received.some(
        (m) => m.method === "notifications/subscriptions/acknowledged",
      ),
      "no stream was opened",
    );
  } finally {
    child.kill("SIGTERM");
    await exitOf(child);
  }
});

test(
  "listen e2e (stdio entry): the acknowledgement comes first with the subscription ID; SIGTERM sends the completion result, then notifications/cancelled",
  { skip: process.platform === "win32" && "POSIX signals only" },
  async () => {
    const { child, received, send, next } = spawnStdio();
    try {
      send(request(1, "server/discover"));
      await next((m) => m.id === 1);
      send(listen(2, ALL_LISTS));
      const ack = await next(
        (m) => m.method === "notifications/subscriptions/acknowledged",
      );
      assert.equal(ack.params._meta[SUB_ID], 2);
      assert.deepEqual(ack.params.notifications, ALL_LISTS);
      const first = received.findIndex((m) => m.params?._meta?.[SUB_ID] === 2);
      assert.equal(received[first], ack, "nothing reached the stream first");

      child.kill("SIGTERM");
      assert.equal(await exitOf(child), 0);
      assertTeardown(received.slice(first), 2);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  },
);

// ---------------------------------------------------------------------------
// HTTP (modern leg)
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

/** Spawn the HTTP entry on a free loopback port; resolves once it serves. */
async function spawnHttp() {
  const port = await freePort();
  const child = spawn(process.execPath, [entry], {
    env: cleanEnv({
      SN_TRANSPORT: "http",
      SN_PORT: String(port),
      SN_HTTP_HOST: "127.0.0.1",
    }),
    cwd: sandbox,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const base = `http://127.0.0.1:${port}/`;
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${base}healthz`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (child.exitCode !== null || Date.now() - started > 10_000) {
      child.kill("SIGKILL");
      throw new Error("the HTTP entry did not start");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const post = (message) =>
    fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MODERN,
        "mcp-method": message.method,
      },
      body: JSON.stringify(message),
    });
  return { child, post };
}

/** Reads SSE frames off a response body as JSON-RPC messages. */
function sseReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const messages = [];
  let buffer = "";
  let ended = false;
  const pull = async () => {
    const { value, done } = await reader.read();
    if (done) {
      ended = true;
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const data = buffer
        .slice(0, end)
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");
      if (data) messages.push(JSON.parse(data));
    }
  };
  return {
    messages,
    /** Read until `count` messages arrived (or the stream ended). */
    async atLeast(count) {
      while (messages.length < count && !ended) await pull();
      return messages;
    },
    /** Read to the end of the stream. */
    async rest() {
      while (!ended) await pull();
      return messages;
    },
  };
}

test("listen e2e (HTTP entry): a taskIds filter without the tasks extension is refused with -32021 and data.requiredCapabilities", async () => {
  const { child, post } = await spawnHttp();
  try {
    const refused = await post(listen(8, { taskIds: [] }, {}));
    assert.equal(refused.status, 400);
    assertTasksRefusal(await refused.json(), 8);
  } finally {
    child.kill("SIGTERM");
    await exitOf(child);
  }
});

test(
  "listen e2e (HTTP entry): the acknowledgement comes first with the subscription ID; SIGTERM sends the completion result, then notifications/cancelled, well within the drain timeout",
  { skip: process.platform === "win32" && "POSIX signals only" },
  async () => {
    const { child, post } = await spawnHttp();
    try {
      const response = await post(listen(7, ALL_LISTS));
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /^text\/event-stream/);
      const stream = sseReader(response);
      const [ack] = await stream.atLeast(1);
      assert.equal(ack.method, "notifications/subscriptions/acknowledged");
      assert.equal(ack.params._meta[SUB_ID], 7);
      assert.deepEqual(ack.params.notifications, ALL_LISTS);

      const started = Date.now();
      child.kill("SIGTERM");
      const messages = await stream.rest();
      const code = await exitOf(child);
      const elapsed = Date.now() - started;
      assert.equal(code, 0);
      assertTeardown(messages, 7);
      // The open stream is not an in-flight request: shutdown ends it at once
      // instead of waiting out the drain, then flushes it before exiting.
      assert.ok(
        elapsed < DRAIN_TIMEOUT_MS / 2,
        `shutdown took ${elapsed} ms (drain timeout ${DRAIN_TIMEOUT_MS} ms)`,
      );
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  },
);
