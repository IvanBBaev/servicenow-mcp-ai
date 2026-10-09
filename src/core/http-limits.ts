import { logger } from "./logging.js";
import { currentRuntime, defineRuntimePart } from "./runtime.js";
import {
  getBreakerResetMs,
  getBreakerThreshold,
  getMaxConcurrent,
  getMaxQueue,
  getQueueTimeoutMs,
} from "./settings.js";

/**
 * Per-host load limits for the request primitive: the bounded concurrency
 * semaphore and the circuit breaker.
 */

// Counting semaphore around fetch, per host: protects each instance from
// request salvos (tableLogic fires 5 in parallel, fetchAll can chain dozens)
// without one host starving another. The wait line is bounded (SN_MAX_QUEUE)
// and timed (SN_QUEUE_TIMEOUT_MS): a stalled instance fails fast with BUSY
// instead of accumulating an unbounded backlog of doomed callers (L1-04).
interface Waiter {
  grant: () => void;
  cancel: (err: Error) => void;
}

interface Slot {
  active: number;
  waiters: Waiter[];
}

// E-3: the slot table lives in the runtime container; dispose() drains it.
const slotsPart = defineRuntimePart(
  "queue",
  () => new Map<string, Slot>(),
  (slots) => {
    drainSlots(slots);
  },
  { scope: "process" },
);

/** Thrown by withSlot when the caller cannot get a slot in time. */
export class SlotBusyError extends Error {
  constructor(
    public readonly reason: "full" | "timeout" | "drained",
    public readonly host: string,
    public readonly queued: number,
    public readonly limitMs: number,
  ) {
    super(
      reason === "full"
        ? `Request queue for ${host} is full (${queued} waiting).`
        : reason === "drained"
          ? `Request queue for ${host} was drained (the server is shutting down or resetting).`
          : `Timed out after ${limitMs}ms waiting for a request slot on ${host} (${queued} waiting).`,
    );
    this.name = "SlotBusyError";
  }
}

export interface SlotOptions {
  /** Run immediately without taking or waiting for a slot (diagnostics). */
  bypass?: boolean;
  maxQueue?: number;
  queueTimeoutMs?: number;
  /** Leave the wait line when this aborts (M-3: a cancelled tool call). */
  signal?: AbortSignal;
}

function slotFor(host: string): Slot {
  const slots = currentRuntime().get(slotsPart);
  let slot = slots.get(host);
  if (!slot) {
    slot = { active: 0, waiters: [] };
    slots.set(host, slot);
  }
  return slot;
}

function release(s: Slot, limit: number): void {
  s.active -= 1;
  // Hand the freed slot straight to the next waiter (no re-check race).
  if (s.active < limit) {
    const next = s.waiters.shift();
    if (next) {
      s.active += 1;
      next.grant();
    }
  }
}

export async function withSlot<T>(
  host: string,
  fn: () => Promise<T>,
  opts: SlotOptions = {},
): Promise<T> {
  if (opts.bypass) return fn();
  const limit = getMaxConcurrent();
  const s = slotFor(host);
  if (s.active < limit) {
    s.active += 1;
  } else {
    const maxQueue = opts.maxQueue ?? getMaxQueue();
    if (s.waiters.length >= maxQueue) {
      throw new SlotBusyError("full", host, s.waiters.length, 0);
    }
    const queueTimeoutMs = opts.queueTimeoutMs ?? getQueueTimeoutMs();
    const { signal } = opts;
    if (signal?.aborted) throw abortReason(signal);
    await new Promise<void>((resolve, reject) => {
      const leave = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const idx = s.waiters.indexOf(waiter);
        if (idx >= 0) s.waiters.splice(idx, 1);
      };
      const onAbort = (): void => {
        leave();
        reject(abortReason(signal));
      };
      const waiter: Waiter = {
        grant: () => {
          leave();
          resolve();
        },
        cancel: (err) => {
          leave();
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        leave();
        reject(
          new SlotBusyError("timeout", host, s.waiters.length, queueTimeoutMs),
        );
      }, queueTimeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      s.waiters.push(waiter);
    });
  }
  try {
    return await fn();
  } finally {
    release(s, limit);
  }
}

/** The error an aborted wait rejects with (the signal's reason, when an Error). */
function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

/** Per-host queue occupancy, for get_status. */
export function getQueueStats(): Record<
  string,
  { active: number; queued: number }
> {
  const out: Record<string, { active: number; queued: number }> = {};
  for (const [host, s] of currentRuntime().get(slotsPart)) {
    if (s.active > 0 || s.waiters.length > 0) {
      out[host] = { active: s.active, queued: s.waiters.length };
    }
  }
  return out;
}

/**
 * Reject every caller still waiting for a slot (they fail with code BUSY) and
 * forget the per-host slot state. For process shutdown / lifecycle dispose();
 * requests already in flight are not interrupted. Returns how many waiters
 * were rejected.
 */
export function drainQueue(): number {
  return drainSlots(currentRuntime().get(slotsPart));
}

function drainSlots(slots: Map<string, Slot>): number {
  let rejected = 0;
  for (const [host, s] of slots) {
    for (const w of s.waiters.splice(0)) {
      w.cancel(new SlotBusyError("drained", host, 0, 0));
      rejected += 1;
    }
  }
  slots.clear();
  return rejected;
}

// After SN_BREAKER_THRESHOLD consecutive failed requests (transport error,
// deadline, 5xx) to one host, further requests fail fast with CIRCUIT_OPEN for
// SN_BREAKER_RESET_MS instead of each burning a full timeout against an
// instance that is down. When the window passes, requests flow again
// (half-open); the first failure re-opens the breaker at once, the first
// success closes it. Diagnostics (bypassQueue) are never rejected, so doctor
// and test_connection still report what is actually wrong.
interface Breaker {
  failures: number;
  openUntil: number;
}

// E-3: breaker state lives in the runtime container; dispose() closes them.
const breakersPart = defineRuntimePart(
  "breakers",
  () => new Map<string, Breaker>(),
  (state) => state.clear(),
  { scope: "process" },
);

const breakers = (): Map<string, Breaker> => currentRuntime().get(breakersPart);

/** Thrown internally when a host's breaker is open. */
export class CircuitOpen extends Error {
  constructor(public readonly retryInMs: number) {
    super("circuit open");
    this.name = "CircuitOpen";
  }
}

export function breakerCheck(key: string): void {
  const b = breakers().get(key);
  if (!b || getBreakerThreshold() === 0) return;
  const left = b.openUntil - Date.now();
  if (left > 0) throw new CircuitOpen(left);
}

export function breakerSuccess(key: string): void {
  breakers().delete(key);
}

export function breakerFailure(key: string): void {
  const threshold = getBreakerThreshold();
  if (threshold === 0) return;
  const b = breakers().get(key) ?? { failures: 0, openUntil: 0 };
  b.failures += 1;
  if (b.failures >= threshold) {
    b.openUntil = Date.now() + getBreakerResetMs();
    logger.warn("Circuit breaker opened", { host: key, failures: b.failures });
  }
  breakers().set(key, b);
}

/** Per-host breaker state (only hosts with recorded failures), for status. */
export function getBreakerStats(): Record<
  string,
  { failures: number; open: boolean }
> {
  const out: Record<string, { failures: number; open: boolean }> = {};
  const now = Date.now();
  for (const [host, b] of breakers()) {
    out[host] = { failures: b.failures, open: b.openUntil > now };
  }
  return out;
}

/** Close every breaker and forget failure counts (profile switch, dispose()). */
export function resetBreakers(): void {
  breakers().clear();
}
