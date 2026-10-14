import { createHash } from "node:crypto";
import { ServiceNowError } from "../core/errors.js";
import { snString } from "./shared.js";
import { getRecord, queryTable, type SnRecord } from "./table.js";
import { BASE_PRIVILEGED_ROLES } from "./access-review.js";

/**
 * N-24 (O-17 option B, ADR 0011): limited role grants, package `access`.
 * One user, one role, granted or revoked directly through sys_user_has_role.
 *
 * Always refused, whatever the policy:
 *   - a privileged role: `admin`, `security_admin`, `maint`, every role
 *     flagged `elevated_privilege`, and every role that contains one of those
 *     (transitively, through sys_user_role_contains). Revoking admin from the
 *     calling account is one of these refusals;
 *   - an inherited role: a row that comes from a group (`granted_by`) or a
 *     containing role (`included_in_role`) is never revoked here.
 *
 * The write itself goes through the table rails: sys_user_has_role is a
 * protected table (B11), so a grant or revoke also needs it listed in
 * SN_TABLES_ALLOW (or SN_PROTECTED_TABLES_WRITE=allow; `confirm` needs apply: true). Field names follow
 * the access review, checked on a PDI (O-5).
 */

export const USER_ROLE_TABLE = "sys_user_has_role";
const ROLE_TABLE = "sys_user_role";
const CONTAINS_TABLE = "sys_user_role_contains";

/** Privileged whatever their elevated_privilege flag says. */
export const ALWAYS_PRIVILEGED = [...BASE_PRIVILEGED_ROLES, "maint"] as const;

/** Roles walked in a containment closure; past this the role is refused. */
export const CLOSURE_MAX = 200;

/** A user's role rows read per plan; past this the plan is not exact. */
const USER_ROLE_MAX = 2_000;

export type RoleChange = "grant" | "revoke";

export interface RoleRef {
  sys_id: string;
  name: string;
}

interface RoleRow {
  sys_id: string;
  role: string;
  name: string;
  inherited: boolean;
  grantedBy: string;
  includedIn: string;
}

/** What a grant or revoke would do, read from the instance. */
export interface RoleChangePlan {
  change: RoleChange;
  user: { sys_id: string; user_name: string };
  role: RoleRef;
  /** The roles the role brings with it (its containment closure). */
  contains: string[];
  /** The sys_user_has_role row a revoke deletes. */
  row?: string;
  effective: {
    before: string[];
    after: string[];
    added: string[];
    removed: string[];
    /** More role rows than were read: before / after may be incomplete. */
    truncated: boolean;
  };
  /** sha256 over the role and the user's role rows, bound into the plan. */
  fingerprint: string;
}

function denied(message: string, hint: string): ServiceNowError {
  return new ServiceNowError(message, 403, undefined, {
    code: "POLICY_DENIED",
    hint,
  });
}

function isPrivileged(name: string, elevated: unknown): boolean {
  return (
    (ALWAYS_PRIVILEGED as readonly string[]).includes(name) ||
    snString(elevated) === "true"
  );
}

/** Resolve a role by exact name. 404 when there is none. */
async function readRole(
  name: string,
): Promise<RoleRef & { elevated: unknown }> {
  const { records } = await queryTable({
    table: ROLE_TABLE,
    query: `name=${name}`,
    fields: ["sys_id", "name", "elevated_privilege"],
    displayValue: "false",
    limit: 1,
  });
  const role = records[0];
  if (!role) {
    throw new ServiceNowError(`Role "${name}" was not found.`, 404, undefined, {
      code: "NOT_FOUND",
    });
  }
  return {
    sys_id: snString(role.sys_id),
    name: snString(role.name),
    elevated: role.elevated_privilege,
  };
}

/**
 * The roles a role contains, transitively. Refuses (fails closed) when a
 * privileged role is among them or the closure is larger than
 * {@link CLOSURE_MAX}; a read error propagates, so nothing is granted on a
 * closure that could not be read.
 */
async function assertNotPrivileged(role: RoleRef & { elevated: unknown }) {
  const refuse = (why: string) =>
    denied(
      `Role "${role.name}" cannot be granted or revoked through servicenow_change_access: ${why}. Nothing was changed.`,
      "Privileged roles (admin, security_admin, maint, elevated_privilege roles and every role that contains one) are changed by an administrator on the instance, never by this tool.",
    );
  if (isPrivileged(role.name, role.elevated)) {
    throw refuse("it is a privileged role");
  }
  const seen = new Map<string, string>([[role.sys_id, role.name]]);
  let frontier = [role.sys_id];
  while (frontier.length) {
    const { records } = await queryTable({
      table: CONTAINS_TABLE,
      query: `roleIN${frontier.join(",")}`,
      fields: ["contains", "contains.name", "contains.elevated_privilege"],
      displayValue: "false",
      fetchAll: true,
    });
    frontier = [];
    for (const r of records) {
      const id = snString(r.contains);
      const name = snString(r["contains.name"]);
      if (!id || seen.has(id)) continue;
      if (isPrivileged(name, r["contains.elevated_privilege"])) {
        throw refuse(`it contains the privileged role "${name}"`);
      }
      seen.set(id, name);
      frontier.push(id);
    }
    if (seen.size > CLOSURE_MAX) {
      throw refuse(`it contains more than ${CLOSURE_MAX} roles`);
    }
  }
  seen.delete(role.sys_id);
  return [...seen.values()].sort();
}

