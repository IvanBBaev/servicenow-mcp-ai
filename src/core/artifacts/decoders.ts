/**
 * P-6 — decoders for encoded JSON fields (project/SDK-PARITY.md §3 tier X).
 *
 * A registry `jsonFields` entry names a decoder id (`DECODER_IDS`). This
 * module maps ids to implementations. `json` ships in json-decoder.ts: a
 * tolerant parse (BOM, surrounding whitespace, trailing commas,
 * double-encoded strings).
 * `flow-values` (P-10) ships too: plain JSON or base64 + gzip JSON, detected
 * per value (flow-values.ts), and so does `uib-composition` (P-14): JSON that
 * must have the shape of a UI Builder component tree (uib-composition.ts).
 * Later domains plug theirs in with {@link registerDecoder}; until one is
 * registered, its fields are read with `json` and the result says so
 * (`via: "json"`).
 *
 * A decoder never throws: a value it cannot read comes back raw with
 * `decoded:false` and a reason, so one bad field never fails an explain.
 */
import { detectFlowValues } from "./flow-values.js";
import { jsonDecoder } from "./json-decoder.js";
import type { DecodeOutcome, Decoder } from "./json-decoder.js";
import type { DecoderId } from "./registry.js";
import { isComposition } from "./uib-composition.js";

export { jsonDecoder } from "./json-decoder.js";
export type { DecodeOutcome, Decoder } from "./json-decoder.js";

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

/**
 * The `uib-composition` decoder (P-14): a macroponent `composition` column.
 * The value is the parsed JSON, unchanged, but only when it has the shape of a
 * component tree (an array of objects with an `elementId`); any other shape is
 * `decoded:false` so the caller shows it raw. The shape is unverified until
 * gate O-5.
 */
export const uibCompositionDecoder: Decoder = {
  id: "uib-composition",
  decode(raw) {
    const parsed = jsonDecoder.decode(raw);
    if (!parsed.decoded) return parsed;
    if (parsed.value === null) return parsed;
    if (!isComposition(parsed.value)) {
      return {
        decoded: false,
        reason:
          "Not a UI Builder composition: expected an array of elements with an elementId.",
      };
    }
    return parsed;
  },
};

const DECODERS = new Map<DecoderId, Decoder>([
  ["json", jsonDecoder],
  ["flow-values", flowValuesDecoder],
  ["uib-composition", uibCompositionDecoder],
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
