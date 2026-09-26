/**
 * P-6 — decoders for encoded JSON fields (project/SDK-PARITY.md §3 tier X).
 *
 * A registry `jsonFields` entry names a decoder id (`DECODER_IDS`). This
 * module maps ids to implementations. `json` ships here: a tolerant parse
 * (BOM, surrounding whitespace, trailing commas, double-encoded strings).
 * `flow-values` (P-10) ships too: plain JSON or base64 + gzip JSON, detected
 * per value (flow-values.ts). Later P2 domains plug theirs in with
 * {@link registerDecoder} — `uib-composition` (P-14). Until one is
 * registered, its fields are read with `json` and the result says so
 * (`via: "json"`).
 *
 * A decoder never throws: a value it cannot read comes back raw with
 * `decoded:false` and a reason, so one bad field never fails an explain.
 */
import { detectFlowValues } from "./flow-values.js";
import type { DecoderId } from "./registry.js";

/** What a decoder made of one raw field value. */
export type DecodeOutcome =
  | { decoded: true; value: unknown }
  | { decoded: false; reason: string };

export interface Decoder {
  id: DecoderId;
  decode(raw: string): DecodeOutcome;
}

/** Remove commas that directly precede `}` / `]`, leaving strings intact. */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    if (ch === ",") {
      let j = i + 1;
      while (/\s/.test(text[j] ?? "")) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** The tolerant `json` decoder. An empty value decodes to `null`. */
export const jsonDecoder: Decoder = {
  id: "json",
  decode(raw) {
    const text = raw.replace(/^\uFEFF/, "").trim();
    if (!text) return { decoded: true, value: null };
    let parsed = tryParse(text);
    if (!parsed.ok) parsed = tryParse(stripTrailingCommas(text));
    if (!parsed.ok) {
      return { decoded: false, reason: "Not valid JSON." };
    }
    // Double-encoded: a JSON string whose content is itself an object/array.
    const v = parsed.value;
    if (typeof v === "string" && /^\s*[[{]/.test(v)) {
      const inner = tryParse(v);
      if (inner.ok) return { decoded: true, value: inner.value };
    }
    return { decoded: true, value: v };
  },
};

/**
 * The `flow-values` decoder (P-10): Flow Designer `values` columns, stored as
 * plain JSON or base64 + gzip JSON depending on the release (gate O-5).
 */
export const flowValuesDecoder: Decoder = {
  id: "flow-values",
  decode(raw) {
    const d = detectFlowValues(raw);
    return d.decoded
      ? { decoded: true, value: d.value }
      : { decoded: false, reason: d.reason };
  },
};

const DECODERS = new Map<DecoderId, Decoder>([
  ["json", jsonDecoder],
  ["flow-values", flowValuesDecoder],
]);

/**
 * Install (or replace) the implementation of a decoder id. Returns a function
 * that restores the previous one.
 */
export function registerDecoder(decoder: Decoder): () => void {
  const previous = DECODERS.get(decoder.id);
  DECODERS.set(decoder.id, decoder);
  return () => {
    if (previous) DECODERS.set(decoder.id, previous);
    else DECODERS.delete(decoder.id);
  };
}

/** The decoder registered for an id, if any. */
export function getDecoder(id: DecoderId): Decoder | undefined {
  return DECODERS.get(id);
}

/** One decoded field, with the decoder that actually ran. */
export type FieldDecode = DecodeOutcome & {
  decoder: DecoderId;
  /** Set when `decoder` has no implementation yet and `json` read the value. */
  via?: "json";
};

/**
 * Decode a raw field value with the named decoder, falling back to `json`
 * when that decoder is not registered. Never throws.
 */
export function decodeField(id: DecoderId, raw: string): FieldDecode {
  const own = DECODERS.get(id);
  const decoder = own ?? jsonDecoder;
  let outcome: DecodeOutcome;
  try {
    outcome = decoder.decode(raw);
  } catch (error) {
    outcome = { decoded: false, reason: (error as Error).message };
  }
  if (!own && !outcome.decoded) {
    outcome = {
      decoded: false,
      reason: `${outcome.reason} The '${id}' decoder is not available yet.`,
    };
  }
  return { ...outcome, decoder: id, ...(own ? {} : { via: "json" as const }) };
}
