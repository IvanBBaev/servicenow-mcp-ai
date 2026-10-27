// N-69 — `ops`: the `events` kind of servicenow_read_ops reads the event queue
// (`sysevent`): the all-time ready backlog and its oldest entry, the events
// fired in the window by state and by name, and (single kind only) the newest
// rows. The section degrades alone, the overview stays on the Aggregate API
// and the parameters are clipped. Table and columns verified on a PDI
// (O-5, 2026-10-27).
import test from "node:test";
import assert from "node:assert/strict";

import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import { OPS_KINDS, OPS_TABLES } from "../build/api/ops.js";
import {
  baselineEnv,
  freshRuntime,
  withFetch,
  jsonResponse,
} from "./helpers.js";

baselineEnv();
test.beforeEach(() => freshRuntime());

const spec = ALL_TOOLS.find((s) => s.name === "servicenow_read_ops");
const read = (args) => runSpec(spec, args);
const out = (res) => JSON.parse(res.content[0].text);

function parse(url) {
  const u = new URL(url);
  const m = u.pathname.match(/^\/api\/now\/(table|stats)\/([^/]+)/);
  return {
    api: m?.[1],
    table: m ? decodeURIComponent(m[2]) : "",
    query: u.searchParams.get("sysparm_query") ?? "",
    groupBy: u.searchParams.get("sysparm_group_by") ?? "",
    limit: u.searchParams.get("sysparm_limit"),
    fields: u.searchParams.get("sysparm_fields") ?? "",
  };
}

const stats = (n) =>
  jsonResponse(200, { result: { stats: { count: String(n) } } });
const grouped = (field, pairs) =>
  jsonResponse(200, {
    result: pairs.map(([value, n]) => ({
      stats: { count: String(n) },
      groupby_fields: [{ field, value }],
    })),
  });
const rows = (result) => jsonResponse(200, { result });
const forbidden = () => jsonResponse(403, { error: { message: "denied" } });

const WINDOW = "sys_created_on>javascript:gs.minutesAgoStart(60)";
const ROW_QUERY = `${WINDOW}^ORDERBYDESCsys_created_on`;
const ROW_RE =
  /^sys_created_on>javascript:gs\.minutesAgoStart\(\d+\)\^ORDERBYDESCsys_created_on$/;

const NAMES = Array.from({ length: 12 }, (_, i) => [
  `table_${i}.inserted`,
  100 - i,
]);

const EVENT = {
  sys_id: "e1",
  sys_created_on: "2026-10-27 09:00:00",
  name: "incident.updated",
  table: "incident",
  state: "ready",
  queue: "",
  process_on: "2026-10-27 09:00:00",
  processed: "",
  processing_duration: "",
  claimed_by: "",
  user_name: "admin",
  parm1: "a".repeat(300),
  parm2: "p2",
};

/** A fetch double for `sysevent`; metadata reads answer empty. */
function eventsDouble({ ready = 4, eventRows = [EVENT] } = {}) {
  return (url) => {
    const q = parse(url);
    if (q.table === "sys_db_object" || q.table === "sys_dictionary")
      return rows([]);
    assert.equal(q.table, "sysevent", `unexpected ${url}`);
    if (q.api === "stats") {
      if (q.groupBy === "state")
        return grouped("state", [
          ["processed", 120],
          ["ready", ready],
          ["error", 1],
        ]);
      if (q.groupBy === "name") return grouped("name", NAMES);
      assert.equal(q.query, "state=ready");
      return stats(ready);
    }
    if (q.limit === "1") {
      assert.equal(q.query, "state=ready^ORDERBYsys_created_on");
      return rows([{ sys_created_on: "2026-10-27 08:00:00" }]);
    }
    assert.match(q.query, ROW_RE);
    return rows(eventRows);
  };
}

const dataCalls = (calls) =>
  calls.map((c) => parse(c.url)).filter((q) => q.table === "sysevent");

// --- surface ----------------------------------------------------------------------

test("N-69: the events kind on the existing tool, no new tool", () => {
  assert.ok(OPS_KINDS.includes("events"));
  assert.equal(OPS_TABLES.events, "sysevent");
  assert.equal(ALL_TOOLS.filter((t) => t.package === "ops").length, 2);
  assert.match(spec.description, /events/);
});

// --- single kind ------------------------------------------------------------------

