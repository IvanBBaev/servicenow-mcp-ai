/**
 * E-4 — the declarative settings manifest.
 *
 * Every environment variable the server reads is declared here once: its
 * type (a zod schema over the raw string), default, section, the release it
 * appeared in, whether it is a secret, whether a `<KEY>_FILE` source may
 * supply it (D-5) and how a named profile scopes it. The getters in
 * settings.ts, policy.ts, config.ts, auth.ts, logging.ts and friends read
 * through {@link readSetting} / {@link rawSetting}, so parsing and the
 * "invalid value" behaviour live in one place, and `npm run docs:env`
 * renders the README table, `.env.example` and the `server.json` env block
 * from the same data (D-3).
 *
 * Values are read live from `process.env` on every call — never cached — so
 * `servicenow_use_instance`, `servicenow_set_credentials` and tests that
 * mutate the environment keep working.
 *
 * Invalid values: a value the schema rejects is reported once per key and
 * value (a logged warning) and the setting keeps its default — the pre-E-4
 * behaviour, now visible. With `SN_STRICT_SETTINGS=1` the startup validation
 * ({@link applySettingsAtStartup}) turns every invalid value into a startup
 * error instead. Secret values are never echoed in a message.
 *
 * Layout: settings-model.ts holds the spec types and kind helpers; the rows
 * are in settings-data-server.ts (connection … packages) and
 * settings-data-runtime.ts (policy … external). This module assembles them,
 * derives the `<KEY>_FILE` rows and owns reading.
 */

import { currentRequestProfile, currentSession } from "./request-context.js";
import { RUNTIME_ROWS } from "./settings-data-runtime.js";
import { SERVER_ROWS } from "./settings-data-server.js";
import {
  NEXT,
  filePath,
  type SettingSectionId,
  type SettingSpec,
} from "./settings-model.js";

export { PROFILE_RE, UNRELEASED } from "./settings-model.js";
export type {
  ProfileScope,
  SettingKind,
  SettingSectionId,
  SettingSpec,
} from "./settings-model.js";

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export interface SettingSection {
  id: SettingSectionId;
  title: string;
  /** Plain-text introduction (rendered above the section's settings). */
  blurb: string;
}

export const SETTING_SECTIONS: readonly SettingSection[] = [
  {
    id: "connection",
    title: "Connection and authentication",
    blurb:
      "The instance and its credentials. Only SN_INSTANCE is always required; the auth method is auto-detected from the keys present (API key -> bearer token -> OAuth -> Basic) unless SN_AUTH names it.",
  },
  {
    id: "secret-files",
    title: "Secrets from files",
    blurb:
      "Container secrets (D-5): <KEY>_FILE=/path loads <KEY> from that file at startup (one trailing newline is trimmed). Setting both <KEY> and <KEY>_FILE is a startup error; so is an unreadable or empty file. A value loaded this way is never written back to the env file. Per profile: SN_PROFILE_<NAME>_<KEY>_FILE for the ServiceNow secrets.",
  },
  {
    id: "profiles",
    title: "Profiles and the env file",
    blurb:
      "The bare SN_INSTANCE / SN_USER / SN_PASSWORD keys are the 'default' profile. More instances live under SN_PROFILE_<NAME>_* keys; switch with SN_ACTIVE_PROFILE or the servicenow_use_instance tool.",
  },
  {
    id: "network",
    title: "Network, TLS and resilience",
    blurb:
      "Timeouts, retries, the host allow-list, the outbound proxy, mutual TLS and the per-host queue and circuit breaker. They govern every REST client of the server. The proxy and mutual TLS need the optional undici package.",
  },
  {
    id: "packages",
    title: "Tool packages",
    blurb:
      "Which tools are registered. The admin tools (set_credentials, get_status, use_instance) are always on.",
  },
  {
    id: "policy",
    title: "Access policy and write safety",
    blurb:
      "Least-privilege table policy, plan-and-apply writes, destructive-write confirmation, per-session caps, prod profiles, update-set binding and the upload / email / SDK-managed-scope guards.",
  },
  {
    id: "results",
    title: "Results, redaction and exports",
    blurb:
      "Result size budgets, output shaping, redaction of record values, the write journal and CSV export safety.",
  },
  {
    id: "caching",
    title: "Caching",
    blurb: "The schema reads cache and the capability / plugin-API probes.",
  },
  {
    id: "docs",
    title: "Docs store and diagrams",
    blurb:
      "The local Markdown docs store (also home of the write journal — keep it out of version control) and the generated Mermaid diagrams.",
  },
  {
    id: "transport",
    title: "HTTP transport",
    blurb:
      "stdio (default, one local client) or Streamable HTTP for remote and agent clients. Securing the HTTP endpoint (TLS, auth, network) is the operator's job.",
  },
  {
    id: "logging",
    title: "Logging",
    blurb:
      "The stderr log, the optional log file and the log lines mirrored to the MCP client.",
  },
  {
    id: "validation",
    title: "Settings validation",
    blurb:
      "Every setting is validated at startup. An invalid value is logged as a warning and the setting keeps its default; strict mode makes it a startup error instead.",
  },
  {
    id: "external",
    title: "Standard variables",
    blurb:
      "Conventional variables outside the SN_ namespace that the server also honours.",
  },
];

