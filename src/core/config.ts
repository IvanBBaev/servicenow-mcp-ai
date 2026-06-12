import {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import dotenv from "dotenv";
import { currentRequestProfile } from "./request-context.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** The project-root .env (parent of build/ or src/), used in local development. */
const projectEnvPath = join(moduleDir, "..", ".env");

/** XDG user-config location, used for global/npx installs. */
function xdgEnvPath(): string {
  const base =
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "servicenow-mcp", ".env");
}

/**
 * Resolve which env file to read/write, in order of precedence:
 *   1. SN_ENV_FILE — explicit override.
 *   2. an existing XDG config file (~/.config/servicenow-mcp/.env).
 *   3. an existing project-root .env (local development).
 *   4. otherwise the XDG path, so a global install writes to user space rather
 *      than into a (possibly read-only or transient) node_modules directory.
 */
export function getEnvPath(): string {
  const explicit = process.env.SN_ENV_FILE?.trim();
  if (explicit) return explicit;
  const xdg = xdgEnvPath();
  if (existsSync(xdg)) return xdg;
  if (existsSync(projectEnvPath)) return projectEnvPath;
  return xdg;
}

export interface ServiceNowCredentials {
  instance: string;
  user: string;
  password: string;
}

/** Load the env file into process.env. Safe to call when the file is missing. */
export function loadEnv(): void {
  const path = getEnvPath();
  if (existsSync(path)) {
    // override:false so values already in the environment (e.g. supplied by the
    // MCP client) take precedence over the file — environment-first config.
    dotenv.config({ path, override: false });
  }
  reloadCredentialsFromEnv();
}

/**
 * Named connection profiles (MI-1). The legacy keys SN_INSTANCE/SN_USER/
 * SN_PASSWORD are the `default` profile — full backwards compatibility. Any
 * other profile lives under SN_PROFILE_<NAME>_INSTANCE/_USER/_PASSWORD, and
 * SN_ACTIVE_PROFILE picks which one tools use when no explicit profile is
 * given.
 */
const PROFILE_RE = /^[a-z0-9_]+$/;

/** Throw on a malformed profile name (lowercase letters, digits, underscores). */
export function assertValidProfileName(profile: string): void {
  if (!PROFILE_RE.test(profile)) {
    throw new Error(
      `Invalid profile name "${profile}" — use lowercase letters, digits and underscores.`,
    );
  }
}

function envKeysFor(profile: string): {
  instance: string;
  user: string;
  password: string;
} {
  if (profile === "default") {
    return {
      instance: "SN_INSTANCE",
      user: "SN_USER",
      password: "SN_PASSWORD",
    };
  }
  const upper = profile.toUpperCase();
  return {
    instance: `SN_PROFILE_${upper}_INSTANCE`,
    user: `SN_PROFILE_${upper}_USER`,
    password: `SN_PROFILE_${upper}_PASSWORD`,
  };
}

/**
 * The profile for the current call: an explicit per-request profile (MI-3
 * AsyncLocalStorage context) wins over SN_ACTIVE_PROFILE.
 */
export function activeProfile(): string {
  const fromRequest = currentRequestProfile();
  if (fromRequest) return fromRequest;
  const raw = process.env.SN_ACTIVE_PROFILE?.trim().toLowerCase();
  return raw && PROFILE_RE.test(raw) ? raw : "default";
}

/** Profiles visible in the environment (default first, then alphabetical). */
export function listProfiles(): string[] {
  const names = new Set<string>();
  if (process.env.SN_INSTANCE?.trim()) names.add("default");
  for (const key of Object.keys(process.env)) {
    const match = /^SN_PROFILE_([A-Z0-9_]+)_INSTANCE$/.exec(key);
    if (match?.[1] && process.env[key]?.trim()) {
      names.add(match[1].toLowerCase());
    }
  }
  return [...names].sort((a, b) =>
    a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b),
  );
}

/**
 * In-memory credential store: the environment is only the *initial* source.
 * The first read of a profile snapshots its keys; afterwards every read
 * returns the same immutable snapshot until saveCredentials/useProfile (or an
 * explicit reload) swaps the store in a single assignment. A torn read
 * (new user + old password) is structurally impossible.
 */
let store = new Map<string, ServiceNowCredentials>();

function snapshotFromEnv(profile: string): ServiceNowCredentials {
  const keys = envKeysFor(profile);
  return {
    instance: process.env[keys.instance]?.trim() ?? "",
    user: process.env[keys.user]?.trim() ?? "",
    password: process.env[keys.password] ?? "",
  };
}

