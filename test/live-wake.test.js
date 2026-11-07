import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  classifyProbe,
  describeOutcome,
  waitForInstance,
} from "../scripts/live-wake.mjs";

const api = (result) => ({ status: 200, body: JSON.stringify({ result }) });

test("classifyProbe: the Table API answer carries the build (N-107)", () => {
  assert.deepEqual(classifyProbe(api([{ value: "glide-zurich-07" }])), {
    state: "awake",
    build: "glide-zurich-07",
  });
  assert.equal(classifyProbe(api([])).state, "awake");
  assert.match(classifyProbe(api([])).build, /not visible/);
});

test("classifyProbe: a refusal is not a sleeping instance (N-107)", () => {
  for (const status of [401, 403]) {
    assert.equal(classifyProbe({ status, body: "" }).state, "refused");
  }
});

test("classifyProbe: a redirect, HTML page or 5xx reads as asleep (N-107)", () => {
  for (const answer of [
    { status: 302, body: "" },
    { status: 200, body: "<html>Your instance is hibernating</html>" },
    { status: 200, body: "{}" },
    { status: 503, body: "" },
  ]) {
    assert.equal(classifyProbe(answer).state, "asleep");
  }
});

test("waitForInstance: backs off until the instance wakes (N-107)", async () => {
  const waits = [];
  const answers = [
    { status: 503, body: "" },
    new Error("connect ECONNRESET"),
    api([{ value: "glide-zurich-07" }]),
  ];
  const outcome = await waitForInstance({
    probe: async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async (ms) => waits.push(ms),
  });
  assert.equal(outcome.state, "awake");
  assert.equal(outcome.attempts, 3);
  assert.deepEqual(waits, [5_000, 10_000]);
});

test("waitForInstance: a refusal stops at once (N-107)", async () => {
  const outcome = await waitForInstance({
    probe: async () => ({ status: 401, body: "" }),
    sleep: () => assert.fail("must not wait"),
  });
  assert.equal(outcome.state, "refused");
  assert.equal(outcome.attempts, 1);
});

test("waitForInstance: gives up as asleep when the budget runs out (N-107)", async () => {
  const waits = [];
  const outcome = await waitForInstance({
    probe: async () => ({ status: 503, body: "" }),
    sleep: async (ms) => waits.push(ms),
  });
  assert.equal(outcome.state, "asleep");
  assert.equal(outcome.attempts, waits.length + 1);
  assert.ok(waits.reduce((a, b) => a + b, 0) <= 300_000);
  assert.equal(Math.max(...waits), 60_000);
});

test("describeOutcome: only an awake instance lets the smoke go on (N-107)", () => {
  const awake = describeOutcome({ state: "awake", build: "glide-x" });
  assert.match(awake.summary, /glide-x/);
  assert.equal(awake.error, undefined);
  const refused = describeOutcome({ state: "refused", detail: "HTTP 401" });
  assert.match(refused.error, /SN_USER/);
  const asleep = describeOutcome({
    state: "asleep",
    attempts: 7,
    detail: "HTTP 503",
  });
  assert.match(asleep.summary, /Not a shape regression/);
  assert.match(asleep.error, /asleep after 7 attempts/);
});

test("live-smoke.yml: an unset secret fails the run, nothing is skipped (N-107)", () => {
  const workflow = fs.readFileSync(".github/workflows/live-smoke.yml", "utf8");
  assert.doesNotMatch(workflow, /^\s*- if:/m);
  assert.doesNotMatch(workflow, /::notice::/);
  assert.match(workflow, /SN_INSTANCE SN_USER SN_PASSWORD/);
  assert.match(workflow, /exit 1/);
  assert.match(workflow, /node scripts\/live-wake\.mjs/);
  assert.match(workflow, /npm run test:live/);
});
