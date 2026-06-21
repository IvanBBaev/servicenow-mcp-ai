#!/usr/bin/env node
// Node guard for the case when build/index.js is started directly (the bin
// launcher already checks before parsing the ESM graph). Runs before the
// server boots; uses no syntax newer than what Node 14 parses.
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) {
  console.error(
    `servicenow-mcp-ai requires Node.js >= 20, but this is ${process.versions.node}. Use e.g. nvm use 22.`,
  );
  process.exit(1);
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { connectTransport } from "./mcp/transport.js";
import { createRequire } from "node:module";
import { loadEnv, hasCredentials } from "./core/config.js";
import { registerAllTools, registerResources } from "./mcp/registry.js";
import { registerPrompts } from "./mcp/prompts.js";
import { setServer } from "./mcp/context.js";
import { logger, setLogSink, type LogLevel } from "./core/logging.js";

loadEnv();

// `servicenow-mcp-ai login` — one-time OAuth 2.1 Authorization Code + PKCE login
// that stores a refresh token, instead of starting the MCP server.
if (process.argv.includes("login")) {
  const { runOAuthLogin } = await import("./core/oauth-login.js");
  try {
    const { host, profile } = await runOAuthLogin();
    process.stderr.write(
      `\n✓ Logged in to ${host} (profile: ${profile}). Refresh token stored — you can start the server now.\n`,
    );
    process.exit(0);
  } catch (error) {
    process.stderr.write(
      `\n✗ Login failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}

const requireJson = createRequire(import.meta.url);
const pkg = requireJson("../package.json") as { version: string };

const server = new McpServer(
  {
    name: "servicenow-mcp-ai",
    version: pkg.version,
  },
  { capabilities: { logging: {} } },
);

registerAllTools(server);
registerResources(server);
registerPrompts(server);
setServer(server);

/** Map our levels onto the MCP logging levels (warn → warning). */
const MCP_LEVEL: Record<LogLevel, "debug" | "info" | "warning" | "error"> = {
  debug: "debug",
  info: "info",
  warn: "warning",
  error: "error",
};

async function main(): Promise<void> {
  // DF-6: stdio (default) or Streamable HTTP, chosen by SN_TRANSPORT.
  const transportKind = await connectTransport(server);
  // Mirror stderr logs to the client over the MCP logging capability (X-4).
  setLogSink((level, message, fields) => {
    void server.server
      .sendLoggingMessage({
        level: MCP_LEVEL[level],
        data: { message, ...(fields ?? {}) },
      })
      .catch(() => undefined);
  });
  // Logs always go to stderr (never stdout — that is the stdio protocol channel).
  logger.info(`servicenow-mcp-ai server running on ${transportKind}`, {
    version: pkg.version,
  });
  if (!hasCredentials()) {
    logger.warn(
      "ServiceNow credentials are incomplete. Use servicenow_set_credentials to configure them.",
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { signal });
    try {
      await server.close();
    } catch {
      // ignore errors raised while closing during shutdown
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Crash safety: a rejected promise outside a handler must be visible, and an
// uncaught exception must not leave the process in an undefined state.
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
  });
});
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception — exiting", { error: error.message });
  process.exit(1);
});

main().catch((error) => {
  logger.error("Fatal error in MCP server", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
