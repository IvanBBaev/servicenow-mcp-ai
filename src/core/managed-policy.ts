/**
 * N-108 (GV-I1) — the managed policy layer.
 *
 * Every other control is read from the process environment or the user's own
 * env file, so the person (or a prompt-injected agent) the policy restrains
 * can loosen it. A managed policy file is owned by an administrator and sets
 * floors the user can only tighten:
 *
 * - the OS path ({@link osPolicyPath}: `/etc/servicenow-mcp-ai/policy.json`,
 *   `/Library/Application Support/servicenow-mcp-ai/policy.json`,
 *   `%ProgramData%\servicenow-mcp-ai\policy.json`) is always read when it
 *   exists — no setting turns it off;
 * - `SN_MANAGED_POLICY_FILE` adds a second file for containers, where the
 *   image owner sets the environment.
 *
 * The file is JSON: `settings` (a lockable key → its floor), `environments`
 * (an instance-host pattern → `prod` | `test` | `dev`, which wins over
 * `SN_ENV`, so "prod" is decided by the administrator per host) and
 * `disableWrites` (shorthand for a `SN_READONLY` floor). How each key merges
 * with the user's value is fixed in {@link RULES}. A file that exists but
 * cannot be read or parsed, or names a key that cannot be locked, fails
 * closed: the server does not start, and a later read of a locked setting
 * throws `MANAGED_POLICY_INVALID`. The files are read once per process; a
 * change takes effect on restart.
 *
 * The layer plugs into the settings reader (settings-manifest.ts) through
 * {@link setManagedPolicyHook}, so every getter sees the merged value. This
 * module registers itself when it is loaded; settings.ts imports it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ServiceNowError } from "./errors.js";
import { resolveHost } from "./host.js";
import {
  currentRuntime,
  defineRuntimePart,
  type RuntimePart,
} from "./runtime.js";
import {
  parseSetting,
  rawSetting,
  setManagedPolicyHook,
  settingSpec,
  type ReadOptions,
  type SettingSpec,
} from "./settings-manifest.js";

/** How a managed value merges with the user's value of the same key. */
type Rule =
  /** `true` locks the flag on; `false` locks nothing. */
  | { kind: "flag" }
  /** The managed entries are always in the list; the user may add more. */
  | { kind: "union" }
  /** The stricter of the two values; `order` runs from loosest to strictest. */
  | { kind: "order"; order: readonly string[] }
  /** The lower of two caps; `0` (no cap) never wins over a managed cap. */
  | { kind: "cap" }
  /** The managed value replaces the user's (allowlists). */
  | { kind: "exact" };

/** The keys a managed policy may lock, and how. Anything else is refused. */
export const RULES: Readonly<Record<string, Rule>> = {
  SN_READONLY: { kind: "flag" },
  SN_REDACT_PII: { kind: "flag" },
  SN_JOURNAL_REQUIRED: { kind: "flag" },
  SN_TABLES_DENY: { kind: "union" },
  SN_PACKAGES_DENY: { kind: "union" },
  SN_PACKAGES_READONLY: { kind: "union" },
  SN_REDACT_FIELDS: { kind: "union" },
  SN_WRITE_MODE: { kind: "order", order: ["apply", "plan"] },
  SN_DESTRUCTIVE_CONFIRM: {
    kind: "order",
    order: ["off", "token", "elicit"],
  },
  SN_PROTECTED_TABLES_WRITE: {
    kind: "order",
    order: ["allow", "confirm", "deny"],
  },
  SN_BATCH_UNMAPPED: { kind: "order", order: ["allow", "deny"] },
  SN_MAX_WRITES_PER_SESSION: { kind: "cap" },
  SN_MAX_DELETES_PER_SESSION: { kind: "cap" },
  SN_MAX_BATCH_WRITES: { kind: "cap" },
  SN_BATCH_MAX_REQUESTS: { kind: "cap" },
  SN_TABLES_ALLOW: { kind: "exact" },
  SN_ALLOWED_HOSTS: { kind: "exact" },
  SN_IMPORT_SET_TABLES: { kind: "exact" },
};

const ENV_KEY = "SN_ENV";
const PRODUCT_DIR = "servicenow-mcp-ai";
const FILE_NAME = "policy.json";

