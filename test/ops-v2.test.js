// N-6 — `ops` v2: servicenow_read_ops kinds `integrations`
// (sys_outbound_http_log), `transactions` (syslog_transaction) and `mid`
// (ecc_agent + ecc_queue). Each section degrades on its own, the overview
// stays on the Aggregate API, rows are capped by `limit`, and logged URLs keep
// only origin and path. The table and field names are O-5-unverified, so the
// fixtures here are queued for the O-2 corpus.
import test from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import { registerPrompts } from "../build/mcp/prompts.js";
import {
  OPS_KINDS,
  OPS_TABLES,
  OPS_ECC_QUEUE,
  SLOW_MS,
  redactUrl,
} from "../build/api/ops.js";
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
    noCount: u.searchParams.get("sysparm_no_count"),
  };
}

const stats = (n) => ({ result: { stats: { count: String(n) } } });
const grouped = (field, pairs) => ({
  result: pairs.map(([value, n]) => ({
    stats: { count: String(n) },
    groupby_fields: [{ field, value }],
  })),
});
const rows = (result, headers) => jsonResponse(200, { result }, headers);
const forbidden = () => jsonResponse(403, { error: { message: "denied" } });
const notFound = () => jsonResponse(404, { error: { message: "no table" } });

/** Dictionary columns per table (the O-5 field guard reads them). */
const DICTIONARY = {
  sys_outbound_http_log: [
    "url",
    "http_method",
    "response_status",
    "response_time",
    "rest_message",
  ],
  syslog_transaction: ["url", "response_time", "sys_created_by"],
};

/**
 * A fetch double: dictionary reads answer from DICTIONARY (or `dictionary`),
 * every other request goes to `onData(q)`.
 */
function fetchDouble(onData, { dictionary = DICTIONARY } = {}) {
  return (url) => {
    const q = parse(url);
    if (q.table === "sys_db_object") return rows([]);
    if (q.table === "sys_dictionary") {
      if (dictionary === "forbidden") return forbidden();
      const table = q.query.match(/^nameIN([^^]+)/)?.[1] ?? "";
      return rows(
        (dictionary[table] ?? []).map((element) => ({
          element,
          internal_type: "string",
          name: table,
        })),
      );
    }
    return onData(q);
  };
}

const dataCalls = (calls) =>
  calls
    .map((c) => parse(c.url))
    .filter((q) => !["sys_db_object", "sys_dictionary"].includes(q.table));

// --- surface ----------------------------------------------------------------------

test("N-6: three new kinds on the existing tool, no new tool", () => {
  for (const k of ["integrations", "transactions", "mid"])
    assert.ok(OPS_KINDS.includes(k), k);
  assert.equal(OPS_TABLES.integrations, "sys_outbound_http_log");
  assert.equal(OPS_TABLES.transactions, "syslog_transaction");
  assert.equal(OPS_TABLES.mid, "ecc_agent");
  assert.equal(OPS_ECC_QUEUE, "ecc_queue");
  assert.equal(
    ALL_TOOLS.filter((t) => t.package === "ops").length,
    2,
    "ops keeps its two tools",
  );
  assert.equal(spec.annotations.readOnlyHint, true);
});

test("redactUrl: no credentials, query string or fragment", () => {
  assert.equal(
    redactUrl("https://user:secret@api.example.com/v1/items?token=abc#x"),
    "https://api.example.com/v1/items",
  );
  assert.equal(redactUrl("/incident.do?sys_id=1"), "/incident.do");
  assert.equal(
    redactUrl("ftp//u:p@host/x?y"),
    "ftp//host/x",
    "unparseable: still stripped",
  );
  assert.equal(redactUrl("  "), "");
  assert.equal(redactUrl(`https://h.example/${"a".repeat(400)}`).length, 301);
});

// --- overview ---------------------------------------------------------------------

