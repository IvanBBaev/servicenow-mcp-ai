import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { setClientInfoProvider } from "../core/identity.js";
import { currentSession } from "../core/request-context.js";

/**
 * The live server instance, for tool handlers that need protocol features
 * (elicitation, client capability checks). Set once at bootstrap; null in
 * unit tests that call handlers directly.
 *
 * H-7: over HTTP every session has its own McpServer, so a request running
 * inside a session (see `runInSession`) resolves that session's server — an
 * elicitation or a list-changed notification reaches the client that caused
 * it, never another session.
 */
let current: McpServer | null = null;

export function setServer(server: McpServer | null): void {
  current = server;
  // The User-Agent names the MCP client (H-10); core/ cannot import this
  // layer, so hand it a lazy lookup of the initialize handshake's clientInfo
  // — resolved per call, so an HTTP session names its own client.
  setClientInfoProvider(
    server ? () => getServer()?.server.getClientVersion() : null,
  );
}

export function getServer(): McpServer | null {
  const scoped = currentSession()?.server as McpServer | undefined;
  return scoped ?? current;
}
