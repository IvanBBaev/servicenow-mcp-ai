import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  createRuntime,
  runWithRuntime,
  type Runtime,
} from "../core/runtime.js";
import {
  currentSession,
  runInSession,
  type SessionScope,
} from "../core/request-context.js";
import { logger, type LogSink } from "../core/logging.js";
import { createLogBridge } from "./log-bridge.js";

/**
 * H-7 — HTTP session management (closes the single-transport design of DF-6).
 *
 * Every MCP session gets its own `StreamableHTTPServerTransport`, its own
 * `McpServer` (so list-changed notifications, the logging level and
 * elicitations reach only the client that owns them) and its own session
 * runtime — a child of the process runtime (`createRuntime({ parent })`):
 * package toggles, plan tokens, tasks and write caps are per session, while
 * the connection pools, breakers, token and schema caches stay shared and are
 * keyed by profile + host.
 *
 * A session is created by an `initialize` POST without a session id, dropped
 * on DELETE, and closed by the sweeper once it has been idle (no request in
 * flight, none started) for the TTL. A request for an unknown or expired
 * session gets 404 / -32001, which tells a client to re-initialize.
 *
 * Every request handed to a session runs inside `runInSession` and
 * `runWithRuntime`, so the session's profile (`use_instance` over HTTP), its
 * server and its log bridge resolve through the request context.
 */

/** Builds the per-session McpServer on the session's runtime. */
export type ServerFactory = (runtime: Runtime) => McpServer;

/** The largest initialize body read before the transport sees it. */
export const MAX_INIT_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpSessionOptions {
  factory: ServerFactory;
  /** The process runtime the session runtimes delegate shared state to. */
  parent: Runtime;
  /** Idle TTL in ms; 0 = sessions live until DELETE. */
  ttlMs: number;
  /** SSE keep-alive interval in ms; 0 disables it. */
  keepAliveMs: number;
  /** Cap on concurrent sessions; a new initialize beyond it gets 503. */
  maxSessions: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

interface HttpSession {
  scope: SessionScope;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  runtime: Runtime;
  lastSeen: number;
  /** Open requests of any kind (an SSE GET stream stays open). */
  open: number;
  /** POST requests in flight — what a graceful shutdown waits for. */
  posts: number;
  closed: boolean;
}

/** The manager of the running HTTP transport, for get_status. */
let active: HttpSessionManager | null = null;

/** H-7 — the calling session and the open-session count, for get_status. */
export function httpSessionInfo(): { sessions: number; sessionId?: string } {
  const id = currentSession()?.id;
  return { sessions: active?.size ?? 0, ...(id ? { sessionId: id } : {}) };
}

export function jsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res
    .writeHead(status, { "Content-Type": "application/json", ...headers })
    .end(
      JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
    );
}

class BodyTooLargeError extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_INIT_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const isInitialize = (body: unknown): boolean =>
  Array.isArray(body)
    ? body.some((m) => isInitializeRequest(m))
    : isInitializeRequest(body);

