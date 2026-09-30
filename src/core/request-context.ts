import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request profile context (MI-3). The manifest layer wraps a tool call in
 * runWithProfile() when the model passes an explicit `instance`; everything
 * below (config → auth → http → policy → caches) resolves the profile through
 * activeProfile() at call time, so no api/ signature ever threads it.
 */
const als = new AsyncLocalStorage<string>();

export function runWithProfile<T>(profile: string, fn: () => T): T {
  return als.run(profile, fn);
}

/** The profile of the current tool call, when one was explicitly requested. */
export function currentRequestProfile(): string | undefined {
  return als.getStore();
}

/**
 * H-5 — the MCP session id of the current tool call (HTTP transport only; a
 * stdio call has none). The manifest layer wraps the call so the write journal
 * can record which client made a change without threading it through api/.
 */
const clientAls = new AsyncLocalStorage<string>();

export function runWithClient<T>(client: string | undefined, fn: () => T): T {
  return client ? clientAls.run(client, fn) : fn();
}

/** The session id of the client making the current tool call, when known. */
export function currentClient(): string | undefined {
  return clientAls.getStore();
}

/**
 * S-2 — the name of the tool handling the current call. The manifest layer
 * wraps every call so the write journal records which tool made a change:
 * revert decides from it how a line can be inverted (a Table API create vs an
 * attachment upload that names its parent record, for example).
 */
const toolAls = new AsyncLocalStorage<string>();

export function runWithTool<T>(tool: string, fn: () => T): T {
  return toolAls.run(tool, fn);
}

/** The name of the tool making the current call, when known. */
export function currentTool(): string | undefined {
  return toolAls.getStore();
}

/**
 * M-3 — the per-call context the manifest layer opens around every tool call:
 * the correlation fields every log line carries (`profile`, `requestId`,
 * `sessionId`, `tool`), plus the SDK's cancellation signal and the progress
 * sink bound to the call's `progressToken`. Like the profile context above,
 * nothing below the manifest layer threads it: snRequest picks the signal up
 * for every request of the call, logging.ts stamps the correlation fields, and
 * api/ code reports progress through core/progress.ts.
 */
export interface ProgressUpdate {
  /** Monotonic counter of work done (items, pages, records, documents). */
  progress: number;
  /** Total units of work, when known. */
  total?: number;
  /** One short human line — e.g. the section or path just finished. */
  message?: string;
}

export type ProgressSink = (update: ProgressUpdate) => void;

export interface CallContext {
  /** The JSON-RPC id of the tools/call request, or a generated local id. */
  requestId: string;
  /** MCP session id (HTTP transport only). */
  sessionId?: string;
  tool: string;
  /** The profile the call resolved to (an explicit `instance` or the active one). */
  profile?: string;
  /** Aborted when the client cancels the call (notifications/cancelled). */
  signal?: AbortSignal;
  /** Present only when the client sent a progressToken. */
  progress?: ProgressSink;
  /**
   * H-3: set on a destructive-apply tool's call while SN_DESTRUCTIVE_CONFIRM
   * is on — the hash of the arguments a plan preview binds its plan_token to,
   * and, once an apply was confirmed, the consumed token (journaled).
   */
  plan?: { argsHash: string; token?: string };
}

const callAls = new AsyncLocalStorage<CallContext>();

export function runWithCall<T>(context: CallContext, fn: () => T): T {
  return callAls.run(context, fn);
}

/**
 * H-7 — the HTTP session a request belongs to. The transport opens it around
 * every request it hands to a session (tool calls, resources, prompts,
 * notifications alike), so the session's active profile (`use_instance` in
 * HTTP mode), its MCP server (elicitation, list-changed notifications) and
 * its log bridge resolve per session without threading anything. A stdio
 * process never opens one.
 */
export interface SessionScope {
  /** The MCP session id (`mcp-session-id`); empty until initialize completes. */
  id: string;
  /** The profile `use_instance` selected for this session only. */
  profile?: string;
  /** The session's McpServer (typed loosely: core/ cannot import mcp/). */
  server?: unknown;
  /** The session's MCP log sink (a per-session log bridge). */
  logSink?: unknown;
}

const sessionAls = new AsyncLocalStorage<SessionScope>();

export function runInSession<T>(scope: SessionScope, fn: () => T): T {
  return sessionAls.run(scope, fn);
}

/** The HTTP session of the current request, when there is one. */
export function currentSession(): SessionScope | undefined {
  return sessionAls.getStore();
}

/** The context of the tool call in progress, when there is one. */
export function currentCall(): CallContext | undefined {
  return callAls.getStore();
}

/** The cancellation signal of the current tool call, when there is one. */
export function currentSignal(): AbortSignal | undefined {
  return callAls.getStore()?.signal;
}

/**
 * The correlation fields for a log line, or undefined outside a tool call.
 * The innermost explicit profile wins (compare_instances runs each side in its
 * own profile context), then the profile the call resolved to.
 */
export function logContext(): Record<string, string> | undefined {
  const call = callAls.getStore();
  if (!call) return undefined;
  const profile = als.getStore() ?? call.profile;
  return {
    ...(profile ? { profile } : {}),
    requestId: call.requestId,
    ...(call.sessionId ? { sessionId: call.sessionId } : {}),
    tool: call.tool,
  };
}
