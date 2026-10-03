// S-10b — the opt-in `ops` package: servicenow_read_ops (syslog, scheduler
// queue, outbound email queue, semaphores; per-section degradation) and
// servicenow_check_data_health (duplicates, orphaned and stale references), plus the
// servicenow_why_is_it_slow prompt.
import test from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { runSpec } from "../build/mcp/define.js";
import {
  ALL_TOOLS,
  PACKAGES,
  resolveEnabledPackages,
} from "../build/mcp/registry.js";
import { registerPrompts } from "../build/mcp/prompts.js";
import { OPS_TABLES } from "../build/api/ops.js";
import {
  baselineEnv,
  freshRuntime,
  withFetch,
  jsonResponse,
} from "./helpers.js";

baselineEnv();
test.beforeEach(() => freshRuntime());

const tool = (name) => {
  const spec = ALL_TOOLS.find((s) => s.name === name);
  assert.ok(spec, `missing tool ${name}`);
  return spec;
};
const call = (name, args) => runSpec(tool(name), args);
const out = (res) => JSON.parse(res.content[0].text);

/** Split a mocked request into its API, table and query parameters. */
function parse(url) {
  const u = new URL(url);
  const m = u.pathname.match(/^\/api\/now\/(table|stats)\/([^/]+)/);
  return {
    api: m?.[1],
    table: m ? decodeURIComponent(m[2]) : "",
    query: u.searchParams.get("sysparm_query") ?? "",
    groupBy: u.searchParams.get("sysparm_group_by") ?? "",
    having: u.searchParams.get("sysparm_having") ?? "",
    limit: u.searchParams.get("sysparm_limit"),
    noCount: u.searchParams.get("sysparm_no_count"),
  };
}

const stats = (count) => ({ result: { stats: { count: String(count) } } });

/** A grouped stats body for one field. */
const grouped = (field, pairs) => ({
  result: pairs.map(([value, n]) => ({
    stats: { count: String(n) },
    groupby_fields: [{ field, value }],
  })),
});

const forbidden = () => jsonResponse(403, { error: { message: "denied" } });

// --- registry / annotations ---------------------------------------------------

