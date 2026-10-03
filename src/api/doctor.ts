import { getProfileEnv, type ProfileEnv } from "../core/settings.js";
import {
  getCredentials,
  hasCredentials,
  activeProfile,
  credentialStatus,
  type AuthMode,
} from "../core/config.js";
import { credentialWarnings, refreshTokenState } from "../core/auth.js";
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
  /** True when everything the profile's auth method needs is present (D-2). */
  configured: boolean;
  profile: string;
  instance: string;
  user: string;
  /** The auth method the profile uses (basic, oauth, apikey, token, none). */
  auth: AuthMode;
  /** The OAuth grant — only for `oauth`. */
  grant?: string;
  /** OAuth refresh-token state (L6-01) — only when one is configured. */
  refreshToken?: "configured" | "rotated-in-memory";
  /** Which required fields are missing (empty when fully configured). */
  missing: string[];
  /** Non-fatal credential warnings (token expiry, env-file ACLs, …). */
  warnings: string[];
  /** H-11 (L3-03): the profile's environment marker, when set. */
  env?: ProfileEnv;
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
  /**
   * M-2: the fix, when the verdict is not healthy — which env var to set or
   * which role the user needs. Absent when there is nothing to fix.
   */
  hint?: string;
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
  const { instance, user } = getCredentials(profile);
  // D-2: evaluated against the profile's own auth method, not only Basic.
  const status = credentialStatus(profile);
  const refresh = refreshTokenState(profile);
  return {
    configured: status.configured,
    profile,
    instance: instance || "(not set)",
    user: user || "(not set)",
    auth: status.mode,
    ...(status.grant ? { grant: status.grant } : {}),
    ...(refresh !== "none" ? { refreshToken: refresh } : {}),
    missing: status.missing,
    warnings: credentialWarnings(profile),
    ...(getProfileEnv(profile) ? { env: getProfileEnv(profile) } : {}),
  };
}

/** Where to set the missing credentials, per auth method. */
function configureHint(config: DoctorConfig): string {
  switch (config.auth) {
    case "apikey":
      return "Set SN_INSTANCE and SN_API_KEY (or use servicenow_set_credentials with request_secrets).";
    case "token":
      return "Set SN_INSTANCE and SN_BEARER_TOKEN or SN_TOKEN_FILE.";
    case "oauth":
      return "Set SN_INSTANCE, SN_OAUTH_CLIENT_ID and the material for SN_OAUTH_GRANT (see the README auth section).";
    case "none":
      return "Set SN_INSTANCE (and a client certificate for mutual TLS).";
    default:
      return "Set credentials with servicenow_set_credentials or the SN_INSTANCE/SN_USER/SN_PASSWORD env vars.";
  }
}

