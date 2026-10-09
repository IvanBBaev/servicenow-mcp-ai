// MRTR guard: every server→client request (elicitation, sampling, roots)
// goes through src/mcp/input.ts, the only module that knows both protocol
// wires. A direct call elsewhere would bypass the 2026-07-28 input_required
// path (and its signed, single-use requestState).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const ALLOWED = path.join(SRC, "mcp", "input.ts");
const FORBIDDEN = /\b(elicitInput|createMessage|listRoots)\s*\(/;

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(full);
    else if (entry.name.endsWith(".ts")) yield full;
  }
}

test("MRTR guard: elicitInput / createMessage / listRoots appear only in src/mcp/input.ts", () => {
  const offenders = [];
  for (const file of sources(SRC)) {
    if (file === ALLOWED) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (FORBIDDEN.test(line)) {
          offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
        }
      });
  }
  assert.deepEqual(offenders, []);
  assert.match(readFileSync(ALLOWED, "utf8"), /elicitInput\(/);
});