test("events: backlog, oldest entry, window tallies, top names and the newest rows", async () => {
  await withFetch(eventsDouble(), async (calls) => {
    const r = out(await read({ kind: "events" }));
    assert.equal(r.kind, "events");
    assert.equal(r.available, true);
    assert.equal(r.table, "sysevent");
    assert.equal(r.window_minutes, 60);
    assert.equal(r.ready, 4);
    assert.equal(r.oldest_ready, "2026-10-27 08:00:00");
    assert.deepEqual(r.by_state_in_window, {
      processed: 120,
      ready: 4,
      error: 1,
    });
    assert.equal(r.top_names.length, 10, "capped at the top 10 names");
    assert.deepEqual(r.top_names[0], { name: "table_0.inserted", count: 100 });
    assert.equal(r.count, 1);
    assert.equal(r.truncated, false);
    const [e] = r.events;
    assert.equal(e.sys_id, "e1");
    assert.equal(e.created_on, "2026-10-27 09:00:00");
    assert.equal(e.name, "incident.updated");
    assert.equal(e.table, "incident");
    assert.equal(e.state, "ready");
    assert.equal(e.user_name, "admin");
    assert.equal(e.parm2, "p2");
    assert.ok(e.parm1.length < 300, "parm1 is clipped");
    assert.ok(e.parm1.startsWith("a".repeat(100)));
    assert.ok(r.caveats.some((c) => /sysevent/.test(c)));
    assert.ok(r.caveats.some((c) => /email_queue/.test(c)));
    const q = dataCalls(calls);
    const stateCount = q.find((c) => c.groupBy === "state");
    assert.ok(stateCount.query.startsWith(WINDOW), "tallies are windowed");
    const rowRead = q.find((c) => c.api === "table" && c.limit !== "1");
    assert.equal(rowRead.query, ROW_QUERY);
    assert.equal(rowRead.limit, "25");
    assert.match(rowRead.fields, /processing_duration/);
    assert.match(rowRead.fields, /parm2/);
  });
});

test("events: no ready backlog skips the oldest-entry read; limit sets truncated", async () => {
  await withFetch(
    eventsDouble({ ready: 0, eventRows: [EVENT, { ...EVENT, sys_id: "e2" }] }),
    async (calls) => {
      const r = out(await read({ kind: "events", limit: 2, minutes: 15 }));
      assert.equal(r.ready, 0);
      assert.equal("oldest_ready" in r, false);
      assert.equal(r.count, 2);
      assert.equal(r.truncated, true);
      assert.equal(r.window_minutes, 15);
      const q = dataCalls(calls);
      assert.ok(!q.some((c) => c.limit === "1"), "no oldest read");
      assert.ok(
        q.some((c) => c.query.includes("minutesAgoStart(15)")),
        "the window follows minutes",
      );
    },
  );
});

test("events: an unreadable sysevent degrades alone", async () => {
  await withFetch(
    () => forbidden(),
    async () => {
      const r = out(await read({ kind: "events" }));
      assert.equal(r.available, false);
      assert.equal(r.table, "sysevent");
      assert.match(r.unavailableReason, /not readable/);
      assert.equal(r.kind, "events");
    },
  );
});

// --- overview ---------------------------------------------------------------------

test("overview: the events section counts via the Aggregate API only", async () => {
  await withFetch(
    (url) => {
      const q = parse(url);
      if (q.table === "sysevent") {
        assert.equal(q.api, "stats", "overview reads no rows");
        if (q.groupBy === "state") return grouped("state", [["processed", 9]]);
        if (q.groupBy === "name")
          return grouped("name", [["incident.inserted", 9]]);
        return stats(0);
      }
      // The other sections are covered elsewhere: unreadable here.
      return forbidden();
    },
    async (calls) => {
      const r = out(await read({ kind: "overview" }));
      const { events } = r.sections;
      assert.equal(events.available, true);
      assert.equal(events.ready, 0);
      assert.deepEqual(events.by_state_in_window, { processed: 9 });
      assert.deepEqual(events.top_names, [
        { name: "incident.inserted", count: 9 },
      ]);
      assert.equal(events.events, undefined, "no rows in the overview");
      assert.equal(events.count, undefined);
      assert.ok(r.caveats.some((c) => /sysevent backlog/.test(c)));
      assert.ok(dataCalls(calls).every((q) => q.api === "stats"));
    },
  );
});
