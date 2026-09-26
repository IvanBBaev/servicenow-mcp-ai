import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getEnvPath } from "../core/config.js";
import { SERVER_VERSION } from "../core/identity.js";
import { getLogFile } from "../core/settings.js";

/**
 * D-1 / L7-03 — `servicenow-mcp-ai support-bundle`: everything a bug report
 * needs in one reviewable JSON file — versions, the doctor JSON, the
 * effective SN_* settings with every secret masked, `npm ls --omit=dev`, the
 * tool manifest summary and the tail of the log file (when one is set).
 *
 * Secrets are handled twice: a key that names a secret is masked, and then
 * every masked value is scrubbed from the whole serialized bundle, so a
 * secret that leaked into a doctor message or a log line is caught too.
 */

export const BUNDLE_VERSION = 1;
export const MASK = "***";
/** Log lines kept from the end of SN_LOG_FILE. */
export const LOG_TAIL_LINES = 200;
/** Bytes read from the end of SN_LOG_FILE to find those lines. */
const LOG_TAIL_BYTES = 256 * 1024;
/** Masked values shorter than this are not scrubbed from free text. */
const MIN_SCRUB_CHARS = 4;

/** Setting names whose value is a credential (or credential material). */
const SECRET_NAME_RE =
  /(PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY|JWT_KEY|PRIVATE|PASSPHRASE|COOKIE|CREDENTIAL|_KEY$|_PFX$)/;

/** True when an env key names a secret. */
export function isSecretSetting(name: string): boolean {
  return SECRET_NAME_RE.test(name.toUpperCase());
}

/** The SN_* settings of `env`, sorted, with secret values masked. */
export function redactedSettings(env: NodeJS.ProcessEnv): {
  settings: Record<string, string>;
  secrets: string[];
} {
  const settings: Record<string, string> = {};
  const secrets: string[] = [];
  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (!key.startsWith("SN_") || value === undefined) continue;
    if (isSecretSetting(key)) {
      settings[key] = value === "" ? "" : MASK;
      if (value.trim().length >= MIN_SCRUB_CHARS) secrets.push(value.trim());
    } else {
      settings[key] = value;
    }
  }
  return { settings, secrets };
}

/** Replace every occurrence of every secret in `text` with the mask. */
export function scrubSecrets(text: string, secrets: string[]): string {
  // Longest first, so a secret that contains another is masked whole.
  const ordered = [...new Set(secrets)].sort((a, b) => b.length - a.length);
  let out = text;
  for (const secret of ordered) {
    out = out.split(secret).join(MASK);
    // The JSON-escaped spelling too (a backslash or quote inside the value).
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) out = out.split(escaped).join(MASK);
  }
  return out;
}

/** The last `lines` lines of a file (reads at most LOG_TAIL_BYTES). */
export function tailFile(path: string, lines = LOG_TAIL_LINES): string[] {
  const size = statSync(path).size;
  const length = Math.min(size, LOG_TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  const all = buffer.toString("utf8").split(/\r?\n/);
  if (all.at(-1) === "") all.pop();
  // A partial first line (the read started mid-line) is dropped.
  if (length < size) all.shift();
  return all.slice(-lines);
}

/** The package root (parent of build/ or src/). */
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `npm ls --omit=dev --depth=0 --json` in the package root — best effort. */
export function npmLs(timeoutMs = 20_000): Promise<unknown> {
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    execFile(
      win ? "npm.cmd" : "npm",
      ["ls", "--omit=dev", "--depth=0", "--json"],
      { cwd: packageRoot, timeout: timeoutMs, shell: win, windowsHide: true },
      (error, stdout) => {
        try {
          // npm ls exits non-zero on extraneous/missing packages but still
          // prints the tree — use it whenever it parses.
          resolve(JSON.parse(stdout));
        } catch {
          resolve({
            error: error ? error.message.split("\n")[0] : "unparseable output",
          });
        }
      },
    );
  });
}

export interface BundleInputs {
  /** The doctor JSON payload (as `doctor --json` prints it). */
  doctor: unknown;
  /** The tool manifest summary. */
  manifest: unknown;
  /** Environment to read SN_* settings from (default: process.env). */
  env?: NodeJS.ProcessEnv;
  /** `npm ls` runner (injectable for tests). */
  npm?: () => Promise<unknown>;
  now?: Date;
}

/**
 * Build the bundle and return it serialized (pretty JSON, secrets scrubbed).
 * Never throws for a missing log file or a failing `npm ls` — those are
 * recorded in the bundle instead.
 */
export async function buildSupportBundle(
  inputs: BundleInputs,
): Promise<string> {
  const env = inputs.env ?? process.env;
  const { settings, secrets } = redactedSettings(env);
  const envFile = getEnvPath();
  const logFile = getLogFile();
  let logTail: unknown;
  if (logFile) {
    try {
      logTail = { file: logFile, lines: tailFile(logFile) };
    } catch (error) {
      logTail = {
        file: logFile,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const bundle = {
    bundleVersion: BUNDLE_VERSION,
    generatedAt: (inputs.now ?? new Date()).toISOString(),
    note: "Review this file before attaching it to an issue: secrets are masked as ***, instance names and user names are not.",
    versions: {
      server: SERVER_VERSION,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    envFile: { path: envFile, exists: existsSync(envFile) },
    settings,
    doctor: inputs.doctor,
    manifest: inputs.manifest,
    npm: await (inputs.npm ?? npmLs)(),
    ...(logTail ? { logTail } : {}),
  };
  return scrubSecrets(JSON.stringify(bundle, null, 2), secrets) + "\n";
}
