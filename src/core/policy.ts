import { ServiceNowError } from "./errors.js";
import { activeProfile } from "./config.js";
import { getDeniedPackages, getReadOnlyPackages } from "./settings.js";

/**
 * Discoverability hint appended to every policy-denial message so a model or
 * human knows where the active policy is surfaced (UX review §6 / §11).
 */
const POLICY_HINT = " Run servicenow_get_status to see the active policy.";

/**
 * Access policy for ServiceNow tables and operations, configured via env:
 *
 * - `SN_TABLES_ALLOW`  comma-separated allowlist; when set, only these tables
 *                      are reachable.
 * - `SN_TABLES_DENY`   comma-separated denylist; always wins over the allowlist.
 * - `SN_READONLY`      when truthy, every write (create/update/delete) is refused.
 *
 * Per-profile overrides (MI-2): `SN_PROFILE_<NAME>_READONLY` / `_TABLES_ALLOW`
 * / `_TABLES_DENY` apply when that profile is active and fall back to the
 * global keys — the real-world setup "prod is read-only, dev has full rights"
 * in one server.
 *
 * Enforced in the client layer so all tool and resource paths share one guard.
 */

/** Read a policy env var: the profile's override first, then the global key. */
function policyValue(
  suffix: string,
  profile: string = activeProfile(),
): string | undefined {
  if (profile !== "default") {
    const scoped = process.env[`SN_PROFILE_${profile.toUpperCase()}_${suffix}`];
    if (scoped !== undefined) return scoped;
  }
  return process.env[`SN_${suffix}`];
}

