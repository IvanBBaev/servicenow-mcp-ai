// S-10a — operations reads and writes: import-set run status and transform
// maps, CMDB relationships and IRE, record history (sys_audit +
// sys_journal_field, C-5), system properties get / set (plan, apply, journal,
// revert), user / group / role lookups and the ATF run wait (polling under
// the M-3 cancellation signal with progress).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describeImportRun } from "../build/api/importset.js";
import { waitForAtfRun } from "../build/api/atf.js";
import { readWriteJournal } from "../build/core/write-journal.js";
import { runWithCall } from "../build/core/request-context.js";
import { runSpec } from "../build/mcp/define.js";
import {
  ALL_TOOLS,
  PACKAGES,
  resolveEnabledPackages,
} from "../build/mcp/registry.js";
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
// They also write sys_properties (set_property), a protected table that is
// write-denied by default since 3.0 (B11, covered in policy-h11.test.js).
process.env.SN_PROTECTED_TABLES_WRITE = "allow";

test.beforeEach(() => {
  baselineEnv();
  freshRuntime();
});

const tool = (name) => {
  const spec = ALL_TOOLS.find((s) => s.name === name);
  assert.ok(spec, `missing tool ${name}`);
  return spec;
};
const call = (name, args) => runSpec(tool(name), args);
const out = (res) => JSON.parse(res.content[0].text);
const id = (c) => c.repeat(32);

/** Parsed Table API list request: table, sysparm_query and fields. */
function tableRequest(url) {
  const u = new URL(url);
  const m = /^\/api\/now\/table\/([^/]+)(?:\/([^/]+))?$/.exec(u.pathname);
  return m
    ? {
        table: m[1],
        sysId: m[2],
        query: u.searchParams.get("sysparm_query") ?? "",
        fields: u.searchParams.get("sysparm_fields") ?? "",
      }
    : undefined;
}

/** Route Table API GETs to `routes[table]` (rows or a status number). */
function tables(routes, other = () => jsonResponse(404, {})) {
  return (url, init) => {
    const req = tableRequest(url);
    if (!req || (init?.method ?? "GET") !== "GET") return other(url, init);
    const route = routes[req.table];
    if (route === undefined)
      return jsonResponse(404, { error: { message: `no ${req.table}` } });
    const value = typeof route === "function" ? route(req) : route;
    if (typeof value === "number") {
      return jsonResponse(value, { error: { message: `HTTP ${value}` } });
    }
    return jsonResponse(
      200,
      { result: value },
      { "X-Total-Count": String(value.length) },
    );
  };
}

