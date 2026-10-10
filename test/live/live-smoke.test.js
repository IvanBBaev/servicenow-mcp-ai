import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { loadEnv, reloadCredentialsFromEnv } from "../../build/core/config.js";
import {
  FIXTURE_DIR,
  SCENARIOS,
  callScenario,
  freshRuntime,
  normalize,
  scenarioArgs,
  shapeOf,
  startServer,
} from "../fixtures/pdi/pdi.js";

/**
 * E-6 / O-2: live smoke against a real instance. Skipped unless SN_LIVE=1
 * (`npm run test:live`); credentials come from SN_* or the active env file.
 * Runs the read-only PDI scenarios and checks each answer still has the
 * shape of the recorded fixture — values differ per instance, shape must not.
 */
const live = process.env.SN_LIVE === "1";

test("pdi live smoke", { skip: !live && "set SN_LIVE=1 to run" }, async (t) => {
  loadEnv();
  reloadCredentialsFromEnv();
  assert.ok(process.env.SN_INSTANCE, "SN_INSTANCE is not set");
  const results = {};
  for (const scenario of SCENARIOS) {
    await t.test(scenario.id, async () => {
      await freshRuntime();
      const { client, close } = await startServer();
      try {
        const args = scenarioArgs(scenario, results);
        results[scenario.id] = await callScenario(client, scenario.tool, args);
      } finally {
        await close();
      }
      const result = results[scenario.id];
      assert.equal(result.isError, false, JSON.stringify(result.data));
      const fixture = JSON.parse(
        fs.readFileSync(path.join(FIXTURE_DIR, `${scenario.id}.json`), "utf8"),
      );
      assert.deepEqual(shapeOf(normalize(result)), shapeOf(fixture.result));
    });
  }
});
