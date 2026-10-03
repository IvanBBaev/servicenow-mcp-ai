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
// These tests drive destructive apply:true calls directly; the H-3 plan-token
// gate (the 3.0 default SN_DESTRUCTIVE_CONFIRM=token, B4) is covered in
// plan-token.test.js, so this file opts out explicitly.
process.env.SN_DESTRUCTIVE_CONFIRM = "off";

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
  values: { script: "// x" },
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
        values: { name: "U", sys_scope: SDK_SCOPE_ID },
      },
    ],
    [
      "servicenow_upsert_record",
      {
        table: "sys_script_include",
        key: { name: "Util" },
        values: { script: "x" },
      },
    ],
    ["servicenow_set_property", { name: "x_acme_sdk.flag", value: "b" }],
  ];
  for (const [name, args] of cases) {
    // set_property writes sys_properties, a protected table (write-denied by
    // default since 3.0, B11); opt out so the guard itself is what refuses.
    const env = { SN_SDK_MANAGED_WRITES: "deny" };
    if (name === "servicenow_set_property")
      env.SN_PROTECTED_TABLES_WRITE = "allow";
    await scenario(env, async (calls) => {
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
        res?.code,
        "SDK_MANAGED_SCOPE",
        `${name}: ${JSON.stringify(res)}`,
      );
      assert.equal(res.status, 409);
      assert.match(res.hint, /now-sdk install/);
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
      values: { state: "2" },
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
          values: { sys_scope: SDK_SCOPE_ID },
          apply: true,
        }),
      );
      assert.equal(res.code, "SDK_MANAGED_SCOPE");
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
      assert.equal(res.code, "POLICY_DENIED");
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
      assert.equal(res.code, "POLICY_DENIED");
      assert.equal(mutating(calls).length, 0);
    },
  );
});

