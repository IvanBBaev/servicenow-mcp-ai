import { snRequest } from "../core/http.js";
import { getCredentials } from "../core/config.js";
import { ServiceNowError } from "../core/errors.js";
import { snParams, snString } from "./shared.js";

/** Result of a connectivity probe — failures are data, not exceptions. */
export interface ConnectionProbe {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  user?: string;
  message?: string;
  /** M-1: the error code (e.g. NOT_CONFIGURED) when the error carries one. */
  code?: string;
  /** M-1: the error's one-line fix, when it carries one. */
  hint?: string;
}

/**
 * Verify that the configured credentials actually work by reading a single
 * sys_user record. Uses snRequest directly on purpose: this is a diagnostic
 * on the admin surface, so a table allow/deny list must not mask it.
 */
export async function testConnection(): Promise<ConnectionProbe> {
  const started = Date.now();
  try {
    const params = new URLSearchParams({
      sysparm_limit: "1",
      sysparm_fields: "sys_id",
    });
    const { status } = await snRequest<unknown>({
      method: "GET",
      path: "/api/now/table/sys_user",
      params,
      // A diagnostic must answer while the per-host queue is stalled — that
      // is exactly when someone runs it.
      bypassQueue: true,
    });
    return {
      ok: true,
      status,
      latencyMs: Date.now() - started,
      user: getCredentials().user,
    };
  } catch (error) {
    if (error instanceof ServiceNowError) {
      // Structured, so the model can read and react (401 → fix credentials,
      // 403 → roles, timeout → connectivity).
      return {
        ok: false,
        status: error.status ?? null,
        latencyMs: Date.now() - started,
        message: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.hint ? { hint: error.hint } : {}),
      };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// N-75 — the instance's basic-auth restriction
// ---------------------------------------------------------------------------

/**
 * The `glide.authenticate.basic_auth.*` property family, verified on a PDI
 * (2026-10-27, GETs only): `restriction.active` switches the feature on,
 * `restriction.enforce` turns tracking into refusal, `restriction.enforcement_date`
 * is the UTC date enforcement starts, `allowed_roles` lists the roles that keep
 * basic auth working and `allowed_users` is a sys_id allow list.
 */
const BASIC_AUTH_PROPERTY_PREFIX = "glide.authenticate.basic_auth.";

/** The default of `glide.authenticate.basic_auth.allowed_roles`. */
export const BASIC_AUTH_API_ROLE = "snc_basic_auth_api_access";

/** Rows per property / role read — the family has eight members. */
const PREFLIGHT_LIMIT = 50;

export type BasicAuthRestriction = "enforced" | "tracking" | "off" | "unknown";

/** What the instance's basic-auth restriction means for the connected user. */
export interface BasicAuthPreflight {
  /**
   * enforced: a user without an allowed role (or allow-list entry) is refused
   * with 401; tracking: active but not enforced yet — a future lockout; off:
   * the restriction is inactive; unknown: the properties were not readable
   * (older instance, ACL), so there is nothing to report.
   */
  restriction: BasicAuthRestriction;
  /** `restriction.enforcement_date`, when the instance has one. */
  enforcementDate?: string;
  /** `allowed_roles` (the default role when unset). */
  allowedRoles?: string[];
  /**
   * Whether the connected user keeps basic auth once the restriction is
   * enforced; absent when the user's roles were not readable.
   */
  userAllowed?: boolean;
  /** What allows the user: an allowed role or the allow list. */
  allowedBy?: "role" | "allow_list";
}

type Rows = { result?: unknown };

function rowsOf(data: Rows): unknown[] {
  return Array.isArray(data.result) ? data.result : [];
}

function field(row: unknown, name: string): string {
  return row !== null && typeof row === "object"
    ? snString((row as Record<string, unknown>)[name])
    : "";
}

/** A comma-separated property value as a list; `^` cannot enter a query. */
function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "" && !item.includes("^"));
}