// --- the manifest ------------------------------------------------------------

const BASE_SETTINGS: readonly SettingSpec[] = [...SERVER_ROWS, ...RUNTIME_ROWS];

/** The `<KEY>_FILE` entries derived from every `fileSource` setting (D-5). */
function fileSourceSpecs(specs: readonly SettingSpec[]): SettingSpec[] {
  return specs
    .filter((s) => s.fileSource)
    .map((s) =>
      filePath({
        key: `${s.key}_FILE`,
        section: "secret-files",
        since: NEXT,
        example: `/run/secrets/${s.key.toLowerCase()}`,
        description: `D-5: read \`${s.key}\` from this file (Docker / Kubernetes secrets).${s.fileNote ?? ""}`,
      }),
    );
}

/** Every declared setting, in documentation order. */
export const SETTINGS: readonly SettingSpec[] = (() => {
  const all = [...BASE_SETTINGS];
  const insertAt = all.findIndex((s) => s.section === "profiles");
  all.splice(insertAt, 0, ...fileSourceSpecs(BASE_SETTINGS));
  return all;
})();

const BY_KEY = new Map<string, SettingSpec>(
  SETTINGS.filter((s) => !s.pattern).map((s) => [s.key, s]),
);

/** The spec for `key`; throws for an undeclared key (a programming error). */
export function settingSpec(key: string): SettingSpec {
  const spec = BY_KEY.get(key);
  if (!spec) throw new Error(`Undeclared setting ${key}`);
  return spec;
}

/** True when `key` is declared in the manifest. */
export function isDeclaredSetting(key: string): boolean {
  return BY_KEY.has(key);
}

// ---------------------------------------------------------------------------
// Profile scoping
// ---------------------------------------------------------------------------

/**
 * `SN_<KEY>` → `SN_PROFILE_<NAME>_<KEY>`; the default profile keeps the
 * global key.
 */
export function profileEnvKey(key: string, profile: string): string {
  return profile === "default"
    ? key
    : `SN_PROFILE_${profile.toUpperCase()}_${key.slice("SN_".length)}`;
}

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface ReadOptions {
  env?: Env;
  /** Profile for a profile-scoped setting (default: the active profile). */
  profile?: string;
}

interface Located {
  /** The env key the raw value came from (for messages). */
  source: string;
  raw: string | undefined;
}