/** Like `scenario`, with `route(url, init)` answering first (null = fall through). */
async function scenarioWith(env, route, fn, opts) {
  const docs = mkdtempSync(path.join(tmpdir(), "p22-"));
  freshRuntime();
  const base = instance(opts);
  try {
    return await withEnv(
      { SN_DOCS_DIR: docs, SN_SDK_MANAGED_SCOPES: "x_acme_sdk", ...env },
      () =>
        withFetch(
          (url, init) => route(new URL(url), init) ?? base(url, init),
          (calls) => fn(calls),
        ),
    );
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
}

const batchWrite = {
  requests: [
    {
      id: "si",
      method: "PATCH",
      url: `/api/now/table/sys_script_include/${REC}`,
      body: { script: "// x" },
    },
    {
      id: "inc",
      method: "PATCH",
      url: `/api/now/table/incident/${REC}`,
      body: { state: "2" },
    },
    { method: "GET", url: "/api/now/table/sys_script_include?sysparm_limit=1" },
  ],
};

test("batch: write sub-requests to a managed scope are flagged in the plan and refused in deny before the batch is sent", async () => {
  await scenario({ SN_SDK_MANAGED_WRITES: "deny" }, async (calls) => {
    const plan = out(await call("servicenow_batch", batchWrite));
    assert.equal(plan.mode, "plan");
    assert.equal(plan.would_refuse, true);
    const [si, inc, get] = plan.after.requests;
    assert.equal(si.sdkManaged?.scope, "x_acme_sdk");
    assert.equal(si.sdkManaged.would_refuse, true);
    assert.equal(inc.sdkManaged, undefined);
    assert.equal(get.sdkManaged, undefined);
    const res = out(
      await call("servicenow_batch", { ...batchWrite, apply: true }),
    );
    assert.equal(res?.code, "SDK_MANAGED_SCOPE", JSON.stringify(res));
    assert.equal(mutating(calls).length, 0);
  });
});

test("batch: warn mode applies the batch and reports sdkManaged per sub-request", async () => {
  await scenario({}, async (calls) => {
    const res = await call("servicenow_batch", { ...batchWrite, apply: true });
    assert.equal(res.isError, undefined, res.content[0].text);
    const body = out(res);
    assert.deepEqual(
      body.sdkManaged.map((g) => g.request),
      ["si"],
    );
    assert.equal(body.sdkManaged[0].scope, "x_acme_sdk");
    assert.equal(mutating(calls).length, 1, "one batch envelope");
  });
});

/** sys_script_include extends sys_metadata. */
const metadataChain = (u) =>
  u.pathname === "/api/now/table/sys_db_object"
    ? jsonResponse(200, {
        result: [
          {
            "super_class.name": /name=sys_script_include/.test(
              u.searchParams.get("sysparm_query") ?? "",
            )
              ? "sys_metadata"
              : "",
          },
        ],
      })
    : null;

const createNoScope = {
  table: "sys_script_include",
  values: { name: "U", script: "// x" },
};

test("create without sys_scope: the session's current application decides (apps.current_app)", async () => {
  const route = (u) =>
    metadataChain(u) ??
    (u.pathname === "/api/now/table/sys_user_preference"
      ? jsonResponse(200, {
          result: /name=apps\.current_app/.test(
            u.searchParams.get("sysparm_query") ?? "",
          )
            ? [{ sys_id: REC, value: SDK_SCOPE_ID, user: REC }]
            : [],
        })
      : null);
  await scenarioWith(
    { SN_SDK_MANAGED_WRITES: "deny" },
    route,
    async (calls) => {
      const plan = out(await call("servicenow_create_record", createNoScope));
      assert.equal(plan.sdkManaged?.would_refuse, true, JSON.stringify(plan));
      assert.equal(plan.sdkManaged.scope, "x_acme_sdk");
      assert.equal(plan.sdkManaged.scope_source, "current_application");
      const res = out(
        await call("servicenow_create_record", {
          ...createNoScope,
          apply: true,
        }),
      );
      assert.equal(res?.code, "SDK_MANAGED_SCOPE");
      assert.equal(mutating(calls).length, 0);
    },
  );
});

test("create without sys_scope: no preference row is global (not flagged); a failed read warns and never crashes", async () => {
  const empty = (u) =>
    metadataChain(u) ??
    (u.pathname === "/api/now/table/sys_user_preference"
      ? jsonResponse(200, { result: [] })
      : null);
  await scenarioWith(
    { SN_SDK_MANAGED_WRITES: "deny" },
    empty,
    async (calls) => {
      const res = await call("servicenow_create_record", {
        ...createNoScope,
        apply: true,
      });
      assert.equal(res.isError, undefined, res.content[0].text);
      assert.equal(out(res).sdkManaged, undefined);
      assert.equal(mutating(calls).length, 1);
    },
  );
  const failing = (u) =>
    metadataChain(u) ??
    (u.pathname === "/api/now/table/sys_user_preference"
      ? jsonResponse(403, { error: { message: "ACL" } })
      : null);
  await scenarioWith({ SN_SDK_MANAGED_WRITES: "deny" }, failing, async () => {
    const plan = out(await call("servicenow_create_record", createNoScope));
    assert.equal(plan.mode, "plan");
    assert.equal(plan.sdkManaged, undefined);
    assert.match(plan.sdkScopeWarning, /apps\.current_app/);
    const res = await call("servicenow_create_record", {
      ...createNoScope,
      apply: true,
    });
    assert.equal(res.isError, undefined, res.content[0].text);
    assert.match(out(res).sdkScopeWarning, /apps\.current_app/);
  });
});

test("with no detection configured a create reads no preference and no hierarchy", async () => {
  await scenarioWith(
    { SN_SDK_MANAGED_SCOPES: undefined, SN_SDK_PROJECT_DIRS: "" },
    () => null,
    async (calls) => {
      await call("servicenow_create_record", createNoScope);
      assert.ok(
        calls.every(
          (c) =>
            !c.url.includes("sys_user_preference") &&
            !c.url.includes("sys_db_object"),
        ),
      );
    },
  );
});
