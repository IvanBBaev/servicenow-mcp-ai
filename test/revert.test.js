// S-2 — journal-based revert: servicenow_revert_write inverts create/update/
// delete journal lines against a stateful Table API mock (plan preview vs
// apply, sys_mod_count / field drift with force, NOT_REVERTIBLE reasons, the
// revert's own `reverts` line, redo) and servicenow_list_writes filters.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendWriteJournal,
  readWriteJournal,
  resultModCount,
} from "../build/core/write-journal.js";
import { buildRevertSpec, listWrites } from "../build/api/revert.js";
import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS, PACKAGES } from "../build/mcp/registry.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

const tool = (name) => {
  const spec = ALL_TOOLS.find((s) => s.name === name);
  assert.ok(spec, `missing tool ${name}`);
  return spec;
};
const call = (name, args) => runSpec(tool(name), args);
const out = (res) => JSON.parse(res.content[0].text);
const errMsg = (res) => out(res).error.message;

/** Run `fn(dir)` with a throw-away SN_DOCS_DIR. */
async function withDocs(env, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "snmcp-s2-"));
  try {
    return await withEnv({ SN_DOCS_DIR: dir, ...env }, () => fn(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A stateful Table API: records keyed by `<table>/<sys_id>`, sys_mod_count
 * bumped on every PATCH, sysparm_fields honoured, a POSTed sys_id kept.
 */
function instance(seed = {}) {
  const db = new Map(Object.entries(seed));
  let n = 0;
  const handler = (url, init) => {
    const u = new URL(url);
    const m = /^\/api\/now\/table\/([^/]+)(?:\/([^/]+))?$/.exec(u.pathname);
    if (!m) return jsonResponse(400, { error: { message: "bad path" } });
    const [, table, id] = m;
    const key = `${table}/${id}`;
    const method = init?.method ?? "GET";
    const notFound = () =>
      jsonResponse(404, { error: { message: "No Record found" } });
    if (method === "POST") {
      const body = JSON.parse(init.body);
      const sysId = body.sys_id ?? `new${++n}`;
      const rec = { ...body, sys_id: sysId, sys_mod_count: "0" };
      db.set(`${table}/${sysId}`, rec);
      return jsonResponse(201, { result: rec });
    }
    const rec = db.get(key);
    if (!rec) return notFound();
    if (method === "GET") {
      const fields = u.searchParams.get("sysparm_fields");
      const view = fields
        ? Object.fromEntries(
            fields
              .split(",")
              .filter((f) => f in rec)
              .map((f) => [f, rec[f]]),
          )
        : rec;
      return jsonResponse(200, { result: view });
    }
    if (method === "PATCH") {
      const next = {
        ...rec,
        ...JSON.parse(init.body),
        sys_mod_count: String(Number(rec.sys_mod_count) + 1),
      };
      db.set(key, next);
      return jsonResponse(200, { result: next });
    }
    if (method === "DELETE") {
      db.delete(key);
      return new Response(null, { status: 204 });
    }
    return jsonResponse(405, {});
  };
  return { db, handler };
}

const INC = {
  sys_id: "inc1",
  number: "INC001",
  short_description: "Printer down",
  urgency: "3",
  sys_mod_count: "4",
  sys_updated_on: "2026-09-01 10:00:00",
};

const journal = () => readWriteJournal().entries;
const last = () => journal().at(-1);

test("revert package: registered with a read and a write tool", () => {
  const pkg = PACKAGES.find((p) => p.name === "revert");
  assert.ok(pkg);
  assert.deepEqual(pkg.tools.map((t) => t.name).sort(), [
    "servicenow_list_writes",
    "servicenow_revert_write",
  ]);
  assert.equal(tool("servicenow_list_writes").annotations.readOnlyHint, true);
  assert.equal(
    tool("servicenow_revert_write").annotations.destructiveHint,
    true,
  );
});

test("resultModCount: number, numeric string, value pair, junk", () => {
  assert.equal(resultModCount({ sys_mod_count: 3 }), 3);
  assert.equal(resultModCount({ sys_mod_count: " 7 " }), 7);
  assert.equal(resultModCount({ sys_mod_count: { value: "2" } }), 2);
  assert.equal(resultModCount({ sys_mod_count: -1 }), undefined);
  assert.equal(resultModCount({ sys_mod_count: "x" }), undefined);
  assert.equal(resultModCount(null), undefined);
});

test("update → revert: plan preview, then apply restores before and journals reverts", async () => {
  await withDocs({}, async () => {
    const sn = instance({ "incident/inc1": { ...INC } });
    await withFetch(sn.handler, async () => {
      const upd = out(
        await call("servicenow_update_record", {
          table: "incident",
          sys_id: "inc1",
          fields: { urgency: "1", short_description: "Fire" },
          apply: true,
        }),
      );
      assert.equal(upd.record.urgency, "1");
      const origin = last();
      assert.equal(origin.tool, "servicenow_update_record");
      assert.equal(origin.after_mod_count, 5);

      // Plan mode: nothing written, preview shows the inverse and drift.
      const plan = out(
        await call("servicenow_revert_write", { entry_id: origin.id }),
      );
      assert.equal(plan.mode, "plan");
      assert.equal(plan.action, "update");
      assert.equal(plan.reverts, origin.id);
      assert.deepEqual(plan.after, {
        urgency: "3",
        short_description: "Printer down",
      });
      assert.equal(plan.drift.status, "clean");
      assert.equal(plan.drift.basis, "sys_mod_count");
      assert.equal(plan.would_refuse, false);
      assert.equal(sn.db.get("incident/inc1").urgency, "1");
      assert.equal(journal().length, 1);

      const res = out(
        await call("servicenow_revert_write", {
          entry_id: origin.id,
          apply: true,
        }),
      );
      assert.equal(res.message, "Write reverted");
      assert.equal(res.inverse, "update");
      assert.equal(res.forced, false);
      assert.equal(sn.db.get("incident/inc1").urgency, "3");
      assert.equal(
        sn.db.get("incident/inc1").short_description,
        "Printer down",
      );

      const rev = last();
      assert.equal(rev.reverts, origin.id);
      assert.equal(rev.tool, "servicenow_revert_write");
      assert.equal(rev.action, "update");
      assert.equal(rev.result, "applied");
      assert.equal(rev.force, undefined);
      assert.deepEqual(rev.before, {
        urgency: "1",
        short_description: "Fire",
      });
      assert.equal(rev.after_mod_count, 6);

      // Already reverted: a second revert is refused.
      const again = await call("servicenow_revert_write", {
        entry_id: origin.id,
        apply: true,
      });
      assert.equal(again.isError, true);
      assert.match(again.content[0].text, /NOT_REVERTIBLE/);
      assert.match(again.content[0].text, /already reverted/);

      // Redo: reverting the revert re-applies the original update.
      await call("servicenow_revert_write", { entry_id: rev.id, apply: true });
      assert.equal(sn.db.get("incident/inc1").urgency, "1");
      assert.equal(last().reverts, rev.id);
    });
  });
});

test("create → revert deletes the record; delete → revert re-creates it", async () => {
  await withDocs({}, async () => {
    const sn = instance();
    await withFetch(sn.handler, async () => {
      const created = out(
        await call("servicenow_create_record", {
          table: "incident",
          fields: { short_description: "Temp" },
          apply: true,
        }),
      );
      const sysId = created.record.sys_id;
      const origin = last();
      assert.equal(origin.after_mod_count, 0);

      const plan = out(
        await call("servicenow_revert_write", { entry_id: origin.id }),
      );
      assert.equal(plan.action, "delete");
      assert.equal(plan.before.short_description, "Temp");
      assert.equal(plan.after, undefined);

      const res = out(
        await call("servicenow_revert_write", {
          entry_id: origin.id,
          apply: true,
        }),
      );
      assert.equal(res.inverse, "delete");
      assert.equal(sn.db.has(`incident/${sysId}`), false);
      const rev = last();
      assert.equal(rev.action, "delete");
      assert.equal(rev.reverts, origin.id);
      assert.equal(rev.before.short_description, "Temp");

      // Redo of a create-revert re-creates from the revert's before state.
      const redo = out(
        await call("servicenow_revert_write", {
          entry_id: rev.id,
          apply: true,
        }),
      );
      assert.equal(redo.inverse, "create");
      assert.equal(redo.sys_id_preserved, true);
      assert.equal(sn.db.get(`incident/${sysId}`).short_description, "Temp");
    });
  });
});

test("delete → revert re-creates from before without system fields", async () => {
  await withDocs({}, async () => {
    const sn = instance({ "incident/inc1": { ...INC } });
    await withFetch(sn.handler, async (calls) => {
      await call("servicenow_delete_record", {
        table: "incident",
        sys_id: "inc1",
        apply: true,
      });
      assert.equal(sn.db.has("incident/inc1"), false);
      const origin = last();

      const plan = out(
        await call("servicenow_revert_write", { entry_id: origin.id }),
      );
      assert.equal(plan.action, "create");
      assert.equal(plan.after.sys_id, "inc1");
      assert.equal(plan.after.sys_mod_count, undefined);

      const res = out(
        await call("servicenow_revert_write", {
          entry_id: origin.id,
          apply: true,
        }),
      );
      assert.equal(res.inverse, "create");
      assert.equal(res.sys_id, "inc1");
      assert.equal(res.sys_id_preserved, true);
      const post = calls.at(-1);
      assert.equal(post.init.method, "POST");
      const body = JSON.parse(post.init.body);
      assert.equal(body.sys_id, "inc1");
      assert.equal(body.number, "INC001");
      assert.equal(body.sys_updated_on, undefined);
      assert.equal(body.sys_mod_count, undefined);
      assert.equal(
        sn.db.get("incident/inc1").short_description,
        "Printer down",
      );
      assert.equal(last().action, "create");
      assert.equal(last().sys_id, "inc1");

      // The record exists again: re-running the delete's revert is refused.
      const dup = appendWriteJournal({
        action: "delete",
        table: "incident",
        sys_id: "inc1",
        before: INC,
        tool: "servicenow_delete_record",
      });
      const again = await call("servicenow_revert_write", { entry_id: dup.id });
      assert.equal(again.isError, true);
      assert.match(again.content[0].text, /exists again/);
    });
  });
});

test("re-create reports a new sys_id when the instance does not keep it", async () => {
  await withDocs({}, async () => {
    const sn = instance();
    const handler = (url, init) => {
      if (init?.method === "POST") {
        const body = { ...JSON.parse(init.body), sys_id: undefined };
        return sn.handler(url, { ...init, body: JSON.stringify(body) });
      }
      return sn.handler(url, init);
    };
    await withFetch(handler, async () => {
      const origin = appendWriteJournal({
        action: "delete",
        table: "incident",
        sys_id: "gone",
        before: { sys_id: "gone", short_description: "Old" },
        tool: "servicenow_delete_record",
      });
      const res = out(
        await call("servicenow_revert_write", {
          entry_id: origin.id,
          apply: true,
        }),
      );
      assert.equal(res.sys_id_preserved, false);
      assert.match(res.sys_id, /^new/);
    });
  });
});

test("drift: sys_mod_count moved on → STALE_RECORD; force reverts and is journaled", async () => {
  await withDocs({}, async () => {
    const sn = instance({ "incident/inc1": { ...INC } });
    await withFetch(sn.handler, async () => {
      await call("servicenow_update_record", {
        table: "incident",
        sys_id: "inc1",
        fields: { urgency: "1" },
        apply: true,
      });
      const origin = last();
      // Someone else edits the record afterwards.
      const rec = sn.db.get("incident/inc1");
      sn.db.set("incident/inc1", {
        ...rec,
        short_description: "Edited elsewhere",
        sys_mod_count: String(Number(rec.sys_mod_count) + 1),
      });

      const plan = out(
        await call("servicenow_revert_write", { entry_id: origin.id }),
      );
      assert.equal(plan.drift.status, "drift");
      assert.equal(plan.drift.expected_mod_count, 5);
      assert.equal(plan.drift.actual_mod_count, 6);
      assert.equal(plan.would_refuse, true);

      const refused = await call("servicenow_revert_write", {
        entry_id: origin.id,
        apply: true,
      });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /STALE_RECORD/);
      assert.match(refused.content[0].text, /force:true/);
      assert.equal(sn.db.get("incident/inc1").urgency, "1");
      assert.equal(last().id, origin.id); // nothing journaled

      const forced = out(
        await call("servicenow_revert_write", {
          entry_id: origin.id,
          force: true,
          apply: true,
        }),
      );
      assert.equal(forced.forced, true);
      assert.equal(sn.db.get("incident/inc1").urgency, "3");
      assert.equal(last().force, true);
      assert.equal(last().reverts, origin.id);
    });
  });
});

test("drift without a mod-count baseline: compares the written fields", async () => {
  await withDocs({}, async () => {
    const sn = instance({
      "change_request/chg1": {
        sys_id: "chg1",
        state: "-4",
        // no sys_mod_count on this record
      },
    });
    await withFetch(sn.handler, async () => {
      const clean = appendWriteJournal({
        action: "update",
        table: "change_request",
        sys_id: "chg1",
        fields: { state: "-4" },
        before: { state: { value: "-5", display_value: "New" } },
        tool: "servicenow_update_change",
      });
      const plan = out(
        await call("servicenow_revert_write", { entry_id: clean.id }),
      );
      assert.equal(plan.drift.status, "clean");
      assert.equal(plan.drift.basis, "fields");
      assert.deepEqual(plan.after, { state: "-5" }); // value pair unwrapped

      sn.db.get("change_request/chg1").state = "-3";
      const drifted = out(
        await call("servicenow_revert_write", { entry_id: clean.id }),
      );
      assert.equal(drifted.drift.status, "drift");
      assert.deepEqual(drifted.drift.changed_fields, ["state"]);

      // Nothing comparable → unverified, which apply refuses without force.
      const unverified = appendWriteJournal({
        action: "create",
        table: "change_request",
        sys_id: "chg1",
        fields: { template_id: "tpl" },
        tool: "servicenow_create_change",
      });
      const p2 = out(
        await call("servicenow_revert_write", { entry_id: unverified.id }),
      );
      assert.equal(p2.drift.status, "unverified");
      const refused = await call("servicenow_revert_write", {
        entry_id: unverified.id,
        apply: true,
      });
      assert.match(refused.content[0].text, /Cannot verify/);
    });
  });
});

test("CMDB update: before read from { attributes } with a mod-count baseline", async () => {
  await withDocs({}, async () => {
    const sn = instance({
      "cmdb_ci_server/ci1": {
        sys_id: "ci1",
        ip_address: "10.0.0.2",
        sys_mod_count: "3",
      },
    });
    await withFetch(sn.handler, async () => {
      const origin = appendWriteJournal({
        action: "update",
        table: "cmdb_ci_server",
        sys_id: "ci1",
        fields: { ip_address: "10.0.0.2" },
        before: { attributes: { ip_address: "10.0.0.1", sys_mod_count: "2" } },
        tool: "servicenow_update_ci",
      });
      const res = out(
        await call("servicenow_revert_write", {
          entry_id: origin.id,
          apply: true,
        }),
      );
      assert.equal(res.drift.basis, "sys_mod_count");
      assert.equal(res.drift.status, "clean");
      assert.equal(sn.db.get("cmdb_ci_server/ci1").ip_address, "10.0.0.1");
    });
  });
});

test("NOT_REVERTIBLE: unknown id, missing before, redacted before and more", async () => {
  await withDocs({}, async () => {
    const sn = instance({ "incident/inc1": { ...INC } });
    await withFetch(sn.handler, async () => {
      const expectNot = async (entryId, pattern) => {
        const res = await call("servicenow_revert_write", {
          entry_id: entryId,
          apply: true,
        });
        assert.equal(res.isError, true, entryId);
        assert.match(res.content[0].text, /NOT_REVERTIBLE/);
        assert.match(res.content[0].text, pattern);
      };
      await expectNot("01NOSUCHENTRY", /no entry with this id/);

      const add = (entry) => appendWriteJournal(entry).id;
      await expectNot(
        add({
          action: "update",
          table: "incident",
          sys_id: "inc1",
          fields: { urgency: "1" },
          tool: "servicenow_update_record",
        }),
        /no before state/,
      );
      await expectNot(
        add({
          action: "update",
          table: "incident",
          sys_id: "inc1",
          fields: { urgency: "1", impact: "1" },
          before: { urgency: "3" },
          tool: "servicenow_update_record",
        }),
        /lacks impact/,
      );
      // appendWriteJournal redacts a secret-looking before value itself.
      const redactedId = add({
        action: "update",
        table: "incident",
        sys_id: "inc1",
        fields: { description: "x" },
        before: { description: "[redacted]" },
        tool: "servicenow_update_record",
      });
      await expectNot(redactedId, /description was redacted/);
      await expectNot(
        add({
          action: "update",
          table: "incident",
          sys_id: "inc1",
          fields: {},
          before: {},
          tool: "servicenow_update_record",
        }),
        /wrote no fields/,
      );
      await expectNot(
        add({
          action: "update",
          table: "incident",
          sys_id: "inc1",
          fields: { urgency: "1" },
          before: { urgency: "3" },
          result: "failed",
          tool: "servicenow_update_record",
        }),
        /was failed/,
      );
      await expectNot(
        add({
          action: "execute",
          table: "sys_atf_test",
          tool: "servicenow_run_atf_test",
        }),
        /no inverse/,
      );
      await expectNot(
        add({
          action: "update",
          table: "incident",
          sys_id: "a",
          batch_id: "B1",
        }),
        /Batch API/,
      );
      await expectNot(
        add({
          action: "create",
          table: "email",
          sys_id: "e1",
          tool: "servicenow_send_email",
        }),
        /cannot be unsent/,
      );
      await expectNot(
        add({
          action: "create",
          table: "cmdb_ci",
          sys_id: "c",
          tool: "servicenow_create_ci",
        }),
        /Identification & Reconciliation/,
      );
      await expectNot(
        add({
          action: "create",
          table: "x",
          sys_id: "c",
          tool: "servicenow_mystery",
        }),
        /no known inverse/,
      );
      await expectNot(
        add({ action: "create", table: "incident", sys_id: "c" }),
        /predates tool stamping/,
      );
      await expectNot(
        add({ action: "delete", table: "sys_attachment", sys_id: "att" }),
        /sys_attachment writes cannot be inverted/,
      );
      await expectNot(
        add({
          action: "delete",
          table: "incident",
          tool: "servicenow_delete_record",
          before: {},
        }),
        /no sys_id/,
      );
      await expectNot(
        add({
          action: "create",
          table: "incident",
          sys_id: "missing",
          tool: "servicenow_create_record",
        }),
        /no longer exists/,
      );

      // A legacy (un-stamped) update is still revertible.
      const legacy = add({
        action: "update",
        table: "incident",
        sys_id: "inc1",
        fields: { urgency: "3" },
        before: { urgency: "2", sys_mod_count: "3" },
      });
      const plan = out(
        await call("servicenow_revert_write", { entry_id: legacy }),
      );
      assert.equal(plan.drift.expected_mod_count, 4);
      assert.equal(plan.drift.status, "clean");
    });
  });
});

test("redacted before (SN_REDACT_FIELDS / SN_REDACT_PII): whole revert refused", async () => {
  await withDocs({ SN_REDACT_FIELDS: "short_description" }, async () => {
    const sn = instance({ "incident/inc1": { ...INC } });
    await withFetch(sn.handler, async () => {
      await call("servicenow_update_record", {
        table: "incident",
        sys_id: "inc1",
        fields: { urgency: "1", short_description: "Fire" },
        apply: true,
      });
      const origin = last();
      assert.equal(origin.before.short_description, "[redacted]");
      const res = await call("servicenow_revert_write", {
        entry_id: origin.id,
        apply: true,
      });
      assert.equal(res.isError, true);
      assert.match(errMsg(res), /short_description was redacted/);
      assert.match(errMsg(res), /no partial revert/);
      assert.equal(sn.db.get("incident/inc1").urgency, "1");
    });
  });
  await withDocs({ SN_REDACT_PII: "true" }, async () => {
    const e = appendWriteJournal({
      action: "delete",
      table: "sys_user",
      sys_id: "u1",
      before: { sys_id: "u1", email: "ann@example.com" },
      tool: "servicenow_delete_record",
    });
    const res = await call("servicenow_revert_write", { entry_id: e.id });
    assert.match(errMsg(res), /email was redacted/);
  });
});

test("NOT_REVERTIBLE when the journal chain is broken", async () => {
  await withDocs({}, async (dir) => {
    const { writeFileSync, readFileSync } = await import("node:fs");
    const e = appendWriteJournal({
      action: "delete",
      table: "incident",
      sys_id: "inc1",
      before: INC,
      tool: "servicenow_delete_record",
    });
    const file = path.join(dir, "default", "write-journal.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").replace("INC001", "INC999"));
    const res = await call("servicenow_revert_write", { entry_id: e.id });
    assert.match(res.content[0].text, /hash chain is broken@1/);
    const listed = out(await call("servicenow_list_writes", {}));
    assert.equal(listed.integrity, "broken@1");
    assert.equal(listed.entries[0].revertible, false);
  });
});

test("policy: SN_READONLY and package axes block the apply, not the plan", async () => {
  await withDocs({}, async () => {
    const sn = instance({ "incident/inc1": { ...INC } });
    await withFetch(sn.handler, async () => {
      const id = appendWriteJournal({
        action: "update",
        table: "incident",
        sys_id: "inc1",
        fields: { urgency: "3" },
        before: { urgency: "2" },
        after_mod_count: 4,
        tool: "servicenow_update_record",
      }).id;
      await withEnv({ SN_READONLY: "true" }, async () => {
        const res = await call("servicenow_revert_write", {
          entry_id: id,
          apply: true,
        });
        assert.equal(res.isError, true);
        assert.match(res.content[0].text, /read-only|SN_READONLY/i);
      });
      await withEnv({ SN_PACKAGES_READONLY: "table" }, async () => {
        const plan = out(
          await call("servicenow_revert_write", { entry_id: id }),
        );
        assert.equal(plan.mode, "plan");
        const res = await call("servicenow_revert_write", {
          entry_id: id,
          apply: true,
        });
        assert.match(errMsg(res), /Package "table" is read-only/);
      });
      await withEnv({ SN_PACKAGES_DENY: "table" }, async () => {
        const res = await call("servicenow_revert_write", {
          entry_id: id,
          apply: true,
        });
        assert.match(errMsg(res), /package "table" is denied/);
      });
      await withEnv({ SN_WRITE_MODE: "apply" }, async () => {
        const res = out(
          await call("servicenow_revert_write", { entry_id: id }),
        );
        assert.equal(res.message, "Write reverted");
      });
      assert.equal(sn.db.get("incident/inc1").urgency, "2");
    });
  });
});

test("list_writes: newest first, summaries, filters and validation", async () => {
  await withDocs({ SN_PROFILE_QA_INSTANCE: "qa.service-now.com" }, async () => {
    const a = appendWriteJournal({
      action: "create",
      table: "incident",
      sys_id: "i1",
      fields: { short_description: "a" },
      tool: "servicenow_create_record",
    });
    const b = appendWriteJournal({
      action: "update",
      table: "problem",
      sys_id: "p1",
      fields: { state: "2" },
      before: { state: "1" },
      result: "failed",
      error: "boom",
      tool: "servicenow_update_record",
    });
    const c = appendWriteJournal({
      action: "update",
      table: "incident",
      sys_id: "i1",
      fields: { state: "2" },
      tool: "servicenow_update_record",
    });

    const all = out(await call("servicenow_list_writes", {}));
    assert.equal(all.integrity, "ok");
    assert.equal(all.total, 3);
    assert.deepEqual(
      all.entries.map((e) => e.id),
      [c.id, b.id, a.id],
    );
    const [ec, eb, ea] = all.entries;
    assert.equal(ea.revertible, true);
    assert.deepEqual(ea.fields, ["short_description"]);
    assert.equal(ea.has_before, false);
    assert.equal(eb.revertible, false);
    assert.match(eb.reason, /was failed/);
    assert.equal(ec.revertible, false);
    assert.match(ec.reason, /no before state/);

    const inc = out(
      await call("servicenow_list_writes", { table: "INCIDENT" }),
    );
    assert.equal(inc.total, 2);
    const failed = out(
      await call("servicenow_list_writes", { result: "failed" }),
    );
    assert.deepEqual(
      failed.entries.map((e) => e.id),
      [b.id],
    );
    const updates = out(
      await call("servicenow_list_writes", { action: "update", limit: 1 }),
    );
    assert.equal(updates.total, 2);
    assert.equal(updates.returned, 1);
    const verbose = out(
      await call("servicenow_list_writes", { verbose: true, limit: 1 }),
    );
    assert.deepEqual(verbose.entries[0].fields, { state: "2" });
    const future = out(
      await call("servicenow_list_writes", { since: "2999-01-01" }),
    );
    assert.equal(future.total, 0);
    const past = out(
      await call("servicenow_list_writes", { since: "2000-01-01T00:00:00Z" }),
    );
    assert.equal(past.total, 3);

    const bad = await call("servicenow_list_writes", { since: "yesterday" });
    assert.equal(bad.isError, true);
    assert.match(errMsg(bad), /Invalid "since"/);

    // Another profile's journal: empty here, and names are validated.
    const qa = out(await call("servicenow_list_writes", { profile: "qa" }));
    assert.equal(qa.profile, "qa");
    assert.equal(qa.total, 0);
    const traversal = await call("servicenow_list_writes", {
      profile: "../etc",
    });
    assert.equal(traversal.isError, true);

    // After a revert the origin reads as already reverted.
    appendWriteJournal({
      action: "delete",
      table: "incident",
      sys_id: "i1",
      reverts: a.id,
      tool: "servicenow_revert_write",
    });
    const after = listWrites({ table: "incident" });
    const origin = after.entries.find((e) => e.id === a.id);
    assert.equal(origin.revertible, false);
    assert.match(origin.reason, /already reverted/);
  });
});

test("buildRevertSpec: packages cover the origin and the Table API", () => {
  const spec = buildRevertSpec(
    {
      id: "X",
      ts: "t",
      profile: "default",
      action: "update",
      table: "change_request",
      sys_id: "c1",
      fields: { state: "1" },
      before: { state: "2" },
      result: "applied",
      tool: "servicenow_update_change",
    },
    new Set(),
  );
  assert.deepEqual(spec.packages, ["change", "table"]);
  assert.equal(spec.inverse, "update");
  assert.deepEqual(spec.restore, { state: "2" });
});
