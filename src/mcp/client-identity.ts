import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type ClientCapabilities,
  type Implementation,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";

/**
 * N-81 — who the client is and which protocol revision it speaks.
 *
 * A 2026-07-28 request names all three in its per-request `_meta` envelope
 * (`ctx.mcpReq.envelope`), which is read first whenever the caller has the
 * handler context. A 2025-era connection has no envelope: the values come
 * from the `initialize` handshake through the server accessors the SDK
 * deprecated in favour of the envelope. This module is the one place that
 * still calls them; they stay functional on both eras (the SDK backfills a
 * modern instance per request), so a caller without a context is answered
 * correctly either way.
 */

type Envelope = Record<string, unknown>;

/** The request's `_meta` envelope, keyed by the reserved meta keys. */
function envelopeOf(ctx: ServerContext | undefined): Envelope | undefined {
  return ctx?.mcpReq.envelope;
}

/** The client's declared capabilities, or undefined before `initialize`. */
export function clientCapabilities(
  server: McpServer | null | undefined,
  ctx?: ServerContext,
): ClientCapabilities | undefined {
  const declared = envelopeOf(ctx)?.[CLIENT_CAPABILITIES_META_KEY];
  if (declared !== undefined) return declared as ClientCapabilities;
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- 2025-era fallback, see the module comment
  return server?.server.getClientCapabilities();
}

/** The client's name and version, or undefined before `initialize`. */
export function clientInfo(
  server: McpServer | null | undefined,
  ctx?: ServerContext,
): Implementation | undefined {
  const declared = envelopeOf(ctx)?.[CLIENT_INFO_META_KEY];
  if (declared !== undefined) return declared as Implementation;
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- 2025-era fallback, see the module comment
  return server?.server.getClientVersion();
}

/** The protocol revision the request is served on, or undefined before `initialize`. */
export function protocolRevision(
  server: McpServer | null | undefined,
  ctx?: ServerContext,
): string | undefined {
  const declared = envelopeOf(ctx)?.[PROTOCOL_VERSION_META_KEY];
  if (typeof declared === "string") return declared;
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- 2025-era fallback, see the module comment
  return server?.server.getNegotiatedProtocolVersion();
}
