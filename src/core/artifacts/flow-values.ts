/**
 * P-10 — the `flow-values` decoder (project/SDK-PARITY.md §5(b)).
 *
 * Flow Designer stores the configured inputs of a trigger, action, logic or
 * subflow instance in its `values` column. Depending on the release the
 * column holds plain JSON or base64-encoded gzip of JSON (unverified, gate
 * O-5). Detection runs in that order:
 *
 *   1. empty            → `null`
 *   2. plain JSON       → the tolerant `json` decoder
 *   3. base64 + gzip    → gunzip (bounded), then the `json` decoder
 *   4. anything else    → `decoded:false` with the byte length
 *
 * Nothing here throws: an unknown or corrupt value comes back as
 * `decoded:false` so one bad step never fails an explain. The registry
 * decoder (`flowValuesDecoder` in decoders.ts) wraps `detectFlowValues`.
 */
import { gunzipSync } from "node:zlib";
import { jsonDecoder } from "./json-decoder.js";

/** Largest inflated `values` payload read (bytes); bigger is `unknown`. */
export const FLOW_VALUES_MAX_INFLATED = 4 * 1024 * 1024;

/** How a `values` column was stored. */
export type FlowValuesFormat =
  | "empty"
  | "json"
  | "base64-gzip-json"
  | "unknown";

export type FlowValuesDetection =
  | { format: FlowValuesFormat; decoded: true; value: unknown; bytes: number }
  | {
      format: "unknown";
      decoded: false;
      reason: string;
      bytes: number;
    };

/** Strict base64 (standard alphabet, padded), whitespace already removed. */
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Detect the storage format of a `values` column and decode it. */
export function detectFlowValues(raw: string): FlowValuesDetection {
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  const bytes = Buffer.byteLength(text, "utf8");
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return { format: "empty", decoded: true, value: null, bytes };

  // Base64 of gzip always starts "H4sI", which is never valid JSON, so
  // trying JSON first cannot misread a compressed value.
  const json = jsonDecoder.decode(trimmed);
  if (json.decoded) {
    return { format: "json", decoded: true, value: json.value, bytes };
  }

  const compact = trimmed.replace(/\s+/g, "");
  if (compact.length >= 4 && BASE64.test(compact)) {
    const buf = Buffer.from(compact, "base64");
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      let inflated: string | undefined;
      try {
        inflated = gunzipSync(buf, {
          maxOutputLength: FLOW_VALUES_MAX_INFLATED,
        }).toString("utf8");
      } catch (error) {
        return {
          format: "unknown",
          decoded: false,
          reason: `base64 + gzip payload did not inflate: ${(error as Error).message}. ${bytes} bytes returned raw.`,
          bytes,
        };
      }
      const inner = jsonDecoder.decode(inflated);
      if (inner.decoded) {
        return {
          format: "base64-gzip-json",
          decoded: true,
          value: inner.value,
          bytes,
        };
      }
      return {
        format: "unknown",
        decoded: false,
        reason: `base64 + gzip payload is not JSON. ${bytes} bytes returned raw.`,
        bytes,
      };
    }
  }

  return {
    format: "unknown",
    decoded: false,
    reason: `Unrecognised flow values format (not JSON, not base64 + gzip JSON). ${bytes} bytes returned raw.`,
    bytes,
  };
}
