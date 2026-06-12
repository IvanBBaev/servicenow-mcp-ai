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

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** The project-root .env (parent of build/ or src/), used in local development. */
const projectEnvPath = join(moduleDir, "..", ".env");

/** XDG user-config location, used for global/npx installs. */
function xdgEnvPath(): string {
  const base =
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "sincronia-mcp", ".env");
}

/**
 * Resolve which env file to read/write, in order of precedence:
 *   1. SN_ENV_FILE — explicit override.
 *   2. an existing XDG config file (~/.config/sincronia-mcp/.env).
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
}

/** Read the current credentials from the environment. */
export function getCredentials(): ServiceNowCredentials {
  return {
    instance: process.env.SN_INSTANCE?.trim() ?? "",
    user: process.env.SN_USER?.trim() ?? "",
    password: process.env.SN_PASSWORD ?? "",
  };
}

/** True when instance, user and password are all present. */
export function hasCredentials(): boolean {
  const c = getCredentials();
  return Boolean(c.instance && c.user && c.password);
}

/**
 * Persist credentials to the .env file and update process.env so the new
 * values take effect immediately. Only the provided fields are changed;
 * any other keys already in .env are preserved.
 */
export function saveCredentials(
  partial: Partial<ServiceNowCredentials>,
): ServiceNowCredentials {
  const updates: Record<string, string> = {};
  if (partial.instance !== undefined)
    updates.SN_INSTANCE = partial.instance.trim();
  if (partial.user !== undefined) updates.SN_USER = partial.user.trim();
  if (partial.password !== undefined) updates.SN_PASSWORD = partial.password;

  updateEnvFile(updates);

  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
  }

  return getCredentials();
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
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match && pending.has(match[1])) {
      const key = match[1];
      pending.delete(key);
      return `${key}=${formatEnvValue(updates[key])}`;
    }
    return line;
  });

  for (const key of pending) {
    rewritten.push(`${key}=${formatEnvValue(updates[key])}`);
  }

  // Write atomically: a temp file in the same directory plus rename avoids a
  // partially written file if the process is interrupted mid-write. Ensure the
  // target directory exists first (e.g. ~/.config/sincronia-mcp on first run).
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${rewritten.join("\n")}\n`, "utf8");
  renameSync(tmpPath, path);
}
