import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ServerOptions } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestTaskStore } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  isTerminal,
  type CreateTaskOptions,
  type TaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks";
import {
  RELATED_TASK_META_KEY,
  type Request,
  type RequestId,
  type Result,
  type Task,
} from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../core/logging.js";
import { readBool } from "../core/settings-manifest.js";
import { redactValue } from "../core/redaction.js";
import {
  currentRuntime,
  defineRuntimePart,
  type Runtime,
} from "../core/runtime.js";
import type { AnyToolSpec, CallExtra } from "./define.js";
import { fail, ok, type ToolResult } from "./result.js";

/**
 * M-9 — long-running operations as MCP tasks (EXPERIMENTAL).
 *
 * Behind `SN_EXPERIMENTAL_TASKS=1` the server hands the SDK's experimental
 * task machinery (`@modelcontextprotocol/sdk/experimental/tasks`, SDK 1.30) a
 * task store, which installs the standard `tasks/get`, `tasks/result`,
 * `tasks/list` and `tasks/cancel` handlers, and the long-running tools gain an
 * optional `run_as_task:true` argument. Such a call returns a task handle at
 * once — `{ task: { taskId, status, ttl, pollInterval, … } }` with
 * `_meta["io.modelcontextprotocol/related-task"]` — and the work continues in
 * the background; `tasks/result` later returns the tool result carrying the
 * same `_meta` key (added by the SDK).
 *
 * - One in-memory store per E-3 runtime container (a runtime part): disposing
 *   the runtime aborts every running task and drops every stored result.
 * - Retention is capped at one hour from creation (TASK_TTL_MS), whatever the
 *   client asks for; an expired task is gone, running or not (its work is
 *   aborted).
 * - Stored results are redacted again (SN_REDACT_FIELDS / SN_REDACT_PII) on
 *   top of the ok()/fail() boundary, so nothing unredacted sits in memory for
 *   an hour even if a result bypassed the boundary.
 * - A task is bound to the MCP session that created it (HTTP transport); a
 *   different session sees "not found".
 * - `tasks/cancel` aborts the task's in-flight requests through the same
 *   signal M-3 threads into snRequest.
 *
 * Native task augmentation (`params.task` on tools/call, SEP-1686
 * `execution.taskSupport`) is deliberately NOT advertised: the SDK then turns
 * every plain call of such a tool into a create-and-poll loop. The capability
 * declares `tasks.list` and `tasks.cancel` only, so a task-augmented
 * tools/call is rejected by the SDK instead of being half-supported.
 *
 * With the flag off nothing here is reachable: no task store, no `tasks`
 * capability, and the input schemas (tools/list) are byte-identical to a build
 * without this module. Removable without a major if the SDK drops the API.
 */

/** Retention cap of a task (and its result), from creation: one hour. */
export const TASK_TTL_MS = 60 * 60 * 1000;

/** Suggested client poll interval for tasks/get. */
export const TASK_POLL_INTERVAL_MS = 2000;

/** The tools that accept `run_as_task` (query_table only with format:"file"). */
export const TASK_TOOLS: ReadonlySet<string> = new Set([
  "servicenow_snapshot_instance",
  "servicenow_compare_instances",
  "servicenow_run_atf_test",
  "servicenow_run_atf_suite",
  "servicenow_check_code_health",
  "servicenow_query_table",
  "servicenow_document_app",
  "servicenow_document_instance",
]);

/** True when SN_EXPERIMENTAL_TASKS is `1` / `true` (read at call time). */
export function tasksEnabled(): boolean {
  return readBool("SN_EXPERIMENTAL_TASKS");
}

/** True when `spec` takes `run_as_task` in the current configuration. */
export function acceptsRunAsTask(spec: AnyToolSpec): boolean {
  return tasksEnabled() && TASK_TOOLS.has(spec.name);
}

interface Entry {
  task: Task;
  request: Request;
  requestId: RequestId;
  sessionId?: string;
  result?: Result;
  /** Epoch ms after which the entry is dropped. */
  expiresAt: number;
}

/**
 * The SDK TaskStore of one runtime: in-memory, lazily expired (every access
 * sweeps — no timers to leak), TTL capped, results redacted, session-bound.
 * It also owns the AbortController of each running task so `tasks/cancel`
 * (a status update to `cancelled`) and TTL expiry stop the work.
 */
