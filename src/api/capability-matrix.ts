import { snRequest } from "../core/http.js";
import { ServiceNowError } from "../core/errors.js";
import { activeProfile, getCredentials } from "../core/config.js";
import {
  assertPackageAllowed,
  assertTableAllowed,
  isReadOnly,
} from "../core/policy.js";
import {
  getCapabilityTtlMs,
  getPluginNegativeTtlMs,
  getReadOnlyPackages,
  getUpdateSetSetting,
  getWriteMode,
} from "../core/settings.js";
import { currentRuntime, defineRuntimePart } from "../core/runtime.js";
import { pluginAvailability } from "./plugin.js";

/**
 * S-13 — capability preflight v2 (GAP L3-06, L6-06).
 *
 * The DF-0 table preflight answers "can the user read the sys_* code tables".
 * This matrix answers the other questions a model has before it plans work:
 * will writes run, is an update set selected, are attachments / aggregates /
 * import sets / email / ATF reachable, which release is the instance on and
 * which roles does the caller hold. One cheap probe per group:
 *
 * - every probe is a single GET (`sysparm_limit=1` or a property/role read) —
 *   the `writes` group never touches the instance, it is derived from the
 *   write policy (SN_READONLY, SN_WRITE_MODE, SN_PACKAGES_READONLY);
 * - every probe is policy-routed: a table denied by SN_TABLES_ALLOW/DENY or a
 *   package denied by SN_PACKAGES_DENY is not probed and reads `unknown`;
 * - results are cached per instance + user in a runtime part: a positive one
 *   for SN_CAPABILITY_TTL_MS (10 min), a negative one (any HTTP error, 503
 *   included) for SN_PLUGIN_NEGATIVE_TTL_MS (60 s); transport errors (no HTTP
 *   status) and policy denials are never cached.
 */

/** The probe groups, in report order. */
export const MATRIX_GROUPS = [
  "writes",
  "update_sets",
  "attachments",
  "aggregate",
  "import_sets",
  "email",
  "atf",
  "version",
  "roles",
] as const;

export type MatrixGroup = (typeof MATRIX_GROUPS)[number];

/**
 * `available` — the probe succeeded; `unavailable` — the instance refused it
 * (401/403/404); `plan-only` / `read-only` — writes are gated by the server's
 * own policy; `unknown` — not probed (policy denial) or not decidable (5xx,
 * transport error, rows hidden by an ACL).
 */
export type MatrixStatus =
  | "available"
  | "unavailable"
  | "plan-only"
  | "read-only"
  | "unknown";

export interface MatrixEntry {
  status: MatrixStatus;
  /** One sentence on why, when the status is not a plain `available`. */
  reason?: string;
  /** HTTP status of the probe, when one was answered. */
  httpStatus?: number;
  /** Group-specific facts (current update set, build tag, role names…). */
  detail?: Record<string, unknown>;
  /** True when served from the capability cache instead of a fresh probe. */
  cached?: boolean;
}

/** One group's probe: policy gates, the GET to send and how to read it. */
interface GroupProbe {
  /** Tool package the group maps to; a SN_PACKAGES_DENY hit skips the probe. */
  package?: string;
  /** Table the probe reads; SN_TABLES_ALLOW/DENY apply to it. */
  table: string;
  path: string;
  params: Record<string, string>;
  /** Turn a 2xx body into an entry; default = `available`. */
  interpret?: (result: unknown[] | undefined, raw: unknown) => MatrixEntry;
}

const rowsOf = (data: unknown): unknown[] | undefined => {
  const r = (data as { result?: unknown } | undefined)?.result;
  return Array.isArray(r) ? r : undefined;
};

const str = (v: unknown): string | undefined => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "value" in v) {
    const inner = (v as { value?: unknown }).value;
    return typeof inner === "string" ? inner : undefined;
  }
  return undefined;
};

