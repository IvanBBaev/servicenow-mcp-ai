#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { loadEnv, hasCredentials } from "./config.js";
import { registerAllTools } from "./registry.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { logger } from "./logging.js";

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
