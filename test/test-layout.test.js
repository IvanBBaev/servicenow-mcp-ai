// E-6 / L9-03: every test runner script discovers tests recursively, so a
// suite placed in a sub-folder of test/ is never silently skipped, and the c8
// coverage thresholds have one definition (.c8rc.json).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const c8 = JSON.parse(readFileSync(join(root, ".c8rc.json"), "utf8"));

test("test layout: every node --test script uses the recursive glob", () => {
  const runners = Object.entries(pkg.scripts).filter(([, cmd]) =>
    cmd.includes("node --test"),
  );
  assert.ok(runners.length >= 4, "expected the test runner scripts");
  for (const [name, cmd] of runners) {
    // Quoted, so node expands `**` itself instead of a shell without globstar.
    assert.ok(
      cmd.includes('node --test "test/**/*.test.js"'),
      `${name} does not run "test/**/*.test.js": ${cmd}`,
    );
  }
});

test("test layout: coverage thresholds live only in .c8rc.json", () => {
  assert.equal(c8["check-coverage"], true);
  for (const key of ["lines", "branches", "functions"]) {
    assert.ok(Number.isInteger(c8[key]), `.c8rc.json has no ${key} threshold`);
  }
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    assert.doesNotMatch(
      cmd,
      /--(check-coverage|lines|branches|functions|statements)\b/,
      `${name} sets a coverage threshold outside .c8rc.json`,
    );
  }
});
