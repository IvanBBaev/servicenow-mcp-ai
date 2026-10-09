import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getTransport,
  getHttpPort,
  getHttpHost,
  getHttpToken,
  metricsEnabled,
  getHttpSessionTtlSec,
  getHttpKeepAliveMs,
  getHttpMaxSessions,
  getHttpAllowedHosts,
  getHttpAllowedOrigins,
  httpRequireToken,
} from "../core/settings.js";
import { logger, setLogSink } from "../core/logging.js";
import { currentRuntime } from "../core/runtime.js";
import { hasCredentials } from "../core/config.js";
import { renderPrometheus } from "./observability.js";
import {
  HttpSessionManager,
  jsonRpcError,
  sessionLogSink,
  type ServerFactory,
} from "./http-sessions.js";
import { testConnection, type ConnectionProbe } from "../api/diagnostics.js";

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
 * DF-6 / A2-4 / H-7 — transport selection.
 *
 * Default `stdio`: one local client, one McpServer, no network surface —
 * unchanged by H-7. With `SN_TRANSPORT=http` the server listens over
 * **Streamable HTTP** on `SN_PORT` with one transport and one McpServer per
 * MCP session (see `http-sessions.ts`), DNS-rebinding protection (Host and
 * Origin allow-lists), `/healthz` + `/readyz` probes and a graceful drain on
 * shutdown. TLS and network exposure remain the operator's responsibility.
 *
 * `server` is either a ready McpServer or a factory building one on a given
 * runtime. HTTP needs a factory to serve more than one session at a time; a
 * plain instance can back a single session only.
 */
export async function connectTransport(
  server: McpServer | ServerFactory,
): Promise<string> {
  const factory: ServerFactory =
    typeof server === "function" ? server : () => server;
  if (getTransport() === "http") {
    await startHttp(factory);
    return "http";
  }
  await factory(currentRuntime()).connect(new StdioServerTransport());
  return "stdio";
}

/** The listening HTTP server, when the http transport is active. */
let httpListener: Server | null = null;
/** Its session manager. */
let sessions: HttpSessionManager | null = null;
/** True once shutdown began: probes answer 503, new requests are refused. */
let draining = false;

/** How long a graceful shutdown waits for in-flight POSTs. */
export const DRAIN_TIMEOUT_MS = 5_000;

/**
 * E-9 / H-7: stop the HTTP transport gracefully (no-op for stdio or when
 * nothing is listening): stop accepting connections, answer new requests with
 * 503, wait up to `drainMs` for in-flight tool calls, then close every session
 * (disposing its runtime) and drop the remaining connections.
 */
export async function closeHttpTransport(
  drainMs: number = DRAIN_TIMEOUT_MS,
): Promise<void> {
  const listener = httpListener;
  if (!listener) return;
  httpListener = null;
  draining = true;
  const manager = sessions;
  const closed = new Promise<void>((resolve) =>
    listener.close(() => resolve()),
  );
  listener.closeIdleConnections();
  if (manager) {
    const deadline = Date.now() + drainMs;
    while (manager.inFlightPosts > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await manager.closeAll();
  }
  sessions = null;
  listener.closeAllConnections();
  await closed;
  setLogSink(null);
  draining = false;
}

/** True for `GET /metrics` (any query string). Exported for testing. */
export function isMetricsRequest(
  method: string | undefined,
  url: string | undefined,
): boolean {
  return method === "GET" && (url ?? "").split("?")[0] === "/metrics";
}

/**
 * D-5: true for a bind address reachable only from this machine. Exported
 * for testing.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\./.test(h);
}

/** The Host names accepted on a loopback bind when no list is configured. */
export const LOOPBACK_HOST_NAMES = ["localhost", "127.0.0.1", "[::1]"];

/**
 * H-7 — the `Host` allow-list for a bind address: `SN_HTTP_ALLOWED_HOSTS`
 * when set; otherwise the loopback names on a loopback bind (a DNS-rebinding
 * page reaching 127.0.0.1 carries its own hostname and is refused); `null`
 * (no check) on a non-loopback bind without a list. Exported for testing.
 */
export function resolveAllowedHosts(bindHost: string): string[] | null {
  const configured = getHttpAllowedHosts();
  if (configured.length) return configured;
  return isLoopbackHost(bindHost) ? LOOPBACK_HOST_NAMES : null;
}

/** Split a Host header or allow-list entry into hostname and port. */
function splitHost(value: string): { name: string; port?: string } {
  const v = value.trim().toLowerCase();
  const m = /^(\[[^\]]*\]|[^:]+)(?::(\d+))?$/.exec(v);
  if (!m) return { name: v };
  const name = m[1] ?? v;
  return m[2] ? { name, port: m[2] } : { name };
}

/**
 * H-7 — true when `header` (the request's Host) matches the allow-list: an
 * entry without a port matches the name on any port, an entry with a port
 * only that port. `null` = no check. Exported for testing.
 */
export function hostAllowed(
  header: string | undefined,
  allowed: string[] | null,
): boolean {
  if (allowed === null) return true;
  if (!header) return false;
  const got = splitHost(header);
  return allowed.some((entry) => {
    const want = splitHost(entry);
    return want.name === got.name && (!want.port || want.port === got.port);
  });
}

const LOOPBACK_ORIGIN =
  /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i;

/**
 * H-7 — true when a browser `Origin` may call the endpoint. No Origin (a
 * non-browser client) is always allowed; `*` in the list allows any; a
 * configured list must match exactly (scheme, host, port); without a list
 * only loopback origins pass. Exported for testing.
 */