function list(suffix: string, profile?: string): string[] {
  return (policyValue(suffix, profile) ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function getAllowedTables(profile?: string): string[] {
  return list("TABLES_ALLOW", profile);
}

export function getDeniedTables(profile?: string): string[] {
  return list("TABLES_DENY", profile);
}

export function isReadOnly(profile?: string): boolean {
  const raw = (policyValue("READONLY", profile) ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

// --- H-11: table policy v2 -------------------------------------------------

/**
 * Tables whose writes can grant access, change security or run code on the
 * instance (GAP L3-01). Writes to them are refused while
 * SN_PROTECTED_TABLES_WRITE=deny (the planned 3.0 default, O-4 / B11) unless
 * SN_TABLES_ALLOW lists the table *exactly* — explicit listing is informed
 * consent. Reads are never affected. `*` / `?` are globs.
 */
export const PROTECTED_TABLES: readonly string[] = [
  "sys_user",
  "sys_user_has_role",
  "sys_user_role",
  "sys_user_grmember",
  "sys_security_acl",
  "sys_security_acl_role",
  "sys_properties",
  "oauth_entity",
  "sys_auth_profile_basic",
  "sys_script",
  "sys_ws_operation",
  "sys_public",
  "sys_ldap*",
  "sys_certificate",
  "sys_data_source",
  "sys_rest_message*",
];

export type TableAction = "read" | "write";

/** Which rule decided a verdict (evaluation order, first match wins). */
export type PolicyRule =
  | "deny-exact"
  | "allow-exact"
  | "deny-pattern"
  | "protected-default"
  | "import-set-allowlist"
  | "allow-pattern"
  | "not-in-allowlist"
  | "no-policy";

export interface PolicyVerdict {
  allowed: boolean;
  rule: PolicyRule;
  /** The list entry that matched (absent for no-policy / not-in-allowlist). */
  matched?: string;
  /** One sentence, the text a denial error carries. */
  reason: string;
}

const compiled = new Map<string, RegExp | null>();

/**
 * A glob entry (`*` any run, `?` one character) as an anchored regex, or null
 * for a plain name (compared exactly). Compiled once per distinct entry.
 */
export function globToRegExp(pattern: string): RegExp | null {
  if (compiled.has(pattern)) return compiled.get(pattern)!;
  const re = /[*?]/.test(pattern)
    ? new RegExp(
        `^${pattern
          .split("")
          .map((c) =>
            c === "*"
              ? ".*"
              : c === "?"
                ? "."
                : c.replace(/[.+^${}()|[\]\\/-]/g, "\\$&"),
          )
          .join("")}$`,
      )
    : null;
  compiled.set(pattern, re);
  return re;
}

function matchesEntry(table: string, entry: string): boolean {
  const re = globToRegExp(entry);
  return re ? re.test(table) : entry === table;
}

function firstMatch(
  table: string,
  entries: readonly string[],
  kind: "exact" | "pattern",
): string | undefined {
  return entries.find((e) =>
    kind === "exact"
      ? !globToRegExp(e) && e === table
      : !!globToRegExp(e) && matchesEntry(table, e),
  );
}

/** H-11: `SN_PROTECTED_TABLES_WRITE` — `allow` (default until 3.0) or `deny`. */
export function protectedTablesWrite(profile?: string): "allow" | "deny" {
  return (policyValue("PROTECTED_TABLES_WRITE", profile) ?? "")
    .trim()
    .toLowerCase() === "deny"
    ? "deny"
    : "allow";
}

/** H-11: the protected-list entry a table falls under, if any. */
export function protectedEntry(table: string): string | undefined {
  const t = table.trim().toLowerCase();
  return PROTECTED_TABLES.find((e) => matchesEntry(t, e));
}

/** H-11: `SN_IMPORT_SET_TABLES` — staging-table patterns; empty = unrestricted. */
export function getImportSetTables(profile?: string): string[] {
  return list("IMPORT_SET_TABLES", profile);
}

/**
 * H-11 (L3-01 / L3-04): the one table-policy evaluator — assertTableAllowed,
 * assertTableWriteAllowed, servicenow_explain_policy and the policy resource
 * all call it, so what the model is told is what is enforced. Order (first
 * match wins): an exact deny, an exact allow (which also overrides the
 * protected list), a pattern deny, the protected list for writes (when
 * SN_PROTECTED_TABLES_WRITE=deny), then the allowlist's patterns — a table
 * outside a non-empty allowlist is refused. With only exact entries this is
 * the pre-H-11 behaviour (deny wins, allowlist restricts).
 */
export function evaluateTable(
  table: string,
  action: TableAction = "read",
  profile: string = activeProfile(),
): PolicyVerdict {
  const t = table.trim().toLowerCase();
  const deny = getDeniedTables(profile);
  const allow = getAllowedTables(profile);

  const exactDeny = firstMatch(t, deny, "exact");
  if (exactDeny) {
    return {
      allowed: false,
      rule: "deny-exact",
      matched: exactDeny,
      reason: `Access to table "${table}" is denied by SN_TABLES_DENY.`,
    };
  }
  const exactAllow = firstMatch(t, allow, "exact");
  if (exactAllow) {
    return {
      allowed: true,
      rule: "allow-exact",
      matched: exactAllow,
      reason: `Table "${table}" is listed in SN_TABLES_ALLOW.`,
    };
  }
  const patternDeny = firstMatch(t, deny, "pattern");
  if (patternDeny) {
    return {
      allowed: false,
      rule: "deny-pattern",
      matched: patternDeny,
      reason: `Access to table "${table}" is denied by SN_TABLES_DENY (pattern "${patternDeny}").`,
    };
  }
  if (action === "write" && protectedTablesWrite(profile) === "deny") {
    const entry = protectedEntry(t);
    if (entry) {
      return {
        allowed: false,
        rule: "protected-default",
        matched: entry,
        reason: `Writes to table "${table}" are refused: it is a protected table (security, identity or code), and SN_PROTECTED_TABLES_WRITE=deny. List it exactly in SN_TABLES_ALLOW to allow them.`,
      };
    }
  }
  if (allow.length > 0) {
    const patternAllow = firstMatch(t, allow, "pattern");
    if (patternAllow) {
      return {
        allowed: true,
        rule: "allow-pattern",
        matched: patternAllow,
        reason: `Table "${table}" matches SN_TABLES_ALLOW pattern "${patternAllow}".`,
      };
    }
    return {
      allowed: false,
      rule: "not-in-allowlist",
      reason: `Access to table "${table}" is not permitted by SN_TABLES_ALLOW.`,
    };
  }
  return {
    allowed: true,
    rule: "no-policy",
    reason: `No table policy restricts "${table}".`,
  };
}

function policyDenied(reason: string): ServiceNowError {
  return new ServiceNowError(`${reason}${POLICY_HINT}`, 403, undefined, {
    code: "POLICY_DENIED",
    hint: "servicenow_explain_policy shows which rule applies and how to change it.",
  });
}

/**
 * H-4: the table axis as a predicate — for filtering rows that name their
 * table (attachment lists, code-search hits) instead of refusing the call.
 */
export function isTableAllowed(table: string): boolean {
  return evaluateTable(table, "read").allowed;
}

/** Throw a 403-style ServiceNowError (POLICY_DENIED) when the table may not be read. */
export function assertTableAllowed(table: string): void {
  const verdict = evaluateTable(table, "read");
  if (!verdict.allowed) throw policyDenied(verdict.reason);
}

/**
 * H-11: the write check for a table — the read rules plus the protected list.
 * Callers still call assertWriteAllowed for the read-only axis.
 */
export function assertTableWriteAllowed(table: string): void {
  const verdict = evaluateTable(table, "write");
  if (!verdict.allowed) throw policyDenied(verdict.reason);
}

/**
 * H-11: an import-set staging table must match SN_IMPORT_SET_TABLES when it
 * is set, so a data load cannot target a real table through the staging path.
 */
export function assertImportSetTable(table: string): void {
  const patterns = getImportSetTables();
  if (patterns.length === 0) return;
  const t = table.trim().toLowerCase();
  if (!patterns.some((p) => matchesEntry(t, p))) {
    throw policyDenied(
      `Table "${table}" is not an import-set staging table allowed by SN_IMPORT_SET_TABLES (${patterns.join(", ")}).`,
    );
  }
}

/** Throw a 403-style ServiceNowError when the server is in read-only mode. */
export function assertWriteAllowed(operation: string): void {
  if (isReadOnly()) {
    throw new ServiceNowError(
      `Server is in read-only mode (SN_READONLY); "${operation}" is not permitted.${POLICY_HINT}`,
      403,
    );
  }
}

/**
 * Throw when a tool package is denied via SN_PACKAGES_DENY. Mirrors the
 * registry's package gate so a path that reaches a package's REST surface
 * outside the normal tool registration (the Batch API) cannot bypass the deny.
 */
export function assertPackageAllowed(pkg: string): void {
  if (getDeniedPackages().includes(pkg)) {
    throw new ServiceNowError(
      `Access to package "${pkg}" is denied by SN_PACKAGES_DENY.${POLICY_HINT}`,
      403,
    );
  }
}

/**
 * Throw when a write targets a package made read-only via SN_PACKAGES_READONLY.
 * The package axis only removes write tools at registration time; this enforces
 * the same rule on the Batch API, whose sub-requests skip that registration.
 */
export function assertPackageWriteAllowed(
  pkg: string,
  operation: string,
): void {
  if (getReadOnlyPackages().includes(pkg)) {
    throw new ServiceNowError(
      `Package "${pkg}" is read-only (SN_PACKAGES_READONLY); "${operation}" is not permitted.${POLICY_HINT}`,
      403,
    );
  }
}