/** The family's properties by name, or undefined when none is readable. */
async function readBasicAuthProperties(): Promise<
  Map<string, string> | undefined
> {
  try {
    const { data } = await snRequest<Rows>({
      method: "GET",
      path: "/api/now/table/sys_properties",
      params: snParams({
        sysparm_query: `nameSTARTSWITH${BASIC_AUTH_PROPERTY_PREFIX}`,
        sysparm_fields: "name,value",
        sysparm_limit: PREFLIGHT_LIMIT,
      }),
    });
    const properties = new Map<string, string>();
    for (const row of rowsOf(data)) {
      const name = field(row, "name");
      if (name.startsWith(BASIC_AUTH_PROPERTY_PREFIX)) {
        properties.set(name, field(row, "value").trim());
      }
    }
    return properties.size > 0 ? properties : undefined;
  } catch {
    // swallowed: unreadable properties (older instance, ACL) mean unknown
    return undefined;
  }
}

/** Whether `user` holds one of `roles` (active grants) or is in `allowedUsers`. */
async function userAllowed(
  user: string,
  roles: readonly string[],
  allowedUsers: readonly string[],
): Promise<Pick<BasicAuthPreflight, "userAllowed" | "allowedBy"> | undefined> {
  // The name is embedded in an encoded query, where `^` separates conditions
  // and cannot be escaped.
  if (user === "" || user.includes("^")) return undefined;
  try {
    const held = await snRequest<Rows>({
      method: "GET",
      path: "/api/now/table/sys_user_has_role",
      params: snParams({
        sysparm_query: `user.user_name=${user}^role.nameIN${roles.join(",")}`,
        sysparm_fields: "role.name,state",
        sysparm_limit: PREFLIGHT_LIMIT,
      }),
    });
    const active = rowsOf(held.data).some((row) => {
      const state = field(row, "state");
      return state === "" || state === "active";
    });
    if (active) return { userAllowed: true, allowedBy: "role" };
    if (allowedUsers.length > 0) {
      const me = await snRequest<Rows>({
        method: "GET",
        path: "/api/now/table/sys_user",
        params: snParams({
          sysparm_query: `user_name=${user}`,
          sysparm_fields: "sys_id",
          sysparm_limit: 1,
        }),
      });
      const sysId = field(rowsOf(me.data)[0], "sys_id");
      if (sysId !== "" && allowedUsers.includes(sysId)) {
        return { userAllowed: true, allowedBy: "allow_list" };
      }
    }
    return { userAllowed: false };
  } catch {
    // swallowed: unreadable roles mean the user's standing is unknown
    return undefined;
  }
}

/**
 * Read the instance's basic-auth restriction and whether `user` keeps basic
 * auth once it is enforced. Runs after a green connection probe, so every
 * failure is "unknown" rather than an error: the check is informational and
 * must never change the doctor verdict. Uses snRequest directly like
 * testConnection(): a table allow/deny list must not mask a diagnostic.
 */
export async function basicAuthPreflight(
  user: string,
): Promise<BasicAuthPreflight> {
  const properties = await readBasicAuthProperties();
  if (properties === undefined) return { restriction: "unknown" };
  const property = (name: string): string =>
    properties.get(BASIC_AUTH_PROPERTY_PREFIX + name) ?? "";
  const active = property("restriction.active") === "true";
  const restriction: BasicAuthRestriction = !active
    ? "off"
    : property("restriction.enforce") === "true"
      ? "enforced"
      : "tracking";
  const allowedRoles = splitList(
    property("allowed_roles") || BASIC_AUTH_API_ROLE,
  );
  const enforcementDate = property("restriction.enforcement_date");
  const allowed = await userAllowed(
    user,
    allowedRoles,
    splitList(property("allowed_users")),
  );
  return {
    restriction,
    ...(enforcementDate !== "" ? { enforcementDate } : {}),
    allowedRoles,
    ...allowed,
  };
}
