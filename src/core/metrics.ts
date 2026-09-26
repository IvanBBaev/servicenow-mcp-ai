import { channel } from "node:diagnostics_channel";
import { currentRuntime, defineRuntimePart } from "./runtime.js";

/**
 * E-5 — in-process observability beyond the HTTP telemetry in http-util.ts:
 * per-tool call statistics, the last rate-limit headers each host sent, and
 * the `node:diagnostics_channel` publish points of the request loop.
 *
 * Memory is bounded: a tool keeps its last TOOL_SAMPLE_SIZE durations in a
 * fixed ring (p50/p95 are computed over that window, the counters are
 * cumulative), the tool set is the finite registered manifest, and the
 * rate-limit map holds one entry per host. Both live in the runtime container,
 * so `dispose()` (and `freshRuntime()` in tests) starts them from empty.
 */

// --- per-tool call statistics ---------------------------------------------

/** Durations kept per tool for the percentiles (a sliding window). */
export const TOOL_SAMPLE_SIZE = 256;

interface ToolSeries {
  count: number;
  errors: number;
  totalMs: number;
  /** Ring buffer of the most recent durations (ms). */
  samples: Float64Array;
  /** Next write position in `samples`. */
  next: number;
}

const toolStatsPart = defineRuntimePart(
  "toolStats",
  () => new Map<string, ToolSeries>(),
  (stats) => stats.clear(),
);

/** One tool's figures as `get_status` reports them. */
export interface ToolStats {
  count: number;
  errors: number;
  /** Median duration (ms) over the last TOOL_SAMPLE_SIZE calls. */
  p50: number;
  /** 95th-percentile duration (ms) over the same window. */
  p95: number;
  /** Cumulative duration of every call (ms) — the Prometheus summary sum. */
  totalMs: number;
}

/** Record one finished tool call (an `isError` result counts as an error). */
export function recordToolCall(tool: string, ms: number, error: boolean): void {
  const stats = currentRuntime().get(toolStatsPart);
  let s = stats.get(tool);
  if (!s) {
    s = {
      count: 0,
      errors: 0,
      totalMs: 0,
      samples: new Float64Array(TOOL_SAMPLE_SIZE),
      next: 0,
    };
    stats.set(tool, s);
  }
  s.count += 1;
  if (error) s.errors += 1;
  s.totalMs += ms;
  s.samples[s.next] = ms;
  s.next = (s.next + 1) % TOOL_SAMPLE_SIZE;
}

/** Nearest-rank percentile of an ascending array (0 for an empty one). */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

/** Per-tool `{count, errors, p50, p95, totalMs}`, tools in name order. */
export function getToolStats(): Record<string, ToolStats> {
  const out: Record<string, ToolStats> = {};
  const entries = [...currentRuntime().get(toolStatsPart)].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [tool, s] of entries) {
    const window = s.samples
      .slice(0, Math.min(s.count, TOOL_SAMPLE_SIZE))
      .sort();
    out[tool] = {
      count: s.count,
      errors: s.errors,
      p50: Math.round(percentile(window, 50)),
      p95: Math.round(percentile(window, 95)),
      totalMs: Math.round(s.totalMs),
    };
  }
  return out;
}

/**
 * Time `fn` as one call of `tool` and record it: a resolved result with
 * `isError: true` and a rejection both count as errors.
 */
export async function timeToolCall<T extends { isError?: boolean }>(
  tool: string,
  fn: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let error = true;
  try {
    const result = await fn();
    error = result.isError === true;
    return result;
  } finally {
    recordToolCall(tool, performance.now() - started, error);
  }
}

// --- rate-limit headers (L1-07) --------------------------------------------

/** The last rate-limit headers a host sent (ServiceNow REST rate-limit rules). */
export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  /** When the window resets (ISO), from `X-RateLimit-Reset`. */
  resetAt?: string;
  /** When these headers were observed (ISO). */
  observedAt: string;
}

const rateLimitPart = defineRuntimePart(
  "rateLimit",
  () => new Map<string, RateLimitInfo>(),
  (map) => map.clear(),
);

function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)?.trim();
  return raw && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : undefined;
}

/**
 * Parse `X-RateLimit-Limit` / `-Remaining` / `-Reset` (undefined when none is
 * present). A reset above 10^9 is an epoch in seconds; a smaller one is a
 * delay in seconds from `now`.
 */
export function parseRateLimit(
  headers: Headers,
  now: number = Date.now(),
): RateLimitInfo | undefined {
  const limit = headerNumber(headers, "x-ratelimit-limit");
  const remaining = headerNumber(headers, "x-ratelimit-remaining");
  const reset = headerNumber(headers, "x-ratelimit-reset");
  if (limit === undefined && remaining === undefined && reset === undefined) {
    return undefined;
  }
  const info: RateLimitInfo = { observedAt: new Date(now).toISOString() };
  if (limit !== undefined) info.limit = limit;
  if (remaining !== undefined) info.remaining = remaining;
  if (reset !== undefined) {
    const at = reset > 1e9 ? reset * 1000 : now + reset * 1000;
    info.resetAt = new Date(at).toISOString();
  }
  return info;
}

/** Remember a response's rate-limit headers under `host` (if it sent any). */
export function recordRateLimit(host: string, headers: Headers): void {
  const info = parseRateLimit(headers);
  if (info) currentRuntime().get(rateLimitPart).set(host, info);
}

/** The last rate-limit headers per host, for `get_status`. */
export function getRateLimitStats(): Record<string, RateLimitInfo> {
  return Object.fromEntries(currentRuntime().get(rateLimitPart));
}

// --- diagnostics_channel publish points --------------------------------------

/**
 * Channel names of the request loop (`rawRequest` in http-util.ts), stable
 * public API: an OpenTelemetry (or any) subscriber attaches with
 * `diagnostics_channel.subscribe(name, fn)` — no dependency on this server.
 * Messages carry only redacted metadata: method, host, the URL *without* its
 * query string, status, timings, error code — never headers, bodies, queries
 * or credentials. Publishing is skipped entirely when nobody subscribes.
 */
export const DIAGNOSTICS_CHANNELS = {
  /** One logical request begins (before the queue / first attempt). */
  requestStart: "servicenow-mcp:http.request.start",
  /** The request resolved with an OK response. */
  requestEnd: "servicenow-mcp:http.request.end",
  /** The request failed (any error the caller sees). */
  requestError: "servicenow-mcp:http.request.error",
  /** An attempt is about to be replayed (backoff, Retry-After, re-auth). */
  requestRetry: "servicenow-mcp:http.request.retry",
} as const;

const channels = {
  start: channel(DIAGNOSTICS_CHANNELS.requestStart),
  end: channel(DIAGNOSTICS_CHANNELS.requestEnd),
  error: channel(DIAGNOSTICS_CHANNELS.requestError),
  retry: channel(DIAGNOSTICS_CHANNELS.requestRetry),
};

/**
 * Publish `message` on one of the request channels, if anyone listens. The
 * message is built lazily, so an unobserved request pays one boolean check.
 * Node itself isolates subscribers: one that throws does not interrupt the
 * publish (the error surfaces as an `uncaughtException` on the next tick), so
 * a subscriber must handle its own errors.
 */
export function publishRequestEvent(
  kind: keyof typeof channels,
  message: () => Record<string, unknown>,
): void {
  const ch = channels[kind];
  if (ch.hasSubscribers) ch.publish(message());
}
