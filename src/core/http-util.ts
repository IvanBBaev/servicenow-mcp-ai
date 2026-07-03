import { getMaxConcurrent } from "./settings.js";

/**
 * Transport primitives shared by every REST client in this server (the
 * ServiceNow client in http.ts and the Jira client in jira/http.ts): the retry
 * matrix, exponential backoff, the per-host concurrency semaphore and the
 * in-process telemetry. Keeping them here means there is still effectively
 * "one HTTP client" — the two callers differ only in host resolution, auth and
 * error-body shape, not in how they retry or rate-limit.
 */

/**
 * In-process telemetry: enough to answer "why is it slow / what is failing"
 * from the client itself (exposed via get_status and servicenow://status).
 * Counted per host so a multi-instance (or multi-system) breakdown comes for
 * free; getTelemetry() also returns the aggregate.
 */
export interface Telemetry {
  requests: number;
  retries: number;
  errors: Record<string, number>;
  totalMs: number;
}

export interface TelemetrySnapshot extends Telemetry {
  perHost: Record<string, Telemetry>;
}

const perHostTelemetry = new Map<string, Telemetry>();

export function telemetryFor(host: string): Telemetry {
  let t = perHostTelemetry.get(host);
  if (!t) {
    t = { requests: 0, retries: 0, errors: {}, totalMs: 0 };
    perHostTelemetry.set(host, t);
  }
  return t;
}

export function getTelemetry(): TelemetrySnapshot {
  const aggregate: TelemetrySnapshot = {
    requests: 0,
    retries: 0,
    errors: {},
    totalMs: 0,
    perHost: {},
  };
  for (const [host, t] of perHostTelemetry) {
    aggregate.requests += t.requests;
    aggregate.retries += t.retries;
    aggregate.totalMs += t.totalMs;
    for (const [k, n] of Object.entries(t.errors)) {
      aggregate.errors[k] = (aggregate.errors[k] ?? 0) + n;
    }
    aggregate.perHost[host] = { ...t, errors: { ...t.errors } };
  }
  return aggregate;
}

/** Test hook. */
export function _resetTelemetry(): void {
  perHostTelemetry.clear();
}

export function countError(
  t: Telemetry,
  key: string | number | undefined,
): void {
  const k = String(key ?? "transport");
  t.errors[k] = (t.errors[k] ?? 0) + 1;
}

// Plain counting semaphore around fetch, per host: protects each instance from
// request salvos (tableLogic fires 5 in parallel, fetchAll can chain dozens)
// without one host starving another.
interface Slot {
  active: number;
  waiters: (() => void)[];
}

const slots = new Map<string, Slot>();

export async function withSlot<T>(
  host: string,
  fn: () => Promise<T>,
): Promise<T> {
  const limit = getMaxConcurrent();
  let slot = slots.get(host);
  if (!slot) {
    slot = { active: 0, waiters: [] };
    slots.set(host, slot);
  }
  const s = slot;
  while (s.active >= limit) {
    await new Promise<void>((resolve) => s.waiters.push(resolve));
  }
  s.active += 1;
  try {
    return await fn();
  } finally {
    s.active -= 1;
    s.waiters.shift()?.();
  }
}

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

export function backoffMs(attempt: number): number {
  const base = Math.min(500 * 2 ** (attempt - 1), 8000);
  return base + Math.floor(Math.random() * 250);
}

// A server-supplied Retry-After is honoured but capped: an absurd value (a
// hostile or buggy header asking for an hour) must not hang a tool call. Past
// the cap the request retries early and either succeeds or exhausts its
// attempts and surfaces the error, rather than blocking silently.
const MAX_RETRY_AFTER_MS = 60_000;

export function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get("retry-after");
  if (!header) return undefined;
  const clamp = (ms: number): number =>
    Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms));
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return clamp(seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : clamp(date - Date.now());
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
