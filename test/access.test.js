// N-24 (O-17 option B, ADR 0011) — the `access` package: grant or revoke one
// role for one user. Privileged and inherited roles are always refused; the
// plan shows the effective roles before and after and binds them into the
// plan_token.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ALL_TOOLS } from "../build/mcp/registry.js";
import { runSpec } from "../build/mcp/define.js";
import { ALL_PACKAGES } from "../build/mcp/package-policy.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const TOOL = "servicenow_change_access";
const spec = ALL_TOOLS.find((s) => s.name === TOOL);
const out = (res) => JSON.parse(res.content[0].text);
const call = (args) => runSpec(spec, args);

const USER = "u".repeat(32);
const ME = "m".repeat(32);

/** role name → { sys_id, elevated } */
const ROLES = {
  itil: { sys_id: "r_itil", elevated: "false" },
  approver_user: { sys_id: "r_appr", elevated: "false" },
  catalog_admin: { sys_id: "r_cat", elevated: "false" },
  admin: { sys_id: "r_admin", elevated: "false" },
  maint: { sys_id: "r_maint", elevated: "false" },
  security_admin: { sys_id: "r_sec", elevated: "true" },
  wrapper: { sys_id: "r_wrap", elevated: "false" },
  outer: { sys_id: "r_outer", elevated: "false" },
};
const nameOf = (id) => Object.keys(ROLES).find((n) => ROLES[n].sys_id === id);

/** role sys_id → contained role names */
const CONTAINS = {
  r_itil: ["approver_user"],
  r_wrap: ["catalog_admin", "outer"],
  r_outer: ["security_admin"],
};

const row = (sys_id, role, extra = {}) => ({
  sys_id,
  role: ROLES[role].sys_id,
  "role.name": role,
  inherited: "false",
  granted_by: "",
  included_in_role: "",
  ...extra,
});

