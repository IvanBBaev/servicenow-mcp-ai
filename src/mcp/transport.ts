import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getTransport, getHttpPort } from "../core/settings.js";
import { logger } from "../core/logging.js";

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

async function startHttp(server: McpServer): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);

  const port = getHttpPort();
  const httpServer = createServer((req, res) => {
    void transport.handleRequest(req, res).catch((error) => {
      logger.error("HTTP request handling failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  httpServer.listen(port, () => {
    logger.info("HTTP transport listening", { port });
  });
}
