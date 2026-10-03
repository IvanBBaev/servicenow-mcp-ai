// M-9 — long-running operations as MCP tasks (EXPERIMENTAL,
// SN_EXPERIMENTAL_TASKS): the per-runtime task store (TTL, session binding,
// redaction, cancel), the run_as_task argument path end to end over the SDK's
// tasks/get / tasks/result / tasks/cancel / tasks/list handlers, and the
// flag-off invariants (no run_as_task in tools/list, no tasks capability).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CancelTaskResultSchema,
  CallToolResultSchema,
  GetTaskPayloadResultSchema,
  GetTaskResultSchema,
  ListTasksResultSchema,
  RELATED_TASK_META_KEY,
} from "@modelcontextprotocol/sdk/types.js";

import { registerAllTools } from "../build/mcp/registry.js";
import { currentRuntime } from "../build/core/runtime.js";
import {
  SnTaskStore,
  TASK_TTL_MS,
  TASK_TOOLS,
  redactResult,
  runMaybeAsTask,
  taskStoreFor,
  tasksEnabled,
  withTaskSupport,
} from "../build/mcp/tasks.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

const DOCS_DIR = mkdtempSync(path.join(tmpdir(), "sn-m9-"));
process.env.SN_DOCS_DIR = DOCS_DIR;
baselineEnv();

test.beforeEach(() => {
  freshRuntime();
});
test.after(() => rmSync(DOCS_DIR, { recursive: true, force: true }));

const ON = { SN_EXPERIMENTAL_TASKS: "1" };
const OFF = { SN_EXPERIMENTAL_TASKS: undefined };
const REQ = { method: "tools/call", params: {} };

/** A hand-driven clock for TTL tests. */
function clock(start = Date.parse("2026-09-26T00:00:00Z")) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

const spec = (name) => {
  const s = ALL_TOOLS.find((x) => x.name === name);
  assert.ok(s, `missing tool ${name}`);
  return s;
};

// --- flag -------------------------------------------------------------------

test("tasksEnabled: only 1 / true switch it on", async () => {
  for (const [value, expected] of [
    [undefined, false],
    ["0", false],
    ["yes", false],
    ["1", true],
    [" TRUE ", true],
  ]) {
    await withEnv({ SN_EXPERIMENTAL_TASKS: value }, () => {
      assert.equal(tasksEnabled(), expected, String(value));
    });
  }
});

test("withTaskSupport: unchanged when off, store + capability when on", async () => {
  const runtime = currentRuntime();
  const base = { capabilities: { logging: {} } };
  await withEnv(OFF, () => {
    assert.equal(withTaskSupport(base, runtime), base);
  });
  await withEnv(ON, () => {
    const opts = withTaskSupport(base, runtime);
    assert.deepEqual(opts.capabilities, {
      logging: {},
      tasks: { list: {}, cancel: {} },
    });
    assert.equal(opts.taskStore, taskStoreFor(runtime));
    assert.equal(
      taskStoreFor(runtime),
      taskStoreFor(runtime),
      "one per runtime",
    );
  });
});

test("TASK_TOOLS names only registered tools", () => {
  for (const name of TASK_TOOLS) spec(name);
});

// --- store ------------------------------------------------------------------

test("store: create / get / result round trip, TTL capped at 1 h", async () => {
  const store = new SnTaskStore(clock());
  const task = await store.createTask({ ttl: 10 * TASK_TTL_MS }, 1, REQ);
  assert.equal(task.status, "working");
  assert.equal(task.ttl, TASK_TTL_MS, "capped");
  assert.equal(task.pollInterval, 2000);
  const shorter = await store.createTask(
    { ttl: 5000, pollInterval: 10 },
    2,
    REQ,
  );
  assert.equal(shorter.ttl, 5000);
  assert.equal(shorter.pollInterval, 10);
  const fallback = await store.createTask({}, 3, REQ);
  assert.equal(fallback.ttl, TASK_TTL_MS);

  await assert.rejects(store.getTaskResult(task.taskId), /no result yet/);
  await store.storeTaskResult(task.taskId, "completed", {
    content: [{ type: "text", text: "done" }],
  });
  assert.equal((await store.getTask(task.taskId)).status, "completed");
  assert.deepEqual(await store.getTaskResult(task.taskId), {
    content: [{ type: "text", text: "done" }],
  });
  await assert.rejects(
    store.storeTaskResult(task.taskId, "failed", { content: [] }),
    /already completed/,
  );
  await assert.rejects(
    store.updateTaskStatus(task.taskId, "working"),
    /already completed/,
  );
  assert.equal(await store.getTask("nope"), null);
  await assert.rejects(store.getTaskResult("nope"), /not found/);
});

