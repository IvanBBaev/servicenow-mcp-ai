// N-16 — ATF result history: last result, pass rate, flaky.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  DEFAULT_WINDOW,
  FLAKY_MIN_FLIPS,
  HISTORY_ROW_LIMIT,
  MAX_WINDOW,
  atfResultHistory,
  clampWindow,
  outcomeOf,
  renderAtfHistory,
  summariseResults,
  withAtfResults,
} from "../build/api/atf-history.js";
import {
  baselineEnv,
  fcParams,
  freshRuntime,
  jsonResponse,
  withFetch,
} from "./helpers.js";

baselineEnv();

const T1 = "1".repeat(32);
const T2 = "2".repeat(32);
const S1 = "5".repeat(32);

/** Rows oldest → newest from a status list (start times one minute apart). */
const runs = (statuses) =>
  statuses.map((status, i) => ({
    status,
    startTime: `2026-10-01 10:${String(i).padStart(2, "0")}:00`,
  }));

function tables(over = {}) {
  return (url) => {
    const u = new URL(url);
    const table = u.pathname.split("/").pop();
    if (over[table]) return over[table](u);
    return jsonResponse(404, { error: { message: `Invalid table ${table}` } });
  };
}

test("outcomes and window clamping", () => {
  assert.equal(outcomeOf("success"), "pass");
  assert.equal(outcomeOf("Failure"), "fail");
  assert.equal(outcomeOf("error"), "fail");
  assert.equal(outcomeOf("skipped"), "other");
  assert.equal(outcomeOf("cancelled"), "other");
  assert.equal(outcomeOf(""), "other");
  assert.equal(clampWindow(undefined), DEFAULT_WINDOW);
  assert.equal(clampWindow(0), 1);
  assert.equal(clampWindow(10_000), MAX_WINDOW);
  assert.equal(clampWindow(Number.NaN), DEFAULT_WINDOW);
});

test("summary: last result, pass rate, flips and flaky", () => {
  const stable = summariseResults(runs(["success", "success", "failure"]));
  assert.equal(stable.runs, 3);
  assert.equal(stable.last.status, "failure");
  assert.equal(stable.last.outcome, "fail");
  assert.equal(stable.passRate, 2 / 3);
  assert.equal(stable.flips, 1);
  assert.equal(stable.flaky, false, "one break is not flaky");

  const flaky = summariseResults(
    runs(["success", "failure", "skipped", "success"]),
  );
  assert.equal(flaky.flips, FLAKY_MIN_FLIPS);
  assert.equal(flaky.other, 1);
  assert.equal(flaky.flaky, true);

  const none = summariseResults([]);
  assert.equal(none.runs, 0);
  assert.equal(none.passRate, null);
  assert.equal(none.last, undefined);
  assert.equal(none.flaky, false);

  // Only the newest `window` runs count.
  const windowed = summariseResults(
    runs(["failure", "success", "failure", "success", "success"]),
    2,
  );
  assert.equal(windowed.runs, 2);
  assert.equal(windowed.passRate, 1);
  assert.equal(windowed.flaky, false);
});

const statusArb = fc.constantFrom(
  "success",
  "failure",
  "error",
  "skipped",
  "cancelled",
  "running",
);
const rowsArb = fc.array(
  fc.record({
    status: statusArb,
    startTime: fc
      .integer({ min: 0, max: 1_000_000 })
      .map((n) => `2026-01-01 ${String(n).padStart(7, "0")}`),
  }),
  { maxLength: 60 },
);

test("property: summary invariants hold for any rows and window", () => {
  fc.assert(
    fc.property(rowsArb, fc.integer({ min: 1, max: 50 }), (rows, window) => {
      const s = summariseResults(rows, window);
      assert.ok(s.runs <= window && s.runs <= rows.length);
      assert.equal(s.runs, Math.min(window, rows.length));
      assert.equal(s.passed + s.failed + s.other, s.runs);
      if (s.passRate !== null) {
        assert.ok(s.passRate >= 0 && s.passRate <= 1);
      } else {
        assert.equal(s.passed + s.failed, 0);
      }
      assert.ok(s.flips <= Math.max(0, s.passed + s.failed - 1));
      if (s.flaky) {
        assert.ok(s.passed > 0 && s.failed > 0);
        assert.ok(s.flips >= FLAKY_MIN_FLIPS);
      }
      if (s.runs > 0) {
        const newest = rows.reduce((a, b) =>
          b.startTime > a.startTime ? b : a,
        );
        assert.equal(s.last.at, newest.startTime);
      } else {
        assert.equal(s.last, undefined);
      }
    }),
    fcParams(),
  );
});

test("property: the summary does not depend on the row order", () => {
  const distinct = fc.uniqueArray(
    fc.record({
      status: statusArb,
      startTime: fc
        .integer({ min: 0, max: 1_000_000 })
        .map((n) => String(n).padStart(7, "0")),
    }),
    { selector: (r) => r.startTime, maxLength: 40 },
  );
  fc.assert(
    fc.property(distinct, fc.integer({ min: 1, max: 30 }), (rows, window) => {
      const reversed = [...rows].reverse();
      assert.deepEqual(
        summariseResults(rows, window),
        summariseResults(reversed, window),
      );
    }),
    fcParams(),
  );
});