test("overview: N-6 sections count via the Aggregate API only; ecc_queue degrades alone", async () => {
  await withFetch(
    fetchDouble((q) => {
      if (q.table === "sys_outbound_http_log") {
        assert.equal(q.api, "stats");
        if (q.query.includes("response_status>=400"))
          return jsonResponse(200, stats(3));
        if (q.query.includes(`response_time>${SLOW_MS}`))
          return jsonResponse(200, stats(2));
        return jsonResponse(200, stats(50));
      }
      if (q.table === "syslog_transaction") {
        assert.equal(q.api, "stats");
        assert.match(q.query, /response_time>5000/);
        return jsonResponse(200, stats(9));
      }
      if (q.table === "ecc_agent" && q.groupBy === "status")
        return jsonResponse(
          200,
          grouped("status", [
            ["Up", 2],
            ["Down", 1],
          ]),
        );
      if (q.table === "ecc_queue") return forbidden();
      // The S-10b sections are out of scope here.
      return forbidden();
    }),
    async (calls) => {
      const r = out(await read({ kind: "overview" }));
      const { integrations, transactions, mid } = r.sections;
      assert.equal(integrations.available, true);
      assert.equal(integrations.calls, 50);
      assert.equal(integrations.failed, 3);
      assert.equal(integrations.slow, 2);
      assert.equal(integrations.slow_ms, SLOW_MS);
      assert.equal(integrations.groups, undefined, "no rows in the overview");
      assert.equal(transactions.available, true);
      assert.equal(transactions.slow, 9);
      assert.equal(transactions.by_url, undefined);
      assert.equal(mid.available, true);
      assert.deepEqual(mid.by_status, { Up: 2, Down: 1 });
      assert.equal(mid.agents, undefined);
      assert.equal(mid.queue.available, false);
      assert.equal(mid.queue.table, "ecc_queue");
      assert.match(mid.queue.unavailableReason, /not readable/);
      assert.ok(r.caveats.some((c) => /O-5/.test(c)));
      const data = dataCalls(calls).filter((q) => N6_DATA.has(q.table));
      assert.ok(data.length > 0);
      assert.ok(
        data.every((q) => q.api === "stats"),
        "overview reads no rows",
      );
    },
  );
});

const N6_DATA = new Set([
  "sys_outbound_http_log",
  "syslog_transaction",
  "ecc_agent",
  "ecc_queue",
]);

// --- integrations -----------------------------------------------------------------

const CALLS = [
  {
    sys_created_on: "2026-10-03 10:00:00",
    url: "https://svc:pw@api.example.com/v1/orders?apikey=SECRET",
    http_method: "post",
    response_status: "500",
    response_time: "1200",
    rest_message: "Orders",
  },
  {
    sys_created_on: "2026-10-03 09:59:00",
    url: "https://api.example.com/v1/orders/42?apikey=SECRET",
    http_method: "get",
    response_status: "200",
    response_time: "9000",
    rest_message: "Orders",
  },
  {
    sys_created_on: "2026-10-03 09:58:00",
    url: "https://hr.example.net/api/people",
    http_method: "get",
    response_status: "401",
    response_time: "80",
    rest_message: "",
  },
];

test("integrations: failed and slow calls grouped by host and REST message, URLs redacted", async () => {
  await withFetch(
    fetchDouble((q) => {
      if (q.api === "stats") return jsonResponse(200, stats(7));
      return rows(CALLS);
    }),
    async (calls) => {
      const r = out(
        await read({ kind: "integrations", minutes: 30, limit: 3 }),
      );
      assert.equal(r.kind, "integrations");
      assert.equal(r.table, "sys_outbound_http_log");
      assert.equal(r.available, true);
      assert.equal(r.window_minutes, 30);
      assert.equal(r.rows_read, 3);
      assert.equal(r.truncated, true);
      assert.equal(r.unverified_fields, undefined);
      assert.equal(r.groups.length, 2);
      const orders = r.groups[0];
      assert.equal(orders.host, "api.example.com");
      assert.equal(orders.rest_message, "Orders");
      assert.equal(orders.calls, 2);
      assert.equal(orders.failed, 1);
      assert.equal(orders.slow, 1);
      assert.equal(orders.max_ms, 9000);
      assert.deepEqual(orders.statuses, { 500: 1, 200: 1 });
      assert.deepEqual(orders.urls, [
        "https://api.example.com/v1/orders",
        "https://api.example.com/v1/orders/42",
      ]);
      assert.equal(r.groups[1].host, "hr.example.net");
      assert.doesNotMatch(JSON.stringify(r), /SECRET|svc:pw/);
      const list = dataCalls(calls).find((q) => q.api === "table");
      assert.equal(
        list.query,
        `sys_created_on>javascript:gs.minutesAgoStart(30)^response_status>=400^ORresponse_time>${SLOW_MS}^ORDERBYDESCsys_created_on`,
      );
      assert.equal(list.limit, "3");
      assert.equal(list.noCount, "true");
      assert.ok(r.caveats.some((c) => /sys_outbound_http_log/.test(c)));
    },
  );
});

