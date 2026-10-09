import test from "node:test";
import assert from "node:assert/strict";

import { baselineEnv } from "./helpers.js";
import { measureSurface } from "./surface.js";

baselineEnv();

/**
 * N-57 — per-tool size caps on the published `tools/list` entry (bytes of
 * JSON.stringify, as test/surface.js measures them). The profile budgets cap
 * the sum; these caps stop one tool from carrying the growth. A tool over a
 * global cap needs an OVERSIZE_ALLOW entry with its own, tighter ceiling and
 * a reason, so the outlier cannot grow unnoticed either.
 */

/** Global caps per component (bytes). */
const TOOL_CAPS = {
  total: 3072,
  description: 256,
  inputSchema: 2560,
  outputSchema: 2048,
};

/**
 * Named exceptions: per component, the ceiling that tool may reach (the
 * measured size rounded up to 128 B). Shrinking a tool under the global caps
 * makes its entry stale, and the stale check fails until it is removed.
 */
const OVERSIZE_ALLOW = {
  servicenow_upsert_artifact: {
    caps: { total: 3456, inputSchema: 3072 },
    reason:
      "The plan → token → apply write takes the artefact type, values, match keys and the H-3 guard arguments.",
  },
};

test("every tool stays within its size caps", async () => {
  const { perTool } = await measureSurface("all");
  const over = [];
  for (const tool of perTool) {
    const caps = { ...TOOL_CAPS, ...OVERSIZE_ALLOW[tool.name]?.caps };
    for (const [component, cap] of Object.entries(caps)) {
      if (tool[component] > cap) {
        over.push(`${tool.name}.${component}: ${tool[component]} > ${cap}`);
      }
    }
  }
  assert.deepEqual(
    over,
    [],
    "trim the tool, or add a reasoned OVERSIZE_ALLOW entry",
  );
});

test("OVERSIZE_ALLOW has no stale entry", async () => {
  const { perTool } = await measureSurface("all");
  const byName = new Map(perTool.map((t) => [t.name, t]));
  const stale = [];
  for (const [name, entry] of Object.entries(OVERSIZE_ALLOW)) {
    assert.ok(entry.reason, `${name}: an entry needs a reason`);
    const tool = byName.get(name);
    if (!tool) {
      stale.push(`${name}: no such tool`);
      continue;
    }
    for (const component of Object.keys(entry.caps)) {
      assert.ok(
        component in TOOL_CAPS,
        `${name}: unknown component ${component}`,
      );
      if (tool[component] <= TOOL_CAPS[component]) {
        stale.push(
          `${name}.${component}: ${tool[component]} fits the global cap`,
        );
      }
    }
  }
  assert.deepEqual(stale, []);
});