test("ops package: two read-only tools with all four hints", () => {
  const pkg = PACKAGES.find((p) => p.name === "ops");
  assert.ok(pkg);
  assert.deepEqual(pkg.tools.map((t) => t.name).sort(), [
    "servicenow_check_data_health",
    "servicenow_read_ops",
  ]);
  for (const t of pkg.tools) {
    assert.deepEqual(t.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  }
});

test("ops package is opt-in: not in core, reader or developer", () => {
  for (const preset of ["core", "reader", "developer"]) {
    assert.ok(!resolveEnabledPackages([preset]).has("ops"), preset);
  }
  assert.ok(resolveEnabledPackages(["all"]).has("ops"));
  assert.ok(resolveEnabledPackages(["ops"]).has("ops"));
});

// --- overview -------------------------------------------------------------------

test("overview: counts from every section; one unreadable table degrades alone", async () => {
  await withFetch(
    (url) => {
      const q = parse(url);
      if (q.table === "sys_semaphore") return forbidden();
      if (q.table === "syslog" && q.groupBy === "level")
        return jsonResponse(
          200,
          grouped("level", [
            ["2", 7],
            ["1", 3],
            ["0", 40],
          ]),
        );
      if (q.table === "syslog" && q.groupBy === "source")
        return jsonResponse(
          200,
          grouped("source", [
            ["Evaluator", 6],
            ["SMTP", 4],
          ]),
        );
      if (q.table === "sys_trigger" && q.groupBy === "state")
        return jsonResponse(
          200,
          grouped("state", [
            ["0", 100],
            ["1", 4],
            ["9", 1],
          ]),
        );
      if (q.table === "sys_trigger") return jsonResponse(200, stats(12));
      if (q.table === "sys_email" && q.api === "stats" && !q.groupBy)
        return jsonResponse(200, stats(0));
      if (q.table === "sys_email" && q.groupBy === "type")
        return jsonResponse(200, grouped("type", [["sent", 30]]));
      throw new Error(`unexpected ${url}`);
    },
    async (calls) => {
      const r = out(await call("servicenow_read_ops", { kind: "overview" }));
      assert.equal(r.kind, "overview");
      assert.equal(r.window_minutes, 60);
      const { syslog, jobs, email_queue, semaphores } = r.sections;
      assert.equal(syslog.available, true);
      assert.deepEqual(syslog.by_level, { error: 7, warning: 3, info: 40 });
      assert.deepEqual(syslog.top_sources[0], {
        source: "Evaluator",
        count: 6,
      });
      assert.equal(syslog.rows, undefined);
      assert.deepEqual(jobs.by_state, { ready: 100, running: 4, 9: 1 });
      assert.equal(jobs.overdue, 12);
      assert.equal(email_queue.ready, 0);
      assert.equal(email_queue.oldest_ready, undefined);
      assert.deepEqual(email_queue.by_type_in_window, { sent: 30 });
      assert.equal(semaphores.available, false);
      assert.equal(semaphores.table, "sys_semaphore");
      assert.match(semaphores.unavailableReason, /not readable/);
      // No row read in the overview: only the Aggregate API.
      assert.ok(calls.every((c) => parse(c.url).api === "stats"));
      // The source summary filters on "warning or worse".
      const src = calls
        .map((c) => parse(c.url))
        .find((q) => q.groupBy === "source");
      assert.match(src.query, /levelIN2,1(\^|$)/);
      assert.match(
        src.query,
        /sys_created_on>javascript:gs\.minutesAgoStart\(60\)/,
      );
    },
  );
});

// --- syslog -------------------------------------------------------------------

test("syslog: rows at or above level with a source filter, messages clipped", async () => {
  const long = "x".repeat(900);
  await withFetch(
    (url) => {
      const q = parse(url);
      if (q.api === "stats")
        return jsonResponse(200, grouped(q.groupBy, [["2", 1]]));
      return jsonResponse(200, {
        result: [
          {
            sys_created_on: "2026-09-26 10:00:00",
            level: "2",
            source: "Evaluator",
            message: long,
            sys_created_by: "system",
          },
        ],
      });
    },
    async (calls) => {
      const r = out(
        await call("servicenow_read_ops", {
          kind: "syslog",
          level: "error",
          source: "Eval",
          minutes: 15,
          limit: 1,
        }),
      );
      assert.equal(r.kind, "syslog");
      assert.equal(r.table, "syslog");
      assert.equal(r.available, true);
      assert.equal(r.level, "error");
      assert.equal(r.source, "Eval");
      assert.equal(r.count, 1);
      assert.equal(r.truncated, true);
      assert.equal(r.rows[0].level, "error");
      assert.equal(r.rows[0].message.length, 501);
      const rows = calls
        .map((c) => parse(c.url))
        .find((q) => q.api === "table");
      assert.equal(
        rows.query,
        "sys_created_on>javascript:gs.minutesAgoStart(15)^levelIN2^sourceLIKEEval^ORDERBYDESCsys_created_on",
      );
      assert.equal(rows.noCount, "true");
      assert.equal(rows.limit, "1");
    },
  );
});

test("syslog: level debug drops the level filter; unknown level values pass through", async () => {
  await withFetch(
    (url) => {
      const q = parse(url);
      if (q.api === "stats")
        return jsonResponse(200, grouped(q.groupBy, [["7", 2]]));
      return jsonResponse(200, { result: [{ level: "7", message: "m" }] });
    },
    async (calls) => {
      const r = out(
        await call("servicenow_read_ops", { kind: "syslog", level: "debug" }),
      );
      assert.deepEqual(r.by_level, { 7: 2 });
      assert.equal(r.rows[0].level, "7");
      assert.equal(r.truncated, false);
      for (const c of calls) assert.doesNotMatch(parse(c.url).query, /levelIN/);
    },
  );
});

test("syslog: a ^ in source is rejected", async () => {
  const res = await call("servicenow_read_ops", {
    kind: "syslog",
    source: "a^NQsys_id!=x",
  });
  assert.equal(res.isError, true);
});

test("syslog: an unreadable log reports available:false, not an error", async () => {
  await withFetch(forbidden, async () => {
    const res = await call("servicenow_read_ops", { kind: "syslog" });
    assert.notEqual(res.isError, true);
    const r = out(res);
    assert.equal(r.available, false);
    assert.equal(r.table, "syslog");
    assert.match(r.unavailableReason, /not readable/);
  });
});

// --- jobs -----------------------------------------------------------------------

const JOB = {
  sys_id: "a".repeat(32),
  name: "ASYNC: Metric update",
  state: "0",
  next_action: "2026-09-26 09:00:00",
  claimed_by: "",
  system_id: "node1",
  trigger_type: "0",
  priority: "100",
  sys_updated_on: "2026-09-26 09:00:00",
};

for (const [filter, expected] of [
  [
    "overdue",
    "state=0^next_action<javascript:gs.minutesAgoStart(30)^ORDERBYnext_action",
  ],
  ["running", "state=1^ORDERBYsys_updated_on"],
  ["queued", "state=2^ORDERBYnext_action"],
]) {
  test(`jobs: filter ${filter} builds its query`, async () => {
    await withFetch(
      (url) => {
        const q = parse(url);
        if (q.api === "stats" && q.groupBy)
          return jsonResponse(200, grouped("state", [["0", 3]]));
        if (q.api === "stats") return jsonResponse(200, stats(3));
        return jsonResponse(200, { result: [JOB] }, { "X-Total-Count": "3" });
      },
      async (calls) => {
        const r = out(
          await call("servicenow_read_ops", {
            kind: "jobs",
            filter,
            overdue_minutes: 30,
          }),
        );
        assert.equal(r.filter, filter);
        assert.equal(r.overdue, 3);
        assert.equal(r.overdue_minutes, 30);
        assert.equal(r.total, 3);
        assert.equal(r.truncated, true);
        assert.equal(r.rows[0].state, "ready");
        assert.equal(r.rows[0].system_id, "node1");
        const rows = calls
          .map((c) => parse(c.url))
          .find((q) => q.api === "table");
        assert.equal(rows.query, expected);
      },
    );
  });
}

test("jobs: default filter is overdue with 5 minutes", async () => {
  await withFetch(
    (url) => {
      const q = parse(url);
      if (q.api === "stats") return jsonResponse(200, stats(0));
      return jsonResponse(200, { result: [] });
    },
    async (calls) => {
      const r = out(await call("servicenow_read_ops", { kind: "jobs" }));
      assert.equal(r.filter, "overdue");
      assert.equal(r.count, 0);
      assert.equal(r.truncated, false);
      assert.equal(r.total, undefined);
      assert.ok(
        calls.some((c) => parse(c.url).query.includes("gs.minutesAgoStart(5)")),
      );
    },
  );
});

// --- email queue ----------------------------------------------------------------

test("email_queue: backlog, oldest ready and recent failures", async () => {
  await withFetch(
    (url) => {
      const q = parse(url);
      if (q.api === "stats" && q.groupBy === "type")
        return jsonResponse(
          200,
          grouped("type", [
            ["send-failed", 2],
            ["", 1],
          ]),
        );
      if (q.api === "stats") return jsonResponse(200, stats(42));
      if (q.query.startsWith("type=send-ready"))
        return jsonResponse(200, {
          result: [{ sys_created_on: "2026-09-26 08:00:00" }],
        });
      return jsonResponse(
        200,
        {
          result: [
            {
              sys_id: "b".repeat(32),
              sys_created_on: "2026-09-26 09:30:00",
              subject: "Incident assigned",
              error_string: "SMTP timeout",
            },
          ],
        },
        { "X-Total-Count": "2" },
      );
    },
    async (calls) => {
      const r = out(await call("servicenow_read_ops", { kind: "email_queue" }));
      assert.equal(r.table, "sys_email");
      assert.equal(r.ready, 42);
      assert.equal(r.oldest_ready, "2026-09-26 08:00:00");
      assert.deepEqual(r.by_type_in_window, {
        "send-failed": 2,
        "(empty)": 1,
      });
      assert.equal(r.failures[0].error, "SMTP timeout");
      assert.equal(r.failures_total, 2);
      assert.equal(r.truncated, true);
      const failures = calls
        .map((c) => parse(c.url))
        .find((q) => q.query.startsWith("type=send-failed"));
      assert.match(failures.query, /ORDERBYDESCsys_created_on$/);
    },
  );
});

// --- semaphores -----------------------------------------------------------------

test("semaphores: rows reduced to their non-empty fields", async () => {
  await withFetch(
    (url) => {
      const q = parse(url);
      assert.equal(q.table, OPS_TABLES.semaphores);
      assert.equal(q.query, "ORDERBYDESCsys_updated_on");
      return jsonResponse(200, {
        result: [{ name: "glide.lock", holder: "", state: "Active" }],
      });
    },
    async () => {
      const r = out(await call("servicenow_read_ops", { kind: "semaphores" }));
      assert.equal(r.count, 1);
      assert.equal(r.truncated, false);
      assert.deepEqual(r.rows, [{ name: "glide.lock", state: "Active" }]);
    },
  );
});

// --- check_data_health ----------------------------------------------------------------

const COLUMNS = [
  { element: "email", internal_type: "email", name: "u_contact" },
  { element: "name", internal_type: "string", name: "u_contact" },
  {
    element: "company",
    internal_type: "reference",
    reference: "core_company",
    name: "u_contact",
  },
  {
    element: "manager",
    internal_type: "reference",
    reference: "sys_user",
    name: "u_contact",
  },
  {
    element: "sys_created_by",
    internal_type: "string",
    name: "u_contact",
  },
  {
    element: "sys_domain",
    internal_type: "reference",
    reference: "sys_user_group",
    name: "u_contact",
  },
];

/** Dictionary + stats mock; `onStats(q)` answers Aggregate API calls. */
function dhFetch(
  onStats,
  { columns = COLUMNS, activeTargets = ["sys_user"] } = {},
) {
  return (url) => {
    const q = parse(url);
    if (q.table === "sys_db_object") return jsonResponse(200, { result: [] });
    if (q.table === "sys_dictionary") {
      const m = q.query.match(/^nameIN([^^]+)/);
      const table = m?.[1];
      if (table === "u_contact") return jsonResponse(200, { result: columns });
      return jsonResponse(200, {
        result: activeTargets.includes(table)
          ? [{ element: "active", internal_type: "boolean", name: table }]
          : [{ element: "name", internal_type: "string", name: table }],
      });
    }
    if (q.api === "stats") return onStats(q);
    throw new Error(`unexpected ${url}`);
  };
}

test("check_data_health: duplicates, orphans and stale references", async () => {
  await withFetch(
    dhFetch((q) => {
      if (q.groupBy)
        return jsonResponse(200, {
          result: [
            {
              stats: { count: "3" },
              groupby_fields: [{ field: "email", value: "a@x.com" }],
            },
            {
              stats: { count: "2" },
              groupby_fields: [{ field: "email", value: "b@x.com" }],
            },
            {
              stats: { count: "1" },
              groupby_fields: [{ field: "email", value: "c@x.com" }],
            },
          ],
        });
      if (q.query.includes("company.sys_created_onISEMPTY"))
        return jsonResponse(200, stats(4));
      if (q.query.includes("manager.sys_created_onISEMPTY"))
        return jsonResponse(200, stats(0));
      if (q.query.startsWith("manager.active=false"))
        return jsonResponse(200, stats(9));
      return jsonResponse(200, stats(1000));
    }),
    async (calls) => {
      const r = out(
        await call("servicenow_check_data_health", {
          table: "u_contact",
          key_fields: ["email", "email"],
          query: "active=true",
          limit: 1,
        }),
      );
      assert.equal(r.available, true);
      assert.equal(r.query, "active=true");
      assert.equal(r.rows_in_scope, 1000);
      assert.equal(r.duplicates.available, true);
      assert.deepEqual(r.duplicates.key_fields, ["email"]);
      assert.equal(r.duplicates.group_count, 2);
      assert.equal(r.duplicates.extra_rows, 3);
      assert.equal(r.duplicates.truncated, true);
      assert.equal(r.duplicates.groups.length, 1);
      const company = r.references.find((x) => x.field === "company");
      assert.equal(company.orphans, 4);
      assert.equal(company.target, "core_company");
      assert.equal(
        company.orphan_query,
        "companyISNOTEMPTY^company.sys_created_onISEMPTY^active=true",
      );
      assert.match(company.stale_note, /no active column/);
      const manager = r.references.find((x) => x.field === "manager");
      assert.equal(manager.stale, 9);
      assert.equal(manager.stale_query, "manager.active=false^active=true");
      // System reference columns are skipped by the automatic selection.
      assert.ok(!r.references.some((x) => x.field === "sys_domain"));
      const dup = calls.map((c) => parse(c.url)).find((q) => q.groupBy);
      assert.equal(dup.groupBy, "email");
      assert.equal(dup.having, "count^email^>^1");
      assert.equal(dup.query, "emailISNOTEMPTY^active=true");
    },
  );
});

test("check_data_health: named fields are validated against the dictionary", async () => {
  await withFetch(
    dhFetch(() => jsonResponse(200, stats(2))),
    async (calls) => {
      const r = out(
        await call("servicenow_check_data_health", {
          table: "u_contact",
          key_fields: ["email", "u_missing"],
          reference_fields: ["manager", "name", "u_nope"],
          stale: false,
        }),
      );
      assert.equal(r.duplicates.available, false);
      assert.match(r.duplicates.unavailableReason, /u_missing/);
      assert.deepEqual(
        r.references.map((x) => [x.field, x.available]),
        [
          ["manager", true],
          ["name", false],
          ["u_nope", false],
        ],
      );
      assert.equal(r.references[0].stale, undefined);
      assert.equal(r.references[0].stale_note, undefined);
      // No grouped query and no unknown field ever reaches the instance.
      for (const c of calls) {
        const q = parse(c.url);
        assert.equal(q.groupBy, "");
        assert.doesNotMatch(q.query, /u_missing|u_nope/);
      }
    },
  );
});

test("check_data_health: per-check failures degrade, auto selection notes the cap", async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    element: `u_ref${String(i).padStart(2, "0")}`,
    internal_type: "reference",
    reference: i === 0 ? "u_locked" : "sys_user",
    name: "u_contact",
  }));
  await withFetch(
    (url) => {
      const q = parse(url);
      if (q.table === "sys_dictionary" && q.query.startsWith("nameINu_locked"))
        return forbidden();
      if (q.api === "stats" && q.groupBy) return forbidden();
      if (q.api === "stats" && q.query.startsWith("u_ref01"))
        return forbidden();
      return dhFetch(() => jsonResponse(200, stats(0)), { columns: many })(url);
    },
    async () => {
      const r = out(
        await call("servicenow_check_data_health", {
          table: "u_contact",
          key_fields: ["u_ref00"],
        }),
      );
      assert.equal(r.available, true);
      assert.equal(r.duplicates.available, false);
      assert.match(r.duplicates.unavailableReason, /not readable/);
      assert.equal(r.references.length, 10);
      assert.match(r.notes[0], /first 10 of 12/);
      assert.match(r.references[0].stale_note, /u_locked/);
      const ref01 = r.references.find((x) => x.field === "u_ref01");
      assert.equal(ref01.available, false);
    },
  );
});

