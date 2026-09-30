// P-23 — servicenow_upsert_artifact: one plan over a primary record and its
// children (S-8 create/update/noop per record), applied in order through the
// journal so S-2 can revert every line; plan-only JSON fields (§5(c)), the
// H-11 table policy, the P-22 SDK guard and the H-3 plan token all hold for
// the parent and every child table.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ALL_TOOLS } from "../build/mcp/registry.js";
import { runSpec } from "../build/mcp/define.js";
import { readWriteJournal } from "../build/core/write-journal.js";
import {
  parentWriteFields,
  childWriteFields,
  writableArtifactType,
} from "../build/api/upsert-artifact.js";
import { getArtifactType } from "../build/core/artifacts/registry.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const call = (name, args) => {
  const spec = ALL_TOOLS.find((s) => s.name === name);
  assert.ok(spec, `missing tool ${name}`);
  return runSpec(spec, args);
};
const out = (res) => JSON.parse(res.content[0].text);
const mutating = (calls) =>
  calls.filter((c) => (c.init?.method ?? "GET") !== "GET");
const SDK_SCOPE_ID = "5".repeat(32);
const SDK_OFF = { SN_SDK_MANAGED_SCOPES: undefined, SN_SDK_PROJECT_DIRS: "" };

/**
 * A stateful Table API: record reads, list queries (`f=v^f2=v2`, `f!=v`,
 * `fINa,b`, `fISEMPTY`,
 * sysparm_fields, sysparm_limit), create / update (bumps sys_mod_count) and
 * delete. `sys_scope` rows serve the SDK guard's scope lookups.
 */
function instance(seed = {}) {
  const db = new Map();
  for (const [table, rows] of Object.entries(seed)) {
    db.set(table, new Map(rows.map((r) => [r.sys_id, { ...r }])));
  }
  const rows = (table) => {
    if (!db.has(table)) db.set(table, new Map());
    return db.get(table);
  };
  let next = 0;
  const project = (rec, fields) =>
    fields
      ? Object.fromEntries(
          fields.split(",").map((f) => [f, rec[f] === undefined ? "" : rec[f]]),
        )
      : { ...rec };
  const handler = (url, init) => {
    const u = new URL(url);
    const m = /^\/api\/now\/table\/([^/]+)(?:\/([^/]+))?$/.exec(u.pathname);
    if (!m) return jsonResponse(404, { error: { message: "not found" } });
    const [, table, id] = m;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : {};
    const store = rows(table);
    const fields = u.searchParams.get("sysparm_fields");
    if (method === "POST") {
      const sysId = body.sys_id ?? `${String(++next).padStart(32, "c")}`;
      const rec = { ...body, sys_id: sysId, sys_mod_count: "0" };
      store.set(sysId, rec);
      return jsonResponse(201, { result: rec });
    }
    if (method === "PATCH" || method === "PUT") {
      const rec = store.get(id);
      if (!rec) return jsonResponse(404, { error: { message: "No record" } });
      Object.assign(rec, body, {
        sys_mod_count: String(Number(rec.sys_mod_count ?? 0) + 1),
      });
      return jsonResponse(200, { result: rec });
    }
    if (method === "DELETE") {
      store.delete(id);
      return new Response(null, { status: 204 });
    }
    if (id) {
      const rec = store.get(id);
      if (!rec) return jsonResponse(404, { error: { message: "No record" } });
      return jsonResponse(200, { result: project(rec, fields) });
    }
    const query = u.searchParams.get("sysparm_query") ?? "";
    const terms = query.split("^").filter((t) => t && !t.startsWith("ORDERBY"));
    const match = (rec) =>
      terms.every((t) => {
        const empty = /^(\w+)ISEMPTY$/.exec(t);
        if (empty) return !rec[empty[1]];
        const ne = /^([\w.]+)!=(.*)$/.exec(t);
        if (ne) return String(rec[ne[1]] ?? "") !== ne[2];
        const inList = /^([\w.]+)IN(.*)$/.exec(t);
        if (inList)
          return inList[2].split(",").includes(String(rec[inList[1]] ?? ""));
        const eq = /^([\w.]+)=(.*)$/.exec(t);
        return eq ? String(rec[eq[1]] ?? "") === eq[2] : true;
      });
    const limit = Number(u.searchParams.get("sysparm_limit") ?? 10_000);
    const found = [...store.values()].filter(match);
    return jsonResponse(
      200,
      { result: found.slice(0, limit).map((r) => project(r, fields)) },
      { "X-Total-Count": String(found.length) },
    );
  };
  return { db, handler, rows };
}

