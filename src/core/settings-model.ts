/**
 * E-4 — the settings manifest's model: the spec types, the kind helpers that
 * pair a kind with its zod schema, and the release markers. The rows live in
 * settings-data-server.ts and settings-data-runtime.ts; settings-manifest.ts
 * assembles them and owns reading. Import from settings-manifest.ts.
 */

import { z } from "zod";

/** The release a setting first shipped in; bump this one constant at release. */
export const UNRELEASED = "unreleased";

export type SettingSectionId =
  | "connection"
  | "secret-files"
  | "profiles"
  | "network"
  | "packages"
  | "policy"
  | "results"
  | "caching"
  | "docs"
  | "transport"
  | "logging"
  | "validation"
  | "external";

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

export type SettingKind =
  | "int"
  | "bool"
  | "enum"
  | "string"
  | "secret"
  | "path"
  | "list"
  | "url"
  | "date";

/**
 * How a named profile scopes a setting:
 * - `override` — `SN_PROFILE_<NAME>_<X>` wins whenever it is defined, even
 *   empty (the table policy, the write mode);
 * - `fallback` — the profile key wins only when non-empty, else `SN_<X>`
 *   (auth settings, the update set);
 * - `isolated` — the default profile reads only `SN_<X>`, any other profile
 *   only `SN_PROFILE_<NAME>_<X>` (the connection, prod marking).
 */
export type ProfileScope = "override" | "fallback" | "isolated";

type Schema = z.ZodType<unknown, string>;

export interface SettingSpec {
  key: string;
  section: SettingSectionId;
  kind: SettingKind;
  /** Markdown; the README renders it as is, `.env.example` strips the markup. */
  description: string;
  since: string;
  /** The parsed default; undefined = unset / computed (see defaultText). */
  default?: unknown;
  /** Human text for the default when it is computed or unset. */
  defaultText?: string;
  required?: boolean;
  /** The value is a secret: never echoed, masked in support bundles. */
  secret?: boolean;
  /** D-5: `<KEY>_FILE` may supply the value. */
  fileSource?: boolean;
  /** Extra text for the generated `<KEY>_FILE` entry. */
  fileNote?: string;
  profile?: ProfileScope;
  /** Legacy names read when the key is unset (e.g. LOG_LEVEL). */
  aliases?: readonly string[];
  /** Outside the SN_ namespace (proxy, XDG). */
  external?: boolean;
  /** A documentation-only pattern row (SN_PROFILE_<NAME>_*), never read. */
  pattern?: boolean;
  /** Example value for `.env.example` (defaults to the default). */
  example?: string;
  /** Short plain-text description: the key is published in server.json. */
  registry?: string;
  /**
   * `isRequired` in server.json. Only a key needed by every auth method is
   * required there (SN_USER / SN_PASSWORD are not needed for apikey / token).
   */
  registryRequired?: boolean;
  /** Enum values, for docs. */
  values?: readonly string[];
  schema: Schema;
}

// --- kind helpers ----------------------------------------------------------

function fail(ctx: z.RefinementCtx, message: string): typeof z.NEVER {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  return z.NEVER;
}

interface IntOpts {
  /** Lowest accepted value (inclusive). */
  min: number;
  max?: number;
  /** Require an integer instead of flooring a decimal. */
  integer?: boolean;
  /** `min` is exclusive before flooring (the legacy "positive" parse). */
  positive?: boolean;
}

function intSchema(o: IntOpts): Schema {
  return z.string().transform((raw, ctx) => {
    const n = Number(raw.trim());
    if (!Number.isFinite(n)) return fail(ctx, "expected a number");
    if (o.integer && !Number.isInteger(n)) {
      return fail(ctx, "expected an integer");
    }
    if (o.positive ? n <= 0 : n < o.min) {
      return fail(ctx, `expected a number >= ${o.positive ? 1 : o.min}`);
    }
    if (o.max !== undefined && n > o.max) {
      return fail(ctx, `expected a number <= ${o.max}`);
    }
    return Math.floor(n);
  });
}

const TRUTHY = ["1", "true", "yes", "on"] as const;
const FALSY = ["0", "false", "no", "off"] as const;

function boolSchema(
  on: readonly string[] = TRUTHY,
  off: readonly string[] = FALSY,
): Schema {
  return z.string().transform((raw, ctx) => {
    const v = raw.trim().toLowerCase();
    if (on.includes(v)) return true;
    if (off.includes(v)) return false;
    return fail(ctx, `expected one of ${[...on, ...off].join(", ")}`);
  });
}

function enumSchema(values: readonly string[], caseSensitive = false): Schema {
  return z.string().transform((raw, ctx) => {
    const v = caseSensitive ? raw.trim() : raw.trim().toLowerCase();
    if (values.includes(v)) return v;
    return fail(ctx, `expected one of ${values.join(", ")}`);
  });
}

const stringSchema: Schema = z.string();

const urlSchema: Schema = z.string().transform((raw, ctx) => {
  try {
    const url = new URL(raw.trim());
    if (url.protocol === "http:" || url.protocol === "https:") return raw;
  } catch {
    // fall through
  }
  return fail(ctx, "expected an http:// or https:// URL");
});

const dateSchema: Schema = z.string().transform((raw, ctx) => {
  if (Number.isNaN(Date.parse(raw.trim()))) {
    return fail(ctx, "expected an ISO 8601 date-time");
  }
  return raw.trim();
});

/** A profile name: lowercase letters, digits and `_`. */
export const PROFILE_RE = /^[a-z0-9_]+$/;

export const profileNameSchema: Schema = z.string().transform((raw, ctx) => {
  const v = raw.trim().toLowerCase();
  if (PROFILE_RE.test(v)) return v;
  return fail(ctx, "expected a profile name (letters, digits, _)");
});

type Common = Omit<SettingSpec, "kind" | "schema" | "values">;

export const int = (o: IntOpts, s: Common): SettingSpec => ({
  ...s,
  kind: "int",
  schema: intSchema(o),
});
/** The legacy "positive number, floored" parse used by most knobs. */
export const positive = (s: Common): SettingSpec =>
  int({ min: 1, positive: true }, s);
/** A non-negative number, floored (0 is meaningful). */
export const nonNegative = (s: Common): SettingSpec => int({ min: 0 }, s);
export const bool = (
  s: Common,
  on?: readonly string[],
  off?: readonly string[],
): SettingSpec => ({ ...s, kind: "bool", schema: boolSchema(on, off) });
export const oneOf = (
  values: readonly string[],
  s: Common,
  caseSensitive = false,
): SettingSpec => ({
  ...s,
  kind: "enum",
  values,
  schema: enumSchema(values, caseSensitive),
});
export const str = (s: Common): SettingSpec => ({
  ...s,
  kind: "string",
  schema: stringSchema,
});
export const secret = (s: Common): SettingSpec => ({
  ...s,
  kind: "secret",
  secret: true,
  schema: stringSchema,
});
export const filePath = (s: Common): SettingSpec => ({
  ...s,
  kind: "path",
  schema: stringSchema,
});
export const list = (s: Common): SettingSpec => ({
  ...s,
  kind: "list",
  schema: stringSchema,
});
export const url = (s: Common): SettingSpec => ({
  ...s,
  kind: "url",
  schema: urlSchema,
});
export const date = (s: Common): SettingSpec => ({
  ...s,
  kind: "date",
  schema: dateSchema,
});

// Release markers.
export const V100 = "1.0.0";
export const V110 = "1.1.0";
export const V200 = "2.0.0";
export const NEXT = UNRELEASED;
