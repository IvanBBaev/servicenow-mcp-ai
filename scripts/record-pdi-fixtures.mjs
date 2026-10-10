#!/usr/bin/env node
// E-6 / O-2: record the PDI fixture corpus (test/fixtures/pdi/*.json).
//
// Phase 1 runs every scenario of test/fixtures/pdi/pdi.js through the real
// tool layer against the instance of the active env file (or SN_* in the
// environment) and records each HTTP exchange. Only read-only tools run.
//
// Phase 2 cleans the exchanges — rows naming a custom (x_<vendor>_ / u_) table
// or field are dropped; host, instance name, e-mail addresses and person
// names become placeholders — and replays them offline to produce the golden
// tool result, so the recorded result always matches the recorded traffic.
//
// The run fails, and writes nothing, when a scenario errors live or on
// replay, or when a fixture still holds the host, the instance name, the
// recording user, a foreign e-mail address or a custom name. Needs
// `npm run build` first.
//
//   node scripts/record-pdi-fixtures.mjs
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const build = path.join(root, "build");

const { loadEnv, reloadCredentialsFromEnv } = await import(
  path.join(build, "core/config.js")
);
const pdi = await import(path.join(root, "test/fixtures/pdi/pdi.js"));

const fail = (message) => {
  console.error(`record-pdi-fixtures: ${message}`);
  process.exit(1);
};

loadEnv();
reloadCredentialsFromEnv();

const host = (process.env.SN_INSTANCE ?? "")
  .replace(/^https?:\/\//, "")
  .replace(/\/.*$/, "");
if (!host) {
  console.error("record-pdi-fixtures: SN_INSTANCE is not set");
  process.exit(2);
}
const user = process.env.SN_USER;

// Phase 1: live.
const realFetch = globalThis.fetch;
const results = {};
const recorded = [];
for (const scenario of pdi.SCENARIOS) {
  await pdi.freshRuntime();
  const exchanges = [];
  globalThis.fetch = async (input, init) => {
    const response = await realFetch(input, init);
    exchanges.push(await pdi.captureExchange(input, init, response));
    return response;
  };
  const args = pdi.scenarioArgs(scenario, results);
  const { client, close } = await pdi.startServer();
  try {
    results[scenario.id] = await pdi.callScenario(client, scenario.tool, args);
  } finally {
    await close();
    globalThis.fetch = realFetch;
  }
  if (results[scenario.id].isError) fail(`${scenario.id} failed live`);
  recorded.push({ scenario, args, exchanges });
}

// Phase 2: clean and replay.
const redactor = pdi.createRedactor({ host });
const restoreEnv = pdi.enterReplayEnv();
const files = [];
try {
  for (const { scenario, args, exchanges } of recorded) {
    const fixture = redactor.redact({
      id: scenario.id,
      tool: scenario.tool,
      args,
      exchanges: exchanges.map(pdi.dropCustomRows),
    });
    const { result, unmatched } = await pdi.replayScenario(fixture);
    if (unmatched.length) fail(`${scenario.id} replay hit unrecorded requests`);
    if (result.isError) fail(`${scenario.id} failed on replay`);
    fixture.result = result;
    files.push({
      file: path.join(pdi.FIXTURE_DIR, `${scenario.id}.json`),
      text: JSON.stringify(fixture, null, 2) + "\n",
      exchanges: exchanges.length,
    });
  }
} finally {
  restoreEnv();
}

const forbidden = pdi.forbiddenStrings({ host, user });
let leaks = 0;
for (const { file, text } of files) {
  const name = path.basename(file);
  const lower = text.toLowerCase();
  if (forbidden.some((s) => lower.includes(s))) {
    leaks += 1;
    console.error(
      `record-pdi-fixtures: ${name} still contains a forbidden string`,
    );
  }
  if (pdi.strayEmails(text).length) {
    leaks += 1;
    console.error(
      `record-pdi-fixtures: ${name} has an unredacted e-mail address`,
    );
  }
  const custom = pdi.customNames(text);
  if (custom.length) {
    leaks += 1;
    console.error(
      `record-pdi-fixtures: ${name} still names ${custom.length} custom table(s) or field(s)`,
    );
  }
}
if (leaks) process.exit(1);

for (const { file, text, exchanges } of files) {
  fs.writeFileSync(file, text);
  console.log(`${path.relative(root, file)}  ${exchanges} exchange(s)`);
}