export function originAllowed(
  origin: string | undefined,
  allowed: string[] = getHttpAllowedOrigins(),
): boolean {
  if (!origin) return true;
  const o = origin.trim().toLowerCase().replace(/\/+$/, "");
  if (allowed.includes("*")) return true;
  if (allowed.length) {
    return allowed.some((a) => a.replace(/\/+$/, "") === o);
  }
  return LOOPBACK_ORIGIN.test(o);
}

/** The path of a request URL without its query string. */
function pathOf(url: string | undefined): string {
  return (url ?? "/").split("?")[0] ?? "/";
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res
    .writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    })
    .end(JSON.stringify(body));
}

/** How long a `/readyz?probe=1` result is reused. */
export const READY_PROBE_CACHE_MS = 5_000;
let lastProbe: { at: number; result: ConnectionProbe } | null = null;

/** Drop the cached readiness probe (tests). */
export function resetReadyProbe(): void {
  lastProbe = null;
}

async function readyProbe(): Promise<ConnectionProbe> {
  if (lastProbe && Date.now() - lastProbe.at < READY_PROBE_CACHE_MS) {
    return lastProbe.result;
  }
  const result = await testConnection();
  lastProbe = { at: Date.now(), result };
  return result;
}

async function startHttp(factory: ServerFactory): Promise<void> {
  const port = getHttpPort();
  const host = getHttpHost();
  const token = getHttpToken();
  const loopback = isLoopbackHost(host);
  if (!token && !loopback) {
    // D-5 / H-7 (B6): a container binds 0.0.0.0 — without a token anyone who
    // can reach the port drives the instance with the configured credentials.
    if (httpRequireToken()) {
      throw new Error(
        `Refusing to bind the HTTP transport to ${host} without SN_HTTP_TOKEN (SN_HTTP_REQUIRE_TOKEN is set) — set SN_HTTP_TOKEN or SN_HTTP_TOKEN_FILE, or bind 127.0.0.1`,
      );
    }
    logger.warn(
      "HTTP transport bound to a non-loopback address without SN_HTTP_TOKEN — every client that can reach the port is accepted; set SN_HTTP_TOKEN (or SN_HTTP_TOKEN_FILE), or SN_HTTP_REQUIRE_TOKEN=1 to refuse",
      { host },
    );
  }
  const allowedHosts = resolveAllowedHosts(host);
  if (allowedHosts === null) {
    logger.warn(
      "HTTP transport bound to a non-loopback address without SN_HTTP_ALLOWED_HOSTS — the Host header is not checked (DNS-rebinding protection off)",
      { host },
    );
  }
  // E-5: Prometheus metrics are served only behind the bearer token — the
  // counters name hosts and tools, so an open /metrics would leak topology.
  const serveMetrics = metricsEnabled() && Boolean(token);
  if (metricsEnabled() && !token) {
    logger.warn(
      "SN_METRICS is set but SN_HTTP_TOKEN is not — GET /metrics stays disabled",
    );
  }

  const manager = new HttpSessionManager({
    factory,
    parent: currentRuntime(),
    ttlMs: getHttpSessionTtlSec() * 1000,
    keepAliveMs: getHttpKeepAliveMs(),
    maxSessions: getHttpMaxSessions(),
  });

  const route = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const path = pathOf(req.url);
    const probe = /[?&]probe=(1|true)\b/.test(req.url ?? "");
    // Liveness and plain readiness are open (orchestrators probe without a
    // token) and reveal nothing beyond up / configured.
    if (req.method === "GET" && path === "/healthz") {
      sendJson(res, draining ? 503 : 200, {
        status: draining ? "draining" : "ok",
      });
      return;
    }
    if (req.method === "GET" && path === "/readyz" && !probe) {
      const ready = !draining && hasCredentials();
      sendJson(res, ready ? 200 : 503, {
        status: ready ? "ready" : draining ? "draining" : "not-configured",
      });
      return;
    }
    if (!hostAllowed(req.headers.host, allowedHosts)) {
      jsonRpcError(res, 403, -32000, "Forbidden: Host not allowed");
      return;
    }
    if (!originAllowed(req.headers.origin)) {
      jsonRpcError(res, 403, -32000, "Forbidden: Origin not allowed");
      return;
    }
    if (draining) {
      jsonRpcError(res, 503, -32000, "Server is shutting down");
      return;
    }
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
    if (req.method === "GET" && path === "/readyz") {
      // The deep probe calls the instance, so it sits behind the token.
      const result = hasCredentials()
        ? await readyProbe()
        : { ok: false, status: null, latencyMs: 0 };
      sendJson(res, result.ok ? 200 : 503, {
        status: result.ok ? "ready" : "unreachable",
        ok: result.ok,
        instanceStatus: result.status,
        latencyMs: result.latencyMs,
      });
      return;
    }
    await manager.handle(req, res);
  };

  const httpServer = createServer((req, res) => {
    void route(req, res).catch((error) => {
      logger.error("HTTP request handling failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  // Resolve only once the port is bound so a bind failure (EADDRINUSE, a
  // privileged port) surfaces as a rejected startup instead of a stray
  // 'error' event.
  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, host, () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await manager.closeAll();
    throw error;
  }
  // H-7: a later server error (EMFILE, a socket fault) is logged, never an
  // uncaught 'error' event that would crash the process.
  httpServer.on("error", (error) => {
    logger.error("HTTP server error", { error: error.message });
  });
  httpListener = httpServer;
  sessions = manager;
  draining = false;
  // Log lines reach the MCP client of the session they were logged in.
  setLogSink(sessionLogSink);
  logger.info("HTTP transport listening", {
    host,
    port,
    authenticated: Boolean(token),
    sessionTtlSec: getHttpSessionTtlSec(),
    maxSessions: getHttpMaxSessions(),
  });
}
