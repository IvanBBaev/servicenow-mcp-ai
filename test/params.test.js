// N-59 (TK-41) — shared parameters have one definition, re-exported unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import * as params from "../build/mcp/params.js";
import { instanceParam, planTokenParam } from "../build/mcp/define.js";
import { applyInput } from "../build/mcp/write-mode.js";
import { specs as tableSpecs } from "../build/tools/table.js";
import { specs as artifactSpecs } from "../build/tools/artifacts.js";
import { specs as updateSetSpecs } from "../build/tools/updatesets.js";

test("define.ts and write-mode.ts re-export the params.ts parameters", () => {
  assert.equal(instanceParam, params.instanceParam);
  assert.equal(planTokenParam, params.planTokenParam);
  assert.equal(applyInput, params.applyInput);
});

test("every update_set input comes from params.ts", () => {
  const shared = new Set([params.updateSetInput, params.updateSetRef]);
  const inputs = [...tableSpecs, ...artifactSpecs, ...updateSetSpecs]
    .map((s) => s.input?.update_set)
    .filter(Boolean);
  assert.ok(inputs.length >= 6, `found ${inputs.length}`);
  for (const input of inputs) assert.ok(shared.has(input));
});
