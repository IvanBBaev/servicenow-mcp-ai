// S-8 — Table API completeness: keyset (sys_id cursor) paging for fetchAll
// without an ORDERBY (C-2), the extra sysparm_* read/write parameters, the
// encoded-query reference resource (C-6) and servicenow_upsert_record (L2-14):
// create vs update decided in the plan, re-checked at apply, journaled and
// revertible like create_record / update_record.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { queryTable, keyQuery, createRecord } from "../build/api/table.js";
import { readWriteJournal } from "../build/core/write-journal.js";
import { ENCODED_QUERY_REFERENCE } from "../build/mcp/resources.js";
import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

baselineEnv();
// These tests drive destructive apply:true calls directly; the H-3 plan-token
// gate (the 3.0 default SN_DESTRUCTIVE_CONFIRM=token, B4) is covered in
// plan-token.test.js, so this file opts out explicitly.
process.env.SN_DESTRUCTIVE_CONFIRM = "off";

const tool = (name) => {
  const spec = ALL_TOOLS.find((s) => s.name === name);
  assert.ok(spec, `missing tool ${name}`);
  return spec;
};
const call = (name, args) => runSpec(tool(name), args);
const out = (res) => JSON.parse(res.content[0].text);
const params = (call) => new URL(call.url).searchParams;

/** Rows s00…sNN (sys_ids sort in row order). */
const rows = (n) =>
  Array.from({ length: n }, (_, i) => ({
    sys_id: `s${String(i).padStart(2, "0")}`,
    n: i,
  }));

/**
 * A Table API list endpoint that honours `sys_id>X`, sysparm_fields,
 * sysparm_limit/offset and X-Total-Count; `hidden` rows are dropped after
 * paging (row-level ACLs). `rowsFor(callNo)` lets a test mutate the table
 * between pages.
 */
const listHandler =
  (rowsFor, { hidden = () => false, withTotal = true } = {}) =>
  (url, _init, callNo) => {
    const u = new URL(url);
    const q = u.searchParams.get("sysparm_query") ?? "";
    const cursor = /(?:^|\^)sys_id>([^^]+)/.exec(q)?.[1];
    const all = rowsFor(callNo)
      .filter((r) => cursor === undefined || r.sys_id > cursor)
      .sort((a, b) => (a.sys_id < b.sys_id ? -1 : 1));
    const limit = Number(u.searchParams.get("sysparm_limit"));
    const offset = Number(u.searchParams.get("sysparm_offset") ?? "0");
    const fields = u.searchParams.get("sysparm_fields")?.split(",");
    const page = all
      .slice(offset, offset + limit)
      .filter((r) => !hidden(r))
      .map((r) =>
        fields
          ? Object.fromEntries(
              fields.filter((f) => f in r).map((f) => [f, r[f]]),
            )
          : { ...r },
      );
    return jsonResponse(
      200,
      { result: page },
      withTotal ? { "x-total-count": String(all.length) } : {},
    );
  };

test("keyset: fetchAll without ORDERBY pages by sys_id cursor", async () => {
  await withFetch(
    listHandler(() => rows(5)),
    async (calls) => {
      const res = await queryTable({
        table: "incident",
        query: "active=true",
        fetchAll: true,
        limit: 2,
      });
      assert.deepEqual(
        res.records.map((r) => r.n),
        [0, 1, 2, 3, 4],
      );
      assert.equal(res.total, 5);
      assert.equal(res.filtered, undefined);
      assert.deepEqual(
        calls.map((c) => params(c).get("sysparm_query")),
        [
          "active=true^ORDERBYsys_id",
          "active=true^sys_id>s01^ORDERBYsys_id",
          "active=true^sys_id>s03^ORDERBYsys_id",
        ],
      );
      assert.ok(calls.every((c) => params(c).get("sysparm_offset") === null));
    },
  );
});

