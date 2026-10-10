import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  McpServer,
  ServerContext,
  ServerOptions,
} from "@modelcontextprotocol/server";
import {
  CLIENT_CAPABILITIES_META_KEY,
  LOG_LEVEL_META_KEY,
  MissingRequiredClientCapabilityError,
  ProtocolError,
  ProtocolErrorCode,
  RELATED_TASK_META_KEY,
  type CallToolResult,
  type Request,
  type RequestId,
  type Result,
  type Task,
} from "@modelcontextprotocol/server";
import { logger } from "../core/logging.js";
import { readBool } from "../core/settings-manifest.js";
import { redactValue } from "../core/redaction.js";
import {
  currentRuntime,
  defineRuntimePart,
  type Runtime,
} from "../core/runtime.js";
import type { AnyToolSpec, CallExtra, SpecResult } from "./define.js";
import { isPendingInput } from "./input.js";
import { fail, ok, type ToolResult } from "./result.js";

/**
 * M-9 — long-running operations as MCP tasks (EXPERIMENTAL).
 *
 * Behind `SN_EXPERIMENTAL_TASKS=1` the server installs the standard
 * `tasks/get`, `tasks/result`, `tasks/list` and `tasks/cancel` handlers
 * (installTaskHandlers — SDK v2 has no task runtime, N-35, so they are ours,
 * on the 2025-11-25 wire vocabulary), and the long-running tools gain an
 * optional `run_as_task:true` argument. Such a call returns a task handle at
 * once — `{ task: { taskId, status, ttl, pollInterval, … } }` with
 * `_meta["io.modelcontextprotocol/related-task"]` — and the work continues in
 * the background; `tasks/result` later returns the tool result carrying the
 * same `_meta` key.
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
 * The 2026-07-28 wire speaks the tasks extension instead (ext-tasks,
 * wireModernTasks): the server declares `extensions[TASKS_EXTENSION]`, a
 * client opts in per request in its envelope, and creating a task is the
 * server's choice — `run_as_task` is stripped there. tasks/get answers the
 * flat task (`ttlMs`, `pollIntervalMs`, `result` or `error`), tasks/update
 * and tasks/cancel answer `{}`, and the background run sends no progress or
 * log notifications. A modern request has no session, so its tasks live in
 * the parent runtime's store, bound to the principal (principalOf).
 *
 * With the flag off nothing here is reachable: no task store, no `tasks`
 * capability, and the input schemas (tools/list) are byte-identical to a build
 * without this module. Removable without a major if the SDK drops the API.
 */

