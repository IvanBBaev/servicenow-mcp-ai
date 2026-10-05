// N-3 — Instance Scan read: latest result, findings by artefact type, "both agree".
import test from "node:test";
import assert from "node:assert/strict";

import {
  agreedFindings,
  artifactTypeForTable,
  readInstanceScan,
  renderInstanceScan,
} from "../build/api/instance-scan.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withFetch,
} from "./helpers.js";

baselineEnv();

const FINDINGS = [
  {
    "check.name": "Avoid eval",
    "check.priority": "1",
    "check.category": "security",
    source_table: "sys_script",
    source: "br1",
  },
  {
    "check.name": "No current.update in BR",
    "check.priority": "2",
    source_table: "sys_script",
    source: "br1",
  },
  {
    "check.name": "Something custom",
    "check.priority": "3",
    source_table: "u_custom",
    source: "x9",
  },
];

test("source tables map to registry artefact types", () => {
  assert.equal(artifactTypeForTable("sys_script"), "business_rule");
  assert.equal(artifactTypeForTable("sys_script_include"), "script_include");
  assert.equal(artifactTypeForTable("u_custom"), undefined);
});

test("agreedFindings groups the checks per record our lint also flags", () => {
  const findings = [
    { check: "A", priority: "1", table: "sys_script", sys_id: "s1" },
    { check: "B", priority: "2", table: "sys_script", sys_id: "s1" },
    { check: "A", priority: "1", table: "sys_script", sys_id: "s1" },
    { check: "C", priority: "1", table: "sys_script", sys_id: "s2" },
  ];
  assert.deepEqual(agreedFindings(findings, new Set(["s1"])), [
    { table: "sys_script", sys_id: "s1", checks: ["A", "B"] },
  ]);
  assert.deepEqual(agreedFindings(findings, new Set()), []);
});

test("readInstanceScan reads the latest result, then its findings", async () => {
  freshRuntime();
  await withFetch(
    (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/scan_result")) {
        assert.equal(u.searchParams.get("sysparm_limit"), "1");
        assert.match(
          u.searchParams.get("sysparm_query"),
          /ORDERBYDESCsys_created_on/,
        );
        return jsonResponse(200, {
          result: [
            {
              sys_id: "r1",
              sys_created_on: "2026-10-01 10:00:00",
              state: "complete",
            },
          ],
        });
      }
      assert.ok(u.pathname.endsWith("/scan_finding"));
      assert.equal(u.searchParams.get("sysparm_query"), "result=r1");
      return jsonResponse(200, { result: FINDINGS });
    },
    async (calls) => {
      const r = await readInstanceScan(new Set(["br1"]));
      assert.equal(calls.length, 2);
      assert.equal(r.available, true);
      assert.equal(r.result.sys_id, "r1");
      assert.equal(r.findingCount, 3);
      assert.equal(r.capped, false);
      assert.deepEqual(r.byPriority, { 1: 1, 2: 1, 3: 1 });
      assert.deepEqual(r.byArtifactType, {
        business_rule: 2,
        "(unregistered)": 1,
      });
      assert.equal(r.findings[0].category, "security");
      assert.deepEqual(r.agreed, [
        {
          table: "sys_script",
          sys_id: "br1",
          checks: ["Avoid eval", "No current.update in BR"],
        },
      ]);
      const md = renderInstanceScan(r).join("\n");
      assert.match(md, /Latest scan result `r1`/);
      assert.match(
        md,
        /Both agree \(Instance Scan and our lint flag the record\): 1/,
      );
      assert.match(
        md,
        /\| Avoid eval \| 1 \| business_rule \| sys_script \| br1 \|/,
      );
    },
  );
});

test("no scan result falls back to active findings", async () => {
  freshRuntime();
  await withFetch(
    (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/scan_result"))
        return jsonResponse(200, { result: [] });
      assert.equal(u.searchParams.get("sysparm_query"), "active=true");
      return jsonResponse(200, { result: [] });
    },
    async () => {
      const r = await readInstanceScan();
      assert.equal(r.available, true);
      assert.equal(r.result, undefined);
      assert.equal(r.findingCount, 0);
      assert.match(renderInstanceScan(r).join("\n"), /No scan result found/);
    },
  );
});

test("a missing plugin or denied read degrades to unavailable", async () => {
  freshRuntime();
  await withFetch(
    () =>
      jsonResponse(404, { error: { message: "Invalid table scan_result" } }),
    async (calls) => {
      const r = await readInstanceScan();
      assert.equal(calls.length, 1);
      assert.equal(r.available, false);
      assert.match(r.unavailableReason, /scan_result could not be read/);
      assert.match(renderInstanceScan(r).join("\n"), /^Unavailable:/);
    },
  );

  freshRuntime();
  await withFetch(
    (url) =>
      new URL(url).pathname.endsWith("/scan_result")
        ? jsonResponse(200, { result: [{ sys_id: "r1", sys_created_on: "x" }] })
        : jsonResponse(403, { error: { message: "denied" } }),
    async () => {
      const r = await readInstanceScan();
      assert.equal(r.available, false);
      assert.equal(r.result.sys_id, "r1");
      assert.match(r.unavailableReason, /scan_finding could not be read/);
    },
  );
});
