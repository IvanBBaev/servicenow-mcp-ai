// N-13 — hardening compliance: the rule table evaluated against sys_properties.
import test from "node:test";
import assert from "node:assert/strict";

import {
  checkHardening,
  evaluateHardening,
  meetsExpect,
  renderHardening,
} from "../build/api/hardening.js";
import {
  HARDENING_RULES,
  HARDENING_RULES_VERSION,
} from "../build/api/hardening-rules.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withFetch,
} from "./helpers.js";

baselineEnv();

const RULES = [
  {
    property: "a.flag",
    expect: { equals: "true" },
    default: "true",
    severity: "high",
    rationale: "r1",
    source: "s",
  },
  {
    property: "b.timeout",
    expect: { max: 30 },
    default: "60",
    severity: "low",
    rationale: "r2",
    source: "s",
  },
  {
    property: "c.unknown_default",
    expect: { equals: "false" },
    severity: "medium",
    rationale: "r3",
    source: "s",
  },
  {
    property: "d.new",
    expect: { equals: "true" },
    severity: "medium",
    rationale: "r4",
    source: "s",
    since: "xanadu",
  },
];

test("the rule table: unique properties, a source each, defaults meet a known form", () => {
  const names = HARDENING_RULES.map((r) => r.property);
  assert.equal(new Set(names).size, names.length);
  for (const r of HARDENING_RULES) {
    assert.match(r.property, /^[a-z0-9_.]+$/);
    assert.ok(r.source && r.rationale);
    assert.ok(["high", "medium", "low"].includes(r.severity));
  }
  assert.ok(HARDENING_RULES_VERSION);
});

test("a baseline with no property rows has no false fail on platform defaults", () => {
  const r = evaluateHardening(new Map());
  assert.equal(r.counts.fail, 0);
  assert.equal(r.counts.not_set, HARDENING_RULES.length);
  for (const res of r.results) {
    if (res.default !== undefined) assert.equal(res.defaultPasses, true);
  }
});

test("pass / fail / not_set per rule, with numeric ranges", () => {
  const values = new Map([
    ["a.flag", "TRUE"],
    ["b.timeout", "45"],
  ]);
  const r = evaluateHardening(values, { rules: RULES });
  const by = Object.fromEntries(r.results.map((x) => [x.property, x]));
  assert.equal(by["a.flag"].status, "pass");
  assert.equal(by["b.timeout"].status, "fail");
  assert.equal(by["b.timeout"].expected, "≤ 30");
  assert.equal(by["c.unknown_default"].status, "not_set");
  assert.equal(by["c.unknown_default"].defaultPasses, undefined);
  assert.deepEqual(r.counts, { pass: 1, fail: 1, not_set: 2, unreadable: 0 });
  assert.deepEqual(r.failed, { high: 0, medium: 0, low: 1 });

  const notSet = evaluateHardening(new Map(), { rules: RULES });
  const timeout = notSet.results.find((x) => x.property === "b.timeout");
  assert.equal(timeout.defaultPasses, false);
});

test("since / until skip a rule outside the release family", () => {
  const before = evaluateHardening(new Map(), {
    rules: RULES,
    family: "vancouver",
  });
  assert.ok(!before.results.some((x) => x.property === "d.new"));
  const after = evaluateHardening(new Map(), {
    rules: RULES,
    family: "zurich",
  });
  assert.ok(after.results.some((x) => x.property === "d.new"));
});

test("meetsExpect: non-numeric value never meets a range", () => {
  assert.equal(meetsExpect({ max: 30 }, "abc"), false);
  assert.equal(meetsExpect({ max: 30 }, ""), false);
  assert.equal(meetsExpect({ min: 8 }, " 12 "), true);
});

test("checkHardening reads every rule in one query; unreadable sys_properties degrades", async () => {
  freshRuntime();
  await withFetch(
    () =>
      jsonResponse(200, {
        result: [
          { name: "glide.security.use_csrf_token", value: "false" },
          { name: "glide.ui.session_timeout", value: "20" },
        ],
      }),
    async (calls) => {
      const r = await checkHardening();
      assert.equal(calls.length, 1);
      const q = new URL(calls[0].url).searchParams.get("sysparm_query");
      assert.match(q, /^nameIN/);
      const by = Object.fromEntries(r.results.map((x) => [x.property, x]));
      assert.equal(by["glide.security.use_csrf_token"].status, "fail");
      assert.equal(by["glide.ui.session_timeout"].status, "pass");
      assert.equal(r.failed.high, 1);
      const md = renderHardening(r).join("\n");
      assert.match(md, /\| `glide\.security\.use_csrf_token` \| fail \| high/);
    },
  );

  freshRuntime();
  await withFetch(
    () => jsonResponse(403, { error: { message: "denied" } }),
    async () => {
      const r = await checkHardening();
      assert.equal(r.available, false);
      assert.match(r.unavailableReason, /sys_properties/);
      assert.equal(r.counts.unreadable, r.results.length);
      assert.match(renderHardening(r).join("\n"), /Unavailable/);
    },
  );
});