/** Roles worth calling out: they change what the tools can do. */
const NOTABLE_ROLES = [
  "admin",
  "security_admin",
  "rest_api_explorer",
  "itil",
  "import_admin",
  "atf_test_admin",
  "web_service_admin",
  // N-23: the rest of the elevated roles the privilege advice checks.
  "maint",
  "user_admin",
  "oauth_admin",
  "catalog_admin",
  "knowledge_admin",
];

/** Most role names reported (a user can hold hundreds through containment). */
const MAX_ROLE_NAMES = 50;

/** `glide-xanadu-07-02-2024__patch3-…` → `xanadu`. */
export function releaseFamily(buildtag: string): string | undefined {
  return /^glide-([a-z]+)-/i.exec(buildtag.trim())?.[1]?.toLowerCase();
}

/** Table-API read of one row's sys_id — the cheapest ACL-exercising read. */
function tableRead(
  table: string,
  pkg: string | undefined,
  extra: Record<string, string> = {},
): GroupProbe {
  return {
    ...(pkg ? { package: pkg } : {}),
    table,
    path: `/api/now/table/${table}`,
    params: { sysparm_limit: "1", sysparm_fields: "sys_id", ...extra },
  };
}

/**
 * The network probe for every group but `writes`. `user` is the configured
 * user name; groups that need it return undefined without one.
 */
function probeFor(group: MatrixGroup, user: string): GroupProbe | undefined {
  switch (group) {
    case "writes":
      return undefined;
    case "update_sets":
      if (!user) return undefined;
      // The picker stores the current update set as a user preference.
      return {
        table: "sys_user_preference",
        path: "/api/now/table/sys_user_preference",
        params: {
          sysparm_query: `name=sys_update_set^user.user_name=${user}`,
          sysparm_fields: "value",
          sysparm_limit: "1",
        },
        interpret: (rows) => {
          const current = str((rows?.[0] as { value?: unknown })?.value);
          return current
            ? { status: "available", detail: { current } }
            : {
                status: "available",
                reason:
                  "No update set selected for this user — configuration changes land in the Default update set of the application scope.",
                detail: { current: null },
              };
        },
      };
    case "attachments":
      return {
        package: "attachment",
        table: "sys_attachment",
        path: "/api/now/attachment",
        params: { sysparm_limit: "1" },
      };
    case "aggregate":
      return {
        package: "aggregate",
        table: "sys_user",
        path: "/api/now/stats/sys_user",
        params: { sysparm_count: "true" },
      };
    case "import_sets":
      return tableRead("sys_import_set", "importset");
    case "email":
      return tableRead("sys_email", "email");
    case "atf": {
      const probe = tableRead("sys_atf_test", "atf");
      return {
        ...probe,
        interpret: () => {
          // Running tests needs the CI/CD API; report it when it was seen.
          const cicd = pluginAvailability()["CI/CD"];
          return {
            status: "available",
            ...(cicd ? { detail: { cicdApi: cicd } } : {}),
          };
        },
      };
    }
    case "version":
      return {
        table: "sys_properties",
        path: "/api/now/table/sys_properties",
        params: {
          sysparm_query: "name=glide.buildtag",
          sysparm_fields: "value",
          sysparm_limit: "1",
        },
        interpret: (rows) => {
          const buildtag = str((rows?.[0] as { value?: unknown })?.value);
          if (!buildtag) {
            return {
              status: "unknown",
              reason:
                "glide.buildtag is not visible to this user (sys_properties rows are ACL-filtered).",
            };
          }
          const family = releaseFamily(buildtag);
          return {
            status: "available",
            detail: { buildtag, ...(family ? { family } : {}) },
          };
        },
      };
    case "roles":
      if (!user) return undefined;
      return {
        table: "sys_user_has_role",
        path: "/api/now/table/sys_user_has_role",
        params: {
          sysparm_query: `user.user_name=${user}^state=active`,
          sysparm_fields: "role.name",
          sysparm_limit: "500",
        },
        interpret: (rows) => {
          const names = [
            ...new Set(
              (rows ?? [])
                .map((r) => str((r as Record<string, unknown>)["role.name"]))
                .filter((n): n is string => !!n),
            ),
          ].sort();
          if (names.length === 0) {
            return {
              status: "unknown",
              reason:
                "No role rows are visible — sys_user_has_role is usually readable only by admins, so the roles could not be read.",
            };
          }
          return {
            status: "available",
            detail: {
              admin: names.includes("admin"),
              notable: NOTABLE_ROLES.filter((r) => names.includes(r)),
              roles: names.slice(0, MAX_ROLE_NAMES),
              ...(names.length > MAX_ROLE_NAMES
                ? { truncated: names.length }
                : {}),
            },
          };
        },
      };
  }
}

