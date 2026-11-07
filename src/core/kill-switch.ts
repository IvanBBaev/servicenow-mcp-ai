/**
 * N-108 (GV-I1, RR-GV-12) — the instance-side kill switch.
 *
 * A managed policy file may name `instanceKillSwitchProperty`, a sys_properties
 * record the platform owner controls. Before an applied write is sent, the
 * server reads that property (cached for {@link KILL_SWITCH_TTL_MS} per
 * instance host); while it is `true`, the write is refused with
 * `POLICY_KILL_SWITCH`. One switch on the instance stops writes from every
 * laptop and replica without touching any of them.
 *
 * The property is honoured "when readable": a property that does not exist,
 * or a read the account is not allowed to make, counts as off and is logged
 * at `warn` once per TTL. The lever is the platform owner's, so the account
 * must be able to read it; the doctor report names the property.
 */
import { snRequest } from "./http.js";
import { resolveHost } from "./host.js";
import { getCredentials } from "./config.js";
import { logger } from "./logging.js";
import { managedKillSwitchProperties } from "./managed-policy.js";
import {
  currentRuntime,
  defineRuntimePart,
  type RuntimePart,
} from "./runtime.js";

/** How long one read of the switch is trusted. */
export const KILL_SWITCH_TTL_MS = 60_000;

interface Reading {
  at: number;
  /** The property names found `true`. */
  engaged: string[];
}

/** host → the last reading. Defined on first use (see managed-policy.ts). */
let readingsPart: RuntimePart<Map<string, Reading>> | undefined;

function readings(): Map<string, Reading> {
  readingsPart ??= defineRuntimePart(
    "kill-switch",
    () => new Map<string, Reading>(),
    undefined,
    { scope: "process" },
  );
  return currentRuntime().get(readingsPart);
}

async function readSwitch(names: string[]): Promise<string[]> {
  const params = new URLSearchParams({
    sysparm_query: `nameIN${names.join(",")}`,
    sysparm_fields: "name,value",
    sysparm_limit: String(names.length),
  });
  const res = await snRequest<{
    result?: Array<{ name?: unknown; value?: unknown }>;
  }>({ method: "GET", path: "/api/now/table/sys_properties", params });
  const rows = res.data?.result ?? [];
  const found = new Set(rows.map((r) => String(r.name)));
  const missing = names.filter((n) => !found.has(n));
  if (missing.length > 0) {
    logger.warn("kill switch property not readable; treated as off", {
      properties: missing,
    });
  }
  return rows
    .filter((r) => String(r.value).trim().toLowerCase() === "true")
    .map((r) => String(r.name));
}

/**
 * The kill-switch properties that are `true` on the active instance, or an
 * empty list (no switch configured, switch off, or not readable).
 */
export async function engagedKillSwitch(): Promise<string[]> {
  const names = managedKillSwitchProperties();
  if (names.length === 0) return [];
  const { instance } = getCredentials();
  if (!instance) return [];
  const host = resolveHost(instance);
  const cache = readings();
  const now = Date.now();
  const hit = cache.get(host);
  if (hit && now - hit.at < KILL_SWITCH_TTL_MS) return hit.engaged;
  let engaged: string[];
  try {
    engaged = await readSwitch(names);
  } catch (error) {
    logger.warn("kill switch read failed; treated as off", {
      properties: names,
      error: error instanceof Error ? error.message : String(error),
    });
    engaged = [];
  }
  cache.set(host, { at: now, engaged });
  return engaged;
}
