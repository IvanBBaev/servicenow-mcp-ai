/**
 * The bridge from the stderr logger to the MCP logging capability (X-4): each
 * log line is mirrored to the client as a `notifications/message`.
 *
 * M-8 fixes two gaps of the plain forwarder:
 * - **logging/setLevel over HTTP.** The SDK stores the level a client sets
 *   under its session id and filters each notification by the session id it is
 *   sent for. Sent without one, an HTTP client's level was never applied; the
 *   bridge now passes the call's session id (the `sessionId` log field) or the
 *   transport's own. On stdio both are undefined, as before.
 * - **Notification flooding (GAP L5-05).** A token bucket per session caps the
 *   notifications at `SN_LOG_NOTIFY_RATE` per second (burst: the larger of 50
 *   and the rate). Lines over the cap are counted, not sent; one `warning`
 *   "N log messages suppressed" per minute reports them. stderr is never
 *   throttled — every line is still written there.
 *
 * M-8 (N-35 step 2) moves the bridge off the deprecated logging API
 * (SEP-2577, 2026-07-28):
 * - **Request-scoped.** A line logged during a tool call goes out through
 *   the call's `ctx.mcpReq.log` (request-context.ts `RequestLog`), on the
 *   stream that carries the call's response. On a 2026-07-28 request it is
 *   sent only when the request set `io.modelcontextprotocol/logLevel` in
 *   `_meta`, and only at or above that level; the SDK applies the
 *   `logging/setLevel` level of a 2025 session.
 * - **Nothing outside a request on the 2026-07-28 wire.** A line logged
 *   outside a call reaches only a 2025 session, and only once it completed
 *   `initialize` (a 2026-07-28 client never sends it); that path keeps the
 *   deprecated `sendLoggingMessage`, functional for the deprecation window.
 *   Lines a 2026-07-28 request drops over the rate cap stay on stderr: its
 *   stream ends with the response, so no summary follows.
 *
 * N-89: a bridge is disposed with the HTTP session it serves (`dispose()`):
 * its buckets and any pending summary timer go, and later lines are dropped
 * (stderr keeps them) — a bucket keyed by an expired session no longer
 * outlives it. The stdio bridge lives as long as the process.
 */
import type { LogLevel, LogSink } from "../core/logging.js";
import { getLogNotifyRate } from "../core/settings.js";
import { currentCall, type McpLogLevel } from "../core/request-context.js";

type McpLevel = McpLogLevel;

/** Map our levels onto the MCP logging levels (warn → warning). */
export const MCP_LEVEL: Record<LogLevel, McpLevel> = {
  debug: "debug",
  info: "info",
  warn: "warning",
  error: "error",
};

/** Smallest burst a session gets, whatever the rate. */
export const LOG_NOTIFY_MIN_BURST = 50;

/** How often the suppressed-lines summary is sent at most. */
export const LOG_SUPPRESSED_SUMMARY_MS = 60_000;

/** The part of the SDK's low-level Server the bridge uses. */
export interface LoggingServer {
  sendLoggingMessage(
    params: { level: McpLevel; data: unknown },
    sessionId?: string,
  ): Promise<void>;
  readonly transport?: { sessionId?: string } | undefined;
  /** Called when a 2025 client completes `initialize` (chained, not replaced). */
  oninitialized?: (() => void) | undefined;
}

/** MCP logging levels by severity (the spec's order, lowest first). */
const SEVERITY: readonly string[] = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
];

/** Whether a 2026-07-28 request's `logLevel` lets `level` through. */
function belowRequestLevel(level: McpLevel, threshold?: string): boolean {
  if (threshold === undefined) return true;
  const floor = SEVERITY.indexOf(threshold);
  return floor < 0 || SEVERITY.indexOf(level) < floor;
}

