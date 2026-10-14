import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { RESERVED_PROFILE_NAMES, envFileChoice } from "./core/config.js";
import {
  isDeclaredSetting,
  isSecretFileSource,
  validateSettings,
} from "./core/settings-manifest.js";

/**
 * `servicenow-mcp-ai migrate` (owner, 2026-10-14): carry a 2.x env file over
 * to 3.x. Every key and value the user set stays as it was, except where 3.x
 * would refuse to start or read it differently:
 *
 * - the project-root `.env` (deprecated, B5) is copied to the XDG location;
 * - a profile with a name 3.x reserves (B13) is renamed `<name>_v2`, with
 *   every `SN_PROFILE_<NAME>_*` key and `SN_ACTIVE_PROFILE`;
 * - a value 3.x rejects at startup (B5) is commented out, so the default
 *   applies — what 2.x did with it;
 * - `SN_COMPAT=2` is appended (unless set, or `--v3-defaults`), so every
 *   setting left unset keeps its 2.x default.
 *
 * Planning is pure (no `process.env`, no writes): the file is read with
 * `util.parseEnv`, the parser 3.x itself loads env files with, and the
 * output keeps every comment and line it does not change.
 */

export type MigrationChangeKind =
  | "location"
  | "rename-profile"
  | "invalid-value"
  | "syntax"
  | "compat";

export interface MigrationChange {
  kind: MigrationChangeKind;
  /** The env key (or the profile name for `rename-profile`). */
  key: string;
  message: string;
}

export interface MigrationPlan {
  source: string;
  target: string;
  changes: MigrationChange[];
  /** The migrated file content. */
  text: string;
  /** The 2.x settings as read from the file. */
  env: Record<string, string>;
}

const LINE_RE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=.*)$/;
/** dotenv's `KEY: value` form (a colon, then whitespace). */
const COLON_LINE_RE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*):\s+(.*)$/;
const COMPAT_LINE =
  "# Added by servicenow-mcp-ai migrate: keep the 2.x defaults for the\n# settings left unset (remove it to take the 3.x defaults).\nSN_COMPAT=2";

/** The non-reserved name a reserved profile `name` is renamed to. */
export function migratedProfileName(name: string): string {
  return `${name}_v2`;
}

/**
 * The profile-scoped part of `key` when it belongs to profile `name`, i.e.
 * `SN_PROFILE_<NAME>_<X>` where `SN_<X>` (or its `_FILE` form) is a declared
 * setting; undefined otherwise (so `docs` never claims a `docs_eu` key).
 */
function profileSuffix(key: string, name: string): string | undefined {
  const prefix = `SN_PROFILE_${name.toUpperCase()}_`;
  if (!key.startsWith(prefix)) return undefined;
  const rest = key.slice(prefix.length);
  const base = `SN_${rest}`;
  if (isDeclaredSetting(base)) return rest;
  if (base.endsWith("_FILE") && isSecretFileSource(base)) return rest;
  return undefined;
}

/** What `planEnv` decided for one set of 2.x settings. */
export interface EnvPlan {
  changes: MigrationChange[];
  /** The 3.x key for `key` (renamed out of a reserved profile), or `key`. */
  keyFor(key: string): string;
  /** The new SN_ACTIVE_PROFILE value, when the active profile was renamed. */
  activeTo: string | undefined;
  /** 3.x keys whose value 3.x refuses at startup. */
  invalid: ReadonlySet<string>;
  /** Whether SN_COMPAT=2 is to be added. */
  compat: boolean;
}

/**
 * Plan the 2.x → 3.x changes to one set of settings (an env file or an MCP
 * client's `env` block): reserved profiles (B13), values 3.x refuses (B5) and
 * SN_COMPAT=2. `removal` names what happens to an invalid value.
 */