test("store: TTL expiry drops the entry and aborts its work", async () => {
  const now = clock();
  const store = new SnTaskStore(now);
  const running = await store.createTask({}, 1, REQ);
  const done = await store.createTask({ ttl: 1000 }, 2, REQ);
  await store.storeTaskResult(done.taskId, "completed", { content: [] });
  const controller = new AbortController();
  store.track(running.taskId, controller);
  assert.equal(store.runningCount(), 1);

  now.advance(999);
  assert.ok(await store.getTask(done.taskId), "still alive just before TTL");
  now.advance(1);
  assert.equal(await store.getTask(done.taskId), null, "expired at TTL");
  await assert.rejects(store.getTaskResult(done.taskId), /not found/);

  now.advance(TASK_TTL_MS);
  assert.equal(await store.getTask(running.taskId), null);
  assert.ok(controller.signal.aborted, "expired running task aborted");
  assert.equal(store.runningCount(), 0);
  assert.deepEqual(await store.listTasks(), { tasks: [] });
});

test("store: cancel aborts, session binding hides foreign tasks", async () => {
  const store = new SnTaskStore(clock());
  const mine = await store.createTask({}, 1, REQ, "s1");
  const theirs = await store.createTask({}, 2, REQ, "s2");
  const open = await store.createTask({}, 3, REQ);
  const controller = new AbortController();
  store.track(mine.taskId, controller);

  assert.equal(await store.getTask(mine.taskId, "s2"), null);
  assert.equal(await store.getTask(mine.taskId), null);
  await assert.rejects(
    store.updateTaskStatus(mine.taskId, "cancelled", "x", "s2"),
    /not found/,
  );
  const listed = (await store.listTasks(undefined, "s1")).tasks.map(
    (t) => t.taskId,
  );
  assert.deepEqual(listed.sort(), [mine.taskId, open.taskId].sort());
  assert.ok(!listed.includes(theirs.taskId));

  await store.updateTaskStatus(mine.taskId, "cancelled", "stop", "s1");
  const got = await store.getTask(mine.taskId, "s1");
  assert.equal(got.status, "cancelled");
  assert.equal(got.statusMessage, "stop");
  assert.ok(controller.signal.aborted);
  assert.equal(store.runningCount(), 0);

  await store.updateTaskStatus(open.taskId, "input_required");
  assert.equal((await store.getTask(open.taskId)).status, "input_required");
});

test("store: listTasks paginates and rejects a bad cursor", async () => {
  const store = new SnTaskStore(clock());
  const ids = [];
  for (let i = 0; i < 55; i++)
    ids.push((await store.createTask({}, i, REQ)).taskId);
  const first = await store.listTasks();
  assert.equal(first.tasks.length, 50);
  assert.equal(first.nextCursor, ids[49]);
  const second = await store.listTasks(first.nextCursor);
  assert.deepEqual(
    second.tasks.map((t) => t.taskId),
    ids.slice(50),
  );
  assert.equal(second.nextCursor, undefined);
  await assert.rejects(store.listTasks("bogus"), /Invalid cursor/);
});

test("store: dispose aborts running work and forgets everything", async () => {
  const store = new SnTaskStore(clock());
  const t = await store.createTask({}, 1, REQ);
  const controller = new AbortController();
  store.track(t.taskId, controller);
  store.untrack("unknown");
  store.dispose();
  assert.ok(controller.signal.aborted);
  assert.equal(await store.getTask(t.taskId), null);
});

test("store: results are retained redacted (fields in JSON text + PII)", async () => {
  const result = {
    content: [
      { type: "text", text: JSON.stringify({ email: "a@b.io", n: 1 }) },
      { type: "text", text: "not json" },
      { type: "image", data: "x", mimeType: "image/png" },
    ],
    structuredContent: { email: "a@b.io" },
  };
  await withEnv(
    { SN_REDACT_FIELDS: undefined, SN_REDACT_PII: undefined },
    () => {
      assert.equal(redactResult(result), result, "no-op when redaction is off");
    },
  );
  await withEnv({ SN_REDACT_FIELDS: "email" }, async () => {
    const store = new SnTaskStore(clock());
    const t = await store.createTask({}, 1, REQ);
    await store.storeTaskResult(t.taskId, "completed", result);
    const kept = await store.getTaskResult(t.taskId);
    assert.deepEqual(JSON.parse(kept.content[0].text), {
      email: "[redacted]",
      n: 1,
    });
    assert.equal(kept.content[1].text, "not json");
    assert.equal(kept.structuredContent.email, "[redacted]");
    // Nothing to mask in the text: the text item is kept as is.
    const plain = { content: [{ type: "text", text: '{"n":1}' }] };
    assert.deepEqual(redactResult(plain), plain);
    assert.deepEqual(redactResult({ isError: false }), { isError: false });
  });
});

