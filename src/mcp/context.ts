import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { setClientInfoProvider } from "../core/identity.js";

/**
 * The live server instance, for tool handlers that need protocol features
 * (elicitation, client capability checks). Set once at bootstrap; null in
 * unit tests that call handlers directly.
 */
let current: McpServer | null = null;

export function setServer(server: McpServer | null): void {
  current = server;
  // The User-Agent names the MCP client (H-10); core/ cannot import this
  // layer, so hand it a lazy lookup of the initialize handshake's clientInfo.
  setClientInfoProvider(server ? () => server.server.getClientVersion() : null);
}

export function getServer(): McpServer | null {
  return current;
}
