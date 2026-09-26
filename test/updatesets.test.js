// S-6 — update-set awareness: the opt-in `updatesets` read tools (list, get,
// compare against a profile or a snapshot) and the write binding of the Table
// tools (`update_set` / SN_UPDATE_SET): the plan names the target set, apply
// switches the user's sys_update_set preference, restores it afterwards and
// journals the set.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseUpdatePayload } from "../build/api/updatesets.js";
import { getUpdateSetSetting } from "../build/core/settings.js";
import { readWriteJournal } from "../build/core/write-journal.js";
import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS, PACKAGES } from "../build/mcp/registry.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

baselineEnv();

const tool = (name) => {
  const spec = ALL_TOOLS.find((s) => s.name === name);
  assert.ok(spec, `missing tool ${name}`);
  return spec;
};
const call = (name, args) => runSpec(tool(name), args);
const out = (res) => JSON.parse(res.content[0].text);

const PROD_HOST = "prod99999.service-now.com";
const PROD_ENV = {
  SN_PROFILE_PROD_INSTANCE: PROD_HOST,
  SN_PROFILE_PROD_USER: "prod.user",
  SN_PROFILE_PROD_PASSWORD: "pr0d",
};

const id = (c) => c.repeat(32);
const SET_OPEN = {
  sys_id: id("a"),
  name: "Sprint 12",
  state: "in progress",
  application: "global",
  "application.name": "Global",
  is_default: "false",
  description: "Sprint work",
  sys_created_by: "alice",
  sys_updated_on: "2026-09-20 10:00:00",
};
const SET_DONE = {
  ...SET_OPEN,
  sys_id: id("b"),
  name: "Sprint 11",
  state: "complete",
};
const SET_SCOPED = {
  ...SET_OPEN,
  sys_id: id("c"),
  name: "Scoped work",
  application: id("d"),
  "application.name": "Acme App",
};
const BR_ID = id("e");

const brPayload = (script, extra = "") =>
  `<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_script"><sys_script action="INSERT_OR_UPDATE">` +
  `<active>true</active><collection display_value="Incident">incident</collection>` +
  `<name>Set priority</name><script><![CDATA[${script}]]></script>` +
  `<sys_id>${BR_ID}</sys_id><sys_updated_on>2026-09-20 10:00:00</sys_updated_on>${extra}` +
  `</sys_script></record_update>`;

/**
 * One stateful mock Table API per host: list GETs filter on `f=v`, `fLIKEv`,
 * `fINa,b` and `fISEMPTY` (ORDERBY and dot-walks are literal row keys), POST
 * creates, PATCH merges, DELETE removes. `fail(method, table)` can force an
 * error response.
 */
function instance(seed, { fail = () => undefined } = {}) {
  const db = new Map();
  for (const [table, rows] of Object.entries(seed)) {
    db.set(table, new Map(rows.map((r) => [r.sys_id, { ...r }])));
  }
  const tableRows = (t) => {
    if (!db.has(t)) db.set(t, new Map());
    return db.get(t);
  };
  let n = 0;
  const handler = (url, init) => {
    const u = new URL(url);
    const m = /^\/api\/now\/table\/([^/]+)(?:\/([^/]+))?$/.exec(u.pathname);
    assert.ok(m, `unexpected path ${u.pathname}`);
    const [, table, sysId] = m;
    const method = init?.method ?? "GET";
    const forced = fail(method, table);
    if (forced) return forced;
    const rows = tableRows(table);
    if (method === "POST") {
      const body = JSON.parse(init.body);
      const rec = { ...body, sys_id: `new${++n}`, sys_mod_count: "0" };
      if (table === "sys_user_preference" && body.user === "u1") {
        rec["user.user_name"] = "alice";
      }
      rows.set(rec.sys_id, rec);
      return jsonResponse(201, { result: rec });
    }
    if (method === "PATCH") {
      const next = { ...rows.get(sysId), ...JSON.parse(init.body) };
      rows.set(sysId, next);
      return jsonResponse(200, { result: next });
    }
    if (method === "DELETE") {
      rows.delete(sysId);
      return new Response(null, { status: 204 });
    }
    if (sysId) {
      const rec = rows.get(sysId);
      return rec
        ? jsonResponse(200, { result: rec })
        : jsonResponse(404, { error: { message: "No Record found" } });
    }
    const conds = (u.searchParams.get("sysparm_query") ?? "")
      .split("^")
      .filter((c) => c && !c.startsWith("ORDERBY"));
    const match = (r) =>
      conds.every((c) => {
        const [, f, op, v] = /^([a-z_.0-9]+?)(LIKE|IN|ISEMPTY|=)(.*)$/.exec(c);
        const have = String(r[f] ?? "");
        if (op === "LIKE") return have.includes(v);
        if (op === "IN") return v.split(",").includes(have);
        if (op === "ISEMPTY") return !have;
        return have === v;
      });
    const all = [...rows.values()].filter(match);
    const offset = Number(u.searchParams.get("sysparm_offset") ?? "0");
    const limit = Number(u.searchParams.get("sysparm_limit") ?? "10000");
    const fields = u.searchParams.get("sysparm_fields")?.split(",");
    const page = all
      .slice(offset, offset + limit)
      .map((r) =>
        fields
          ? Object.fromEntries(
              fields.filter((f) => f in r).map((f) => [f, r[f]]),
            )
          : r,
      );
    return jsonResponse(
      200,
      { result: page },
      { "x-total-count": String(all.length) },
    );
  };
  return { db, handler, rows: tableRows };
}

