import { createServer, type Server } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getTransport,
  getHttpPort,
  getHttpHost,
  getHttpToken,
  metricsEnabled,
} from "../core/settings.js";
import { logger } from "../core/logging.js";
import { dispose } from "../core/lifecycle.js";
import { renderPrometheus } from "./observability.js";

/**
 * Constant-time bearer check for the HTTP transport: true only when the
 * Authorization header is exactly `Bearer <token>`. Exported for testing.
 */
export function httpAuthorized(
  authHeader: string | undefined,
  token: string,
): boolean {
  const expected = `Bearer ${token}`;
  const got = authHeader ?? "";
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

/**
 * DF-6 / A2-4 — transport selection, extracted from index.ts.
 *
 * Default `stdio`: one local client, no network surface. With `SN_TRANSPORT=http`
 * the server listens over **Streamable HTTP** on `SN_PORT`, turning a local-only
 * tool into something the official ServiceNow MCP *Client* app and remote clients
 * can consume — the competitor becomes a supplier. Securing the HTTP endpoint
 * (TLS, authentication, network exposure) is the operator's responsibility; the
 * server binds it as-is.
 */
export async function connectTransport(server: McpServer): Promise<string> {
  if (getTransport() === "http") {
    await startHttp(server);
    return "http";
  }
  await server.connect(new StdioServerTransport());
  return "stdio";
}

/** The listening HTTP server, when the http transport is active. */
let httpListener: Server | null = null;

/**
 * E-9: stop the HTTP listener (no-op for stdio or when nothing is listening).
 * Used by the signal shutdown path and by tests so no server handle outlives
 * the run.
 */
export async function closeHttpTransport(): Promise<void> {
  const listener = httpListener;
  if (!listener) return;
  httpListener = null;
  await new Promise<void>((resolve) => {
    listener.close(() => resolve());
    listener.closeAllConnections();
  });
}

/** True for `GET /metrics` (any query string). Exported for testing. */
export function isMetricsRequest(
  method: string | undefined,
  url: string | undefined,
): boolean {
  return method === "GET" && (url ?? "").split("?")[0] === "/metrics";
}

async function startHttp(server: McpServer): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    // E-9: a client ending its session (DELETE) leaves the process running for
    // the next one — dispose the runtime's state (tokens, schema cache,
    // telemetry, plugin availability) so nothing leaks across sessions.
    onsessionclosed: () => dispose(),
  });
  await server.connect(transport);

  const port = getHttpPort();
  const host = getHttpHost();
  const token = getHttpToken();
  // E-5: Prometheus metrics are served only behind the bearer token — the
  // counters name hosts and tools, so an open /metrics would leak topology.
  const serveMetrics = metricsEnabled() && Boolean(token);
  if (metricsEnabled() && !token) {
    logger.warn(
      "SN_METRICS is set but SN_HTTP_TOKEN is not — GET /metrics stays disabled",
    );
  }
  const httpServer = createServer((req, res) => {
    if (token && !httpAuthorized(req.headers.authorization, token)) {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("Unauthorized");
      return;
    }
    if (serveMetrics && isMetricsRequest(req.method, req.url)) {
      let body: string;
      try {
        body = renderPrometheus();
      } catch (error) {
        logger.error("Rendering /metrics failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        res.writeHead(500).end();
        return;
      }
      res
        .writeHead(200, {
          "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
          "Cache-Control": "no-store",
        })
        .end(body);
      return;
    }
    void transport.handleRequest(req, res).catch((error) => {
      logger.error("HTTP request handling failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  // Resolve only once the port is bound so a bind failure (EADDRINUSE, a
  // privileged port) surfaces as a rejected startup instead of a stray
  // 'error' event.
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      httpListener = httpServer;
      logger.info("HTTP transport listening", {
        host,
        port,
        authenticated: Boolean(token),
      });
      resolve();
    });
  });
}
