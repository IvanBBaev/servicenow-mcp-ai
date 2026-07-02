import {
  getCredentials,
  hasCredentials,
  activeProfile,
} from "../core/config.js";
import { testConnection, type ConnectionProbe } from "./diagnostics.js";
import { checkCapabilities, type CapabilityReport } from "./capabilities.js";

/**
 * UX §11.8 / §4.2 — the `doctor` CLI subcommand.
 *
 * One-shot health check that fuses the three questions a new user actually asks
 * before trusting the server: is it *configured*, can it *reach* the instance,
 * and which higher-level *capabilities* the connected user can actually use.
 * It reuses the same building blocks the MCP tools expose — testConnection()
 * (servicenow_test_connection) and checkCapabilities() (check_capabilities) —
 * so the CLI answer and the tool answer never drift.
 *
 * The stages are ordered and short-circuit: no point probing connectivity when
 * nothing is configured, and no point preflighting capabilities when the
 * instance is unreachable (the capability probe re-throws transport errors on
 * purpose). Secrets are never printed — only presence flags and the username.
 */

/** Overall health verdict, mapped 1:1 onto the process exit code (see EXIT). */
export type DoctorStatus = "healthy" | "degraded" | "not_configured";

/** Credential-presence stage — never carries the password, only flags. */
export interface DoctorConfig {
  /** True when instance + user + password are all present for the profile. */
  configured: boolean;
  profile: string;
  instance: string;
  user: string;
  /** Which required fields are missing (empty when fully configured). */
  missing: string[];
}

export interface DoctorReport {
  status: DoctorStatus;
  config: DoctorConfig;
  /** Live connectivity probe; omitted when nothing is configured. */
  connection?: ConnectionProbe;
  /** Capability preflight; omitted when unconfigured or unreachable. */
  capabilities?: CapabilityReport;
  /** One-line, human-readable summary of the verdict. */
  summary: string;
}

/**
 * Exit-code convention (documented for the CLI dispatch in index.ts):
 *   0 = healthy      — configured, reachable, no capability degraded.
 *   1 = degraded     — configured but the instance is unreachable/auth failed,
 *                      or some capability is not achievable for the user.
 *   2 = not_configured — no instance/user/password for the active profile.
 */
export const EXIT: Record<DoctorStatus, number> = {
  healthy: 0,
  degraded: 1,
  not_configured: 2,
};

/** Inspect the active profile's credentials without touching the network. */
function inspectConfig(profile: string): DoctorConfig {
  const { instance, user, password } = getCredentials(profile);
  const missing: string[] = [];
  if (!instance) missing.push("instance");
  if (!user) missing.push("user");
  if (!password) missing.push("password");
  return {
    configured: missing.length === 0,
    profile,
    instance: instance || "(not set)",
    user: user || "(not set)",
    missing,
  };
}

/**
 * Run the full health check for the active profile. Returns a structured
 * report (never throws for the expected "not configured / unreachable / 401"
 * cases — those are data). A genuine, global transport error while probing
 * capabilities is turned into a degraded verdict rather than propagated, so the
 * CLI always exits with a meaningful code.
 */
export async function runDoctor(): Promise<DoctorReport> {
  const profile = activeProfile();
  const config = inspectConfig(profile);

  if (!config.configured) {
    return {
      status: "not_configured",
      config,
      summary: `Profile "${profile}" is not configured (missing: ${config.missing.join(", ")}). Set credentials with servicenow_set_credentials or the SN_INSTANCE/SN_USER/SN_PASSWORD env vars.`,
    };
  }

  // hasCredentials() is redundant with the check above but keeps the intent
  // explicit and guards against a future divergence in what "configured" means.
  const connection: ConnectionProbe = hasCredentials(profile)
    ? await testConnection()
    : { ok: false, status: null, latencyMs: 0, message: "not configured" };

  if (!connection.ok) {
    return {
      status: "degraded",
      config,
      connection,
      summary: `Configured but not reachable — ${describeConnection(connection)}.`,
    };
  }

  // Reachable: the capability preflight is safe to run. Should its transport
  // guard fire despite a green connection probe, degrade instead of crashing.
  let capabilities: CapabilityReport | undefined;
  try {
    capabilities = await checkCapabilities();
  } catch (error) {
    return {
      status: "degraded",
      config,
      connection,
      summary: `Reachable, but the capability preflight failed — ${
        error instanceof Error ? error.message : String(error)
      }.`,
    };
  }

  const status: DoctorStatus = capabilities.degraded ? "degraded" : "healthy";
  const summary =
    status === "healthy"
      ? `Healthy — ${config.instance} reachable in ${connection.latencyMs}ms; ${capabilities.summary}`
      : `Degraded — ${config.instance} reachable, but ${capabilities.summary}`;

  return { status, config, connection, capabilities, summary };
}

/** Short phrase for a failed connectivity probe (401/403/timeout/other). */
function describeConnection(c: ConnectionProbe): string {
  if (c.status === 401) return "authentication failed (401): check credentials";
  if (c.status === 403) return "access forbidden (403): check the user's roles";
  if (c.status === null)
    return `unreachable: ${c.message ?? "no response from the instance"}`;
  return `HTTP ${c.status}: ${c.message ?? "unexpected response"}`;
}

const CHECK = "✓";
const CROSS = "✗";

/** Render a DoctorReport as a readable, plain-text block for the terminal. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("servicenow-mcp-ai doctor");
  lines.push("");

  // -- credentials --------------------------------------------------------
  const { config } = report;
  lines.push(
    `${config.configured ? CHECK : CROSS} Credentials — profile "${config.profile}"`,
  );
  lines.push(`    instance: ${config.instance}`);
  lines.push(`    user:     ${config.user}`);
  if (!config.configured) {
    lines.push(`    missing:  ${config.missing.join(", ")}`);
  }

  // -- connectivity -------------------------------------------------------
  if (report.connection) {
    const c = report.connection;
    lines.push("");
    lines.push(
      `${c.ok ? CHECK : CROSS} Connectivity — ${
        c.ok ? `HTTP ${c.status} in ${c.latencyMs}ms` : describeConnection(c)
      }`,
    );
  }

  // -- capabilities -------------------------------------------------------
  if (report.capabilities) {
    const cap = report.capabilities;
    lines.push("");
    lines.push(`${cap.degraded ? CROSS : CHECK} Capabilities — ${cap.summary}`);
    for (const [key, c] of Object.entries(cap.capabilities)) {
      lines.push(
        `    ${c.achievable ? CHECK : CROSS} ${key}: ${c.label}${
          c.achievable ? "" : ` (missing: ${c.missing.join(", ")})`
        }`,
      );
    }
    if (cap.degraded) {
      lines.push("");
      lines.push(`    ${cap.recommendation}`);
    }
  }

  lines.push("");
  lines.push(report.summary);
  return lines.join("\n");
}
