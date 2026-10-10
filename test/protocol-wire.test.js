// N-35 / wire — the base-protocol rows of the 2026-07-28 conformance matrix
// (basic, lifecycle, stdio, cancellation, progress, prompts, completion),
// proved against the shipped server: buildMcpServer behind serveStdio over an
// in-memory wire wrapped by guardListenWire (the production stdio wiring), and
// build/index.js spawned for what only a real process can show (UTF-8 bytes on
// stdout, exit on stdin EOF). Raw JSON-RPC throughout, so every key, code and
// message the server emits is the test's to check.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { buildMcpServer } from "../build/server.js";
import { setServer } from "../build/mcp/context.js";
import { guardListenWire, versionRejection } from "../build/mcp/listen.js";
import { TASKS_EXTENSION } from "../build/mcp/tasks.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const MODERN = "2026-07-28";
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPS_KEY = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
const CLIENT_INFO = { name: "wire-test", version: "0" };

const envelope = (capabilities = {}, clientInfo = CLIENT_INFO) => ({
  [VERSION_KEY]: MODERN,
  ...(clientInfo === undefined ? {} : { [CLIENT_INFO_KEY]: clientInfo }),
  [CAPS_KEY]: capabilities,
});

/** A modern request; `meta` overrides or adds envelope keys. */
const request = (id, method, params = {}, options = {}) => ({
  jsonrpc: "2.0",
  id,
  method,
  params: {
    ...params,
    _meta: {
      ...params._meta,
      ...envelope(options.capabilities, options.clientInfo),
      ...options.meta,
    },
  },
});

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const replyTo = (sent, id) => sent.find((m) => m.id === id && !m.method);

/**
 * A stdio connection over an in-memory wire, wired as src/mcp/transport.ts
 * wires production: `push` delivers a client message and waits, `sent` is
 * everything the server wrote, in order. `fetch` (optional) stands in for
 * ServiceNow; the default answers one record.
 */
async function stdioConnection(fn, { env = {}, fetch } = {}) {
  return withEnv(
    { SN_PACKAGES_DENY: "", SN_PACKAGES_READONLY: "", ...env },
    async () => {
      const sent = [];
      const wire = {
        async start() {},
        async send(message) {
          sent.push(message);
        },
        async close() {
          wire.onclose?.();
        },
      };
      const errors = [];
      const runtime = freshRuntime();
      const handle = serveStdio(
        () => {
          const server = buildMcpServer(runtime);
          setServer(server);
          return server;
        },
        {
          transport: guardListenWire(wire),
          onerror: (error) => errors.push(error.message),
        },
      );
      const push = async (message, ms) => {
        wire.onmessage(message);
        await settle(ms);
      };
      const answer =
        fetch ??
        (async () =>
          jsonResponse(
            200,
            { result: [{ sys_id: "1" }] },
            {
              "X-Total-Count": "1",
            },
          ));
      try {
        await settle();
        return await withFetch(answer, (calls) =>
          fn({
            push,
            sent,
            errors,
            calls,
            close: () => handle.close(),
          }),
        );
      } finally {
        await handle.close();
        setServer(null);
      }
    },
  );
}

/**
 * One pass over the surface a client can reach without credentials: lists,
 * reads, a tool call, a prompt, a completion, a listen stream (closed at the
 * end, so its teardown is on the wire too) and every refusal the modern
 * entry has. Returns everything the server wrote.
 */