function instance(rows) {
  const state = { rows };
  return {
    state,
    handler: (url, init) => {
      const u = new URL(url);
      const method = init?.method ?? "GET";
      const q = u.searchParams.get("sysparm_query") ?? "";
      if (method === "POST" && u.pathname.endsWith("/sys_user_has_role")) {
        return jsonResponse(201, {
          result: { sys_id: "newrow", sys_mod_count: "0" },
        });
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (u.pathname.endsWith("/sys_user_role")) {
        const name = q.replace(/^name=/, "");
        const r = ROLES[name];
        return jsonResponse(200, {
          result: r
            ? [{ sys_id: r.sys_id, name, elevated_privilege: r.elevated }]
            : [],
        });
      }
      if (u.pathname.endsWith("/sys_user_role_contains")) {
        const ids = q.replace(/^roleIN/, "").split(/[,^]/);
        const result = [];
        for (const id of ids) {
          for (const n of CONTAINS[id] ?? []) {
            result.push({
              contains: ROLES[n].sys_id,
              "contains.name": n,
              "contains.elevated_privilege": ROLES[n].elevated,
            });
          }
        }
        return jsonResponse(200, { result });
      }
      if (u.pathname.includes("/sys_user/")) {
        const id = u.pathname.split("/").pop();
        return jsonResponse(200, {
          result: { sys_id: id, user_name: id === ME ? "mcp.bot" : "abel" },
        });
      }
      if (u.pathname.endsWith("/sys_user_has_role")) {
        return jsonResponse(200, { result: state.rows });
      }
      throw new Error(`unexpected ${method} ${url}`);
    },
  };
}

const writes = (calls) =>
  calls.filter((c) => ["POST", "DELETE"].includes(c.init?.method));

async function scenario(env, rows, fn) {
  const docs = mkdtempSync(path.join(tmpdir(), "n24-"));
  freshRuntime();
  const inst = instance(rows);
  try {
    return await withEnv(
      {
        SN_DOCS_DIR: docs,
        SN_DESTRUCTIVE_CONFIRM: "token",
        SN_PROTECTED_TABLES_WRITE: "allow",
        ...env,
      },
      () => withFetch(inst.handler, (calls) => fn(calls, inst.state)),
    );
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
}

const planThenApply = async (args) => {
  const plan = out(await call(args));
  return {
    plan,
    res: await call({ ...args, apply: true, plan_token: plan.plan_token }),
  };
};

test("access is a package of its own, off by default, with one destructive tool", () => {
  assert.ok(ALL_PACKAGES.includes("access"));
  assert.equal(spec.package, "access");
  assert.equal(spec.annotations.destructiveHint, true);
  assert.equal(nameOf("r_itil"), "itil");
});

test("grant: the plan shows effective roles before and after, then grants once", async () => {
  await scenario({}, [row("x1", "catalog_admin")], async (calls) => {
    const { plan, res } = await planThenApply({
      user: USER,
      role: "itil",
      action: "grant",
    });
    assert.equal(plan.mode, "plan");
    assert.match(plan.plan_token, /^pt[a-z]{28}$/);
    assert.deepEqual(plan.effective.before, ["catalog_admin"]);
    assert.deepEqual(plan.effective.after, [
      "approver_user",
      "catalog_admin",
      "itil",
    ]);
    assert.deepEqual(plan.effective.added, ["approver_user", "itil"]);
    assert.equal(res.isError, undefined, res.content[0].text);
    const [post, ...rest] = writes(calls);
    assert.equal(rest.length, 0);
    assert.deepEqual(JSON.parse(post.init.body), {
      user: USER,
      role: "r_itil",
    });
  });
});

test("an apply without the plan_token returns the plan instead (B4 self-healing)", async () => {
  await scenario({}, [], async (calls) => {
    const res = out(
      await call({ user: USER, role: "itil", action: "grant", apply: true }),
    );
    assert.equal(res.mode, "plan");
    assert.match(res.apply_skipped, /plan_token/);
    assert.match(res.plan_token, /^pt[a-z]{28}$/);
    assert.equal(writes(calls).length, 0);
  });
});

for (const role of ["admin", "maint", "security_admin", "wrapper"]) {
  test(`privileged role "${role}" is refused for grant and revoke`, async () => {
    await scenario(
      { SN_DESTRUCTIVE_CONFIRM: "off" },
      [row("x1", role)],
      async (calls) => {
        for (const action of ["grant", "revoke"]) {
          for (const apply of [false, true]) {
            const res = await call({ user: USER, role, action, apply });
            assert.equal(res.isError, true, `${action} ${apply}`);
            assert.equal(out(res).code, "POLICY_DENIED");
          }
        }
        assert.equal(writes(calls).length, 0);
      },
    );
  });
}

test("revoking admin from the calling account is refused", async () => {
  await scenario(
    { SN_DESTRUCTIVE_CONFIRM: "off" },
    [row("x1", "admin")],
    async (calls) => {
      const res = await call({
        user: ME,
        role: "admin",
        action: "revoke",
        apply: true,
      });
      assert.equal(out(res).code, "POLICY_DENIED");
      assert.equal(writes(calls).length, 0);
    },
  );
});

test("revoke: deletes the direct row; the plan drops the roles it brought in", async () => {
  await scenario(
    {},
    [
      row("d1", "itil"),
      row("c1", "approver_user", { inherited: "true", included_in_role: "d1" }),
      row("x1", "catalog_admin"),
    ],
    async (calls) => {
      const { plan, res } = await planThenApply({
        user: USER,
        role: "itil",
        action: "revoke",
      });
      assert.equal(plan.sys_id, "d1");
      assert.deepEqual(plan.effective.removed, ["approver_user", "itil"]);
      assert.deepEqual(plan.effective.after, ["catalog_admin"]);
      assert.equal(res.isError, undefined, res.content[0].text);
      const [del, ...rest] = writes(calls);
      assert.equal(rest.length, 0);
      assert.match(del.url, /\/sys_user_has_role\/d1$/);
    },
  );
});

test("revoke: a role held only through a group or a role is refused as inherited", async () => {
  await scenario(
    { SN_DESTRUCTIVE_CONFIRM: "off" },
    [
      row("g1", "itil", { inherited: "true", granted_by: "grp1" }),
      row("c1", "approver_user", { inherited: "true", included_in_role: "g1" }),
    ],
    async (calls) => {
      for (const role of ["itil", "approver_user"]) {
        const res = await call({
          user: USER,
          role,
          action: "revoke",
          apply: true,
        });
        assert.equal(out(res).code, "POLICY_DENIED", role);
        assert.match(out(res).error ?? res.content[0].text, /inherited/i);
      }
      assert.equal(writes(calls).length, 0);
    },
  );
});

test("grant of a role held directly is a conflict; an unknown role is not found", async () => {
  await scenario({}, [row("d1", "itil")], async () => {
    const dup = await call({ user: USER, role: "itil", action: "grant" });
    assert.equal(out(dup).code, "CONFLICT");
    const none = await call({ user: USER, role: "nope", action: "grant" });
    assert.equal(out(none).code, "NOT_FOUND");
  });
});

test("roles that changed after the plan are refused as stale", async () => {
  await scenario({}, [], async (calls, state) => {
    const args = { user: USER, role: "itil", action: "grant" };
    const plan = out(await call(args));
    state.rows.push(row("x9", "catalog_admin"));
    const res = await call({
      ...args,
      apply: true,
      plan_token: plan.plan_token,
    });
    assert.equal(out(res).code, "STALE_RECORD");
    assert.equal(writes(calls).length, 0);
  });
});

test("the protected-table default and read-only mode refuse before any read", async () => {
  for (const env of [
    { SN_PROTECTED_TABLES_WRITE: "deny", SN_DESTRUCTIVE_CONFIRM: "off" },
    { SN_READONLY: "true", SN_DESTRUCTIVE_CONFIRM: "off" },
  ]) {
    await scenario(env, [], async (calls) => {
      const res = await call({
        user: USER,
        role: "itil",
        action: "grant",
        apply: true,
      });
      assert.equal(res.isError, true);
      assert.equal(calls.length, 0);
    });
  }
});