test("integrations: an empty log is flagged, not reported as healthy", async () => {
  await withFetch(
    fetchDouble((q) =>
      q.api === "stats" ? jsonResponse(200, stats(0)) : rows([]),
    ),
    async () => {
      const r = out(await read({ kind: "integrations" }));
      assert.equal(r.calls, 0);
      assert.match(r.note, /logging may be off/);
      assert.deepEqual(r.groups, []);
      assert.equal(r.truncated, false);
    },
  );
});

test("integrations: a filter field missing from the dictionary degrades (O-5 guard)", async () => {
  await withFetch(
    fetchDouble(
      () => {
        throw new Error("no data read expected");
      },
      { dictionary: { sys_outbound_http_log: ["url", "response_time"] } },
    ),
    async (calls) => {
      const res = await read({ kind: "integrations" });
      assert.notEqual(res.isError, true);
      const r = out(res);
      assert.equal(r.available, false);
      assert.equal(r.table, "sys_outbound_http_log");
      assert.match(r.unavailableReason, /response_status.*O-5/);
      assert.equal(dataCalls(calls).length, 0);
    },
  );
});

test("integrations: an unreadable dictionary leaves the fields flagged as unverified", async () => {
  await withFetch(
    fetchDouble(
      (q) => (q.api === "stats" ? jsonResponse(200, stats(1)) : rows([])),
      { dictionary: "forbidden" },
    ),
    async () => {
      const r = out(await read({ kind: "integrations" }));
      assert.equal(r.available, true);
      assert.deepEqual(r.unverified_fields, [
        "response_status",
        "response_time",
      ]);
    },
  );
});

test("integrations: a missing table (plugin / logging off) reports available:false", async () => {
  await withFetch(
    fetchDouble(() => notFound(), { dictionary: {} }),
    async () => {
      const r = out(await read({ kind: "integrations" }));
      assert.equal(r.available, false);
      assert.match(r.unavailableReason, /does not exist/);
    },
  );
});

// --- transactions -----------------------------------------------------------------

test("transactions: slow transactions grouped by URL without the query string", async () => {
  await withFetch(
    fetchDouble((q) => {
      if (q.api === "stats") return jsonResponse(200, stats(4));
      return rows([
        {
          url: "/incident.do?sys_id=1",
          response_time: "12000",
          sys_created_by: "alice",
        },
        {
          url: "/incident.do?sys_id=2",
          response_time: "6000",
          sys_created_by: "bob",
        },
        {
          url: "/incident.do?sys_id=3",
          response_time: "7000",
          sys_created_by: "alice",
        },
        {
          url: "/api/now/table/task?sysparm_query=x",
          response_time: "30000",
          sys_created_by: "integration",
        },
      ]);
    }),
    async (calls) => {
      const r = out(await read({ kind: "transactions", limit: 10 }));
      assert.equal(r.table, "syslog_transaction");
      assert.equal(r.slow, 4);
      assert.equal(r.rows_read, 4);
      assert.equal(r.truncated, false);
      assert.deepEqual(r.by_url[0], {
        url: "/incident.do",
        count: 3,
        avg_ms: 8333,
        max_ms: 12000,
        users: 2,
      });
      assert.deepEqual(r.by_url[1], {
        url: "/api/now/table/task",
        count: 1,
        avg_ms: 30000,
        max_ms: 30000,
        users: 1,
      });
      assert.doesNotMatch(JSON.stringify(r), /alice|sys_id=/);
      const list = dataCalls(calls).find((q) => q.api === "table");
      assert.equal(
        list.query,
        `sys_created_on>javascript:gs.minutesAgoStart(60)^response_time>${SLOW_MS}^ORDERBYDESCresponse_time`,
      );
      assert.equal(list.limit, "10");
    },
  );
});

test("transactions: an unreadable table degrades alone", async () => {
  await withFetch(
    fetchDouble(() => forbidden()),
    async () => {
      const r = out(await read({ kind: "transactions" }));
      assert.equal(r.available, false);
      assert.equal(r.table, "syslog_transaction");
      assert.match(r.unavailableReason, /not readable/);
    },
  );
});

// --- mid ---------------------------------------------------------------------------