async function withDocs(env, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "snmcp-s10a-"));
  try {
    return await withEnv({ SN_DOCS_DIR: dir, ...env }, () => fn(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- packages ----------------------------------------------------------------

test("S-10a packages: history, properties, directory are opt-in; cmdb gains two tools", () => {
  const names = (p) =>
    PACKAGES.find((x) => x.name === p)
      .tools.map((t) => t.name)
      .sort();
  assert.deepEqual(names("history"), [
    "servicenow_get_record_history",
    "servicenow_get_task_context",
  ]);
  assert.deepEqual(names("properties"), [
    "servicenow_get_properties",
    "servicenow_set_property",
  ]);
  assert.deepEqual(names("directory"), ["servicenow_lookup_directory"]);
  const cmdb = names("cmdb");
  assert.ok(cmdb.includes("servicenow_list_ci_relations"));
  assert.ok(cmdb.includes("servicenow_identify_reconcile"));
  const core = resolveEnabledPackages(["core"]);
  for (const p of ["history", "properties", "directory", "cmdb"]) {
    assert.equal(core.has(p), false, p);
  }
  assert.equal(PACKAGES.at(-1).name, "admin");
  assert.equal(tool("servicenow_set_property").annotations.readOnlyHint, false);
  assert.equal(
    tool("servicenow_lookup_directory").annotations.readOnlyHint,
    true,
  );
});

// --- import set run -----------------------------------------------------------

test("insert_import_set_row: adds the run status and the transform maps used", async () => {
  await withFetch(
    (url, init) => {
      if (url.includes("/api/now/import/")) {
        assert.equal(init.method, "POST");
        return jsonResponse(201, {
          import_set: "ISET0010",
          staging_table: "u_imp_inc",
          result: [
            {
              transform_map: "Incident import",
              table: "incident",
              status: "inserted",
            },
            {
              transform_map: "Hidden map",
              table: "incident",
              status: "ignored",
            },
          ],
        });
      }
      return tables({
        sys_import_set_run: (req) => {
          assert.match(
            req.query,
            /^set\.number=ISET0010\^ORDERBYDESCsys_created_on$/,
          );
          return [{ sys_id: "run1", state: "complete", inserts: "1" }];
        },
        sys_transform_map: (req) => {
          assert.match(req.query, /^source_table=u_imp_inc\^ORDERBYorder$/);
          return [
            { sys_id: "m1", name: "Incident import", target_table: "incident" },
            { sys_id: "m2", name: "Unused map", target_table: "incident" },
          ];
        },
      })(url, init);
    },
    async () => {
      const res = out(
        await call("servicenow_insert_import_set_row", {
          table: "u_imp_inc",
          values: { u_number: "INC1" },
          apply: true,
        }),
      );
      assert.equal(res.message, "Import set row inserted");
      assert.equal(res.import_set_run.state, "complete");
      const used = res.transform_maps.filter((m) => m.used).map((m) => m.name);
      assert.deepEqual(used.sort(), ["Hidden map", "Incident import"]);
      assert.equal(
        res.transform_maps.find((m) => m.name === "Unused map").used,
        false,
      );
      assert.equal(res.warnings, undefined);
    },
  );
});

test("describeImportRun: reads degrade to warnings; odd set numbers are not queried", async () => {
  await withFetch(
    tables({ sys_import_set_run: 403, sys_transform_map: 403 }),
    async (calls) => {
      const r = await describeImportRun("u_imp", {
        result: { import_set: "ISET1", result: [] },
      });
      assert.equal(r.import_set_run, null);
      assert.deepEqual(r.transform_maps, []);
      assert.equal(r.warnings.length, 2);
      assert.equal(calls.length, 2);
    },
  );
  await withFetch(tables({ sys_transform_map: [] }), async (calls) => {
    const r = await describeImportRun("u_imp", { import_set: "bad^set" });
    assert.equal(r.import_set_run, null);
    assert.ok(r.warnings.some((w) => /import set/i.test(w)));
    assert.equal(calls.length, 1);
  });
});

// --- CMDB relations and IRE ----------------------------------------------------

const CI = id("a");
const REL_ROWS = [
  {
    sys_id: "r1",
    parent: CI,
    child: id("b"),
    type: id("t"),
    "type.name": "Depends on::Used by",
    "child.name": "db01",
    "child.sys_class_name": "cmdb_ci_db_instance",
  },
  {
    sys_id: "r2",
    parent: id("c"),
    child: CI,
    type: id("u"),
    "type.name": "Runs on::Runs",
    "parent.name": "app01",
    "parent.sys_class_name": "cmdb_ci_appl",
  },
];

test("list_ci_relations: both directions, oriented from the CI", async () => {
  await withFetch(
    tables({
      cmdb_rel_ci: (req) => {
        assert.equal(req.query, `parent=${CI}^ORchild=${CI}^ORDERBYtype.name`);
        assert.match(req.fields, /child\.sys_class_name/);
        return REL_ROWS;
      },
    }),
    async () => {
      const res = out(
        await call("servicenow_list_ci_relations", { sys_id: CI }),
      );
      assert.equal(res.count, 2);
      assert.equal(res.truncated, false);
      assert.deepEqual(res.relations[0], {
        sys_id: "r1",
        direction: "outbound",
        type: "Depends on::Used by",
        type_sys_id: id("t"),
        ci: { sys_id: id("b"), name: "db01", class: "cmdb_ci_db_instance" },
      });
      assert.equal(res.relations[1].direction, "inbound");
      assert.equal(res.relations[1].ci.name, "app01");
    },
  );
});

test("list_ci_relations: direction and type filters; caret refused; 403 degrades; policy errors", async () => {
  const seen = [];
  await withFetch(
    tables({
      cmdb_rel_ci: (req) => {
        seen.push(req.query);
        return [];
      },
    }),
    async () => {
      await call("servicenow_list_ci_relations", {
        sys_id: CI,
        direction: "outbound",
        type: "Runs on::Runs",
      });
      await call("servicenow_list_ci_relations", {
        sys_id: CI,
        direction: "inbound",
        type: id("f"),
      });
      const bad = await call("servicenow_list_ci_relations", {
        sys_id: CI,
        type: "x^ORname=y",
      });
      assert.equal(bad.isError, true);
    },
  );
  assert.deepEqual(seen, [
    `parent=${CI}^type.name=Runs on::Runs^ORDERBYtype.name`,
    `child=${CI}^type=${id("f")}^ORDERBYtype.name`,
  ]);
  await withFetch(tables({ cmdb_rel_ci: 403 }), async () => {
    const res = out(await call("servicenow_list_ci_relations", { sys_id: CI }));
    assert.equal(res.count, 0);
    assert.equal(res.degraded.status, 403);
  });
  await withFetch(tables({ cmdb_rel_ci: 500 }), async () => {
    const res = await call("servicenow_list_ci_relations", { sys_id: CI });
    assert.equal(res.isError, true);
  });
  await withEnv({ SN_TABLES_DENY: "cmdb_rel_ci" }, () =>
    withFetch(tables({}), async (calls) => {
      const res = await call("servicenow_list_ci_relations", { sys_id: CI });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /SN_TABLES_DENY/);
      assert.equal(calls.length, 0);
    }),
  );
});

const IRE_ARGS = {
  items: [
    { className: "cmdb_ci_linux_server", values: { name: "web01" } },
    { className: "cmdb_ci_appl", values: { name: "shop" } },
  ],
  relations: [{ parent: 1, child: 0, type: "Runs on::Runs" }],
};

test("identify_reconcile: plan runs the identify-only query, apply posts and journals", async () => {
  await withDocs({}, async () => {
    await withFetch(
      (url, init) => {
        const u = new URL(url);
        assert.equal(init.method, "POST");
        assert.equal(u.searchParams.get("sysparm_data_source"), "ServiceNow");
        const body = JSON.parse(init.body);
        assert.equal(body.items.length, 2);
        assert.equal(body.relations[0].type, "Runs on::Runs");
        if (u.pathname === "/api/now/identifyreconcile/query") {
          return jsonResponse(200, {
            result: {
              items: [{ operation: "INSERT" }, { operation: "UPDATE" }],
            },
          });
        }
        assert.equal(u.pathname, "/api/now/identifyreconcile");
        return jsonResponse(200, {
          items: [{ sysId: id("1"), operation: "INSERT" }],
        });
      },
      async (calls) => {
        const plan = out(await call("servicenow_identify_reconcile", IRE_ARGS));
        assert.equal(plan.mode, "plan");
        assert.equal(plan.action, "execute");
        assert.equal(plan.identification.items[0].operation, "INSERT");
        assert.equal(readWriteJournal().entries.length, 0);

        const res = out(
          await call("servicenow_identify_reconcile", {
            ...IRE_ARGS,
            apply: true,
          }),
        );
        assert.equal(res.message, "IRE payload processed");
        assert.equal(res.result.items[0].operation, "INSERT");
        const line = readWriteJournal().entries.at(-1);
        assert.equal(line.tool, "servicenow_identify_reconcile");
        assert.equal(line.action, "execute");
        assert.equal(line.fields.items.length, 2);
        assert.equal(calls.length, 2);
      },
    );
  });
});

test("identify_reconcile: plan degrades without the query endpoint; guards run before any request", async () => {
  await withFetch(
    () =>
      jsonResponse(404, {
        error: { message: "Requested URI does not represent any resource" },
      }),
    async () => {
      const plan = out(
        await call("servicenow_identify_reconcile", {
          items: IRE_ARGS.items,
          data_source: "SGO-Acme",
        }),
      );
      assert.equal(plan.identification.degraded.status, 404);
    },
  );
  await withFetch(
    () => {
      throw new Error("no request expected");
    },
    async (calls) => {
      const range = await call("servicenow_identify_reconcile", {
        items: IRE_ARGS.items,
        relations: [{ parent: 0, child: 5, type: "x" }],
      });
      assert.equal(range.isError, true);
      assert.match(range.content[0].text, /out of range/);
      await withEnv({ SN_TABLES_DENY: "cmdb_ci_appl" }, async () => {
        const denied = await call("servicenow_identify_reconcile", IRE_ARGS);
        assert.equal(denied.isError, true);
        assert.match(denied.content[0].text, /SN_TABLES_DENY/);
      });
      await withEnv({ SN_READONLY: "true" }, async () => {
        const ro = await call("servicenow_identify_reconcile", {
          ...IRE_ARGS,
          apply: true,
        });
        assert.equal(ro.isError, true);
        assert.match(ro.content[0].text, /read-only/);
      });
      assert.equal(calls.length, 0);
    },
  );
});

// --- record history -----------------------------------------------------------

const INC = id("9");

test("get_record_history: merges audit and journal newest first, dedupes journal fields", async () => {
  await withFetch(
    tables({
      sys_journal_field: (req) => {
        assert.equal(
          req.query,
          `name=incident^element_id=${INC}^ORDERBYDESCsys_created_on`,
        );
        return [
          {
            sys_id: "j1",
            element: "work_notes",
            value: "Rebooted the printer",
            sys_created_by: "bob",
            sys_created_on: "2026-09-20 11:00:00",
          },
        ];
      },
      sys_audit: (req) => {
        assert.equal(
          req.query,
          `tablename=incident^documentkey=${INC}^ORDERBYDESCsys_created_on`,
        );
        return [
          {
            sys_id: "a1",
            fieldname: "state",
            oldvalue: "1",
            newvalue: "2",
            user: "alice",
            sys_created_on: "2026-09-20 12:00:00",
          },
          {
            sys_id: "a2",
            fieldname: "work_notes",
            oldvalue: "",
            newvalue: "Rebooted the printer",
            user: "bob",
            sys_created_on: "2026-09-20 11:00:00",
          },
          {
            sys_id: "a3",
            fieldname: "priority",
            oldvalue: "4",
            newvalue: "x".repeat(50),
            user: "alice",
            sys_created_on: "2026-09-19 09:00:00",
            reason: "escalation",
          },
        ];
      },
    }),
    async () => {
      const res = out(
        await call("servicenow_get_record_history", {
          table: "incident",
          sys_id: INC,
          value_max_chars: 10,
        }),
      );
      assert.equal(res.count, 3);
      assert.deepEqual(
        res.entries.map((e) => `${e.source}:${e.field}`),
        ["audit:state", "journal:work_notes", "audit:priority"],
      );
      assert.equal(res.entries[1].new_value, "Rebooted t");
      assert.equal(res.entries[1].truncated, true);
      assert.equal(res.entries[2].reason, "escalation");
      assert.equal(res.sources.audit.journal_duplicates_skipped, 1);
      assert.equal(res.sources.journal.read, true);
      assert.equal(res.note, undefined);
    },
  );
});

test("get_record_history: field and since filters, limit, single source", async () => {
  const seen = [];
  const rows = (n) =>
    Array.from({ length: n }, (_, i) => ({
      sys_id: `a${i}`,
      fieldname: "state",
      oldvalue: "1",
      newvalue: "2",
      user: "u",
      sys_created_on: `2026-09-2${i} 10:00:00`,
    }));
  await withFetch(
    tables({
      sys_audit: (req) => {
        seen.push(req.query);
        return rows(3);
      },
      sys_journal_field: (req) => {
        seen.push(req.query);
        return [];
      },
    }),
    async () => {
      const res = out(
        await call("servicenow_get_record_history", {
          table: "incident",
          sys_id: INC,
          source: "audit",
          fields: ["state", "priority"],
          since: "2026-09-01 08:30:00",
          limit: 2,
        }),
      );
      assert.equal(res.count, 2);
      assert.equal(res.truncated, true);
      assert.equal(res.sources.journal, undefined);
      await call("servicenow_get_record_history", {
        table: "incident",
        sys_id: INC,
        source: "journal",
        since: "2026-09-01",
      });
      const bad = await call("servicenow_get_record_history", {
        table: "incident",
        sys_id: INC,
        since: "yesterday",
      });
      assert.equal(bad.isError, true);
      assert.match(bad.content[0].text, /Invalid \\"since\\"/);
    },
  );
  assert.deepEqual(seen, [
    `tablename=incident^documentkey=${INC}^fieldnameINstate,priority^sys_created_on>=javascript:gs.dateGenerate('2026-09-01','08:30:00')^ORDERBYDESCsys_created_on`,
    `name=incident^element_id=${INC}^sys_created_on>=javascript:gs.dateGenerate('2026-09-01','00:00:00')^ORDERBYDESCsys_created_on`,
  ]);
});

test("get_record_history: each source degrades (ACL, policy); subject table policy errors", async () => {
  await withEnv({ SN_TABLES_DENY: "sys_journal_field" }, () =>
    withFetch(tables({ sys_audit: 403 }), async () => {
      const res = out(
        await call("servicenow_get_record_history", {
          table: "incident",
          sys_id: INC,
        }),
      );
      assert.equal(res.count, 0);
      assert.equal(res.sources.journal.policy, "denied");
      assert.equal(res.sources.audit.status, 403);
      assert.match(res.note, /partial/);
    }),
  );
  await withFetch(
    tables({ sys_audit: [], sys_journal_field: [] }),
    async () => {
      const res = out(
        await call("servicenow_get_record_history", {
          table: "incident",
          sys_id: INC,
        }),
      );
      assert.match(res.note, /Auditing may be off/);
    },
  );
  await withFetch(
    tables({ sys_audit: 500, sys_journal_field: [] }),
    async () => {
      const res = await call("servicenow_get_record_history", {
        table: "incident",
        sys_id: INC,
      });
      assert.equal(res.isError, true);
    },
  );
  await withEnv({ SN_TABLES_DENY: "incident" }, () =>
    withFetch(tables({}), async (calls) => {
      const res = await call("servicenow_get_record_history", {
        table: "incident",
        sys_id: INC,
      });
      assert.equal(res.isError, true);
      assert.equal(calls.length, 0);
    }),
  );
});

// --- properties ---------------------------------------------------------------

const PROP = {
  sys_id: id("p"),
  name: "glide.ui.session_timeout",
  value: "30",
  type: "integer",
  sys_mod_count: "2",
};
const SECRET_PROP = {
  sys_id: id("s"),
  name: "x_acme.api_token",
  value: "hunter2",
  type: "string",
  sys_mod_count: "0",
};

/** A stateful sys_properties mock: name= / nameSTARTSWITH lists, GET and PATCH by id. */
function propertyInstance(rows) {
  const db = new Map(rows.map((r) => [r.sys_id, { ...r }]));
  const handler = (url, init) => {
    const req = tableRequest(url);
    assert.equal(req.table, "sys_properties");
    const method = init?.method ?? "GET";
    if (req.sysId) {
      const rec = db.get(req.sysId);
      if (!rec)
        return jsonResponse(404, { error: { message: "No Record found" } });
      if (method === "PATCH") {
        const next = {
          ...rec,
          ...JSON.parse(init.body),
          sys_mod_count: String(Number(rec.sys_mod_count) + 1),
        };
        db.set(req.sysId, next);
        return jsonResponse(200, { result: next });
      }
      return jsonResponse(200, { result: rec });
    }
    const name = /^name=([^^]+)/.exec(req.query)?.[1];
    const prefix = /nameSTARTSWITH([^^]+)/.exec(req.query)?.[1];
    const hits = [...db.values()].filter(
      (r) =>
        (name === undefined || r.name === name) &&
        (prefix === undefined || r.name.startsWith(prefix)),
    );
    return jsonResponse(
      200,
      { result: hits },
      { "X-Total-Count": String(hits.length) },
    );
  };
  return { db, handler };
}

test("get_properties: by name and prefix, secrets masked, long values truncated", async () => {
  const long = {
    ...PROP,
    sys_id: id("l"),
    name: "glide.ui.banner",
    value: "y".repeat(40),
  };
  const sn = propertyInstance([PROP, SECRET_PROP, long]);
  await withFetch(sn.handler, async () => {
    const one = out(
      await call("servicenow_get_properties", {
        name: "glide.ui.session_timeout",
      }),
    );
    assert.equal(one.count, 1);
    assert.equal(one.properties[0].value, "30");

    const pre = out(
      await call("servicenow_get_properties", {
        prefix: "glide.ui.",
        value_max_chars: 10,
      }),
    );
    assert.equal(pre.count, 2);
    const banner = pre.properties.find((p) => p.name === "glide.ui.banner");
    assert.equal(banner.value, "y".repeat(10));
    assert.equal(banner.value_truncated, true);
    assert.equal(banner.value_length, 40);

    const secret = out(
      await call("servicenow_get_properties", { name: "x_acme.api_token" }),
    );
    assert.equal(secret.properties[0].value, "[redacted]");
    assert.equal(secret.properties[0].masked, true);

    const none = out(
      await call("servicenow_get_properties", { name: "no.such.prop" }),
    );
    assert.equal(none.count, 0);
    assert.match(none.note, /ACL-filtered/);

    for (const args of [{}, { name: "bad name" }, { prefix: "a^b" }]) {
      const res = await call("servicenow_get_properties", args);
      assert.equal(res.isError, true, JSON.stringify(args));
    }
  });
  await withFetch(tables({ sys_properties: 403 }), async () => {
    const res = out(
      await call("servicenow_get_properties", { prefix: "glide." }),
    );
    assert.equal(res.degraded.status, 403);
  });
  await withFetch(tables({ sys_properties: 500 }), async () => {
    const res = await call("servicenow_get_properties", { prefix: "glide." });
    assert.equal(res.isError, true);
  });
});

test("set_property: plan, apply with journal, then revert restores the old value", async () => {
  await withDocs({}, async () => {
    const sn = propertyInstance([PROP]);
    await withFetch(sn.handler, async () => {
      const plan = out(
        await call("servicenow_set_property", {
          name: "glide.ui.session_timeout",
          value: "60",
        }),
      );
      assert.equal(plan.mode, "plan");
      assert.equal(plan.before.value, "30");
      assert.deepEqual(plan.after, { value: "60" });
      assert.equal(plan.unchanged, undefined);
      assert.equal(sn.db.get(PROP.sys_id).value, "30");

      const same = out(
        await call("servicenow_set_property", {
          name: "glide.ui.session_timeout",
          value: "30",
        }),
      );
      assert.equal(same.unchanged, true);

      const res = out(
        await call("servicenow_set_property", {
          name: "glide.ui.session_timeout",
          value: "60",
          apply: true,
        }),
      );
      assert.match(res.message, /updated/);
      assert.equal(res.property.value, "60");
      assert.equal(sn.db.get(PROP.sys_id).value, "60");
      const line = readWriteJournal().entries.at(-1);
      assert.equal(line.tool, "servicenow_set_property");
      assert.equal(line.action, "update");
      assert.equal(line.table, "sys_properties");
      assert.equal(line.before.value, "30");
      assert.equal(line.after_mod_count, 3);

      const rev = out(
        await call("servicenow_revert_write", {
          entry_id: line.id,
          apply: true,
        }),
      );
      assert.equal(rev.message, "Write reverted");
      assert.equal(sn.db.get(PROP.sys_id).value, "30");
    });
  });
});

test("set_property: secret values never reach the plan or the journal; guards", async () => {
  await withDocs({}, async () => {
    const sn = propertyInstance([SECRET_PROP, PROP]);
    await withFetch(sn.handler, async () => {
      const plan = out(
        await call("servicenow_set_property", {
          name: "x_acme.api_token",
          value: "n3wS3cret",
        }),
      );
      assert.equal(plan.before.value, "[redacted]");
      assert.equal(plan.after.value, "[redacted]");
      assert.equal(JSON.stringify(plan).includes("hunter2"), false);

      const res = out(
        await call("servicenow_set_property", {
          name: "x_acme.api_token",
          value: "n3wS3cret",
          apply: true,
        }),
      );
      assert.equal(res.property.value, "[redacted]");
      assert.equal(sn.db.get(SECRET_PROP.sys_id).value, "n3wS3cret");
      const line = readWriteJournal().entries.at(-1);
      const text = JSON.stringify(line);
      assert.equal(text.includes("n3wS3cret"), false);
      assert.equal(text.includes("hunter2"), false);
      const rev = await call("servicenow_revert_write", {
        entry_id: line.id,
        apply: true,
      });
      assert.equal(rev.isError, true);
      assert.match(rev.content[0].text, /redacted/);

      const missing = await call("servicenow_set_property", {
        name: "no.such.prop",
        value: "1",
      });
      assert.equal(missing.isError, true);
      assert.match(missing.content[0].text, /PROPERTY_NOT_FOUND/);

      await withEnv({ SN_READONLY: "true" }, async () => {
        const before = sn.db.get(PROP.sys_id).value;
        const ro = await call("servicenow_set_property", {
          name: "glide.ui.session_timeout",
          value: "99",
          apply: true,
        });
        assert.equal(ro.isError, true);
        assert.match(ro.content[0].text, /read-only/);
        assert.equal(sn.db.get(PROP.sys_id).value, before);
      });
    });
    const dup = propertyInstance([PROP, { ...PROP, sys_id: id("d") }]);
    await withFetch(dup.handler, async () => {
      const res = await call("servicenow_set_property", {
        name: "glide.ui.session_timeout",
        value: "1",
      });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /ambiguous/);
    });
  });
});

// --- directory ----------------------------------------------------------------

const USER = {
  sys_id: id("u"),
  user_name: "alice",
  name: "Alice Admin",
  email: "alice@example.com",
  active: "true",
};

test("lookup_directory: user search with details (roles, groups)", async () => {
  const seen = {};
  await withFetch(
    tables({
      sys_user: (req) => {
        seen.user = req.query;
        return [USER];
      },
      sys_user_has_role: (req) => {
        assert.equal(req.query, `user=${USER.sys_id}^ORDERBYrole.name`);
        return [
          { role: id("r"), "role.name": "admin", inherited: "false" },
          {
            role: id("s"),
            "role.name": "itil",
            inherited: "true",
            state: "active",
          },
        ];
      },
      sys_user_grmember: [{ group: id("g"), "group.name": "Service Desk" }],
    }),
    async () => {
      const res = out(
        await call("servicenow_lookup_directory", {
          kind: "user",
          term: "ali",
          active: true,
          include_details: true,
        }),
      );
      assert.equal(res.count, 1);
      assert.deepEqual(res.details.roles[1], {
        name: "itil",
        sys_id: id("s"),
        inherited: true,
        state: "active",
      });
      assert.deepEqual(res.details.groups, [
        { name: "Service Desk", sys_id: id("g") },
      ]);
      assert.equal(res.details_unavailable, undefined);
    },
  );
  assert.equal(
    seen.user,
    "active=true^user_nameSTARTSWITHali^ORemailSTARTSWITHali^ORnameLIKEali^ORDERBYuser_name",
  );
});

test("lookup_directory: group and role details, degraded detail reads", async () => {
  const GROUP = { sys_id: id("g"), name: "Service Desk", active: "true" };
  const ROLE = { sys_id: id("r"), name: "itil" };
  await withFetch(
    tables({
      sys_user_group: [GROUP],
      sys_user_grmember: [
        {
          user: USER.sys_id,
          "user.user_name": "alice",
          "user.name": "Alice Admin",
          "user.active": "true",
        },
      ],
      sys_group_has_role: 403,
    }),
    async () => {
      const res = out(
        await call("servicenow_lookup_directory", {
          kind: "group",
          sys_id: GROUP.sys_id,
          include_details: true,
        }),
      );
      assert.equal(res.details.members[0].user_name, "alice");
      assert.equal(res.details.members[0].active, true);
      assert.equal(res.details_unavailable[0].detail, "roles");
      assert.equal(res.details_unavailable[0].status, 403);
    },
  );
  await withEnv({ SN_TABLES_DENY: "sys_group_has_role" }, () =>
    withFetch(
      tables({
        sys_user_role: [ROLE],
        sys_user_role_contains: [
          { contains: id("x"), "contains.name": "itil_base" },
        ],
      }),
      async () => {
        const res = out(
          await call("servicenow_lookup_directory", {
            kind: "role",
            term: "itil",
            include_details: true,
          }),
        );
        assert.deepEqual(res.details.contains, [
          { name: "itil_base", sys_id: id("x") },
        ]);
        assert.equal(res.details_unavailable[0].policy, "denied");
      },
    ),
  );
});

test("lookup_directory: several matches skip details; guards", async () => {
  await withFetch(
    tables({ sys_user_group: [{ sys_id: "g1" }, { sys_id: "g2" }] }),
    async (calls) => {
      const res = out(
        await call("servicenow_lookup_directory", {
          kind: "group",
          term: "desk",
          include_details: true,
        }),
      );
      assert.equal(res.count, 2);
      assert.equal(res.details, undefined);
      assert.match(res.note, /exactly one/);
      assert.equal(calls.length, 1);
      const plain = out(
        await call("servicenow_lookup_directory", {
          kind: "group",
          term: "desk",
        }),
      );
      assert.equal(plain.note, undefined);
    },
  );
  await withFetch(tables({}), async (calls) => {
    const none = await call("servicenow_lookup_directory", { kind: "user" });
    assert.equal(none.isError, true);
    const caret = await call("servicenow_lookup_directory", {
      kind: "user",
      term: "a^ORactive=false",
    });
    assert.equal(caret.isError, true);
    await withEnv({ SN_TABLES_DENY: "sys_user" }, async () => {
      const denied = await call("servicenow_lookup_directory", {
        kind: "user",
        term: "a",
      });
      assert.equal(denied.isError, true);
    });
    assert.equal(calls.length, 0);
  });
});

// --- ATF wait -----------------------------------------------------------------

const cicd = (status, pct) =>
  jsonResponse(200, {
    result: {
      status: String(status),
      status_label: status === 2 ? "Successful" : "Running",
      percent_complete: pct,
      links: { progress: { id: "exec1", url: "https://x/progress/exec1" } },
    },
  });

test("run_atf_suite wait_seconds: polls to a final state with progress", async () => {
  await withDocs({}, async () => {
    let polls = 0;
    await withFetch(
      (url, init) => {
        if (url.includes("/testsuite/run")) {
          assert.equal(init.method, "POST");
          return cicd(1, 0);
        }
        assert.match(url, /\/api\/sn_cicd\/progress\/exec1$/);
        polls++;
        return cicd(2, 100);
      },
      async () => {
        const res = out(
          await call("servicenow_run_atf_suite", {
            sys_id: id("5"),
            wait_seconds: 5,
            apply: true,
          }),
        );
        assert.equal(res.status, "2");
        assert.equal(res.wait.state, "finished");
        assert.equal(res.wait.polls, 1);
        assert.equal(res.wait.tracker, undefined);
        assert.equal(polls, 1);
      },
    );
    // Without wait_seconds the result is unchanged (no wait block).
    await withFetch(
      () => cicd(1, 0),
      async (calls) => {
        const res = out(
          await call("servicenow_run_atf_test", {
            sys_id: id("6"),
            apply: true,
          }),
        );
        assert.equal(res.wait, undefined);
        assert.equal(calls.length, 1);
      },
    );
  });
});

test("waitForAtfRun: timeout returns running with a tracker; progress reported", async () => {
  const updates = [];
  let n = 0;
  await withFetch(
    () => cicd(1, ++n * 10),
    async () => {
      const res = await runWithCall(
        {
          requestId: "r1",
          tool: "servicenow_run_atf_suite",
          progress: (u) => updates.push(u),
        },
        () => waitForAtfRun({ executionId: "exec1", status: "1" }, 60, 20),
      );
      assert.equal(res.wait.state, "running");
      assert.equal(res.wait.tracker, "exec1");
      assert.ok(res.wait.polls >= 2, `polls ${res.wait.polls}`);
      assert.equal(res.percentComplete, n * 10);
    },
  );
  assert.ok(updates.length >= 2);
  assert.equal(updates[0].total, 100);
  assert.equal(updates[0].progress, 10);
  assert.equal(updates[0].message, "Running");
});

test("waitForAtfRun: final or id-less runs return at once; cancellation aborts the wait", async () => {
  await withFetch(
    () => {
      throw new Error("no poll expected");
    },
    async (calls) => {
      const done = await waitForAtfRun({ executionId: "e", status: "3" }, 1000);
      assert.equal(done.wait.state, "finished");
      const noId = await waitForAtfRun({ status: "1" }, 1000);
      assert.equal(noId.wait.state, "running");
      assert.equal(noId.wait.tracker, undefined);
      assert.equal(calls.length, 0);
    },
  );
  const controller = new AbortController();
  await withFetch(
    () => {
      controller.abort();
      return cicd(1, 5);
    },
    async (calls) => {
      await assert.rejects(
        runWithCall(
          { requestId: "r2", tool: "t", signal: controller.signal },
          () =>
            waitForAtfRun({ executionId: "exec1", status: "1" }, 10_000, 5_000),
        ),
        { code: "CANCELLED", message: /cancel/i },
      );
      assert.equal(calls.length, 1);
    },
  );
});
