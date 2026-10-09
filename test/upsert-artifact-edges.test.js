// P-23 / P-24 — servicenow_upsert_artifact refusals and edge paths that the
// scenario tests in upsert-artifact.test.js do not reach: key shapes, child
// resolution, the child read cap, ambiguous child keys, scope moves, the
// scope-prefix lookup and an apply whose parent comes back without a sys_id.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  applyArtifactPlan,
  planArtifactUpsert,
} from "../build/api/upsert-artifact.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();
process.env.SN_DESTRUCTIVE_CONFIRM = "off";

const SDK_OFF = { SN_SDK_MANAGED_SCOPES: undefined, SN_SDK_PROJECT_DIRS: "" };
const SYS = (c) => c.repeat(32);

/**
 * A read-mostly Table API over `seed` (table → rows). List queries match
 * `f=v` and `f!=v` terms; `totals` overrides X-Total-Count per table; a POST
 * answers with `postResult` (default: the body plus a fresh sys_id).
 */
function fakeInstance(seed = {}, { totals = {}, postResult } = {}) {
  let next = 0;
  return (url, init) => {
    const u = new URL(url);
    const m = /^\/api\/now\/table\/([^/]+)(?:\/([^/]+))?$/.exec(u.pathname);
    if (!m) return jsonResponse(404, { error: { message: "not found" } });
    const [, table, id] = m;
    const method = init?.method ?? "GET";
    if (method === "POST") {
      const body = JSON.parse(init.body);
      return jsonResponse(201, {
        result: postResult ?? { ...body, sys_id: SYS(String(++next)) },
      });
    }
    const rows = seed[table] ?? [];
    if (id) {
      const rec = rows.find((r) => r.sys_id === id);
      return rec
        ? jsonResponse(200, { result: rec })
        : jsonResponse(404, { error: { message: "No record" } });
    }
    const terms = (u.searchParams.get("sysparm_query") ?? "")
      .split("^")
      .filter((t) => t && !t.startsWith("ORDERBY"));
    const found = rows.filter((rec) =>
      terms.every((t) => {
        const ne = /^([\w.]+)!=(.*)$/.exec(t);
        if (ne) return String(rec[ne[1]] ?? "") !== ne[2];
        const eq = /^([\w.]+)=(.*)$/.exec(t);
        return eq ? String(rec[eq[1]] ?? "") === eq[2] : true;
      }),
    );
    return jsonResponse(
      200,
      { result: found },
      { "X-Total-Count": String(totals[table] ?? found.length) },
    );
  };
}

