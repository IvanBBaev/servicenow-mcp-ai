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
 */
import type { LogLevel, LogSink } from "../core/logging.js";
import { getLogNotifyRate } from "../core/settings.js";

type McpLevel = "debug" | "info" | "warning" | "error";

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

/** Build the log sink that forwards to `server` (see the module comment). */
export function createLogBridge(server: LoggingServer): LogSink {
  const buckets = new Map<string, Bucket>();

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

  return (level, message, fields) => {
    const mcpLevel = MCP_LEVEL[level];
    const fromContext = fields?.sessionId;
    const sessionId =
      typeof fromContext === "string" && fromContext
        ? fromContext
        : server.transport?.sessionId;
    if (ignoredByClient(server, mcpLevel, sessionId)) return;
    const data = { message, ...(fields ?? {}) };
    const rate = getLogNotifyRate();
    if (rate === 0) {
      send(mcpLevel, data, sessionId);
      return;
    }
    const key = sessionId ?? "";
    if (take(key, rate)) {
      send(mcpLevel, data, sessionId);
      return;
    }
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
}
