// Shared by the plugin hooks: read the server's local config the way the
// server resolves it — the process environment over the env file
// (SN_ENV_FILE, else $XDG_CONFIG_HOME/servicenow-mcp-ai/.env), parsed with
// Node's own parser, and per-profile settings with the server's scoping
// (src/core/settings-manifest.ts). No network, no dependency. Only the keys a
// caller names are read; nothing here prints anything.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

export const TRUTHY = new Set(["1", "true", "yes", "on"]);
export const PROFILE_RE = /^[a-z0-9_]+$/;
export const ENVIRONMENTS = new Set(["prod", "test", "dev"]);
export const PROD_WRITES_ACK = "I_UNDERSTAND";

/** The env file the server reads (SN_ENV_FILE, else the XDG path). */
export function envFilePath(env = process.env) {
  const explicit = env.SN_ENV_FILE?.trim();
  if (explicit) return explicit;
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "servicenow-mcp-ai", ".env");
}

/** The parsed env file, or `{}` when it is missing or unreadable. */
export function readEnvFile(path) {
  try {
    if (!path || !existsSync(path)) return {};
    return parseEnv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/** A trimmed non-empty string, else `undefined`. */
export function clean(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * A setting as the server resolves it for `profile`. `override`: a non-default
 * profile's SN_PROFILE_<NAME>_<X> wins, else SN_<X>. `isolated`: the default
 * profile reads only SN_<X>, any other profile only SN_PROFILE_<NAME>_<X>.
 */
export function setting(config, suffix, profile, scope) {
  const scoped =
    profile === "default"
      ? undefined
      : clean(config[`SN_PROFILE_${profile.toUpperCase()}_${suffix}`]);
  if (scope === "isolated") {
    return profile === "default" ? clean(config[`SN_${suffix}`]) : scoped;
  }
  return scoped ?? clean(config[`SN_${suffix}`]);
}

/** The profile names the config defines (`default` when SN_INSTANCE is set). */
export function profileNames(config) {
  const names = new Set();
  if (clean(config.SN_INSTANCE)) names.add("default");
  for (const key of Object.keys(config)) {
    const m = /^SN_PROFILE_([A-Z0-9_]+)_INSTANCE$/.exec(key);
    if (m && clean(config[key])) names.add(m[1].toLowerCase());
  }
  return [...names].sort();
}

/** The active profile SN_ACTIVE_PROFILE names (`default` when unset or invalid). */
export function activeProfile(config) {
  const requested = clean(config.SN_ACTIVE_PROFILE)?.toLowerCase();
  return requested && PROFILE_RE.test(requested) ? requested : "default";
}

/**
 * The write policy of `profile`, as the server derives it (settings.ts):
 * - `environment`: `prod` / `test` / `dev`, or `undefined` when not marked;
 * - `configured`: the configured write mode (`plan` unless `apply`);
 * - `held`: apply is configured but a prod profile lacks SN_PROD_WRITES;
 * - `mode`: the effective write mode (`plan` while held);
 * - `readonly`: SN_READONLY refuses every write;
 * - `confirm`: SN_DESTRUCTIVE_CONFIRM (`off` / `token` / `elicit`); a prod
 *   profile is always at least `elicit`.
 */
export function writePolicy(config, profile) {
  const environment = setting(
    config,
    "ENV",
    profile,
    "isolated",
  )?.toLowerCase();
  const marked = ENVIRONMENTS.has(environment) ? environment : undefined;
  const configured =
    setting(config, "WRITE_MODE", profile, "override")?.toLowerCase() ===
    "apply"
      ? "apply"
      : "plan";
  const held =
    configured === "apply" &&
    marked === "prod" &&
    setting(config, "PROD_WRITES", profile, "isolated") !== PROD_WRITES_ACK;
  const readonly = TRUTHY.has(
    setting(config, "READONLY", profile, "override")?.toLowerCase() ?? "",
  );
  const raw = clean(config.SN_DESTRUCTIVE_CONFIRM)?.toLowerCase();
  const confirm =
    marked === "prod"
      ? "elicit"
      : raw === "off" || raw === "elicit"
        ? raw
        : "token";
  return {
    environment: marked,
    configured,
    held,
    mode: held ? "plan" : configured,
    readonly,
    confirm,
  };
}