type Environment = "prod" | "test" | "dev";

const settingValue = z.union([
  z.string(),
  z.boolean(),
  z.number(),
  z.array(z.string()),
]);

const fileSchema = z.strictObject({
  $schema: z.string().optional(),
  settings: z.record(z.string(), settingValue).optional(),
  environments: z
    .record(z.string().min(1), z.enum(["prod", "test", "dev"]))
    .optional(),
  disableWrites: z.boolean().optional(),
});

/** One loaded managed policy file. */
export interface ManagedPolicy {
  /** The file it came from. */
  source: string;
  /** Lockable key → the managed raw value (lists joined with commas). */
  settings: Map<string, string>;
  /** Host pattern → environment, in file order. */
  environments: Array<[string, Environment]>;
}

/** The administrator-owned path for this platform. */
export function osPolicyPath(
  platform: NodeJS.Platform = process.platform,
  programData: string | undefined = process.env.ProgramData,
): string {
  switch (platform) {
    case "win32":
      return path.win32.join(
        programData ?? "C:\\ProgramData",
        PRODUCT_DIR,
        FILE_NAME,
      );
    case "darwin":
      return path.posix.join(
        "/Library/Application Support",
        PRODUCT_DIR,
        FILE_NAME,
      );
    default:
      return path.posix.join("/etc", PRODUCT_DIR, FILE_NAME);
  }
}

function invalid(source: string, why: string): ServiceNowError {
  return new ServiceNowError(
    `Managed policy ${source} is invalid: ${why}`,
    undefined,
    undefined,
    {
      code: "MANAGED_POLICY_INVALID",
      hint: "Ask the administrator who owns the file to fix it; the server refuses to run under a policy it cannot read.",
    },
  );
}

function asRaw(value: z.infer<typeof settingValue>): string {
  return Array.isArray(value) ? value.join(",") : String(value);
}

/** Parse one policy file's text; throws MANAGED_POLICY_INVALID. */
export function parseManagedPolicy(
  text: string,
  source: string,
): ManagedPolicy {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw invalid(source, (error as Error).message);
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    throw invalid(
      source,
      parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    );
  }
  const settings = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed.data.settings ?? {})) {
    if (!(key in RULES)) {
      throw invalid(
        source,
        `${key} cannot be locked (lockable: ${Object.keys(RULES).join(", ")})`,
      );
    }
    const raw = asRaw(value);
    const check = parseSetting(settingSpec(key), raw);
    if (!check.ok) throw invalid(source, `${key}: ${check.error}`);
    settings.set(key, raw);
  }
  if (parsed.data.disableWrites === true) settings.set("SN_READONLY", "true");
  return {
    source,
    settings,
    environments: Object.entries(parsed.data.environments ?? {}).map(
      ([pattern, env]) => [pattern.toLowerCase(), env],
    ),
  };
}

function loadFile(file: string): ManagedPolicy | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw invalid(file, (error as Error).message);
  }
  return parseManagedPolicy(text, file);
}

/**
 * Loaded files by path; `undefined` = no file there. Read once per process.
 * Defined on first use: this module loads inside the runtime ↔ settings
 * import cycle, before runtime.ts has initialised its part registry.
 */
let loadedPart: RuntimePart<Map<string, ManagedPolicy | undefined>> | undefined;

function load(file: string): ManagedPolicy | undefined {
  loadedPart ??= defineRuntimePart(
    "managed-policy",
    () => new Map<string, ManagedPolicy | undefined>(),
    undefined,
    { scope: "process" },
  );
  const loaded = currentRuntime().get(loadedPart);
  if (!loaded.has(file)) loaded.set(file, loadFile(file));
  return loaded.get(file);
}

/**
 * The managed policies in force, the `SN_MANAGED_POLICY_FILE` one first and
 * the OS one last, so the OS file has the last word on an `exact` key.
 * Throws MANAGED_POLICY_INVALID for a file that exists but is not valid.
 */
export function managedPolicies(
  env: ReadOptions["env"] = process.env,
): ManagedPolicy[] {
  const files: string[] = [];
  const extra = env?.SN_MANAGED_POLICY_FILE?.trim();
  if (extra) files.push(path.resolve(extra));
  const os = osPolicyPath();
  if (!files.includes(os)) files.push(os);
  return files.map(load).filter((p): p is ManagedPolicy => p !== undefined);
}

