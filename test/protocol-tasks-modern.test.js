// N-35 — conformance rows of the 2026-07-28 tasks extension
// (io.modelcontextprotocol/tasks) that the M-9 e2e tests in
// http-transport-v2.test.js do not pin: the core fallback for an undeclared
// client, `completed` vs `failed`, read-your-write consistency, input inside
// a task, ignored input responses and the error messages. The behaviour is in
// src/mcp/tasks.ts; requests go through the SDK's modern handler.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  createMcpHandler,
  inputRequired,
} from "@modelcontextprotocol/server";
import * as z from "zod";

import { buildMcpServer } from "../build/server.js";
import {
  installTaskHandlers,
  taskWorkSettled,
  wireModernTasks,
  withTaskSupport,
} from "../build/mcp/tasks.js";
import { mrtrServerOptions } from "../build/mcp/input.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const MODERN = "2026-07-28";
const TASKS = { extensions: { "io.modelcontextprotocol/tasks": {} } };
const FORM_AND_TASKS = { ...TASKS, elicitation: { form: {} } };
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A task tool name (TASK_TOOLS) served by the probe server below. */
const PROBE = "servicenow_snapshot_instance";

/**
 * A minimal server wired like buildMcpServer (task handlers, MRTR options,
 * wireModernTasks) whose one task tool does what `mode` says: an `isError`
 * result, a thrown error the SDK turns into an `isError` result, the one
 * error it lets through as a JSON-RPC error (-32042), an input_required round
 * or a plain result.
 */
function probeServer(runtime) {
  const server = new McpServer(
    { name: "tasks-conf", version: "0" },
    withTaskSupport({ ...mrtrServerOptions(), capabilities: {} }),
  );
  installTaskHandlers(server, runtime);
  server.registerTool(
    PROBE,
    {
      description: "probe",
      inputSchema: z.object({ mode: z.string() }),
    },
    async ({ mode }) => {
      if (mode === "isError") {
        return {
          isError: true,
          content: [{ type: "text", text: "the instance said no" }],
        };
      }
      if (mode === "throw") {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          "probe: bad snapshot scope",
        );
      }
      if (mode === "protocol") {
        throw new ProtocolError(
          ProtocolErrorCode.UrlElicitationRequired,
          "probe: sign in to the instance first",
          { elicitations: [] },
        );
      }
      if (mode === "input") {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: "Go?",
              requestedSchema: { type: "object", properties: {} },
            }),
          },
          requestState: "probe-state",
        });
      }
      return { content: [{ type: "text", text: `ok:${mode}` }] };
    },
  );
  wireModernTasks(server, runtime);
  return server;
}

/** A modern client over `factory`, one shared runtime, raw JSON-RPC. */
function modernClient(runtime, factory = (rt) => buildMcpServer(rt)) {
  const handler = createMcpHandler(() => factory(runtime), {
    legacy: "reject",
    onerror: () => {},
  });
  let id = 0;
  async function rpc(method, params, { capabilities = TASKS } = {}) {
    id += 1;
    const res = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MODERN,
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
              "io.modelcontextprotocol/protocolVersion": MODERN,
              "io.modelcontextprotocol/clientInfo": {
                name: "tasks-conf",
                version: "0",
              },
              "io.modelcontextprotocol/clientCapabilities": capabilities,
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
          .filter((line) => line.startsWith("data:"))
          .map((line) => JSON.parse(line.slice(5)))
      : [JSON.parse(text)];
    return messages.find((m) => m.id === id);
  }
  const call = (name, args, options) =>
    rpc("tools/call", { name, arguments: args }, options);
  async function settled(taskId) {
    await taskWorkSettled(runtime);
    return (await rpc("tasks/get", { taskId })).result;
  }
  return { rpc, call, settled, close: () => handler.close() };
}

