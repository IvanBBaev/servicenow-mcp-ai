import {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  mkdirSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import dotenv from "dotenv";
import { activeProfile, PROFILE_RE } from "./profile.js";
import { currentRuntime, defineRuntimePart } from "./runtime.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** The project-root .env (parent of build/ or src/), used in local development. */
const projectEnvPath = join(moduleDir, "..", ".env");

/** XDG user-config location, used for global/npx installs. */
function xdgEnvPath(): string {
  const base =
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "servicenow-mcp-ai", ".env");
}

/**
 * Resolve which env file to read/write, in order of precedence:
 *   1. SN_ENV_FILE — explicit override.
 *   2. an existing XDG config file (~/.config/servicenow-mcp-ai/.env).
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

/** Throw on a malformed profile name (lowercase letters, digits, underscores). */
export function assertValidProfileName(profile: string): void {
  if (!PROFILE_RE.test(profile)) {
    throw new Error(
      `Invalid profile name "${profile}" — use lowercase letters, digits and underscores.`,
    );
  }
}

export function envKeysFor(profile: string): {
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

export { activeProfile };

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
 *
 * E-3: the store is held by the runtime container (a fresh runtime re-reads
 * the environment); it survives dispose() — credentials are not session state.
 */
const profileStorePart = defineRuntimePart("profiles", () => ({
  snapshots: new Map<string, ServiceNowCredentials>(),
}));

const profileStore = () => currentRuntime().get(profileStorePart);

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
  const store = profileStore().snapshots;
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
  profileStore().snapshots = new Map();
  return getCredentials();
}

// ---------------------------------------------------------------------------
// D-2 — per-auth-method credential model
// ---------------------------------------------------------------------------

/** Every inbound REST auth method ServiceNow supports. */
export type AuthMode = "basic" | "oauth" | "apikey" | "token" | "none";

/** The auth settings `servicenow_set_credentials` can write (env suffixes). */
export type AuthSetting =
  | "AUTH"
  | "API_KEY"
  | "OAUTH_CLIENT_ID"
  | "OAUTH_CLIENT_SECRET"
  | "OAUTH_GRANT";

/** Pending (not yet persisted) auth values, keyed by env suffix. */
export type PendingAuth = Partial<Record<string, string>>;

/**
 * Read an auth env var for `profile`: SN_PROFILE_<NAME>_<SUFFIX> first, then
 * the global SN_<SUFFIX> (an empty override falls through). `pending` values
 * win over both — used to evaluate a change before it is written.
 */
export function profileAuthEnv(
  suffix: string,
  profile: string,
  pending: PendingAuth = {},
): string | undefined {
  const staged = pending[suffix];
  if (staged !== undefined) return staged;
  if (profile !== "default") {
    const scoped = process.env[`SN_PROFILE_${profile.toUpperCase()}_${suffix}`];
    if (scoped !== undefined && scoped.trim() !== "") return scoped;
  }
  return process.env[`SN_${suffix}`];
}

/** The env key a profile's auth setting is written to. */
export function authEnvKey(suffix: string, profile: string): string {
  return profile === "default"
    ? `SN_${suffix}`
    : `SN_PROFILE_${profile.toUpperCase()}_${suffix}`;
}

const AUTH_MODES: readonly AuthMode[] = [
  "basic",
  "oauth",
  "apikey",
  "token",
  "none",
];

/**
 * Resolve a profile's auth mode. An explicit SN_AUTH wins; otherwise it is
 * inferred from the present keys: API key → bearer token (inline or file) →
 * OAuth client id → Basic.
 */
export function authModeFor(
  profile: string,
  pending: PendingAuth = {},
): AuthMode {
  const env = (suffix: string) =>
    profileAuthEnv(suffix, profile, pending)?.trim();
  const explicit = env("AUTH")?.toLowerCase();
  if (explicit && (AUTH_MODES as readonly string[]).includes(explicit)) {
    return explicit as AuthMode;
  }
  if (env("API_KEY")) return "apikey";
  if (env("BEARER_TOKEN") || env("TOKEN_FILE")) return "token";
  if (env("OAUTH_CLIENT_ID")) return "oauth";
  return "basic";
}

