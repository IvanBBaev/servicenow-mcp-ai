// N-81 — the private SDK members this server reaches into. Each one is a
// seam the typed surface does not offer: `Protocol._requestHandlers`
// (lean-list.ts, tasks.ts wrap tools/list and tools/call),
// `McpServer._registeredTools` (tasks.ts reads the enable state) and
// `Server.isMessageIgnored` (log-bridge.ts honours logging/setLevel). An SDK
// minor that renames one of them fails here, by name, before the feature
// built on it degrades quietly.
import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

import { setLogSink } from "../build/core/logging.js";
import { wireModernTasks } from "../build/mcp/tasks.js";
import { baselineEnv, freshRuntime, withEnv } from "./helpers.js";

baselineEnv();

/** A bare McpServer with one tool, so the tools/* handlers are installed. */
function probeServer() {
  const server = new McpServer({ name: "probe", version: "0.0.0" });
  server.registerTool(
    "probe_tool",
    { description: "probe", inputSchema: z.object({}) },
    () => ({ content: [{ type: "text", text: "ok" }] }),
  );
  return server;
}

/** Run `fn` and return the error-level log lines it produced. */
async function errorLines(fn) {
  const lines = [];
  setLogSink((level, message) => {
    if (level === "error") lines.push(message);
  });
  try {
    await fn();
  } finally {
    setLogSink(null);
  }
  return lines;
}

test("Protocol._requestHandlers is a Map holding the tools/* handlers", () => {
  const handlers = probeServer().server._requestHandlers;
  assert.ok(handlers instanceof Map, "_requestHandlers is a Map");
  for (const method of ["tools/list", "tools/call"]) {
    assert.equal(typeof handlers.get(method), "function", method);
  }
});

test("McpServer._registeredTools maps a tool name to an entry with `enabled`", () => {
  const server = probeServer();
  const entry = server._registeredTools?.probe_tool;
  assert.ok(entry, "the registered tool is there by name");
  assert.equal(entry.enabled, true);
  server._registeredTools.probe_tool.disable();
  assert.equal(server._registeredTools.probe_tool.enabled, false);
});

test("Server.isMessageIgnored is a (level, sessionId) predicate", () => {
  const { server } = probeServer();
  assert.equal(typeof server.isMessageIgnored, "function");
  assert.equal(typeof server.isMessageIgnored("debug", undefined), "boolean");
});

test("wireModernTasks logs an error when the handler table is missing", async () => {
  const runtime = freshRuntime();
  const lines = await withEnv({ SN_EXPERIMENTAL_TASKS: "1" }, () =>
    errorLines(() => {
      const server = probeServer();
      server.server._requestHandlers = undefined;
      wireModernTasks(server, runtime);
    }),
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /_requestHandlers/);
});

test("wireModernTasks logs an error when no tools/call handler is registered", async () => {
  const runtime = freshRuntime();
  const lines = await withEnv({ SN_EXPERIMENTAL_TASKS: "1" }, () =>
    errorLines(() => {
      const server = new McpServer({ name: "probe", version: "0.0.0" });
      wireModernTasks(server, runtime);
    }),
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /tools\/call/);
});

test("wireModernTasks is silent with the flag off", async () => {
  const runtime = freshRuntime();
  const lines = await withEnv({ SN_EXPERIMENTAL_TASKS: undefined }, () =>
    errorLines(() => {
      const server = new McpServer({ name: "probe", version: "0.0.0" });
      wireModernTasks(server, runtime);
    }),
  );
  assert.deepEqual(lines, []);
});