test("mid: agents, ready backlog and recent errors by agent", async () => {
  await withFetch(
    fetchDouble((q) => {
      if (q.table === "ecc_agent" && q.api === "stats")
        return jsonResponse(200, grouped("status", [["Up", 1]]));
      if (q.table === "ecc_agent")
        return rows(
          [
            {
              sys_id: "a".repeat(32),
              name: "mid1",
              status: "Up",
              version: "zurich-07-01-2026",
              last_refreshed: "2026-10-03 10:00:00",
              host_name: "midhost",
            },
          ],
          { "X-Total-Count": "1" },
        );
      if (q.api === "stats" && q.query === "state=ready")
        return jsonResponse(
          200,
          grouped("agent", [
            ["mid.server.mid1", 40],
            ["mid.server.mid2", 2],
          ]),
        );
      if (q.api === "stats")
        return jsonResponse(200, grouped("agent", [["mid.server.mid1", 1]]));
      if (q.query.startsWith("state=ready"))
        return rows([{ sys_created_on: "2026-10-03 08:00:00" }]);
      return rows([
        {
          sys_id: "b".repeat(32),
          sys_created_on: "2026-10-03 09:00:00",
          agent: "mid.server.mid1",
          queue: "input",
          topic: "Discovery",
          name: "probe",
          error_string: "x".repeat(800),
        },
      ]);
    }),
    async (calls) => {
      const r = out(await read({ kind: "mid", limit: 5 }));
      assert.equal(r.table, "ecc_agent");
      assert.equal(r.available, true);
      assert.deepEqual(r.by_status, { Up: 1 });
      assert.equal(r.agents[0].name, "mid1");
      assert.equal(r.agents[0].version, "zurich-07-01-2026");
      assert.equal(r.truncated, false);
      const queue = r.queue;
      assert.equal(queue.available, true);
      assert.equal(queue.ready, 42);
      assert.deepEqual(queue.ready_by_agent, { mid1: 40, mid2: 2 });
      assert.deepEqual(queue.errors_by_agent, { mid1: 1 });
      assert.equal(queue.errors_in_window, 1);
      assert.equal(queue.oldest_ready, "2026-10-03 08:00:00");
      assert.equal(queue.errors[0].agent, "mid1");
      assert.equal(queue.errors[0].error.length, 501);
      const errors = dataCalls(calls).find(
        (q) => q.api === "table" && q.query.startsWith("state=error"),
      );
      assert.match(errors.query, /ORDERBYDESCsys_created_on$/);
      assert.equal(errors.limit, "5");
    },
  );
});

test("mid: ecc_queue unreadable keeps the agents; ecc_agent unreadable fails the section", async () => {
  await withFetch(
    fetchDouble((q) => {
      if (q.table === OPS_ECC_QUEUE) return forbidden();
      if (q.api === "stats") return jsonResponse(200, grouped("status", []));
      return rows([]);
    }),
    async () => {
      const r = out(await read({ kind: "mid" }));
      assert.equal(r.available, true);
      assert.deepEqual(r.agents, []);
      assert.equal(r.queue.available, false);
      assert.equal(r.queue.table, "ecc_queue");
    },
  );
  freshRuntime();
  await withFetch(
    fetchDouble((q) =>
      q.table === "ecc_agent" ? notFound() : jsonResponse(200, stats(0)),
    ),
    async () => {
      const r = out(await read({ kind: "mid" }));
      assert.equal(r.available, false);
      assert.equal(r.table, "ecc_agent");
      assert.match(r.unavailableReason, /does not exist/);
    },
  );
});

// --- limits -----------------------------------------------------------------------

test("N-6 kinds honour the limit bounds", async () => {
  // The SDK validates the input schema before the handler runs.
  assert.equal(spec.input.limit.safeParse(201).success, false);
  assert.equal(spec.input.limit.safeParse(200).success, true);
  assert.equal(spec.input.minutes.safeParse(1441).success, false);
  await withFetch(
    fetchDouble((q) =>
      q.api === "stats" ? jsonResponse(200, stats(0)) : rows([]),
    ),
    async (calls) => {
      await read({ kind: "transactions" });
      const list = dataCalls(calls).find((q) => q.api === "table");
      assert.equal(list.limit, "25", "default limit");
    },
  );
});

// --- prompt ---------------------------------------------------------------------

test("why_is_it_slow prompt: uses the transactions and integrations kinds", async () => {
  const server = new McpServer({ name: "t", version: "0.0.0" });
  registerPrompts(server);
  const client = new Client({ name: "c", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const { messages } = await client.getPrompt({
      name: "servicenow_why_is_it_slow",
      arguments: {},
    });
    const text = messages[0].content.text;
    assert.match(text, /servicenow_read_ops kind 'transactions'/);
    assert.match(text, /servicenow_read_ops kind 'integrations'/);
    assert.match(text, /kind 'mid'/);
  } finally {
    await client.close();
    await server.close();
  }
});
