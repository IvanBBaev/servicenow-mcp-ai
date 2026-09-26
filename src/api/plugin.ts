import { getCredentials } from "../core/config.js";
import { ServiceNowError } from "../core/errors.js";
import { logger } from "../core/logging.js";
import { currentRuntime, defineRuntimePart } from "../core/runtime.js";
import {
  getCapabilityTtlMs,
  getPluginNegativeTtlMs,
} from "../core/settings.js";
import { queryTable } from "./table.js";

/**
 * Wrap a call to a plugin-scoped API. ServiceNow returns 404 for the whole
 * namespace when the backing plugin is not installed/active, which is easy to
 * misread as "record not found". When a 404 surfaces we append a hint that the
 * API may simply be inactive on this instance, without hiding the original
 * message or status.
 *
 * A *namespace* 404 (as opposed to a record-level one) additionally marks the
 * API unavailable for `SN_PLUGIN_NEGATIVE_TTL_MS` (default 60 s), so repeated
 * calls fail fast without hitting the instance again — but a transient answer
 * never poisons the session for long (S-13 / L6-06). Successful calls mark it
 * available for `SN_CAPABILITY_TTL_MS` (default 10 min); errors without a
 * namespace 404 (5xx, transport failures) are never cached. The map is exposed
 * in the status payload.
 */

/** "45s" / "5 min" — the negative-cache window, for the fast-fail message. */
function describeWindow(ms: number): string {
  return ms < 120_000
    ? `${Math.round(ms / 1000)}s`
    : `${Math.round(ms / 60_000)} min`;
}

/**
 * ServiceNow's 404 body for a missing REST namespace says the URI does not
 * map to a resource; a 404 for a missing record says "No Record found".
 * Only the former proves the plugin is absent.
 */
const NAMESPACE_404 = /does not represent any resource|invalid uri/i;

/**
 * Plugin / store-app ids that back each plugin-scoped API (H-8 C-10). Used only
 * to tell "installed but inactive" from "not installed" after a namespace 404.
 * Best-effort: ids differ across releases and are not verified against a live
 * instance — an unknown id simply reads as "not found" in the probe, so the
 * verdict falls back to the generic wording rather than a wrong claim.
 */
export const PLUGIN_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  "CI/CD": ["sn_cicd", "com.glide.continuousdelivery"],
  "Change Management": [
    "com.snc.change_management",
    "com.snc.change_management.core",
    "sn_chg_rest",
  ],
  "Service Catalog": ["com.glideapp.servicecatalog", "sn_sc"],
  Knowledge: ["com.snc.knowledge_management", "sn_km_api"],
  "Code Search": ["sn_codesearch", "com.glide.sn-codesearch"],
};

/** Outcome of the plugin-state probe that follows a namespace 404. */
export type PluginVerdict =
  | { state: "inactive"; id: string; name?: string }
  | { state: "missing"; ids: readonly string[] }
  | { state: "active"; id: string; name?: string };

/** Probe signature — replaceable for tests via `setPluginProbe`. */
export type PluginProbe = (
  ids: readonly string[],
) => Promise<PluginVerdict | undefined>;

const isActive = (v: unknown): boolean => {
  const raw = typeof v === "object" && v !== null && "value" in v ? v.value : v;
  return raw === true || raw === "true" || raw === "active";
};

/**
 * Default probe: v_plugin (id, active = "active"/"inactive"), falling back to
 * sys_plugins (source, active = true/false). Goes through queryTable, so the
 * table policy applies; any failure (ACL, policy, network) yields undefined —
 * the caller then keeps the generic message.
 */
export const defaultPluginProbe: PluginProbe = async (ids) => {
  const lookups: Array<{ table: string; idField: string }> = [
    { table: "v_plugin", idField: "id" },
    { table: "sys_plugins", idField: "source" },
  ];
  for (const { table, idField } of lookups) {
    try {
      const { records } = await queryTable({
        table,
        query: `${idField}IN${ids.join(",")}`,
        fields: [idField, "name", "active"],
        limit: ids.length,
        displayValue: "false",
      });
      const found = records.map((r) => {
        const id = r[idField];
        return {
          id: typeof id === "string" && id ? id : (ids[0] ?? "?"),
          name: typeof r.name === "string" ? r.name : undefined,
          active: isActive(r.active),
        };
      });
      const hit = found.find((f) => f.active) ?? found[0];
      if (!hit) return { state: "missing", ids };
      return {
        state: hit.active ? "active" : "inactive",
        id: hit.id,
        ...(hit.name ? { name: hit.name } : {}),
      };
    } catch {
      // Try the next source; both failing means "unknown".
    }
  }
  return undefined;
};

