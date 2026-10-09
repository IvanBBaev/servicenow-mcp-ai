// N-1 — upgrade readiness: history, skipped grouping, base vs customer.
import test from "node:test";
import assert from "node:assert/strict";

import {
  artifactTypeOfTable,
  classifySkip,
  groupSkipped,
  isResolved,
  isSkipDisposition,
  payloadFields,
  readSkipped,
  readStoreUpdates,
  readUpgradeHistory,
  renderSkipped,
  renderStoreUpdates,
  renderUpgradeHistory,
  reviewSkippedRecord,
  tableOfUpdateName,
} from "../build/api/upgrade.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import { runSpec } from "../build/mcp/define.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withFetch,
} from "./helpers.js";

baselineEnv();

const UPG = "1".repeat(32);
const BR = `sys_script_${"a".repeat(32)}`;

/** A sys_script update payload with a CDATA script. */
const payload = (script, extra = "") =>
  `<?xml version="1.0" encoding="UTF-8"?><record_update table="sys_script"><sys_script action="INSERT_OR_UPDATE"><name>Close child tasks</name><script><![CDATA[${script}]]></script>${extra}<sys_updated_on>2026-01-01 00:00:00</sys_updated_on></sys_script></record_update>`;

function tables(over = {}) {
  return (url) => {
    const u = new URL(url);
    const table = u.pathname.split("/").pop();
    if (over[table]) return over[table](u);
    return jsonResponse(404, { error: { message: `Invalid table ${table}` } });
  };
}

test("update names, registry types, dispositions, resolutions", () => {
  assert.equal(tableOfUpdateName(BR), "sys_script");
  assert.equal(tableOfUpdateName("sys_properties_glide.x"), "");
  assert.equal(artifactTypeOfTable("sys_script"), "business_rule");
  assert.equal(artifactTypeOfTable("u_nope"), undefined);
  assert.equal(isSkipDisposition("Skipped Manual Merge"), true);
  assert.equal(isSkipDisposition("Inserted"), false);
  assert.equal(isResolved("Reviewed Retained"), true);
  assert.equal(isResolved("Not Reviewed"), false);
  assert.equal(isResolved(""), false);
});

test("payload fields drop the volatile system fields and keep CDATA", () => {
  const f = payloadFields(payload("if (a < b) go();"));
  assert.deepEqual(f, {
    name: "Close child tasks",
    script: "if (a < b) go();",
  });
  assert.equal(payloadFields("<unload/>"), undefined);
});

test("classification: the three outcomes and unknown", () => {
  const v = (script) => ({ name: "x", script });
  assert.equal(
    classifySkip(v("b1"), v("c"), v("b0")).classification,
    "both_changed",
  );
  assert.equal(
    classifySkip(v("b0"), v("c"), v("b0")).classification,
    "only_customer_changes",
  );
  assert.equal(
    classifySkip(v("b1"), v("b0"), v("b0")).classification,
    "only_base_changes",
  );
  assert.equal(
    classifySkip(v("b1"), v("b1"), undefined).classification,
    "only_base_changes",
  );
  assert.equal(
    classifySkip(v("b1"), v("c"), undefined).classification,
    "unknown",
  );
  assert.equal(
    classifySkip(undefined, v("c"), v("b0")).classification,
    "unknown",
  );
});

test("history: newest first, rendered as a table", async () => {
  freshRuntime();
  await withFetch(
    tables({
      sys_upgrade_history: () =>
        jsonResponse(200, {
          result: [
            {
              sys_id: UPG,
              from_version: "glide-xanadu",
              to_version: "glide-yokohama",
              upgrade_started: "2026-09-01 00:00:00",
              upgrade_finished: "2026-09-01 02:00:00",
              state: "complete",
            },
          ],
        }),
    }),
    async (calls) => {
      const h = await readUpgradeHistory();
      assert.equal(h.available, true);
      assert.equal(h.upgrades[0].toVersion, "glide-yokohama");
      assert.match(
        new URL(calls[0].url).searchParams.get("sysparm_query"),
        /ORDERBYDESCupgrade_started/,
      );
      const md = renderUpgradeHistory(h).join("\n");
      assert.match(md, /\| glide-xanadu \| glide-yokohama \|/);
      assert.match(md, /unverified until O-5/);
    },
  );
});

