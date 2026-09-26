import { CANCELLED_HINT, ServiceNowError } from "./errors.js";
import { currentCall, type ProgressUpdate } from "./request-context.js";

/**
 * M-3 — progress and cancellation for long-running api/ work (fetchAll,
 * snapshot_instance, compare_instances, batch; S-15's document generators).
 *
 * Everything here resolves the current tool call through the call context
 * (request-context.ts), so an api/ function reports progress without a new
 * parameter and stays a plain function outside a tool call: without a
 * progressToken every report is a no-op, without a cancellation signal
 * nothing ever throws. The MCP layer (mcp/progress.ts) owns the throttling
 * and the monotonic guard, so callers may report as often as they like.
 */

/** The error a cancelled tool call fails with (code CANCELLED). */
export function cancelledError(
  what = "The tool call was cancelled by the client.",
): ServiceNowError {
  return new ServiceNowError(what, undefined, undefined, {
    code: "CANCELLED",
    hint: CANCELLED_HINT,
  });
}

/**
 * Throw the CANCELLED error when the current call was cancelled. A long loop
 * whose steps swallow per-step failures as warnings calls this between steps,
 * so a cancelled request is never mistaken for one failed section.
 */
export function throwIfCancelled(): void {
  if (currentCall()?.signal?.aborted) throw cancelledError();
}

/** Send one progress update for the current call; a no-op without a token. */
export function reportProgress(update: ProgressUpdate): void {
  currentCall()?.progress?.(update);
}

/** A step counter over `reportProgress` — see {@link trackProgress}. */
export interface ProgressTracker {
  /**
   * Mark `units` (default 1) of work done and report it with `message` (the
   * section or path just finished). Throws CANCELLED first when the call was
   * cancelled, so a tick is also the loop's cancellation checkpoint.
   */
  tick(message?: string, units?: number): void;
  /** Units done so far. */
  readonly done: number;
}

/**
 * Count the steps of a multi-step operation against `total` (when known) and
 * report each one: `const p = trackProgress(files.length); p.tick(path)`.
 */
export function trackProgress(total?: number): ProgressTracker {
  let done = 0;
  return {
    tick(message?: string, units = 1): void {
      throwIfCancelled();
      done += units;
      reportProgress({
        progress: done,
        ...(total === undefined ? {} : { total }),
        ...(message ? { message } : {}),
      });
    },
    get done() {
      return done;
    },
  };
}

/**
 * The `onProgress` for a top-level fetchAll read (query_records): one report
 * per page, counting records against the expected total. Composite operations
 * (snapshot, compare) report their own steps instead — never both, since a
 * record count and a step count on one token would not be monotonic.
 */
export function fetchAllProgress(
  table: string,
): (fetched: number, total?: number) => void {
  return (fetched, total) =>
    reportProgress({
      progress: fetched,
      ...(total === undefined ? {} : { total }),
      message: `${fetched} ${table} record(s) fetched`,
    });
}