function locate(spec: SettingSpec, opts: ReadOptions): Located {
  const env = opts.env ?? process.env;
  const global = (): Located => {
    if (env[spec.key] !== undefined || !spec.aliases) {
      return { source: spec.key, raw: env[spec.key] };
    }
    for (const alias of spec.aliases) {
      if (env[alias] !== undefined) return { source: alias, raw: env[alias] };
    }
    return { source: spec.key, raw: undefined };
  };
  if (!spec.profile) return global();
  const profile = opts.profile ?? activeProfile();
  if (profile === "default") return global();
  const scopedKey = profileEnvKey(spec.key, profile);
  const scoped = env[scopedKey];
  switch (spec.profile) {
    case "override":
      return scoped !== undefined
        ? { source: scopedKey, raw: scoped }
        : global();
    case "fallback":
      return scoped !== undefined && scoped.trim() !== ""
        ? { source: scopedKey, raw: scoped }
        : global();
    case "isolated":
      return { source: scopedKey, raw: scoped };
  }
}

/**
 * The raw string of a setting, profile scope applied — undefined when unset.
 * Unlike {@link readSetting} it neither trims nor validates: secrets and
 * values with meaningful whitespace are returned verbatim.
 */
export function rawSetting(
  key: string,
  opts: ReadOptions = {},
): string | undefined {
  return locate(settingSpec(key), opts).raw;
}

/** The env key a setting resolves from for `profile` (for messages). */
export function settingSource(key: string, opts: ReadOptions = {}): string {
  return locate(settingSpec(key), opts).source;
}

// ---------------------------------------------------------------------------
// Parsing and warnings
// ---------------------------------------------------------------------------

export interface ParseResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** Parse a raw value against a spec; an empty value counts as unset. */
export function parseSetting(
  spec: SettingSpec,
  raw: string | undefined,
): ParseResult {
  if (raw === undefined || raw.trim() === "") return { ok: true };
  const parsed = spec.schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: parsed.error.issues.map((i) => i.message).join("; "),
  };
}

/** Human text of a setting's default. */
export function defaultText(spec: SettingSpec): string {
  if (spec.defaultText !== undefined) return spec.defaultText;
  if (spec.default === undefined) return "—";
  if (Array.isArray(spec.default)) return `\`${spec.default.join(",")}\``;
  const value = spec.default;
  const text =
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
      ? String(value)
      : JSON.stringify(value);
  return `\`${text}\``;
}

function shownValue(spec: SettingSpec, raw: string): string {
  return spec.secret ? "<redacted>" : JSON.stringify(raw);
}

/** A one-line message for an invalid value (a secret's value is never shown). */
export function invalidMessage(
  spec: SettingSpec,
  source: string,
  raw: string,
  error: string,
): string {
  return `Invalid ${source}=${shownValue(spec, raw)}: ${error}; using the default (${defaultText(spec).replaceAll("`", "")})`;
}

const warned = new Set<string>();

/**
 * Where an invalid-value warning goes. logging.ts plugs the logger in when it
 * loads (it reads SN_LOG_LEVEL through this module, so importing it here
 * would close an import cycle); until then a bare stderr line is written.
 */
let settingWarn: (message: string) => void = (message) =>
  console.error(message);

/** Route invalid-value warnings (logging.ts sets the logger here). */
export function setSettingWarn(fn: (message: string) => void): void {
  settingWarn = fn;
}

/** Forget which invalid values were already reported (tests). */
export function resetSettingWarnings(): void {
  warned.clear();
}

function warnOnce(id: string, message: string): void {
  if (warned.has(id)) return;
  // Mark first: the logger reads SN_LOG_LEVEL through this module.
  warned.add(id);
  settingWarn(message);
}

/**
 * The profile for the current call: an explicit per-request profile (MI-3
 * AsyncLocalStorage context) wins, then the HTTP session's own selection
 * (H-7 — `use_instance` in HTTP mode), then SN_ACTIVE_PROFILE. Lives here,
 * next to the reader that scopes settings by it; profile.ts re-exports it.
 */
