// H-3 remainder: optimistic concurrency on update / delete (L2-05),
// unknown_fields from the schema cache (L2-06), the bounded email body
// preview (L4-06), and the plan-token binding ignoring `expected_*`.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ALL_TOOLS } from "../build/mcp/registry.js";
import { runSpec } from "../build/mcp/define.js";
import { planArgsHash } from "../build/mcp/plan-token.js";
import { BODY_PREVIEW_CHARS } from "../build/tools/email.js";
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
const mutating = (calls) =>
  calls.filter((c) => (c.init?.method ?? "GET") !== "GET");

/** A record whose sys_mod_count is whatever `state.mod` holds at read time. */
function instance(state) {
  return (url, init) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method !== "GET") {
      return jsonResponse(200, {
        result: { sys_id: REC, sys_mod_count: String(state.mod + 1) },
      });
    }
    if (u.pathname === "/api/now/table/sys_db_object") {
      return jsonResponse(200, {
        result: [{ name: "incident", super_class: "" }],
      });
    }
    if (u.pathname === "/api/now/table/sys_dictionary") {
      return jsonResponse(200, {
        result: ["short_description", "state", "caller_id"].map((element) => ({
          element,
          name: "incident",
          internal_type: "string",
        })),
      });
    }
    const fields = u.searchParams.get("sysparm_fields")?.split(",");
    const full = {
      sys_id: REC,
      short_description: "old",
      state: "1",
      sys_mod_count: String(state.mod),
    };
    const row = fields
      ? Object.fromEntries(
          fields.filter((f) => f in full).map((f) => [f, full[f]]),
        )
      : full;
    return jsonResponse(200, {
      result: u.pathname.endsWith(REC) ? row : [row],
    });
  };
}

async function scenario(env, fn) {
  const docs = mkdtempSync(path.join(tmpdir(), "h3r-"));
  const state = { mod: 3 };
  freshRuntime();
  try {
    return await withEnv({ SN_DOCS_DIR: docs, ...env }, () =>
      withFetch(instance(state), (calls) => fn(calls, state)),
    );
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
}

const upd = { table: "incident", sys_id: REC, fields: { state: "2" } };
const del = { table: "incident", sys_id: REC };

test("L2-05: the update plan hands back expected_mod_count; before still shows only the written fields", async () => {
  await scenario({}, async () => {
    const plan = out(await call("servicenow_update_record", upd));
    assert.deepEqual(plan.apply_with, { expected_mod_count: 3 });
    assert.deepEqual(plan.before, { state: "1" });
  });
});

test("L2-05: a changed record refuses update / delete with STALE_RECORD; unchanged or unchecked applies", async () => {
  for (const [name, args] of [
    ["servicenow_update_record", upd],
    ["servicenow_delete_record", del],
  ]) {
    await scenario({}, async (calls, state) => {
      const plan = out(await call(name, args));
      assert.equal(plan.apply_with.expected_mod_count, 3, name);
      state.mod = 4; // someone else wrote in between
      const stale = out(
        await call(name, { ...args, ...plan.apply_with, apply: true }),
      );
      assert.equal(stale.error.code, "STALE_RECORD", name);
      assert.equal(stale.error.status, 409);
      assert.match(stale.error.message, /3 → 4/);
      assert.equal(mutating(calls).length, 0, name);

      const fresh = out(await call(name, args));
      const ok = await call(name, {
        ...args,
        ...fresh.apply_with,
        apply: true,
      });
      assert.equal(ok.isError, undefined, ok.content[0].text);
      const unchecked = await call(name, { ...args, apply: true });
      assert.equal(unchecked.isError, undefined, unchecked.content[0].text);
      assert.equal(mutating(calls).length, 2, name);
    });
  }
});

test("L2-05 × H-3: expected_* do not break the plan-token binding", async () => {
  assert.equal(
    planArgsHash({
      ...upd,
      expected_mod_count: 3,
      expected_action: "update",
      expected_sys_id: REC,
    }),
    planArgsHash(upd),
  );
  await scenario({ SN_DESTRUCTIVE_CONFIRM: "token" }, async (calls) => {
    const plan = out(await call("servicenow_delete_record", del));
    const res = await call("servicenow_delete_record", {
      ...del,
      ...plan.apply_with,
      plan_token: plan.plan_token,
      apply: true,
    });
    assert.equal(res.isError, undefined, res.content[0].text);
    assert.equal(mutating(calls).length, 1);
  });
});

test("L2-06: unknown_fields comes from the schema cache only", async () => {
  await scenario({}, async (calls) => {
    const fields = {
      short_desription: "typo",
      state: "2",
      "caller_id.name": "x",
    };
    const cold = out(
      await call("servicenow_create_record", { table: "incident", fields }),
    );
    assert.equal(cold.unknown_fields, undefined, "no cached schema, no claim");
    assert.equal(calls.length, 0, "nothing read to find out");

    await call("servicenow_describe_table", { table: "incident" });
    const warm = out(
      await call("servicenow_create_record", { table: "incident", fields }),
    );
    assert.deepEqual(warm.unknown_fields, ["short_desription"]);
    const upd2 = out(
      await call("servicenow_update_record", {
        table: "incident",
        sys_id: REC,
        fields: { stat: "2" },
      }),
    );
    assert.deepEqual(upd2.unknown_fields, ["stat"]);
    const clean = out(
      await call("servicenow_create_record", {
        table: "incident",
        fields: { state: "2" },
      }),
    );
    assert.equal(clean.unknown_fields, undefined);
  });
});

test("L4-06: the email plan shows a short body in full and a long one as a 2 KB preview, with length and sha256", async () => {
  await scenario({ SN_EMAIL_ALLOWED_DOMAINS: "example.com" }, async (calls) => {
    const base = { to: ["a@example.com"], subject: "s" };
    const short = out(
      await call("servicenow_send_email", { ...base, body: "hi" }),
    );
    assert.equal(short.after.body, "hi");
    assert.equal(short.after.body_chars, 2);
    assert.equal(
      short.after.body_sha256,
      createHash("sha256").update("hi").digest("hex"),
    );
    const long = "x".repeat(BODY_PREVIEW_CHARS) + "TAIL";
    const plan = out(
      await call("servicenow_send_email", { ...base, body: long }),
    );
    assert.equal(plan.after.body, undefined);
    assert.equal(plan.after.body_preview.length, BODY_PREVIEW_CHARS);
    assert.equal(plan.after.body_truncated, true);
    assert.equal(plan.after.body_chars, long.length);
    assert.doesNotMatch(JSON.stringify(plan), /TAIL/);
    assert.equal(calls.length, 0);
  });
});