export function planEnv(
  env: Record<string, string>,
  options: { v3Defaults?: boolean; removal: string },
): EnvPlan {
  const changes: MigrationChange[] = [];
  const renames = new Map<string, string>();
  for (const name of RESERVED_PROFILE_NAMES) {
    if (Object.keys(env).some((key) => profileSuffix(key, name))) {
      const to = migratedProfileName(name);
      renames.set(name, to);
      changes.push({
        kind: "rename-profile",
        key: name,
        message: `Profile "${name}" is reserved in 3.x (B13): renamed "${to}" (its SN_PROFILE_${name.toUpperCase()}_* keys${env.SN_ACTIVE_PROFILE?.trim().toLowerCase() === name ? " and SN_ACTIVE_PROFILE" : ""}).`,
      });
    }
  }
  const keyFor = (key: string): string => {
    for (const [from, to] of renames) {
      const rest = profileSuffix(key, from);
      if (rest) return `SN_PROFILE_${to.toUpperCase()}_${rest}`;
    }
    return key;
  };
  const migratedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    migratedEnv[keyFor(key)] = value;
  }
  const active = env.SN_ACTIVE_PROFILE?.trim().toLowerCase();
  const activeTo = active ? renames.get(active) : undefined;
  if (activeTo) migratedEnv.SN_ACTIVE_PROFILE = activeTo;

  // B5: values 3.x would refuse at startup (under the settings' own
  // SN_STRICT_SETTINGS). 2.x ignored them and used the default.
  const invalid = new Set<string>();
  for (const issue of validateSettings(migratedEnv).issues) {
    if (issue.level !== "error") continue;
    invalid.add(issue.key);
    changes.push({
      kind: "invalid-value",
      key: issue.key,
      message: `${issue.message} — ${options.removal}, so the default applies (as in 2.x).`,
    });
  }

  const compat = !options.v3Defaults && env.SN_COMPAT === undefined;
  if (compat) {
    changes.push({
      kind: "compat",
      key: "SN_COMPAT",
      message:
        "SN_COMPAT=2 is added: every setting left unset keeps its 2.x default (protected tables writable, no plan token, unmapped batch rows allowed, old tool names listed, the core packages). Use --v3-defaults to leave it out.",
    });
  }
  return { changes, keyFor, activeTo, invalid, compat };
}

/**
 * 2.x read env files with dotenv, which also took `KEY: value`; 3.x reads
 * them with `util.parseEnv`, which skips such a line. Rewrite it as
 * `KEY=value` (pure).
 */
function normaliseColonLines(text: string): {
  text: string;
  keys: string[];
} {
  const keys: string[] = [];
  const out = text.split(/\r?\n/).map((line) => {
    const match = COLON_LINE_RE.exec(line);
    if (!match) return line;
    const [, lead = "", key = "", value = ""] = match;
    keys.push(key);
    return `${lead}${key}=${value}`;
  });
  return { text: out.join("\n"), keys };
}

/** Plan the migration of env file `text` (pure). */
export function planMigration(input: {
  text: string;
  source: string;
  target: string;
  /** Do not append `SN_COMPAT=2`. */
  v3Defaults?: boolean;
}): MigrationPlan {
  const { source, target } = input;
  const changes: MigrationChange[] = [];
  if (resolve(source) !== resolve(target)) {
    changes.push({
      kind: "location",
      key: "SN_ENV_FILE",
      message: `${source} is copied to ${target} (the project-root .env is deprecated, B5); the original stays as it is.`,
    });
  }
  const colon = normaliseColonLines(input.text);
  for (const key of colon.keys) {
    changes.push({
      kind: "syntax",
      key,
      message: `${key}: the 2.x "KEY: value" form is rewritten "KEY=value" (3.x skips the colon form).`,
    });
  }
  const env = parseEnv(colon.text) as Record<string, string>;
  const plan = planEnv(env, {
    v3Defaults: input.v3Defaults,
    removal: "commented out",
  });
  changes.push(...plan.changes);

  const lines = colon.text.split(/\r?\n/).map((line) => {
    const match = LINE_RE.exec(line);
    if (!match) return line;
    const [, lead = "", key = "", rest = ""] = match;
    const to = plan.keyFor(key);
    let out = `${lead}${to}${rest}`;
    if (to === "SN_ACTIVE_PROFILE" && plan.activeTo) {
      out = `${lead}${to}=${plan.activeTo}`;
    }
    if (plan.invalid.has(to)) {
      return `# servicenow-mcp-ai migrate: invalid in 3.x, the default applies.\n# ${out}`;
    }
    return out;
  });

  if (plan.compat) {
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push("", COMPAT_LINE, "");
  }
  return { source, target, changes, text: lines.join("\n"), env };
}