export function activeProfile(): string {
  const fromRequest = currentRequestProfile();
  if (fromRequest) return fromRequest;
  const fromSession = currentSession()?.profile;
  if (fromSession) return fromSession;
  // E-4: parsed (trimmed, lowercased, PROFILE_RE) by the manifest; an
  // invalid name warns once and falls back to the default profile.
  return readSetting<string>("SN_ACTIVE_PROFILE") ?? "default";
}

/**
 * A setting's parsed value, profile scope applied. Unset → the manifest
 * default (undefined for computed defaults, which the caller supplies).
 * Invalid → a one-time warning and the default.
 */
export function readSetting<T = unknown>(
  key: string,
  opts: ReadOptions = {},
): T | undefined {
  const spec = settingSpec(key);
  const { source, raw } = locate(spec, opts);
  const parsed = parseSetting(spec, raw);
  if (parsed.ok) {
    return (parsed.value !== undefined ? parsed.value : spec.default) as
      | T
      | undefined;
  }
  warnOnce(
    `${source}\u0000${raw}`,
    invalidMessage(spec, source, raw ?? "", parsed.error ?? "invalid"),
  );
  return spec.default as T | undefined;
}

/** A numeric setting (the caller supplies a computed default). */
export function readInt(key: string, opts?: ReadOptions): number | undefined {
  return readSetting<number>(key, opts);
}

/** A boolean setting. */
export function readBool(key: string, opts?: ReadOptions): boolean {
  return readSetting<boolean>(key, opts) === true;
}

/** An enum setting. */
export function readEnum<T extends string>(
  key: string,
  opts?: ReadOptions,
): T | undefined {
  return readSetting<T>(key, opts);
}

/** A string setting, trimmed; empty → undefined. */
export function readString(
  key: string,
  opts?: ReadOptions,
): string | undefined {
  const raw = rawSetting(key, opts)?.trim();
  return raw ? raw : undefined;
}

// ---------------------------------------------------------------------------
// Secrets and D-5 file sources
// ---------------------------------------------------------------------------

const FILE_SOURCE_SPECS = SETTINGS.filter((s) => s.fileSource);

/**
 * True when `name` is a D-5 `<KEY>_FILE` secret source: `<KEY>` is a
 * `fileSource` setting, or `SN_PROFILE_<NAME>_<X>_FILE` for a profile-scoped
 * one. SN_TOKEN_FILE, SN_OAUTH_JWT_KEY_FILE and the SN_TLS_*_FILE paths keep
 * their own meaning and are not sources.
 */
export function isSecretFileSource(name: string): boolean {
  if (!name.endsWith("_FILE")) return false;
  const base = name.slice(0, -"_FILE".length);
  for (const spec of FILE_SOURCE_SPECS) {
    if (base === spec.key) return true;
    if (!spec.profile) continue;
    const suffix = `_${spec.key.slice("SN_".length)}`;
    if (base.startsWith("SN_PROFILE_") && base.endsWith(suffix)) {
      const name = base.slice("SN_PROFILE_".length, -suffix.length);
      if (/^[A-Z0-9_]+$/.test(name)) return true;
    }
  }
  return false;
}

/** The base keys a `<KEY>_FILE` source may supply (global forms). */
export function fileSourceKeys(): string[] {
  return FILE_SOURCE_SPECS.map((s) => s.key);
}

/** Resolve an env key (possibly profile-scoped) to its declared spec. */
function specForEnvKey(name: string): SettingSpec | undefined {
  const direct = BY_KEY.get(name);
  if (direct) return direct;
  if (name.endsWith("_FILE") && isSecretFileSource(name)) {
    return BY_KEY.get(`${name.slice(0, -"_FILE".length)}`) ?? undefined;
  }
  if (name.startsWith("SN_PROFILE_")) {
    for (const spec of SETTINGS) {
      if (!spec.profile) continue;
      const suffix = `_${spec.key.slice("SN_".length)}`;
      if (
        name.endsWith(suffix) &&
        name.length > "SN_PROFILE_".length + suffix.length
      ) {
        return spec;
      }
    }
  }
  return undefined;
}