test("skipped: unresolved skips grouped by application and artefact type", async () => {
  freshRuntime();
  const row = (file_name, application, disposition, resolution_status) => ({
    sys_id: file_name.slice(-4),
    file_name,
    target_name: file_name,
    application,
    disposition,
    resolution_status,
  });
  await withFetch(
    tables({
      sys_upgrade_history_log: () =>
        jsonResponse(200, {
          result: [
            row(BR, "Global", "Skipped", "Not Reviewed"),
            row(
              `sys_script_${"b".repeat(32)}`,
              "Global",
              "Skipped Manual Merge",
              "",
            ),
            row(
              `sys_script_include_${"c".repeat(32)}`,
              "Global",
              "Skipped",
              "",
            ),
            row(`u_custom_${"d".repeat(32)}`, "", "Skipped", ""),
            row(
              `sys_script_${"e".repeat(32)}`,
              "Global",
              "Skipped",
              "Reviewed Merged",
            ),
            row(`sys_script_${"f".repeat(32)}`, "Global", "Inserted", ""),
          ],
        }),
    }),
    async (calls) => {
      const s = await readSkipped(UPG);
      assert.equal(s.available, true);
      assert.equal(s.scanned, 6);
      assert.equal(s.skipped, 4);
      assert.deepEqual(
        s.groups.map((g) => [g.application, g.artifactType, g.count]),
        [
          ["(unknown application)", "u_custom", 1],
          ["Global", "business_rule", 2],
          ["Global", "script_include", 1],
        ],
      );
      const q = new URL(calls[0].url).searchParams;
      assert.equal(
        q.get("sysparm_query"),
        `upgrade_history=${UPG}^ORDERBYfile_name`,
      );
      assert.equal(q.get("sysparm_display_value"), "true");
      const md = renderSkipped(s).join("\n");
      assert.match(md, /4 unresolved skipped record\(s\) of 6 log row\(s\)/);
      assert.match(md, /### Global — business_rule/);
    },
  );
  const bad = await readSkipped("x^ORsys_id!=");
  assert.equal(bad.available, false);
});

test("record: new base, old base and customer version with a diff", async () => {
  freshRuntime();
  const version = (sys_id, recorded, source_table, state, script) => ({
    sys_id,
    name: BR,
    state,
    source_table,
    source: source_table,
    sys_recorded_at: recorded,
    payload: payload(script),
  });
  await withFetch(
    tables({
      sys_update_version: () =>
        jsonResponse(200, {
          result: [
            version(
              "v4",
              "2026-09-01 01:00:00",
              "sys_upgrade_history",
              "previous",
              "base();\nnewBase();",
            ),
            version(
              "v3",
              "2025-05-01 00:00:00",
              "sys_update_set",
              "current",
              "base();\ncustomer();",
            ),
            version(
              "v1",
              "2024-01-01 00:00:00",
              "sys_upgrade_history",
              "previous",
              "base();",
            ),
          ],
        }),
    }),
    async () => {
      const r = await reviewSkippedRecord(BR);
      assert.equal(r.available, true);
      assert.equal(r.classification, "both_changed");
      assert.equal(r.newBase.sys_id, "v4");
      assert.equal(r.oldBase.sys_id, "v1");
      assert.equal(r.customer.sys_id, "v3");
      assert.deepEqual(
        r.diffs.map((d) => d.field),
        ["script"],
      );
      assert.match(r.diffs[0].diff, /^--- base\/script/);
      assert.match(r.diffs[0].diff, /-newBase\(\);/);
      assert.match(r.diffs[0].diff, /\+customer\(\);/);
    },
  );
});

test("unreadable upgrade tables degrade to unavailable", async () => {
  freshRuntime();
  await withFetch(
    () => jsonResponse(403, { error: { message: "denied" } }),
    async () => {
      const h = await readUpgradeHistory();
      assert.equal(h.available, false);
      assert.match(h.unavailableReason, /sys_upgrade_history is not readable/);
      assert.match(renderUpgradeHistory(h).join("\n"), /^Unavailable:/);
      const s = await readSkipped(UPG);
      assert.match(
        s.unavailableReason,
        /sys_upgrade_history_log is not readable/,
      );
      const r = await reviewSkippedRecord(BR);
      assert.match(r.unavailableReason, /sys_update_version is not readable/);
    },
  );
  assert.equal((await reviewSkippedRecord("nope")).available, false);
  assert.deepEqual(groupSkipped([]), []);
});

test("store updates: apps with an update and their customised artefacts", async () => {
  freshRuntime();
  const APP = "2".repeat(32);
  const CLEAN = "3".repeat(32);
  await withFetch(
    tables({
      sys_store_app: () =>
        jsonResponse(200, {
          result: [
            {
              sys_id: APP,
              name: "HR Service Delivery",
              scope: "sn_hr_core",
              version: "5.0.1",
              latest_version: "6.0.0",
            },
            {
              sys_id: CLEAN,
              name: "Clean App",
              scope: "sn_clean",
              version: "1.0.0",
              latest_version: "1.1.0",
            },
          ],
        }),
      sys_update_xml: (u) => {
        const q = u.searchParams.get("sysparm_query");
        if (q.startsWith(`application=${CLEAN}`)) {
          return jsonResponse(200, { result: [] });
        }
        return jsonResponse(200, {
          result: [
            { name: BR, target_name: "Close child tasks" },
            { name: BR, target_name: "Close child tasks" },
            { name: `sys_script_${"b".repeat(32)}`, target_name: "Other" },
            {
              name: `sys_script_include_${"c".repeat(32)}`,
              target_name: "HRUtils",
            },
            { name: `u_custom_${"d".repeat(32)}`, target_name: "x" },
          ],
        });
      },
    }),
    async (calls) => {
      const s = await readStoreUpdates();
      assert.equal(s.available, true);
      assert.equal(s.apps.length, 2);
      const hr = s.apps[0];
      assert.equal(hr.latestVersion, "6.0.0");
      assert.equal(hr.customisations.length, 4);
      assert.deepEqual(hr.byType, [
        { artifactType: "business_rule", count: 2 },
        { artifactType: "script_include", count: 1 },
        { artifactType: "u_custom", count: 1 },
      ]);
      assert.deepEqual(s.apps[1].customisations, []);
      assert.equal(
        new URL(calls[0].url).searchParams.get("sysparm_query"),
        "active=true^update_available=true^ORDERBYname",
      );
      const md = renderStoreUpdates(s).join("\n");
      assert.match(
        md,
        /\| HR Service Delivery \| sn_hr_core \| 5\.0\.1 \| 6\.0\.0 \| 4 \|/,
      );
      assert.match(md, /### Clean App\n\n_No customised artefacts/);
      assert.match(md, /unverified until O-5/);
    },
  );
});

test("store updates degrade: unreadable store table or scope updates", async () => {
  freshRuntime();
  await withFetch(
    () => jsonResponse(403, { error: { message: "denied" } }),
    async () => {
      const s = await readStoreUpdates();
      assert.equal(s.available, false);
      assert.match(s.unavailableReason, /sys_store_app is not readable/);
      assert.match(renderStoreUpdates(s).join("\n"), /^Unavailable:/);
    },
  );
  await withFetch(
    tables({
      sys_store_app: () =>
        jsonResponse(200, {
          result: [
            {
              sys_id: "4".repeat(32),
              name: "App",
              scope: "x_app",
              version: "1",
              latest_version: "2",
            },
            { sys_id: "bad", name: "Bad", scope: "x_bad" },
          ],
        }),
    }),
    async () => {
      const s = await readStoreUpdates();
      assert.equal(s.available, true);
      assert.match(
        s.apps[0].customisations.unavailableReason,
        /sys_update_xml does not exist/,
      );
      assert.match(
        s.apps[1].customisations.unavailableReason,
        /not a store app/,
      );
      const md = renderStoreUpdates(s).join("\n");
      assert.match(md, /\| App \| x_app \| 1 \| 2 \| \? \|/);
    },
  );
  freshRuntime();
  await withFetch(
    tables({ sys_store_app: () => jsonResponse(200, { result: [] }) }),
    async () => {
      assert.match(
        renderStoreUpdates(await readStoreUpdates()).join("\n"),
        /No store app has an update available/,
      );
    },
  );
});

const tool = ALL_TOOLS.find((t) => t.name === "servicenow_review_upgrade");

/** The table each request of one tool call read, in order. */
const tablesRead = (calls) =>
  calls.map((c) => new URL(c.url).pathname.split("/").pop());

test("N-1: review_upgrade is a read tool in the opt-in instance package", () => {
  assert.ok(tool);
  assert.equal(tool.package, "instance");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
});

test("N-1: the history view is the default, as structured content", async () => {
  freshRuntime();
  await withFetch(
    tables({
      sys_upgrade_history: () =>
        jsonResponse(200, {
          result: [{ sys_id: UPG, to_version: "glide-yokohama" }],
        }),
    }),
    async (calls) => {
      const res = await runSpec(tool, {});
      assert.equal(res.isError, undefined);
      assert.equal(res.structuredContent.available, true);
      assert.equal(
        res.structuredContent.upgrades[0].toVersion,
        "glide-yokohama",
      );
      assert.deepEqual(JSON.parse(res.content[0].text), res.structuredContent);
      assert.deepEqual(tablesRead(calls), ["sys_upgrade_history"]);
    },
  );
});

test("N-1: upgrade, update_name and store_updates pick their view", async () => {
  freshRuntime();
  await withFetch(
    () => jsonResponse(403, { error: { message: "denied" } }),
    async (calls) => {
      const skipped = await runSpec(tool, { upgrade: UPG });
      assert.match(
        skipped.structuredContent.unavailableReason,
        /sys_upgrade_history_log/,
      );
      const record = await runSpec(tool, { update_name: BR, upgrade: UPG });
      assert.match(
        record.structuredContent.unavailableReason,
        /sys_update_version/,
      );
      const store = await runSpec(tool, { store_updates: true });
      assert.equal(store.structuredContent.available, false);
      assert.ok(tablesRead(calls).includes("sys_store_app"));
    },
  );
});

test("N-1: the upgrade document holds the history, the newest upgrade's skips and the store updates", async () => {
  freshRuntime();
  const { generateDocument } = await import("../build/api/document.js");
  await withFetch(
    tables({
      sys_upgrade_history: () =>
        jsonResponse(200, {
          result: [
            {
              sys_id: UPG,
              from_version: "glide-xanadu",
              to_version: "glide-yokohama",
              state: "Complete",
            },
          ],
        }),
      sys_upgrade_history_log: () =>
        jsonResponse(200, {
          result: [
            {
              sys_id: "a1",
              file_name: BR,
              target_name: BR,
              application: "Global",
              disposition: "Skipped",
              resolution_status: "Not Reviewed",
            },
          ],
        }),
      sys_store_app: () => jsonResponse(200, { result: [] }),
    }),
    async (calls) => {
      const doc = await generateDocument("upgrade", "upgrade", {
        write: false,
      });
      assert.match(doc.path, /\/upgrade\.md$/);
      assert.match(doc.markdown, /^# Upgrade readiness — profile /m);
      assert.match(doc.markdown, /^## Skipped records — `glide-yokohama`$/m);
      assert.match(doc.markdown, /business_rule/);
      assert.match(doc.markdown, /^## Store app updates$/m);
      assert.match(doc.markdown, /review_upgrade with update_name/);
      assert.ok(
        calls.some((c) =>
          decodeURIComponent(c.url).includes(`upgrade_history=${UPG}`),
        ),
      );
    },
  );
});

test("N-1: an unreadable instance degrades every upgrade section", async () => {
  freshRuntime();
  const { generateDocument } = await import("../build/api/document.js");
  await withFetch(
    () => jsonResponse(403, { error: { message: "denied" } }),
    async () => {
      const doc = await generateDocument("upgrade", "upgrade", {
        write: false,
      });
      assert.match(doc.markdown, /^## Skipped records$/m);
      assert.match(doc.markdown, /_No upgrade to review\._/);
      assert.match(doc.markdown, /Unavailable:/);
    },
  );
});
