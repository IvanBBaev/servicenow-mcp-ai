import test from "node:test";
import assert from "node:assert/strict";

import { driftCount } from "../build/api/compare.js";

const empty = {
  tablesOnlyInA: [],
  tablesOnlyInB: [],
  columnDiffs: [],
  scriptDiffs: [],
  pluginDiffs: [],
  appDiffs: [],
};

test("driftCount is 0 for identical instances (exit 0)", () => {
  assert.equal(driftCount(empty), 0);
});

test("driftCount sums every difference dimension (DF-3)", () => {
  assert.equal(
    driftCount({
      ...empty,
      tablesOnlyInA: ["u_custom"],
      columnDiffs: [{}, {}],
      scriptDiffs: [{}],
      pluginDiffs: ["com.x"],
    }),
    5,
  );
});
