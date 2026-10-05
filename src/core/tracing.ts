import { channel } from "node:diagnostics_channel";

/**
 * N-55 (TK-31) — the tool-call side of the `node:diagnostics_channel` publish
 * points (the HTTP side is E-5, metrics.ts), plus the W3C Trace Context a
 * client hands over in `params._meta`.
 *
 * The manifest layer (mcp/define.ts runSpec) publishes one `start` and then
 * exactly one of `end` / `error` around every tool call. Messages carry only
 * metadata — tool name, package, request / session ids, profile alias,
 * outcome, error `code`, duration, result size — never arguments, results,
 * headers or credentials. Publishing is skipped entirely when nobody
 * subscribes, so an unobserved call pays one boolean check per channel.
 */

/** Channel names of the tool-call envelope — stable public API. */
export const TOOL_CALL_CHANNELS = {
  /** A tools/call begins (before argument normalisation and the handler). */
  start: "servicenow-mcp:mcp.tool.call.start",
  /** The call returned a result without `isError`. */
  end: "servicenow-mcp:mcp.tool.call.end",
  /** The call returned an `isError` result (or, defensively, threw). */
  error: "servicenow-mcp:mcp.tool.call.error",
} as const;

const channels = {
  start: channel(TOOL_CALL_CHANNELS.start),
  end: channel(TOOL_CALL_CHANNELS.end),
  error: channel(TOOL_CALL_CHANNELS.error),
};

/** True when any tool-call channel has a subscriber. */
export function toolCallObserved(): boolean {
  return (
    channels.start.hasSubscribers ||
    channels.end.hasSubscribers ||
    channels.error.hasSubscribers
  );
}

/**
 * Publish `message` on one of the tool-call channels, if anyone listens. The
 * message is built lazily. As with the HTTP channels, Node isolates a
 * throwing subscriber from the publisher (the error surfaces as an
 * `uncaughtException` on the next tick), so a subscriber must handle its own
 * errors.
 */
export function publishToolCallEvent(
  kind: keyof typeof channels,
  message: () => Record<string, unknown>,
): void {
  const ch = channels[kind];
  if (ch.hasSubscribers) ch.publish(message());
}

/** Per-process id that correlates a call's events with its HTTP requests. */
let callSeq = 0;

/** The next tool-call id (process-unique, monotonic). */
export function nextCallId(): number {
  return ++callSeq;
}

// --- W3C Trace Context --------------------------------------------------------

/** A validated W3C Trace Context received from the client. */
export interface TraceContext {
  /** The `traceparent` value exactly as received (lower-case, validated). */
  traceparent: string;
  /** The `tracestate` value, when one was sent and is well-formed. */
  tracestate?: string;
  /** 32 lower-case hex digits. */
  traceId: string;
  /** The caller's span id: 16 lower-case hex digits. */
  parentId: string;
  /** The trace-flags byte (bit 0 = sampled). */
  flags: number;
}

const TRACEPARENT_RE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
/** The W3C limit a vendor must accept; anything longer is dropped. */
const TRACESTATE_MAX = 512;
/** Printable ASCII only — a tracestate never needs anything else. */
const TRACESTATE_RE = /^[\x20-\x7e]*$/;

/**
 * Parse a W3C `traceparent` (https://www.w3.org/TR/trace-context/): version
 * `ff` is invalid, version `00` must have exactly four fields, a later
 * version may append fields, and an all-zero trace or parent id is invalid.
 * Anything else — a non-string, upper-case hex, a wrong length — yields
 * undefined: an invalid header starts a new trace, it never fails the call.
 */
export function parseTraceparent(
  value: unknown,
): Omit<TraceContext, "tracestate"> | undefined {
  if (typeof value !== "string" || value.length > 512) return undefined;
  const raw = value.trim();
  const m = TRACEPARENT_RE.exec(raw);
  if (!m) return undefined;
  const [, version, traceId, parentId, flags, rest] = m;
  if (version === "ff") return undefined;
  if (version === "00" && rest !== undefined) return undefined;
  if (/^0+$/.test(traceId!) || /^0+$/.test(parentId!)) return undefined;
  return {
    traceparent: raw,
    traceId: traceId!,
    parentId: parentId!,
    flags: parseInt(flags!, 16),
  };
}

/**
 * The trace context of a tools/call request: `traceparent` / `tracestate`
 * from its `params._meta` (the MCP semantic conventions propagate W3C Trace
 * Context there, without a prefix). The tracestate is kept only next to a
 * valid traceparent and only when it is short, printable ASCII.
 */
export function traceContextFromMeta(meta: unknown): TraceContext | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const record = meta as Record<string, unknown>;
  const parent = parseTraceparent(record.traceparent);
  if (!parent) return undefined;
  const state = record.tracestate;
  if (
    typeof state === "string" &&
    state.trim() !== "" &&
    state.length <= TRACESTATE_MAX &&
    TRACESTATE_RE.test(state)
  ) {
    return { ...parent, tracestate: state.trim() };
  }
  return parent;
}

// --- result metadata -----------------------------------------------------------

interface ResultLike {
  isError?: boolean;
  content?: ReadonlyArray<{ type: string; text?: string }>;
}

/** UTF-8 bytes of a result's text blocks (the size the client receives). */
export function resultBytes(result: ResultLike): number {
  let bytes = 0;
  for (const block of result.content ?? []) {
    if (typeof block.text === "string") {
      bytes += Buffer.byteLength(block.text, "utf8");
    }
  }
  return bytes;
}

/**
 * The stable error `code` of an `isError` result (M-2: every failure's first
 * text block is a JSON object with a `code`), or undefined.
 */
export function resultErrorCode(result: ResultLike): string | undefined {
  const text = result.content?.find((b) => b.type === "text")?.text;
  if (!text) return undefined;
  try {
    const code = (JSON.parse(text) as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

// --- outbound propagation (SN_OTEL_PROPAGATE) ------------------------------------

/**
 * The `traceparent` / `tracestate` headers of an outbound ServiceNow request.
 * A subscriber of `servicenow-mcp:http.request.start` (the SN_OTEL one, or
 * any other) may name its client span by setting `outboundTraceparent` (and
 * optionally `outboundTracestate`) on the start message; otherwise the
 * context the client sent with the tool call is forwarded unchanged. An
 * invalid value is ignored. Undefined = no header.
 */
export function outboundTraceHeaders(
  startMessage: Record<string, unknown> | undefined,
  trace: TraceContext | undefined,
): Record<string, string> | undefined {
  const fromSpan = traceContextFromMeta({
    traceparent: startMessage?.outboundTraceparent,
    tracestate: startMessage?.outboundTracestate,
  });
  const ctx = fromSpan ?? trace;
  if (!ctx) return undefined;
  return {
    traceparent: ctx.traceparent,
    ...(ctx.tracestate ? { tracestate: ctx.tracestate } : {}),
  };
}
