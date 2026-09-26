import { getRedactFields, redactPII } from "./settings.js";

/**
 * DF-5 / H-5 — the redaction primitives, in core so both the result boundary
 * (mcp/result.ts, mcp/redact.ts) and the write journal (core/write-journal.ts)
 * mask with the same rules. Named fields (`SN_REDACT_FIELDS`) are masked
 * outright wherever the key occurs, at any depth; with `SN_REDACT_PII`, string
 * values that match an email/phone/national-id pattern are masked too.
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

/** The active redaction rules, or null when redaction is off (the default). */
export interface RedactionRules {
  fields: Set<string>;
  pii: boolean;
}

export function redactionRules(): RedactionRules | null {
  const fields = new Set(getRedactFields());
  const pii = redactPII();
  return fields.size === 0 && !pii ? null : { fields, pii };
}

/**
 * Deep-redact any JSON-like value: a key named in `SN_REDACT_FIELDS` has its
 * (non-empty) value replaced wholesale, and with `SN_REDACT_PII` every string
 * is scanned. Returns the same reference and `redacted: 0` when redaction is
 * off, so the default path pays nothing. Cycles are not expected (every input
 * is JSON-serialisable) but a visited set keeps a stray one from recursing.
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
      if (!rules.pii) return v;
      const r = redactString(v);
      redacted += r.hits;
      return r.value;
    }
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return v;
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(v)) {
      if (rules.fields.has(key) && inner != null && inner !== "") {
        out[key] = REDACTED;
        redacted++;
      } else {
        out[key] = walk(inner);
      }
    }
    return out;
  };
  return { value: walk(value) as T, redacted };
}