async function readUserRoles(
  user: string,
): Promise<{ rows: RoleRow[]; truncated: boolean }> {
  const { records } = await queryTable({
    table: USER_ROLE_TABLE,
    query: `user=${user}^state=active^ORstateISEMPTY`,
    fields: [
      "sys_id",
      "role",
      "role.name",
      "inherited",
      "granted_by",
      "included_in_role",
    ],
    displayValue: "false",
    limit: USER_ROLE_MAX + 1,
  });
  return {
    rows: records.slice(0, USER_ROLE_MAX).map((r: SnRecord) => ({
      sys_id: snString(r.sys_id),
      role: snString(r.role),
      name: snString(r["role.name"]),
      inherited: snString(r.inherited) === "true",
      grantedBy: snString(r.granted_by),
      includedIn: snString(r.included_in_role),
    })),
    truncated: records.length > USER_ROLE_MAX,
  };
}

/** A row granted to the user itself: not from a group, not from a role. */
function isDirect(row: RoleRow): boolean {
  return !row.inherited && !row.grantedBy && !row.includedIn;
}

const names = (rows: RoleRow[]) =>
  [...new Set(rows.map((r) => r.name).filter(Boolean))].sort();

/**
 * Read everything a grant or revoke needs and refuse what is never allowed.
 * The result is the plan; its fingerprint changes when the role or any of
 * the user's role rows changes.
 */
export async function planRoleChange(
  change: RoleChange,
  userId: string,
  roleName: string,
): Promise<RoleChangePlan> {
  const role = await readRole(roleName);
  const contains = await assertNotPrivileged(role);
  const user = await getRecord("sys_user", userId, ["sys_id", "user_name"]);
  const { rows, truncated } = await readUserRoles(userId);
  const own = rows.filter((r) => r.role === role.sys_id);
  const direct = own.find(isDirect);
  const before = names(rows);
  let after: string[];
  let row: string | undefined;
  if (change === "grant") {
    if (direct) {
      throw new ServiceNowError(
        `The user already holds role "${role.name}" directly. Nothing was changed.`,
        409,
        undefined,
        { code: "CONFLICT" },
      );
    }
    after = [...new Set([...before, role.name, ...contains])].sort();
  } else {
    if (!direct) {
      if (own.length) {
        throw denied(
          `The user holds role "${role.name}" only through a group or a containing role. Inherited roles are never revoked here. Nothing was changed.`,
          "Remove the user from the granting group, or change the containing role, on the instance.",
        );
      }
      throw new ServiceNowError(
        `The user does not hold role "${role.name}". Nothing was changed.`,
        404,
        undefined,
        { code: "NOT_FOUND" },
      );
    }
    row = direct.sys_id;
    // The instance deletes the rows the revoked row brought in, and theirs.
    const gone = new Set([direct.sys_id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const r of rows) {
        if (!gone.has(r.sys_id) && gone.has(r.includedIn)) {
          gone.add(r.sys_id);
          grew = true;
        }
      }
    }
    after = names(rows.filter((r) => !gone.has(r.sys_id)));
  }
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        change,
        userId,
        role.sys_id,
        truncated,
        rows
          .map((r) => `${r.sys_id}:${r.role}:${r.inherited}:${r.includedIn}`)
          .sort(),
      ]),
    )
    .digest("hex");
  return {
    change,
    user: {
      sys_id: snString(user.sys_id) || userId,
      user_name: snString(user.user_name),
    },
    role: { sys_id: role.sys_id, name: role.name },
    contains,
    ...(row ? { row } : {}),
    effective: {
      before,
      after,
      added: after.filter((n) => !before.includes(n)),
      removed: before.filter((n) => !after.includes(n)),
      truncated,
    },
    fingerprint,
  };
}

/** Refuse an apply whose roles changed after the plan. */
export function assertRolePlanCurrent(
  plan: RoleChangePlan,
  planned?: string,
): void {
  if (planned !== undefined && planned !== plan.fingerprint) {
    throw new ServiceNowError(
      `The roles of user "${plan.user.user_name || plan.user.sys_id}" changed after the ${plan.change} was planned. Nothing was changed.`,
      409,
      undefined,
      {
        code: "STALE_RECORD",
        hint: "Plan the change again (without apply) and review the new effective roles.",
      },
    );
  }
}