function compileGlob(pattern: string): RegExp {
  const body = pattern
    .split("")
    .map((c) =>
      c === "*"
        ? ".*"
        : c === "?"
          ? "."
          : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${body}$`);
}

/** The environment a managed policy assigns to `host`: exact match first, then the first pattern. */
export function managedEnvironment(
  policy: ManagedPolicy,
  host: string,
): Environment | undefined {
  const lower = host.toLowerCase();
  const exact = policy.environments.find(([pattern]) => pattern === lower);
  if (exact) return exact[1];
  return policy.environments.find(([pattern]) =>
    compileGlob(pattern).test(lower),
  )?.[1];
}

function instanceHost(opts: ReadOptions): string | undefined {
  const instance = rawSetting("SN_INSTANCE", opts)?.trim();
  if (!instance) return undefined;
  try {
    return resolveHost(instance).toLowerCase();
  } catch {
    // swallowed: an invalid instance fails on its own; it matches no pattern
    return undefined;
  }
}

/** The user's value as the reader would take it: the raw value if valid, else the default. */
function userValue(spec: SettingSpec, raw: string | undefined): unknown {
  const parsed = parseSetting(spec, raw);
  return parsed.ok && parsed.value !== undefined ? parsed.value : spec.default;
}

/** Merge one managed value over the user's raw value of the same key. */
export function mergeManaged(
  spec: SettingSpec,
  managed: string,
  raw: string | undefined,
): string | undefined {
  const rule = RULES[spec.key];
  if (!rule) return raw;
  switch (rule.kind) {
    case "flag":
      return userValue(spec, managed) === true ? "true" : raw;
    case "union": {
      const user = raw?.trim();
      return user ? `${managed},${user}` : managed;
    }
    case "order": {
      const rank = (v: unknown) =>
        typeof v === "string" ? rule.order.indexOf(v.toLowerCase()) : -1;
      const mine = rank(userValue(spec, raw));
      return mine >= rank(userValue(spec, managed)) ? raw : managed;
    }
    case "cap": {
      const cap = Number(managed);
      if (cap === 0) return raw;
      const mine = userValue(spec, raw);
      return typeof mine === "number" && mine > 0 && mine <= cap
        ? raw
        : managed;
    }
    case "exact":
      return managed;
  }
}

/** The managed overlay over one located value (the settings reader calls this). */
function overlay(
  spec: SettingSpec,
  located: { source: string; raw: string | undefined },
  opts: ReadOptions,
): { source: string; raw: string | undefined } {
  if (spec.key !== ENV_KEY && !(spec.key in RULES)) return located;
  let result = located;
  for (const policy of managedPolicies(opts.env)) {
    if (spec.key === ENV_KEY) {
      if (policy.environments.length === 0) continue;
      const host = instanceHost(opts);
      const env = host ? managedEnvironment(policy, host) : undefined;
      if (env) result = { source: policy.source, raw: env };
      continue;
    }
    const managed = policy.settings.get(spec.key);
    if (managed === undefined) continue;
    const merged = mergeManaged(spec, managed, result.raw);
    if (merged !== result.raw) result = { source: policy.source, raw: merged };
  }
  return result;
}

/** What `doctor` and `explain_policy` report about the managed layer. */
export interface ManagedPolicySummary {
  sources: string[];
  locked: string[];
  environments: Record<string, Environment>;
}

/** The managed layer in force, or undefined when there is none. */
export function managedPolicySummary(): ManagedPolicySummary | undefined {
  const policies = managedPolicies();
  if (policies.length === 0) return undefined;
  const locked = new Set<string>();
  const environments: Record<string, Environment> = {};
  for (const policy of policies) {
    for (const key of policy.settings.keys()) locked.add(key);
    for (const [pattern, env] of policy.environments) {
      environments[pattern] ??= env;
    }
  }
  if (Object.keys(environments).length > 0) locked.add(ENV_KEY);
  return {
    sources: policies.map((p) => p.source),
    locked: [...locked].sort(),
    environments,
  };
}

setManagedPolicyHook({ overlay, check: (env) => void managedPolicies(env) });
