import { createRequire } from "node:module";
import { getTransport, getUserAgentSuffix } from "./settings.js";

/**
 * The server's outbound identity (H-10 / L1-02): one User-Agent on every
 * ServiceNow and OAuth request, so instance transaction logs, WAF logs
 * and the REST usage dashboards can attribute the traffic:
 *
 *   servicenow-mcp-ai/<version> (node/<major>; <transport>; <client>)[ <suffix>]
 *
 * The MCP client's name/version comes from the `initialize` handshake. core/
 * must not import mcp/, so the mcp layer registers a provider at bootstrap
 * (see mcp/context.ts) and this module evaluates it lazily per request.
 */

const requireJson = createRequire(import.meta.url);
const pkg = requireJson("../../package.json") as { version: string };

export const SERVER_VERSION: string = pkg.version;

export interface ClientInfo {
  name: string;
  version?: string;
}

type ClientInfoProvider = () => ClientInfo | undefined;

let clientInfoProvider: ClientInfoProvider | null = null;

/** Register how the client name is looked up (called once by the mcp layer). */
export function setClientInfoProvider(
  provider: ClientInfoProvider | null,
): void {
  clientInfoProvider = provider;
}

const MAX_CLIENT_CHARS = 40;

/**
 * Reduce a free-form client string to a safe header token: only
 * `[A-Za-z0-9._/-]` survive (runs of anything else collapse to one `-`), and
 * the result is capped so a hostile clientInfo cannot bloat the header.
 */
export function sanitizeClientToken(raw: string | undefined): string {
  const cleaned = (raw ?? "")
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CLIENT_CHARS);
  return cleaned || "unknown";
}

/** The MCP client's identity as a header token, or "unknown". */
export function clientToken(): string {
  let info: ClientInfo | undefined;
  try {
    info = clientInfoProvider?.();
  } catch {
    info = undefined;
  }
  if (!info?.name) return "unknown";
  const name = sanitizeClientToken(info.name);
  const version = info.version ? sanitizeClientToken(info.version) : "";
  return version ? `${name}/${version}`.slice(0, MAX_CLIENT_CHARS) : name;
}

const NODE_MAJOR = process.versions.node.split(".")[0] ?? "0";

/** Build the User-Agent header value for the current request. */
export function userAgent(): string {
  const base = `servicenow-mcp-ai/${SERVER_VERSION} (node/${NODE_MAJOR}; ${getTransport()}; ${clientToken()})`;
  const suffix = getUserAgentSuffix();
  // The suffix is operator-controlled; keep it on one line and printable.
  const safeSuffix = suffix
    ?.replace(/[^\x20-\x7e]+/g, " ")
    .trim()
    .slice(0, 80);
  return safeSuffix ? `${base} ${safeSuffix}` : base;
}
