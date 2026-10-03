import test from "node:test";
import { parseEnv as parseEnvFile } from "node:util";
import fc from "fast-check";

import { formatEnvValue } from "../build/core/config.js";

// E-2: Node's env-file parser (dotenv's replacement); a plain object, since
// Node 26 returns a null-prototype one that deepStrictEqual would reject.
const parseEnv = (text) => ({ ...parseEnvFile(text) });

/**
 * Property-based tests (Q2-2) for the two hand-written codecs, where
 * hand-picked examples are weakest: arbitrary inputs explore the corners.
 */

test("formatEnvValue: whatever it accepts, the env-file parser reads back identically", () => {
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
      const parsed = parseEnv(`KEY=${formatted}`).KEY ?? "";
      return parsed === value;
    }),
    { numRuns: 500 },
  );
});

test("L2-11: formatEnvValue over an adversarial alphabet round-trips (and only refuses the unrepresentable)", () => {
  // Backslash, all three quote characters, whitespace and the comment marker
  // are exactly the characters the quoting rules hinge on.
  const unit = fc.constantFrom(
    "a",
    "Z",
    "1",
    "\\",
    '"',
    "'",
    "`",
    " ",
    "#",
    "$",
    "=",
    "\t",
  );
  fc.assert(
    fc.property(fc.string({ unit, maxLength: 24 }), (value) => {
      let formatted;
      try {
        formatted = formatEnvValue(value);
      } catch {
        // Only a value needing quotes that holds ', ` and " (or ", with a
        // backslash, when no other quote is free) is legitimately refused.
        return value.includes("'") && value.includes("`");
      }
      const parsed = parseEnv(`KEY=${formatted}`).KEY ?? "";
      return parsed === value;
    }),
    { numRuns: 2000 },
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
