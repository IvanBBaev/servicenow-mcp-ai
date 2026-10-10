// N-35 / listen — subscriptions/listen on the 2026-07-28 wire, driven through
// the real server factory (buildMcpServer) behind both SDK entries: serveStdio
// over an in-memory wire wrapped by guardListenWire, and createMcpHandler with
// its fetch wrapped by guardListenFetch. Raw JSON-RPC, so the order and the
// _meta of every message on the wire are the test's to check. The legacy
// (2025) wire has no listen; dynamic-packages.test.js keeps covering its
// list_changed notifications unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { buildMcpServer } from "../build/server.js";
import { setServer } from "../build/mcp/context.js";
import {
  TASKS_EXTENSION,
  guardListenFetch,
  guardListenWire,
  listenRejection,
  listenTeardownCancel,
} from "../build/mcp/listen.js";
import { baselineEnv, freshRuntime, withEnv } from "./helpers.js";

baselineEnv();

const MODERN = "2026-07-28";
const SUB_ID = "io.modelcontextprotocol/subscriptionId";
const ALL_LISTS = {
  toolsListChanged: true,
  promptsListChanged: true,
  resourcesListChanged: true,
};
const TASKS_CAPS = { extensions: { [TASKS_EXTENSION]: {} } };

const envelope = (capabilities = {}) => ({
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "listen-test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": capabilities,
});

const request = (id, method, params = {}, capabilities) => ({
  jsonrpc: "2.0",
  id,
  method,
  params: { ...params, _meta: { ...params._meta, ...envelope(capabilities) } },
});

const listen = (id, notifications, capabilities) =>
  request(id, "subscriptions/listen", { notifications }, capabilities);

const LIST_CHANGED = {
  tools: "sendToolListChanged",
  prompts: "sendPromptListChanged",
  resources: "sendResourceListChanged",
};
const ALL_KINDS = Object.keys(LIST_CHANGED);

const isNote = (m) => m.method !== undefined && m.id === undefined;
const subIdOf = (m) => m.params?._meta?.[SUB_ID] ?? m.result?._meta?.[SUB_ID];
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/**
 * A stdio connection over an in-memory wire: `push` delivers a client
 * message, `sent` is everything the server wrote, in order, and `changed`
 * announces list changes from the serving instance. On this wire the lists
 * are fixed per server (O-19 d: enable/disable_package refuse), so the test
 * raises them the way any server-side change would, through the instance.
 */
async function stdioConnection(fn) {
  return withEnv(
    { SN_PACKAGES_DENY: "", SN_PACKAGES_READONLY: "" },
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
      let server;
      const handle = serveStdio(
        () => {
          server = buildMcpServer(runtime);
          setServer(server);
          return server;
        },
        {
          transport: guardListenWire(wire),
          onerror: (error) => errors.push(error.message),
        },
      );
      const push = async (message) => {
        wire.onmessage(message);
        await settle();
      };
      const changed = async (...kinds) => {
        for (const kind of kinds) await server.server[LIST_CHANGED[kind]]();
        await settle();
      };
      try {
        await settle();
        // The opening request pins the modern era.
        await push(request(1, "server/discover"));
        return await fn({
          push,
          sent,
          changed,
          close: () => handle.close(),
          errors,
        });
      } finally {
        await handle.close();
        setServer(null);
      }
    },
  );
}

/** The messages of one subscription, in wire order. */
const onStream = (sent, id) => sent.filter((m) => subIdOf(m) === id);

test("listen (stdio): the acknowledgement comes first and every stream notification carries the subscription ID", async () => {
  await stdioConnection(async ({ push, sent, changed }) => {
    await push(listen(2, ALL_LISTS));
    const from = sent.length;
    await changed(...ALL_KINDS);
    const listenStart = sent.findIndex(
      (m) => m.method === "notifications/subscriptions/acknowledged",
    );
    assert.ok(listenStart >= 0, "an acknowledgement was sent");
    const ack = sent[listenStart];
    assert.equal(ack.params._meta[SUB_ID], 2);
    assert.deepEqual(ack.params.notifications, ALL_LISTS);
    // Nothing reached the subscription before its acknowledgement.
    assert.equal(
      sent.slice(0, listenStart).filter((m) => subIdOf(m) === 2).length,
      0,
    );
    const notes = sent.slice(from).filter(isNote);
    assert.ok(notes.length >= 3, JSON.stringify(notes));
    for (const note of notes) {
      assert.equal(note.params?._meta?.[SUB_ID], 2, JSON.stringify(note));
    }
  });
});