async function surfaceBattery(options = {}) {
  return stdioConnection(async ({ push, sent, close }) => {
    await push(request(1, "server/discover"));
    await push(request(2, "tools/list"));
    await push(request(3, "prompts/list"));
    await push(request(4, "resources/list"));
    await push(request(5, "resources/templates/list"));
    await push(
      request(6, "prompts/get", { name: "servicenow_instance_overview" }),
    );
    await push(
      request(7, "tools/call", {
        name: "servicenow_query_table",
        arguments: { table: "incident", limit: 1 },
      }),
      100,
    );
    await push(
      request(8, "resources/read", {
        uri: "servicenow://reference/encoded-query",
      }),
    );
    await push(
      request(9, "completion/complete", {
        ref: { type: "ref/prompt", name: "servicenow_incident_triage" },
        argument: { name: "incident", value: "INC" },
      }),
    );
    await push(
      request(10, "subscriptions/listen", {
        notifications: { toolsListChanged: true },
      }),
    );
    // Refusals: unknown names, a bad method, a broken or foreign envelope, a
    // capability the client did not declare.
    await push(request(20, "prompts/get", { name: "no_such_prompt" }));
    await push(request(21, "tools/call", { name: "no_such_tool" }));
    await push(request(22, "resources/read", { uri: "servicenow://nope" }));
    await push(request(23, "no/such/method"));
    await push({ jsonrpc: "2.0", id: 24, method: "tools/list" });
    await push(request(25, "tools/list", {}, { meta: { [CAPS_KEY]: 7 } }));
    await push(
      request(26, "tools/list", {}, { meta: { [VERSION_KEY]: "2099-01-01" } }),
    );
    await push(
      request(27, "subscriptions/listen", {
        notifications: { taskIds: ["t-1"] },
      }),
    );
    await push(
      request(28, "completion/complete", {
        ref: { type: "ref/prompt", name: "no_such_prompt" },
        argument: { name: "x", value: "" },
      }),
    );
    await close();
    await settle();
    return [...sent];
  }, options);
}

/** Every `_meta` object anywhere in a message, with its path. */
function metaObjects(value, path = "$", out = []) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => metaObjects(item, `${path}[${i}]`, out));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "_meta" && child && typeof child === "object") {
        out.push({ path: `${path}._meta`, meta: child });
      }
      metaObjects(child, `${path}.${key}`, out);
    }
  }
  return out;
}