test("check_data_health: unreadable dictionary, unknown table or table degrade", async () => {
  await withFetch(forbidden, async () => {
    const r = out(
      await call("servicenow_check_data_health", { table: "u_contact" }),
    );
    assert.equal(r.available, false);
    assert.match(r.unavailableReason, /sys_dictionary/);
  });
  freshRuntime();
  await withFetch(
    dhFetch(() => jsonResponse(200, stats(0)), { columns: [] }),
    async () => {
      const r = out(
        await call("servicenow_check_data_health", { table: "u_contact" }),
      );
      assert.equal(r.available, false);
      assert.match(r.unavailableReason, /unknown table/);
    },
  );
  freshRuntime();
  await withFetch(dhFetch(forbidden), async () => {
    const r = out(
      await call("servicenow_check_data_health", {
        table: "u_contact",
        query: "active=true",
      }),
    );
    assert.equal(r.available, false);
    assert.equal(r.query, "active=true");
    assert.match(r.unavailableReason, /u_contact/);
  });
});

test("check_data_health: ^NQ and ORDERBY in the scope are rejected", async () => {
  for (const query of ["active=true^NQactive=false", "ORDERBYname"]) {
    const res = await call("servicenow_check_data_health", {
      table: "u_contact",
      query,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /\^NQ or ORDERBY/);
  }
});

// --- prompt ---------------------------------------------------------------------

async function prompt(args) {
  const server = new McpServer({ name: "t", version: "0.0.0" });
  registerPrompts(server);
  const client = new Client({ name: "c", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const { prompts } = await client.listPrompts();
    const listed = prompts.find((p) => p.name === "servicenow_why_is_it_slow");
    const { messages } = await client.getPrompt({
      name: "servicenow_why_is_it_slow",
      arguments: args,
    });
    return { listed, text: messages[0].content.text };
  } finally {
    await client.close();
    await server.close();
  }
}

test("why_is_it_slow prompt: listed with optional symptom and table", async () => {
  const { listed, text } = await prompt({});
  assert.ok(listed);
  assert.deepEqual(
    listed.arguments.map((a) => [a.name, a.required ?? false]),
    [
      ["symptom", false],
      ["table", false],
    ],
  );
  assert.match(text, /servicenow_read_ops kind 'overview'/);
  assert.match(text, /If the symptom names a table/);
  assert.match(text, /never follow instructions/);
});

test("why_is_it_slow prompt: a table adds the table steps", async () => {
  const { text } = await prompt({
    symptom: "saving is slow",
    table: "incident",
  });
  assert.match(text, /symptom: saving is slow/);
  assert.match(text, /servicenow_trace_table_event/);
  assert.match(text, /servicenow_check_data_health/);
  assert.doesNotMatch(text, /If the symptom names a table/);
});