/** The writes group: pure policy, never a request (and never a write). */
function writesEntry(): MatrixEntry {
  const readOnlyPackages = getReadOnlyPackages();
  const detail = {
    writeMode: getWriteMode(),
    ...(readOnlyPackages.length ? { readOnlyPackages } : {}),
  };
  if (isReadOnly()) {
    return {
      status: "read-only",
      reason: "SN_READONLY is set: every create/update/delete is refused.",
      detail,
    };
  }
  if (getWriteMode() === "plan") {
    return {
      status: "plan-only",
      reason:
        "SN_WRITE_MODE=plan: write tools return a preview unless called with apply:true. Instance ACLs still decide per table.",
      detail,
    };
  }
  return {
    status: "available",
    reason: "SN_WRITE_MODE=apply. Instance ACLs still decide per table.",
    detail,
  };
}

interface CacheSlot {
  entry: MatrixEntry;
  until: number;
}

// Per-session state lives in the runtime container (E-3), like the plugin
// availability map; dispose() forgets it.
const cachePart = defineRuntimePart(
  "capabilityMatrix",
  () => new Map<string, CacheSlot>(),
  (map) => map.clear(),
);

const cache = (): Map<string, CacheSlot> => currentRuntime().get(cachePart);

/** Forget every cached probe result (refresh, credential/profile changes). */
export function clearCapabilityCache(): void {
  cache().clear();
}

const HTTP_REASON: Record<number, string> = {
  401: "authentication failed",
  403: "no access (the user lacks a role or an ACL denies the read)",
  404: "not present on this instance (table missing or plugin inactive)",
};

