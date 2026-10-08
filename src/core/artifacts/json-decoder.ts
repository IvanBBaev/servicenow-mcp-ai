/**
 * P-6 — the tolerant `json` decoder and the decoder contract, on their own
 * so that flow-values.ts can build on `json` without importing the decoder
 * registry (decoders.ts), which wraps flow-values (E-7: no import cycle).
 */
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