interface Bucket {
  tokens: number;
  refilledAt: number;
  suppressed: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Whether the client's level (logging/setLevel) drops this message anyway.
 * The SDK's check is not part of its typed surface, so it is used only when
 * present; a dropped message must not spend a token.
 */
function ignoredByClient(
  server: LoggingServer,
  level: McpLevel,
  sessionId: string | undefined,
): boolean {
  const check = (server as unknown as Record<string, unknown>).isMessageIgnored;
  return (
    typeof check === "function" &&
    (check as (l: string, s?: string) => boolean).call(
      server,
      level,
      sessionId,
    ) === true
  );
}

/** A log bridge: the sink plus the release of its per-session state (N-89). */
export type LogBridge = LogSink & {
  /**
   * Drop every rate bucket and cancel a pending suppressed-lines summary;
   * lines logged afterwards are not forwarded (the session is gone, stderr
   * keeps them). Safe to call more than once.
   */
  dispose(): void;
};

/** Build the log sink that forwards to `server` (see the module comment). */
export function createLogBridge(server: LoggingServer): LogBridge {
  const buckets = new Map<string, Bucket>();
  let disposed = false;
  // A 2025 session completed initialize: lines outside a call may reach it.
  let legacySession = false;
  const previous = server.oninitialized;
  server.oninitialized = () => {
    legacySession = true;
    previous?.();
  };

  const send = (level: McpLevel, data: unknown, sessionId?: string): void => {
    void server
      .sendLoggingMessage({ level, data }, sessionId)
      .catch(() => undefined);
  };

  const flush = (key: string, sessionId: string | undefined): void => {
    const bucket = buckets.get(key);
    if (!bucket) return;
    bucket.timer = null;
    if (bucket.suppressed === 0) return;
    const count = bucket.suppressed;
    bucket.suppressed = 0;
    send(
      "warning",
      {
        message: `${count} log messages suppressed (SN_LOG_NOTIFY_RATE); see stderr for the full log`,
        suppressed: count,
      },
      sessionId,
    );
  };

  /** Take one token from the session's bucket; false when it is empty. */
  const take = (key: string, rate: number): boolean => {
    const burst = Math.max(LOG_NOTIFY_MIN_BURST, rate);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: burst, refilledAt: now, suppressed: 0, timer: null };
      buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, now - bucket.refilledAt) / 1000;
      bucket.tokens = Math.min(burst, bucket.tokens + elapsed * rate);
      bucket.refilledAt = now;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  };

  const sink: LogSink = (level, message, fields) => {
    if (disposed) return;
    const mcpLevel = MCP_LEVEL[level];
    const channel = currentCall()?.log;
    if (channel?.modern) {
      if (belowRequestLevel(mcpLevel, channel.level)) return;
    } else if (!channel && !legacySession) {
      return;
    }
    const fromContext = fields?.sessionId;
    const sessionId =
      typeof fromContext === "string" && fromContext
        ? fromContext
        : server.transport?.sessionId;
    if (!channel?.modern && ignoredByClient(server, mcpLevel, sessionId)) {
      return;
    }
    const data = { message, ...(fields ?? {}) };
    const emit = (): void => {
      if (channel) void channel.send(mcpLevel, data).catch(() => undefined);
      else send(mcpLevel, data, sessionId);
    };
    const rate = getLogNotifyRate();
    if (rate === 0) {
      emit();
      return;
    }
    const key = sessionId ?? "";
    if (take(key, rate)) {
      emit();
      return;
    }
    if (channel?.modern) return;
    const bucket = buckets.get(key)!;
    bucket.suppressed++;
    if (!bucket.timer) {
      bucket.timer = setTimeout(
        () => flush(key, sessionId),
        LOG_SUPPRESSED_SUMMARY_MS,
      );
      // The summary must never keep the process alive.
      bucket.timer.unref?.();
    }
  };

  const dispose = (): void => {
    disposed = true;
    for (const bucket of buckets.values()) {
      if (bucket.timer) clearTimeout(bucket.timer);
    }
    buckets.clear();
  };

  return Object.assign(sink, { dispose });
}
