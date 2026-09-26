import { getSchemaCacheStats } from "../core/cache.js";
import {
  getBreakerStats,
  getQueueStats,
  getTelemetry,
} from "../core/http-util.js";
import {
  getRateLimitStats,
  getToolStats,
  TOOL_SAMPLE_SIZE,
} from "../core/metrics.js";
import { getMaxConcurrent, getMaxQueue } from "../core/settings.js";

/**
 * E-5 — one snapshot of the in-process metrics, shared by the
 * `servicenow_get_status` `observability` block and the Prometheus
 * `GET /metrics` endpoint (HTTP transport, `SN_METRICS=1`), so the two can
 * never disagree. Everything is read from the current runtime; nothing here
 * calls the instance.
 */
export function observabilityPayload() {
  const telemetry = getTelemetry();
  return {
    // Per-tool counters since startup; p50/p95 (ms) over the last
    // `sampleWindow` calls of each tool.
    tools: getToolStats(),
    sampleWindow: TOOL_SAMPLE_SIZE,
    cache: { schema: getSchemaCacheStats() },
    // Per telemetry bucket (host, or "auth" for token requests).
    retries: Object.fromEntries(
      Object.entries(telemetry.perHost).map(([host, t]) => [host, t.retries]),
    ),
    queue: {
      limits: { maxConcurrent: getMaxConcurrent(), maxQueue: getMaxQueue() },
      hosts: getQueueStats(),
    },
    // Hosts with recorded failures only; `open` = requests are refused now.
    breakers: getBreakerStats(),
    // The last X-RateLimit-* headers each host sent (L1-07).
    rateLimit: getRateLimitStats(),
  };
}

// --- Prometheus text exposition (format 0.0.4) ----------------------------

/** Escape a label value per the exposition format. */
export function escapeLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

type Labels = Record<string, string>;

class Exposition {
  private readonly lines: string[] = [];

  family(name: string, type: string, help: string): this {
    this.lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    return this;
  }

  sample(name: string, labels: Labels, value: number): this {
    const pairs = Object.entries(labels).map(
      ([k, v]) => `${k}="${escapeLabel(v)}"`,
    );
    const suffix = pairs.length > 0 ? `{${pairs.join(",")}}` : "";
    this.lines.push(`${name}${suffix} ${Number.isFinite(value) ? value : 0}`);
    return this;
  }

  toString(): string {
    return `${this.lines.join("\n")}\n`;
  }
}

/** Metric-name prefix of every family. */
const P = "servicenow_mcp";

/**
 * Render the observability snapshot in the Prometheus text format. Label
 * values are tool names and host names only — never URLs, queries or
 * credentials.
 */
export function renderPrometheus(): string {
  const o = observabilityPayload();
  const telemetry = getTelemetry();
  const out = new Exposition();

  const tools = Object.entries(o.tools);
  out.family(`${P}_tool_calls_total`, "counter", "Tool calls since startup.");
  for (const [tool, s] of tools) {
    out.sample(`${P}_tool_calls_total`, { tool }, s.count);
  }
  out.family(
    `${P}_tool_errors_total`,
    "counter",
    "Tool calls that returned an error result.",
  );
  for (const [tool, s] of tools) {
    out.sample(`${P}_tool_errors_total`, { tool }, s.errors);
  }
  out.family(
    `${P}_tool_duration_ms`,
    "summary",
    `Tool call duration in ms; quantiles over the last ${o.sampleWindow} calls.`,
  );
  for (const [tool, s] of tools) {
    out.sample(`${P}_tool_duration_ms`, { tool, quantile: "0.5" }, s.p50);
    out.sample(`${P}_tool_duration_ms`, { tool, quantile: "0.95" }, s.p95);
    out.sample(`${P}_tool_duration_ms_sum`, { tool }, s.totalMs);
    out.sample(`${P}_tool_duration_ms_count`, { tool }, s.count);
  }

  const hosts = Object.entries(telemetry.perHost);
  out.family(
    `${P}_http_requests_total`,
    "counter",
    "Logical outbound HTTP requests.",
  );
  for (const [host, t] of hosts) {
    out.sample(`${P}_http_requests_total`, { host }, t.requests);
  }
  out.family(`${P}_http_retries_total`, "counter", "Replayed HTTP attempts.");
  for (const [host, t] of hosts) {
    out.sample(`${P}_http_retries_total`, { host }, t.retries);
  }
  out.family(
    `${P}_http_errors_total`,
    "counter",
    "Failed HTTP requests by kind (status code or client-side condition).",
  );
  for (const [host, t] of hosts) {
    for (const [kind, n] of Object.entries(t.errors)) {
      out.sample(`${P}_http_errors_total`, { host, kind }, n);
    }
  }
  out.family(
    `${P}_http_duration_ms_sum`,
    "counter",
    "Total wall time of finished HTTP requests in ms.",
  );
  for (const [host, t] of hosts) {
    out.sample(`${P}_http_duration_ms_sum`, { host }, t.totalMs);
  }

  const queue = Object.entries(o.queue.hosts);
  out.family(`${P}_queue_active`, "gauge", "Requests holding a host slot.");
  for (const [host, q] of queue) {
    out.sample(`${P}_queue_active`, { host }, q.active);
  }
  out.family(`${P}_queue_waiting`, "gauge", "Requests waiting for a slot.");
  for (const [host, q] of queue) {
    out.sample(`${P}_queue_waiting`, { host }, q.queued);
  }

  const breakers = Object.entries(o.breakers);
  out.family(`${P}_breaker_open`, "gauge", "1 while the host breaker is open.");
  for (const [host, b] of breakers) {
    out.sample(`${P}_breaker_open`, { host }, b.open ? 1 : 0);
  }
  out.family(
    `${P}_breaker_failures`,
    "gauge",
    "Consecutive failures counted by the host breaker.",
  );
  for (const [host, b] of breakers) {
    out.sample(`${P}_breaker_failures`, { host }, b.failures);
  }

  const cache = o.cache.schema;
  out.family(`${P}_schema_cache_hits_total`, "counter", "Schema cache hits.");
  out.sample(`${P}_schema_cache_hits_total`, {}, cache.hits);
  out.family(
    `${P}_schema_cache_misses_total`,
    "counter",
    "Schema cache misses.",
  );
  out.sample(`${P}_schema_cache_misses_total`, {}, cache.misses);
  out.family(
    `${P}_schema_cache_evictions_total`,
    "counter",
    "Schema cache LRU evictions.",
  );
  out.sample(`${P}_schema_cache_evictions_total`, {}, cache.evictions);
  out.family(`${P}_schema_cache_size`, "gauge", "Schema cache entries.");
  out.sample(`${P}_schema_cache_size`, {}, cache.size);

  const limits = Object.entries(o.rateLimit);
  out.family(
    `${P}_ratelimit_limit`,
    "gauge",
    "Last X-RateLimit-Limit a host sent.",
  );
  for (const [host, r] of limits) {
    if (r.limit !== undefined) {
      out.sample(`${P}_ratelimit_limit`, { host }, r.limit);
    }
  }
  out.family(
    `${P}_ratelimit_remaining`,
    "gauge",
    "Last X-RateLimit-Remaining a host sent.",
  );
  for (const [host, r] of limits) {
    if (r.remaining !== undefined) {
      out.sample(`${P}_ratelimit_remaining`, { host }, r.remaining);
    }
  }

  return out.toString();
}
