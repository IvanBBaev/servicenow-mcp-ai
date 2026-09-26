import type { ProgressSink, ProgressUpdate } from "../core/request-context.js";

/** A notifications/progress message as the SDK's sendNotification takes it. */
export interface ProgressNotification {
  method: "notifications/progress";
  params: {
    progressToken: string | number;
    progress: number;
    total?: number;
    message?: string;
  };
}

/**
 * Minimum gap between two progress notifications of one call. A fetchAll over
 * a large table or a snapshot of many tables would otherwise emit one message
 * per page or file — noise for the client and the transport.
 */
export const PROGRESS_MIN_INTERVAL_MS = 250;

export interface ThrottledProgress {
  sink: ProgressSink;
  /** Send the last update the throttle held back, if any (end of the call). */
  flush(): void;
}

/**
 * M-3 — turn a call's `progressToken` into a throttled progress sink.
 *
 * - Progress must increase (MCP spec): a value not above the last one sent is
 *   dropped, so nested or repeated reports can never go backwards.
 * - At most one notification per `minIntervalMs`; an update that completes
 *   the work (`progress >= total`) is always sent at once. The newest update
 *   held back is sent by `flush()`, which runSpec calls before it returns.
 * - A failing send never fails the tool call.
 */
export function createProgressSink(
  progressToken: string | number,
  send: (notification: ProgressNotification) => Promise<void>,
  minIntervalMs = PROGRESS_MIN_INTERVAL_MS,
  now: () => number = Date.now,
): ThrottledProgress {
  let last = Number.NEGATIVE_INFINITY;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let pending: ProgressUpdate | undefined;

  const emit = (update: ProgressUpdate): void => {
    last = update.progress;
    lastSentAt = now();
    pending = undefined;
    const notification: ProgressNotification = {
      method: "notifications/progress",
      params: {
        progressToken,
        progress: update.progress,
        ...(update.total === undefined ? {} : { total: update.total }),
        ...(update.message ? { message: update.message } : {}),
      },
    };
    try {
      void Promise.resolve(send(notification)).catch(() => undefined);
    } catch {
      // A transport that throws synchronously is ignored the same way.
    }
  };

  return {
    sink: (update) => {
      if (!Number.isFinite(update.progress) || update.progress <= last) return;
      const complete =
        update.total !== undefined && update.progress >= update.total;
      if (complete || now() - lastSentAt >= minIntervalMs) emit(update);
      else pending = update;
    },
    flush: () => {
      if (pending) emit(pending);
    },
  };
}
