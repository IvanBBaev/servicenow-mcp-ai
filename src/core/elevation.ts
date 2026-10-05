/**
 * N-20 EL-2 — elevated-privilege detection for writes.
 *
 * Some tables accept writes only from a session that has elevated an
 * elevated-privilege role (security_admin for the ACL tables). A REST session
 * cannot elevate, so the instance answers 403 even when the account holds the
 * role. This module recognises that case from the request alone and turns the
 * opaque 403 into ELEVATION_REQUIRED with a hint naming the role.
 *
 * The gated tables and their roles are the platform's out-of-box ones,
 * unverified until O-5 (PDI).
 */

/** Tables whose writes need an elevated role, with the role. */
export const ELEVATED_TABLES: Readonly<Record<string, string>> = {
  sys_security_acl: "security_admin",
  sys_security_acl_role: "security_admin",
};

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** `/api/now/table/<t>` or `/api/now/v2/table/<t>`, optionally `/<sys_id>`. */
const TABLE_PATH = /^\/api\/now\/(?:v\d+\/)?table\/([A-Za-z0-9_]+)(?:\/|$)/;

export interface ElevationNeed {
  table: string;
  role: string;
}

/**
 * The elevated role a request needs, or undefined when it needs none: only
 * Table API writes to a gated table qualify.
 */
export function elevationNeeded(
  method: string,
  path: string,
): ElevationNeed | undefined {
  if (!WRITE_METHODS.has(method.toUpperCase())) return undefined;
  const m = TABLE_PATH.exec(path.split("?")[0] ?? "");
  const table = m?.[1];
  if (!table) return undefined;
  const role = ELEVATED_TABLES[table];
  return role ? { table, role } : undefined;
}

/** The ELEVATION_REQUIRED hint for a gated write. */
export function elevationHint({ table, role }: ElevationNeed): string {
  return `Writes to ${table} need the ${role} role elevated for the session. This server cannot elevate a REST session yet (N-20): elevate ${role} in the UI and make the change there, or deliver it in an update set committed by an elevated user.`;
}