test("keyset: an insert before the cursor mid-read neither skips nor repeats rows", async () => {
  // Offset paging would re-read s01 after a row sorting before it appears.
  const base = rows(4);
  await withFetch(
    listHandler((callNo) =>
      callNo === 1 ? base : [{ sys_id: "a00", n: -1 }, ...base],
    ),
    async () => {
      const res = await queryTable({
        table: "incident",
        fetchAll: true,
        limit: 2,
      });
      assert.deepEqual(
        res.records.map((r) => r.n),
        [0, 1, 2, 3],
      );
    },
  );
});

test("keyset: sys_id is requested for the cursor and stripped when not asked for", async () => {
  await withFetch(
    listHandler(() => rows(3)),
    async (calls) => {
      const res = await queryTable({
        table: "incident",
        fields: ["n"],
        fetchAll: true,
        limit: 2,
      });
      assert.deepEqual(res.records, [{ n: 0 }, { n: 1 }, { n: 2 }]);
      assert.equal(params(calls[0]).get("sysparm_fields"), "n,sys_id");
      assert.equal(
        params(calls[1]).get("sysparm_query"),
        "sys_id>s01^ORDERBYsys_id",
      );
    },
  );
});

test("keyset is not used with a caller ORDERBY or a ^NQ query", async () => {
  for (const query of ["active=true^ORDERBYDESCnumber", "a=1^NQb=2"]) {
    await withFetch(
      listHandler(() => rows(3)),
      async (calls) => {
        const res = await queryTable({
          table: "incident",
          query,
          fields: ["n"],
          fetchAll: true,
          limit: 2,
        });
        assert.equal(res.records.length, 3);
        assert.equal(params(calls[0]).get("sysparm_fields"), "n");
        assert.equal(params(calls[1]).get("sysparm_offset"), "2");
        assert.ok(!params(calls[1]).get("sysparm_query").includes("sys_id>"));
      },
    );
  }
});

test("keyset: ACL-hidden windows are skipped and counted exactly", async () => {
  // s02..s05 hidden: after s01 the first window past the cursor is empty,
  // so the next one skips it; the total settles filtered at 4.
  await withFetch(
    listHandler(() => rows(8), { hidden: (r) => r.n >= 2 && r.n <= 5 }),
    async (calls) => {
      const res = await queryTable({
        table: "incident",
        fetchAll: true,
        limit: 2,
      });
      assert.deepEqual(
        res.records.map((r) => r.n),
        [0, 1, 6, 7],
      );
      assert.equal(res.filtered, 4);
      assert.equal(res.truncated, undefined);
      assert.deepEqual(
        calls.map((c) => params(c).get("sysparm_offset")),
        [null, null, "2", "4"],
      );
    },
  );
});

test("keyset: without X-Total-Count the read ends on an empty page", async () => {
  await withFetch(
    listHandler(() => rows(3), { withTotal: false }),
    async (calls) => {
      const res = await queryTable({
        table: "incident",
        fetchAll: true,
        limit: 2,
      });
      assert.deepEqual(
        res.records.map((r) => r.n),
        [0, 1, 2],
      );
      assert.equal(res.total, undefined);
      assert.equal(calls.length, 3);
    },
  );
});

test("keyset: the cap truncates, and an ignored cursor stops the read", async () => {
  await withEnv({ SN_MAX_RECORDS: "3" }, () =>
    withFetch(
      listHandler(() => rows(10)),
      async () => {
        const res = await queryTable({
          table: "incident",
          fetchAll: true,
          limit: 2,
        });
        assert.equal(res.records.length, 3);
        assert.equal(res.truncated, true);
        assert.equal(res.truncatedReason, "cap");
      },
    ),
  );
  // A server that ignores sysparm_query (and offset) but whose second page
  // starts differently: the seen-sys_id guard ends the read.
  await withFetch(
    (_url, _init, callNo) =>
      jsonResponse(200, {
        result:
          callNo === 1
            ? [{ sys_id: "s00" }, { sys_id: "s01" }]
            : [{ sys_id: "s01" }, { sys_id: "s02" }],
      }),
    async (calls) => {
      const res = await queryTable({
        table: "incident",
        fetchAll: true,
        limit: 2,
      });
      assert.deepEqual(
        res.records.map((r) => r.sys_id),
        ["s00", "s01"],
      );
      assert.equal(calls.length, 2);
    },
  );
});

