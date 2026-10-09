// H-4 — policy-axis bypass closure: every path to the instance gets a policy
// verdict. Attachments follow their parent table, the plugin-API tools check
// their backing tables, code-search hits on denied tables are dropped, the
// Batch API cannot nest, hide a table in its query/body or (opt-in) reach an
// unmapped surface, and check_change_conflicts(calculate) is a plan/apply write.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ALL_TOOLS } from "../build/mcp/registry.js";
import { runSpec } from "../build/mcp/define.js";
import {
  PACKAGE_BY_PATH,
  packageForUrl,
  runBatch,
  tablesForSubRequest,
} from "../build/api/batch.js";
import {
  getBatchMaxRequests,
  getBatchUnmapped,
} from "../build/core/settings.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const root = path.join(import.meta.dirname, "..");
const spec = (name) => ALL_TOOLS.find((s) => s.name === name);
const call = (name, args) => runSpec(spec(name), args);
const out = (res) => JSON.parse(res.content[0].text);
const SYS_ID = "a".repeat(32);
const mutating = (calls) =>
  calls.filter((c) => (c.init?.method ?? "GET") !== "GET");

/** A lenient instance: object for a record path, one-row array for a list. */
function instance(extra = {}) {
  return (url) => {
    const u = new URL(url);
    if (/\/api\/now\/attachment\/[^/]+(\/file)?$/.test(u.pathname)) {
      if (u.pathname.endsWith("/file")) {
        return new Response("aGVsbG8=", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return jsonResponse(200, {
        result: {
          sys_id: SYS_ID,
          table_name: extra.attachmentTable ?? "incident",
          file_name: "a.txt",
          size_bytes: "5",
        },
      });
    }
    const row = {
      sys_id: SYS_ID,
      name: "p",
      value: "v",
      type: "string",
      table_name: "incident",
      sys_mod_count: "1",
      email: "a@example.com",
    };
    if (/\/api\/now\/table\/[^/]+\/[^/]+$/.test(u.pathname)) {
      return jsonResponse(200, { result: row });
    }
    if (u.pathname.startsWith("/api/now/table/")) {
      return jsonResponse(200, { result: [row] });
    }
    return jsonResponse(200, { result: extra.pluginResult ?? row });
  };
}

async function scenario(env, fn, extra) {
  const docs = mkdtempSync(path.join(tmpdir(), "h4-"));
  freshRuntime();
  try {
    return await withEnv({ SN_DOCS_DIR: docs, ...env }, () =>
      withFetch(instance(extra), (calls) => fn(calls, docs)),
    );
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
}

// --- settings --------------------------------------------------------------

test("settings: SN_BATCH_UNMAPPED and SN_BATCH_MAX_REQUESTS default to deny / 50 (3.0, B8)", async () => {
  await withEnv(
    { SN_BATCH_UNMAPPED: undefined, SN_BATCH_MAX_REQUESTS: undefined },
    () => {
      assert.equal(getBatchUnmapped(), "deny");
      assert.equal(getBatchMaxRequests(), 50);
    },
  );
  for (const [raw, want] of [
    ["deny", "deny"],
    [" DENY ", "deny"],
    ["allow", "allow"],
    [" ALLOW ", "allow"],
    ["no", "deny"],
  ]) {
    await withEnv({ SN_BATCH_UNMAPPED: raw }, () =>
      assert.equal(getBatchUnmapped(), want, raw),
    );
  }
  for (const [raw, want] of [
    ["1000", 1000],
    ["1", 1],
    ["0", 50],
    ["1001", 50],
    ["x", 50],
  ]) {
    await withEnv({ SN_BATCH_MAX_REQUESTS: raw }, () =>
      assert.equal(getBatchMaxRequests(), want, raw),
    );
  }
});

// --- attachments -----------------------------------------------------------

test("attachments: get / download / delete follow the parent table's policy", async () => {
  await scenario(
    { SN_TABLES_DENY: "hr_case", SN_WRITE_MODE: "apply" },
    async (calls) => {
      for (const [name, args] of [
        ["servicenow_get_attachment", { sys_id: SYS_ID }],
        ["servicenow_download_attachment", { sys_id: SYS_ID }],
        ["servicenow_delete_attachment", { sys_id: SYS_ID }],
      ]) {
        const res = out(await call(name, args));
        assert.equal(res?.status, 403, name);
        assert.match(res.error, /hr_case.*SN_TABLES_DENY/, name);
      }
      assert.equal(mutating(calls).length, 0);
      assert.ok(
        calls.every((c) => !c.url.includes("/file")),
        "the file body is never fetched",
      );
    },
    { attachmentTable: "hr_case" },
  );
});

test("attachments: an allowed parent table still works; an unscoped list drops denied rows", async () => {
  await scenario({ SN_TABLES_DENY: "hr_case" }, async () => {
    const meta = out(
      await call("servicenow_get_attachment", { sys_id: SYS_ID }),
    );
    assert.equal(meta.error, undefined, JSON.stringify(meta));
    await withFetch(
      () =>
        jsonResponse(200, {
          result: [
            { sys_id: "1", table_name: "incident" },
            { sys_id: "2", table_name: "hr_case" },
            { sys_id: "3" },
          ],
        }),
      async () => {
        const list = out(await call("servicenow_list_attachments", {}));
        const ids = JSON.stringify(list);
        assert.match(ids, /"1"/);
        assert.doesNotMatch(ids, /"2"/);
        assert.match(ids, /"3"/);
      },
    );
  });
});

// --- plugin APIs and their backing tables ------------------------------------

test("plugin-API tools check their backing tables before any request", async () => {
  const cases = [
    ["change_request", "servicenow_list_changes", {}],
    ["change_request", "servicenow_get_change", { sys_id: SYS_ID }],
    ["change_request", "servicenow_check_change_conflicts", { sys_id: SYS_ID }],
    ["sc_catalog", "servicenow_list_catalogs", {}],
    ["sc_cat_item", "servicenow_list_catalog_items", {}],
    ["sc_cat_item", "servicenow_get_catalog_item", { sys_id: SYS_ID }],
    [
      "sc_request",
      "servicenow_order_catalog_item",
      { sys_id: SYS_ID, apply: true },
    ],
    ["kb_knowledge", "servicenow_search_knowledge", {}],
    ["kb_knowledge", "servicenow_get_knowledge_article", { sys_id: SYS_ID }],
    ["sys_email", "servicenow_get_email", { sys_id: SYS_ID }],
    [
      "sys_email",
      "servicenow_send_email",
      { to: ["a@example.com"], subject: "s", body: "b", apply: true },
    ],
    [
      "hr_case",
      "servicenow_send_email",
      {
        to: ["a@example.com"],
        subject: "s",
        body: "b",
        table: "hr_case",
        sys_id: SYS_ID,
        apply: true,
      },
    ],
    ["sys_atf_test", "servicenow_list_atf_tests", {}],
    ["sys_atf_test_suite", "servicenow_list_atf_suites", {}],
    [
      "sys_atf_test",
      "servicenow_run_atf_test",
      { sys_id: SYS_ID, apply: true },
    ],
  ];
  for (const [table, name, args] of cases) {
    assert.ok(spec(name), `${name} exists`);
    await scenario(
      { SN_TABLES_DENY: table, SN_WRITE_MODE: "apply" },
      async (calls) => {
        const res = out(await call(name, args));
        assert.equal(res?.status, 403, `${name}: ${JSON.stringify(res)}`);
        assert.match(res.error, new RegExp(`"${table}"`), name);
        assert.equal(calls.length, 0, `${name} sent nothing`);
      },
    );
  }
});

test("code search: hits on a denied table are dropped", async () => {
  await scenario(
    { SN_TABLES_DENY: "sys_script_include", SN_CODESEARCH: "true" },
    async () => {
      const res = out(
        await call("servicenow_search_code", { text: "gs.info" }),
      );
      const text = JSON.stringify(res);
      assert.match(text, /sys_script"/);
      assert.doesNotMatch(text, /sys_script_include/);
    },
    {
      pluginResult: [
        {
          table: "sys_script",
          sys_id: "1",
          name: "br",
          line: 1,
          snippet: "gs.info()",
        },
        {
          table: "sys_script_include",
          sys_id: "2",
          name: "si",
          line: 1,
          snippet: "gs.info()",
        },
      ],
    },
  );
});

// --- batch ------------------------------------------------------------------

const batchOk = () =>
  jsonResponse(200, {
    batch_request_id: "1",
    serviced_requests: [{ id: "1", status_code: 200, body: btoa("{}") }],
    unserviced_requests: [],
  });

test("batch: tables are read from the path, the query and the body", () => {
  const cases = [
    [{ url: "/api/now/table/incident" }, ["incident"]],
    [{ url: "/api/now/v1/stats/task?x=1" }, ["task"]],
    [
      { url: "/api/now/attachment/file?table_name=hr_case&table_sys_id=1" },
      ["hr_case"],
    ],
    [
      {
        url: "/api/now/attachment?sysparm_query=table_name%3Dhr_case%5Etable_sys_id%3D1",
      },
      ["hr_case"],
    ],
    [{ url: "/api/now/email", body: { table_name: "hr_case" } }, ["hr_case"]],
    [
      {
        url: "/api/now/identifyreconcile",
        body: {
          items: [{ className: "cmdb_ci_server" }, { className: "cmdb_ci_db" }],
          relations: [{}],
        },
      },
      ["cmdb_ci_server", "cmdb_ci_db", "cmdb_rel_ci"],
    ],
    [{ url: "/api/sn_sc/servicecatalog/items" }, []],
  ];
  for (const [req, want] of cases) {
    assert.deepEqual(tablesForSubRequest(req).sort(), want.sort(), req.url);
  }
});

test("batch: a table named in the query or body is policed; a nested batch is refused", async () => {
  await scenario({ SN_TABLES_DENY: "hr_case" }, async () => {
    await withFetch(batchOk, async (calls) => {
      for (const req of [
        {
          method: "POST",
          url: "/api/now/attachment/file?table_name=hr_case&table_sys_id=1",
          body: "x",
        },
        {
          method: "POST",
          url: "/api/now/email",
          body: { table_name: "hr_case", to: "a@b.c" },
        },
      ]) {
        await assert.rejects(runBatch([req]), {
          code: "POLICY_DENIED",
          message: /hr_case.*SN_TABLES_DENY/,
        });
      }
      for (const url of [
        "/api/now/v1/batch",
        "/api/now/batch",
        "/api/now/v2/batch/x",
      ]) {
        await assert.rejects(
          runBatch([{ method: "POST", url, body: {} }]),
          { code: "POLICY_DENIED", message: /nested batch/ },
          url,
        );
      }
      assert.equal(calls.length, 0);
    });
  });
});

test("batch: an attachment addressed by sys_id is checked against its parent table (only with a table policy)", async () => {
  // Parent is hr_case (denied): one metadata read, then refused, nothing sent.
  await scenario(
    { SN_TABLES_DENY: "hr_case" },
    async (calls) => {
      await assert.rejects(
        runBatch([
          { method: "GET", url: `/api/now/attachment/${SYS_ID}/file` },
        ]),
        { code: "POLICY_DENIED", message: /hr_case/ },
      );
      assert.deepEqual(
        calls.map((c) => new URL(c.url).pathname),
        [`/api/now/attachment/${SYS_ID}`],
      );
      await assert.rejects(
        runBatch([{ method: "GET", url: "/api/now/attachment" }]),
        { code: "POLICY_DENIED", message: /without naming a table/ },
      );
    },
    { attachmentTable: "hr_case" },
  );
  // No table policy: no extra read, the sub-request goes straight out.
  await scenario({}, async () => {
    await withFetch(batchOk, async (calls) => {
      await runBatch([{ method: "GET", url: `/api/now/attachment/${SYS_ID}` }]);
      await runBatch([{ method: "GET", url: "/api/now/attachment" }]);
      assert.equal(calls.length, 2);
      assert.ok(calls.every((c) => c.url.endsWith("/api/now/v1/batch")));
    });
  });
});

test("batch: unmapped paths are refused by default (B8) and pass with SN_BATCH_UNMAPPED=allow", async () => {
  const req = [{ method: "GET", url: "/api/x_acme/custom/thing" }];
  for (const env of [{}, { SN_BATCH_UNMAPPED: "deny" }]) {
    await scenario(env, async () => {
      await withFetch(batchOk, async (calls) => {
        await assert.rejects(runBatch(req), (err) => {
          assert.match(err.message, /SN_BATCH_UNMAPPED=deny/);
          assert.equal(err.code, "POLICY_DENIED");
          assert.match(err.hint, /SN_BATCH_UNMAPPED=allow/);
          return true;
        });
        assert.equal(calls.length, 0, "nothing is sent");
        await runBatch([{ method: "GET", url: "/api/now/table/incident" }]);
        assert.equal(calls.length, 1, "mapped paths still work");
      });
    });
  }
  await scenario({ SN_BATCH_UNMAPPED: "allow" }, async () => {
    await withFetch(batchOk, async (calls) => {
      await runBatch(req);
      assert.equal(calls.length, 1);
    });
  });
});

test("batch: more than 50 sub-requests are refused by default (B8)", async () => {
  await scenario({}, async () => {
    await withFetch(batchOk, async (calls) => {
      const many = (n) =>
        Array.from({ length: n }, () => ({
          method: "GET",
          url: "/api/now/table/incident",
        }));
      await assert.rejects(runBatch(many(51)), /at most 50 sub-requests/);
      assert.equal(calls.length, 0);
      await runBatch(many(50));
      assert.equal(calls.length, 1);
    });
  });
});

test("batch: SN_BATCH_MAX_REQUESTS is enforced before anything is sent", async () => {
  await scenario({ SN_BATCH_MAX_REQUESTS: "2" }, async () => {
    await withFetch(batchOk, async (calls) => {
      const three = Array.from({ length: 3 }, () => ({
        method: "GET",
        url: "/api/now/table/incident",
      }));
      await assert.rejects(runBatch(three), /at most 2 sub-requests/);
      assert.equal(calls.length, 0);
    });
  });
});

test("batch: the plan preview shows bodies (redacted), tables and the owning package", async () => {
  await scenario({ SN_REDACT_FIELDS: "password" }, async (calls) => {
    const res = out(
      await call("servicenow_batch", {
        requests: [
          {
            method: "POST",
            url: "/api/now/table/sys_user",
            body: { user_name: "x", password: "hunter2" },
          },
          { method: "GET", url: "/api/x_acme/custom" },
        ],
      }),
    );
    assert.equal(res.mode, "plan");
    const [write, other] = res.after.requests;
    assert.deepEqual(write.body, { user_name: "x", password: "[redacted]" });
    assert.deepEqual(write.tables, ["sys_user"]);
    assert.equal(write.package, "table");
    assert.equal(other.package, null);
    assert.equal(calls.length, 0);
  });
});

test("GA-7: every REST surface the server calls maps to a tool package", () => {
  const prefixes = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.name.endsWith(".ts")) {
        // Code only: comment lines quote example paths (e.g. traversal tricks).
        const src = readFileSync(full, "utf8")
          .split("\n")
          .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
          .join("\n");
        for (const [, p] of src.matchAll(
          /["`](\/api\/(?:now\/(?:v\d+\/)?[a-z_]+|sn_[a-z_]+\/[a-z_]+))/g,
        )) {
          prefixes.add(p);
        }
      }
    }
  };
  walk(path.join(root, "src", "api"));
  // The Batch API itself is the transport (a nested batch is refused).
  prefixes.delete("/api/now/v1/batch");
  assert.ok(prefixes.size >= 10, [...prefixes].join(" "));
  const unmapped = [...prefixes].filter((p) => !packageForUrl(`${p}/x`));
  assert.deepEqual(unmapped, [], "add these to PACKAGE_BY_PATH");
  const packages = new Set(ALL_TOOLS.map((s) => s.package));
  for (const [, pkg] of PACKAGE_BY_PATH) {
    assert.ok(packages.has(pkg), `${pkg} is a real package`);
  }
});

// --- check_change_conflicts ---------------------------------------------------------

test("check_change_conflicts(calculate): plan previews the current conflicts, apply POSTs and journals", async () => {
  await scenario({}, async (calls, docs) => {
    const plan = out(
      await call("servicenow_check_change_conflicts", {
        sys_id: SYS_ID,
        calculate: true,
      }),
    );
    assert.equal(plan.mode, "plan");
    assert.equal(plan.table, "conflict");
    assert.ok(plan.before, "shows the conflicts it would replace");
    assert.equal(mutating(calls).length, 0);

    const read = out(
      await call("servicenow_check_change_conflicts", { sys_id: SYS_ID }),
    );
    assert.ok(read.result);
    assert.equal(mutating(calls).length, 0);

    const applied = out(
      await call("servicenow_check_change_conflicts", {
        sys_id: SYS_ID,
        calculate: true,
        apply: true,
        plan_token: plan.plan_token,
      }),
    );
    assert.ok(applied.result);
    assert.equal(mutating(calls).length, 1);
    const lines = readFileSync(
      path.join(docs, "default", "write-journal.jsonl"),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].action, "execute");
    assert.equal(lines[0].table, "conflict");
    assert.equal(lines[0].tool, "servicenow_check_change_conflicts");
  });
});

test("check_change_conflicts(calculate) needs a plan_token under SN_DESTRUCTIVE_CONFIRM=token; a read does not", async () => {
  await scenario({ SN_DESTRUCTIVE_CONFIRM: "token" }, async (calls) => {
    const read = out(
      await call("servicenow_check_change_conflicts", { sys_id: SYS_ID }),
    );
    assert.equal(read.error, undefined);
    const refused = out(
      await call("servicenow_check_change_conflicts", {
        sys_id: SYS_ID,
        calculate: true,
        apply: true,
      }),
    );
    assert.equal(refused.code, "PLAN_REQUIRED");
    assert.equal(mutating(calls).length, 0);
  });
});

// --- acceptance: no write reaches the instance without a policy verdict ---------

/** Valid arguments for every tool that can write to the instance. */
const WRITE_ARGS = {
  servicenow_create_record: { table: "incident", values: { a: "1" } },
  servicenow_update_record: {
    table: "incident",
    sys_id: SYS_ID,
    values: { a: "1" },
  },
  servicenow_upsert_record: {
    table: "incident",
    key: { number: "INC1" },
    values: { a: "1" },
  },
  servicenow_delete_record: { table: "incident", sys_id: SYS_ID },
  servicenow_upload_attachment: {
    table: "incident",
    sys_id: SYS_ID,
    file_name: "a.txt",
    content_base64: "aGVsbG8=",
  },
  servicenow_delete_attachment: { sys_id: SYS_ID },
  servicenow_insert_import_set_row: {
    table: "u_imp_x",
    values: { a: "1" },
  },
  servicenow_batch: {
    requests: [{ method: "POST", url: "/api/now/table/incident", body: {} }],
  },
  servicenow_order_catalog_item: { sys_id: SYS_ID },
  servicenow_create_change: { type: "normal", values: {} },
  servicenow_update_change: { sys_id: SYS_ID, values: { a: "1" } },
  servicenow_check_change_conflicts: { sys_id: SYS_ID, calculate: true },
  servicenow_create_ci: {
    table: "cmdb_ci_server",
    values: { a: "1" },
  },
  servicenow_update_ci: {
    table: "cmdb_ci_server",
    sys_id: SYS_ID,
    values: { a: "1" },
  },
  servicenow_identify_reconcile: {
    items: [{ className: "cmdb_ci_server", values: { name: "x" } }],
    data_source: "ServiceNow",
  },
  servicenow_send_email: { to: ["a@example.com"], subject: "s", body: "b" },
  servicenow_run_atf_test: { sys_id: SYS_ID },
  servicenow_run_atf_suite: { sys_id: SYS_ID },
  servicenow_check_code_health: { scan_run: "full" },
  servicenow_revert_write: { entry_id: "01J0000000000000000000000" },
  servicenow_set_property: { name: "glide.x", value: "1" },
  servicenow_upsert_artifact: {
    artifactType: "ui_policy",
    key: { short_description: "x", table: "incident" },
    values: { conditions: "active=true" },
    children: [{ values: { field: "priority", visible: "false" } }],
  },
};

/** The table each tool's write lands in, for the table-deny sweep. */
const WRITE_TABLE = {
  servicenow_create_record: "incident",
  servicenow_update_record: "incident",
  servicenow_upsert_record: "incident",
  servicenow_delete_record: "incident",
  servicenow_upload_attachment: "incident",
  servicenow_delete_attachment: "incident",
  servicenow_insert_import_set_row: "u_imp_x",
  servicenow_batch: "incident",
  servicenow_order_catalog_item: "sc_request",
  servicenow_create_change: "change_request",
  servicenow_update_change: "change_request",
  servicenow_check_change_conflicts: "conflict",
  servicenow_create_ci: "cmdb_ci_server",
  servicenow_update_ci: "cmdb_ci_server",
  servicenow_identify_reconcile: "cmdb_ci_server",
  servicenow_send_email: "sys_email",
  servicenow_run_atf_test: "sys_atf_test",
  servicenow_run_atf_suite: "sys_atf_test_suite",
  servicenow_check_code_health: "scan_result",
  servicenow_set_property: "sys_properties",
  servicenow_upsert_artifact: "sys_ui_policy",
  // revert_write takes its table from the journal entry (test/revert.test.js).
};

const instanceWriters = () =>
  ALL_TOOLS.filter((s) => "apply" in s.input).map((s) => s.name);

test("acceptance: the write sweep covers every tool with an apply argument", () => {
  assert.deepEqual(
    instanceWriters().sort(),
    Object.keys(WRITE_ARGS).sort(),
    "a new write tool needs WRITE_ARGS (and WRITE_TABLE) entries",
  );
});

test("acceptance: under SN_READONLY no write tool sends a mutating request", async () => {
  for (const name of instanceWriters()) {
    await scenario(
      { SN_READONLY: "1", SN_WRITE_MODE: "apply" },
      async (calls) => {
        const res = await call(name, WRITE_ARGS[name]);
        assert.equal(res.isError, true, `${name}: ${res.content[0].text}`);
        assert.equal(mutating(calls).length, 0, `${name} mutated`);
        if (name !== "servicenow_revert_write") {
          assert.match(
            res.content[0].text,
            /read-only|SN_READONLY/,
            `${name} was refused by the policy`,
          );
        }
      },
    );
  }
});

test("acceptance: with the target table denied no write tool sends a mutating request", async () => {
  for (const [name, table] of Object.entries(WRITE_TABLE)) {
    await scenario(
      { SN_TABLES_DENY: table, SN_WRITE_MODE: "apply" },
      async (calls) => {
        const res = await call(name, WRITE_ARGS[name]);
        assert.equal(res.isError, true, `${name}: ${res.content[0].text}`);
        assert.equal(mutating(calls).length, 0, `${name} mutated`);
        assert.match(
          res.content[0].text,
          new RegExp(`${table}.*SN_TABLES_DENY`),
          `${name} was refused by the table policy`,
        );
      },
    );
  }
});