/** Dev: three update sets, a business rule, the user and her preference. */
const devSeed = (prefValue = id("f")) => ({
  sys_update_set: [SET_OPEN, SET_DONE, SET_SCOPED],
  sys_user: [{ sys_id: "u1", user_name: "alice" }],
  sys_user_preference: prefValue
    ? [
        {
          sys_id: "p1",
          name: "sys_update_set",
          value: prefValue,
          user: "u1",
          "user.user_name": "alice",
        },
      ]
    : [],
  sys_db_object: [
    { sys_id: "t1", name: "sys_script", "super_class.name": "sys_metadata" },
    { sys_id: "t2", name: "incident", "super_class.name": "task" },
    { sys_id: "t3", name: "task", "super_class.name": "" },
    { sys_id: "t4", name: "u_synced", "super_class.name": "" },
  ],
  sys_dictionary: [
    {
      sys_id: "d1",
      name: "u_synced",
      internal_type: "collection",
      attributes: "update_synch=true",
    },
  ],
  sys_script: [
    { sys_id: BR_ID, name: "Set priority", script: "old();", active: "true" },
  ],
  incident: [{ sys_id: "i1", short_description: "Printer down" }],
  sys_update_xml: [
    {
      sys_id: "x1",
      update_set: id("a"),
      name: `sys_script_${BR_ID}`,
      type: "Business Rule",
      target_name: "Set priority",
      action: "INSERT_OR_UPDATE",
      table: "incident",
      payload: brPayload(
        "current.priority = 1;",
        "<u_api_key>k-123</u_api_key>",
      ),
    },
    {
      sys_id: "x2",
      update_set: id("a"),
      name: `sys_properties_${id("1")}`,
      type: "System Property",
      target_name: "glide.acme.flag",
      action: "INSERT_OR_UPDATE",
      table: "",
      payload: `<record_update table="sys_properties"><sys_properties action="INSERT_OR_UPDATE"><name>glide.acme.flag</name><sys_id>${id("1")}</sys_id><value>true</value></sys_properties></record_update>`,
    },
    {
      sys_id: "x3",
      update_set: id("a"),
      name: `sys_security_acl_${id("2")}`,
      type: "Access Control",
      target_name: "incident.read",
      action: "INSERT_OR_UPDATE",
      table: "",
      payload: `<record_update table="sys_security_acl"><sys_security_acl action="INSERT_OR_UPDATE"><name>incident</name><operation>read</operation><script>answer = true;</script><sys_id>${id("2")}</sys_id></sys_security_acl></record_update>`,
    },
    {
      sys_id: "x4",
      update_set: id("a"),
      name: `sys_script_${id("3")}`,
      type: "Business Rule",
      target_name: "Old rule",
      action: "DELETE",
      table: "incident",
      payload: `<record_update table="sys_script"><sys_script action="DELETE"><name>Old rule</name><sys_id>${id("3")}</sys_id></sys_script></record_update>`,
    },
    {
      sys_id: "x5",
      update_set: id("a"),
      name: "sys_dictionary_incident_u_x",
      type: "Dictionary",
      target_name: "incident.u_x",
      action: "INSERT_OR_UPDATE",
      table: "incident",
      payload: `<record_update><sys_dictionary action="INSERT_OR_UPDATE"><element>u_x</element></sys_dictionary></record_update>`,
    },
    {
      sys_id: "x9",
      update_set: id("b"),
      name: "other",
      type: "Script Include",
      target_name: "Other",
      action: "INSERT_OR_UPDATE",
      table: "",
      payload: "",
    },
  ],
});

