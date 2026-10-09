// E-6 / L9-03 sentinel: this suite sits in a sub-folder of test/; it only runs
// because the test scripts use the recursive "test/**/*.test.js" glob.
import test from "node:test";
import assert from "node:assert/strict";
import { basename, dirname } from "node:path";

test("test layout: a suite in a sub-folder of test/ runs", () => {
  assert.equal(basename(dirname(import.meta.dirname)), "test");
});