async function scenario(seed, fn, opts) {
  const docs = mkdtempSync(path.join(tmpdir(), "p23-edges-"));
  freshRuntime();
  try {
    return await withEnv({ SN_DOCS_DIR: docs, ...SDK_OFF }, () =>
      withFetch(fakeInstance(seed, opts), fn),
    );
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
}

/** Refusals raised before any request. */
async function refused(input, check) {
  await withFetch(
    () => assert.fail("no request expected"),
    async () => {
      await assert.rejects(planArtifactUpsert(input), (err) => {
        if (check instanceof RegExp) assert.match(err.message, check);
        else check(err);
        return true;
      });
    },
  );
}

test("a filtered (baseQuery) type is NOT_WRITABLE_TYPE without a hint", async () => {
  await refused(
    { artifactType: "dictionary_script", key: {}, fields: {} },
    (err) => {
      assert.equal(err.code, "NOT_WRITABLE_TYPE");
      assert.match(err.message, /filtered view of sys_dictionary/);
      assert.equal(err.hint, undefined);
    },
  );
});

test("several disallowed fields are listed together", async () => {
  await refused(
    {
      artifactType: "script_include",
      key: "x_util",
      fields: { bogus: 1, other: 2 },
    },
    (err) => {
      assert.equal(err.code, "FIELD_NOT_ALLOWED");
      assert.match(
        err.message,
        /Fields bogus, other on sys_script_include are/,
      );
    },
  );
});

test("parent key shapes: composite, sys_id, empty, incomplete, foreign, malformed sys_id", async () => {
  await refused(
    { artifactType: "user_preference", key: "x", fields: {} },
    /composite key \(name, user\); pass 'key' as an object/,
  );
  await refused(
    { artifactType: "business_rule", key: "not-a-sys-id", fields: {} },
    /keyed by sys_id; a plain key must be a 32-character sys_id/,
  );
  await refused(
    { artifactType: "user_preference", key: {}, fields: {} },
    /at least one field/,
  );
  await refused(
    { artifactType: "user_preference", key: { name: "x" }, fields: {} },
    /needs every key field: missing user/,
  );
  await refused(
    {
      artifactType: "user_preference",
      key: { name: "x", user: "u", bogus: "y" },
      fields: {},
    },
    (err) => {
      assert.equal(err.code, "FIELD_NOT_ALLOWED");
      assert.match(err.message, /bogus .* is not usable as a key/);
    },
  );
  await refused(
    { artifactType: "business_rule", key: { sys_id: "nope" }, fields: {} },
    /key\.sys_id must be a 32-character sys_id/,
  );
});

test("a field that contradicts the key is refused", async () => {
  await refused(
    {
      artifactType: "script_include",
      key: "x_util",
      fields: { api_name: "x_other" },
    },
    /fields\.api_name conflicts with key\.api_name/,
  );
});

test("child resolution: unnamed tables, value links, the parent chain", async () => {
  const base = { key: { name: "m" }, fields: {} };
  await refused(
    {
      artifactType: "script_include",
      key: "x_util",
      fields: {},
      children: [{ table: "sys_script", fields: {} }],
    },
    /sys_script is not a child of .*Children: \(none\)/,
  );
  await refused(
    {
      artifactType: "script_include",
      key: "x_util",
      fields: {},
      children: [{ fields: {} }],
    },
    /has no child tables; name the child's table/,
  );
  await refused(
    { artifactType: "state_model", ...base, children: [{ fields: {} }] },
    /has several child tables; name the child's table/,
  );
  await refused(
    {
      artifactType: "choice_set",
      key: { name: "incident", element: "state" },
      fields: {},
      children: [{ table: "sys_choice", fields: {} }],
    },
    /linked by value, not by a reference/,
  );
  await refused(
    {
      artifactType: "state_model",
      ...base,
      children: [{ table: "sttrm_transition_condition", fields: {} }],
    },
    (err) => {
      assert.equal(err.code, "CHILD_PARENT_INVALID");
      assert.match(
        err.message,
        /hangs off sttrm_state_transition; set 'parent'/,
      );
    },
  );
  await refused(
    {
      artifactType: "state_model",
      ...base,
      children: [
        { table: "sttrm_state", fields: { label: "New" } },
        { table: "sttrm_transition_condition", fields: {}, parent: 0 },
      ],
    },
    /hangs off sttrm_state_transition, not sttrm_state/,
  );
  await refused(
    {
      artifactType: "state_model",
      ...base,
      children: [{ table: "sttrm_state", fields: { label: "New" }, parent: 0 }],
    },
    (err) => {
      assert.equal(err.code, "CHILD_PARENT_INVALID");
      assert.equal(
        err.message,
        "children[0].parent must be the position of an earlier child.",
      );
    },
  );
});

test("child fields and keys: disallowed field, no key, empty key, malformed sys_id", async () => {
  const policy = (child) => ({
    artifactType: "ui_policy",
    key: { short_description: "p", table: "incident" },
    fields: {},
    children: [child],
  });
  await refused(
    policy({ fields: { bogus: "1" } }),
    /bogus on sys_ui_policy_action is not writable/,
  );
  await refused(
    policy({ fields: { visible: "true" } }),
    /needs a 'key' or a value for its name field 'field'\.$/,
  );
  await refused(
    {
      artifactType: "role",
      key: "x_app.user",
      fields: {},
      children: [{ fields: {} }],
    },
    /children\[0\] on sys_user_role_contains needs a 'key'\.$/,
  );
  await refused(policy({ key: {}, fields: {} }), (err) => {
    assert.equal(err.code, "FIELD_NOT_ALLOWED");
    assert.match(err.message, /is not usable as a key/);
  });
  await refused(
    policy({ key: { sys_id: "short" }, fields: {} }),
    /children\[0\]\.key\.sys_id must be a 32-character sys_id/,
  );
});

test("a numeric catalog variable name is PREFLIGHT_INVALID", async () => {
  await refused(
    {
      artifactType: "catalog_item",
      key: { name: "Laptop" },
      fields: {},
      children: [{ table: "item_option_new", fields: { name: 123 } }],
    },
    (err) => {
      assert.equal(err.code, "PREFLIGHT_INVALID");
      assert.match(err.message, /catalog variable name '123' is invalid/);
    },
  );
});

const ROLE = { sys_id: SYS("a"), name: "x_app.user", description: "d" };

test("more than CHILD_WRITE_LIMIT children is TOO_MANY_CHILDREN", async () => {
  await scenario(
    { sys_user_role: [ROLE], sys_user_role_contains: [] },
    async () => {
      await assert.rejects(
        planArtifactUpsert({
          artifactType: "role",
          key: "x_app.user",
          fields: {},
          children: [{ key: { contains: SYS("b") }, fields: {} }],
        }),
        (err) => {
          assert.equal(err.code, "TOO_MANY_CHILDREN");
          assert.equal(err.status, 409);
          return true;
        },
      );
    },
    { totals: { sys_user_role_contains: 500 } },
  );
});

test("a child key matching two records is AMBIGUOUS_KEY", async () => {
  const link = (c) => ({
    sys_id: SYS(c),
    role: ROLE.sys_id,
    contains: SYS("b"),
  });
  await scenario(
    { sys_user_role: [ROLE], sys_user_role_contains: [link("1"), link("2")] },
    async () => {
      await assert.rejects(
        planArtifactUpsert({
          artifactType: "role",
          key: "x_app.user",
          fields: {},
          children: [{ key: { contains: SYS("b") }, fields: {} }],
        }),
        (err) => {
          assert.equal(err.code, "AMBIGUOUS_KEY");
          assert.deepEqual(err.detail.matches, [SYS("1"), SYS("2")]);
          return true;
        },
      );
    },
  );
});

test("moving an existing record to another scope is refused", async () => {
  await scenario(
    {
      sys_script_include: [
        { sys_id: SYS("a"), api_name: "x_util", sys_scope: SYS("1") },
      ],
    },
    async () => {
      await assert.rejects(
        planArtifactUpsert({
          artifactType: "script_include",
          key: "x_util",
          fields: { sys_scope: SYS("2") },
        }),
        (err) => {
          assert.equal(err.code, "FIELD_NOT_ALLOWED");
          assert.match(err.message, /only writable on a create/);
          return true;
        },
      );
    },
  );
});

test("numeric values compare as stored text, so an equal order plans noop", async () => {
  await scenario(
    {
      sys_script: [
        { sys_id: SYS("a"), name: "BR", order: "100", active: "true" },
      ],
    },
    async () => {
      const plan = await planArtifactUpsert({
        artifactType: "business_rule",
        key: SYS("a"),
        fields: { order: 100, active: true },
      });
      assert.equal(plan.parent.action, "noop");
      assert.deepEqual(plan.parent.write, {});
    },
  );
});

test("a create in the global scope carries no scope-prefix warning", async () => {
  await scenario(
    { sys_scope: [{ sys_id: SYS("9"), scope: "global" }] },
    async () => {
      const plan = await planArtifactUpsert({
        artifactType: "sp_widget",
        key: "my-widget",
        fields: { name: "My widget", sys_scope: SYS("9") },
      });
      assert.equal(plan.parent.action, "create");
      assert.deepEqual(plan.warnings, []);
    },
  );
});

test("apply stops when the created parent comes back without a sys_id", async () => {
  await scenario(
    {},
    async (calls) => {
      const plan = await planArtifactUpsert({
        artifactType: "ui_policy",
        key: { short_description: "p", table: "incident" },
        fields: {},
        children: [{ fields: { field: "priority", visible: "false" } }],
      });
      assert.equal(plan.parent.action, "create");
      assert.equal(plan.children[0].action, "create");
      await assert.rejects(applyArtifactPlan(plan, undefined), (err) => {
        assert.equal(err.code, "UNEXPECTED_RESPONSE");
        assert.equal(err.status, 502);
        assert.match(
          err.message,
          /parent of children\[0\] came back without a sys_id/,
        );
        return true;
      });
      const posts = calls.filter((c) => c.init?.method === "POST");
      assert.equal(posts.length, 1, "only the parent was written");
    },
    { postResult: { short_description: "p" } },
  );
});