/** A profile's OAuth grant (lower-cased; `password` when unset). */
export function oauthGrantFor(
  profile: string,
  pending: PendingAuth = {},
): string {
  return (
    profileAuthEnv("OAUTH_GRANT", profile, pending)?.trim().toLowerCase() ||
    "password"
  );
}

/** Presence-only view of a profile's credentials — never carries a secret. */
export interface CredentialStatus {
  /** True when every field the auth method needs is present. */
  configured: boolean;
  mode: AuthMode;
  /** The OAuth grant — only for `oauth`. */
  grant?: string;
  /** Missing fields, named by role (e.g. `password`, `api_key`). */
  missing: string[];
}

/**
 * Evaluate a profile against the requirements of its own auth method (D-2):
 *   basic   instance + user + password
 *   apikey  instance + API key
 *   token   instance + bearer token (SN_BEARER_TOKEN or SN_TOKEN_FILE)
 *   oauth   instance + client id + the grant's material — user + password
 *           (password), client secret (client_credentials), refresh token
 *           (refresh_token), private key + subject (jwt_bearer)
 *   none    instance only (certificate-only mutual TLS)
 */
export function credentialStatus(
  profile: string = activeProfile(),
): CredentialStatus {
  const c = getCredentials(profile);
  const env = (suffix: string) => profileAuthEnv(suffix, profile)?.trim();
  const mode = authModeFor(profile);
  const missing: string[] = [];
  if (!c.instance) missing.push("instance");
  let grant: string | undefined;
  switch (mode) {
    case "basic":
      if (!c.user) missing.push("user");
      if (!c.password) missing.push("password");
      break;
    case "apikey":
      if (!env("API_KEY")) missing.push("api_key");
      break;
    case "token":
      if (!env("BEARER_TOKEN") && !env("TOKEN_FILE"))
        missing.push("bearer_token");
      break;
    case "oauth":
      grant = oauthGrantFor(profile);
      if (!env("OAUTH_CLIENT_ID")) missing.push("oauth_client_id");
      if (grant === "password") {
        if (!c.user) missing.push("user");
        if (!c.password) missing.push("password");
      } else if (grant === "client_credentials") {
        if (!env("OAUTH_CLIENT_SECRET")) missing.push("oauth_client_secret");
      } else if (grant === "refresh_token") {
        if (!env("OAUTH_REFRESH_TOKEN")) missing.push("oauth_refresh_token");
      } else if (grant === "jwt_bearer") {
        // The inline key may legitimately carry surrounding whitespace.
        if (!env("OAUTH_JWT_KEY") && !env("OAUTH_JWT_KEY_FILE"))
          missing.push("oauth_jwt_key");
        if (!env("OAUTH_JWT_SUB") && !c.user) missing.push("oauth_jwt_sub");
      } else {
        missing.push("oauth_grant");
      }
      break;
    case "none":
      break;
  }
  return {
    configured: missing.length === 0,
    mode,
    ...(grant ? { grant } : {}),
    missing,
  };
}

/** True when the profile has everything its auth method needs (D-2). */
export function hasCredentials(profile: string = activeProfile()): boolean {
  return credentialStatus(profile).configured;
}

/**
 * Persist credentials to the .env file and update process.env so the new
 * values take effect immediately. Only the provided fields are changed;
 * any other keys already in .env are preserved. Non-default profiles write
 * their prefixed keys. `auth` carries D-2 auth settings (SN_AUTH, SN_API_KEY,
 * SN_OAUTH_*) written in the same atomic update.
 */
