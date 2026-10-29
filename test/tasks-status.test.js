// N-82 — a background task's progress becomes its statusMessage, so
// tasks/get shows how far the run got ("3/12 — incident"): the store's
// reportStatus, the run_as_task path (2025-11-25 wire) and the tasks
// extension path (2026-07-28 wire) through runSpec's call context.
import test from "node:test";
import assert from "node:assert/strict";
import {
  McpServer,
  createMcpHandler,
  RELATED_TASK_META_KEY,
} from "@modelcontextprotocol/server";
import * as z from "zod";

import {
  STATUS_MESSAGE_MAX,
  SnTaskStore,
  installTaskHandlers,
  runMaybeAsTask,
  statusLine,
  taskStoreFor,
  taskWorkSettled,
  wireModernTasks,
  withTaskSupport,
} from "../build/mcp/tasks.js";
import { mrtrServerOptions } from "../build/mcp/input.js";
import {
  callExtraFromContext,
  defineTool,
  runSpec,
} from "../build/mcp/define.js";
import { ok } from "../build/mcp/result.js";
import { trackProgress } from "../build/core/progress.js";
import { currentRuntime } from "../build/core/runtime.js";
import { baselineEnv, freshRuntime, withEnv } from "./helpers.js";

baselineEnv();
test.beforeEach(() => {
  freshRuntime();
});

const ON = { SN_EXPERIMENTAL_TASKS: "1" };
const REQ = { method: "tools/call", params: {} };
const TOOL = "servicenow_snapshot_instance";

/** A gate the probe tool waits on between its two progress steps. */
function gate() {
  let open;
  const opened = new Promise((r) => {
    open = r;
  });
  return { opened, open };
}

/** A task-tool-named spec that reports two steps around `between`. */
function probeSpec(between) {
  return defineTool({
    name: TOOL,
    title: "probe",
    description: "Test-only task tool that reports progress.",
    package: "test",
    annotations: { readOnlyHint: true },
    input: {},
    handler: async () => {
      const progress = trackProgress(2);
      progress.tick("sys_script");
      await between();
      progress.tick("sys_script_include");
      return ok({ done: true });
    },
  });
}

const tick = () => new Promise((r) => setImmediate(r));

test("statusLine: the count, the total when known, the message, capped", () => {
  assert.equal(statusLine({ progress: 3 }), "3");
  assert.equal(statusLine({ progress: 3, total: 12 }), "3/12");
  assert.equal(
    statusLine({ progress: 3, total: 12, message: "incident" }),
    "3/12 — incident",
  );
  const long = statusLine({ progress: 1, message: "x".repeat(500) });
  assert.equal(long.length, STATUS_MESSAGE_MAX);
  assert.ok(long.endsWith("…"));
});

test("store: reportStatus sets statusMessage while working, never after", async () => {
  const store = new SnTaskStore();
  const task = await store.createTask({}, 1, REQ);
  const before = (await store.getTask(task.taskId)).lastUpdatedAt;
  store.reportStatus(task.taskId, { progress: 1, total: 4, message: "a" });
  const working = await store.getTask(task.taskId);
  assert.equal(working.statusMessage, "1/4 — a");
  assert.ok(working.lastUpdatedAt >= before);

  store.reportStatus(task.taskId, { progress: Number.NaN });
  assert.equal((await store.getTask(task.taskId)).statusMessage, "1/4 — a");

  await store.storeTaskResult(task.taskId, "completed", { content: [] });
  store.reportStatus(task.taskId, { progress: 2, total: 4 });
  assert.equal((await store.getTask(task.taskId)).statusMessage, "1/4 — a");

  // An unknown task is ignored, not an error.
  store.reportStatus("nope", { progress: 1 });
});

test("runSpec: without a progress token, progress goes to taskStatus", async () => {
  const seen = [];
  await runSpec(
    probeSpec(async () => {}),
    {},
    {
      taskStatus: (u) => seen.push(u),
    },
  );
  assert.deepEqual(
    seen.map((u) => statusLine(u)),
    ["1/2 — sys_script", "2/2 — sys_script_include"],
  );
});

test("run_as_task: tasks/get shows the background run's progress", async () => {
  await withEnv(ON, async () => {
    const store = taskStoreFor(currentRuntime());
    const requestStore = {
      createTask: (p) => store.createTask(p, 1, REQ),
      storeTaskResult: (id, status, result) =>
        store.storeTaskResult(id, status, result),
    };
    const held = gate();
    const spec = probeSpec(() => held.opened);
    const res = await runMaybeAsTask(
      spec,
      { run_as_task: true },
      { taskStore: requestStore },
      (args, extra) => runSpec(spec, args, extra),
    );
    const { taskId } = res._meta[RELATED_TASK_META_KEY];
    await tick();
    const working = await store.getTask(taskId);
    assert.equal(working.status, "working");
    assert.equal(working.statusMessage, "1/2 — sys_script");

    held.open();
    while (store.runningCount() > 0) await tick();
    const done = await store.getTask(taskId);
    assert.equal(done.status, "completed");
    assert.equal(done.statusMessage, "2/2 — sys_script_include");
  });
});

test("tasks extension: tasks/get on the 2026-07-28 wire shows the progress", async () => {
  await withEnv(ON, async () => {
    const runtime = freshRuntime();
    const held = gate();
    const spec = probeSpec(() => held.opened);
    const factory = () => {
      const server = new McpServer(
        { name: "tasks-status", version: "0" },
        withTaskSupport({ ...mrtrServerOptions(), capabilities: {} }),
      );
      installTaskHandlers(server, runtime);
      server.registerTool(
        TOOL,
        { description: "probe", inputSchema: z.object({}) },
        (args, ctx) => runSpec(spec, args, callExtraFromContext(ctx, server)),
      );
      wireModernTasks(server, runtime);
      return server;
    };
    const handler = createMcpHandler(factory, {
      legacy: "reject",
      onerror: () => {},
    });
    let id = 0;
    const rpc = async (method, params) => {
      id += 1;
      const res = await handler.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": method,
            "mcp-name": params.name ?? params.taskId,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params: {
              ...params,
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": {
                  name: "tasks-status",
                  version: "0",
                },
                "io.modelcontextprotocol/clientCapabilities": {
                  extensions: { "io.modelcontextprotocol/tasks": {} },
                },
              },
            },
          }),
        }),
      );
      const text = await res.text();
      const messages = res.headers
        .get("content-type")
        ?.includes("text/event-stream")
        ? text
            .split("\n")
            .filter((l) => l.startsWith("data:") && l.slice(5).trim())
            .map((l) => JSON.parse(l.slice(5)))
        : [JSON.parse(text)];
      return messages.find((m) => m.id === id).result;
    };
    try {
      const created = await rpc("tools/call", { name: TOOL, arguments: {} });
      assert.equal(created.resultType, "task");
      await tick();
      const working = await rpc("tasks/get", { taskId: created.taskId });
      assert.equal(working.status, "working");
      assert.equal(working.statusMessage, "1/2 — sys_script");

      held.open();
      await taskWorkSettled(runtime);
      const done = await rpc("tasks/get", { taskId: created.taskId });
      assert.equal(done.status, "completed");
      assert.equal(done.statusMessage, "2/2 — sys_script_include");
    } finally {
      await handler.close();
    }
  });
});
