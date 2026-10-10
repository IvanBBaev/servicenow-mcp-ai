import { McpServer, type ServerOptions } from "@modelcontextprotocol/server";
import {
  connectTransport,
  closeHttpTransport,
  closeStdioTransport,
} from "./mcp/transport.js";
import { installCrashHandlers } from "./core/lifecycle.js";
import { startOtelSubscriber } from "./core/otel.js";
import { hasCredentials } from "./core/config.js";
import { getTransport } from "./core/settings.js";
import {
  effectivePackages,
  registerAllTools,
  registerResources,
} from "./mcp/registry.js";
import { LIST_CHANGED_NOTIFICATIONS } from "./mcp/packages.js";
import { registerPrompts } from "./mcp/prompts.js";
import { setServer } from "./mcp/context.js";
import { mrtrServerOptions } from "./mcp/input.js";
import { logger, setLogSink } from "./core/logging.js";
import { createLogBridge } from "./mcp/log-bridge.js";
import { warnIfTlsVerifyOff } from "./core/dispatcher.js";
import type { Runtime } from "./core/runtime.js";
import { SERVER_VERSION } from "./core/identity.js";
import { LIST_CACHE_HINTS } from "./mcp/cache-hints.js";
import {
  installTaskHandlers,
  wireModernTasks,
  withTaskSupport,
} from "./mcp/tasks.js";
import {
  buildServerInstructions,
  serverImplementation,
} from "./mcp/server-info.js";

/**
 * Build one fully registered McpServer on `runtime`: tools (with the
 * runtime's package session), resources and prompts. stdio builds one per
 * connection, the HTTP transport one per session or modern request (H-7).
 *
 * `serverOptions` is spread over the base options (capabilities are merged),
 * so a protocol feature can add its server options without touching this
 * bootstrap.
 */
export function buildMcpServer(
  runtime: Runtime,
  serverOptions: ServerOptions = {},
): McpServer {
  // M-1: title / website / icon, and `instructions` generated from the live
  // registry and configuration (packages, write mode, credentials, how to fix).
  const server = new McpServer(
    serverImplementation(SERVER_VERSION),
    // M-9: the `tasks` capability when SN_EXPERIMENTAL_TASKS is on.
    withTaskSupport({
      instructions: buildServerInstructions(SERVER_VERSION),
      // M-5: one list_changed per list for a package toggle, not one per tool.
      debouncedNotificationMethods: LIST_CHANGED_NOTIFICATIONS,
      // N-38: ttlMs / cacheScope on the 2026-07-28 wire; legacy ignores them.
      cacheHints: LIST_CACHE_HINTS,
      // MRTR (2026-07-28): input_required rounds with a signed, single-use
      // requestState; the legacy wire keeps in-line elicitation (input.ts).
      ...mrtrServerOptions(),
      ...serverOptions,
      capabilities: { logging: {}, ...serverOptions.capabilities },
    }),
  );
  installTaskHandlers(server, runtime);
  registerAllTools(server, runtime);
  wireModernTasks(server, runtime);
  registerResources(server);
  registerPrompts(server, effectivePackages().enabled);
  return server;
}

/**
 * D-1 — the MCP server bootstrap, extracted from the entry point so that
 * importing it has no side effects: nothing is created, registered or
 * connected until `startServer()` is called (by the CLI when no subcommand is
 * given). The caller has already installed `runtime` and loaded the env file.
 *
 * stdout stays the protocol channel: every log line goes to stderr.
 */
export async function startServer(runtime: Runtime): Promise<void> {
  // Crash safety (E-9): an unhandled rejection or uncaught exception logs one
  // structured error line (pid, uptime, transport, error) and exits 1 after
  // flushing stderr — a possibly corrupt process must not keep serving.
  installCrashHandlers();
  // N-55: SN_OTEL=1 maps the diagnostics_channel events to OpenTelemetry
  // spans (optional peer dependency; off = never imported).
  await startOtelSubscriber();

  const http = getTransport() === "http";
  if (http) {
    // H-7: one McpServer per HTTP session or modern request, each on its own
    // child runtime of `runtime`; the transport installs the log sink.
    await connectTransport((sessionRuntime) => buildMcpServer(sessionRuntime));
  } else {
    // DF-6 / H-7: stdio serves one client in either protocol era; serveStdio
    // builds the server for the era the client speaks (a discarded discovery
    // probe may come first, so the last built instance is the live one).
    await connectTransport((processRuntime) => {
      const server = buildMcpServer(processRuntime);
      setServer(server);
      // Mirror stderr logs to the client over the MCP logging capability
      // (X-4). M-8: per-session levels and a notification rate limit
      // (SN_LOG_NOTIFY_RATE) — see log-bridge.ts.
      setLogSink(createLogBridge(server.server));
      return server;
    });
  }
  const transportKind = http ? "http" : "stdio";
  // Logs always go to stderr (never stdout — that is the stdio protocol channel).
  logger.info(`servicenow-mcp-ai server running on ${transportKind}`, {
    version: SERVER_VERSION,
  });
  if (!hasCredentials()) {
    logger.warn(
      "ServiceNow credentials are incomplete. Use servicenow_set_credentials to configure them.",
    );
  }
  // H-6 / SEC-16: say it at startup, not only when the first request is made.
  warnIfTlsVerifyOff();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { signal });
    try {
      // E-9: stop the protocol, then release the runtime's state (caches,
      // tokens, dispatcher pools).
      // H-7: HTTP drains in-flight calls and closes every session first.
      await closeHttpTransport();
      await closeStdioTransport();
      await runtime.dispose();
    } catch {
      // ignore errors raised while closing during shutdown
    }
    process.exit(0);
  };
  // SIGTERM behaves exactly like SIGINT (E-9): graceful close, exit 0.
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
