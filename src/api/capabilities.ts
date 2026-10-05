import { snRequest } from "../core/http.js";
import { ServiceNowError } from "../core/errors.js";
import { getCredentials } from "../core/config.js";
import { ARTIFACT_TYPES } from "../core/artifacts/registry.js";
import { assertTableAllowed } from "../core/policy.js";
import { clearPluginAvailability } from "./plugin.js";
import {
  clearCapabilityCache,
  probeCapabilityMatrix,
  probeDomainSeparation,
  probeWorkspaces,
  MATRIX_GROUPS,
  type MatrixEntry,
  type MatrixGroup,
} from "./capability-matrix.js";

export { MATRIX_GROUPS, type MatrixEntry, type MatrixGroup };
import {
  sdkManagedStatus,
  type SdkManagedStatus,
} from "../core/artifacts/sdk-managed.js";

/**
 * DF-0 — capability preflight.
 *
 * The script-intelligence, flow and codecheck tools read admin-restricted
 * `sys_*` tables (`sys_script`, `sys_script_include`, `sys_security_acl`, …). A
 * true least-privilege integration user often cannot read them, so a tool that
 * "reads the instance's code" can return a silently empty result on a governed
 * instance even though it dazzles on a PDI (COMPETITIVE-ANALYSIS R1/R2). This
 * module probes, up front, which of those tables the connected user can
 * actually read and maps the result to the higher-level capabilities that
 * depend on them — so the assistant never promises a read it cannot make.
 *
 * S-13 adds the capability matrix (writes, update sets, attachments,
 * aggregate, import sets, email, ATF, version, roles — see
 * capability-matrix.ts) to the same report, and routes the table probes
 * through the table policy: a table SN_TABLES_ALLOW/DENY forbids is reported
 * unreadable without a request, because no tool could read it either.
 */

/** Tables behind the schema tools. */
const SCHEMA_TABLES = ["sys_db_object", "sys_dictionary"];

/**
 * Every distinct artefact table the script-intelligence readers touch: the
 * primary tables of the registry types exposed through the script tools (P-1).
 * Verified types only: the S-4 widened types are unverified until O-5, and a
 * missing optional table must not flip `script_intelligence` to unavailable.
 */
const ARTEFACT_TABLES = [
  ...new Set(
    ARTIFACT_TYPES.filter((t) => t.scriptTools && t.verified).map(
      (t) => t.table,
    ),
  ),
];

/** A higher-level capability and the tables it needs to be achievable. */
interface CapabilityGroup {
  label: string;
  /** Tables that must be readable for the capability to work. */
  tables: string[];
  /** Which tools this capability unlocks. */
  unlocks: string;
}

const CAPABILITY_GROUPS: Record<string, CapabilityGroup> = {
  schema_reads: {
    label: "Schema reads (list/describe tables, inheritance chain)",
    tables: SCHEMA_TABLES,
    unlocks: "schema package",
  },
  script_intelligence: {
    label:
      "Script intelligence (business rules, script includes, client scripts…)",
    tables: ARTEFACT_TABLES.filter((t) => t !== "sys_security_acl"),
    unlocks: "scripts, flows and codecheck packages",
  },
  acl_audit: {
    label: "ACL / security audit",
    tables: ["sys_security_acl"],
    unlocks: "DF-1 security scan",
  },
};

export interface TableProbe {
  table: string;
  readable: boolean;
  /** HTTP status observed (200 when readable; 401/403/404 when not). */
  status?: number;
  /** Human-readable reason when not readable. */
  reason?: string;
  /** True when the table policy forbids it, so it was not probed (S-13). */
  policyDenied?: boolean;
}

export interface CapabilityResult {
  achievable: boolean;
  label: string;
  unlocks: string;
  /** Tables this capability needs that the user cannot read. */
  missing: string[];
}

export interface CapabilityReport {
  instance: string;
  user: string;
  probed: TableProbe[];
  capabilities: Record<string, CapabilityResult>;
  /** True when at least one needed artefact table is unreadable. */
  degraded: boolean;
  recommendation: string;
  summary: string;
  /**
   * S-13 — per-group capability matrix (all groups unless `groups` narrowed
   * it). Informational: it does not change `degraded`.
   */
  matrix: Partial<Record<MatrixGroup, MatrixEntry>>;
  /** P-3: scopes the local sources declare SDK-managed (additive). */
  sdkManaged: SdkManagedStatus;
  /**
   * N-12: whether domain separation is active and the user's domain
   * (`detail.active`, `detail.domain`). Probed on a full run only — absent
   * when `groups` narrowed the matrix.
   */
  domainSeparation?: MatrixEntry;
  /**
   * N-30: configurable workspaces vs legacy Agent Workspace configs
   * (`detail.kind` configurable / agent / mixed / none, with counts). Probed
   * on a full run only — absent when `groups` narrowed the matrix.
   */
  workspaces?: MatrixEntry;
}