export function saveCredentials(
  partial: Partial<ServiceNowCredentials>,
  profile: string = activeProfile(),
  auth: Partial<Record<AuthSetting, string>> = {},
): ServiceNowCredentials {
  assertValidProfileName(profile);
  const keys = envKeysFor(profile);
  const updates: Record<string, string> = {};
  if (partial.instance !== undefined)
    updates[keys.instance] = partial.instance.trim();
  if (partial.user !== undefined) updates[keys.user] = partial.user.trim();
  if (partial.password !== undefined) updates[keys.password] = partial.password;
  // D-2: auth settings go through the same single atomic write.
  for (const [suffix, value] of Object.entries(auth)) {
    if (value !== undefined) updates[authEnvKey(suffix, profile)] = value;
  }

  updateEnvFile(updates);

  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
  }

  // Swap the store in one assignment — readers never observe a half-applied
  // credential change.
  profileStore().snapshots = new Map();
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
  profileStore().snapshots = new Map();
  return getCredentials(profile);
}

/**
 * Serialise a value for an .env line so that dotenv parses it back identically.
 *
 * dotenv (v16) strips one pair of surrounding quotes and, for double quotes
 * only, expands `\n`/`\r`; it never unescapes `\\`, `\'`, `\"` or `` \` ``.
 * Single- and backtick-quoted values are therefore fully literal — backslashes
 * included (L2-11: a Windows path such as `C:\Program Files\ca.pem` round-trips)
 * — as long as they do not contain their own quote character. Double quotes
 * are the last resort and only for values without a backslash (an escape
 * sequence could be expanded). Unquoted values are literal except that
 * leading/trailing whitespace is trimmed and `#` starts a comment. A newline
 * is never written: it would split the line on a rewrite.
 */
export function formatEnvValue(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      "Value cannot be stored safely in .env: it contains a newline.",
    );
  }
  const needsQuoting =
    value === "" || /^\s|\s$|#/.test(value) || /^['"`]/.test(value);
  if (!needsQuoting) {
    // Unquoted values are literal (backslashes, $, quotes in the middle all
    // survive), so no escaping is required here.
    return value;
  }
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes("`")) return `\`${value}\``;
  if (!value.includes('"') && !value.includes("\\")) return `"${value}"`;
  throw new Error(
    "Value cannot be stored safely in .env: it contains single quotes, backticks and either double quotes or a backslash.",
  );
}

/**
 * L2-11 — POSIX `0600` is a no-op on Windows: the env file inherits the ACLs of
 * its directory. The server never changes ACLs itself; it says so instead.
 */
export const ENV_FILE_ACL_WARNING =
  "On Windows the env file inherits its directory's ACLs (chmod 0600 has no effect) — restrict it to your account, e.g. icacls <file> /inheritance:r /grant:r %USERNAME%:F.";

/** The Windows ACL warning, or undefined on platforms with POSIX modes. */
export function envFileAclWarning(
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return platform === "win32" ? ENV_FILE_ACL_WARNING : undefined;
}

/**
 * Persist arbitrary env keys to the resolved env file (and process.env), used by
 * the OAuth login flow to store the obtained refresh token. Reuses the same
 * atomic, comment-preserving writer as credential saves.
 */
export function persistEnv(updates: Record<string, string>): void {
  updateEnvFile(updates);
  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
  }
}

/**
 * Update or append the given keys in the .env file while keeping the rest of
 * the file (comments, ordering, unrelated keys) intact.
 */
function updateEnvFile(updates: Record<string, string>): void {
  const path = getEnvPath();
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  // L2-11: keep the file's line ending — a CRLF file stays CRLF.
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
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
  // target directory exists first (e.g. ~/.config/servicenow-mcp-ai on first run).
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // H-5: pid + random suffix — two writers in one process (concurrent
  // set_credentials calls) must never share a temp file.
  const tmpPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  // 0600: the file holds a plaintext password, so keep it owner-only rather
  // than the default 0644. Set the mode on the temp file and re-assert it after
  // the rename so the result is owner-only regardless of the process umask.
  // chmod is best-effort — POSIX permissions are a no-op on Windows.
  try {
    writeFileSync(tmpPath, `${rewritten.join(eol)}${eol}`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmpPath, path);
  } catch (error) {
    // Never leave a plaintext-password temp file behind on a failed write.
    try {
      unlinkSync(tmpPath);
    } catch {
      // already gone (or never created)
    }
    throw error;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // platforms without POSIX file modes (Windows) — ignore
  }
}
