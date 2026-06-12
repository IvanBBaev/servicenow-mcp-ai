import { ServiceNowError } from "./errors.js";

/**
 * Access policy for ServiceNow tables and operations, configured via env:
 *
 * - `SN_TABLES_ALLOW`  comma-separated allowlist; when set, only these tables
 *                      are reachable.
 * - `SN_TABLES_DENY`   comma-separated denylist; always wins over the allowlist.
 * - `SN_READONLY`      when truthy, every write (create/update/delete) is refused.
 *
 * Enforced in the client layer so all tool and resource paths share one guard.
 */

function list(envVar: string): string[] {
  return (process.env[envVar] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function getAllowedTables(): string[] {
  return list("SN_TABLES_ALLOW");
}

export function getDeniedTables(): string[] {
  return list("SN_TABLES_DENY");
}

export function isReadOnly(): boolean {
  const raw = (process.env.SN_READONLY ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Throw a 403-style ServiceNowError when the table is not permitted. */
export function assertTableAllowed(table: string): void {
  const t = table.trim().toLowerCase();
  if (getDeniedTables().includes(t)) {
    throw new ServiceNowError(
      `Access to table "${table}" is denied by SN_TABLES_DENY.`,
      403,
    );
  }
  const allowed = getAllowedTables();
  if (allowed.length > 0 && !allowed.includes(t)) {
    throw new ServiceNowError(
      `Access to table "${table}" is not permitted by SN_TABLES_ALLOW.`,
      403,
    );
  }
}

/** Throw a 403-style ServiceNowError when the server is in read-only mode. */
export function assertWriteAllowed(operation: string): void {
  if (isReadOnly()) {
    throw new ServiceNowError(
      `Server is in read-only mode (SN_READONLY); "${operation}" is not permitted.`,
      403,
    );
  }
}
