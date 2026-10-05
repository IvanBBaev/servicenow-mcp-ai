import { getRedactFields, redactPII } from "./settings.js";
import type { SecretRegistry } from "./request-context.js";
import {
  FALLBACK_SECRET_FIELDS,
  MIN_SECRET_VALUE_LENGTH,
  secretRegistry,
} from "./secret-columns.js";

/**
 * DF-5 / H-5 — the redaction primitives, in core so both the result boundary
 * (mcp/result.ts, mcp/redact.ts) and the write journal (core/write-journal.ts)
 * mask with the same rules. Named fields (`SN_REDACT_FIELDS`) are masked
 * outright wherever the key occurs, at any depth; with `SN_REDACT_PII`, string
 * values that match an email/phone/national-id pattern are masked too.
 *
 * N-21: on top of the opt-in rules, secret columns are masked always — the
 * OOTB secret names, the columns the call's reads resolved as
 * password / password2 / glide_encrypted, and those columns' values wherever
 * they reappear (see core/secret-columns.ts). That part cannot be turned off.
 */

export const REDACTED = "[redacted]";

const PII_PATTERNS: RegExp[] = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/g, // email
  /\b\+?\d[\d ()-]{7,}\d\b/g, // phone
  /\b\d{9,}\b/g, // long national-id digit run
];

/** Mask every PII match in one string, counting the hits. */
export function redactString(value: string): { value: string; hits: number } {
  let hits = 0;
  let out = value;
  for (const re of PII_PATTERNS) {
    out = out.replace(re, () => {
      hits++;
      return REDACTED;
    });
  }
  return { value: out, hits };
}

/** The active redaction rules (N-21: never off — secret columns always mask). */
export interface RedactionRules {
  fields: Set<string>;
  pii: boolean;
  /** N-21: masks a known secret value inside a string; absent when none is known. */
  secrets?: SecretMatcher;
}

/** N-21: the secret values a call read, compiled for scanning strings. */
export interface SecretMatcher {
  /** Values masked when a string equals one of them. */
  exact: Set<string>;
  /** Values long enough to be masked inside a longer string too. */
  within?: RegExp;
}

/** Values that are a mask already — never counted or re-masked. */
const ALREADY_MASKED: ReadonlySet<unknown> = new Set([REDACTED, "***"]);

/** Shorter secret values are masked only as a whole string (too generic). */
const SUBSTRING_MIN_LENGTH = 8;

const matcherCache = new WeakMap<
  SecretRegistry,
  { version: number; matcher?: SecretMatcher }
>();

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Compile (once per registry version) the matcher for a registry's values. */
function secretMatcher(reg: SecretRegistry): SecretMatcher | undefined {
  const hit = matcherCache.get(reg);
  if (hit && hit.version === reg.version) return hit.matcher;
  let matcher: SecretMatcher | undefined;
  const exact = new Set(
    [...reg.values].filter((v) => v.length >= MIN_SECRET_VALUE_LENGTH),
  );
  if (exact.size) {
    // Longest first, so a value never leaves the tail of a longer one behind.
    const long = [...exact]
      .filter((v) => v.length >= SUBSTRING_MIN_LENGTH)
      .sort((a, b) => b.length - a.length);
    matcher = {
      exact,
      ...(long.length
        ? { within: new RegExp(long.map(escapeRegExp).join("|"), "g") }
        : {}),
    };
  }
  matcherCache.set(reg, { version: reg.version, matcher });
  return matcher;
}

/**
 * The active rules: `SN_REDACT_FIELDS`, the OOTB secret names, the secret
 * columns the current call resolved (plus `extraFields`, e.g. the journal's
 * cached columns of its table), `SN_REDACT_PII`, and the call's secret values.
 */
export function redactionRules(extraFields?: Iterable<string>): RedactionRules {
  const reg = secretRegistry();
  const fields = new Set([
    ...getRedactFields(),
    ...FALLBACK_SECRET_FIELDS,
    ...(reg?.fields ?? []),
    ...(extraFields ?? []),
  ]);
  const secrets = reg && secretMatcher(reg);
  return { fields, pii: redactPII(), ...(secrets ? { secrets } : {}) };
}

/** Mask every known secret value inside one string, counting the hits. */
function redactSecrets(
  value: string,
  matcher: SecretMatcher,
): { value: string; hits: number } {
  if (matcher.exact.has(value)) return { value: REDACTED, hits: 1 };
  if (!matcher.within) return { value, hits: 0 };
  let hits = 0;
  const out = value.replace(matcher.within, () => {
    hits++;
    return REDACTED;
  });
  return { value: out, hits };
}

/**
 * Deep-redact any JSON-like value: a key named in the rules' fields (a
 * `SN_REDACT_FIELDS` name or a secret column) has its (non-empty) value
 * replaced wholesale, every string is scanned for the call's secret values,
 * and with `SN_REDACT_PII` for PII. A value that is already a mask
 * (`[redacted]`, or the logger's / settings' `***`) is left as it is. Returns
 * the same reference and `redacted: 0` when nothing was masked (or `rules` is
 * null). Cycles are not expected (every input is JSON-serialisable) but a
 * visited set keeps a stray one from recursing.
 */
export function redactValue<T>(
  value: T,
  rules: RedactionRules | null = redactionRules(),
): { value: T; redacted: number } {
  if (!rules) return { value, redacted: 0 };
  let redacted = 0;
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      let out = v;
      if (rules.secrets) {
        const s = redactSecrets(out, rules.secrets);
        redacted += s.hits;
        out = s.value;
      }
      if (!rules.pii) return out;
      const r = redactString(out);
      redacted += r.hits;
      return r.value;
    }
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return v;
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(v)) {
      if (
        rules.fields.has(key) &&
        inner != null &&
        inner !== "" &&
        !ALREADY_MASKED.has(inner as string)
      ) {
        out[key] = REDACTED;
        redacted++;
      } else {
        out[key] = walk(inner);
      }
    }
    return out;
  };
  const out = walk(value) as T;
  return redacted ? { value: out, redacted } : { value, redacted: 0 };
}
