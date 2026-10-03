// P-18 — registry-driven lint and search: the portal client / server rules,
// lint_script over the opt-in registry types, check_code_health's `extended`
// registry sweep, and where_used's `extended` search.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ALL_TOOLS } from "../build/mcp/registry.js";
import { runSpec } from "../build/mcp/define.js";
import { lintSource, lintArtifacts } from "../build/api/codecheck.js";
import { getArtifactType } from "../build/core/artifacts/registry.js";
import { SCRIPT_TYPES, OPT_IN_SCRIPT_TYPES } from "../build/api/scripts.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withMetadataFetch,
} from "./helpers.js";

baselineEnv();

const call = (name, args) =>
  runSpec(
    ALL_TOOLS.find((s) => s.name === name),
    args,
  );
const out = (res) => JSON.parse(res.content[0].text);
const rules = (findings) => findings.map((f) => `${f.rule}:${f.line}`);
const W = "a".repeat(32);
const U = "b".repeat(32);

test("portal client rules: $sce.trustAsHtml and $sceProvider.enabled(false), client scope only", () => {
  const src = [
    "c.html = $sce.trustAsHtml(c.data.body);",
    "c.x = $sce.trustAs($sce.HTML, v);",
    "$sceProvider.enabled(false);",
    "c.safe = c.data.body;",
  ].join("\n");
  assert.deepEqual(rules(lintSource(src, "client")), [
    "sce-trust-as-html:1",
    "sce-trust-as-html:2",
    "sanitize-bypass:3",
  ]);
  assert.deepEqual(
    rules(lintSource(src, "server")).filter((r) => !r.startsWith("syntax")),
    [],
  );
});

test("server rule: a $sp.getParameter value reaching an encoded query, a table name or eval", () => {
  const src = [
    'var q = $sp.getParameter("q");',
    'var t = $sp.getParameter("table");',
    "var gr = new GlideRecord(t);",
    "gr.addEncodedQuery(q);",
    'gr.addQuery("number", q);',
    "gr.get(q);",
    "var qq = 1; gr.addEncodedQuery(qq);",
    'gr.addEncodedQuery("active=true");',
    'gr.addEncodedQuery($sp.getParameter("x"));',
    "gs.eval(q);",
  ].join("\n");
  assert.deepEqual(
    rules(lintSource(src, "server")).filter((r) => r.startsWith("sp-param")),
    [
      "sp-param-unvalidated:3",
      "sp-param-unvalidated:4",
      "sp-param-unvalidated:9",
      "sp-param-unvalidated:10",
    ],
  );
  assert.deepEqual(
    rules(lintSource(src, "client")).filter((r) => r.startsWith("sp-param")),
    [],
    "server rule only",
  );
});

/** Every registry script table answers with one row unless listed. */
function instance(rows, statuses = {}) {
  return (url) => {
    const u = new URL(url);
    const m = /^\/api\/now\/table\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const table = m[1];
      if (statuses[table]) {
        return jsonResponse(statuses[table], { error: { message: "nope" } });
      }
      return jsonResponse(200, { result: rows[table] ?? [] });
    }
    const one = /^\/api\/now\/table\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    if (one) {
      const row = (rows[one[1]] ?? []).find((r) => r.sys_id === one[2]);
      return jsonResponse(row ? 200 : 404, row ? { result: row } : {});
    }
    if (u.pathname.startsWith("/api/now/stats/")) {
      return jsonResponse(200, { result: { stats: { count: "1" } } });
    }
    return jsonResponse(200, { result: [] });
  };
}

const ROWS = {
  sp_widget: [
    {
      sys_id: W,
      name: "Unsafe widget",
      client_script:
        "function($sce){ var c = this; c.h = $sce.trustAsHtml(c.data.x); }",
      script:
        '(function(){ var q = $sp.getParameter("q"); var gr = new GlideRecord("incident"); gr.addEncodedQuery(q); gr.setLimit(1); gr.query(); })();',
      link: "",
      css: ".x { color: red; }",
    },
  ],
  sys_ux_client_script: [
    {
      sys_id: U,
      name: "Client script",
      script: 'function handler(){ var gr = new GlideRecord("sys_user"); }',
    },
  ],
};

