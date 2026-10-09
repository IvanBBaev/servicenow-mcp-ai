import { getRetryAfterMaxMs } from "./settings.js";

/**
 * The retry matrix, backoff, `Retry-After` handling and abort-signal helpers
 * used by the request primitive.
 */

// 429 means the request was rejected by the rate limiter *before* it was
// processed, so the write never landed — safe (and recommended) to replay on
// any method. 502/503/504 are gateway/unavailable responses where a write may
// already have landed, so they are only retried for idempotent (GET) requests;
// replaying them could duplicate a create/transition.
const RETRYABLE_ANY_METHOD = new Set([429]);

const RETRYABLE_IDEMPOTENT = new Set([502, 503, 504]);

export function isIdempotent(method: string): boolean {
  return method === "GET";
}

export function shouldRetryStatus(status: number, method: string): boolean {
  if (RETRYABLE_ANY_METHOD.has(status)) return true;
  return isIdempotent(method) && RETRYABLE_IDEMPOTENT.has(status);
}

/** Same matrix with an explicit idempotency verdict (the token POST is replayable). */
export function shouldRetryStatusFor(
  status: number,
  idempotent: boolean,
): boolean {
  if (RETRYABLE_ANY_METHOD.has(status)) return true;
  return idempotent && RETRYABLE_IDEMPOTENT.has(status);
}

export function backoffMs(attempt: number): number {
  const base = Math.min(500 * 2 ** (attempt - 1), 8000);
  return base + Math.floor(Math.random() * 250);
}

/**
 * A server-supplied Retry-After is honoured but capped (SN_RETRY_AFTER_MAX_MS,
 * default 60 s): an absurd value (a hostile or buggy header asking for an hour)
 * must not hang a tool call. Past the cap the request retries early and either
 * succeeds or exhausts its attempts and surfaces the error, rather than
 * blocking silently.
 */
export function retryAfterMs(
  res: Response,
  maxMs: number = getRetryAfterMaxMs(),
): number | undefined {
  const header = res.headers.get("retry-after");
  if (!header) return undefined;
  const clamp = (ms: number): number => Math.min(maxMs, Math.max(0, ms));
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return clamp(seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : clamp(date - Date.now());
}

/** Sleep, ending early (still resolving) when `signal` aborts. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * One signal that aborts when any input aborts — AbortSignal.any where the
 * runtime has it (Node ≥ 20.3), a manual composite otherwise.
 */
export function anySignal(
  signals: (AbortSignal | undefined)[],
): AbortSignal | undefined {
  const list = signals.filter((s): s is AbortSignal => Boolean(s));
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  const native = (
    AbortSignal as unknown as {
      any?: (signals: AbortSignal[]) => AbortSignal;
    }
  ).any;
  if (typeof native === "function") return native.call(AbortSignal, list);
  const controller = new AbortController();
  for (const s of list) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), {
      once: true,
    });
  }
  return controller.signal;
}

export function isAbortError(err: Error): boolean {
  return err.name === "TimeoutError" || err.name === "AbortError";
}