/** Run one group's probe; never throws. `cacheable` false = do not cache. */
async function runProbe(
  probe: GroupProbe,
): Promise<{ entry: MatrixEntry; cacheable: boolean }> {
  try {
    const res = await snRequest<unknown>({
      method: "GET",
      path: probe.path,
      params: new URLSearchParams(probe.params),
      // Preflight/doctor diagnostic: answer even while the queue is stalled.
      bypassQueue: true,
    });
    const entry = probe.interpret
      ? probe.interpret(rowsOf(res.data), res.data)
      : { status: "available" as const };
    return { entry: { ...entry, httpStatus: res.status }, cacheable: true };
  } catch (error) {
    if (error instanceof ServiceNowError && error.status !== undefined) {
      const status = error.status;
      return {
        entry: {
          status: status in HTTP_REASON ? "unavailable" : "unknown",
          reason: HTTP_REASON[status] ?? `HTTP ${status}: ${error.message}`,
          httpStatus: status,
        },
        cacheable: true,
      };
    }
    // Transport failure, deadline, open breaker…: says nothing about the
    // capability itself, so it is reported but never cached.
    return {
      entry: {
        status: "unknown",
        reason: `probe failed without an HTTP answer: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      cacheable: false,
    };
  }
}

/** Resolve one group: policy first, then the cache, then the probe. */
async function resolveGroup(
  group: MatrixGroup,
  keyPrefix: string,
  user: string,
): Promise<MatrixEntry> {
  if (group === "writes") return writesEntry();
  const probe = probeFor(group, user);
  if (!probe) {
    return {
      status: "unknown",
      reason:
        "No user name is configured for this auth method, so the per-user probe cannot run.",
    };
  }
  // Policy routing: the probe obeys the same gates as the tools it stands for.
  try {
    if (probe.package) assertPackageAllowed(probe.package);
    assertTableAllowed(probe.table);
  } catch (error) {
    return {
      status: "unknown",
      reason: `not probed — ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const key = `${keyPrefix}|${group}`;
  const hit = cache().get(key);
  if (hit && hit.until > Date.now()) return { ...hit.entry, cached: true };

  const { entry, cacheable } = await runProbe(probe);
  if (cacheable) {
    const ttl =
      entry.status === "available"
        ? getCapabilityTtlMs()
        : getPluginNegativeTtlMs();
    cache().set(key, { entry, until: Date.now() + ttl });
  } else {
    cache().delete(key);
  }
  return entry;
}

/**
 * S-6: the `update_sets` group also says whether the user can read update
 * sets (one more cached GET on sys_update_set) and whether a write can be
 * bound to one — inferred, never tested by writing: the sets are readable,
 * the preference table is readable and policy-allowed, and writes are on.
 */
async function withUpdateSetAccess(
  entry: MatrixEntry,
  keyPrefix: string,
): Promise<MatrixEntry> {
  let canRead: boolean | null;
  try {
    // An undecided preference probe (no user, policy denial) adds no request.
    if (entry.status === "unknown") throw new Error("not probed");
    assertTableAllowed("sys_update_set");
    const key = `${keyPrefix}|update_sets.read`;
    const hit = cache().get(key);
    let read = hit && hit.until > Date.now() ? hit.entry : undefined;
    if (!read) {
      const probe = tableRead("sys_update_set", undefined);
      const { entry: fresh, cacheable } = await runProbe({
        ...probe,
        interpret: (rows) =>
          rows?.length ? { status: "available" } : { status: "unavailable" },
      });
      read = fresh;
      if (cacheable) {
        cache().set(key, {
          entry: fresh,
          until:
            Date.now() +
            (fresh.status === "available"
              ? getCapabilityTtlMs()
              : getPluginNegativeTtlMs()),
        });
      }
    }
    canRead =
      read.status === "available"
        ? true
        : read.status === "unavailable"
          ? false
          : null;
  } catch {
    canRead = null;
  }
  let prefAllowed = true;
  try {
    assertTableAllowed("sys_user_preference");
  } catch {
    prefAllowed = false;
  }
  const canSet =
    canRead === true &&
    entry.status === "available" &&
    prefAllowed &&
    !isReadOnly();
  return {
    ...entry,
    detail: {
      ...entry.detail,
      canRead,
      canSet,
      configured: getUpdateSetSetting(activeProfile()) ?? null,
    },
  };
}

/**
 * Probe the requested groups (default: all) for the active profile. Never
 * throws: every failure is an `unknown` entry with a reason.
 */
export async function probeCapabilityMatrix(
  groups: readonly MatrixGroup[] = MATRIX_GROUPS,
): Promise<Partial<Record<MatrixGroup, MatrixEntry>>> {
  const { instance, user } = getCredentials();
  // A '^' in the user name would inject into the encoded query.
  const safeUser = user && !user.includes("^") ? user : "";
  const keyPrefix = `${instance}|${user}`;
  const wanted = MATRIX_GROUPS.filter((g) => groups.includes(g));
  const entries = await Promise.all(
    wanted.map((g) => resolveGroup(g, keyPrefix, safeUser)),
  );
  const out: Partial<Record<MatrixGroup, MatrixEntry>> = {};
  wanted.forEach((g, i) => {
    out[g] = entries[i];
  });
  if (out.update_sets) {
    out.update_sets = await withUpdateSetAccess(out.update_sets, keyPrefix);
  }
  return out;
}
