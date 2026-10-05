import type { CapabilityReport, MatrixGroup } from "./capabilities.js";

/**
 * N-23 (NX-32) — least-privilege advice for the server's own account.
 *
 * `doctor` and `check_capabilities` report what the account cannot do; this
 * module also reports what it holds but does not need. It is pure: it reads a
 * capability report that was already probed and the package set in force, and
 * sends no request of its own.
 *
 * - `missing`: a probed table or matrix group the enabled packages need and
 *   the account cannot read (facts from the probes, never guessed).
 * - `excess`: an elevated role the account holds that no enabled package
 *   needs. Only decidable when the `roles` matrix group could read the
 *   account's roles; otherwise `rolesKnown` is false and `excess` is empty.
 *
 * Role names are the platform's out-of-box ones; which package needs which
 * role is unverified until O-5 (PDI), so the advice is informational and never
 * changes the doctor verdict.
 */

/** Which enabled packages depend on each table-preflight capability. */
const CAPABILITY_PACKAGES: Record<string, readonly string[]> = {
  schema_reads: ["schema"],
  script_intelligence: ["scripts", "flows", "codecheck", "docs"],
  acl_audit: ["codecheck"],
};

/** Which package each capability-matrix group serves. */
const MATRIX_PACKAGES: Partial<Record<MatrixGroup, string>> = {
  update_sets: "updatesets",
  attachments: "attachment",
  aggregate: "aggregate",
  import_sets: "importset",
  email: "email",
  atf: "atf",
};

interface RoleRule {
  /** Packages that justify holding the role; empty = none ever does. */
  justifiedBy: readonly string[];
  /** Why the role is broader than the server needs. */
  why: string;
}

/** Elevated roles worth flagging when nothing enabled needs them. */
export const ELEVATED_ROLES: Record<string, RoleRule> = {
  admin: {
    justifiedBy: [],
    why: "admin bypasses most ACLs; a dedicated read role on the tables the enabled packages read (plus itil for task data) is enough",
  },
  maint: {
    justifiedBy: [],
    why: "maint is the platform's own maintenance role and is never needed by an integration account",
  },
  security_admin: {
    justifiedBy: ["codecheck", "scripts"],
    why: "security_admin is only needed to read ACL script bodies (codecheck, scripts)",
  },
  user_admin: {
    justifiedBy: [],
    why: "user_admin manages users and groups; the directory lookups only read them",
  },
  oauth_admin: {
    justifiedBy: [],
    why: "oauth_admin manages OAuth entities; no tool reads or writes them",
  },
  web_service_admin: {
    justifiedBy: [],
    why: "web_service_admin manages REST and SOAP definitions; no tool writes them",
  },
  import_admin: {
    justifiedBy: ["importset"],
    why: "import_admin is only needed by the importset package",
  },
  atf_test_admin: {
    justifiedBy: ["atf"],
    why: "atf_test_admin is only needed by the atf package",
  },
  catalog_admin: {
    justifiedBy: ["catalog"],
    why: "catalog_admin is only needed by the catalog package",
  },
  knowledge_admin: {
    justifiedBy: ["knowledge"],
    why: "knowledge_admin is only needed by the knowledge package",
  },
};

export interface PrivilegeGap {
  /** The capability or matrix group the account cannot use. */
  need: string;
  /** Enabled packages that depend on it. */
  packages: string[];
  /** Unreadable tables, when the gap comes from the table preflight. */
  tables?: string[];
  reason: string;
}

export interface ExcessRole {
  role: string;
  reason: string;
}

export interface PrivilegeAdvice {
  /**
   * `least` — nothing missing and nothing excess; `advice` — at least one
   * finding; `partial` — nothing missing, but the roles could not be read.
   */
  status: "least" | "advice" | "partial";
  /** The package set the advice was computed for. */
  packages: string[];
  /** False when the account's roles were not readable (excess unknown). */
  rolesKnown: boolean;
  missing: PrivilegeGap[];
  excess: ExcessRole[];
  summary: string;
}

/** Role names from the `roles` matrix entry, or undefined when unknown. */
function heldRoles(report: CapabilityReport): Set<string> | undefined {
  const entry = report.matrix.roles;
  if (entry?.status !== "available" || !entry.detail) return undefined;
  const detail = entry.detail as {
    admin?: unknown;
    notable?: unknown;
    roles?: unknown;
  };
  const names = new Set<string>();
  for (const list of [detail.roles, detail.notable]) {
    if (Array.isArray(list)) {
      for (const n of list) if (typeof n === "string") names.add(n);
    }
  }
  if (detail.admin === true) names.add("admin");
  return names;
}

/**
 * Compare what the enabled `packages` need with what the account can read and
 * the roles it holds.
 */
export function advisePrivilege(
  report: CapabilityReport,
  packages: readonly string[],
): PrivilegeAdvice {
  const enabled = new Set(packages);
  const missing: PrivilegeGap[] = [];

  for (const [key, cap] of Object.entries(report.capabilities)) {
    if (cap.achievable) continue;
    const users = (CAPABILITY_PACKAGES[key] ?? []).filter((p) =>
      enabled.has(p),
    );
    if (users.length === 0) continue;
    missing.push({
      need: key,
      packages: users,
      tables: cap.missing,
      reason: `grant read access to ${cap.missing.join(", ")}`,
    });
  }

  for (const [group, entry] of Object.entries(report.matrix)) {
    const pkg = MATRIX_PACKAGES[group as MatrixGroup];
    if (!pkg || !enabled.has(pkg) || entry?.status !== "unavailable") continue;
    missing.push({
      need: group,
      packages: [pkg],
      reason: entry.reason ?? "the instance refused the probe",
    });
  }

  const held = heldRoles(report);
  const excess: ExcessRole[] = [];
  if (held) {
    for (const [role, rule] of Object.entries(ELEVATED_ROLES)) {
      if (!held.has(role)) continue;
      if (rule.justifiedBy.some((p) => enabled.has(p))) continue;
      excess.push({ role, reason: rule.why });
    }
  }

  const status: PrivilegeAdvice["status"] =
    missing.length > 0 || excess.length > 0
      ? "advice"
      : held
        ? "least"
        : "partial";
  const summary =
    status === "least"
      ? "The account's access matches the enabled packages."
      : status === "partial"
        ? "Nothing the enabled packages need is missing; the account's roles are not readable, so excess roles are unknown."
        : [
            missing.length
              ? `missing: ${missing.map((m) => m.need).join(", ")}`
              : "",
            excess.length
              ? `excess: ${excess.map((e) => e.role).join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join("; ");

  return {
    status,
    packages: [...enabled].sort(),
    rolesKnown: held !== undefined,
    missing,
    excess,
    summary,
  };
}
