import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { DIAGNOSTICS_CHANNELS } from "./metrics.js";
import { SERVER_VERSION } from "./identity.js";
import { logger } from "./logging.js";
import { getTransport, otelEnabled } from "./settings.js";
import { parseTraceparent, TOOL_CALL_CHANNELS } from "./tracing.js";

/**
 * N-55 (TK-31) — the opt-in OpenTelemetry subscriber (`SN_OTEL=1`). It turns
 * the tool-call channels (tracing.ts) and the E-5 HTTP channels (metrics.ts)
 * into spans:
 *
 *   tools/call <tool>   SERVER span, parented on the client's `traceparent`
 *                       from `params._meta` (a new trace without one)
 *   <METHOD>            CLIENT span per logical ServiceNow / OAuth request,
 *                       parented on its tool call's span; retries are span
 *                       events
 *
 * `@opentelemetry/api` is an optional peer dependency, imported only when the
 * setting is on — the default install never loads it. Missing → one warning,
 * no subscription, nothing else changes. The spans go wherever the process's
 * registered OpenTelemetry SDK sends them (no SDK → the API's no-op tracer).
 *
 * Attribute names follow the OpenTelemetry semantic conventions as of
 * 2026-10: the MCP conventions (`semantic-conventions-genai`, docs/gen-ai/
 * mcp.md — status *Development*, so PROVISIONAL and liable to rename) for the
 * server span, the stable HTTP client conventions for the request span.
 * Project-specific values use the `servicenow_mcp.*` namespace.
 */

/** The module specifier of the optional peer dependency. */
export const OTEL_API_MODULE = "@opentelemetry/api";

// --- the structural subset of @opentelemetry/api this module uses -------------

type Attributes = Record<string, string | number | boolean>;

interface SpanContextLike {
  traceId: string;
  spanId: string;
  traceFlags: number;
  isRemote?: boolean;
  traceState?: { serialize(): string };
}

interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): unknown;
  setAttributes(attributes: Attributes): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  addEvent(name: string, attributes?: Attributes): unknown;
  spanContext(): SpanContextLike;
  end(endTime?: number): void;
}

interface TracerLike {
  startSpan(
    name: string,
    options: { kind: number; attributes?: Attributes; startTime?: number },
    context?: unknown,
  ): SpanLike;
}

/** What `startOtelSubscriber` needs from `@opentelemetry/api`. */
export interface OtelApiLike {
  trace: {
    getTracer(name: string, version?: string): TracerLike;
    setSpan(context: unknown, span: SpanLike): unknown;
    setSpanContext(context: unknown, spanContext: SpanContextLike): unknown;
  };
  context: { active(): unknown };
  ROOT_CONTEXT: unknown;
  SpanKind: { SERVER: number; CLIENT: number };
  SpanStatusCode: { ERROR: number };
  createTraceState?: (raw?: string) => { serialize(): string };
}

export interface OtelSubscriber {
  /** Unsubscribe every channel and forget the open spans. */
  stop(): void;
}

export interface OtelOptions {
  /** Loader of the API module — tests inject a fake; default: dynamic import. */
  load?: () => Promise<unknown>;
}

let warnedMissing = false;

/** Test hook: forget that the missing-package warning was logged. */
export function resetOtelWarning(): void {
  warnedMissing = false;
}

/**
 * Start the subscriber when `SN_OTEL` is on. Off → undefined, and the API
 * module is never imported. A failed import logs one warning (per process)
 * and returns undefined.
 */
