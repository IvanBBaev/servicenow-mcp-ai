#!/usr/bin/env node
// Node guard for the case when build/index.js is started directly (the bin
// launcher already checks before parsing the ESM graph). Runs before the
// server boots; uses no syntax newer than what Node 14 parses.
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) {
  console.error(
    `sincronia-mcp requires Node.js >= 20, but this is ${process.versions.node}. Use e.g. nvm use 22.`,
  );
  process.exit(1);
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { loadEnv, hasCredentials } from "./core/config.js";
import { registerAllTools } from "./mcp/registry.js";
import { registerResources } from "./mcp/resources.js";
import { registerPrompts } from "./mcp/prompts.js";
import { logger } from "./core/logging.js";

loadEnv();

const requireJson = createRequire(import.meta.url);
const pkg = requireJson("../package.json") as { version: string };

const server = new McpServer({
  name: "sincronia-servicenow",
  version: pkg.version,
});

registerAllTools(server);
registerResources(server);
registerPrompts(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // STDIO servers must never write to stdout; logging goes to stderr.
  logger.info("Sincronia ServiceNow MCP server running on stdio", {
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

main().catch((error) => {
  logger.error("Fatal error in MCP server", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
