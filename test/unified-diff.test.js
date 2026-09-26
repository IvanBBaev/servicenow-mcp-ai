import test from "node:test";
import assert from "node:assert/strict";

import { unifiedDiff } from "../build/api/unified-diff.js";

test("unifiedDiff returns an empty string for identical texts", () => {
  assert.equal(unifiedDiff("a\nb", "a\nb", "A", "B"), "");
});

test("unifiedDiff emits diff -u hunks with three lines of context", () => {
  const a = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
  const b = [...a];
  b[4] = "five";
  const out = unifiedDiff(a.join("\n"), b.join("\n"), "dev:x", "prod:x");
  assert.equal(
    out,
    [
      "--- dev:x",
      "+++ prod:x",
      "@@ -2,7 +2,7 @@",
      " 2",
      " 3",
      " 4",
      "-5",
      "+five",
      " 6",
      " 7",
      " 8",
    ].join("\n"),
  );
});

test("unifiedDiff splits distant changes into separate hunks", () => {
  const a = Array.from({ length: 30 }, (_, i) => `l${i}`);
  const b = [...a];
  b[1] = "changed";
  b.splice(25, 1);
  b.push("added");
  const out = unifiedDiff(a.join("\n"), b.join("\n"), "a", "b");
  const hunks = out.split("\n").filter((l) => l.startsWith("@@"));
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0], "@@ -1,5 +1,5 @@");
  assert.match(out, /^-l25$/m);
  assert.match(out, /^\+added$/m);
});

test("unifiedDiff handles pure insertions into an empty text", () => {
  const out = unifiedDiff("", "x\ny", "a", "b");
  assert.match(out, /^@@ -1,1 \+1,2 @@$/m);
  assert.match(out, /^\+x$/m);
});

test("unifiedDiff caps its output and marks the cut", () => {
  const a = Array.from({ length: 50 }, (_, i) => `a${i}`).join("\n");
  const b = Array.from({ length: 50 }, (_, i) => `b${i}`).join("\n");
  const lines = unifiedDiff(a, b, "a", "b", 10).split("\n");
  assert.equal(lines.length, 11);
  assert.match(lines[10], /^… \d+ more line\(s\)$/);
});

test("unifiedDiff gives up past the edit-distance limit", () => {
  const a = Array.from({ length: 2100 }, (_, i) => `a${i}`).join("\n");
  const b = Array.from({ length: 2100 }, (_, i) => `b${i}`).join("\n");
  assert.match(
    unifiedDiff(a, b, "a", "b"),
    /too many changes to diff: 2100 vs 2100 lines/,
  );
});