// --- runMaybeAsTask (direct) ------------------------------------------------

test("runMaybeAsTask: strips run_as_task and runs inline when not a task", async () => {
  const seen = [];
  const run = async (args) => {
    seen.push(args);
    return { content: [{ type: "text", text: "{}" }] };
  };
  const health = spec("servicenow_check_code_health");
  await withEnv(OFF, async () => {
    await runMaybeAsTask(health, { scope: "x" }, {}, run);
    await runMaybeAsTask(health, { scope: "x", run_as_task: true }, {}, run);
  });
  await withEnv(ON, async () => {
    await runMaybeAsTask(health, { scope: "x", run_as_task: false }, {}, run);
    await runMaybeAsTask(
      spec("servicenow_get_record"),
      { run_as_task: true },
      {},
      run,
    );
    const missing = await runMaybeAsTask(
      health,
      { scope: "x", run_as_task: true },
      {},
      run,
    );
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /without a task store/);
    const notFile = await runMaybeAsTask(
      spec("servicenow_query_table"),
      { table: "incident", run_as_task: true },
      {},
      run,
    );
    assert.equal(notFile.isError, true);
    assert.match(notFile.content[0].text, /format:'file'/);
  });
  assert.deepEqual(seen, [{ scope: "x" }, { scope: "x" }, { scope: "x" }, {}]);
});