test("listen (stdio): only the requested notification types reach the stream", async () => {
  await stdioConnection(async ({ push, sent, changed }) => {
    await push(listen(2, { toolsListChanged: true }));
    await changed(...ALL_KINDS);
    const methods = sent.filter(isNote).map((m) => m.method);
    assert.ok(methods.includes("notifications/tools/list_changed"));
    assert.equal(
      onStream(sent, 2).filter((m) => m.method.endsWith("list_changed")).length,
      1,
    );
    assert.ok(
      !methods.includes("notifications/prompts/list_changed"),
      methods.join(),
    );
    assert.ok(
      !methods.includes("notifications/resources/list_changed"),
      methods.join(),
    );
  });
});

test("listen (stdio): tools, prompts and resources list_changed reach an open stream", async () => {
  await stdioConnection(async ({ push, sent, changed }) => {
    await push(listen(2, ALL_LISTS));
    await changed(...ALL_KINDS);
    const methods = onStream(sent, 2).map((m) => m.method);
    for (const kind of ["tools", "prompts", "resources"]) {
      assert.ok(
        methods.includes(`notifications/${kind}/list_changed`),
        `${kind}: ${methods.join()}`,
      );
    }
  });
});

test("listen (stdio): shutdown answers the listen request with a completion result, then cancels it", async () => {
  await stdioConnection(async ({ push, sent, changed, close }) => {
    await push(listen(2, ALL_LISTS));
    await changed("tools");
    await close();
    const done = sent.findIndex((m) => m.id === 2 && m.result);
    assert.ok(done >= 0, "the listen request was answered");
    assert.equal(sent[done].result.resultType, "complete");
    assert.equal(sent[done].result._meta[SUB_ID], 2);
    assert.equal(
      sent[done].result._meta["io.modelcontextprotocol/serverInfo"].name,
      "servicenow-mcp-ai",
    );
    assert.deepEqual(sent[done + 1], {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 2, reason: "Subscription closed by the server." },
    });
    // Every server-sent cancellation references a listen request.
    const cancels = sent.filter((m) => m.method === "notifications/cancelled");
    assert.deepEqual(
      cancels.map((m) => m.params.requestId),
      [2],
    );
  });
});

test("listen (stdio): a taskIds filter without the tasks extension is refused with -32021", async () => {
  await stdioConnection(async ({ push, sent }) => {
    await push(listen(2, { toolsListChanged: true, taskIds: ["t-1"] }, {}));
    const reply = sent.find((m) => m.id === 2);
    assert.deepEqual(reply.error.code, -32021);
    assert.deepEqual(reply.error.data, {
      requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
    });
    assert.ok(
      !sent.some(
        (m) => m.method === "notifications/subscriptions/acknowledged",
      ),
      "no stream was opened",
    );
  });
});

test("listen (stdio): a declaring client's taskIds filter is honoured as empty", async () => {
  await stdioConnection(async ({ push, sent, close }) => {
    await push(listen(2, { taskIds: ["t-1"] }, TASKS_CAPS));
    const ack = sent.find(
      (m) => m.method === "notifications/subscriptions/acknowledged",
    );
    assert.deepEqual(ack.params.notifications, {});
    assert.ok(!sent.some((m) => m.id === 2 && m.error), "not refused");
    // Nothing honoured: the stdio stream idles until the server ends it.
    await close();
    const done = sent.find((m) => m.id === 2);
    assert.equal(done.result.resultType, "complete");
  });
});

