import { activeProfile, listProfiles } from "../core/config.js";
import {
  PROTECTED_TABLES,
  evaluateTable,
  getAllowedTables,
  getDeniedTables,
  getImportSetTables,
  globToRegExp,
  isReadOnly,
  protectedEntry,
  protectedTablesWrite,
  type TableAction,
} from "../core/policy.js";
import {
  getDeniedPackages,
  getDestructiveConfirm,
  getReadOnlyPackages,
  getWriteMode,
} from "../core/settings.js";

/**
 * H-11 (L3-04): what the policy allows, answered locally from the same
 * evaluator the guards call (core/policy.ts evaluateTable) — no request to
 * the instance. Backs servicenow_explain_policy and servicenow://policy.
 */

/** Split a list into exact names and glob patterns. */
function split(entries: string[]): { exact: string[]; patterns: string[] } {
  return {
    exact: entries.filter((e) => !globToRegExp(e)),
    patterns: entries.filter((e) => !!globToRegExp(e)),
  };
}

/** The effective policy of one profile. */
export function policyPayload(profile: string = activeProfile()) {
  return {
    profile,
    tables: {
      allow: split(getAllowedTables(profile)),
      deny: split(getDeniedTables(profile)),
      order: [
        "deny-exact",
        "allow-exact",
        "deny-pattern",
        "protected-default",
        "allow-pattern / not-in-allowlist",
        "no-policy",
      ],
    },
    protectedTables: {
      write: protectedTablesWrite(profile),
      list: [...PROTECTED_TABLES],
      override: "List the table exactly in SN_TABLES_ALLOW.",
    },
    importSetTables: getImportSetTables(profile),
    readOnly: isReadOnly(profile),
    packages: {
      denied: getDeniedPackages(),
      readOnly: getReadOnlyPackages(),
    },
    writeMode: getWriteMode(),
    destructiveConfirm: getDestructiveConfirm(),
  };
}

/** The payload of servicenow://policy: every profile's effective policy. */
export function policyResourcePayload() {
  const active = activeProfile();
  const profiles = listProfiles();
  return {
    activeProfile: active,
    profiles: Object.fromEntries(
      (profiles.length ? profiles : [active]).map((p) => [p, policyPayload(p)]),
    ),
  };
}

/**
 * The verdict for one table and action: the table rule, then — for a write —
 * the read-only axis. `allowed` is the combined answer.
 */
export function explainTable(
  table: string,
  action: TableAction,
  profile: string = activeProfile(),
) {
  const verdict = evaluateTable(table, action, profile);
  const readOnly = action === "write" && isReadOnly(profile);
  const entry = protectedEntry(table);
  return {
    table,
    action,
    profile,
    allowed: verdict.allowed && !readOnly,
    rule: readOnly && verdict.allowed ? "read-only" : verdict.rule,
    ...(verdict.matched ? { matched: verdict.matched } : {}),
    reason:
      readOnly && verdict.allowed
        ? "Writes are refused: the profile is read-only (SN_READONLY)."
        : verdict.reason,
    protected: entry !== undefined,
    ...(action === "write"
      ? {
          writeMode: getWriteMode(),
          destructiveConfirm: getDestructiveConfirm(),
        }
      : {}),
  };
}