async function scenario(env, fn, rows = ROWS, statuses) {
  const docs = mkdtempSync(path.join(tmpdir(), "p18-"));
  freshRuntime();
  try {
    return await withEnv({ SN_DOCS_DIR: docs, ...env }, () =>
      withMetadataFetch(instance(rows, statuses), (calls) => fn(calls)),
    );
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
}

test("lint_script: opt-in registry types use their client fields", async () => {
  await scenario({}, async () => {
    const r = out(
      await call("servicenow_lint_script", {
        type: "uib_client_script",
        sys_id: U,
      }),
    );
    assert.equal(r.results[0].field, "script");
    assert.ok(r.results[0].findings.some((f) => f.rule === "gr-on-client"));
    const w = out(
      await call("servicenow_lint_script", { type: "sp_widget", sys_id: W }),
    );
    const byField = Object.fromEntries(
      w.results.map((x) => [x.field, x.findings.map((f) => f.rule)]),
    );
    assert.ok(byField.client_script.includes("sce-trust-as-html"));
    assert.ok(byField.script.includes("sp-param-unvalidated"));
    assert.equal(byField.css, undefined, "markup is not linted");
  });
});

test("check_code_health extended: findings in a widget and a UX client script (acceptance)", async () => {
  await scenario({}, async (calls) => {
    const r = out(
      await call("servicenow_check_code_health", { extended: true }),
    );
    const a = r.artifacts;
    assert.ok(a, JSON.stringify(r).slice(0, 400));
    assert.ok(a.types.sp_widget.findingCount >= 2);
    assert.ok(a.types.uib_client_script.findingCount >= 1);
    const hit = (type) => a.results.find((x) => x.type === type);
    assert.equal(hit("sp_widget").sys_id, W);
    assert.equal(hit("uib_client_script").sys_id, U);
    assert.ok("uib_client_script" in r.scriptCounts, "opt-in types counted");
    // Every lintable registry type was read once, newest first, bounded.
    const reads = calls
      .map((c) => new URL(c.url))
      .filter((u) => /^\/api\/now\/table\/[^/]+$/.test(u.pathname));
    // The sweep's reads (the security scan in check_code_health reads other tables).
    const sweep = reads.filter((u) =>
      /ORDERBYDESCsys_updated_on$/.test(
        u.searchParams.get("sysparm_query") ?? "",
      ),
    );
    const tables = new Set(sweep.map((u) => u.pathname.split("/").pop()));
    // Exactly the tables of the types with a non-markup (JavaScript) field.
    const expected = new Set(
      Object.entries({ ...SCRIPT_TYPES, ...OPT_IN_SCRIPT_TYPES })
        .filter(([type, d]) => {
          const markup = getArtifactType(type).markupFields ?? [];
          return d.scriptFields.some((f) => !markup.includes(f));
        })
        .map(([, d]) => d.table),
    );
    assert.deepEqual([...tables].sort(), [...expected].sort());
    const w = reads.find((u) => u.pathname.endsWith("/sp_widget"));
    assert.match(
      w.searchParams.get("sysparm_query"),
      /ORDERBYDESCsys_updated_on$/,
    );
    assert.equal(w.searchParams.get("sysparm_limit"), "51");
    assert.match(w.searchParams.get("sysparm_fields"), /client_script/);
    assert.doesNotMatch(w.searchParams.get("sysparm_fields"), /css/);
  });
});

test("check_code_health: without extended nothing is swept; an unreadable type is a warning; limit caps and flags", async () => {
  await scenario({}, async (calls) => {
    const r = out(await call("servicenow_check_code_health", {}));
    assert.equal(r.artifacts, undefined);
    assert.equal("uib_client_script" in r.scriptCounts, false);
    assert.ok(
      calls.every(
        (c) => !new URL(c.url).pathname.startsWith("/api/now/table/sp_widget"),
      ),
    );
  });
  const many = {
    ...ROWS,
    sp_widget: [
      ROWS.sp_widget[0],
      { ...ROWS.sp_widget[0], sys_id: "c".repeat(32) },
    ],
  };
  await scenario(
    {},
    async () => {
      const a = await lintArtifacts({ limit: 1 });
      assert.equal(a.types.sp_widget.scanned, 1);
      assert.equal(a.types.sp_widget.capped, true);
      assert.equal(a.types.uib_client_script, undefined);
      assert.ok(a.warnings.some((w) => w.startsWith("uib_client_script")));
    },
    many,
    { sys_ux_client_script: 404 },
  );
});

test("where_used extended also searches the opt-in types", async () => {
  for (const extended of [false, true]) {
    await scenario({}, async (calls) => {
      await call("servicenow_where_used", {
        kind: "script",
        name: "MyUtil",
        structural: false,
        ...(extended ? { extended } : {}),
      });
      const uxRead = calls.some((c) =>
        new URL(c.url).pathname.endsWith("/sys_ux_client_script"),
      );
      assert.equal(uxRead, extended);
    });
  }
});
