import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  FIXTURE_DIR,
  FIXTURE_HOST,
  SCENARIOS,
  customNames,
  enterReplayEnv,
  replayScenario,
  strayEmails,
} from "./fixtures/pdi/pdi.js";

/**
 * E-6 / O-2: replay the redacted PDI corpus (recorded by
 * `npm run fixtures:record`) through the real tool layer, offline. A change
 * that alters what a tool asks the instance for, or how it shapes the answer,
 * shows up here as an unmatched request or a result diff.
 */
const load = (id) =>
  JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${id}.json`), "utf8"));

for (const scenario of SCENARIOS) {
  test(`pdi replay: ${scenario.id}`, async () => {
    const fixture = load(scenario.id);
    assert.equal(fixture.tool, scenario.tool);
    const restore = enterReplayEnv();
    try {
      const { result, unmatched } = await replayScenario(fixture);
      assert.deepEqual(unmatched, []);
      assert.deepEqual(result, fixture.result);
    } finally {
      restore();
    }
  });
}

test("pdi corpus holds no instance, person or custom-scope data", () => {
  const files = fs
    .readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".json"));
  assert.deepEqual(
    files.sort(),
    SCENARIOS.map((s) => `${s.id}.json`).sort(),
    "every fixture belongs to a scenario and every scenario has a fixture",
  );
  for (const name of files) {
    const text = fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
    const hosts = new Set(text.match(/[a-z0-9.-]+\.service-now\.com/g) ?? []);
    assert.deepEqual(
      [...hosts].filter((h) => h !== FIXTURE_HOST),
      [],
      name,
    );
    assert.deepEqual(strayEmails(text), [], name);
    assert.deepEqual(customNames(text), [], name);
  }
});