export class SnTaskStore implements TaskStore {
  private readonly entries = new Map<string, Entry>();
  private readonly running = new Map<string, AbortController>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxTtlMs: number = TASK_TTL_MS,
  ) {}

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  private stop(taskId: string): void {
    this.running.get(taskId)?.abort();
    this.running.delete(taskId);
  }

  /** Drop every expired entry (and abort its work, if still running). */
  private sweep(): void {
    const t = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= t) {
        this.entries.delete(id);
        this.stop(id);
      }
    }
  }

  /** The live entry of `taskId` as seen from `sessionId`, if any. */
  private entry(taskId: string, sessionId?: string): Entry | undefined {
    this.sweep();
    const entry = this.entries.get(taskId);
    if (!entry) return undefined;
    if (entry.sessionId !== undefined && entry.sessionId !== sessionId) {
      return undefined;
    }
    return entry;
  }

  private mustGet(taskId: string, sessionId?: string): Entry {
    const entry = this.entry(taskId, sessionId);
    if (!entry) throw new Error(`Task ${taskId} not found (or expired).`);
    return entry;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async TaskStore contract; sync throws must reject
  async createTask(
    params: CreateTaskOptions,
    requestId: RequestId,
    request: Request,
    sessionId?: string,
  ): Promise<Task> {
    this.sweep();
    const requested = params.ttl;
    const ttl =
      typeof requested === "number" && requested > 0
        ? Math.min(requested, this.maxTtlMs)
        : this.maxTtlMs;
    const createdAt = this.stamp();
    const task: Task = {
      taskId: randomUUID(),
      status: "working",
      ttl,
      createdAt,
      lastUpdatedAt: createdAt,
      pollInterval: params.pollInterval ?? TASK_POLL_INTERVAL_MS,
    };
    this.entries.set(task.taskId, {
      task,
      request,
      requestId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      expiresAt: this.now() + ttl,
    });
    return { ...task };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async TaskStore contract; sync throws must reject
  async getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    const entry = this.entry(taskId, sessionId);
    return entry ? { ...entry.task } : null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async TaskStore contract; sync throws must reject
  async storeTaskResult(
    taskId: string,
    status: "completed" | "failed",
    result: Result,
    sessionId?: string,
  ): Promise<void> {
    const entry = this.mustGet(taskId, sessionId);
    if (isTerminal(entry.task.status)) {
      throw new Error(
        `Task ${taskId} is already ${entry.task.status}; its result is final.`,
      );
    }
    entry.result = redactResult(result);
    entry.task.status = status;
    entry.task.lastUpdatedAt = this.stamp();
    this.running.delete(taskId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async TaskStore contract; sync throws must reject
  async getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    const entry = this.mustGet(taskId, sessionId);
    if (!entry.result) throw new Error(`Task ${taskId} has no result yet.`);
    return entry.result;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async TaskStore contract; sync throws must reject
  async updateTaskStatus(
    taskId: string,
    status: Task["status"],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    const entry = this.mustGet(taskId, sessionId);
    if (isTerminal(entry.task.status)) {
      throw new Error(
        `Task ${taskId} is already ${entry.task.status}; it cannot become ${status}.`,
      );
    }
    entry.task.status = status;
    if (statusMessage) entry.task.statusMessage = statusMessage;
    entry.task.lastUpdatedAt = this.stamp();
    if (status === "cancelled") this.stop(taskId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async TaskStore contract; sync throws must reject
  async listTasks(
    cursor?: string,
    sessionId?: string,
  ): Promise<{ tasks: Task[]; nextCursor?: string }> {
    this.sweep();
    const PAGE = 50;
    const visible = [...this.entries.values()].filter(
      (e) => e.sessionId === undefined || e.sessionId === sessionId,
    );
    let start = 0;
    if (cursor) {
      const at = visible.findIndex((e) => e.task.taskId === cursor);
      if (at < 0) throw new Error(`Invalid cursor: ${cursor}`);
      start = at + 1;
    }
    const page = visible.slice(start, start + PAGE);
    const tasks = page.map((e) => ({ ...e.task }));
    const last = page.at(-1);
    return start + PAGE < visible.length && last
      ? { tasks, nextCursor: last.task.taskId }
      : { tasks };
  }

  /** Register the controller that aborts `taskId`'s work. */
  track(taskId: string, controller: AbortController): void {
    this.running.set(taskId, controller);
  }

  /** Forget `taskId`'s controller (the work finished). */
  untrack(taskId: string): void {
    this.running.delete(taskId);
  }

  /** Number of tasks whose work is still running (tests, status). */
  runningCount(): number {
    return this.running.size;
  }

  /** Abort every running task and drop every entry (runtime dispose). */
  dispose(): void {
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
    this.entries.clear();
  }
}

/**
 * Redact a tool result before it is retained: deep over the object (covers
 * structuredContent and PII in text), and inside JSON text content so a named
 * field (SN_REDACT_FIELDS) is masked even in the serialised payload. A no-op,
 * same reference, when redaction is off.
 */
export function redactResult(result: Result): Result {
  const masked = redactValue(result).value;
  const content = (masked as { content?: unknown }).content;
  if (!Array.isArray(content)) return masked;
  let changed = false;
  const next = content.map((item: unknown) => {
    const text = (item as { type?: unknown; text?: unknown }).text;
    if ((item as { type?: unknown }).type !== "text") return item;
    if (typeof text !== "string") return item;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return item;
    }
    const r = redactValue(parsed);
    if (r.redacted === 0) return item;
    changed = true;
    return { ...(item as object), text: JSON.stringify(r.value) };
  });
  return changed ? { ...masked, content: next } : masked;
}

const TASKS = defineRuntimePart(
  "tasks",
  () => new SnTaskStore(),
  (store) => store.dispose(),
);

/** The task store of `runtime` (created on first use). */
export function taskStoreFor(runtime: Runtime): SnTaskStore {
  return runtime.get(TASKS);
}

/**
 * McpServer options with task support merged in when the flag is on: the
 * runtime's task store and the `tasks` capability (list + cancel). Returns
 * `options` unchanged when the flag is off.
 */
export function withTaskSupport(
  options: ServerOptions,
  runtime: Runtime,
): ServerOptions {
  if (!tasksEnabled()) return options;
  return {
    ...options,
    capabilities: {
      ...options.capabilities,
      tasks: { list: {}, cancel: {} },
    },
    taskStore: taskStoreFor(runtime),
  };
}

const runAsTaskParam = z
  .boolean()
  .optional()
  .describe(
    "EXPERIMENTAL: run as a background task, return its handle; poll tasks/get, read tasks/result (kept 1 h); tasks/cancel stops it.",
  );

/**
 * The registered input schema, plus `run_as_task` for a task-capable tool
 * when the flag is on. The same object is returned otherwise, so tools/list
 * is unchanged by default.
 */
export function withTaskInput<T extends z.ZodObject>(
  spec: AnyToolSpec,
  schema: T,
): T {
  if (!acceptsRunAsTask(spec)) return schema;
  return schema.extend({ run_as_task: runAsTaskParam }) as unknown as T;
}

/**
 * The registered output schema (M-6). A task-capable tool with the flag on
 * may answer with a task handle instead of its data, so every declared field
 * turns optional there; the handle body then validates like any result.
 * Otherwise the same object is returned, so tools/list is unchanged by default.
 */
export function withTaskOutput<T extends z.ZodObject>(
  spec: AnyToolSpec,
  schema: T,
): T {
  if (!acceptsRunAsTask(spec)) return schema;
  return schema.partial() as unknown as T;
}

/** The SDK `extra` as seen here: M-3's subset plus the request task store. */
export type TaskCallExtra = CallExtra & { taskStore?: RequestTaskStore };

/** A tool handle result: the ok() envelope plus the related-task `_meta`. */
export type TaskHandleResult = ToolResult & {
  _meta: Record<string, unknown>;
};

/**
 * Run a tool call, as a task when it asked for one (`run_as_task:true` on a
 * task-capable tool with the flag on), else directly through `run`. The
 * `run_as_task` argument never reaches the tool handler.
 */
export async function runMaybeAsTask(
  spec: AnyToolSpec,
  args: Record<string, unknown>,
  extra: TaskCallExtra,
  run: (args: Record<string, unknown>, extra: CallExtra) => Promise<ToolResult>,
): Promise<ToolResult | TaskHandleResult> {
  if (!("run_as_task" in args)) return run(args, extra);
  const { run_as_task: asTask, ...rest } = args;
  if (asTask !== true || !acceptsRunAsTask(spec)) return run(rest, extra);
  if (spec.name === "servicenow_query_table" && rest.format !== "file") {
    return fail(
      "run_as_task on servicenow_query_table needs format:'file' (the S-11 export path).",
      {
        code: "TASKS_UNAVAILABLE",
        hint: "Repeat the call with format:'file'.",
      },
    );
  }
  const requestStore = extra.taskStore;
  if (!requestStore) {
    return fail(
      "run_as_task is unavailable: this server was started without a task store (SN_EXPERIMENTAL_TASKS).",
      {
        code: "TASKS_UNAVAILABLE",
        hint: "Set SN_EXPERIMENTAL_TASKS=true and restart the server, or call the tool without run_as_task.",
      },
    );
  }
  const store = taskStoreFor(currentRuntime());
  const task = await requestStore.createTask({
    ttl: TASK_TTL_MS,
    pollInterval: TASK_POLL_INTERVAL_MS,
  });
  const controller = new AbortController();
  store.track(task.taskId, controller);
  // The progress token belonged to the request that just returned; the
  // background run reports status through the task instead.
  const background: CallExtra = {
    ...(extra.requestId !== undefined ? { requestId: extra.requestId } : {}),
    ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
    signal: controller.signal,
  };
  void (async () => {
    let result: ToolResult;
    try {
      result = await run(rest, background);
    } catch (error) {
      result = fail(error);
    }
    store.untrack(task.taskId);
    if (controller.signal.aborted) return; // cancelled or expired
    try {
      await requestStore.storeTaskResult(
        task.taskId,
        result.isError ? "failed" : "completed",
        result,
      );
    } catch (error) {
      logger.debug("task result dropped", {
        taskId: task.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  logger.info("task started", { tool: spec.name, taskId: task.taskId });
  const body = {
    task,
    next: "Poll tasks/get with this taskId; tasks/result returns the tool result (kept 1 h); tasks/cancel stops it.",
  };
  return {
    ...ok(body),
    // M-6: a tool with an output schema must answer with structuredContent;
    // withTaskOutput makes every declared field optional for this tool.
    ...(spec.output ? { structuredContent: { ...body } } : {}),
    _meta: { [RELATED_TASK_META_KEY]: { taskId: task.taskId } },
  };
}
