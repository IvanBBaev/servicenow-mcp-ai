// N-57: checks or lowers the `tools/list` byte budgets in
// test/fixtures/token-budgets.json against the wire measurement of
// test/surface.js (run `npm run build` first; it measures build/).
//
//   npm run tokens:budget              report measured vs budget; exit 1 when
//                                      a profile is over budget or more than
//                                      slackPct under it (the ratchet)
//   npm run tokens:budget -- --write   lower every budget to its measurement
//                                      rounded up to 256 B
//
// --write never raises a budget: growth is a hand edit of the fixture and an
// owner decision (O-10), so a profile over its budget fails here as well.

import { readFileSync, writeFileSync } from "node:fs";

import { baselineEnv } from "../test/helpers.js";
import { measureSurface, roundBudget } from "../test/surface.js";

const FIXTURE = new URL("../test/fixtures/token-budgets.json", import.meta.url);

baselineEnv();
const write = process.argv.includes("--write");
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
const floor = 1 - fixture.slackPct / 100;

let failed = false;
let lowered = false;
for (const [profile, budget] of Object.entries(fixture.profiles)) {
  const { bytes } = await measureSurface(profile);
  const target = roundBudget(bytes);
  let verdict = "ok";
  if (bytes > budget) {
    verdict = "OVER BUDGET (raising it is an owner decision, O-10)";
    failed = true;
  } else if (target < budget && write) {
    fixture.profiles[profile] = target;
    verdict = `lowered from ${budget}`;
    lowered = true;
  } else if (bytes < Math.floor(budget * floor)) {
    verdict = "slack over the ratchet (run with --write)";
    failed = true;
  }
  console.log(
    `${profile.padEnd(11)} ${String(bytes).padStart(7)} B  budget ${String(fixture.profiles[profile]).padStart(7)}  ${verdict}`,
  );
}

if (lowered) {
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log("tokens:budget: test/fixtures/token-budgets.json updated");
}
process.exitCode = failed ? 1 : 0;
