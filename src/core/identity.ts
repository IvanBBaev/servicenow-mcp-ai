import { createRequire } from "node:module";
import { getTransport, getUserAgentSuffix } from "./settings.js";

/**
 * The server's outbound identity (H-10 / L1-02): one User-Agent on every
 * ServiceNow and OAuth request, so instance transaction logs, WAF logs
 * and the REST usage dashboards can attribute the traffic:
 *
 *   servicenow-mcp-ai/<version> (node/<major>; <transport>)[ <suffix>]
 *
 * Neither the MCP client (the initialize handshake's clientInfo) nor the
 * calling user is part of it: the instance already knows who authenticated,
 * and which AI tool drives the server is the user's business. Operators who
 * want attribution set SN_USER_AGENT_SUFFIX.
 */

const requireJson = createRequire(import.meta.url);
const pkg = requireJson("../../package.json") as { version: string };

export const SERVER_VERSION: string = pkg.version;

const NODE_MAJOR = process.versions.node.split(".")[0] ?? "0";

/** Build the User-Agent header value for the current request. */
export function userAgent(): string {
  const base = `servicenow-mcp-ai/${SERVER_VERSION} (node/${NODE_MAJOR}; ${getTransport()})`;
  const suffix = getUserAgentSuffix();
  // The suffix is operator-controlled; keep it on one line and printable.
  const safeSuffix = suffix
    ?.replace(/[^\x20-\x7e]+/g, " ")
    .trim()
    .slice(0, 80);
  return safeSuffix ? `${base} ${safeSuffix}` : base;
}