/** Route by hostname: the default profile is dev, PROD_HOST is prod. */
const byHost = (dev, prod) => (url, init, n) =>
  (new URL(url).hostname === PROD_HOST ? prod : dev).handler(url, init, n);

/** Throw-away docs dir (journal, snapshots) plus a fresh runtime. */
async function withDocs(env, fn) {
  freshRuntime();
  const dir = mkdtempSync(path.join(tmpdir(), "snmcp-s6-"));
  try {
    return await withEnv({ SN_DOCS_DIR: dir, ...env }, () => fn(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tables = (calls) =>
  calls.map((c) => {
    const u = new URL(c.url);
    return `${c.init?.method ?? "GET"} ${u.pathname.replace("/api/now/table/", "")}`;
  });

// ---------------------------------------------------------------------------
// Package + settings
// ---------------------------------------------------------------------------

test("updatesets: an opt-in read-only package of three tools", () => {
  const pkg = PACKAGES.find((p) => p.name === "updatesets");
  assert.ok(pkg);
  assert.deepEqual(
    pkg.tools.map((t) => t.name),
    [
      "servicenow_list_update_sets",
      "servicenow_get_update_set",
      "servicenow_compare_update_set",
    ],
  );
  for (const t of pkg.tools) {
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.destructiveHint, false);
    assert.ok(t.output, `${t.name} declares an outputSchema`);
  }
});

test("SN_UPDATE_SET: global setting, a per-profile override, blank is unset", async () => {
  await withEnv(
    { SN_UPDATE_SET: " Sprint 12 ", SN_PROFILE_PROD_UPDATE_SET: undefined },
    () => {
      assert.equal(getUpdateSetSetting(), "Sprint 12");
      assert.equal(getUpdateSetSetting("prod"), "Sprint 12");
    },
  );
  await withEnv(
    { SN_UPDATE_SET: "Sprint 12", SN_PROFILE_PROD_UPDATE_SET: "Release 3" },
    () => {
      assert.equal(getUpdateSetSetting("default"), "Sprint 12");
      assert.equal(getUpdateSetSetting("prod"), "Release 3");
    },
  );
  await withEnv({ SN_UPDATE_SET: "  " }, () => {
    assert.equal(getUpdateSetSetting(), undefined);
  });
});

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

test("parseUpdatePayload: flat record fields, CDATA and entities", () => {
  const parsed = parseUpdatePayload(
    brPayload("if (a < b && c) {}", "<empty/><note>x &lt; y &amp;&#65;</note>"),
  );
  assert.equal(parsed.table, "sys_script");
  assert.equal(parsed.action, "INSERT_OR_UPDATE");
  assert.equal(parsed.fields.script, "if (a < b && c) {}");
  assert.equal(parsed.fields.collection, "incident");
  assert.equal(parsed.fields.empty, "");
  assert.equal(parsed.fields.note, "x < y &A");
  assert.equal(parsed.fields.sys_id, BR_ID);
});

test("parseUpdatePayload: non-record and nested payloads give a reason", () => {
  assert.match(parseUpdatePayload("").reason, /not a record_update/);
  assert.match(
    parseUpdatePayload('<record_update table="x"><y/></record_update>').reason,
    /no <x action/,
  );
  assert.match(
    parseUpdatePayload(
      '<record_update table="x"><x action="INSERT_OR_UPDATE"><a><b>1</b></a></x></record_update>',
    ).reason,
    /nested/,
  );
});

// ---------------------------------------------------------------------------
// servicenow_list_update_sets
// ---------------------------------------------------------------------------

test("list: filters compose one query and the user's current set is marked", async () => {
  freshRuntime();
  const sn = instance(devSeed(id("a")));
  await withFetch(sn.handler, async (calls) => {
    const res = out(
      await call("servicenow_list_update_sets", {
        state: "in progress",
        name: "Sprint",
        application: "global",
      }),
    );
    assert.equal(res.count, 1);
    assert.equal(res.total, 1);
    assert.equal(res.truncated, false);
    assert.equal(res.current_update_set, id("a"));
    assert.equal(res.update_sets[0].name, "Sprint 12");
    assert.equal(res.update_sets[0].current, true);
    assert.equal(res.update_sets[0].application_name, "Global");
    const q = new URL(
      calls.find((c) => c.url.includes("/sys_update_set?")).url,
    ).searchParams.get("sysparm_query");
    assert.equal(
      q,
      "state=in progress^nameLIKESprint^application=global^ORDERBYDESCsys_updated_on",
    );
  });
});

test("list: a scope namespace filters on application.scope; paging reports truncation", async () => {
  freshRuntime();
  const sn = instance(devSeed(null));
  await withFetch(sn.handler, async (calls) => {
    const res = out(await call("servicenow_list_update_sets", { limit: 2 }));
    assert.equal(res.count, 2);
    assert.equal(res.total, 3);
    assert.equal(res.truncated, true);
    assert.equal(res.current_update_set, null);
    await call("servicenow_list_update_sets", { application: "x_acme_app" });
    assert.match(
      calls.at(-1).url + calls.at(-2).url,
      /application\.scope%3Dx_acme_app/,
    );
    const bad = await call("servicenow_list_update_sets", { name: "a^b" });
    assert.equal(bad.isError, true);
  });
});

// ---------------------------------------------------------------------------
// servicenow_get_update_set
// ---------------------------------------------------------------------------

test("get: summarises sys_update_xml per artefact without payloads by default", async () => {
  freshRuntime();
  const sn = instance(devSeed());
  await withFetch(sn.handler, async (calls) => {
    const res = out(
      await call("servicenow_get_update_set", { update_set: "Sprint 12" }),
    );
    assert.equal(res.update_set.sys_id, id("a"));
    assert.equal(res.count, 5);
    assert.equal(res.truncated, false);
    assert.deepEqual(res.by_type, {
      "Business Rule": 2,
      "System Property": 1,
      "Access Control": 1,
      Dictionary: 1,
    });
    assert.deepEqual(res.by_action, { INSERT_OR_UPDATE: 4, DELETE: 1 });
    assert.ok(res.updates.every((u) => !("payload" in u)));
    const xmlCall = calls.find((c) => c.url.includes("/sys_update_xml"));
    const fields = new URL(xmlCall.url).searchParams.get("sysparm_fields");
    assert.doesNotMatch(fields, /payload/);
  });
});

test("get: include_payload parses fields, masks secrets and caps values", async () => {
  freshRuntime();
  const sn = instance(devSeed());
  await withFetch(sn.handler, async () => {
    const res = out(
      await call("servicenow_get_update_set", {
        update_set: id("a"),
        type: "Business Rule",
        include_payload: true,
        payload_max_chars: 20,
      }),
    );
    assert.equal(res.count, 2);
    const br = res.updates.find((u) => u.sys_id === "x1");
    assert.equal(br.payload.parsed, true);
    assert.equal(br.payload.table, "sys_script");
    assert.equal(br.payload.fields.u_api_key, "[redacted]");
    assert.equal(br.payload.fields.script, "current.priority = 1…");
    assert.doesNotMatch(JSON.stringify(res), /k-123/);
  });
});

test("get: an unknown set is UPDATE_SET_NOT_FOUND; a shared name prefers the open set", async () => {
  freshRuntime();
  const seed = devSeed();
  seed.sys_update_set.push({ ...SET_DONE, sys_id: id("9"), name: "Sprint 12" });
  const sn = instance(seed);
  await withFetch(sn.handler, async () => {
    const missing = await call("servicenow_get_update_set", {
      update_set: "Nope",
    });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /UPDATE_SET_NOT_FOUND/);
    const res = out(
      await call("servicenow_get_update_set", { update_set: "Sprint 12" }),
    );
    assert.equal(res.update_set.sys_id, id("a"));
    // Two sets named "Sprint 11", neither in progress: ambiguous.
    sn.rows("sys_update_set").set(id("8"), { ...SET_DONE, sys_id: id("8") });
    const amb = await call("servicenow_get_update_set", {
      update_set: "Sprint 11",
    });
    assert.match(amb.content[0].text, /AMBIGUOUS_KEY/);
  });
});

// ---------------------------------------------------------------------------
// servicenow_compare_update_set
// ---------------------------------------------------------------------------

test("compare: against another profile, read live per table", async () => {
  await withDocs(PROD_ENV, async () => {
    const dev = instance(devSeed());
    const prod = instance({
      sys_script: [
        {
          sys_id: BR_ID,
          name: "Set priority",
          script: "current.priority = 2;",
          active: "true",
          collection: "incident",
          sys_updated_on: "2025-01-01",
        },
      ],
      sys_properties: [],
      sys_security_acl: [
        {
          sys_id: id("2"),
          name: "incident",
          operation: "read",
          script: "answer = true;",
        },
      ],
    });
    await withFetch(byHost(dev, prod), async (calls) => {
      const res = out(
        await call("servicenow_compare_update_set", {
          update_set: "Sprint 12",
          with_profile: "prod",
        }),
      );
      assert.deepEqual(res.against, { profile: "prod" });
      const by = Object.fromEntries(
        res.artefacts.map((a) => [a.target_name, a]),
      );
      assert.equal(by["Set priority"].status, "different");
      // Only script differs: audit columns and fields prod lacks are skipped.
      assert.deepEqual(by["Set priority"].fields, ["script"]);
      assert.equal(by["glide.acme.flag"].status, "missing");
      assert.equal(by["incident.read"].status, "same");
      // Deleted by the set and absent on prod: already in the target state.
      assert.equal(by["Old rule"].status, "same");
      assert.equal(by["incident.u_x"].status, "not_comparable");
      assert.deepEqual(res.summary, {
        different: 1,
        missing: 1,
        same: 2,
        not_comparable: 1,
      });
      const prodCalls = calls.filter((c) => c.url.includes(PROD_HOST));
      assert.ok(
        prodCalls.every((c) => /sys_idIN/.test(decodeURIComponent(c.url))),
      );
      assert.ok(res.caveats.length > 0);
    });
  });
});

test("compare: an unreadable table on the other profile is unknown with a warning", async () => {
  await withDocs(PROD_ENV, async () => {
    const dev = instance(devSeed());
    const prod = instance(
      { sys_properties: [], sys_security_acl: [] },
      {
        fail: (_m, table) =>
          table === "sys_script"
            ? jsonResponse(403, { error: { message: "ACL denied" } })
            : undefined,
      },
    );
    await withFetch(byHost(dev, prod), async () => {
      const res = out(
        await call("servicenow_compare_update_set", {
          update_set: id("a"),
          with_profile: "prod",
        }),
      );
      const brs = res.artefacts.filter((a) => a.table === "sys_script");
      assert.ok(brs.every((a) => a.status === "unknown"));
      assert.equal(res.warnings.length, 1);
      assert.match(res.warnings[0], /sys_script unreadable on "prod"/);
    });
  });
});

test("compare: against a snapshot covers only its record sections", async () => {
  await withDocs(PROD_ENV, async (dir) => {
    mkdirSync(path.join(dir, "prod"), { recursive: true });
    const hash = createHash("sha256")
      .update("answer = false;")
      .digest("hex")
      .slice(0, 16);
    writeFileSync(
      path.join(dir, "prod", "acls.json"),
      JSON.stringify({
        records: [
          {
            sys_id: id("2"),
            name: "incident",
            operation: "read",
            script_hash: hash,
          },
        ],
      }),
    );
    writeFileSync(
      path.join(dir, "prod", "properties.json"),
      JSON.stringify({
        records: [
          {
            sys_id: id("1"),
            name: "glide.acme.flag",
            value: "[redacted]",
          },
        ],
      }),
    );
    const dev = instance(devSeed());
    await withFetch(dev.handler, async (calls) => {
      const res = out(
        await call("servicenow_compare_update_set", {
          update_set: "Sprint 12",
          with_snapshot: "prod",
        }),
      );
      assert.deepEqual(res.against, { snapshot: "prod" });
      const by = Object.fromEntries(
        res.artefacts.map((a) => [a.target_name, a]),
      );
      assert.equal(by["incident.read"].status, "different");
      assert.deepEqual(by["incident.read"].fields, ["script_hash"]);
      // A redacted snapshot value is never reported as a difference.
      assert.equal(by["glide.acme.flag"].status, "same");
      assert.equal(by["Set priority"].status, "not_covered");
      assert.ok(calls.every((c) => !c.url.includes(PROD_HOST)));
    });
  });
});

test("compare: exactly one of with_profile / with_snapshot, and a known profile", async () => {
  freshRuntime();
  const dev = instance(devSeed());
  await withFetch(dev.handler, async (calls) => {
    const none = await call("servicenow_compare_update_set", {
      update_set: "Sprint 12",
    });
    assert.match(none.content[0].text, /exactly one of/);
    const both = await call("servicenow_compare_update_set", {
      update_set: "Sprint 12",
      with_profile: "a",
      with_snapshot: "b",
    });
    assert.match(both.content[0].text, /exactly one of/);
    const unknown = await call("servicenow_compare_update_set", {
      update_set: "Sprint 12",
      with_profile: "nope",
    });
    assert.match(unknown.content[0].text, /Unknown connection profile/);
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Write binding
// ---------------------------------------------------------------------------

test("binding: without update_set or SN_UPDATE_SET a write makes no extra request", async () => {
  await withDocs({ SN_UPDATE_SET: undefined }, async () => {
    const sn = instance(devSeed());
    await withFetch(sn.handler, async (calls) => {
      const plan = out(
        await call("servicenow_create_record", {
          table: "sys_script",
          fields: { name: "x" },
        }),
      );
      assert.equal(plan.mode, "plan");
      assert.equal(plan.update_set, undefined);
      assert.equal(calls.length, 0);
      const res = out(
        await call("servicenow_create_record", {
          table: "sys_script",
          fields: { name: "x" },
          apply: true,
        }),
      );
      assert.equal(res.update_set, undefined);
      assert.deepEqual(tables(calls), ["POST sys_script"]);
      assert.equal(readWriteJournal().entries.at(-1).update_set, undefined);
    });
  });
});

test("acceptance: an applied business-rule change lands in the named update set", async () => {
  await withDocs({}, async () => {
    const sn = instance(devSeed());
    await withFetch(sn.handler, async (calls) => {
      const args = {
        table: "sys_script",
        sys_id: BR_ID,
        fields: { script: "current.priority = 1;" },
        update_set: "Sprint 12",
      };
      const plan = out(await call("servicenow_update_record", args));
      assert.equal(plan.mode, "plan");
      assert.equal(plan.update_set.sys_id, id("a"));
      assert.equal(plan.update_set.name, "Sprint 12");
      assert.equal(plan.update_set.source, "argument");
      assert.equal(plan.update_set.captured, true);
      assert.match(plan.update_set.note, /recorded in update set "Sprint 12"/);
      assert.equal(plan.update_set.would_refuse, undefined);
      // The plan never touches the preference.
      assert.ok(tables(calls).every((t) => t.startsWith("GET ")));

      calls.length = 0;
      // The instance records the update in whatever set the preference names
      // when the business-rule PATCH arrives.
      const captured = [];
      const record = sn.handler;
      await withFetch(
        (url, init, n) => {
          if (init?.method === "PATCH" && url.includes("/sys_script/")) {
            captured.push(sn.rows("sys_user_preference").get("p1").value);
          }
          return record(url, init, n);
        },
        async (applyCalls) => {
          const res = out(
            await call("servicenow_update_record", { ...args, apply: true }),
          );
          assert.equal(res.message, "Record updated");
          assert.deepEqual(res.update_set, {
            sys_id: id("a"),
            name: "Sprint 12",
            bound: true,
            previous: id("f"),
            restored: true,
          });
          assert.deepEqual(captured, [id("a")]);
          const writes = tables(applyCalls).filter((t) => !t.startsWith("GET"));
          assert.deepEqual(writes, [
            "PATCH sys_user_preference/p1",
            "PATCH sys_script/" + BR_ID,
            "PATCH sys_user_preference/p1",
          ]);
        },
      );
      assert.equal(sn.rows("sys_user_preference").get("p1").value, id("f"));
      assert.equal(
        sn.rows("sys_script").get(BR_ID).script,
        "current.priority = 1;",
      );
      const entry = readWriteJournal().entries.at(-1);
      assert.equal(entry.action, "update");
      assert.equal(entry.update_set, id("a"));
    });
  });
});

test("binding: SN_UPDATE_SET applies to create; a missing preference row is created and removed", async () => {
  await withDocs({ SN_UPDATE_SET: "Sprint 12" }, async () => {
    const sn = instance(devSeed(null));
    await withFetch(sn.handler, async (calls) => {
      const plan = out(
        await call("servicenow_create_record", {
          table: "sys_script",
          fields: { name: "New rule" },
        }),
      );
      assert.equal(plan.update_set.source, "SN_UPDATE_SET");
      calls.length = 0;
      const res = out(
        await call("servicenow_create_record", {
          table: "sys_script",
          fields: { name: "New rule" },
          apply: true,
        }),
      );
      assert.equal(res.update_set.previous, null);
      assert.equal(res.update_set.restored, true);
      const writes = tables(calls).filter((t) => !t.startsWith("GET"));
      assert.deepEqual(writes, [
        "POST sys_user_preference",
        "POST sys_script",
        "DELETE sys_user_preference/new1",
      ]);
      const pref = JSON.parse(
        calls.find((c) => c.init?.method === "POST").init.body,
      );
      assert.deepEqual(pref, {
        user: "u1",
        name: "sys_update_set",
        value: id("a"),
        type: "string",
      });
      assert.equal(sn.rows("sys_user_preference").size, 0);
      assert.equal(readWriteJournal().entries.at(-1).update_set, id("a"));
    });
  });
});

test("binding: a scoped set also switches the scope's update-set preference", async () => {
  await withDocs({}, async () => {
    const sn = instance(devSeed());
    await withFetch(sn.handler, async (calls) => {
      const res = out(
        await call("servicenow_delete_record", {
          table: "sys_script",
          sys_id: BR_ID,
          update_set: id("c"),
          apply: true,
        }),
      );
      assert.equal(res.message, "Record deleted");
      assert.equal(res.update_set.restored, true);
      const writes = tables(calls).filter((t) => !t.startsWith("GET"));
      assert.deepEqual(writes, [
        "PATCH sys_user_preference/p1",
        "POST sys_user_preference",
        "DELETE sys_script/" + BR_ID,
        "DELETE sys_user_preference/new1",
        "PATCH sys_user_preference/p1",
      ]);
      const scoped = calls.find((c) => c.init?.method === "POST");
      assert.equal(
        JSON.parse(scoped.init.body).name,
        `updateSetForScope${id("d")}`,
      );
      const entry = readWriteJournal().entries.at(-1);
      assert.equal(entry.action, "delete");
      assert.equal(entry.update_set, id("c"));
    });
  });
});

test("binding: upsert carries the set into its plan and its applied write", async () => {
  await withDocs({}, async () => {
    const sn = instance(devSeed());
    await withFetch(sn.handler, async () => {
      const args = {
        table: "sys_script",
        key: { name: "Set priority" },
        fields: { active: "false" },
        update_set: "Sprint 12",
      };
      const plan = out(await call("servicenow_upsert_record", args));
      assert.equal(plan.action, "update");
      assert.equal(plan.update_set.name, "Sprint 12");
      const res = out(
        await call("servicenow_upsert_record", {
          ...args,
          ...plan.apply_with,
          apply: true,
        }),
      );
      assert.equal(res.update_set.bound, true);
      assert.equal(readWriteJournal().entries.at(-1).update_set, id("a"));
    });
  });
});

test("binding: a data-row table is written without switching, and the plan says so", async () => {
  await withDocs({ SN_UPDATE_SET: "Sprint 12" }, async () => {
    const sn = instance(devSeed());
    await withFetch(sn.handler, async (calls) => {
      const args = {
        table: "incident",
        sys_id: "i1",
        fields: { short_description: "Printer on fire" },
      };
      const plan = out(await call("servicenow_update_record", args));
      assert.equal(plan.update_set.captured, false);
      assert.match(plan.update_set.note, /data rows/);
      calls.length = 0;
      const res = out(
        await call("servicenow_update_record", { ...args, apply: true }),
      );
      assert.equal(res.update_set.bound, false);
      assert.ok(tables(calls).every((t) => !t.includes("sys_user_preference")));
      assert.equal(readWriteJournal().entries.at(-1).update_set, undefined);
    });
  });
});

test("binding: a table with the update_synch attribute is captured", async () => {
  await withDocs({}, async () => {
    const sn = instance(devSeed());
    await withFetch(sn.handler, async () => {
      const plan = out(
        await call("servicenow_create_record", {
          table: "u_synced",
          fields: { name: "x" },
          update_set: "Sprint 12",
        }),
      );
      assert.equal(plan.update_set.captured, true);
    });
  });
});

test("binding: a set that is not in progress is flagged in the plan and refused at apply", async () => {
  await withDocs({}, async () => {
    const sn = instance(devSeed());
    await withFetch(sn.handler, async (calls) => {
      const args = {
        table: "sys_script",
        fields: { name: "x" },
        update_set: "Sprint 11",
      };
      const plan = out(await call("servicenow_create_record", args));
      assert.equal(plan.update_set.would_refuse, true);
      assert.match(plan.update_set.note, /"complete", not "in progress"/);
      calls.length = 0;
      const res = await call("servicenow_create_record", {
        ...args,
        apply: true,
      });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /UPDATE_SET_NOT_IN_PROGRESS/);
      assert.ok(tables(calls).every((t) => t.startsWith("GET ")));
      assert.equal(readWriteJournal().entries.length, 0);
    });
  });
});

test("binding: an unknown set fails the plan before anything is written", async () => {
  await withDocs({}, async () => {
    const sn = instance(devSeed());
    await withFetch(sn.handler, async () => {
      const res = await call("servicenow_create_record", {
        table: "sys_script",
        fields: { name: "x" },
        update_set: "Nope",
        apply: true,
      });
      assert.match(res.content[0].text, /UPDATE_SET_NOT_FOUND/);
      assert.equal(sn.rows("sys_script").size, 1);
    });
  });
});

test("binding: a failed write still restores the preference", async () => {
  await withDocs({}, async () => {
    const sn = instance(devSeed(), {
      fail: (m, t) =>
        m === "PATCH" && t === "sys_script"
          ? jsonResponse(403, { error: { message: "Denied" } })
          : undefined,
    });
    await withFetch(sn.handler, async () => {
      const res = await call("servicenow_update_record", {
        table: "sys_script",
        sys_id: BR_ID,
        fields: { script: "x" },
        update_set: "Sprint 12",
        apply: true,
      });
      assert.equal(res.isError, true);
      assert.equal(sn.rows("sys_user_preference").get("p1").value, id("f"));
    });
  });
});

test("binding: a failed restore is reported, never the write's failure", async () => {
  await withDocs({}, async () => {
    let prefPatches = 0;
    const sn = instance(devSeed(), {
      fail: (m, t) =>
        m === "PATCH" && t === "sys_user_preference" && ++prefPatches === 2
          ? jsonResponse(403, { error: { message: "Denied" } })
          : undefined,
    });
    await withFetch(sn.handler, async () => {
      const res = out(
        await call("servicenow_update_record", {
          table: "sys_script",
          sys_id: BR_ID,
          fields: { script: "x" },
          update_set: "Sprint 12",
          apply: true,
        }),
      );
      assert.equal(res.message, "Record updated");
      assert.equal(res.update_set.restored, false);
      assert.match(
        res.update_set.warning,
        /Could not restore preference sys_update_set/,
      );
    });
  });
});

test("binding: the preference table is subject to the table policy", async () => {
  await withDocs({ SN_TABLES_DENY: "sys_user_preference" }, async () => {
    const sn = instance(devSeed());
    await withFetch(sn.handler, async () => {
      const res = await call("servicenow_create_record", {
        table: "sys_script",
        fields: { name: "x" },
        update_set: "Sprint 12",
        apply: true,
      });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /sys_user_preference/);
      assert.equal(sn.rows("sys_script").size, 1);
    });
  });
});

test("binding: concurrent bound writes of one user do not interleave switch and restore", async () => {
  await withDocs({}, async () => {
    const sn = instance(devSeed());
    await withFetch(sn.handler, async (calls) => {
      await Promise.all(
        ["a", "b"].map((name) =>
          call("servicenow_create_record", {
            table: "sys_script",
            fields: { name },
            update_set: "Sprint 12",
            apply: true,
          }),
        ),
      );
      const writes = tables(calls).filter((t) => !t.startsWith("GET"));
      assert.deepEqual(writes, [
        "PATCH sys_user_preference/p1",
        "POST sys_script",
        "PATCH sys_user_preference/p1",
        "PATCH sys_user_preference/p1",
        "POST sys_script",
        "PATCH sys_user_preference/p1",
      ]);
      assert.equal(sn.rows("sys_user_preference").get("p1").value, id("f"));
    });
  });
});