test("history: one bounded IN query per section, newest first", async () => {
  freshRuntime();
  await withFetch(
    tables({
      sys_atf_test_result: () =>
        jsonResponse(200, {
          result: [
            {
              test: T1,
              status: "success",
              start_time: "2026-10-03 00:00:00",
              run_time: "00:00:12",
              parent: "9".repeat(32),
            },
            {
              test: T1,
              status: "failure",
              start_time: "2026-10-02 00:00:00",
            },
            { test: T1, status: "success", start_time: "2026-10-01 00:00:00" },
            { test: "f".repeat(32), status: "success", start_time: "x" },
          ],
        }),
      sys_atf_test_suite_result: () =>
        jsonResponse(200, {
          result: [
            { test_suite: S1, status: "error", start_time: "2026-10-03" },
          ],
        }),
    }),
    async (calls) => {
      const h = await atfResultHistory({
        testIds: [T1, T2, T1],
        suiteIds: [S1],
        window: 5,
      });
      assert.equal(h.window, 5);
      assert.equal(calls.length, 2);
      const q = new URL(calls[0].url).searchParams;
      assert.equal(
        q.get("sysparm_query"),
        `testIN${T1},${T2}^ORDERBYDESCstart_time`,
      );
      assert.equal(q.get("sysparm_limit"), "10");
      assert.match(q.get("sysparm_fields"), /parent/);
      assert.match(
        new URL(calls[1].url).searchParams.get("sysparm_query"),
        new RegExp(`^test_suiteIN${S1}\\^ORDERBYDESCstart_time$`),
      );

      assert.equal(h.tests.available, true);
      assert.equal(h.tests.scanned, 4);
      assert.equal(h.tests.truncated, false);
      assert.deepEqual(Object.keys(h.tests.summaries), [T1, T2]);
      const t1 = h.tests.summaries[T1];
      assert.equal(t1.runs, 3);
      assert.equal(t1.last.status, "success");
      assert.equal(t1.last.runTime, "00:00:12");
      assert.equal(t1.last.suiteResult, "9".repeat(32));
      assert.equal(t1.flips, 2);
      assert.equal(t1.flaky, true);
      assert.equal(h.tests.summaries[T2].runs, 0);
      assert.equal(h.suites.summaries[S1].last.outcome, "fail");

      const md = renderAtfHistory(h, { [T1]: "Login | smoke" }).join("\n");
      assert.match(md, /## Tests/);
      assert.match(md, /## Suites/);
      assert.match(md, /Login \\\| smoke \| success \|/);
      assert.match(md, /never run/);
      assert.match(md, /yes \(2 flips\)/);
      assert.match(md, /unverified until O-5/);
    },
  );
});

test("history: the row limit caps the read and marks it truncated", async () => {
  freshRuntime();
  const ids = Array.from({ length: 100 }, (_, i) =>
    i.toString(16).padStart(32, "0"),
  );
  await withFetch(
    tables({
      sys_atf_test_result: (u) => {
        const n = Number(u.searchParams.get("sysparm_limit"));
        return jsonResponse(200, {
          result: Array.from({ length: n }, () => ({
            test: ids[0],
            status: "success",
            start_time: "2026-10-01",
          })),
        });
      },
    }),
    async (calls) => {
      const h = await atfResultHistory({ testIds: ids, window: 50 });
      assert.equal(
        new URL(calls[0].url).searchParams.get("sysparm_limit"),
        String(HISTORY_ROW_LIMIT),
      );
      assert.equal(h.tests.truncated, true);
      assert.equal(h.tests.summaries[ids[0]].runs, 50);
    },
  );
});

test("history: bad ids and failed reads degrade per section, never throw", async () => {
  freshRuntime();
  await withFetch(
    tables({
      sys_atf_test_suite_result: () =>
        jsonResponse(403, { error: { message: "ACL" } }),
    }),
    async (calls) => {
      const bad = await atfResultHistory({ testIds: ["nope"] });
      assert.equal(bad.tests.available, false);
      assert.match(bad.tests.unavailableReason, /not a sys_id/);
      assert.equal(calls.length, 0);

      const tooMany = await atfResultHistory({
        testIds: Array.from({ length: 101 }, (_, i) =>
          i.toString(16).padStart(32, "0"),
        ),
      });
      assert.match(tooMany.tests.unavailableReason, /At most 100/);

      const empty = await atfResultHistory({ testIds: [] });
      assert.deepEqual(empty.tests.summaries, {});
      assert.equal(calls.length, 0);

      const h = await atfResultHistory({ testIds: [T1], suiteIds: [S1] });
      assert.equal(h.tests.available, false);
      assert.match(h.tests.unavailableReason, /sys_atf_test_result/);
      assert.equal(h.suites.available, false);
      assert.match(h.suites.unavailableReason, /not readable.*403/);
      const md = renderAtfHistory(h).join("\n");
      assert.match(md, /Unavailable: sys_atf_test_suite_result/);
      assert.deepEqual(renderAtfHistory({ window: 20 }), [
        "_No tests or suites requested._",
      ]);
    },
  );
});

test("withAtfResults merges summaries onto list items by sys_id", () => {
  const list = [
    { sys_id: T1, name: "Login" },
    { sys_id: T2, name: "Logout" },
    { name: "no id" },
  ];
  const section = {
    available: true,
    summaries: { [T1]: summariseResults(runs(["success"])) },
    scanned: 1,
    truncated: false,
  };
  const merged = withAtfResults(list, section);
  assert.equal(merged[0].results.passRate, 1);
  assert.equal(merged[0].name, "Login");
  assert.equal("results" in merged[1], false);
  assert.equal("results" in merged[2], false);
  assert.notEqual(merged[0], list[0], "items are copied, not mutated");

  const off = { available: false, unavailableReason: "x" };
  assert.deepEqual(withAtfResults(list, off), list);
  assert.deepEqual(withAtfResults(list, undefined), list);
});