test("listen (stdio): no notifications/progress or notifications/message travel on a listen stream", async () => {
  await stdioConnection(async ({ push, sent, changed }) => {
    await push(listen(2, { ...ALL_LISTS, taskIds: [] }, TASKS_CAPS));
    await changed(...ALL_KINDS);
    await push(
      request(3, "tools/call", {
        name: "servicenow_find_tools",
        arguments: { query: "lint a script" },
        _meta: {
          progressToken: "p-1",
          "io.modelcontextprotocol/logLevel": "debug",
        },
      }),
    );
    const stream = onStream(sent, 2).map((m) => m.method);
    assert.ok(stream.length > 1, "the stream is live");
    assert.ok(!stream.includes("notifications/progress"), stream.join());
    assert.ok(!stream.includes("notifications/message"), stream.join());
  });
});

/** A modern HTTP handler over buildMcpServer, its fetch wrapped. */
function httpHandler() {
  const runtime = freshRuntime();
  const handler = createMcpHandler(() => buildMcpServer(runtime), {
    legacy: "reject",
    onerror: () => {},
  });
  const fetch = guardListenFetch(handler.fetch);
  const post = (message) =>
    fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MODERN,
          "mcp-method": message.method,
        },
        body: JSON.stringify(message),
      }),
    );
  return { post, close: () => handler.close() };
}

/** Every JSON-RPC message of an SSE body, once the stream ends. */
async function sseMessages(response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((frame) =>
      frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join(""),
    )
    .filter(Boolean)
    .map((data) => JSON.parse(data));
}

test("listen (HTTP): acknowledgement first, then on shutdown a completion result and its cancellation", async () => {
  const { post, close } = httpHandler();
  const response = await post(listen(7, ALL_LISTS));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  const messages = sseMessages(response);
  await settle();
  await close();
  const frames = await messages;
  assert.equal(frames[0].method, "notifications/subscriptions/acknowledged");
  assert.equal(frames[0].params._meta[SUB_ID], 7);
  assert.equal(frames.at(-2).id, 7);
  assert.equal(frames.at(-2).result.resultType, "complete");
  assert.equal(frames.at(-2).result._meta[SUB_ID], 7);
  assert.deepEqual(frames.at(-1), {
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 7, reason: "Subscription closed by the server." },
  });
  for (const frame of frames.filter(isNote)) {
    if (frame.method === "notifications/cancelled") continue;
    assert.equal(frame.params._meta[SUB_ID], 7, JSON.stringify(frame));
  }
});

test("listen (HTTP): a taskIds filter is refused with -32021 without the tasks extension and honoured as empty with it", async () => {
  const { post, close } = httpHandler();
  try {
    const refused = await post(listen(8, { taskIds: [] }, {}));
    assert.equal(refused.status, 400);
    const body = await refused.json();
    assert.equal(body.id, 8);
    assert.equal(body.error.code, -32021);
    assert.deepEqual(body.error.data, {
      requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
    });
    const honoured = await post(listen(9, { taskIds: ["t-1"] }, TASKS_CAPS));
    const frames = await sseMessages(honoured);
    assert.deepEqual(frames[0].params.notifications, {});
    assert.equal(frames[1].result.resultType, "complete");
    assert.equal(frames[2].method, "notifications/cancelled");
  } finally {
    await close();
  }
});

test("listen guards: other messages, legacy (claim-less) requests and ordinary results pass untouched", () => {
  const legacyListen = {
    jsonrpc: "2.0",
    id: 1,
    method: "subscriptions/listen",
    params: { notifications: { taskIds: [] } },
  };
  assert.equal(listenRejection(legacyListen), undefined);
  assert.equal(listenRejection(listen(1, ALL_LISTS, {})), undefined);
  assert.equal(
    listenRejection(
      request(1, "tools/list", { notifications: { taskIds: [] } }),
    ),
    undefined,
  );
  assert.equal(listenRejection(undefined), undefined);
  assert.equal(
    listenTeardownCancel({ jsonrpc: "2.0", id: 1, result: {} }),
    undefined,
  );
  assert.equal(
    listenTeardownCancel({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
      params: { _meta: { [SUB_ID]: 1 } },
    }),
    undefined,
  );
});