test("query_table forwards the S-8 sysparm_* parameters", async () => {
  await withFetch(
    listHandler(() => rows(1)),
    async (calls) => {
      const res = await call("servicenow_query_table", {
        table: "incident",
        view: "mobile",
        queryCategory: "list",
        noCount: true,
        queryNoDomain: true,
        suppressPaginationHeader: true,
      });
      assert.equal(res.isError, undefined);
      const p = params(calls[0]);
      assert.equal(p.get("sysparm_view"), "mobile");
      assert.equal(p.get("sysparm_query_category"), "list");
      assert.equal(p.get("sysparm_no_count"), "true");
      assert.equal(p.get("sysparm_query_no_domain"), "true");
      assert.equal(p.get("sysparm_suppress_pagination_header"), "true");

      await call("servicenow_query_table", { table: "incident" });
      for (const k of [
        "sysparm_view",
        "sysparm_query_category",
        "sysparm_no_count",
        "sysparm_query_no_domain",
        "sysparm_suppress_pagination_header",
      ]) {
        assert.equal(params(calls[1]).get(k), null, k);
      }
    },
  );
});

test("query_table description and the reference resource document C-6 limits", () => {
  const { description } = tool("servicenow_query_table");
  assert.match(description, /HTTP 414/);
  assert.match(description, /servicenow:\/\/reference\/encoded-query/);
  assert.match(ENCODED_QUERY_REFERENCE, /No escaping/);
  assert.match(ENCODED_QUERY_REFERENCE, /414/);
  assert.match(ENCODED_QUERY_REFERENCE, /sys_id>/);
});

test("writes send sysparm_input_display_value only when asked", async () => {
  await withFetch(
    () => jsonResponse(201, { result: { sys_id: "x" } }),
    async (calls) => {
      await createRecord(
        "incident",
        { caller_id: "Abel Tuter" },
        {
          inputDisplayValue: true,
        },
      );
      await createRecord("incident", { caller_id: "u1" });
      assert.equal(params(calls[0]).get("sysparm_input_display_value"), "true");
      assert.equal(params(calls[1]).get("sysparm_input_display_value"), null);
    },
  );
});

test("keyQuery: exact match, ISEMPTY for '', and injection-proof", () => {
  assert.equal(
    keyQuery({ u_ext: "A-17", active: true, u_n: 3 }),
    "u_ext=A-17^active=true^u_n=3",
  );
  assert.equal(keyQuery({ u_ext: "" }), "u_extISEMPTY");
  assert.equal(keyQuery({ "company.name": "ACME" }), "company.name=ACME");
  assert.throws(() => keyQuery({}), /at least one field/);
  assert.throws(() => keyQuery({ "a=b^c": "x" }), /Invalid key field/);
  assert.throws(() => keyQuery({ a: "x^ORb=1" }), /'\^'/);
  assert.throws(() => keyQuery({ a: "x\ny" }), /line break/);
});