/** M-2: the fix for a failed connectivity probe, per status and auth method. */
export function connectionHint(
  c: ConnectionProbe,
  config: DoctorConfig,
): string | undefined {
  if (c.ok) return undefined;
  if (c.status === 401) {
    return `Check the credentials: ${configureHint(config)} servicenow_set_credentials updates them at runtime.`;
  }
  if (c.status === 403) {
    return "Grant the user a role that can read sys_user over REST (e.g. itil), plus snc_platform_rest_api_access where REST access is restricted.";
  }
  if (c.status === null) {
    return "Check SN_INSTANCE (the host must resolve and be reachable), the network, and the proxy settings (HTTPS_PROXY / NO_PROXY).";
  }
  return undefined;
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
      summary: `Profile "${profile}" is not configured (missing: ${config.missing.join(", ")}). ${configureHint(config)}`,
      hint: configureHint(config),
    };
  }

  // hasCredentials() is redundant with the check above but keeps the intent
  // explicit and guards against a future divergence in what "configured" means.
  const connection: ConnectionProbe = hasCredentials(profile)
    ? await testConnection()
    : { ok: false, status: null, latencyMs: 0, message: "not configured" };

  if (!connection.ok) {
    const hint = connectionHint(connection, config);
    return {
      status: "degraded",
      config,
      connection,
      summary: `Configured but not reachable — ${describeConnection(connection)}.`,
      ...(hint ? { hint } : {}),
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

  return {
    status,
    config,
    connection,
    capabilities,
    summary,
    ...(status === "degraded" && capabilities.recommendation
      ? { hint: capabilities.recommendation }
      : {}),
  };
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
const WARN = "!";

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
  lines.push(
    `    auth:     ${config.auth}${config.grant ? ` (${config.grant})` : ""}`,
    ...(config.env ? [`    env:      ${config.env}`] : []),
  );
  if (config.refreshToken) {
    lines.push(`    refresh:  ${config.refreshToken}`);
  }
  if (!config.configured) {
    lines.push(`    missing:  ${config.missing.join(", ")}`);
  }
  for (const warning of config.warnings) {
    lines.push(`    ${WARN} ${warning}`);
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
    // S-13 capability matrix — informational, it does not change the verdict.
    const matrix = Object.entries(cap.matrix ?? {});
    if (matrix.length > 0) {
      lines.push("");
      lines.push("  Capability matrix");
      for (const [group, m] of matrix) {
        const mark =
          m.status === "available" ? CHECK : m.status === "unknown" ? "?" : "-";
        lines.push(
          `    ${mark} ${group}: ${m.status}${m.reason ? ` (${m.reason})` : ""}`,
        );
      }
    }
  }

  lines.push("");
  lines.push(report.summary);
  if (report.hint && report.hint !== report.capabilities?.recommendation) {
    lines.push(`Fix: ${report.hint}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// D-1 / L4-05 — machine-readable and ASCII output for the CLI
// ---------------------------------------------------------------------------

/** One stage of the report as a flat check (`doctor --json | jq .checks`). */
export interface DoctorCheck {
  name: "credentials" | "connectivity" | "capabilities";
  ok: boolean;
  detail: string;
  /** M-2: the fix for a failed check (absent when it passed). */
  hint?: string;
}

/** The report's stages as a flat list; skipped stages are omitted. */
export function doctorChecks(report: DoctorReport): DoctorCheck[] {
  const { config } = report;
  const checks: DoctorCheck[] = [
    {
      name: "credentials",
      ok: config.configured,
      detail: config.configured
        ? `profile "${config.profile}" (${config.auth})`
        : `missing: ${config.missing.join(", ")}`,
      ...(config.configured ? {} : { hint: configureHint(config) }),
    },
  ];
  if (report.connection) {
    const c = report.connection;
    checks.push({
      name: "connectivity",
      ok: c.ok,
      detail: c.ok
        ? `HTTP ${c.status} in ${c.latencyMs}ms`
        : describeConnection(c),
      ...(connectionHint(c, config) ? { hint: connectionHint(c, config) } : {}),
    });
  }
  if (report.capabilities) {
    checks.push({
      name: "capabilities",
      ok: !report.capabilities.degraded,
      detail: report.capabilities.summary,
      ...(report.capabilities.degraded && report.capabilities.recommendation
        ? { hint: report.capabilities.recommendation }
        : {}),
    });
  }
  return checks;
}

/** E-4: why an env file was chosen, as shown by `doctor`. */
const ENV_FILE_SOURCE_TEXT: Record<string, string> = {
  SN_ENV_FILE: "from SN_ENV_FILE",
  xdg: "XDG config",
  project: "project-root .env fallback, deprecated — removed in 3.0",
  "xdg-default": "XDG config default",
};

/**
 * The first line of every doctor output: which env file was chosen and, when
 * `source` is given (E-4), which resolution rule picked it.
 */
export function envFileLine(
  path: string,
  exists: boolean,
  source?: string,
): string {
  const why = source ? `, ${ENV_FILE_SOURCE_TEXT[source] ?? source}` : "";
  return `env file: ${path} (${exists ? "exists" : "missing"}${why})`;
}

/**
 * L4-05 — plain ASCII is used when asked for, when stdout is not a terminal,
 * and on a Windows console that is not Windows Terminal (`cmd.exe` and legacy
 * PowerShell render the check glyphs as `?`).
 */
export function shouldUseAscii(options: {
  flag?: boolean;
  isTTY?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (options.flag) return true;
  if (!options.isTTY) return true;
  return options.platform === "win32" && !options.env?.WT_SESSION;
}

const ASCII_MAP: Record<string, string> = {
  [CHECK]: "[ok]",
  [CROSS]: "[x]",
  "—": "-",
  "–": "-",
  "…": "...",
  "→": "->",
  "·": "-",
  "“": '"',
  "”": '"',
  "‘": "'",
  "’": "'",
};

/** Transliterate a report to pure ASCII (anything unmapped becomes `?`). */
export function toAscii(text: string): string {
  return text.replace(/[^\t\n\r\x20-\x7e]/g, (ch) => ASCII_MAP[ch] ?? "?");
}