async function scenario(env, seed, fn) {
  const docs = mkdtempSync(path.join(tmpdir(), "p23-"));
  freshRuntime();
  const inst = instance(seed);
  try {
    return await withEnv({ SN_DOCS_DIR: docs, ...SDK_OFF, ...env }, () =>
      withFetch(inst.handler, (calls) => fn(calls, inst)),
    );
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
}

/** Plan, then apply with the plan's apply_with (and token, when issued). */
async function planAndApply(args) {
  const plan = out(await call("servicenow_upsert_artifact", args));
  assert.equal(plan.mode, "plan", JSON.stringify(plan));
  const res = await call("servicenow_upsert_artifact", {
    ...args,
    ...plan.apply_with,
    ...(plan.plan_token ? { plan_token: plan.plan_token } : {}),
    apply: true,
  });
  return { plan, res, result: out(res) };
}

const POLICY_KEY = { short_description: "Lock priority", table: "incident" };
const policyArgs = (visible, mandatory) => ({
  artifactType: "ui_policy",
  key: POLICY_KEY,
  fields: { conditions: "active=true", on_load: "true" },
  children: [
    { fields: { field: "priority", visible, mandatory: "true" } },
    { fields: { field: "urgency", visible: "true", mandatory } },
  ],
});

test("descriptor allow-lists never include sys_* or the parent link", () => {
  const t = getArtifactType("ui_policy");
  const parent = parentWriteFields(t);
  assert.ok(parent.includes("conditions"));
  assert.ok(parent.includes("script_true"));
  assert.ok(parent.every((f) => !f.startsWith("sys_")));
  const child = childWriteFields(t.children[0]);
  assert.ok(child.includes("visible"));
  assert.ok(!child.includes("ui_policy"));
  assert.throws(() => writableArtifactType("flow"), /NOT_WRITABLE_TYPE|flow/);
});

test("acceptance: create -> update -> S-2 revert of a UI policy with two actions restores both actions", async () => {
  await scenario({}, {}, async (calls, inst) => {
    // 1. Create: the parent, then both actions linked to it.
    const created = await planAndApply(policyArgs("true", "false"));
    assert.equal(created.plan.parent_action, "create");
    assert.deepEqual(created.plan.count, { create: 3, update: 0, noop: 0 });
    assert.equal(created.res.isError, undefined, created.res.content[0].text);
    const policies = [...inst.rows("sys_ui_policy").values()];
    assert.equal(policies.length, 1);
    const policyId = policies[0].sys_id;
    const actions = () =>
      [...inst.rows("sys_ui_policy_action").values()].sort((a, b) =>
        a.field.localeCompare(b.field),
      );
    assert.equal(actions().length, 2);
    assert.ok(actions().every((a) => a.ui_policy === policyId));
    const createOrder = mutating(calls).map(
      (c) => new URL(c.url).pathname.split("/")[4],
    );
    assert.deepEqual(createOrder, [
      "sys_ui_policy",
      "sys_ui_policy_action",
      "sys_ui_policy_action",
    ]);

    // 2. Update: both actions (and the parent) change; one plan, one apply.
    const updated = await planAndApply({
      ...policyArgs("false", "true"),
      fields: { conditions: "active=false", on_load: "true" },
    });
    assert.equal(updated.plan.parent_action, "update");
    assert.deepEqual(updated.plan.count, { create: 0, update: 3, noop: 0 });
    assert.equal(updated.res.isError, undefined, updated.res.content[0].text);
    const [priority, urgency] = actions();
    assert.equal(priority.visible, "false");
    assert.equal(urgency.mandatory, "true");
    assert.equal(policies[0].conditions, "active=false");

    // Every line of the update is journaled with its `before` and one link.
    const journal = readWriteJournal().entries;
    const updates = journal.filter(
      (e) => e.tool === "servicenow_upsert_artifact" && e.action === "update",
    );
    assert.equal(updates.length, 3);
    assert.equal(new Set(updates.map((e) => e.artifact_write)).size, 1);
    assert.equal(updated.result.artifact_write, updates[0].artifact_write);
    const byRecord = (id) => updates.find((e) => e.sys_id === id);
    assert.deepEqual(byRecord(priority.sys_id).before, { visible: "true" });
    assert.deepEqual(byRecord(urgency.sys_id).before, { mandatory: "false" });

    // 3. Revert each line (the parent and both actions) through S-2.
    for (const entry of updates) {
      const r = await call("servicenow_revert_write", {
        entry_id: entry.id,
        apply: true,
      });
      assert.equal(r.isError, undefined, r.content[0].text);
    }
    const [p2, u2] = actions();
    assert.equal(p2.visible, "true");
    assert.equal(p2.mandatory, "true");
    assert.equal(u2.visible, "true");
    assert.equal(u2.mandatory, "false");
    assert.equal(policies[0].conditions, "active=true");
  });
});

test("an unchanged artefact plans noop everywhere and applies no write", async () => {
  await scenario({}, {}, async (calls) => {
    await planAndApply(policyArgs("true", "false"));
    const before = mutating(calls).length;
    const again = await planAndApply(policyArgs("true", "false"));
    assert.equal(again.plan.no_changes, true);
    assert.deepEqual(again.plan.count, { create: 0, update: 0, noop: 3 });
    assert.equal(again.res.isError, undefined, again.res.content[0].text);
    assert.equal(mutating(calls).length, before);
  });
});

test("a new child of an existing parent is a create linked to the parent; unnamed children are left alone", async () => {
  await scenario({}, {}, async (calls, inst) => {
    await planAndApply(policyArgs("true", "false"));
    const r = await planAndApply({
      ...policyArgs("true", "false"),
      children: [{ fields: { field: "impact", visible: "false" } }],
    });
    assert.deepEqual(r.plan.count, { create: 1, update: 0, noop: 1 });
    const actions = [...inst.rows("sys_ui_policy_action").values()];
    assert.equal(actions.length, 3);
    const parentId = [...inst.rows("sys_ui_policy").values()][0].sys_id;
    assert.equal(actions.find((a) => a.field === "impact").ui_policy, parentId);
  });
});

test("a sys_ux_macroponent.composition change returns a plan and refuses the apply", async () => {
  const MAC = "d".repeat(32);
  await scenario(
    {},
    {
      sys_ux_macroponent: [
        { sys_id: MAC, name: "Page", composition: "[]", sys_mod_count: "1" },
      ],
    },
    async (calls, inst) => {
      const args = {
        artifactType: "uib_macroponent",
        key: MAC,
        fields: { composition: '[{"id":"x"}]' },
      };
      const plan = out(await call("servicenow_upsert_artifact", args));
      assert.equal(plan.mode, "plan");
      assert.equal(plan.parent_action, "update");
      assert.equal(plan.would_refuse, true);
      assert.deepEqual(plan.plan_only.fields, [
        { table: "sys_ux_macroponent", field: "composition" },
      ]);
      const res = out(
        await call("servicenow_upsert_artifact", {
          ...args,
          ...plan.apply_with,
          apply: true,
        }),
      );
      assert.equal(res.error?.code, "PLAN_ONLY_FIELD", JSON.stringify(res));
      assert.equal(res.error.status, 409);
      assert.equal(mutating(calls).length, 0);
      assert.equal(inst.rows("sys_ux_macroponent").get(MAC).composition, "[]");
    },
  );
});

test("policy deny on a child table refuses the whole apply before any write", async () => {
  await scenario(
    { SN_TABLES_DENY: "sys_ui_policy_action" },
    {},
    async (calls) => {
      const plan = out(
        await call("servicenow_upsert_artifact", policyArgs("true", "false")),
      );
      assert.equal(plan.mode, "plan");
      assert.equal(plan.would_refuse, true);
      assert.equal(plan.policy_denied[0].table, "sys_ui_policy_action");
      const res = out(
        await call("servicenow_upsert_artifact", {
          ...policyArgs("true", "false"),
          ...plan.apply_with,
          apply: true,
        }),
      );
      assert.equal(res.error?.code, "POLICY_DENIED", JSON.stringify(res));
      assert.equal(mutating(calls).length, 0);
    },
  );
});

test("SDK guard deny: a create into an SDK-managed scope is refused with no mutating request", async () => {
  await scenario(
    { SN_SDK_MANAGED_SCOPES: "x_acme_sdk", SN_SDK_MANAGED_WRITES: "deny" },
    {
      sys_scope: [{ sys_id: SDK_SCOPE_ID, scope: "x_acme_sdk" }],
    },
    async (calls) => {
      const args = {
        ...policyArgs("true", "false"),
        fields: { conditions: "active=true", sys_scope: SDK_SCOPE_ID },
      };
      const plan = out(await call("servicenow_upsert_artifact", args));
      assert.equal(plan.mode, "plan");
      assert.equal(plan.would_refuse, true, JSON.stringify(plan));
      assert.equal(plan.sdkManaged[0].table, "sys_ui_policy");
      assert.equal(plan.sdkManaged[0].scope, "x_acme_sdk");
      const res = out(
        await call("servicenow_upsert_artifact", {
          ...args,
          ...plan.apply_with,
          apply: true,
        }),
      );
      assert.equal(res.error?.code, "SDK_MANAGED_SCOPE", JSON.stringify(res));
      assert.equal(mutating(calls).length, 0);
    },
  );
});

test("plan token: the token binds the whole plan; changed children are PLAN_REQUIRED", async () => {
  await scenario({ SN_DESTRUCTIVE_CONFIRM: "token" }, {}, async (calls) => {
    const args = policyArgs("true", "false");
    const plan = out(await call("servicenow_upsert_artifact", args));
    assert.match(plan.plan_token, /^pt[a-z]{28}$/);
    const changed = {
      ...args,
      children: [{ fields: { field: "priority", visible: "false" } }],
      ...plan.apply_with,
      plan_token: plan.plan_token,
      apply: true,
    };
    const res = out(await call("servicenow_upsert_artifact", changed));
    assert.equal(res.error?.code, "PLAN_REQUIRED", JSON.stringify(res));
    assert.equal(mutating(calls).length, 0);
    // The matching token applies.
    const good = await call("servicenow_upsert_artifact", {
      ...args,
      ...plan.apply_with,
      plan_token: plan.plan_token,
      apply: true,
    });
    assert.equal(good.isError, undefined, good.content[0].text);
    assert.equal(mutating(calls).length, 3);
    const lines = readWriteJournal().entries.filter(
      (e) => e.tool === "servicenow_upsert_artifact",
    );
    assert.ok(lines.every((e) => e.plan_token === plan.plan_token));
  });
});

test("the plan is stale-checked: a parent created since the plan is refused", async () => {
  await scenario({}, {}, async (calls, inst) => {
    const args = policyArgs("true", "false");
    const plan = out(await call("servicenow_upsert_artifact", args));
    assert.equal(plan.apply_with.expected_action, "create");
    inst.rows("sys_ui_policy").set("e".repeat(32), {
      sys_id: "e".repeat(32),
      ...POLICY_KEY,
      sys_mod_count: "0",
    });
    const res = out(
      await call("servicenow_upsert_artifact", {
        ...args,
        ...plan.apply_with,
        apply: true,
      }),
    );
    assert.ok(res.error, JSON.stringify(res));
    assert.equal(mutating(calls).length, 0);
  });
});

test("refusals: flow fields other than active, sys_* and parent-link fields, duplicate child keys", async () => {
  await scenario({}, {}, async (calls) => {
    const flow = out(
      await call("servicenow_upsert_artifact", {
        artifactType: "flow",
        key: { name: "X" },
        fields: { description: "x" },
      }),
    );
    assert.equal(flow.error?.code, "FLOW_ACTIVE_ONLY", JSON.stringify(flow));

    const sys = out(
      await call("servicenow_upsert_artifact", {
        ...policyArgs("true", "false"),
        fields: { sys_created_by: "x" },
      }),
    );
    assert.equal(sys.error?.code, "FIELD_NOT_ALLOWED", JSON.stringify(sys));

    const link = out(
      await call("servicenow_upsert_artifact", {
        ...policyArgs("true", "false"),
        children: [{ fields: { field: "a", ui_policy: "f".repeat(32) } }],
      }),
    );
    assert.equal(link.error?.code, "FIELD_NOT_ALLOWED", JSON.stringify(link));

    const dup = out(
      await call("servicenow_upsert_artifact", {
        ...policyArgs("true", "false"),
        children: [
          { fields: { field: "a", visible: "true" } },
          { fields: { field: "a", visible: "false" } },
        ],
      }),
    );
    assert.equal(dup.error?.code, "DUPLICATE_CHILD_KEY", JSON.stringify(dup));
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// P-24 — portal (SP-1 … SP-10) and catalog (CAT-1 … CAT-6) writes with the
// SDK pre-flight checks; P-25 — a flow's `active` flag only (unverified, O-5).
// ---------------------------------------------------------------------------

const PAGE = "a".repeat(31) + "1";
const CONT = "a".repeat(31) + "2";
const ROW = "a".repeat(31) + "3";
const COL = "a".repeat(31) + "4";
const INST = "a".repeat(31) + "5";
const WIDGET = "b".repeat(32);
const MINE = "6".repeat(32);
const OTHER = "7".repeat(32);

const layoutSeed = () => ({
  sp_widget: [
    { sys_id: WIDGET, id: "x_acme_hello", name: "Hello", sys_mod_count: "0" },
  ],
  sp_page: [
    {
      sys_id: PAGE,
      id: "x_acme_home",
      title: "Home",
      public: "true",
      sys_mod_count: "0",
    },
  ],
  sp_container: [
    {
      sys_id: CONT,
      sp_page: PAGE,
      order: "1",
      name: "main",
      width: "container",
      sys_mod_count: "0",
    },
  ],
  sp_row: [
    {
      sys_id: ROW,
      sp_container: CONT,
      order: "1",
      class_name: "row-a",
      sys_mod_count: "0",
    },
  ],
  sp_column: [
    { sys_id: COL, sp_row: ROW, order: "1", size: "12", sys_mod_count: "0" },
  ],
  sp_instance: [
    {
      sys_id: INST,
      sp_column: COL,
      order: "1",
      sp_widget: WIDGET,
      title: "Hello",
      widget_parameters: '{"greeting":"hi"}',
      sys_mod_count: "0",
    },
  ],
});

/** Turn a servicenow_get_artifact result into upsert args keyed by sys_id. */
function upsertFromGet(got) {
  const t = getArtifactType(got.artifactType);
  const pick = (rec, allowed, skip = []) =>
    Object.fromEntries(
      Object.entries(rec).filter(
        ([f]) => allowed.includes(f) && !skip.includes(f),
      ),
    );
  const flat = [];
  for (const entry of got.children) {
    const c = t.children.find(
      (d) =>
        d.table === entry.table &&
        (d.parentTable ?? t.table) === (entry.parentTable ?? t.table),
    );
    for (const rec of entry.records) flat.push({ c, rec });
  }
  const children = flat.map(({ c, rec }) => {
    const owner = rec[c.parentField];
    const parent = flat.findIndex((o) => o.rec.sys_id === owner);
    return {
      table: c.table,
      key: { sys_id: rec.sys_id },
      fields: pick(rec, childWriteFields(c)),
      ...(parent >= 0 ? { parent } : {}),
    };
  });
  return {
    artifactType: got.artifactType,
    key: got.key,
    fields: pick(got.record, parentWriteFields(t), t.keyFields),
    children,
  };
}

test("P-24 acceptance: a page layout round-trips get -> upsert -> get unchanged", async () => {
  const get = async () =>
    out(
      await call("servicenow_get_artifact", {
        artifactType: "sp_page",
        key: "x_acme_home",
      }),
    );
  let first;
  let args;
  await scenario({}, layoutSeed(), async (calls) => {
    first = await get();
    assert.deepEqual(
      first.children.map((c) => [c.table, c.count]),
      [
        ["sp_container", 1],
        ["sp_row", 1],
        ["sp_column", 1],
        ["sp_instance", 1],
      ],
    );
    args = upsertFromGet(first);
    assert.deepEqual(
      args.children.map((c) => c.parent),
      [undefined, 0, 1, 2],
    );
    const r = await planAndApply(args);
    assert.equal(r.plan.no_changes, true, JSON.stringify(r.plan));
    assert.deepEqual(r.plan.count, { create: 0, update: 0, noop: 5 });
    assert.equal(r.res.isError, undefined, r.res.content[0].text);
    assert.equal(mutating(calls).length, 0);
    assert.deepEqual(await get(), first);
  });

  // The same args rebuild the tree on an empty instance, linked level by
  // level, with the same child sys_ids.
  await scenario(
    {},
    { sp_widget: layoutSeed().sp_widget },
    async (calls, inst) => {
      const made = await planAndApply(args);
      assert.equal(made.plan.parent_action, "create");
      assert.deepEqual(made.plan.count, { create: 5, update: 0, noop: 0 });
      assert.equal(made.res.isError, undefined, made.res.content[0].text);
      assert.deepEqual(
        mutating(calls).map((c) => new URL(c.url).pathname.split("/")[4]),
        ["sp_page", "sp_container", "sp_row", "sp_column", "sp_instance"],
      );
      const pageId = [...inst.rows("sp_page").values()][0].sys_id;
      assert.equal(inst.rows("sp_container").get(CONT).sp_page, pageId);
      assert.equal(inst.rows("sp_row").get(ROW).sp_container, CONT);
      assert.equal(inst.rows("sp_column").get(COL).sp_row, ROW);
      assert.equal(inst.rows("sp_instance").get(INST).sp_column, COL);
      const again = await get();
      const norm = (g) =>
        JSON.parse(JSON.stringify(g).replaceAll(g.sys_id, "PAGE"));
      assert.deepEqual(norm(again), norm(first));
    },
  );
});

test("P-24: a nested layout update is journaled per record and reverts through S-2", async () => {
  await scenario({}, layoutSeed(), async (calls, inst) => {
    const r = await planAndApply({
      artifactType: "sp_page",
      key: "x_acme_home",
      fields: {},
      children: [
        { table: "sp_container", key: { sys_id: CONT }, fields: {} },
        { table: "sp_row", parent: 0, key: { sys_id: ROW }, fields: {} },
        {
          table: "sp_column",
          parent: 1,
          key: { sys_id: COL },
          fields: { size: "6" },
        },
        {
          table: "sp_instance",
          parent: 2,
          key: { sys_id: INST },
          fields: { title: "Hi there" },
        },
        {
          table: "sp_instance",
          parent: 2,
          fields: { order: "2", sp_widget: WIDGET, title: "Second" },
        },
      ],
    });
    assert.equal(r.res.isError, undefined, r.res.content[0].text);
    assert.deepEqual(r.plan.count, { create: 1, update: 2, noop: 3 });
    const created = [...inst.rows("sp_instance").values()].find(
      (i) => i.title === "Second",
    );
    assert.equal(created.sp_column, COL);
    const lines = readWriteJournal().entries.filter(
      (e) => e.tool === "servicenow_upsert_artifact",
    );
    assert.equal(lines.length, 3);
    assert.equal(new Set(lines.map((e) => e.artifact_write)).size, 1);
    for (const e of lines.filter((l) => l.action === "update")) {
      const res = await call("servicenow_revert_write", {
        entry_id: e.id,
        apply: true,
      });
      assert.equal(res.isError, undefined, res.content[0].text);
    }
    assert.equal(inst.rows("sp_column").get(COL).size, "12");
    assert.equal(inst.rows("sp_instance").get(INST).title, "Hello");
  });
});

test("P-24: nested children must name an earlier child of the right table", async () => {
  await scenario({}, layoutSeed(), async (calls) => {
    const run = async (children) =>
      out(
        await call("servicenow_upsert_artifact", {
          artifactType: "sp_page",
          key: "x_acme_home",
          fields: {},
          children,
        }),
      );
    const noParent = await run([{ table: "sp_row", fields: { order: "1" } }]);
    assert.equal(noParent.error?.code, "CHILD_PARENT_INVALID");
    const later = await run([
      { table: "sp_container", parent: 1, fields: { order: "1" } },
      { table: "sp_container", fields: { order: "2" } },
    ]);
    assert.equal(later.error?.code, "CHILD_PARENT_INVALID");
    const wrong = await run([
      { table: "sp_container", fields: { order: "1" } },
      { table: "sp_column", parent: 0, fields: { order: "1" } },
    ]);
    assert.equal(wrong.error?.code, "CHILD_PARENT_INVALID");
    assert.match(wrong.error.message, /sp_row/);
    const badId = await run([
      { table: "sp_container", key: { sys_id: "nope" }, fields: {} },
    ]);
    assert.ok(badId.error, JSON.stringify(badId));
    assert.equal(mutating(calls).length, 0);
  });
});

test("P-24 acceptance: a duplicate sp_widget.id is rejected at plan time", async () => {
  await scenario(
    {},
    {
      sys_scope: [
        { sys_id: MINE, scope: "x_acme" },
        { sys_id: OTHER, scope: "x_other" },
      ],
      sp_widget: [
        {
          sys_id: WIDGET,
          id: "x_acme_hello",
          name: "Hello",
          sys_scope: OTHER,
          sys_mod_count: "0",
        },
      ],
      sp_ng_template: [
        {
          sys_id: "e".repeat(32),
          id: "x_acme_tpl",
          sp_widget: WIDGET,
          sys_mod_count: "0",
        },
      ],
    },
    async (calls) => {
      // Same id, another application scope.
      const scoped = out(
        await call("servicenow_upsert_artifact", {
          artifactType: "sp_widget",
          key: "x_acme_hello",
          fields: { name: "Mine", sys_scope: MINE },
        }),
      );
      assert.equal(scoped.error?.code, "DUPLICATE_UNIQUE_FIELD");
      assert.equal(scoped.error.status, 409);

      // A header / footer extends sp_widget: its id collides with a widget's.
      const hf = out(
        await call("servicenow_upsert_artifact", {
          artifactType: "sp_header_footer",
          key: "x_acme_hello",
          fields: { name: "Header" },
        }),
      );
      assert.equal(
        hf.error?.code,
        "DUPLICATE_UNIQUE_FIELD",
        JSON.stringify(hf),
      );
      assert.match(hf.error.message, /sp_widget id='x_acme_hello'/);

      // A new widget's template id is owned by another widget.
      const tpl = out(
        await call("servicenow_upsert_artifact", {
          artifactType: "sp_widget",
          key: "x_acme_new",
          fields: { name: "New" },
          children: [{ table: "sp_ng_template", fields: { id: "x_acme_tpl" } }],
        }),
      );
      assert.equal(tpl.error?.code, "DUPLICATE_UNIQUE_FIELD");
      assert.match(tpl.error.message, /children\[0\]/);

      // Two records of one plan claiming the same id.
      const twice = out(
        await call("servicenow_upsert_artifact", {
          artifactType: "sp_widget",
          key: "x_acme_tpl2",
          fields: { name: "Twice" },
          children: [
            {
              table: "sp_ng_template",
              key: { id: "x_acme_t" },
              fields: { template: "a" },
            },
            {
              table: "sp_ng_template",
              key: { id: "x_acme_t", template: "b" },
              fields: {},
            },
          ],
        }),
      );
      assert.equal(twice.error?.code, "DUPLICATE_UNIQUE_FIELD");
      assert.match(twice.error.message, /claimed by both/);
      assert.equal(mutating(calls).length, 0);
    },
  );
});

test("P-24: a widget create in a scope warns when the id lacks the scope prefix", async () => {
  await scenario(
    {},
    { sys_scope: [{ sys_id: MINE, scope: "x_acme" }] },
    async (calls, inst) => {
      const r = await planAndApply({
        artifactType: "sp_widget",
        key: "hello",
        fields: { name: "Hello", sys_scope: MINE, template: "<div></div>" },
      });
      assert.deepEqual(
        r.plan.warnings.map((w) => [w.code, w.field]),
        [["SCOPE_PREFIX", "id"]],
      );
      assert.equal(r.res.isError, undefined, r.res.content[0].text);
      assert.equal(r.result.warnings[0].code, "SCOPE_PREFIX");
      assert.equal([...inst.rows("sp_widget").values()].length, 1);

      const good = out(
        await call("servicenow_upsert_artifact", {
          artifactType: "sp_widget",
          key: "x_acme_ok",
          fields: { name: "Ok", sys_scope: MINE },
        }),
      );
      assert.equal(good.mode, "plan");
      assert.equal(good.warnings, undefined);
    },
  );
});

test("P-24: a catalog item with a variable, its choice, a UI policy with an action and a category", async () => {
  await scenario({}, {}, async (calls, inst) => {
    const CATEGORY = "9".repeat(32);
    const r = await planAndApply({
      artifactType: "catalog_item",
      key: { name: "Laptop" },
      fields: { short_description: "Request a laptop" },
      children: [
        {
          table: "item_option_new",
          fields: {
            name: "model",
            question_text: "Model",
            type: "5",
            order: "100",
          },
        },
        {
          table: "question_choice",
          parent: 0,
          fields: { text: "Pro", value: "pro", order: "1" },
        },
        {
          table: "catalog_ui_policy",
          fields: { short_description: "Show model", on_load: "true" },
        },
        {
          table: "catalog_ui_policy_action",
          parent: 2,
          fields: { catalog_variable: "model", visible: "true" },
        },
        { table: "sc_cat_item_category", fields: { sc_category: CATEGORY } },
      ],
    });
    assert.equal(r.res.isError, undefined, r.res.content[0].text);
    assert.deepEqual(r.plan.count, { create: 6, update: 0, noop: 0 });
    const one = (table) => [...inst.rows(table).values()][0];
    const item = one("sc_cat_item");
    assert.equal(one("item_option_new").cat_item, item.sys_id);
    assert.equal(
      one("question_choice").question,
      one("item_option_new").sys_id,
    );
    assert.equal(one("catalog_ui_policy").catalog_item, item.sys_id);
    assert.equal(
      one("catalog_ui_policy_action").ui_policy,
      one("catalog_ui_policy").sys_id,
    );
    assert.equal(one("sc_cat_item_category").sc_cat_item, item.sys_id);

    // A second run is noop throughout, the nested choice included.
    const again = out(
      await call("servicenow_upsert_artifact", {
        artifactType: "catalog_item",
        key: { name: "Laptop" },
        fields: { short_description: "Request a laptop" },
        children: [
          { table: "item_option_new", fields: { name: "model", type: "5" } },
          { table: "question_choice", parent: 0, fields: { text: "Pro" } },
        ],
      }),
    );
    assert.deepEqual(again.count, { create: 0, update: 0, noop: 3 });
  });
});

test("P-24: an invalid catalog variable name is PREFLIGHT_INVALID before any request", async () => {
  await scenario({}, {}, async (calls) => {
    for (const args of [
      {
        artifactType: "catalog_item",
        key: { name: "Laptop" },
        fields: {},
        children: [{ table: "item_option_new", fields: { name: "1model" } }],
      },
      {
        artifactType: "catalog_variable",
        key: { name: "has space" },
        fields: {},
      },
    ]) {
      const res = out(await call("servicenow_upsert_artifact", args));
      assert.equal(res.error?.code, "PREFLIGHT_INVALID", JSON.stringify(res));
    }
    assert.equal(calls.length, 0);
  });
});

const FLOW = "f".repeat(32);
const flowSeed = () => ({
  sys_hub_flow: [
    {
      sys_id: FLOW,
      internal_name: "x_acme_onboard",
      name: "Onboard",
      active: "false",
      master_snapshot: "d".repeat(32),
      sys_mod_count: "3",
    },
  ],
});

test("P-25: a flow's active flag toggles through plan -> apply, flagged unverified (O-5)", async () => {
  await scenario({}, flowSeed(), async (calls, inst) => {
    const r = await planAndApply({
      artifactType: "flow",
      key: "x_acme_onboard",
      fields: { active: "true" },
    });
    assert.equal(r.plan.parent_action, "update");
    assert.equal(r.plan.warnings[0].code, "UNVERIFIED");
    assert.match(r.plan.warnings[0].message, /master_snapshot/);
    assert.equal(r.res.isError, undefined, r.res.content[0].text);
    const writes = mutating(calls);
    assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(writes[0].init.body), { active: "true" });
    const flow = inst.rows("sys_hub_flow").get(FLOW);
    assert.equal(flow.active, "true");
    assert.equal(flow.master_snapshot, "d".repeat(32));
    const [line] = readWriteJournal().entries.filter(
      (e) => e.tool === "servicenow_upsert_artifact",
    );
    const back = await call("servicenow_revert_write", {
      entry_id: line.id,
      apply: true,
    });
    assert.equal(back.isError, undefined, back.content[0].text);
    assert.equal(flow.active, "false");
  });
});

test("P-25: anything but {active} on an existing flow is FLOW_ACTIVE_ONLY", async () => {
  await scenario({}, flowSeed(), async (calls) => {
    const refused = [
      { fields: { name: "Renamed" } },
      { fields: { active: "true", description: "x" } },
      { fields: {} },
      { fields: { active: "maybe" } },
      {
        fields: { active: "true" },
        children: [{ table: "sys_hub_action_instance", fields: {} }],
      },
      { key: "x_acme_missing", fields: { active: "true" } },
    ];
    for (const extra of refused) {
      const res = out(
        await call("servicenow_upsert_artifact", {
          artifactType: "flow",
          key: "x_acme_onboard",
          ...extra,
        }),
      );
      assert.equal(res.error?.code, "FLOW_ACTIVE_ONLY", JSON.stringify(extra));
    }
    assert.equal(mutating(calls).length, 0);
  });
});