/** Read a profile's credentials (atomic snapshot; default: the active profile). */
export function getCredentials(
  profile: string = activeProfile(),
): ServiceNowCredentials {
  let creds = store.get(profile);
  if (!creds) {
    creds = snapshotFromEnv(profile);
    store.set(profile, creds);
  }
  return { ...creds };
}

/**
 * Drop every profile snapshot and re-read from process.env — used by
 * loadEnv() at startup and by tests that stage the environment directly.
 */
export function reloadCredentialsFromEnv(): ServiceNowCredentials {
  store = new Map();
  return getCredentials();
}

/** True when the profile's instance, user and password are all present. */
export function hasCredentials(profile: string = activeProfile()): boolean {
  const c = getCredentials(profile);
  return Boolean(c.instance && c.user && c.password);
}

/**
 * Persist credentials to the .env file and update process.env so the new
 * values take effect immediately. Only the provided fields are changed;
 * any other keys already in .env are preserved. Non-default profiles write
 * their prefixed keys.
 */
export function saveCredentials(
  partial: Partial<ServiceNowCredentials>,
  profile: string = activeProfile(),
): ServiceNowCredentials {
  assertValidProfileName(profile);
  const keys = envKeysFor(profile);
  const updates: Record<string, string> = {};
  if (partial.instance !== undefined)
    updates[keys.instance] = partial.instance.trim();
  if (partial.user !== undefined) updates[keys.user] = partial.user.trim();
  if (partial.password !== undefined) updates[keys.password] = partial.password;

  updateEnvFile(updates);

  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
  }

  // Swap the store in one assignment — readers never observe a half-applied
  // credential change.
  store = new Map();
  return getCredentials(profile);
}

/**
 * Switch the active profile (persisted to the env file). The caller is
 * responsible for clearing identity-scoped caches (tokens, schema, plugin
 * availability) — the admin tool does that.
 */
export function useProfile(name: string): ServiceNowCredentials {
  const profile = name.trim().toLowerCase();
  assertValidProfileName(profile);
  const known = listProfiles();
  if (!known.includes(profile)) {
    throw new Error(
      `Unknown profile "${profile}". Available: ${known.join(", ") || "(none)"}.`,
    );
  }
  updateEnvFile({ SN_ACTIVE_PROFILE: profile });
  process.env.SN_ACTIVE_PROFILE = profile;
  store = new Map();
  return getCredentials(profile);
}

/**
 * Serialise a value for an .env line so that dotenv parses it back identically.
 *
 * dotenv (v16) only strips one pair of surrounding quotes and, for double
 * quotes, expands `\n`/`\r`; it does NOT unescape `\\` or `\"`. The only
 * lossless quoting is therefore single quotes (taken literally), which cannot
 * contain a single quote or newline. Unquoted values are also literal except
 * that leading/trailing whitespace is trimmed and `#` starts a comment.
 */
export function formatEnvValue(value: string): string {
  const needsQuoting =
    value === "" || /^\s|\s$|[#\r\n]/.test(value) || /^['"`]/.test(value);
  if (!needsQuoting) {
    // Unquoted values are literal (backslashes, $, quotes in the middle all
    // survive), so no escaping is required here.
    return value;
  }
  // Inside quotes dotenv treats \' \" \` as escapes but never unescapes a
  // backslash, so a value that needs quoting cannot contain a backslash or
  // newline and still round-trip reliably.
  if (/[\\\r\n]/.test(value)) {
    throw new Error(
      "Value cannot be stored safely in .env: it needs quoting but contains a backslash or newline that dotenv cannot round-trip.",
    );
  }
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  if (!value.includes('"')) {
    return `"${value}"`;
  }
  throw new Error(
    "Value cannot be stored safely in .env: it contains both single and double quotes.",
  );
}

/**
 * Update or append the given keys in the .env file while keeping the rest of
 * the file (comments, ordering, unrelated keys) intact.
 */
function updateEnvFile(updates: Record<string, string>): void {
  const path = getEnvPath();
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = raw.split(/\r?\n/);

  // Drop a single trailing empty entry caused by a final newline; we re-add
  // exactly one trailing newline on write to avoid stray blank lines.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const pending = new Set(Object.keys(updates));

  const rewritten = lines.map((line) => {
    const key = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    const value = key !== undefined ? updates[key] : undefined;
    if (key !== undefined && value !== undefined && pending.has(key)) {
      pending.delete(key);
      return `${key}=${formatEnvValue(value)}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (pending.has(key)) rewritten.push(`${key}=${formatEnvValue(value)}`);
  }

  // Write atomically: a temp file in the same directory plus rename avoids a
  // partially written file if the process is interrupted mid-write. Ensure the
  // target directory exists first (e.g. ~/.config/servicenow-mcp on first run).
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${rewritten.join("\n")}\n`, "utf8");
  renameSync(tmpPath, path);
}
