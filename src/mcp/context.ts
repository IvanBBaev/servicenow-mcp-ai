import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * The live server instance, for tool handlers that need protocol features
 * (elicitation, client capability checks). Set once at bootstrap; null in
 * unit tests that call handlers directly.
 */
let current: McpServer | null = null;

export function setServer(server: McpServer | null): void {
  current = server;
}

export function getServer(): McpServer | null {
  return current;
}