/** Run `fn` with the tasks flag on, a fresh runtime and a docs dir. */
async function withTasks(fn) {
  const docs = mkdtempSync(path.join(tmpdir(), "sn-tasks-conf-"));
  try {
    await withEnv({ SN_EXPERIMENTAL_TASKS: "1", SN_DOCS_DIR: docs }, async () =>
      fn(freshRuntime()),
    );
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
}

const queryFile = (args = {}) => ({
  table: "incident",
  limit: 2,
  format: "file",
  ...args,
});

const incidents = () =>
  jsonResponse(
    200,
    { result: [{ sys_id: "a1", number: "INC1" }] },
    { "x-total-count": "1" },
  );

test("lifecycle-04 / tasks-02: an undeclared client gets the core result of a task tool, never -32021", async () => {
  await withTasks(async (runtime) => {
    const client = modernClient(runtime);
    try {
      await withFetch(incidents, async () => {
        for (const capabilities of [{}, { extensions: {} }]) {
          const res = await client.call("servicenow_query_table", queryFile(), {
            capabilities,
          });
          assert.equal(res.error, undefined, JSON.stringify(res.error));
          assert.equal(res.result.resultType, "complete");
          assert.equal("taskId" in res.result, false);
          assert.notEqual(res.result.isError, true);
          assert.equal(res.result.structuredContent.format, "file");
          assert.equal(res.result.structuredContent.rows, 1);
        }
      });
    } finally {
      await client.close();
    }
  });
});

test("tasks-03: task creation is keyed on the tool and its arguments, not wired into one request type", async () => {
  await withTasks(async (runtime) => {
    const client = modernClient(runtime, probeServer);
    try {
      // The same task store and tasks/* methods serve any task-creating
      // request; tools/call is the one that creates tasks today.
      const created = (await client.call(PROBE, { mode: "plain" })).result;
      assert.equal(created.resultType, "task");
      const done = await client.settled(created.taskId);
      assert.equal(done.status, "completed");
      assert.deepEqual(done.result.content, [
        { type: "text", text: "ok:plain" },
      ]);
      // A request type that does not create tasks is answered as in core.
      const listed = (await client.rpc("tools/list", {})).result;
      assert.equal(listed.resultType, "complete");
      assert.ok(listed.tools.some((t) => t.name === PROBE));
    } finally {
      await client.close();
    }
  });
});

test("tasks-06: an isError tool result completes the task; only a JSON-RPC error fails it", async () => {
  await withTasks(async (runtime) => {
    const client = modernClient(runtime, probeServer);
    try {
      // A tool result, an error thrown in the tool and a validation failure
      // all reach the client as an isError tool result: the task completes.
      for (const args of [
        { mode: "isError" },
        { mode: "throw" },
        { mode: 5 },
      ]) {
        const soft = (await client.call(PROBE, args)).result;
        assert.equal(soft.resultType, "task", JSON.stringify(args));
        const done = await client.settled(soft.taskId);
        assert.equal(done.status, "completed", JSON.stringify(args));
        assert.equal(done.result.isError, true, JSON.stringify(args));
        assert.equal("error" in done, false, JSON.stringify(args));
      }

      // A JSON-RPC error of the call fails the task and is its `error`. The
      // SDK lets one through tools/call: the -32042 throw, which it answers
      // with -32603 on this revision.
      const hard = (await client.call(PROBE, { mode: "protocol" })).result;
      const hardDone = await client.settled(hard.taskId);
      assert.equal(hardDone.status, "failed");
      assert.equal("result" in hardDone, false);
      assert.equal(hardDone.error.code, ProtocolErrorCode.InternalError);
      assert.match(hardDone.error.message, /URL elicitation cannot be/);
      assert.equal(hardDone.statusMessage, hardDone.error.message);
    } finally {
      await client.close();
    }
  });
});

test("tasks-08: a created task is visible to the very next tasks/get", async () => {
  await withTasks(async (runtime) => {
    const client = modernClient(runtime);
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    try {
      await withFetch(
        async () => {
          await gate;
          return incidents();
        },
        async () => {
          const created = (
            await client.call("servicenow_query_table", queryFile())
          ).result;
          assert.equal(created.resultType, "task");
          assert.match(created.taskId, UUID);
          // No wait between create and read: the store is written first.
          const seen = (
            await client.rpc("tasks/get", { taskId: created.taskId })
          ).result;
          assert.equal(seen.taskId, created.taskId);
          assert.equal(seen.status, "working");
          assert.equal(seen.createdAt, created.createdAt);
          release();
          assert.equal(
            (await client.settled(created.taskId)).status,
            "completed",
          );
        },
      );
    } finally {
      release();
      await client.close();
    }
  });
});

test("tasks-09 / tasks-12 / tasks-13 / tasks-18 / tasks-19: input is asked synchronously; a task never enters input_required", async () => {
  await withTasks(async (runtime) => {
    const client = modernClient(runtime, probeServer);
    try {
      // Synchronously (run_as_task:false) the MRTR round reaches the client
      // before any task exists.
      const sync = (
        await client.call(
          PROBE,
          { mode: "input", run_as_task: false },
          { capabilities: FORM_AND_TASKS },
        )
      ).result;
      assert.equal(sync.resultType, "input_required");
      assert.ok(sync.inputRequests.confirm);

      // Inside a task nobody could answer (even a client that declares
      // elicitation), so the task completes with a
      // CONFIRM_REQUIRED tool result instead: no input_required status, so
      // no inputRequests and no request keys to keep unique or reuse.
      const statuses = [];
      for (let i = 0; i < 2; i++) {
        const created = (
          await client.call(
            PROBE,
            { mode: "input" },
            { capabilities: FORM_AND_TASKS },
          )
        ).result;
        assert.equal(created.resultType, "task");
        statuses.push(created.status);
        const done = await client.settled(created.taskId);
        statuses.push(done.status);
        assert.equal("inputRequests" in done, false);
        assert.equal(done.result.isError, true);
        const body = JSON.parse(done.result.content[0].text);
        assert.equal(body.code, "CONFIRM_REQUIRED");
        assert.match(body.hint, /run_as_task:false/);
      }
      assert.equal(statuses.includes("input_required"), false, statuses);
    } finally {
      await client.close();
    }
  });
});

test("tasks-22: tasks/update ignores input responses for keys that are not outstanding", async () => {
  await withTasks(async (runtime) => {
    const client = modernClient(runtime, probeServer);
    try {
      const created = (await client.call(PROBE, { mode: "plain" })).result;
      const before = await client.settled(created.taskId);
      for (const inputResponses of [
        {},
        { confirm: { action: "accept", content: {} } },
        { never_issued: { action: "decline" } },
      ]) {
        const res = await client.rpc("tasks/update", {
          taskId: created.taskId,
          inputResponses,
        });
        assert.equal(res.error, undefined, JSON.stringify(res.error));
        const rest = { ...res.result };
        delete rest._meta;
        assert.deepEqual(rest, { resultType: "complete" });
      }
      const after = (await client.rpc("tasks/get", { taskId: created.taskId }))
        .result;
      assert.equal(after.status, before.status);
      assert.equal(after.lastUpdatedAt, before.lastUpdatedAt);
      assert.deepEqual(after.result, before.result);
    } finally {
      await client.close();
    }
  });
});

test("tasks-35: task errors say what went wrong", async () => {
  await withTasks(async (runtime) => {
    const client = modernClient(runtime, probeServer);
    try {
      const taskId = "0b6f5a8e-0000-4000-8000-000000000000";
      for (const method of ["tasks/get", "tasks/cancel", "tasks/update"]) {
        const unknown = await client.rpc(method, { taskId });
        assert.equal(unknown.error.code, -32602, method);
        assert.equal(
          unknown.error.message,
          `Task ${taskId} not found (or expired).`,
          method,
        );
        const undeclared = await client.rpc(
          method,
          { taskId },
          { capabilities: {} },
        );
        assert.equal(undeclared.error.code, -32021, method);
        assert.match(undeclared.error.message, /client capability/i, method);
        assert.deepEqual(undeclared.error.data.requiredCapabilities, TASKS);
      }
      // A failed task carries the cause in its error and statusMessage.
      const created = (await client.call(PROBE, { mode: "protocol" })).result;
      const failed = await client.settled(created.taskId);
      assert.match(failed.error.message, /return inputRequired/);
      assert.equal(failed.statusMessage, failed.error.message);
    } finally {
      await client.close();
    }
  });
});
