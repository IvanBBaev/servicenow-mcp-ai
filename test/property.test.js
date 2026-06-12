import test from "node:test";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import fc from "fast-check";

import { formatEnvValue } from "../build/core/config.js";

/**
 * Property-based tests (Q2-2) for the two hand-written codecs, where
 * hand-picked examples are weakest: arbitrary inputs explore the corners.
 */

test("formatEnvValue: whatever it accepts, dotenv parses back identically", () => {
  fc.assert(
    fc.property(fc.string(), (value) => {
      let formatted;
      try {
        formatted = formatEnvValue(value);
      } catch {
        // Explicitly refusing to serialise is a valid outcome — the property
        // only covers values the codec claims to support.
        return true;
      }
      const parsed = dotenv.parse(`KEY=${formatted}`).KEY ?? "";
      return parsed === value;
    }),
    { numRuns: 500 },
  );
});

test("base64 round-trip: every buffer survives encode → strict decode", async () => {
  const { uploadAttachment } = await import("../build/api/attachment.js");
  const { baselineEnv, withFetch } = await import("./helpers.js");
  baselineEnv();

  await fc.assert(
    fc.asyncProperty(fc.uint8Array({ maxLength: 256 }), async (bytes) => {
      const base64 = Buffer.from(bytes).toString("base64");
      let uploaded = null;
      await withFetch(
        (_url, init) => {
          uploaded = Buffer.from(init.body);
          return new Response(JSON.stringify({ result: { sys_id: "a" } }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        },
        async () => {
          await uploadAttachment({
            table: "incident",
            sysId: "r1",
            fileName: "f.bin",
            contentBase64: base64,
          });
        },
      );
      return Buffer.from(bytes).equals(uploaded);
    }),
    { numRuns: 200 },
  );
});