/** The 2025-11-25 task statuses a task never leaves. */
const TERMINAL: ReadonlySet<Task["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** True when `status` is final (completed, failed or cancelled). */
export function isTerminal(status: Task["status"]): boolean {
  return TERMINAL.has(status);
}

/** What a caller may ask of a new task (`ttl` is capped by the store). */
export interface CreateTaskOptions {
  ttl?: number | null;
  pollInterval?: number;
}

/**
 * The task store bound to one tools/call request (its id, the request and
 * its session) — the shape SDK v1 handed tools as `extra.taskStore`.
 */
export interface RequestTaskStore {
  createTask(options: CreateTaskOptions): Promise<Task>;
  storeTaskResult(
    taskId: string,
    status: "completed" | "failed",
    result: Result,
  ): Promise<void>;
}

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

/** The JSON-RPC error a failed 2026-07-28 task carries (ext-tasks). */
export interface TaskError {
  code: number;
  message: string;
  data?: unknown;
}

interface Entry {
  task: Task;
  request: Request;
  requestId: RequestId;
  sessionId?: string;
  result?: Result;
  /** Set on a `failed` task of the 2026-07-28 extension. */
  error?: TaskError;
  /** Epoch ms after which the entry is dropped. */
  expiresAt: number;
}

/**
 * The SDK TaskStore of one runtime: in-memory, lazily expired (every access
 * sweeps — no timers to leak), TTL capped, results redacted, session-bound.
 * It also owns the AbortController of each running task so `tasks/cancel`
 * (a status update to `cancelled`) and TTL expiry stop the work.
 */
export class SnTaskStore {
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

  /**
   * Fail `taskId` with a JSON-RPC error (the 2026-07-28 extension: `failed`
   * is for errors only; a tool result, even `isError`, is `completed`).
   */
  storeTaskError(taskId: string, error: TaskError, sessionId?: string): void {
    const entry = this.mustGet(taskId, sessionId);
    if (isTerminal(entry.task.status)) {
      throw new Error(
        `Task ${taskId} is already ${entry.task.status}; its result is final.`,
      );
    }
    entry.error = error;
    entry.task.status = "failed";
    // ext-tasks: a failed task says why in statusMessage too.
    entry.task.statusMessage = error.message;
    entry.task.lastUpdatedAt = this.stamp();
    this.running.delete(taskId);
  }

  /**
   * The task as the 2026-07-28 extension shows it (tasks/get): `ttlMs` and
   * `pollIntervalMs`, plus `result` once completed or `error` once failed.
   * Null when unknown, expired or bound to another principal.
   */
  modernTask(taskId: string, sessionId?: string): ModernTask | null {
    const entry = this.entry(taskId, sessionId);
    return entry ? toModernTask(entry) : null;
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

/** A task on the 2026-07-28 wire (ext-tasks `Task`). */
export interface ModernTask {
  taskId: string;
  status: Task["status"];
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
  result?: Result;
  error?: TaskError;
}

function toModernTask(entry: Entry): ModernTask {
  const { task } = entry;
  return {
    taskId: task.taskId,
    status: task.status,
    ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttl ?? null,
    ...(task.pollInterval !== undefined
      ? { pollIntervalMs: task.pollInterval }
      : {}),
    ...(task.status === "completed" && entry.result
      ? { result: entry.result }
      : {}),
    ...(task.status === "failed" && entry.error ? { error: entry.error } : {}),
  };
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
 * McpServer options with the `tasks` capability (list + cancel) merged in
 * when the flag is on; installTaskHandlers serves it. Returns `options`
 * unchanged when the flag is off.
 */
export function withTaskSupport(options: ServerOptions): ServerOptions {
  if (!tasksEnabled()) return options;
  return {
    ...options,
    capabilities: {
      ...options.capabilities,
      tasks: { list: {}, cancel: {} },
      // 2026-07-28: the tasks extension (ext-tasks), served by
      // wireModernTasks and the modern branches of installTaskHandlers.
      extensions: {
        ...options.capabilities?.extensions,
        [TASKS_EXTENSION]: {},
      },
    },
  };
}

/** `store` bound to one tools/call request (RequestTaskStore). */
export function requestTaskStore(
  store: SnTaskStore,
  requestId: RequestId,
  request: Request,
  sessionId?: string,
): RequestTaskStore {
  return {
    createTask: (options) =>
      store.createTask(options, requestId, request, sessionId),
    storeTaskResult: (taskId, status, result) =>
      store.storeTaskResult(taskId, status, result, sessionId),
  };
}

const taskIdParams = z.looseObject({ taskId: z.string() });
const listParams = z.looseObject({ cursor: z.string().optional() }).optional();
const updateParams = z.looseObject({
  taskId: z.string(),
  inputResponses: z.record(z.string(), z.unknown()).optional(),
});

/** A task id unknown to (or hidden from) the session: -32602. */
function notFound(taskId: string): ProtocolError {
  return new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `Task ${taskId} not found (or expired).`,
  );
}

/** Resolve after `ms`, or at once when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** The 2026-07-28 tasks extension identifier (ext-tasks). */
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for a request that carries the 2026-07-28 per-request envelope. */
function isModernRequest(ctx: ServerContext): boolean {
  return ctx.mcpReq.envelope !== undefined;
}

/**
 * True when a request's `_meta` (its 2026-07-28 envelope) declares the tasks
 * extension in its clientCapabilities. Shared by the handlers (through
 * clientDeclaresTasks) and the raw-message listen guard (listen.ts).
 */
export function envelopeDeclaresTasks(envelope: unknown): boolean {
  const capabilities = isRecord(envelope)
    ? envelope[CLIENT_CAPABILITIES_META_KEY]
    : undefined;
  if (!isRecord(capabilities) || !isRecord(capabilities.extensions)) {
    return false;
  }
  return isRecord(capabilities.extensions[TASKS_EXTENSION]);
}

/** True when the request's envelope declares the tasks extension. */
export function clientDeclaresTasks(ctx: ServerContext): boolean {
  return envelopeDeclaresTasks(ctx.mcpReq.envelope);
}

/** The -32021 error for a client that did not declare the tasks extension. */
export function tasksExtensionRequired(
  message: string,
): MissingRequiredClientCapabilityError {
  return new MissingRequiredClientCapabilityError(
    { requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } },
    message,
  );
}

/** -32021 for a modern tasks/* request whose client did not declare it. */
function requireTasksDeclared(ctx: ServerContext): void {
  if (clientDeclaresTasks(ctx)) return;
  throw tasksExtensionRequired("Missing required client capability");
}

/**
 * Who owns a 2026-07-28 task: the authenticated client (bearer `clientId`),
 * or the one anonymous principal of an unauthenticated server. Modern
 * requests have no session, so this is the binding a later tasks/get is
 * checked against. The prefix keeps it apart from 2025 session ids.
 */
function principalOf(ctx: ServerContext): string {
  return `modern:${ctx.http?.authInfo?.clientId ?? ""}`;
}

/**
 * Serve tasks/get, tasks/result, tasks/list and tasks/cancel from the
 * runtime's store (N-35: SDK v1 installed these from `taskStore`; v2 has no
 * task runtime). Session-bound like the store. tasks/result waits for a
 * final status, as the 2025-11-25 spec asks, until the request is cancelled.
 * A no-op when the flag is off.
 */
export function installTaskHandlers(server: McpServer, runtime: Runtime): void {
  if (!tasksEnabled()) return;
  const store = taskStoreFor(runtime);
  const home = runtime.parent ?? runtime;
  const proto = server.server;
  proto.setRequestHandler(
    "tasks/get",
    { params: taskIdParams },
    async ({ taskId }, ctx: ServerContext) => {
      if (isModernRequest(ctx)) {
        requireTasksDeclared(ctx);
        const task = taskStoreFor(home).modernTask(taskId, principalOf(ctx));
        if (!task) throw notFound(taskId);
        return { ...task };
      }
      const task = await store.getTask(taskId, ctx.sessionId);
      if (!task) throw notFound(taskId);
      return { ...task };
    },
  );
  proto.setRequestHandler(
    "tasks/result",
    { params: taskIdParams },
    async ({ taskId }, ctx: ServerContext) => {
      for (;;) {
        const task = await store.getTask(taskId, ctx.sessionId);
        if (!task) throw notFound(taskId);
        if (task.status === "cancelled") {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Task ${taskId} was cancelled; it has no result.`,
          );
        }
        if (isTerminal(task.status)) {
          const result = await store.getTaskResult(taskId, ctx.sessionId);
          return {
            ...result,
            _meta: {
              ...result._meta,
              [RELATED_TASK_META_KEY]: { taskId },
            },
          };
        }
        if (ctx.mcpReq.signal.aborted) throw notFound(taskId);
        await pause(
          task.pollInterval ?? TASK_POLL_INTERVAL_MS,
          ctx.mcpReq.signal,
        );
      }
    },
  );
  proto.setRequestHandler(
    "tasks/list",
    { params: listParams },
    (params, ctx: ServerContext) =>
      store.listTasks(params?.cursor, ctx.sessionId),
  );
  proto.setRequestHandler(
    "tasks/cancel",
    { params: taskIdParams },
    async ({ taskId }, ctx: ServerContext) => {
      if (isModernRequest(ctx)) {
        // ext-tasks: an empty ack; cancelling a final task is a no-op.
        requireTasksDeclared(ctx);
        const owner = principalOf(ctx);
        const modern = taskStoreFor(home);
        const task = modern.modernTask(taskId, owner);
        if (!task) throw notFound(taskId);
        if (!isTerminal(task.status)) {
          await modern.updateTaskStatus(taskId, "cancelled", undefined, owner);
        }
        return {};
      }
      const task = await store.getTask(taskId, ctx.sessionId);
      if (!task) throw notFound(taskId);
      if (isTerminal(task.status)) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Task ${taskId} is already ${task.status}; it cannot be cancelled.`,
        );
      }
      await store.updateTaskStatus(
        taskId,
        "cancelled",
        undefined,
        ctx.sessionId,
      );
      return { ...(await store.getTask(taskId, ctx.sessionId))! };
    },
  );
  // ext-tasks only. No task of this server ever asks for input, so there is
  // never an outstanding key: every response is ignored, as the spec asks.
  proto.setRequestHandler(
    "tasks/update",
    { params: updateParams },
    ({ taskId }, ctx: ServerContext) => {
      if (!isModernRequest(ctx)) {
        throw new ProtocolError(
          ProtocolErrorCode.MethodNotFound,
          "Method not found",
        );
      }
      requireTasksDeclared(ctx);
      if (!taskStoreFor(home).modernTask(taskId, principalOf(ctx))) {
        throw notFound(taskId);
      }
      return {};
    },
  );
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

/** M-3's CallExtra plus the request task store (registry.ts binds it). */
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
  run: (args: Record<string, unknown>, extra: CallExtra) => Promise<SpecResult>,
): Promise<SpecResult | TaskHandleResult> {
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
    ...(extra.input ? { input: extra.input } : {}),
    signal: controller.signal,
    background: true,
  };
  void (async () => {
    let result: ToolResult;
    try {
      const done = await run(rest, background);
      // MRTR: the request that could carry the answer has already returned.
      result = isPendingInput(done)
        ? fail(
            "This call needs the user's confirmation, which a background task cannot ask for. Nothing was changed.",
            {
              code: "CONFIRM_REQUIRED",
              hint: "Call the tool without run_as_task to confirm the change.",
            },
          )
        : done;
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
    ...(spec.output && readBool("SN_STRUCTURED")
      ? { structuredContent: { ...body } }
      : {}),
    _meta: { [RELATED_TASK_META_KEY]: { taskId: task.taskId } },
  };
}

/** The SDK's request-handler table (`Protocol._requestHandlers`). */
type RequestHandler = (
  request: unknown,
  ctx: ServerContext,
) => Promise<unknown>;

interface CallRequest {
  method: string;
  params: {
    name: string;
    arguments?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
}

/** Background task work per runtime, so its disposal can wait for it. */
const held = new WeakMap<Runtime, Set<Promise<void>>>();

function hold(runtime: Runtime, work: Promise<void>): void {
  let set = held.get(runtime);
  if (!set) {
    set = new Set();
    held.set(runtime, set);
  }
  set.add(work);
  void work.finally(() => set.delete(work));
}

/**
 * Resolves once every 2026-07-28 task started on `runtime` has finished. The
 * modern HTTP leg disposes a request's runtime only then: the task outlives
 * the request that created it (http-modern.ts).
 */
export async function taskWorkSettled(runtime: Runtime): Promise<void> {
  await Promise.all([...(held.get(runtime) ?? [])]);
}

/** `record` without `key` (the same object when it has none). */
function without<T extends Record<string, unknown>>(
  record: T | undefined,
  key: string,
): T | undefined {
  if (!record || !(key in record)) return record;
  const rest = { ...record };
  delete rest[key];
  return rest;
}

/** The call without `run_as_task` (a modern request never takes it). */
function withoutRunAsTask(request: CallRequest): CallRequest {
  const args = request.params.arguments;
  if (!args || !("run_as_task" in args)) return request;
  const rest = { ...args };
  delete rest.run_as_task;
  return { ...request, params: { ...request.params, arguments: rest } };
}

/**
 * True when a call of `name` with `args` becomes a task on the modern wire:
 * a registered, enabled task tool, query_table only with format:"file", and
 * not opted out with `run_as_task:false`.
 */
function createsTask(
  name: string,
  args: Record<string, unknown> | undefined,
  tools: Record<string, { enabled: boolean } | undefined>,
): boolean {
  if (!TASK_TOOLS.has(name) || !tools[name]?.enabled) return false;
  if (args?.run_as_task === false) return false;
  return name !== "servicenow_query_table" || args?.format === "file";
}

/**
 * The context the background work runs with: the task's own abort signal,
 * no progress token and no log level (ext-tasks: no notifications/progress
 * or notifications/message for a task), and a send path that goes nowhere
 * because the creating request has already been answered.
 */
function backgroundContext(
  ctx: ServerContext,
  signal: AbortSignal,
): ServerContext {
  const envelope = without(
    ctx.mcpReq.envelope as Record<string, unknown> | undefined,
    LOG_LEVEL_META_KEY,
  );
  const meta = without(ctx.mcpReq._meta, "progressToken");
  const mcpReq = {
    ...ctx.mcpReq,
    signal,
    notify: () => Promise.resolve(),
    log: () => Promise.resolve(),
  };
  if (envelope) mcpReq.envelope = envelope;
  if (meta) mcpReq._meta = meta;
  else delete mcpReq._meta;
  return { ...ctx, mcpReq };
}

/** A thrown error as the `error` of a failed task. */
function taskError(error: unknown): TaskError {
  if (error instanceof ProtocolError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data !== undefined ? { data: error.data } : {}),
    };
  }
  return {
    code: ProtocolErrorCode.InternalError,
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Run `call` to its end and record the outcome on the task. */
async function settleTask(
  store: SnTaskStore,
  taskId: string,
  owner: string,
  controller: AbortController,
  call: () => Promise<unknown>,
): Promise<void> {
  let outcome: { result: Result } | { error: TaskError };
  try {
    const done = await call();
    // A task tool never asks for input; should one, nobody can answer it.
    outcome = {
      result: isPendingInput(done)
        ? fail(
            "This call needs the user's confirmation, which a background task cannot ask for. Nothing was changed.",
            {
              code: "CONFIRM_REQUIRED",
              hint: "Call the tool with run_as_task:false to confirm the change.",
            },
          )
        : (done as Result),
    };
  } catch (error) {
    outcome = { error: taskError(error) };
  }
  store.untrack(taskId);
  if (controller.signal.aborted) return; // cancelled or expired
  try {
    // ext-tasks: a tool result, isError included, completes the task;
    // only a JSON-RPC error fails it.
    if ("result" in outcome) {
      await store.storeTaskResult(taskId, "completed", outcome.result, owner);
    } else {
      store.storeTaskError(taskId, outcome.error, owner);
    }
  } catch (error) {
    logger.debug("task result dropped", {
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * M-9 on the 2026-07-28 wire — the tasks extension (ext-tasks). Wraps the
 * protocol-level tools/call handler McpServer installed (the way
 * wireLeanToolsList wraps tools/list), so the background run still goes
 * through the SDK's input validation, output validation and projection and
 * yields a real CallToolResult.
 *
 * - A modern request never takes `run_as_task` (it is stripped): the
 *   extension makes task creation server-directed.
 * - A task tool called by a client whose envelope declares the extension
 *   answers `{ resultType: "task", taskId, status: "working", ttlMs,
 *   pollIntervalMs, … }` at once and runs in the background; the client polls
 *   tasks/get. `run_as_task:false` keeps a call synchronous.
 * - Without the declaration the call runs synchronously, as in core MCP.
 * - The task lives in the store of the parent (process) runtime, bound to
 *   the principal: a modern request has no session, and its own runtime ends
 *   with the response. That runtime's disposal waits for the work
 *   (taskWorkSettled).
 *
 * Call it after the tools are registered; a no-op when the flag is off.
 */
export function wireModernTasks(server: McpServer, runtime: Runtime): void {
  if (!tasksEnabled()) return;
  const handlers = (server.server as unknown as { _requestHandlers?: unknown })
    ._requestHandlers;
  if (!(handlers instanceof Map)) return;
  const original = (handlers as Map<string, RequestHandler>).get("tools/call");
  if (!original) return;
  const tools = (
    server as unknown as {
      _registeredTools: Record<string, { enabled: boolean } | undefined>;
    }
  )._registeredTools;
  const home = runtime.parent ?? runtime;
  const wrapped: RequestHandler = async (request, ctx) => {
    if (!isModernRequest(ctx)) return original(request, ctx);
    const { name, arguments: args } = (request as CallRequest).params;
    const call = withoutRunAsTask(request as CallRequest);
    if (!createsTask(name, args, tools) || !clientDeclaresTasks(ctx)) {
      return original(call, ctx);
    }
    const owner = principalOf(ctx);
    const store = taskStoreFor(home);
    const task = await store.createTask({}, ctx.mcpReq.id, call, owner);
    const controller = new AbortController();
    store.track(task.taskId, controller);
    const background: CallRequest = {
      ...call,
      params: {
        ...call.params,
        ...(call.params._meta
          ? { _meta: without(call.params._meta, "progressToken") }
          : {}),
      },
    };
    const bgCtx = backgroundContext(ctx, controller.signal);
    hold(
      runtime,
      settleTask(store, task.taskId, owner, controller, () =>
        original(background, bgCtx),
      ),
    );
    logger.info("task started", { tool: name, taskId: task.taskId });
    return { resultType: "task", ...store.modernTask(task.taskId, owner) };
  };
  server.server.setRequestHandler(
    "tools/call",
    async (request, ctx) =>
      // A CreateTaskResult is a valid tools/call answer on the 2026 wire;
      // the SDK's static result type predates the extension.
      (await wrapped(request, ctx)) as CallToolResult,
  );
}