test("runMaybeAsTask: a thrown run is stored as failed, a late store is swallowed", async () => {
  await withEnv(ON, async () => {
    const store = taskStoreFor(currentRuntime());
    const requestStore = {
      createTask: (p) => store.createTask(p, 1, REQ),
      storeTaskResult: (id, status, result) =>
        store.storeTaskResult(id, status, result),
    };
    const res = await runMaybeAsTask(
      spec("servicenow_check_code_health"),
      { run_as_task: true },
      { taskStore: requestStore },
      async () => {
        throw new Error("boom");
      },
    );
    const { taskId } = res._meta[RELATED_TASK_META_KEY];
    await new Promise((r) => setImmediate(r));
    const task = await store.getTask(taskId);
    assert.equal(task.status, "failed");
    const kept = await store.getTaskResult(taskId);
    assert.equal(kept.isError, true);
    assert.match(kept.content[0].text, /boom/);

    // The store rejects the result (e.g. already terminal): logged, not thrown.
    const broken = {
      ...requestStore,
      storeTaskResult: async () => {
        throw new Error("gone");
      },
    };
    await runMaybeAsTask(
      spec("servicenow_check_code_health"),
      { run_as_task: true },
      { taskStore: broken, requestId: 7, sessionId: "s" },
      async () => ({ content: [{ type: "text", text: "{}" }] }),
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(store.runningCount(), 0);
  });
});

// --- end to end over the SDK ------------------------------------------------

async function startServer() {
  const runtime = currentRuntime();
  const server = new McpServer(
    { name: "servicenow-mcp-test", version: "0.0.0" },
    withTaskSupport({ capabilities: { logging: {} } }, runtime),
  );
  registerAllTools(server, runtime);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    store: taskStoreFor(runtime),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const rows = (n) =>
  Array.from({ length: n }, (_, i) => ({
    sys_id: `s${String(i).padStart(3, "0")}`,
    n: i,
    email: `u${i}@example.com`,
  }));

const taskIdOf = (res) => {
  const meta = res._meta?.[RELATED_TASK_META_KEY];
  assert.ok(meta?.taskId, "handle carries related-task _meta");
  return meta.taskId;
};

test("flag off: no run_as_task in tools/list, no tasks capability", async () => {
  await withEnv({ ...OFF, SN_TOOL_PACKAGES: "all" }, async () => {
    const { client, close } = await startServer();
    try {
      const { tools } = await client.listTools();
      for (const t of tools) {
        assert.ok(
          !("run_as_task" in (t.inputSchema.properties ?? {})),
          `${t.name} leaks run_as_task`,
        );
      }
      assert.equal(client.getServerCapabilities().tasks, undefined);
      // The argument is rejected by the strict schema, not silently accepted.
      const res = await client.callTool({
        name: "servicenow_check_code_health",
        arguments: { run_as_task: true },
      });
      assert.equal(res.isError, true);
    } finally {
      await close();
    }
  });
});

test("flag on: run_as_task only on the task tools, capability declared", async () => {
  await withEnv({ ...ON, SN_TOOL_PACKAGES: "all" }, async () => {
    const { client, close } = await startServer();
    try {
      const { tools } = await client.listTools();
      const withFlag = tools
        .filter((t) => "run_as_task" in (t.inputSchema.properties ?? {}))
        .map((t) => t.name)
        .sort();
      assert.deepEqual(withFlag, [...TASK_TOOLS].sort());
      const health = tools.find(
        (t) => t.name === "servicenow_check_code_health",
      );
      assert.equal(
        health.inputSchema.additionalProperties,
        false,
        "still strict",
      );
      assert.deepEqual(client.getServerCapabilities().tasks, {
        list: {},
        cancel: {},
      });
    } finally {
      await close();
    }
  });
});

test("e2e: query_table file export as a task — handle, get, result, list", async () => {
  await withEnv({ ...ON, SN_REDACT_FIELDS: "email" }, async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const data = rows(3);
    await withFetch(
      async (url) => {
        await gate;
        const u = new URL(url);
        const offset = Number(u.searchParams.get("sysparm_offset") ?? "0");
        return jsonResponse(
          200,
          { result: offset ? [] : data },
          {
            "x-total-count": String(data.length),
          },
        );
      },
      async () => {
        const { client, store, close } = await startServer();
        try {
          const handle = await client.callTool({
            name: "servicenow_query_table",
            arguments: {
              table: "incident",
              format: "file",
              fileFormat: "jsonl",
              run_as_task: true,
            },
          });
          assert.notEqual(handle.isError, true);
          const taskId = taskIdOf(handle);
          const body = JSON.parse(handle.content[0].text);
          assert.equal(body.task.taskId, taskId);
          assert.equal(body.task.status, "working");
          assert.equal(body.task.ttl, TASK_TTL_MS);
          assert.equal(store.runningCount(), 1, "work is in the background");

          const working = await client.request(
            { method: "tasks/get", params: { taskId } },
            GetTaskResultSchema,
          );
          assert.equal(working.status, "working");
          const listed = await client.request(
            { method: "tasks/list", params: {} },
            ListTasksResultSchema,
          );
          assert.ok(listed.tasks.some((t) => t.taskId === taskId));

          release();
          const result = await client.request(
            { method: "tasks/result", params: { taskId } },
            GetTaskPayloadResultSchema,
          );
          assert.equal(result._meta[RELATED_TASK_META_KEY].taskId, taskId);
          const parsed = CallToolResultSchema.parse(result);
          const out = JSON.parse(parsed.content[0].text);
          assert.equal(out.format, "file");
          assert.equal(out.rows, 3);
          const lines = readFileSync(out.file, "utf8").trim().split("\n");
          assert.ok(lines.every((l) => JSON.parse(l).email === "[redacted]"));

          const done = await client.request(
            { method: "tasks/get", params: { taskId } },
            GetTaskResultSchema,
          );
          assert.equal(done.status, "completed");
          assert.equal(store.runningCount(), 0);
        } finally {
          await close();
        }
      },
    );
  });
});

test("e2e: tasks/cancel aborts the in-flight ServiceNow request", async () => {
  await withEnv({ ...ON, SN_TOOL_PACKAGES: "all" }, async () => {
    let aborted = false;
    await withFetch(
      (url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(init.signal.reason ?? new Error("aborted"));
          });
        }),
      async (calls) => {
        const { client, store, close } = await startServer();
        try {
          const handle = await client.callTool({
            name: "servicenow_check_code_health",
            arguments: { run_as_task: true },
          });
          const taskId = taskIdOf(handle);
          while (calls.length === 0) await new Promise((r) => setImmediate(r));

          const cancelled = await client.request(
            { method: "tasks/cancel", params: { taskId } },
            CancelTaskResultSchema,
          );
          assert.equal(cancelled.status, "cancelled");
          for (let i = 0; i < 20 && !aborted; i++) {
            await new Promise((r) => setImmediate(r));
          }
          assert.ok(aborted, "fetch saw the abort");
          assert.equal(store.runningCount(), 0);
          // The cancelled task keeps its terminal status; no result arrives.
          await new Promise((r) => setImmediate(r));
          const after = await client.request(
            { method: "tasks/get", params: { taskId } },
            GetTaskResultSchema,
          );
          assert.equal(after.status, "cancelled");
          await assert.rejects(
            client.request(
              { method: "tasks/cancel", params: { taskId } },
              CancelTaskResultSchema,
            ),
            /terminal|already/i,
          );
        } finally {
          await close();
        }
      },
    );
  });
});