let probe: PluginProbe = defaultPluginProbe;

/** Replace the plugin-state probe (tests); returns the previous one. */
export function setPluginProbe(next: PluginProbe): PluginProbe {
  const prev = probe;
  probe = next;
  return prev;
}

/** One actionable sentence per verdict; "" when the state is unknown. */
export function describeVerdict(
  apiLabel: string,
  verdict: PluginVerdict | undefined,
): string {
  if (!verdict) return "";
  const who = (id: string, name?: string): string =>
    name ? `'${name}' (${id})` : id;
  switch (verdict.state) {
    case "inactive":
      return ` The backing plugin ${who(verdict.id, verdict.name)} is installed but inactive — activate it (System Definition > Plugins) to enable the ${apiLabel} API.`;
    case "missing":
      return ` No backing plugin (${verdict.ids.join(", ")}) is installed on this instance — install and activate it (System Definition > Plugins / ServiceNow Store) to enable the ${apiLabel} API.`;
    case "active":
      return ` The backing plugin ${who(verdict.id, verdict.name)} is active, so the 404 points at the API path or version (or a role restriction), not a missing plugin.`;
  }
}

type ApiState =
  | { status: "available"; until: number }
  | { status: "unavailable"; until: number; verdict?: PluginVerdict };

// E-3: the availability map is per-session state held by the runtime
// container — dispose() (signals, HTTP session close) forgets it.
const statesPart = defineRuntimePart(
  "pluginAvailability",
  () => new Map<string, ApiState>(),
  (map) => map.clear(),
);

const states = (): Map<string, ApiState> => currentRuntime().get(statesPart);

/**
 * Availability is per *instance*: the backing plugin can be active on one
 * profile's instance and absent on another, so a 404 cached for one must never
 * fast-fail a concurrent call on a different host. Keys carry the instance the
 * same way the schema cache does (see api/meta.ts `cacheKey`).
 */
const stateKey = (apiLabel: string): string =>
  `${getCredentials().instance}|${apiLabel}`;

/**
 * Availability of every plugin API touched on the active instance (for the
 * status payload, which is itself scoped to the active profile).
 */
export function pluginAvailability(): Record<string, string> {
  const prefix = `${getCredentials().instance}|`;
  const out: Record<string, string> = {};
  const now = Date.now();
  for (const [key, s] of states()) {
    if (!key.startsWith(prefix)) continue;
    // An expired entry (either polarity) is only a memory, not a verdict.
    out[key.slice(prefix.length)] = s.until > now ? s.status : "unknown";
  }
  return out;
}

/**
 * Forget all probed availability — credential/instance changes and
 * `servicenow_check_capabilities({refresh: true})`.
 */
export function clearPluginAvailability(): void {
  states().clear();
}

export async function pluginCall<T>(
  apiLabel: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = stateKey(apiLabel);
  const state = states().get(key);
  if (state?.status === "unavailable" && state.until > Date.now()) {
    throw new ServiceNowError(
      `${apiLabel} API is not available on this instance (a namespace 404 was cached in the last ${describeWindow(getPluginNegativeTtlMs())}; the backing plugin is probably inactive).${describeVerdict(apiLabel, state.verdict)}`,
      404,
    );
  }
  try {
    const result = await fn();
    states().set(key, {
      status: "available",
      until: Date.now() + getCapabilityTtlMs(),
    });
    return result;
  } catch (err) {
    if (err instanceof ServiceNowError && err.status === 404) {
      const haystack = `${err.message} ${JSON.stringify(err.detail ?? "")}`;
      let verdict: PluginVerdict | undefined;
      if (NAMESPACE_404.test(haystack)) {
        // H-8 C-10: name the real cause — installed-but-inactive vs missing.
        const ids = PLUGIN_CANDIDATES[apiLabel];
        if (ids?.length) {
          try {
            verdict = await probe(ids);
          } catch {
            verdict = undefined;
          }
        }
        states().set(key, {
          status: "unavailable",
          until: Date.now() + getPluginNegativeTtlMs(),
          ...(verdict ? { verdict } : {}),
        });
        logger.info("Plugin API marked unavailable", {
          api: apiLabel,
          plugin: verdict?.state ?? "unknown",
        });
      }
      throw new ServiceNowError(
        `${err.message} (If every ${apiLabel} request fails this way, the ${apiLabel} API/plugin may not be active on this instance.)${describeVerdict(apiLabel, verdict)}`,
        err.status,
        err.detail,
      );
    }
    throw err;
  }
}
