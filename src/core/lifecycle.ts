/**
 * E-9 — process lifecycle.
 *
 * Two concerns live here:
 *
 * 1. `dispose()` tears down the process runtime (E-3, `core/runtime.ts`): the
 *    schema cache, cached OAuth tokens, the per-host request queue and circuit
 *    breakers, the undici dispatchers — proxy / TLS connection pools — HTTP
 *    telemetry, the plugin-availability map, plus whatever is registered
 *    through `registerDisposer`. It is a thin delegate to
 *    `currentRuntime().dispose()`, kept so the signal, session-close and crash
 *    paths need not hold the runtime. Called on SIGINT/SIGTERM, when an HTTP
 *    session closes, and by tests.
 *
 * 2. The crash handlers (`installCrashHandlers`): an unhandled rejection or an
 *    uncaught exception logs exactly one structured, secret-free `error` line
 *    and exits 1 after flushing stderr. A process whose state may be corrupt
 *    (a background token refresh, a stray semaphore waiter) must not run on —
 *    there is deliberately no keep-alive-on-error switch.
 */

import { logger } from "./logging.js";
import { getTransport } from "./settings.js";
import { currentRuntime, type Disposer } from "./runtime.js";

// ---------------------------------------------------------------------------
// dispose()
// ---------------------------------------------------------------------------

/**
 * Register extra teardown on the current runtime; see `Runtime.onDispose`.
 * Disposers run after the runtime's own state is cleared; a throwing disposer
 * is logged and does not stop the others. Returns an unregister function.
 */
export function registerDisposer(fn: Disposer): () => void {
  return currentRuntime().onDispose(fn);
}

/**
 * Tear down the current runtime's state. Idempotent, safe to call with
 * nothing initialised, and concurrent calls share one run.
 */
export function dispose(): Promise<void> {
  return currentRuntime().dispose();
}

// ---------------------------------------------------------------------------
// Crash handlers
// ---------------------------------------------------------------------------

export type CrashKind = "unhandledRejection" | "uncaughtException";

/** Upper bound on waiting for stderr to drain before exiting anyway. */
export const CRASH_FLUSH_TIMEOUT_MS = 250;

/** Error messages are bounded so a crash line cannot dump a whole payload. */
const MAX_ERROR_CHARS = 2000;

function errorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.length > MAX_ERROR_CHARS
    ? `${message.slice(0, MAX_ERROR_CHARS)}…`
    : message;
}

/**
 * The fields of a crash line: enough to correlate the line with a client's
 * "server disconnected" (pid, uptime, transport) and to name the failure
 * (error name + message) — never a stack, never the raw reason object, which
 * could carry request payloads or credentials.
 */
export function crashFields(reason: unknown): Record<string, unknown> {
  return {
    pid: process.pid,
    uptime: Math.round(process.uptime() * 1000) / 1000,
    transport: getTransport(),
    errorName: reason instanceof Error ? reason.name : typeof reason,
    error: errorMessage(reason),
  };
}

const CRASH_MESSAGE: Record<CrashKind, string> = {
  unhandledRejection: "Unhandled promise rejection — exiting",
  uncaughtException: "Uncaught exception — exiting",
};

/**
 * Log one structured error line, flush stderr and exit 1. stderr pipes are
 * asynchronous on macOS, so a bare `process.exit()` can lose the very line the
 * user needs; the exit waits for the write callback, bounded by
 * `CRASH_FLUSH_TIMEOUT_MS` in case the pipe never drains. `exit` is injectable
 * so the in-process test can observe the code; the child-process test covers
 * the real `process.exit` path.
 */
export function handleCrash(
  kind: CrashKind,
  reason: unknown,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  try {
    logger.error(CRASH_MESSAGE[kind], crashFields(reason));
  } catch {
    // Logging must never stand between a crash and the exit.
  }
  let exited = false;
  const finish = (): void => {
    if (exited) return;
    exited = true;
    clearTimeout(timer);
    exit(1);
  };
  const timer = setTimeout(finish, CRASH_FLUSH_TIMEOUT_MS);
  try {
    process.stderr.write("", finish);
  } catch {
    finish();
  }
}

/**
 * Register the process-wide crash handlers. Only the first crash is handled —
 * anything raised while stderr is draining is swallowed so the exit path emits
 * exactly one line.
 */
export function installCrashHandlers(): void {
  let crashing = false;
  const once =
    (kind: CrashKind) =>
    (reason: unknown): void => {
      if (crashing) return;
      crashing = true;
      handleCrash(kind, reason);
    };
  process.on("unhandledRejection", once("unhandledRejection"));
  process.on("uncaughtException", once("uncaughtException"));
}