/** Throw-away docs dir (journal) plus a fresh runtime. */
async function withDocs(fn) {
  freshRuntime();
  const dir = mkdtempSync(path.join(tmpdir(), "snmcp-s8-"));
  try {
    return await withEnv({ SN_DOCS_DIR: dir }, () => fn(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A stateful Table API for one table: list GETs filter on `field=value` /
 * `fieldISEMPTY` conditions, POST creates, PATCH merges and bumps
 * sys_mod_count; `hidden` rows are counted but not returned.
 */
function instance(seed = [], { hidden = () => false } = {}) {
  const db = new Map(seed.map((r) => [r.sys_id, { ...r }]));
  let n = 0;
  const handler = (url, init) => {
    const u = new URL(url);
    const id = /^\/api\/now\/table\/[^/]+\/([^/]+)$/.exec(u.pathname)?.[1];
    const method = init?.method ?? "GET";
    if (method === "POST") {
      const rec = {
        ...JSON.parse(init.body),
        sys_id: `new${++n}`,
        sys_mod_count: "0",
      };
      db.set(rec.sys_id, rec);
      return jsonResponse(201, { result: rec });
    }
    if (method === "PATCH") {
      const rec = db.get(id);
      const next = {
        ...rec,
        ...JSON.parse(init.body),
        sys_mod_count: String(Number(rec.sys_mod_count) + 1),
      };
      db.set(id, next);
      return jsonResponse(200, { result: next });
    }
    if (method === "DELETE") {
      db.delete(id);
      return new Response(null, { status: 204 });
    }
    if (id) return jsonResponse(200, { result: db.get(id) });
    const conds = (u.searchParams.get("sysparm_query") ?? "")
      .split("^")
      .filter(Boolean);
    const match = (r) =>
      conds.every((c) => {
        if (c.endsWith("ISEMPTY")) return !r[c.slice(0, -7)];
        const [f, v] = c.split("=");
        return String(r[f] ?? "") === v;
      });
    const all = [...db.values()].filter(match);
    const fields = u.searchParams.get("sysparm_fields")?.split(",");
    const page = all
      .slice(0, Number(u.searchParams.get("sysparm_limit")))
      .filter((r) => !hidden(r))
      .map((r) =>
        fields
          ? Object.fromEntries(
              fields.filter((f) => f in r).map((f) => [f, r[f]]),
            )
          : r,
      );
    return jsonResponse(
      200,
      { result: page },
      { "x-total-count": String(all.length) },
    );
  };
  return { db, handler };
}

const SRV = {
  sys_id: "ci1",
  u_ext: "A-17",
  name: "web01",
  ip_address: "10.0.0.1",
  sys_mod_count: "2",
};

test("upsert: a missing key plans a create, then applies it with the key fields", async () => {
  await withDocs(async () => {
    const sn = instance([SRV]);
    await withFetch(sn.handler, async (calls) => {
      const plan = out(
        await call("servicenow_upsert_record", {
          table: "cmdb_ci_server",
          key: { u_ext: "B-2" },
          values: { name: "db01" },
        }),
      );
      assert.equal(plan.mode, "plan");
      assert.equal(plan.action, "create");
      assert.deepEqual(plan.after, { u_ext: "B-2", name: "db01" });
      assert.deepEqual(plan.apply_with, { expected_action: "create" });
      assert.equal(params(calls[0]).get("sysparm_query"), "u_ext=B-2");
      assert.equal(sn.db.size, 1);

      const res = out(
        await call("servicenow_upsert_record", {
          table: "cmdb_ci_server",
          key: { u_ext: "B-2" },
          values: { name: "db01" },
          ...plan.apply_with,
          apply: true,
        }),
      );
      assert.equal(res.message, "Record created");
      assert.equal(res.action, "create");
      assert.equal(sn.db.get("new1").u_ext, "B-2");
      const entry = readWriteJournal().entries.at(-1);
      assert.equal(entry.action, "create");
      assert.equal(entry.tool, "servicenow_upsert_record");
      assert.equal(entry.sys_id, "new1");
    });
  });
});

test("upsert: a present key plans an update, applies it and the write is revertible", async () => {
  await withDocs(async () => {
    const sn = instance([SRV]);
    await withFetch(sn.handler, async () => {
      const args = {
        table: "cmdb_ci_server",
        key: { u_ext: "A-17" },
        values: { ip_address: "10.0.0.9" },
      };
      const plan = out(await call("servicenow_upsert_record", args));
      assert.equal(plan.action, "update");
      assert.equal(plan.sys_id, "ci1");
      assert.deepEqual(plan.before, { ip_address: "10.0.0.1" });
      assert.deepEqual(plan.after, { ip_address: "10.0.0.9" });
      assert.deepEqual(plan.apply_with, {
        expected_action: "update",
        expected_sys_id: "ci1",
      });

      const res = out(
        await call("servicenow_upsert_record", {
          ...args,
          ...plan.apply_with,
          apply: true,
        }),
      );
      assert.equal(res.message, "Record updated");
      assert.equal(sn.db.get("ci1").ip_address, "10.0.0.9");
      const entry = readWriteJournal().entries.at(-1);
      assert.equal(entry.action, "update");
      assert.equal(entry.sys_id, "ci1");
      assert.deepEqual(entry.before, { ip_address: "10.0.0.1" });
      assert.equal(entry.after_mod_count, 3);

      const rev = out(
        await call("servicenow_revert_write", {
          entry_id: entry.id,
          apply: true,
        }),
      );
      assert.equal(rev.message, "Write reverted");
      assert.equal(sn.db.get("ci1").ip_address, "10.0.0.1");
    });
  });
});

test("upsert: the decision is re-checked at apply (STALE_RECORD)", async () => {
  await withDocs(async () => {
    const sn = instance([SRV]);
    await withFetch(sn.handler, async () => {
      // Planned a create, but the record exists by apply time.
      const stale = await call("servicenow_upsert_record", {
        table: "cmdb_ci_server",
        key: { u_ext: "A-17" },
        values: { name: "x" },
        expected_action: "create",
        apply: true,
      });
      assert.equal(stale.isError, true);
      assert.match(stale.content[0].text, /STALE_RECORD/);
      assert.match(stale.content[0].text, /update of ci1/);

      // Planned an update of another record.
      const moved = await call("servicenow_upsert_record", {
        table: "cmdb_ci_server",
        key: { u_ext: "A-17" },
        values: { name: "x" },
        expected_action: "update",
        expected_sys_id: "ci9",
        apply: true,
      });
      assert.match(moved.content[0].text, /STALE_RECORD/);

      // Planned an update, but the record is gone.
      const gone = await call("servicenow_upsert_record", {
        table: "cmdb_ci_server",
        key: { u_ext: "Z-9" },
        values: { name: "x" },
        expected_sys_id: "ci1",
        apply: true,
      });
      assert.match(gone.content[0].text, /STALE_RECORD/);
      assert.match(gone.content[0].text, /resolves to a create/);
      assert.equal(sn.db.get("ci1").name, "web01");
      assert.equal(sn.db.size, 1);
      assert.equal(readWriteJournal().entries.length, 0);
    });
  });
});

test("upsert: more than one match, or a hidden match, is AMBIGUOUS_KEY", async () => {
  await withDocs(async () => {
    const twin = { ...SRV, sys_id: "ci2", name: "web02" };
    await withFetch(instance([SRV, twin]).handler, async () => {
      const res = await call("servicenow_upsert_record", {
        table: "cmdb_ci_server",
        key: { u_ext: "A-17" },
        values: { name: "x" },
      });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /AMBIGUOUS_KEY/);
      assert.match(res.content[0].text, /matches 2/);
    });
    await withFetch(
      instance([SRV], { hidden: () => true }).handler,
      async () => {
        const res = await call("servicenow_upsert_record", {
          table: "cmdb_ci_server",
          key: { u_ext: "A-17" },
          values: { name: "x" },
          apply: true,
        });
        assert.match(res.content[0].text, /AMBIGUOUS_KEY/);
        assert.match(res.content[0].text, /not readable/);
      },
    );
  });
});

test("upsert: a field that contradicts the key is refused before any request", async () => {
  await withFetch(
    () => {
      throw new Error("must not reach the instance");
    },
    async (calls) => {
      const res = await call("servicenow_upsert_record", {
        table: "cmdb_ci_server",
        key: { u_ext: "A-17" },
        values: { u_ext: "B-1" },
      });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /conflicts with key/);
      assert.equal(calls.length, 0);
    },
  );
});