export class HttpSessionManager {
  private readonly sessions = new Map<string, HttpSession>();
  /** Sessions being initialized (not yet in the map), for the cap. */
  private pending = 0;
  private sweeper: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly options: HttpSessionOptions) {
    this.now = options.now ?? Date.now;
    // The status tool reads the live manager through this module handle.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    active = this;
    if (options.ttlMs > 0) {
      this.sweeper = setInterval(
        () => void this.sweep(),
        Math.min(options.ttlMs, 60_000),
      );
      this.sweeper.unref();
    }
  }

  /** Open sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** POST requests in flight across all sessions. */
  get inFlightPosts(): number {
    let n = 0;
    for (const s of this.sessions.values()) n += s.posts;
    return n;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  /** Route one MCP request (anything that is not a health or metrics probe). */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const header = req.headers["mcp-session-id"];
    const id = Array.isArray(header) ? header[0] : header;
    if (id) {
      const session = this.sessions.get(id);
      if (!session) {
        jsonRpcError(res, 404, -32001, "Session not found");
        return;
      }
      await this.dispatch(session, req, res);
      return;
    }
    if (req.method !== "POST") {
      jsonRpcError(
        res,
        400,
        -32000,
        "Bad Request: Mcp-Session-Id header is required",
      );
      return;
    }
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        jsonRpcError(res, 413, -32000, "Request body too large");
      } else {
        jsonRpcError(res, 400, -32700, "Parse error: invalid JSON");
      }
      return;
    }
    if (!isInitialize(body)) {
      jsonRpcError(
        res,
        400,
        -32000,
        "Bad Request: no session — send initialize first",
      );
      return;
    }
    if (this.sessions.size + this.pending >= this.options.maxSessions) {
      jsonRpcError(res, 503, -32000, "Too many open sessions", {
        "Retry-After": "5",
      });
      return;
    }
    await this.create(req, res, body);
  }

  private async create(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    this.pending += 1;
    const runtime = createRuntime({ parent: this.options.parent });
    const scope: SessionScope = { id: "" };
    let session: HttpSession | undefined;
    try {
      const server = runWithRuntime(runtime, () =>
        this.options.factory(runtime),
      );
      scope.server = server;
      scope.logSink = createLogBridge(server.server);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        keepAliveMs: this.options.keepAliveMs,
        onsessioninitialized: (id) => {
          scope.id = id;
          this.sessions.set(id, session!);
          logger.info("HTTP session opened", {
            sessionId: id,
            sessions: this.sessions.size,
          });
        },
      });
      session = {
        scope,
        transport,
        server,
        runtime,
        lastSeen: this.now(),
        open: 0,
        posts: 0,
        closed: false,
      };
      const created = session;
      // Set before connect: the protocol chains its own onclose after ours.
      transport.onclose = () => void this.close(created, "closed");
      await server.connect(transport);
      await this.dispatch(created, req, res, body);
    } finally {
      this.pending -= 1;
    }
    // A failed initialize (bad protocol version, a transport error) never
    // got a session id — release what was built for it.
    if (session && !scope.id) await this.close(session, "initialize failed");
  }

  private async dispatch(
    session: HttpSession,
    req: IncomingMessage,
    res: ServerResponse,
    body?: unknown,
  ): Promise<void> {
    const isPost = req.method === "POST";
    session.open += 1;
    if (isPost) session.posts += 1;
    session.lastSeen = this.now();
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      session.open -= 1;
      if (isPost) session.posts -= 1;
      session.lastSeen = this.now();
    };
    res.once("close", done);
    try {
      await runInSession(session.scope, () =>
        runWithRuntime(session.runtime, () =>
          session.transport.handleRequest(req, res, body),
        ),
      );
    } finally {
      // handleRequest resolves once the response is handed over; an SSE
      // stream stays open until `close`, which settles it then.
      if (res.writableEnded) done();
    }
  }

  /**
   * Close sessions idle for longer than the TTL (none of their requests open).
   * Returns the ids closed. Called by the interval sweeper; exported for tests.
   */
  async sweep(now: number = this.now()): Promise<string[]> {
    const ttl = this.options.ttlMs;
    if (ttl <= 0) return [];
    const expired = [...this.sessions.values()].filter(
      (s) => s.open === 0 && now - s.lastSeen >= ttl,
    );
    for (const s of expired) await this.close(s, "idle TTL");
    return expired.map((s) => s.scope.id);
  }

  private async close(session: HttpSession, reason: string): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    if (session.scope.id) this.sessions.delete(session.scope.id);
    try {
      await session.server.close();
    } catch (error) {
      logger.warn("closing an HTTP session failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Only the session's own state — the shared process parts stay.
    await session.runtime.dispose();
    if (session.scope.id) {
      logger.info("HTTP session closed", {
        sessionId: session.scope.id,
        reason,
        sessions: this.sessions.size,
      });
    }
  }

  /** Stop the sweeper and close every session. */
  async closeAll(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    await Promise.all(
      [...this.sessions.values()].map((s) => this.close(s, "shutdown")),
    );
    if (active === this) active = null;
  }
}

/**
 * The process-wide log sink over HTTP: each line goes to the MCP log bridge
 * of the session the current request belongs to (its own logging level and
 * rate limit); a line logged outside any session reaches no client.
 */
export const sessionLogSink: LogSink = (level, message, fields) => {
  const sink = currentSession()?.logSink as LogSink | undefined;
  sink?.(level, message, fields);
};
