import { currentRuntime, defineRuntimePart } from "./runtime.js";

/**
 * In-process transport telemetry, counted per host (split out of
 * `src/core/http-util.ts`).
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

// E-3: counters live in the runtime container; dispose() clears them.
const telemetryPart = defineRuntimePart(
  "telemetry",
  () => new Map<string, Telemetry>(),
  (perHost) => perHost.clear(),
  { scope: "process" },
);

export function telemetryFor(host: string): Telemetry {
  const perHostTelemetry = currentRuntime().get(telemetryPart);
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
  for (const [host, t] of currentRuntime().get(telemetryPart)) {
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

export function countError(
  t: Telemetry,
  key: string | number | undefined,
): void {
  const k = String(key ?? "transport");
  t.errors[k] = (t.errors[k] ?? 0) + 1;
}
