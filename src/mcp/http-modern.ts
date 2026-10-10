import type { IncomingMessage, ServerResponse } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  isJSONRPCRequest,
  type McpHttpHandler,
  type McpRequestContext,
  type McpServer,
} from "@modelcontextprotocol/server";
import {
  createRuntime,
  currentRuntime,
  runWithRuntime,
  type Runtime,
} from "../core/runtime.js";
import {
  currentSession,
  runInSession,
  type SessionScope,
} from "../core/request-context.js";
import { logger } from "../core/logging.js";
import { createLogBridge } from "./log-bridge.js";
import { taskWorkSettled } from "./tasks.js";
import { guardListenFetch } from "./listen.js";
import { MAX_INIT_BODY_BYTES } from "./http-sessions.js";

/**
 * H-7 (N-35 step 2) — the stateless 2026-07-28 leg of the HTTP transport.
 *
 * A modern request carries its protocol envelope in `_meta` and needs no
 * session: the SDK's `createMcpHandler` builds one McpServer per request from
 * the factory, serves the exchange and closes it. Every request runs on its
 * own child runtime (`createRuntime({ parent })`), disposed when its server
 * closes, so plan tokens, package toggles and the `use_instance` profile of
 * one request never leak into another. A task the request started (M-9,
 * ext-tasks) outlives the response: the runtime is disposed once its
 * background work has settled, and the task itself lives on the parent. 2025-era traffic never reaches this
 * leg (`legacy: 'reject'`): `HttpSessionManager` keeps serving it with
 * sessions.
 *
 * A subscriptions/listen stream (N-35) is not a request in flight: it stays
 * open until the client or the server ends it, so a graceful shutdown does
 * not wait for it. `close()` ends it instead — the completion result and its
 * cancellation (listen.ts) — and waits, bounded, until both are flushed.
 */

/** Builds one McpServer for one modern request on the request's runtime. */
export type ModernServerFactory = (
  runtime: Runtime,
  ctx: McpRequestContext,
) => McpServer;

export interface ModernHttpOptions {
  factory: ModernServerFactory;
  /** The process runtime the request runtimes delegate shared state to. */
  parent: Runtime;
  /** SSE keep-alive interval in ms; 0 disables it. */
  keepAliveMs: number;
}

export class ModernHttpHandler {
  private readonly handler: McpHttpHandler;
  private readonly node: ReturnType<typeof toNodeHandler>;
  /** Requests in flight — what a graceful shutdown waits for. */
  private open = 0;
  /** Open listen streams, each settling once its response has closed. */
  private readonly listens = new Map<ServerResponse, Promise<void>>();

  constructor(private readonly options: ModernHttpOptions) {
    const onerror = (error: Error): void => {
      logger.warn("HTTP modern request failed", { error: error.message });
    };
    this.handler = createMcpHandler((ctx) => this.build(ctx), {
      legacy: "reject",
      keepAliveMs: options.keepAliveMs,
      maxRequestBodySize: MAX_INIT_BODY_BYTES,
      onerror,
    });
    // N-35: the listen guards wrap the modern leg only; 2025 sessions
    // (http-sessions.ts) never pass through this handler.
    this.node = toNodeHandler(
      { ...this.handler, fetch: guardListenFetch(this.handler.fetch) },
      {
        onerror,
        maxRequestBodySize: MAX_INIT_BODY_BYTES,
      },
    );
  }

  /** Requests in flight (open listen streams excluded). */
  get inFlight(): number {
    return this.open;
  }

  /** Serve one modern request; `body` is the already parsed JSON body. */
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    body?: unknown,
  ): Promise<void> {
    const runtime = createRuntime({ parent: this.options.parent });
    const scope: SessionScope = { id: "" };
    const listen = isListenRequest(body);
    if (listen) {
      this.listens.set(
        res,
        new Promise((resolve) => res.once("close", () => resolve())),
      );
    } else {
      this.open += 1;
    }
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      if (listen) this.listens.delete(res);
      else this.open -= 1;
      // The factory never ran (a rejected request): nothing closes the
      // server that would dispose the runtime, so release it here.
      if (!scope.server) void runtime.dispose();
    };
    res.once("close", done);
    try {
      await runInSession(scope, () =>
        runWithRuntime(runtime, () => this.node(req, res, body)),
      );
    } finally {
      if (res.writableEnded) done();
    }
  }

  /**
   * Abort in-flight modern exchanges and close their servers; end every
   * open listen stream gracefully and wait up to `flushMs` for those
   * responses to close, so the completion and cancellation frames reach the
   * client before the transport drops its connections.
   */
  async close(flushMs = 0): Promise<void> {
    const listening = [...this.listens.values()];
    await this.handler.close();
    if (!listening.length) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(listening),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, flushMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /** The McpServerFactory: runs inside `handle`'s request context. */
  private build(ctx: McpRequestContext): McpServer {
    const runtime = currentRuntime();
    const server = this.options.factory(runtime, ctx);
    const scope = currentSession();
    if (scope) {
      scope.server = server;
      scope.logSink = createLogBridge(server.server);
      // N-17: an OAuth caller is keyed by its subject, so one user's plan
      // token cannot be redeemed by another user of the same client.
      const subject = ctx.authInfo?.extra?.subject;
      if (typeof subject === "string") {
        scope.subject = subject;
        scope.principal = `modern:sub:${subject}`;
        const login = ctx.authInfo?.extra?.login;
        if (typeof login === "string") scope.login = login;
      } else {
        scope.principal = `modern:${ctx.authInfo?.clientId ?? ""}`;
      }
    }
    // The handler chains its own onclose after ours.
    const previous = server.server.onclose;
    server.server.onclose = () => {
      previous?.();
      void taskWorkSettled(runtime).then(() => runtime.dispose());
    };
    return server;
  }
}

/** True for a subscriptions/listen request body. */
function isListenRequest(body: unknown): boolean {
  return isJSONRPCRequest(body) && body.method === "subscriptions/listen";
}
