// P-22 — SDK-managed write guard. A write into a scope that P-3 detects as
// SDK-managed is previewed and applied with an `sdkManaged` warning (default
// `warn`), refused with SDK_MANAGED_SCOPE (`deny`) or ignored (`allow`). It
// runs after the H-11 table policy and costs nothing when detection is off.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ALL_TOOLS } from "../build/mcp/registry.js";
import { runSpec } from "../build/mcp/define.js";
import { scopeRefOf, SDK_ALTERNATIVE } from "../build/mcp/sdk-guard.js";
import { getSdkManagedWrites } from "../build/core/settings.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const call = (name, args) =>
  runSpec(
    ALL_TOOLS.find((s) => s.name === name),
    args,
  );
const out = (res) => JSON.parse(res.content[0].text);
const REC = "a".repeat(32);
const SDK_SCOPE_ID = "5".repeat(32);
const PLAIN_SCOPE_ID = "6".repeat(32);
const mutating = (calls) =>
  calls.filter((c) => (c.init?.method ?? "GET") !== "GET");

/**
 * sys_script_include/REC lives in x_acme_sdk (SDK-managed); sys_properties
 * rows and other records in x_acme_plain; incident has no sys_scope.
 */
function instance({ recordScope = SDK_SCOPE_ID } = {}) {
  return (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method !== "GET") {
      return jsonResponse(200, { result: { sys_id: REC, sys_mod_count: "2" } });
    }
    if (u.pathname === "/api/now/table/sys_scope") {
      const q = u.searchParams.get("sysparm_query") ?? "";
      const rows = [
        { sys_id: SDK_SCOPE_ID, scope: "x_acme_sdk" },
        { sys_id: PLAIN_SCOPE_ID, scope: "x_acme_plain" },
      ].filter((r) => q === `sys_id=${r.sys_id}` || q === `scope=${r.scope}`);
      return jsonResponse(200, { result: rows });
    }
    if (u.pathname.startsWith("/api/now/table/incident")) {
      const row = { sys_id: REC, short_description: "x" };
      return jsonResponse(200, {
        result: u.pathname.endsWith(REC) ? row : [row],
      });
    }
    if (u.pathname === "/api/now/table/sys_properties") {
      return jsonResponse(200, {
        result: [
          {
            sys_id: REC,
            name: "x_acme_sdk.flag",
            value: "a",
            type: "string",
            sys_scope: recordScope,
          },
        ],
      });
    }
    const row = {
      sys_id: REC,
      name: "Util",
      sys_scope: recordScope,
      sys_mod_count: "1",
    };
    return jsonResponse(200, {
      result: /\/[0-9a-f]{32}$/.test(u.pathname) ? row : [row],
    });
  };
}