/** True when the manifest declares `name` (or its profile form) a secret. */
export function isSecretKey(name: string): boolean {
  const spec = specForEnvKey(name);
  if (!spec) return false;
  // A `<KEY>_FILE` source holds a path, not the secret itself.
  return spec.secret === true && !name.endsWith("_FILE");
}

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

export interface SettingIssue {
  key: string;
  level: "error" | "warning";
  message: string;
}

export interface ValidatedSettings {
  /** Resolved global values (defaults applied; secrets shown as "<set>"). */
  settings: Record<string, unknown>;
  issues: SettingIssue[];
  strict: boolean;
}

/** Profile-scoped keys: every SN_PROFILE_<NAME>_<X> in `env` with a spec. */
function profileScopedKeys(env: Env): Array<[string, SettingSpec]> {
  const out: Array<[string, SettingSpec]> = [];
  for (const name of Object.keys(env)) {
    if (!name.startsWith("SN_PROFILE_") || name.endsWith("_FILE")) continue;
    const spec = specForEnvKey(name);
    if (spec) out.push([name, spec]);
  }
  return out;
}

/**
 * Validate every declared setting in `env` (global and profile-scoped
 * forms) and report unknown `SN_*` keys. Pure: no logging, no throwing.
 */
export function validateSettings(env: Env = process.env): ValidatedSettings {
  const issues: SettingIssue[] = [];
  const settings: Record<string, unknown> = {};
  const check = (
    spec: SettingSpec,
    source: string,
    raw: string | undefined,
  ) => {
    const parsed = parseSetting(spec, raw);
    if (!parsed.ok) {
      issues.push({
        key: source,
        level: "error",
        message: invalidMessage(
          spec,
          source,
          raw ?? "",
          parsed.error ?? "invalid",
        ),
      });
    }
    return parsed;
  };
  for (const spec of SETTINGS) {
    if (spec.pattern) continue;
    const { source, raw } = locate(spec, { env, profile: "default" });
    const parsed = check(spec, source, raw);
    const value =
      parsed.ok && parsed.value !== undefined ? parsed.value : spec.default;
    if (value !== undefined) {
      settings[spec.key] =
        spec.secret && raw !== undefined && raw.trim() !== "" ? "<set>" : value;
    }
  }
  for (const [name, spec] of profileScopedKeys(env)) {
    check(spec, name, env[name]);
  }
  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith("SN_") || specForEnvKey(name)) continue;
    issues.push({
      key: name,
      level: "warning",
      message: `Unknown setting ${name} — not read by this server (a typo?)`,
    });
  }
  const strict =
    parseSetting(settingSpec("SN_STRICT_SETTINGS"), env.SN_STRICT_SETTINGS)
      .value === true;
  return { settings, issues, strict };
}

let startup: ValidatedSettings | undefined;

/** The result of the last {@link applySettingsAtStartup} (doctor). */
export function startupSettings(): ValidatedSettings | undefined {
  return startup;
}

/**
 * E-4 — validate the environment once at startup (after the env file and
 * the D-5 secret files are loaded). Every issue is logged as a warning; with
 * SN_STRICT_SETTINGS on, invalid values throw one error naming them all.
 * Runtime reads keep going through the live accessors above, so a later
 * `use_instance` / `set_credentials` change is honoured.
 */
export function applySettingsAtStartup(
  env: Env = process.env,
): ValidatedSettings {
  const result = validateSettings(env);
  startup = result;
  const errors = result.issues.filter((i) => i.level === "error");
  if (result.strict && errors.length > 0) {
    throw new Error(
      `Invalid settings (SN_STRICT_SETTINGS is on): ${errors.map((e) => e.message).join(" | ")}`,
    );
  }
  for (const issue of result.issues) {
    const spec = BY_KEY.get(issue.key);
    const raw = env[issue.key];
    warnOnce(
      issue.level === "error" && spec
        ? `${issue.key}\u0000${raw}`
        : `unknown\u0000${issue.key}`,
      issue.message,
    );
  }
  return result;
}