export async function startOtelSubscriber(
  options: OtelOptions = {},
): Promise<OtelSubscriber | undefined> {
  if (!otelEnabled()) return undefined;
  const load =
    options.load ??
    // A variable specifier: tsc must not resolve the optional peer.
    ((): Promise<unknown> => import(OTEL_API_MODULE));
  let api: OtelApiLike;
  try {
    const mod = (await load()) as OtelApiLike & { default?: OtelApiLike };
    api = mod.trace ? mod : (mod.default as OtelApiLike);
    if (!api?.trace?.getTracer) throw new Error("not the OpenTelemetry API");
  } catch (error) {
    if (!warnedMissing) {
      warnedMissing = true;
      logger.warn(
        `SN_OTEL is on but ${OTEL_API_MODULE} could not be loaded — no spans are emitted. Install it next to the server (npm install ${OTEL_API_MODULE}) and register an OpenTelemetry SDK.`,
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
    return undefined;
  }
  return subscribeSpans(api);
}

/** A string field of a channel message, or undefined. */
function str(message: Record<string, unknown>, key: string) {
  const value = message[key];
  return typeof value === "string" ? value : undefined;
}

function num(message: Record<string, unknown>, key: string) {
  const value = message[key];
  return typeof value === "number" ? value : undefined;
}

/** The W3C traceparent of a span context (`00-<trace>-<span>-<flags>`). */
export function formatTraceparent(ctx: SpanContextLike): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${(ctx.traceFlags & 0xff).toString(16).padStart(2, "0")}`;
}

/**
 * Map the channels to spans with `api`. Exposed for tests; the server goes
 * through startOtelSubscriber. Every handler swallows its own errors — a
 * subscriber that throws would surface as an uncaught exception, and the
 * crash handler (E-9) would end the process.
 */
export function subscribeSpans(api: OtelApiLike): OtelSubscriber {
  const tracer = api.trace.getTracer("servicenow-mcp-ai", SERVER_VERSION);
  /** Open tool-call spans by call id, with the context their children use. */
  const calls = new Map<number, { span: SpanLike; ctx: unknown }>();
  /** Open HTTP spans by request id. */
  const requests = new Map<number, SpanLike>();

  /** The remote parent context of a message's `traceparent`, if valid. */
  const remoteParent = (message: Record<string, unknown>): unknown => {
    const parsed = parseTraceparent(message.traceparent);
    if (!parsed) return undefined;
    const tracestate = str(message, "tracestate");
    const spanContext: SpanContextLike = {
      traceId: parsed.traceId,
      spanId: parsed.parentId,
      traceFlags: parsed.flags,
      isRemote: true,
      ...(tracestate && api.createTraceState
        ? { traceState: api.createTraceState(tracestate) }
        : {}),
    };
    return api.trace.setSpanContext(api.ROOT_CONTEXT, spanContext);
  };

  const guard =
    (fn: (message: Record<string, unknown>) => void) =>
    (message: unknown): void => {
      try {
        if (message && typeof message === "object") {
          fn(message as Record<string, unknown>);
        }
      } catch (error) {
        logger.debug("OpenTelemetry subscriber error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

  const onToolStart = guard((m) => {
    const id = num(m, "id");
    const tool = str(m, "tool");
    if (id === undefined || !tool) return;
    const parent = remoteParent(m) ?? api.context.active();
    const sessionId = str(m, "sessionId");
    const requestId = str(m, "requestId");
    const span = tracer.startSpan(
      `tools/call ${tool}`,
      {
        kind: api.SpanKind.SERVER,
        attributes: {
          // MCP semconv (Development — provisional names).
          "mcp.method.name": "tools/call",
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": tool,
          "network.transport": getTransport() === "http" ? "tcp" : "pipe",
          ...(requestId && !requestId.startsWith("local-")
            ? { "jsonrpc.request.id": requestId }
            : {}),
          ...(sessionId ? { "mcp.session.id": sessionId } : {}),
          // Project-specific.
          ...(str(m, "package")
            ? { "servicenow_mcp.package": str(m, "package")! }
            : {}),
        },
      },
      parent,
    );
    calls.set(id, { span, ctx: api.trace.setSpan(parent, span) });
  });

  const onToolDone = guard((m) => {
    const id = num(m, "id");
    if (id === undefined) return;
    const open = calls.get(id);
    if (!open) return;
    calls.delete(id);
    const { span } = open;
    const profile = str(m, "profile");
    const code = str(m, "code");
    const bytes = num(m, "resultBytes");
    const outcome = str(m, "outcome");
    span.setAttributes({
      ...(profile ? { "servicenow_mcp.profile": profile } : {}),
      ...(outcome ? { "servicenow_mcp.outcome": outcome } : {}),
      ...(bytes !== undefined ? { "servicenow_mcp.result.bytes": bytes } : {}),
    });
    if (outcome && outcome !== "ok") {
      // MCP semconv: a tool result with isError → error.type "tool_error"
      // unless a more specific type is known; the stable code is that type.
      const type = code ?? str(m, "errorName") ?? "tool_error";
      span.setAttribute("error.type", type);
      span.setStatus({ code: api.SpanStatusCode.ERROR, message: type });
    }
    span.end();
  });

  const onRequestStart = guard((m) => {
    const id = num(m, "id");
    if (id === undefined) return;
    const callId = num(m, "callId");
    const parent =
      (callId !== undefined ? calls.get(callId)?.ctx : undefined) ??
      remoteParent(m) ??
      api.context.active();
    const method = str(m, "method") ?? "GET";
    const host = str(m, "host");
    const url = str(m, "url");
    const span = tracer.startSpan(
      method,
      {
        kind: api.SpanKind.CLIENT,
        attributes: {
          // Stable HTTP client semconv. `url.full` is the redacted URL
          // without its query string, as the channel publishes it.
          "http.request.method": method,
          ...(host ? { "server.address": host } : {}),
          ...(url ? { "url.full": url } : {}),
          ...(str(m, "system")
            ? { "servicenow_mcp.system": str(m, "system")! }
            : {}),
        },
      },
      parent,
    );
    requests.set(id, span);
    // N-55: name this span as the outbound parent (SN_OTEL_PROPAGATE).
    const sc = span.spanContext();
    if (/^[0-9a-f]{32}$/.test(sc.traceId) && /^[0-9a-f]{16}$/.test(sc.spanId)) {
      m.outboundTraceparent = formatTraceparent(sc);
      const state = sc.traceState?.serialize();
      if (state) m.outboundTracestate = state;
    }
  });

  const onRequestRetry = guard((m) => {
    const span = requests.get(num(m, "id") ?? -1);
    if (!span) return;
    const reason = str(m, "reason");
    const attempt = num(m, "attempt");
    const waitMs = num(m, "waitMs");
    span.addEvent("retry", {
      ...(reason ? { reason } : {}),
      ...(attempt !== undefined
        ? { "http.request.resend_count": attempt - 1 }
        : {}),
      ...(waitMs !== undefined ? { "servicenow_mcp.wait_ms": waitMs } : {}),
    });
  });

  const onRequestDone = guard((m) => {
    const id = num(m, "id");
    if (id === undefined) return;
    const span = requests.get(id);
    if (!span) return;
    requests.delete(id);
    const status = num(m, "status");
    const attempts = num(m, "attempts");
    span.setAttributes({
      ...(status !== undefined ? { "http.response.status_code": status } : {}),
      ...(attempts !== undefined && attempts > 1
        ? { "http.request.resend_count": attempts - 1 }
        : {}),
    });
    const failed =
      m.errorName !== undefined || (status !== undefined && status >= 400);
    if (failed) {
      const type =
        str(m, "code") ??
        (status !== undefined ? String(status) : undefined) ??
        str(m, "errorName") ??
        "_OTHER";
      span.setAttribute("error.type", type);
      span.setStatus({ code: api.SpanStatusCode.ERROR, message: type });
    }
    span.end();
  });

  const subscriptions: Array<[string, (message: unknown) => void]> = [
    [TOOL_CALL_CHANNELS.start, onToolStart],
    [TOOL_CALL_CHANNELS.end, onToolDone],
    [TOOL_CALL_CHANNELS.error, onToolDone],
    [DIAGNOSTICS_CHANNELS.requestStart, onRequestStart],
    [DIAGNOSTICS_CHANNELS.requestRetry, onRequestRetry],
    [DIAGNOSTICS_CHANNELS.requestEnd, onRequestDone],
    [DIAGNOSTICS_CHANNELS.requestError, onRequestDone],
  ];
  for (const [name, fn] of subscriptions) subscribe(name, fn);
  logger.info("OpenTelemetry spans enabled (SN_OTEL)");
  return {
    stop() {
      for (const [name, fn] of subscriptions) unsubscribe(name, fn);
      calls.clear();
      requests.clear();
    },
  };
}