async function scenario(env, fn, opts) {
  const docs = mkdtempSync(path.join(tmpdir(), "p22-"));
  freshRuntime();
  try {
    return await withEnv(
      { SN_DOCS_DIR: docs, SN_SDK_MANAGED_SCOPES: "x_acme_sdk", ...env },
      () => withFetch(instance(opts), (calls) => fn(calls)),
    );
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
}

const update = {
  table: "sys_script_include",
  sys_id: REC,
  fields: { script: "// x" },
};

test("settings: SN_SDK_MANAGED_WRITES defaults to warn", async () => {
  for (const [raw, want] of [
    [undefined, "warn"],
    ["deny", "deny"],
    [" ALLOW ", "allow"],
    ["bogus", "warn"],
  ]) {
    await withEnv({ SN_SDK_MANAGED_WRITES: raw }, () =>
      assert.equal(getSdkManagedWrites(), want, String(raw)),
    );
  }
});

test("scopeRefOf reads a sys_id, a name, a value pair or a link", () => {
  assert.deepEqual(scopeRefOf(SDK_SCOPE_ID), { sys_id: SDK_SCOPE_ID });
  assert.deepEqual(scopeRefOf("x_acme_sdk"), { scope: "x_acme_sdk" });
  assert.deepEqual(
    scopeRefOf({ value: SDK_SCOPE_ID, display_value: "x_acme_sdk" }),
    {
      sys_id: SDK_SCOPE_ID,
      scope: "x_acme_sdk",
    },
  );
  assert.deepEqual(scopeRefOf({ link: "https://x", value: SDK_SCOPE_ID }), {
    sys_id: SDK_SCOPE_ID,
    scope: null,
  });
  assert.equal(scopeRefOf(""), null);
  assert.equal(scopeRefOf(undefined), null);
});

test("warn (default): the plan and the applied result carry sdkManaged and the Fluent alternative", async () => {
  await scenario({}, async (calls) => {
    const plan = out(await call("servicenow_update_record", update));
    assert.equal(plan.mode, "plan");
    assert.equal(plan.sdkManaged.scope, "x_acme_sdk");
    assert.equal(plan.sdkManaged.mode, "warn");
    assert.equal(plan.sdkManaged.alternative, SDK_ALTERNATIVE);
    assert.equal(plan.sdkManaged.would_refuse, undefined);
    assert.equal(plan.sdkManaged.evidence[0].source, "declaration");
    const applied = out(
      await call("servicenow_update_record", { ...update, apply: true }),
    );
    assert.equal(applied.message, "Record updated");
    assert.equal(applied.sdkManaged.scope, "x_acme_sdk");
    assert.equal(mutating(calls).length, 1);
  });
});

test("deny: the plan says would_refuse; every guarded write tool refuses the apply without a mutating request (acceptance)", async () => {
  const cases = [
    ["servicenow_update_record", update],
    ["servicenow_delete_record", { table: "sys_script_include", sys_id: REC }],
    [
      "servicenow_create_record",
      {
        table: "sys_script_include",
        fields: { name: "U", sys_scope: SDK_SCOPE_ID },
      },
    ],
    [
      "servicenow_upsert_record",
      {
        table: "sys_script_include",
        key: { name: "Util" },
        fields: { script: "x" },
      },
    ],
    ["servicenow_set_property", { name: "x_acme_sdk.flag", value: "b" }],
  ];
  for (const [name, args] of cases) {
    await scenario({ SN_SDK_MANAGED_WRITES: "deny" }, async (calls) => {
      const plan = out(await call(name, args));
      assert.equal(plan.mode, "plan", name);
      assert.equal(
        plan.sdkManaged?.would_refuse,
        true,
        `${name}: ${JSON.stringify(plan)}`,
      );
      let applyArgs = { ...args, apply: true };
      if (plan.apply_with) applyArgs = { ...applyArgs, ...plan.apply_with };
      const res = out(await call(name, applyArgs));
      assert.equal(
        res.error?.code,
        "SDK_MANAGED_SCOPE",
        `${name}: ${JSON.stringify(res)}`,
      );
      assert.equal(res.error.status, 409);
      assert.match(res.error.hint, /now-sdk install/);
      assert.equal(mutating(calls).length, 0, name);
    });
  }
});

test("allow, or no detection configured: no sdkManaged and no extra read", async () => {
  for (const env of [
    { SN_SDK_MANAGED_WRITES: "allow" },
    { SN_SDK_MANAGED_SCOPES: undefined, SN_SDK_PROJECT_DIRS: undefined },
  ]) {
    await scenario(env, async (calls) => {
      const plan = out(await call("servicenow_update_record", update));
      assert.equal(plan.sdkManaged, undefined);
      assert.ok(
        calls.every(
          (c) =>
            !new URL(c.url).searchParams
              .get("sysparm_fields")
              ?.startsWith("sys_scope"),
        ),
        "no sys_scope read",
      );
      assert.ok(calls.every((c) => !c.url.includes("/sys_scope")));
    });
  }
});

test("records outside a managed scope, and tables without sys_scope, are not flagged", async () => {
  await scenario(
    { SN_SDK_MANAGED_WRITES: "deny" },
    async (calls) => {
      const r = await call("servicenow_update_record", {
        ...update,
        apply: true,
      });
      assert.equal(r.isError, undefined, r.content[0].text);
      assert.equal(out(r).sdkManaged, undefined);
      assert.equal(mutating(calls).length, 1);
    },
    { recordScope: PLAIN_SCOPE_ID },
  );
  await scenario({ SN_SDK_MANAGED_WRITES: "deny" }, async (calls) => {
    const r = await call("servicenow_update_record", {
      table: "incident",
      sys_id: REC,
      fields: { state: "2" },
      apply: true,
    });
    assert.equal(r.isError, undefined, r.content[0].text);
    assert.equal(mutating(calls).length, 1);
  });
});

test("an update that moves a record into a managed scope is caught by the written value", async () => {
  await scenario(
    { SN_SDK_MANAGED_WRITES: "deny" },
    async (calls) => {
      const res = out(
        await call("servicenow_update_record", {
          table: "sys_script_include",
          sys_id: REC,
          fields: { sys_scope: SDK_SCOPE_ID },
          apply: true,
        }),
      );
      assert.equal(res.error.code, "SDK_MANAGED_SCOPE");
      assert.equal(mutating(calls).length, 0);
    },
    { recordScope: PLAIN_SCOPE_ID },
  );
});

test("the table policy decides first: a denied write is POLICY_DENIED, not SDK_MANAGED_SCOPE", async () => {
  await scenario(
    { SN_SDK_MANAGED_WRITES: "deny", SN_TABLES_DENY: "sys_script_include" },
    async (calls) => {
      const res = out(
        await call("servicenow_update_record", { ...update, apply: true }),
      );
      assert.equal(res.error.code, "POLICY_DENIED");
      assert.equal(calls.length, 0);
    },
  );
});

test("ordering: a protected-table write (readable, not writable) is POLICY_DENIED before the guard judges it", async () => {
  await scenario(
    { SN_SDK_MANAGED_WRITES: "deny", SN_PROTECTED_TABLES_WRITE: "deny" },
    async (calls) => {
      const res = out(
        await call("servicenow_set_property", {
          name: "x_acme_sdk.flag",
          value: "b",
          apply: true,
        }),
      );
      assert.equal(res.error.code, "POLICY_DENIED");
      assert.equal(mutating(calls).length, 0);
    },
  );
});
