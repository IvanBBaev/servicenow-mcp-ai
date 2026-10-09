import type { IncomingMessage, ServerResponse } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
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
import { MAX_INIT_BODY_BYTES } from "./http-sessions.js";

/**
 * H-7 (N-35 step 2) — the stateless 2026-07-28 leg of the HTTP transport.
 *
 * A modern request carries its protocol envelope in `_meta` and needs no
 * session: the SDK's `createMcpHandler` builds one McpServer per request from
 * the factory, serves the exchange and closes it. Every request runs on its
 * own child runtime (`createRuntime({ parent })`), disposed when its server
 * closes, so plan tokens, package toggles and the `use_instance` profile of
 * one request never leak into another. 2025-era traffic never reaches this
 * leg (`legacy: 'reject'`): `HttpSessionManager` keeps serving it with
 * sessions.
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
    this.node = toNodeHandler(this.handler, {
      onerror,
      maxRequestBodySize: MAX_INIT_BODY_BYTES,
    });
  }

  /** Requests in flight. */
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
    this.open += 1;
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      this.open -= 1;
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

  /** Abort in-flight modern exchanges and close their servers. */
  close(): Promise<void> {
    return this.handler.close();
  }

  /** The McpServerFactory: runs inside `handle`'s request context. */
  private build(ctx: McpRequestContext): McpServer {
    const runtime = currentRuntime();
    const server = this.options.factory(runtime, ctx);
    const scope = currentSession();
    if (scope) {
      scope.server = server;
      scope.logSink = createLogBridge(server.server);
    }
    // The handler chains its own onclose after ours.
    const previous = server.server.onclose;
    server.server.onclose = () => {
      previous?.();
      void runtime.dispose();
    };
    return server;
  }
}
