// N-14 — cross-scope access: scope-qualified calls joined with sys_scope_privilege.
import test from "node:test";
import assert from "node:assert/strict";

import {
  crossScopeReport,
  joinPrivileges,
  qualifiedScriptCalls,
} from "../build/api/cross-scope.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withMetadataFetch,
} from "./helpers.js";

baselineEnv();

const APP_ID = "a".repeat(32);

test("qualifiedScriptCalls: new, static and GlideAjax forms; unqualified calls ignored", () => {
  const calls = qualifiedScriptCalls(`
    var a = new x_other.Util();
    var b = sn_hr_core.HRUtils.getProfile(id);
    var c = new GlideAjax('global.AjaxHelper');
    var d = new LocalUtil();
    var e = gs.getUser().getName();
    var f = new x_other.Util(); // duplicate
    var g = foo.x_other.Hidden.call();
  `);
  assert.deepEqual(calls.map((c) => `${c.scope}.${c.name}`).sort(), [
    "global.AjaxHelper",
    "sn_hr_core.HRUtils",
    "x_other.Util",
  ]);
});

test("joinPrivileges: no row is missing; denied wins over requested and allowed", () => {
  const call = {
    targetScope: "x_other",
    targetType: "script_include",
    target: "Util",
  };
  assert.deepEqual(joinPrivileges(call, []), {
    status: "missing",
    operations: [],
  });
  const row = (status, operation = "execute", extra = {}) => ({
    targetScope: "x_other",
    targetType: "sys_script_include",
    target: "x_other.Util",
    operation,
    status,
    ...extra,
  });
  assert.equal(joinPrivileges(call, [row("allowed")]).status, "allowed");
  assert.equal(
    joinPrivileges(call, [row("allowed"), row("requested")]).status,
    "requested",
  );
  assert.equal(
    joinPrivileges(call, [row("allowed"), row("Denied", "read")]).status,
    "denied",
  );
  assert.deepEqual(
    joinPrivileges(call, [row("allowed", "read"), row("allowed", "execute")])
      .operations,
    ["execute", "read"],
  );
  // Another scope, another name or a table row never matches a script call.
  assert.equal(
    joinPrivileges(call, [
      row("allowed", "execute", { targetScope: "x_third" }),
      row("allowed", "execute", { target: "Other" }),
      row("allowed", "execute", { targetType: "sys_db_object" }),
    ]).status,
    "missing",
  );
  const table = {
    targetScope: "global",
    targetType: "table",
    target: "incident",
  };
  assert.equal(
    joinPrivileges(table, [
      {
        targetScope: "global",
        targetType: "sys_db_object",
        target: "incident",
        operation: "read",
        status: "allowed",
      },
    ]).status,
    "allowed",
  );
});

const tables = (overrides = {}) => ({
  sys_script_include: (q) =>
    q.includes(`sys_scope=${APP_ID}`)
      ? [
          {
            sys_id: "c".repeat(32),
            name: "AcmeUtils",
            script:
              "var a = new x_other.Util(); var b = new x_acme.Own(); var gr = new GlideRecord('incident'); var s = new GlideRecord('x_acme_request');",
          },
        ]
      : [],
  sys_db_object: [
    { name: "incident", "sys_scope.scope": "global" },
    { name: "x_acme_request", "sys_scope.scope": "x_acme" },
  ],
  sys_scope_privilege: (q) =>
    q.startsWith(`source_scope=${APP_ID}`)
      ? [
          {
            target_name: "incident",
            "target_scope.scope": "global",
            target_type: "sys_db_object",
            operation: "read",
            status: "allowed",
          },
        ]
      : [
          {
            "source_scope.scope": "x_third",
            target_name: "x_acme.AcmeUtils",
            target_type: "sys_script_include",
            operation: "execute",
            status: "requested",
          },
        ],
  sys_restricted_caller_access: [],
  ...overrides,
});

const route = (t) => (url) => {
  const u = new URL(url);
  const m = /\/api\/now\/table\/([^/?]+)/.exec(u.pathname);
  let entry = m ? t[m[1]] : [];
  if (typeof entry === "function") {
    entry = entry(u.searchParams.get("sysparm_query") ?? "");
  }
  if (typeof entry === "number") {
    return jsonResponse(entry, { error: { message: `status ${entry}` } });
  }
  return jsonResponse(200, { result: entry ?? [] });
};

test("a foreign script include with no privilege row is missing (done when); own scope is skipped", async () => {
  freshRuntime();
  await withMetadataFetch(route(tables()), async () => {
    const r = await crossScopeReport(APP_ID, "x_acme");
    const by = Object.fromEntries(
      r.outbound.map((c) => [`${c.targetScope}.${c.target}`, c]),
    );
    assert.equal(by["x_other.Util"].status, "missing");
    assert.equal(by["x_other.Util"].targetType, "script_include");
    assert.deepEqual(by["x_other.Util"].callers, [
      { type: "script_include", name: "AcmeUtils" },
    ]);
    assert.equal(by["global.incident"].status, "allowed");
    assert.deepEqual(by["global.incident"].operations, ["read"]);
    assert.ok(!("x_acme.Own" in by));
    assert.ok(!("x_acme.x_acme_request" in by));
    assert.equal(r.outbound[0].status, "missing", "missing sorts first");
    assert.equal(r.counts.missing, 1);
    assert.equal(r.counts.allowed, 1);
    assert.equal(r.inbound.length, 1);
    assert.equal(r.inbound[0].sourceScope, "x_third");
    assert.ok(r.scanned >= 1);
  });
});

test("an unreadable sys_scope_privilege degrades to missing with a caveat", async () => {
  freshRuntime();
  await withMetadataFetch(
    route(
      tables({ sys_scope_privilege: 403, sys_restricted_caller_access: 403 }),
    ),
    async () => {
      const r = await crossScopeReport(APP_ID, "x_acme");
      assert.ok(r.outbound.every((c) => c.status === "missing"));
      assert.ok(
        r.caveats.some((c) => /every outbound call shows as missing/.test(c)),
      );
      assert.ok(r.caveats.some((c) => /sys_restricted_caller_access/.test(c)));
      assert.deepEqual(r.inbound, []);
    },
  );
});
