// H-11 — policy model v2: glob patterns with a fixed precedence, protected
// tables (opt-in write deny), an import-set allowlist, one evaluator shared by
// the guards, servicenow_explain_policy and servicenow://policy, per-session
// write caps, and the per-profile environment marker (prod).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { ALL_TOOLS } from "../build/mcp/registry.js";
import { runSpec } from "../build/mcp/define.js";
import { setServer } from "../build/mcp/context.js";
import {
  PROTECTED_TABLES,
  assertTableAllowed,
  assertTableWriteAllowed,
  evaluateTable,
  globToRegExp,
} from "../build/core/policy.js";
import { policyResourcePayload } from "../build/mcp/policy-view.js";
import {
  getDestructiveConfirm,
  getProfileEnv,
  getWriteMode,
  writeModeHold,
} from "../build/core/settings.js";
import { environmentCaution } from "../build/mcp/prompts.js";
import { buildServerInstructions } from "../build/mcp/server-info.js";
import { checkCapabilities } from "../build/api/capabilities.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const spec = (name) => ALL_TOOLS.find((s) => s.name === name);
const call = (name, args) => runSpec(spec(name), args);
const out = (res) => JSON.parse(res.content[0].text);
const SYS_ID = "a".repeat(32);
const mutating = (calls) =>
  calls.filter((c) => (c.init?.method ?? "GET") !== "GET");

function instance() {
  return (url, init) => {
    const method = init?.method ?? "GET";
    if (method === "DELETE") return new Response(null, { status: 204 });
    const row = { sys_id: SYS_ID, sys_mod_count: "1", table_name: "incident" };
    const u = new URL(url);
    if (/\/api\/now\/table\/[^/]+$/.test(u.pathname) && method === "GET") {
      return jsonResponse(200, { result: [row] });
    }
    return jsonResponse(200, { result: row });
  };
}

