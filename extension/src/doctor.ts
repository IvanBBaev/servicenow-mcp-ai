/**
 * Pure helpers for the status-bar doctor: the launcher command line and the
 * summary of a `servicenow-mcp-ai doctor --json` run. No `vscode` import —
 * unit-tested in `src/test/doctor.test.ts`.
 */
import { SERVER_SPEC } from "./config";

/** A command line to spawn: the executable, its arguments, shell or not. */
export interface Launch {
  command: string;
  args: string[];
  /** Windows resolves `npx` to `npx.cmd`, which needs a shell to spawn. */
  shell: boolean;
}

/**
 * The launcher shared by the MCP server definition and the doctor, so both run
 * the same package through the same resolver: `npx -y servicenow-mcp-ai@<major>.x [...]`
 * (`SERVER_SPEC`, D-6).
 */
export function serverLaunch(
  extraArgs: string[] = [],
  platform: NodeJS.Platform = process.platform,
): Launch {
  return {
    command: "npx",
    args: ["-y", SERVER_SPEC, ...extraArgs],
    shell: platform === "win32",
  };
}

export type DoctorStatus = "healthy" | "degraded" | "not_configured";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** What the status bar and the output channel show after a doctor run. */
export interface DoctorSummary {
  /** `error` when the run produced no usable report. */
  status: DoctorStatus | "error";
  /** One line for a notification / the status-bar tooltip. */
  headline: string;
  checks: DoctorCheck[];
  envFile?: { path: string; exists: boolean };
  /** Non-fatal credential warnings the report carried. */
  warnings: string[];
  /** Multi-line text for the output channel. */
  text: string;
}

const STATUSES: readonly string[] = ["healthy", "degraded", "not_configured"];

/**
 * Pull the JSON document out of the doctor's stdout. `npx` may print notices
 * before it, so fall back to the span from the first line that opens an object
 * to the last closing brace.
 */
export function extractJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/^\{/m);
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/**
 * Summarise one doctor run. The exit code maps 0 / 1 / 2 onto healthy /
 * degraded / not_configured; anything else, or stdout without a report, is an
 * `error` summary carrying the tail of stderr.
 */
export function summarizeDoctor(run: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}): DoctorSummary {
  const doc = extractJson(run.stdout);
  const report =
    doc && typeof doc === "object"
      ? (doc as Record<string, unknown>)
      : undefined;
  const status = str(report?.status);
  if (!report || !status || !STATUSES.includes(status)) {
    const tail = run.stderr.trim().split(/\r?\n/).slice(-5).join("\n");
    const reason =
      tail ||
      (run.exitCode === null
        ? "the doctor process did not exit normally"
        : `exit code ${run.exitCode} without a JSON report`);
    return {
      status: "error",
      headline: `Doctor failed: ${reason.split(/\r?\n/).pop() ?? reason}`,
      checks: [],
      warnings: [],
      text: `Doctor failed (exit ${run.exitCode ?? "none"}).\n${reason}\n`,
    };
  }

  const checks: DoctorCheck[] = Array.isArray(report.checks)
    ? report.checks.flatMap((c): DoctorCheck[] => {
        if (!c || typeof c !== "object") return [];
        const o = c as Record<string, unknown>;
        const name = str(o.name);
        if (!name) return [];
        return [{ name, ok: o.ok === true, detail: str(o.detail) ?? "" }];
      })
    : [];

  const ef = report.envFile as Record<string, unknown> | undefined;
  const envFile =
    ef && typeof ef === "object" && typeof ef.path === "string"
      ? { path: ef.path, exists: ef.exists === true }
      : undefined;

  const config = report.config as Record<string, unknown> | undefined;
  const warnings =
    config && Array.isArray(config.warnings)
      ? config.warnings.filter((w): w is string => typeof w === "string")
      : [];

  const summary = str(report.summary) ?? status;
  const lines = [
    `Status: ${status}`,
    summary !== status ? `Summary: ${summary}` : undefined,
    envFile
      ? `Env file: ${envFile.path} (${envFile.exists ? "exists" : "missing"})`
      : undefined,
    ...checks.map((c) => `  [${c.ok ? "ok" : "x"}] ${c.name}: ${c.detail}`),
    ...warnings.map((w) => `  warning: ${w}`),
  ].filter((l): l is string => l !== undefined);

  return {
    status: status as DoctorStatus,
    headline: `ServiceNow doctor: ${summary}`,
    checks,
    ...(envFile ? { envFile } : {}),
    warnings,
    text: lines.join("\n") + "\n",
  };
}