// The _meta key grammar (basic#meta): an optional prefix of dot-separated
// labels and a slash, then a name.
const LABEL = /^[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const NAME = /^(?:[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)?$/;
const W3C_KEYS = new Set(["traceparent", "tracestate", "baggage"]);

/** Why a `_meta` key breaks the naming rules, or undefined. */
function metaKeyProblem(key, { prefixRequired = false } = {}) {
  if (W3C_KEYS.has(key)) return;
  const slash = key.lastIndexOf("/");
  if (slash === -1) {
    if (prefixRequired) return "no prefix";
    return NAME.test(key) ? undefined : "bad name";
  }
  const labels = key.slice(0, slash).split(".");
  if (!labels.every((label) => LABEL.test(label))) return "bad prefix label";
  if (!NAME.test(key.slice(slash + 1))) return "bad name";
  // Reverse DNS (base-32, SHOULD): the first label is a TLD-like label, not
  // a host name ending in one.
  if (labels.length > 1 && /^(?:com|org|net|io|dev|ai)$/.test(labels.at(-1))) {
    return "not reverse DNS";
  }
}

// W3C Trace Context level 1 and W3C Baggage.
const TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const TRACESTATE_MEMBER =
  /^(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})=[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;
const BAGGAGE_MEMBER =
  /^\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*=\s*[^\s,;\\"]*\s*(?:;.*)?$/;

/** Why a trace-context value is malformed, or undefined. */
function traceProblem(key, value) {
  if (typeof value !== "string") return "not a string";
  if (key === "traceparent") {
    return TRACEPARENT.test(value) && !/^ff-|-0{32}-|-0{16}-/.test(value)
      ? undefined
      : "bad traceparent";
  }
  const members = value.split(",").filter((m) => m.trim() !== "");
  const pattern = key === "tracestate" ? TRACESTATE_MEMBER : BAGGAGE_MEMBER;
  return members.every((m) => pattern.test(m.trim()))
    ? undefined
    : `bad ${key}`;
}

// ---------------------------------------------------------------------------
// Spawned entry
// ---------------------------------------------------------------------------

const root = join(import.meta.dirname, "..");
const entry = join(root, "build", "index.js");
const sandbox = mkdtempSync(join(tmpdir(), "sn-wire-"));
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

/**
 * Spawn the stdio entry. stdout is decoded with a fatal UTF-8 decoder, so a
 * byte sequence that is not UTF-8 fails the test; `next(pred)` resolves with
 * the first matching message.
 */
function spawnStdio() {
  const child = spawn(process.execPath, [entry], {
    env: cleanEnv({ SN_TRANSPORT: "stdio" }),
    cwd: sandbox,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const received = [];
  const waiters = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += decoder.decode(chunk, { stream: true });
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
  const send = (message) =>
    child.stdin.write(Buffer.from(JSON.stringify(message) + "\n", "utf8"));
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
// base-01, lifecycle-01 — base protocol, versioning, message patterns
// ---------------------------------------------------------------------------

test("wire: the spawned stdio entry serves the base protocol — discover, versioned requests, -32022 for an unsupported revision and a listen stream", async () => {
  const { child, received, send, next } = spawnStdio();
  try {
    send(request(1, "server/discover"));
    const discover = await next((m) => m.id === 1);
    assert.deepEqual(discover.result.supportedVersions, [MODERN]);
    assert.equal(discover.result.resultType, "complete");

    send(request(2, "tools/list"));
    const tools = await next((m) => m.id === 2);
    assert.ok(tools.result.tools.length > 0);

    send(
      request(3, "tools/list", {}, { meta: { [VERSION_KEY]: "2099-01-01" } }),
    );
    const refused = await next((m) => m.id === 3);
    assert.equal(refused.error.code, -32022);
    assert.deepEqual(refused.error.data, {
      supported: [MODERN],
      requested: "2099-01-01",
    });

    send(
      request(4, "subscriptions/listen", {
        notifications: { toolsListChanged: true },
      }),
    );
    const ack = await next(
      (m) => m.method === "notifications/subscriptions/acknowledged",
    );
    assert.equal(ack.params._meta["io.modelcontextprotocol/subscriptionId"], 4);
    assert.ok(!received.some((m) => m.id === 4), "the stream stays open");
  } finally {
    child.stdin.end();
    await exitOf(child);
  }
});

test("wire: every request naming an unsupported revision is refused with -32022 and the supported list, not only the opening one (lifecycle-01)", async () => {
  await stdioConnection(async ({ push, sent }) => {
    await push(request(1, "server/discover"));
    assert.equal(replyTo(sent, 1).result.resultType, "complete");
    for (const [id, version] of [
      [2, "2099-01-01"],
      [3, "2025-11-25"],
      [4, "2024-11-05"],
    ]) {
      await push(
        request(id, "tools/list", {}, { meta: { [VERSION_KEY]: version } }),
      );
      assert.deepEqual(replyTo(sent, id).error, {
        code: -32022,
        message: `Unsupported protocol version: ${version}`,
        data: { supported: [MODERN], requested: version },
      });
    }
    // The connection keeps serving the supported revision.
    await push(request(5, "tools/list"));
    assert.ok(replyTo(sent, 5).result.tools.length > 0);
  });
});

test("wire: versionRejection leaves claim-less (legacy) and non-string claims to the entry", () => {
  assert.equal(
    versionRejection({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    undefined,
  );
  assert.equal(
    versionRejection(
      request(1, "tools/list", {}, { meta: { [VERSION_KEY]: 7 } }),
    ),
    undefined,
  );
  assert.equal(versionRejection(request(1, "tools/list")), undefined);
  assert.equal(
    versionRejection({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1, _meta: { [VERSION_KEY]: "2099-01-01" } },
    }),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// base-05/54, base-06, base-39, lifecycle-07 — every result
// ---------------------------------------------------------------------------

test("wire: every result carries resultType and names the server in _meta serverInfo", async () => {
  const sent = await surfaceBattery();
  const results = sent.filter((m) => "result" in m);
  assert.ok(results.length >= 10, `results seen: ${results.length}`);
  for (const m of results) {
    assert.equal(
      typeof m.result.resultType,
      "string",
      `resultType on ${JSON.stringify(m).slice(0, 120)}`,
    );
    const info = m.result._meta?.[SERVER_INFO_KEY];
    assert.equal(info?.name, "servicenow-mcp-ai", `serverInfo on id ${m.id}`);
    assert.equal(typeof info.version, "string");
  }
});

test("wire: resultType values come from the core set, plus task only while the tasks extension is advertised", async () => {
  const core = new Set(["complete", "input_required"]);
  for (const tasks of [false, true]) {
    const sent = await surfaceBattery({
      env: { SN_EXPERIMENTAL_TASKS: tasks ? "true" : "" },
    });
    const discover = replyTo(sent, 1).result;
    const advertised = Object.hasOwn(
      discover.capabilities.extensions ?? {},
      TASKS_EXTENSION,
    );
    assert.equal(advertised, tasks, `tasks extension advertised: ${tasks}`);
    const allowed = new Set([...core, ...(advertised ? ["task"] : [])]);
    for (const m of sent.filter((x) => "result" in x)) {
      assert.ok(
        allowed.has(m.result.resultType),
        `${m.result.resultType} (id ${m.id}) with tasks=${tasks}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// base-10, base-11 — notifications
// ---------------------------------------------------------------------------

test("wire: client notifications get no response, whatever they carry", async () => {
  await stdioConnection(async ({ push, sent }) => {
    await push(request(1, "server/discover"));
    const before = sent.length;
    const notes = [
      { method: "notifications/cancelled", params: { requestId: 999 } },
      { method: "notifications/initialized" },
      {
        method: "notifications/progress",
        params: { progressToken: "x", progress: 1 },
      },
      {
        method: "notifications/roots/list_changed",
        params: { _meta: envelope() },
      },
      { method: "notifications/no_such_thing", params: { _meta: envelope() } },
      {
        method: "notifications/cancelled",
        params: { _meta: { [VERSION_KEY]: "2099-01-01" } },
      },
    ];
    for (const note of notes) await push({ jsonrpc: "2.0", ...note });
    assert.deepEqual(sent.slice(before), []);
  });
});

test("wire: no notification the server sends carries an id", async () => {
  const sent = await surfaceBattery();
  const notes = sent.filter((m) => m.method !== undefined);
  assert.ok(
    notes.some((m) => m.method === "notifications/subscriptions/acknowledged"),
    "the battery produced server notifications",
  );
  for (const m of notes) {
    assert.ok(!("id" in m), `${m.method} has no id`);
  }
});

// ---------------------------------------------------------------------------
// base-12, base-55 — stateless serving
// ---------------------------------------------------------------------------

test("wire: requests after discover still need their own envelope; nothing carries over from earlier requests", async () => {
  await stdioConnection(async ({ push, sent }) => {
    await push(request(1, "server/discover"));
    await push(request(2, "tools/list"));
    assert.ok(replyTo(sent, 2).result);
    await push({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    assert.equal(replyTo(sent, 3).error.code, -32602);
    await push({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/list",
      params: { _meta: { [VERSION_KEY]: MODERN } },
    });
    assert.equal(
      replyTo(sent, 4).error.code,
      -32602,
      "capabilities are per request",
    );
  });
});

test("wire: client capabilities are read from each request, never inferred from a prior one", async () => {
  await stdioConnection(async ({ push, sent }) => {
    const withTasks = { extensions: { [TASKS_EXTENSION]: {} } };
    await push(
      request(
        1,
        "subscriptions/listen",
        {
          notifications: { toolsListChanged: true, taskIds: [] },
        },
        { capabilities: withTasks },
      ),
    );
    assert.ok(
      sent.some(
        (m) =>
          m.method === "notifications/subscriptions/acknowledged" &&
          m.params._meta["io.modelcontextprotocol/subscriptionId"] === 1,
      ),
      "a declaring request is served",
    );
    await push(
      request(2, "subscriptions/listen", {
        notifications: { toolsListChanged: true, taskIds: [] },
      }),
    );
    assert.equal(replyTo(sent, 2).error.code, -32021);
    // And the other way round: a refusal does not stick either.
    await push(
      request(
        3,
        "subscriptions/listen",
        {
          notifications: { toolsListChanged: true, taskIds: [] },
        },
        { capabilities: withTasks },
      ),
    );
    assert.equal(
      replyTo(sent, 3),
      undefined,
      "the stream is open, not refused",
    );
  });
});

// ---------------------------------------------------------------------------
// base-29, base-40 — reserved keys and client identity
// ---------------------------------------------------------------------------

test("wire: unknown reserved _meta keys and extra clientInfo fields are tolerated, not interpreted", async () => {
  await stdioConnection(async ({ push, sent }) => {
    await push(
      request(
        1,
        "tools/list",
        {},
        {
          clientInfo: { name: "x", version: "9", vendor: { odd: [1, 2] } },
          meta: {
            "io.modelcontextprotocol/futureThing": { any: "value" },
            "io.modelcontextprotocol/future-flag": "not-an-object-either",
            "com.example/flag": true,
          },
        },
      ),
    );
    await push(request(2, "tools/list"));
    const odd = replyTo(sent, 1).result;
    assert.ok(odd, JSON.stringify(replyTo(sent, 1)));
    assert.deepEqual(odd, replyTo(sent, 2).result);
  });
});

test("wire: a different or absent clientInfo changes no result", async () => {
  const runs = [];
  for (const clientInfo of [
    CLIENT_INFO,
    { name: "claude-code", version: "99.0.0", title: "Admin" },
    undefined,
  ]) {
    runs.push(
      await stdioConnection(async ({ push, sent }) => {
        await push(request(1, "server/discover", {}, { clientInfo }));
        await push(request(2, "tools/list", {}, { clientInfo }));
        await push(request(3, "prompts/list", {}, { clientInfo }));
        await push(request(4, "resources/list", {}, { clientInfo }));
        await push(
          request(
            5,
            "tools/call",
            {
              name: "servicenow_query_table",
              arguments: { table: "incident", limit: 1 },
            },
            { clientInfo },
          ),
          100,
        );
        return [...sent];
      }),
    );
  }
  assert.deepEqual(runs[1], runs[0]);
  assert.deepEqual(runs[2], runs[0]);
});

// ---------------------------------------------------------------------------
// base-30/31/32/33, lifecycle-03 — _meta key and extension identifier names
// ---------------------------------------------------------------------------

test("wire: every _meta key the server emits follows the naming rules", async () => {
  const sent = await surfaceBattery({ env: { SN_EXPERIMENTAL_TASKS: "true" } });
  const seen = new Set();
  for (const message of sent) {
    for (const { path, meta } of metaObjects(message)) {
      for (const key of Object.keys(meta)) {
        seen.add(key);
        assert.equal(metaKeyProblem(key), undefined, `${key} at ${path}`);
      }
    }
  }
  assert.ok(seen.has(SERVER_INFO_KEY), [...seen].join(", "));
  assert.ok(seen.has("io.modelcontextprotocol/subscriptionId"));
});

test("wire: advertised extension identifiers carry a valid, mandatory prefix", async () => {
  await stdioConnection(
    async ({ push, sent }) => {
      await push(request(1, "server/discover"));
      const extensions = replyTo(sent, 1).result.capabilities.extensions;
      assert.ok(extensions && Object.keys(extensions).length > 0);
      for (const id of Object.keys(extensions)) {
        assert.equal(
          metaKeyProblem(id, { prefixRequired: true }),
          undefined,
          id,
        );
      }
    },
    { env: { SN_EXPERIMENTAL_TASKS: "true" } },
  );
});

test("wire: the _meta key checker rejects what the rules forbid", () => {
  for (const bad of [
    "example.com/x", // not reverse DNS
    "1io/x", // label starts with a digit
    "io-/x", // label ends with a hyphen
    "io..x/y", // empty label
    "io/-x", // name starts with a hyphen
    "io/x.", // name ends with a dot
    "-x",
  ]) {
    assert.notEqual(metaKeyProblem(bad), undefined, bad);
  }
  assert.notEqual(metaKeyProblem("tasks", { prefixRequired: true }), undefined);
  for (const good of [
    "io.modelcontextprotocol/serverInfo",
    "com.example/a_b.c",
    "x",
    "io/",
    "traceparent",
  ]) {
    assert.equal(metaKeyProblem(good), undefined, good);
  }
});

// ---------------------------------------------------------------------------
// base-34 — missing required fields
// ---------------------------------------------------------------------------

test("wire: a request missing a required field is refused with -32602", async () => {
  await stdioConnection(async ({ push, sent }) => {
    // A modern request pins the connection; right after discover alone a
    // claim-less request is the legacy fallback the probe allows.
    await push(request(1, "tools/list"));
    const cases = [
      { jsonrpc: "2.0", id: 2, method: "tools/list" }, // no _meta envelope
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: { _meta: { [CAPS_KEY]: {} } },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/list",
        params: { _meta: { [VERSION_KEY]: MODERN } },
      },
      request(5, "tools/call", { arguments: {} }), // no name
      request(6, "prompts/get", {}), // no name
      request(7, "resources/read", {}), // no uri
      request(8, "completion/complete", { argument: { name: "x", value: "" } }), // no ref
    ];
    for (const message of cases) await push(message);
    for (const { id } of cases) {
      const error = replyTo(sent, id)?.error;
      assert.equal(
        error?.code,
        -32602,
        `id ${id}: ${JSON.stringify(replyTo(sent, id))}`,
      );
      // errors-07: one line, not a validator dump.
      assert.doesNotMatch(error.message, /\n/, `id ${id}: ${error.message}`);
      assert.ok(error.message.length <= 200, `id ${id}: ${error.message}`);
    }
  });
});

// ---------------------------------------------------------------------------
// base-42 — W3C trace context
// ---------------------------------------------------------------------------

test("wire: trace-context keys are accepted from the client and any the server emits follow the W3C formats", async () => {
  await stdioConnection(async ({ push, sent }) => {
    await push(
      request(
        1,
        "tools/call",
        {
          name: "servicenow_query_table",
          arguments: { table: "incident", limit: 1 },
        },
        {
          meta: {
            traceparent:
              "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            tracestate: "rojo=00f067aa0ba902b7,congo=t61rcWkgMzE",
            baggage: "userId=alice,serverNode=DF%2028",
          },
        },
      ),
      100,
    );
    assert.ok(replyTo(sent, 1).result, JSON.stringify(replyTo(sent, 1)));
    for (const message of sent) {
      for (const { path, meta } of metaObjects(message)) {
        for (const key of W3C_KEYS) {
          if (key in meta) {
            assert.equal(
              traceProblem(key, meta[key]),
              undefined,
              `${key} at ${path}`,
            );
          }
        }
      }
    }
  });
  // The checker itself.
  assert.equal(
    traceProblem(
      "traceparent",
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    ),
    undefined,
  );
  assert.notEqual(traceProblem("traceparent", "00-0af7-b7ad-01"), undefined);
  assert.notEqual(
    traceProblem(
      "traceparent",
      "00-00000000000000000000000000000000-b7ad6b7169203331-01",
    ),
    undefined,
  );
  assert.equal(traceProblem("tracestate", "vendor@tenant=v1"), undefined);
  assert.notEqual(traceProblem("tracestate", "Bad Key=v"), undefined);
  assert.equal(traceProblem("baggage", "k=v;prop, k2=v2"), undefined);
  assert.notEqual(traceProblem("baggage", "no equals"), undefined);
});

// ---------------------------------------------------------------------------
// base-45 — UTF-8
// ---------------------------------------------------------------------------

test("wire: the spawned stdio entry reads and writes UTF-8 — non-ASCII text survives the round trip byte-exact", async () => {
  const { child, send, next } = spawnStdio();
  const name = "prompt-ünïcødé-日本語-🙂";
  try {
    send(
      request(
        1,
        "server/discover",
        {},
        { clientInfo: { name: "клиент", version: "1" } },
      ),
    );
    assert.equal((await next((m) => m.id === 1)).result.resultType, "complete");
    send(request(2, "prompts/get", { name }));
    const refused = await next((m) => m.id === 2);
    assert.equal(refused.error.code, -32602);
    assert.ok(refused.error.message.includes(name), refused.error.message);
    send(request(3, "tools/list"));
    const tools = await next((m) => m.id === 3);
    // The tool catalogue itself carries non-ASCII (em dashes, arrows).
    assert.ok(
      [...JSON.stringify(tools.result)].some((c) => c.codePointAt(0) > 0x7f),
    );
  } finally {
    child.stdin.end();
    await exitOf(child);
  }
});

// ---------------------------------------------------------------------------
// errors-03, errors-04, errors-07 — error codes and messages
// ---------------------------------------------------------------------------

const JSONRPC_DEFINED = new Set([-32700, -32600, -32601, -32602, -32603]);
const MCP_DEFINED = new Set([-32020, -32021, -32022]);

test("wire: emitted error codes in the reserved ranges are defined ones, used with their meanings", async () => {
  const sent = await surfaceBattery({ env: { SN_EXPERIMENTAL_TASKS: "true" } });
  const errors = sent.filter((m) => m.error);
  assert.ok(errors.length >= 8, `errors seen: ${errors.length}`);
  const codes = new Set();
  for (const { id, error } of errors) {
    codes.add(error.code);
    assert.ok(Number.isInteger(error.code), `id ${id}`);
    if (error.code >= -32768 && error.code <= -32000) {
      assert.ok(
        JSONRPC_DEFINED.has(error.code) || MCP_DEFINED.has(error.code),
        `id ${id}: ${error.code} is not a defined code`,
      );
    }
    if (error.code === -32022) {
      assert.ok(
        Array.isArray(error.data?.supported) &&
          typeof error.data.requested === "string",
      );
    }
    if (error.code === -32021) {
      assert.equal(typeof error.data?.requiredCapabilities, "object");
    }
    assert.notEqual(error.code, -32002, "the removed resource-not-found code");
    assert.notEqual(error.code, -32042, "the removed URL-elicitation code");
  }
  for (const expected of [-32601, -32602, -32021, -32022]) {
    assert.ok(codes.has(expected), `${expected} among ${[...codes]}`);
  }
});

test("wire: src emits no code from the MCP reserved sub-range other than -32020, -32021 and -32022", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) files.push(path);
    }
  };
  walk(join(root, "src"));
  const reserved = /-320[2-9]\d\b|-3209\d\b/g;
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").match(reserved) ?? []) {
      assert.ok(MCP_DEFINED.has(Number(match)), `${match} in ${file}`);
    }
  }
});

test("wire: error messages are one concise sentence on a single line", async () => {
  const sent = await surfaceBattery();
  for (const { id, error } of sent.filter((m) => m.error)) {
    const message = error.message;
    assert.equal(typeof message, "string");
    assert.ok(!message.includes("\n"), `id ${id}: ${message}`);
    assert.ok(message.length <= 200, `id ${id}: ${message.length} chars`);
    const sentences = message.split(/[.!?]\s+(?=[A-Z])/).length;
    assert.equal(sentences, 1, `id ${id}: ${message}`);
  }
});

// ---------------------------------------------------------------------------
// stdio-05, cancel-02, cancel-10, progress-06 — cancellation and progress
// ---------------------------------------------------------------------------

/** ServiceNow that never answers table "hang" until the request aborts. */
function hangingFetch(aborted) {
  return async (url, init) => {
    if (String(url).includes("/hang")) {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted.push(String(url));
          reject(init.signal.reason);
        });
      });
    }
    return jsonResponse(
      200,
      { result: [{ sys_id: "1" }] },
      { "X-Total-Count": "1" },
    );
  };
}

test("wire: a cancelled request stops its ServiceNow call and gets no further message — no result, error or progress", async () => {
  const aborted = [];
  await stdioConnection(
    async ({ push, sent }) => {
      await push(request(1, "server/discover"));
      await push(
        request(2, "tools/call", {
          name: "servicenow_query_table",
          arguments: { table: "hang" },
          _meta: { progressToken: "p2" },
        }),
        100,
      );
      const at = sent.length;
      await push(
        {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 2, reason: "user" },
        },
        300,
      );
      const after = sent.slice(at);
      assert.ok(!after.some((m) => m.id === 2), JSON.stringify(after));
      assert.ok(!after.some((m) => m.params?.progressToken === "p2"));
      assert.ok(!sent.some((m) => m.id === 2), "never answered");
      assert.ok(aborted.length > 0, "the outbound call was aborted");
      // The connection still serves.
      await push(request(3, "tools/list"));
      assert.ok(replyTo(sent, 3).result);
    },
    { fetch: hangingFetch(aborted) },
  );
});

test("wire: the server sends notifications/cancelled only to close a listen stream it ended", async () => {
  const sent = await surfaceBattery();
  const cancels = sent.filter((m) => m.method === "notifications/cancelled");
  assert.deepEqual(
    cancels.map((m) => m.params.requestId),
    [10],
    "only the open listen stream (id 10) is cancelled, on teardown",
  );
  const done = sent.findIndex((m) => m.id === 10 && m.result);
  assert.equal(
    sent[done + 1],
    cancels[0],
    "and only after its completion result",
  );
});

test("wire: invalid cancellations are ignored and the server keeps serving", async () => {
  const aborted = [];
  await stdioConnection(
    async ({ push, sent, errors }) => {
      await push(request(1, "server/discover"));
      await push(
        request(2, "tools/call", {
          name: "servicenow_query_table",
          arguments: { table: "hang" },
        }),
        100,
      );
      const before = sent.length;
      for (const params of [
        { requestId: 999 }, // unknown
        { requestId: 1 }, // already completed
        {}, // malformed: no requestId
        { requestId: { not: "an id" } }, // malformed: bad type
        undefined, // malformed: no params
      ]) {
        await push({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          ...(params ? { params } : {}),
        });
      }
      assert.deepEqual(sent.slice(before), [], "no reply to any of them");
      assert.deepEqual(aborted, [], "the in-flight request was not touched");
      assert.deepEqual(errors, []);
      await push(request(3, "tools/list"));
      assert.ok(replyTo(sent, 3).result);
      await push(
        {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 2 },
        },
        100,
      );
      assert.equal(aborted.length, 1, "a valid cancellation still works");
    },
    { fetch: hangingFetch(aborted) },
  );
});

test("wire: progress notifications for a request stop once it is answered", async () => {
  await stdioConnection(async ({ push, sent }) => {
    await push(request(1, "server/discover"));
    await push(
      request(2, "tools/call", {
        name: "servicenow_query_table",
        arguments: { table: "incident", fetchAll: true },
        _meta: { progressToken: "p2" },
      }),
      300,
    );
    await settle(200);
    const done = sent.findIndex((m) => m.id === 2);
    assert.ok(done >= 0 && sent[done].result, JSON.stringify(sent.at(-1)));
    const progress = sent
      .map((m, i) => ({ m, i }))
      .filter(
        ({ m }) =>
          m.method === "notifications/progress" &&
          m.params.progressToken === "p2",
      );
    assert.ok(progress.length > 0, "the request reported progress");
    assert.ok(
      progress.every(({ i }) => i < done),
      "none after the result",
    );
  });
});

// ---------------------------------------------------------------------------
// stdio-06 — exit on stdin EOF
// ---------------------------------------------------------------------------

test("wire: the spawned stdio entry exits promptly once stdin is closed", async () => {
  const { child, send, next } = spawnStdio();
  send(request(1, "server/discover"));
  await next((m) => m.id === 1);
  const start = Date.now();
  child.stdin.end();
  const code = await exitOf(child, 10_000);
  const elapsed = Date.now() - start;
  assert.equal(code, 0, `exit code ${code}`);
  assert.ok(elapsed < 3_000, `exited after ${elapsed} ms`);
});

// ---------------------------------------------------------------------------
// prompts-08, prompts-10, completion-02
// ---------------------------------------------------------------------------

test("wire: prompts/get answers -32602 for an unknown prompt and for missing required arguments", async () => {
  await stdioConnection(async ({ push, sent }) => {
    await push(request(1, "prompts/get", { name: "no_such_prompt" }));
    await push(
      request(2, "prompts/get", {
        name: "servicenow_incident_triage",
        arguments: {},
      }),
    );
    await push(
      request(3, "prompts/get", { name: "servicenow_incident_triage" }),
    );
    for (const id of [1, 2, 3]) {
      assert.equal(
        replyTo(sent, id).error?.code,
        -32602,
        JSON.stringify(replyTo(sent, id)),
      );
    }
    await push(
      request(4, "prompts/get", {
        name: "servicenow_incident_triage",
        arguments: { incident: "INC0010001" },
      }),
    );
    assert.equal(replyTo(sent, 4).result.resultType, "complete");
  });
});

test("wire: prompts are advertised and served to a client that declares no capabilities", async () => {
  await stdioConnection(async ({ push, sent }) => {
    await push(request(1, "server/discover", {}, { capabilities: {} }));
    assert.ok(replyTo(sent, 1).result.capabilities.prompts);
    await push(request(2, "prompts/list", {}, { capabilities: {} }));
    const prompts = replyTo(sent, 2).result.prompts;
    assert.ok(prompts.some((p) => p.name === "servicenow_instance_overview"));
    await push(
      request(
        3,
        "prompts/get",
        { name: "servicenow_instance_overview" },
        { capabilities: {} },
      ),
    );
    assert.ok(replyTo(sent, 3).result.messages.length > 0);
  });
});

test("wire: completion/complete answers -32602 for an unknown prompt and for a missing argument", async () => {
  await stdioConnection(async ({ push, sent }) => {
    await push(
      request(1, "completion/complete", {
        ref: { type: "ref/prompt", name: "no_such_prompt" },
        argument: { name: "x", value: "" },
      }),
    );
    await push(
      request(2, "completion/complete", {
        ref: { type: "ref/prompt", name: "servicenow_incident_triage" },
      }),
    );
    await push(
      request(3, "completion/complete", {
        ref: { type: "ref/resource", uri: "servicenow://no-such-template/{x}" },
        argument: { name: "x", value: "" },
      }),
    );
    for (const id of [1, 2]) {
      assert.equal(
        replyTo(sent, id).error?.code,
        -32602,
        JSON.stringify(replyTo(sent, id)),
      );
    }
    const resource = replyTo(sent, 3);
    assert.ok(
      resource.error?.code === -32602 || resource.result?.completion,
      JSON.stringify(resource),
    );
    await push(
      request(4, "completion/complete", {
        ref: { type: "ref/prompt", name: "servicenow_incident_triage" },
        argument: { name: "incident", value: "INC" },
      }),
    );
    assert.equal(replyTo(sent, 4).result.resultType, "complete");
  });
});