async function scenario(env, fn) {
  const docs = mkdtempSync(path.join(tmpdir(), "h11-"));
  freshRuntime();
  try {
    return await withEnv({ SN_DOCS_DIR: docs, ...env }, () =>
      withFetch(instance(), (calls) => fn(calls, docs)),
    );
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
}

function journal(docs, profile = "default") {
  const file = path.join(docs, profile, "write-journal.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// --- evaluator ---------------------------------------------------------------

test("glob: a pattern without wildcards behaves as an exact match (property)", () => {
  const name = fc.stringMatching(/^[a-z0-9_]{1,20}$/);
  fc.assert(
    fc.property(name, name, (entry, table) => {
      assert.equal(globToRegExp(entry), null);
      return withEnvSync(
        { SN_TABLES_DENY: entry },
        () => evaluateTable(table).allowed === (entry !== table),
      );
    }),
  );
});

/** withEnv for synchronous bodies inside a property. */
function withEnvSync(overrides, fn) {
  const saved = Object.fromEntries(
    Object.keys(overrides).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("glob: * and ? match, anchored, case-insensitive table names", () => {
  assert.ok(globToRegExp("sys_*").test("sys_user"));
  assert.ok(!globToRegExp("sys_*").test("x_sys_user"));
  assert.ok(globToRegExp("u_?mp").test("u_imp"));
  assert.ok(!globToRegExp("u_?mp").test("u_iimp"));
  withEnvSync({ SN_TABLES_DENY: "SYS_*" }, () => {
    assert.equal(evaluateTable("sys_user").allowed, false);
    assert.equal(evaluateTable("incident").allowed, true);
  });
});

test("precedence: exact deny > exact allow > pattern deny > protected > allow patterns", () => {
  const cases = [
    // [allow, deny, table, action, protectedWrite, allowed, rule]
    ["", "", "incident", "read", "allow", true, "no-policy"],
    ["", "sys_*", "sys_user", "read", "allow", false, "deny-pattern"],
    ["", "sys_*", "incident", "read", "allow", true, "no-policy"],
    ["sys_user", "sys_*", "sys_user", "read", "allow", true, "allow-exact"],
    ["sys_user", "sys_user", "sys_user", "read", "allow", false, "deny-exact"],
    ["u_*,incident", "", "u_x", "read", "allow", true, "allow-pattern"],
    ["u_*,incident", "", "problem", "read", "allow", false, "not-in-allowlist"],
    ["u_*", "u_secret", "u_secret", "read", "allow", false, "deny-exact"],
    ["", "", "sys_user_has_role", "write", "deny", false, "protected-default"],
    ["", "", "sys_user_has_role", "read", "deny", true, "no-policy"],
    ["", "", "sys_user_has_role", "write", "allow", true, "no-policy"],
    [
      "sys_user_has_role",
      "",
      "sys_user_has_role",
      "write",
      "deny",
      true,
      "allow-exact",
    ],
    [
      "sys_*",
      "",
      "sys_user_has_role",
      "write",
      "deny",
      false,
      "protected-default",
    ],
    [
      "",
      "",
      "sys_ldap_server_config",
      "write",
      "deny",
      false,
      "protected-default",
    ],
    ["", "", "incident", "write", "deny", true, "no-policy"],
  ];
  for (const [allow, deny, table, action, pw, allowed, rule] of cases) {
    withEnvSync(
      {
        SN_TABLES_ALLOW: allow,
        SN_TABLES_DENY: deny,
        SN_PROTECTED_TABLES_WRITE: pw,
      },
      () => {
        const v = evaluateTable(table, action);
        const label = JSON.stringify({ allow, deny, table, action, pw });
        assert.equal(v.allowed, allowed, label);
        assert.equal(v.rule, rule, label);
      },
    );
  }
});

test("the guards throw POLICY_DENIED with the evaluator's reason", () => {
  withEnvSync(
    { SN_TABLES_DENY: "sys_*", SN_PROTECTED_TABLES_WRITE: "deny" },
    () => {
      assert.throws(
        () => assertTableAllowed("sys_user"),
        (e) =>
          e.code === "POLICY_DENIED" &&
          e.status === 403 &&
          /pattern "sys_\*"/.test(e.message),
      );
      assert.doesNotThrow(() => assertTableAllowed("incident"));
      assert.throws(
        () => assertTableWriteAllowed("oauth_entity"),
        (e) => e.code === "POLICY_DENIED",
      );
    },
  );
  assert.ok(PROTECTED_TABLES.includes("sys_user_has_role"));
});

test("acceptance: create_record on sys_user_has_role is refused under the protected default; an exact allow re-enables it", async () => {
  await scenario(
    { SN_WRITE_MODE: "apply", SN_PROTECTED_TABLES_WRITE: "deny" },
    async (calls) => {
      const res = out(
        await call("servicenow_create_record", {
          table: "sys_user_has_role",
          fields: { user: "x", role: "admin" },
        }),
      );
      assert.equal(res.error.code, "POLICY_DENIED");
      assert.match(res.error.message, /protected table/);
      assert.match(res.error.message, /SN_TABLES_ALLOW/);
      assert.equal(mutating(calls).length, 0);
    },
  );
  await scenario(
    {
      SN_WRITE_MODE: "apply",
      SN_PROTECTED_TABLES_WRITE: "deny",
      SN_TABLES_ALLOW: "sys_user_has_role",
    },
    async (calls) => {
      const res = await call("servicenow_create_record", {
        table: "sys_user_has_role",
        fields: { user: "x", role: "admin" },
      });
      assert.equal(res.isError, undefined, res.content[0].text);
      assert.equal(mutating(calls).length, 1);
    },
  );
  // The default (allow) keeps today's behaviour.
  await scenario({ SN_WRITE_MODE: "apply" }, async (calls) => {
    const res = await call("servicenow_create_record", {
      table: "sys_user_has_role",
      fields: { user: "x" },
    });
    assert.equal(res.isError, undefined, res.content[0].text);
    assert.equal(mutating(calls).length, 1);
  });
});

test("protected tables: batch writes and set_property meet the rule; reads do not", async () => {
  await scenario(
    { SN_WRITE_MODE: "apply", SN_PROTECTED_TABLES_WRITE: "deny" },
    async (calls) => {
      const batch = out(
        await call("servicenow_batch", {
          requests: [
            { method: "POST", url: "/api/now/table/sys_user", body: {} },
          ],
        }),
      );
      assert.equal(batch.error.code, "POLICY_DENIED");
      const prop = out(
        await call("servicenow_set_property", { name: "glide.x", value: "1" }),
      );
      assert.equal(prop.error.code, "POLICY_DENIED");
      assert.equal(mutating(calls).length, 0);
      const read = await call("servicenow_get_record", {
        table: "sys_user",
        sys_id: SYS_ID,
      });
      assert.equal(read.isError, undefined, read.content[0].text);
    },
  );
});

test("SN_IMPORT_SET_TABLES: the staging table must match a pattern", async () => {
  await scenario(
    { SN_WRITE_MODE: "apply", SN_IMPORT_SET_TABLES: "u_*,imp_*" },
    async (calls) => {
      const bad = out(
        await call("servicenow_insert_import_set_row", {
          staging_table: "incident",
          fields: { a: "1" },
        }),
      );
      assert.equal(bad.error.code, "POLICY_DENIED");
      assert.match(bad.error.message, /SN_IMPORT_SET_TABLES/);
      assert.equal(mutating(calls).length, 0);
      const good = await call("servicenow_insert_import_set_row", {
        staging_table: "u_imp_users",
        fields: { a: "1" },
      });
      assert.equal(good.isError, undefined, good.content[0].text);
      assert.equal(mutating(calls).length, 1);
    },
  );
});

// --- explain_policy / servicenow://policy -----------------------------------------

test("explain_policy answers with the guards' own verdict (acceptance: sys_user update → protected-default)", async () => {
  await scenario({ SN_PROTECTED_TABLES_WRITE: "deny" }, async (calls) => {
    const r = out(
      await call("servicenow_explain_policy", {
        table: "sys_user",
        action: "write",
      }),
    );
    assert.equal(r.allowed, false);
    assert.equal(r.rule, "protected-default");
    assert.equal(r.protected, true);
    const read = out(
      await call("servicenow_explain_policy", { table: "sys_user" }),
    );
    assert.equal(read.allowed, true);
    assert.equal(read.action, "read");
    assert.equal(calls.length, 0, "local only");
  });
  // Same evaluator: over a grid of policies and tables, explain == guard.
  const tables = ["incident", "sys_user", "u_x", "sys_ldap_x", "problem"];
  const policies = [
    {},
    { SN_TABLES_DENY: "sys_*" },
    { SN_TABLES_ALLOW: "u_*,incident" },
    { SN_TABLES_ALLOW: "sys_user", SN_TABLES_DENY: "sys_*" },
    { SN_PROTECTED_TABLES_WRITE: "deny" },
    { SN_READONLY: "1" },
  ];
  for (const env of policies) {
    await scenario(env, async () => {
      for (const table of tables) {
        for (const action of ["read", "write"]) {
          const r = out(
            await call("servicenow_explain_policy", { table, action }),
          );
          let guard = true;
          try {
            if (action === "read") assertTableAllowed(table);
            else {
              assertTableWriteAllowed(table);
              if (env.SN_READONLY) guard = false;
            }
          } catch {
            guard = false;
          }
          assert.equal(
            r.allowed,
            guard,
            JSON.stringify({ env, table, action }),
          );
        }
      }
    });
  }
});

test("explain_policy without a table and servicenow://policy return the effective policy", async () => {
  await scenario(
    {
      SN_TABLES_DENY: "sys_*,hr_case",
      SN_PROFILE_PROD_INSTANCE: "dev11111.service-now.com",
      SN_PROFILE_PROD_USER: "u",
      SN_PROFILE_PROD_PASSWORD: "p",
      SN_PROFILE_PROD_TABLES_ALLOW: "incident",
    },
    async () => {
      const p = out(await call("servicenow_explain_policy", {}));
      assert.deepEqual(p.tables.deny, {
        exact: ["hr_case"],
        patterns: ["sys_*"],
      });
      assert.equal(p.protectedTables.write, "allow");
      assert.ok(p.protectedTables.list.includes("sys_rest_message*"));
      const res = policyResourcePayload();
      assert.equal(res.activeProfile, "default");
      assert.deepEqual(res.profiles.prod.tables.allow.exact, ["incident"]);
      assert.deepEqual(res.profiles.default.tables.allow.exact, []);
    },
  );
});

// --- write caps ------------------------------------------------------------------

test("write caps: the cap+1th delete fails with WRITE_CAP before any request and is journaled", async () => {
  await scenario(
    { SN_WRITE_MODE: "apply", SN_MAX_DELETES_PER_SESSION: "2" },
    async (calls, docs) => {
      for (let i = 0; i < 2; i++) {
        const ok = await call("servicenow_delete_record", {
          table: "incident",
          sys_id: SYS_ID,
        });
        assert.equal(ok.isError, undefined, ok.content[0].text);
      }
      const before = calls.length;
      const refused = out(
        await call("servicenow_delete_record", {
          table: "incident",
          sys_id: SYS_ID,
        }),
      );
      assert.equal(refused.error.code, "WRITE_CAP");
      assert.equal(refused.error.status, 429);
      assert.equal(mutating(calls).length, 2);
      assert.ok(
        calls.slice(before).every((c) => (c.init?.method ?? "GET") === "GET"),
      );
      const last = journal(docs).at(-1);
      assert.equal(last.result, "refused");
      assert.equal(last.cap_hit, true);
      // Other writes are not deletes.
      const update = await call("servicenow_update_record", {
        table: "incident",
        sys_id: SYS_ID,
        fields: { a: "1" },
      });
      assert.equal(update.isError, undefined, update.content[0].text);
      const status = out(await call("servicenow_get_status", {}));
      assert.deepEqual(status.writes.caps.deletes, { used: 2, max: 2 });
      assert.equal(status.writes.caps.writes.used, 3);
      assert.equal(status.writes.caps.writes.max, null);
    },
  );
});

test("write caps: a batch counts its write sub-requests; SN_MAX_BATCH_WRITES caps one batch; a new session resets", async () => {
  const batchOk = () =>
    jsonResponse(200, {
      batch_request_id: "1",
      serviced_requests: [{ id: "1", status_code: 200, body: btoa("{}") }],
      unserviced_requests: [],
    });
  const req = (n) => ({
    requests: Array.from({ length: n }, () => ({
      method: "PATCH",
      url: `/api/now/table/incident/${SYS_ID}`,
      body: { a: "1" },
    })),
  });
  await scenario(
    {
      SN_WRITE_MODE: "apply",
      SN_MAX_WRITES_PER_SESSION: "5",
      SN_MAX_BATCH_WRITES: "3",
    },
    async () => {
      await withFetch(batchOk, async (calls) => {
        const tooBig = out(await call("servicenow_batch", req(4)));
        assert.equal(tooBig.error.code, "WRITE_CAP");
        assert.match(tooBig.error.message, /SN_MAX_BATCH_WRITES/);
        assert.equal(calls.length, 0);
        assert.equal(
          (await call("servicenow_batch", req(3))).isError,
          undefined,
        );
        const over = out(await call("servicenow_batch", req(3)));
        assert.equal(over.error.code, "WRITE_CAP");
        assert.match(over.error.message, /3 of 5 writes/);
        assert.equal(calls.length, 1);
        freshRuntime();
        assert.equal(
          (await call("servicenow_batch", req(3))).isError,
          undefined,
        );
        assert.equal(calls.length, 2);
      });
    },
  );
});

// --- environment marker ----------------------------------------------------------

test("env: SN_ENV / SN_PROFILE_<NAME>_ENV parse; unknown values are unmarked", async () => {
  await withEnv({ SN_ENV: " PROD " }, () =>
    assert.equal(getProfileEnv(), "prod"),
  );
  await withEnv({ SN_ENV: "staging" }, () =>
    assert.equal(getProfileEnv(), undefined),
  );
  await withEnv({ SN_PROFILE_DEV_ENV: "dev", SN_ENV: "prod" }, () => {
    assert.equal(getProfileEnv("dev"), "dev");
    assert.equal(
      getProfileEnv("other"),
      undefined,
      "SN_ENV is the default profile's",
    );
  });
});

test("env: a prod profile configured for apply stays in plan mode until acknowledged, and says why (acceptance)", async () => {
  await scenario({ SN_ENV: "prod", SN_WRITE_MODE: "apply" }, async (calls) => {
    assert.equal(getWriteMode(), "plan");
    assert.match(writeModeHold(), /SN_PROD_WRITES=I_UNDERSTAND/);
    const res = await call("servicenow_update_record", {
      table: "incident",
      sys_id: SYS_ID,
      fields: { a: "1" },
    });
    const body = out(res);
    assert.equal(body.mode, "plan");
    assert.match(body.write_mode_hold, /marked prod/);
    assert.deepEqual(res._meta, { environment: "prod" });
    assert.equal(mutating(calls).length, 0);
    assert.match(
      buildServerInstructions("0.0.0"),
      /Environment: prod\. Writes: plan — Profile "default" is marked prod/,
    );
    const status = out(await call("servicenow_get_status", {}));
    assert.equal(status.profileDetails[0].env, "prod");
    assert.equal(status.profileDetails[0].writeMode, "plan");
    assert.match(status.profileDetails[0].writeModeHold, /I_UNDERSTAND/);
  });
  await scenario(
    { SN_ENV: "prod", SN_WRITE_MODE: "apply", SN_PROD_WRITES: "I_UNDERSTAND" },
    () => {
      assert.equal(getWriteMode(), "apply");
      assert.equal(writeModeHold(), undefined);
    },
  );
  // A per-profile write mode, with the default staying in plan.
  await withEnv(
    {
      SN_PROFILE_DEV_INSTANCE: "dev22222.service-now.com",
      SN_PROFILE_DEV_WRITE_MODE: "apply",
      SN_WRITE_MODE: undefined,
    },
    () => {
      assert.equal(getWriteMode("dev"), "apply");
      assert.equal(getWriteMode("default"), "plan");
    },
  );
});

async function connectedServer(capabilities, answer) {
  const server = new McpServer({ name: "h11", version: "0.0.0" });
  setServer(server);
  const client = new Client({ name: "c", version: "0.0.0" }, { capabilities });
  if (capabilities.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async () => answer());
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return async () => {
    setServer(null);
    await client.close();
    await server.close();
  };
}

test("env: prod destructive applies are confirmed even in acknowledged apply mode", async () => {
  const env = {
    SN_ENV: "prod",
    SN_WRITE_MODE: "apply",
    SN_PROD_WRITES: "I_UNDERSTAND",
  };
  const del = { table: "incident", sys_id: SYS_ID };
  await scenario(env, async (calls, docs) => {
    assert.equal(getDestructiveConfirm(), "elicit");
    // No elicitation → CONFIRM_REQUIRED.
    const close1 = await connectedServer({});
    try {
      const r = out(await call("servicenow_delete_record", del));
      assert.equal(r.error.code, "CONFIRM_REQUIRED");
    } finally {
      await close1();
    }
    // Declined → refused and journaled.
    const close2 = await connectedServer({ elicitation: {} }, () => ({
      action: "decline",
    }));
    try {
      const r = out(await call("servicenow_delete_record", del));
      assert.equal(r.error.code, "CONFIRM_DECLINED");
    } finally {
      await close2();
    }
    assert.equal(mutating(calls).length, 0);
    assert.equal(journal(docs).at(-1).result, "refused");
    // Confirmed → deleted. A non-destructive write needs no confirmation.
    const close3 = await connectedServer({ elicitation: {} }, () => ({
      action: "accept",
      content: { confirm: true },
    }));
    try {
      const r = await call("servicenow_delete_record", del);
      assert.equal(r.isError, undefined, r.content[0].text);
    } finally {
      await close3();
    }
    const upd = await call("servicenow_update_record", {
      ...del,
      fields: { a: "1" },
    });
    assert.equal(upd.isError, undefined, upd.content[0].text);
    assert.equal(mutating(calls).length, 2);
  });
  // An unmarked profile in apply mode keeps the H-3 bypass.
  await scenario({ SN_WRITE_MODE: "apply" }, async (calls) => {
    const r = await call("servicenow_delete_record", del);
    assert.equal(r.isError, undefined, r.content[0].text);
    assert.equal(r._meta, undefined);
    assert.equal(mutating(calls).length, 1);
  });
});

test("env: the overview prompt and use_instance follow the marker", async () => {
  await withEnv({ SN_ENV: "prod" }, () =>
    assert.match(environmentCaution(), /marked PRODUCTION/),
  );
  await withEnv({ SN_ENV: "dev" }, () =>
    assert.match(environmentCaution(), /marked dev/),
  );
  await withEnv({ SN_ENV: undefined }, () =>
    assert.match(environmentCaution(), /no environment marker/),
  );
  await scenario(
    {
      SN_PROFILE_PROD_INSTANCE: "dev11111.service-now.com",
      SN_PROFILE_PROD_USER: "u",
      SN_PROFILE_PROD_PASSWORD: "p",
      SN_PROFILE_PROD_ENV: "prod",
      SN_ACTIVE_PROFILE: "default",
      SN_ENV_FILE: path.join(tmpdir(), `h11-env-${process.pid}`),
    },
    async () => {
      const r = out(await call("servicenow_use_instance", { name: "prod" }));
      assert.equal(r.environment, "prod");
      assert.match(r.warning, /PRODUCTION/);
    },
  );
  rmSync(path.join(tmpdir(), `h11-env-${process.pid}`), { force: true });
});

// --- probes (L3-05) -----------------------------------------------------------------

test("probes: a strict allowlist makes the preflight report, not throw", async () => {
  await scenario({ SN_TABLES_ALLOW: "incident" }, async () => {
    const r = await checkCapabilities();
    const denied = r.probed.filter((t) => t.policyDenied);
    assert.ok(denied.length > 0, "policy-denied probes are reported");
    assert.ok(denied.every((t) => t.readable === false));
  });
});

test("env: doctor lists the active profile's marker", async () => {
  const { runDoctor, formatDoctorReport } =
    await import("../build/api/doctor.js");
  await scenario({ SN_ENV: "prod" }, async () => {
    const report = await runDoctor();
    assert.equal(report.config.env, "prod");
    assert.match(formatDoctorReport(report), /env:\s+prod/);
  });
  await scenario({ SN_ENV: undefined }, async () => {
    const report = await runDoctor();
    assert.equal(report.config.env, undefined);
  });
});