export interface CheckCapabilitiesOptions {
  /** Matrix groups to probe (default: all). The table preflight always runs. */
  groups?: readonly MatrixGroup[];
  /** Drop the cached matrix results and plugin availability first. */
  refresh?: boolean;
}

/**
 * Read a single row's `sys_id` from a table — the cheapest possible read that
 * still exercises the ACL. A 401/403/404 is recorded as "not readable" rather
 * than thrown, so one restricted table never fails the whole preflight; a
 * transport-level error (no HTTP status) is genuinely global and is re-thrown.
 */
async function probeTable(table: string): Promise<TableProbe> {
  try {
    assertTableAllowed(table);
  } catch (error) {
    return {
      table,
      readable: false,
      policyDenied: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const params = new URLSearchParams({
    sysparm_limit: "1",
    sysparm_fields: "sys_id",
  });
  try {
    const res = await snRequest<{ result?: unknown[] }>({
      method: "GET",
      path: `/api/now/table/${encodeURIComponent(table)}`,
      params,
      // Preflight/doctor diagnostic: answer even while the queue is stalled.
      bypassQueue: true,
    });
    return { table, readable: true, status: res.status };
  } catch (error) {
    if (error instanceof ServiceNowError && error.status !== undefined) {
      const reason =
        error.status === 403
          ? "no read access (the user lacks a role that can read this table)"
          : error.status === 401
            ? "authentication failed"
            : error.status === 404
              ? "table not present on this instance"
              : error.message;
      return { table, readable: false, status: error.status, reason };
    }
    // No HTTP status → transport/SSRF failure; the instance is unreachable, so
    // the whole preflight is meaningless. Surface it.
    throw error;
  }
}

/**
 * Probe the admin-restricted tables behind the read-heavy capabilities and
 * report which capabilities are actually achievable for the connected user.
 */
export async function checkCapabilities(
  opts: CheckCapabilitiesOptions = {},
): Promise<CapabilityReport> {
  const { instance, user } = getCredentials();
  const tables = [...new Set([...SCHEMA_TABLES, ...ARTEFACT_TABLES])];

  if (opts.refresh) {
    clearCapabilityCache();
    clearPluginAvailability();
  }
  // The matrix never throws; a table-probe transport error still does.
  const [probed, matrix, domainSeparation, workspaces] = await Promise.all([
    Promise.all(tables.map(probeTable)),
    probeCapabilityMatrix(opts.groups ?? MATRIX_GROUPS),
    opts.groups ? undefined : probeDomainSeparation(),
    opts.groups ? undefined : probeWorkspaces(),
  ]);
  const readable = new Set(
    probed.filter((p) => p.readable).map((p) => p.table),
  );

  const capabilities: Record<string, CapabilityResult> = {};
  for (const [key, group] of Object.entries(CAPABILITY_GROUPS)) {
    const missing = group.tables.filter((t) => !readable.has(t));
    capabilities[key] = {
      achievable: missing.length === 0,
      label: group.label,
      unlocks: group.unlocks,
      missing,
    };
  }

  const degraded = Object.values(capabilities).some((c) => !c.achievable);
  const recommendation = degraded
    ? "Some capabilities are limited. The sys_* code tables are admin-restricted by default; grant the integration user read access (a dedicated read role, or admin) — ACL script bodies additionally need the security_admin elevated role."
    : "All probed capabilities are achievable for the connected user.";

  const ok = Object.values(capabilities).filter((c) => c.achievable).length;
  const summary = `${readable.size}/${tables.length} probed tables readable; ${ok}/${Object.keys(capabilities).length} capabilities achievable.`;

  return {
    instance: instance || "(not set)",
    user: user || "(not set)",
    probed,
    capabilities,
    degraded,
    recommendation,
    summary,
    matrix,
    sdkManaged: sdkManagedStatus(),
    ...(domainSeparation ? { domainSeparation } : {}),
    ...(workspaces ? { workspaces } : {}),
  };
}
