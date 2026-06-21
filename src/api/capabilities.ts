import { snRequest } from "../core/http.js";
import { ServiceNowError } from "../core/errors.js";
import { getCredentials } from "../core/config.js";
import { SCRIPT_TYPES } from "./scripts.js";

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
 */

/** Tables behind the schema tools. */
const SCHEMA_TABLES = ["sys_db_object", "sys_dictionary"];

/** Every distinct artefact table the script-intelligence readers touch. */
const ARTEFACT_TABLES = [
  ...new Set(Object.values(SCRIPT_TYPES).map((t) => t.table)),
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
}

/**
 * Read a single row's `sys_id` from a table — the cheapest possible read that
 * still exercises the ACL. A 401/403/404 is recorded as "not readable" rather
 * than thrown, so one restricted table never fails the whole preflight; a
 * transport-level error (no HTTP status) is genuinely global and is re-thrown.
 */
async function probeTable(table: string): Promise<TableProbe> {
  const params = new URLSearchParams({
    sysparm_limit: "1",
    sysparm_fields: "sys_id",
  });
  try {
    const res = await snRequest<{ result?: unknown[] }>({
      method: "GET",
      path: `/api/now/table/${encodeURIComponent(table)}`,
      params,
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
export async function checkCapabilities(): Promise<CapabilityReport> {
  const { instance, user } = getCredentials();
  const tables = [...new Set([...SCHEMA_TABLES, ...ARTEFACT_TABLES])];

  const probed = await Promise.all(tables.map(probeTable));
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
  };
}
