import { createRequire } from "node:module";
import { getCredentials } from "./config.js";
import { delegatedSubject } from "./delegation.js";
import { getTransport, getUserAgentSuffix } from "./settings.js";

/**
 * The server's outbound identity (H-10 / L1-02): one User-Agent on every
 * ServiceNow and OAuth request, so instance transaction logs, WAF logs
 * and the REST usage dashboards can attribute the traffic:
 *
 *   servicenow-mcp-ai/<version> (node/<major>; <transport>[; user=<name>])[ <suffix>]
 *
 * `user` is the ServiceNow user the request calls as: the OAuth subject of a
 * delegated request (N-17), otherwise the active profile's SN_USER. It is
 * left out when no user name is configured (API key, client credentials).
 * The MCP client (the initialize handshake's clientInfo) is deliberately not
 * part of it: which AI tool drives the server is the user's business, not the
 * instance's. Operators who want more attribution set SN_USER_AGENT_SUFFIX.
 */

const requireJson = createRequire(import.meta.url);
const pkg = requireJson("../../package.json") as { version: string };

export const SERVER_VERSION: string = pkg.version;

const NODE_MAJOR = process.versions.node.split(".")[0] ?? "0";

const MAX_USER_CHARS = 64;

/** The calling ServiceNow user, reduced to a safe User-Agent comment token. */
export function userToken(): string | undefined {
  const raw = delegatedSubject() ?? getCredentials().user;
  const safe = raw
    ?.replace(/[^\x21-\x7e]+/g, "")
    .replace(/[();\\]/g, "")
    .slice(0, MAX_USER_CHARS);
  return safe || undefined;
}

/** Build the User-Agent header value for the current request. */
export function userAgent(): string {
  const user = userToken();
  const comment = user
    ? `node/${NODE_MAJOR}; ${getTransport()}; user=${user}`
    : `node/${NODE_MAJOR}; ${getTransport()}`;
  const base = `servicenow-mcp-ai/${SERVER_VERSION} (${comment})`;
  const suffix = getUserAgentSuffix();
  // The suffix is operator-controlled; keep it on one line and printable.
  const safeSuffix = suffix
    ?.replace(/[^\x20-\x7e]+/g, " ")
    .trim()
    .slice(0, 80);
  return safeSuffix ? `${base} ${safeSuffix}` : base;
}