/**
 * Where `migrate` reads and writes: `from` (an explicit 2.x file) or the env
 * file 3.x resolves; a project-root `.env` (or `from`) moves to the file 3.x
 * would use when no project `.env` existed. Undefined when there is nothing
 * to migrate.
 */
export function migrationPaths(
  from?: string,
): { source: string; target: string } | undefined {
  const choice = envFileChoice();
  // The path 3.x settles on without the deprecated project-root fallback.
  const settled = choice.source === "project" ? envFileChoice("") : choice;
  if (from) return { source: resolve(from), target: settled.path };
  if (!existsSync(choice.path)) return undefined;
  return { source: choice.path, target: settled.path };
}

/**
 * Write a plan: a target that already exists is first backed up next to
 * itself as `<file>.v2.bak` (kept if one is already there — it holds the
 * 2.x original). Both files are 0600. Returns the backup path, if any.
 */
export function writeMigration(plan: MigrationPlan): string | undefined {
  const { source, target } = plan;
  let backup: string | undefined;
  if (existsSync(target)) {
    backup = `${target}.v2.bak`;
    if (!existsSync(backup)) {
      copyFileSync(target, backup);
      chmodSync(backup, 0o600);
    }
  } else if (resolve(source) !== resolve(target)) {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  }
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, plan.text, { mode: 0o600 });
  renameSync(tmp, target);
  chmodSync(target, 0o600);
  return backup;
}

/** Read `source` (throws a readable error when it is missing). */
export function readEnvFile(source: string): string {
  if (!existsSync(source)) throw new Error(`No env file at ${source}.`);
  return readFileSync(source, "utf8");
}

/**
 * The docs directory 3.x will use (getDocsDir): SN_DOCS_DIR from the process
 * environment, then from the migrated env file, else `docs/instance`; a
 * relative value resolves against `cwd`.
 */
export function migrationDocsDir(
  env: Record<string, string | undefined>,
  fileEnv: Record<string, string>,
  cwd: string,
): { dir: string; cwdRelative: boolean } {
  const raw = env.SN_DOCS_DIR?.trim() || fileEnv.SN_DOCS_DIR?.trim();
  const value = raw || "docs/instance";
  return { dir: resolve(cwd, value), cwdRelative: !isAbsolute(value) };
}

/** One renamed profile's docs and journal folder. */
export interface FolderMove {
  profile: string;
  from: string;
  to: string;
  /** `move`: to be renamed; `taken`: the target exists, left as is. */
  state: "move" | "taken";
}

/**
 * The docs (and write journal) folders of the profiles renamed out of the
 * reserved names (B13): `<docsDir>/<name>` → `<docsDir>/<name>_v2`. A profile
 * without a folder is skipped; one whose target already exists is `taken`.
 */
export function planFolderMoves(
  docsDir: string,
  profiles: Iterable<string>,
): FolderMove[] {
  const moves: FolderMove[] = [];
  for (const profile of new Set(profiles)) {
    const from = join(docsDir, profile);
    if (!existsSync(from)) continue;
    const to = join(docsDir, migratedProfileName(profile));
    moves.push({ profile, from, to, state: existsSync(to) ? "taken" : "move" });
  }
  return moves;
}

/** Rename one planned folder; never overwrites an existing target. */
export function moveFolder(move: FolderMove): void {
  if (move.state !== "move" || existsSync(move.to)) {
    throw new Error(`${move.to} already exists; ${move.from} is left as is.`);
  }
  renameSync(move.from, move.to);
}
