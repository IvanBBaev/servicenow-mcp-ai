// N-3 — Instance Scan read: latest result, findings by artefact type, "both agree";
// phase D run through the CI/CD API behind the ATF rails.
import test from "node:test";
import assert from "node:assert/strict";

import {
  agreedFindings,
  artifactTypeForTable,
  readInstanceScan,
  renderInstanceScan,
  runInstanceScan,
  scanRunRequest,
  waitForInstanceScan,
} from "../build/api/instance-scan.js";
import { ServiceNowError } from "../build/core/errors.js";
import { runWithCall } from "../build/core/request-context.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
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

// --- run (phase D) ---------------------------------------------------------

const started = (id) =>
  jsonResponse(200, {
    result: {
      status: "0",
      status_label: "Pending",
      percent_complete: 0,
      links: { progress: { id, url: `https://x/api/sn_cicd/progress/${id}` } },
    },
  });

test("scanRunRequest maps each target to its CI/CD path", () => {
  assert.deepEqual(scanRunRequest({ kind: "full" }), {
    path: "/api/sn_cicd/instance_scan/full_scan",
  });
  const point = scanRunRequest({
    kind: "point",
    table: "sys_script",
    sysId: "br1",
  });
  assert.equal(point.path, "/api/sn_cicd/instance_scan/point_scan");
  assert.equal(
    point.params.toString(),
    "target_table=sys_script&target_sys_id=br1",
  );
  assert.deepEqual(scanRunRequest({ kind: "suite", suiteSysId: "a/b" }), {
    path: "/api/sn_cicd/instance_scan/suite_scan/a%2Fb",
  });
  assert.throws(() =>
    scanRunRequest({ kind: "point", table: "a^b", sysId: "x" }),
  );
});

test("runInstanceScan POSTs the scan and returns the progress id", async () => {
  freshRuntime();
  await withFetch(
    () => started("p1"),
    async (calls) => {
      const run = await runInstanceScan({
        kind: "point",
        table: "sys_script",
        sysId: "br1",
      });
      assert.equal(run.executionId, "p1");
      assert.equal(run.statusLabel, "Pending");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].init.method, "POST");
      const url = new URL(calls[0].url);
      assert.equal(url.pathname, "/api/sn_cicd/instance_scan/point_scan");
      assert.equal(url.searchParams.get("target_table"), "sys_script");
      await runInstanceScan({ kind: "full" });
      assert.match(calls[1].url, /\/instance_scan\/full_scan$/);
    },
  );
});

test("runInstanceScan is refused in read-only mode and on a denied table", async () => {
  freshRuntime();
  await withFetch(
    () => started("p1"),
    async (calls) => {
      await withEnv({ SN_READONLY: "true" }, () =>
        assert.rejects(
          runInstanceScan({ kind: "full" }),
          (err) => err instanceof ServiceNowError && err.status === 403,
        ),
      );
      await withEnv({ SN_TABLES_DENY: "sys_script" }, () =>
        assert.rejects(
          runInstanceScan({ kind: "point", table: "sys_script", sysId: "x" }),
          (err) => err instanceof ServiceNowError && err.status === 403,
        ),
      );
      await withEnv({ SN_TABLES_DENY: "scan_result" }, () =>
        assert.rejects(
          runInstanceScan({ kind: "suite", suiteSysId: "s1" }),
          (err) => err instanceof ServiceNowError && err.status === 403,
        ),
      );
      assert.equal(calls.length, 0);
    },
  );
});

test("an inactive sn_cicd plugin is reported clearly", async () => {
  freshRuntime();
  await withFetch(
    () =>
      jsonResponse(404, {
        error: { message: "Requested URI does not represent any resource" },
      }),
    async () => {
      await assert.rejects(
        runInstanceScan({ kind: "full" }),
        (err) =>
          err instanceof ServiceNowError &&
          err.status === 404 &&
          /may not be active/i.test(err.message),
      );
    },
  );
});

test("waitForInstanceScan polls progress until the scan finishes", async () => {
  freshRuntime();
  const updates = [];
  let n = 0;
  await withFetch(
    (url) => {
      assert.match(url, /\/api\/sn_cicd\/progress\/p1$/);
      n += 1;
      return jsonResponse(200, {
        result:
          n < 2
            ? { status: "1", percent_complete: 40 }
            : {
                status: "2",
                status_label: "Successful",
                percent_complete: 100,
              },
      });
    },
    async () => {
      const res = await runWithCall(
        { requestId: "r1", tool: "t", progress: (u) => updates.push(u) },
        () => waitForInstanceScan({ executionId: "p1", status: "0" }, 5000, 1),
      );
      assert.equal(res.wait.state, "finished");
      assert.equal(res.wait.polls, 2);
      assert.equal(res.statusLabel, "Successful");
    },
  );
  assert.equal(updates[0].message, "Instance scan in progress");
  assert.equal(updates[1].message, "Successful");
});

// --- run through check_code_health (scan_run) -------------------------------

const healthTool = (await import("../build/tools/codecheck.js")).specs.find(
  (s) => s.name === "servicenow_check_code_health",
);
const out = (res) => JSON.parse(res.content[0].text);

test("check_code_health scan_run previews by default and calls nothing", async () => {
  freshRuntime();
  await withFetch(
    () => started("p1"),
    async (calls) => {
      const o = out(
        await healthTool.handler({
          scan_run: "point",
          scope: "sys_script",
          sys_id: "br1",
        }),
      );
      assert.equal(o.mode, "plan");
      assert.equal(o.action, "execute");
      assert.equal(o.table, "scan_result");
      assert.equal(o.sys_id, "br1");
      assert.equal(o.scope, "sys_script");
      assert.ok(o.generatedAt);
      assert.deepEqual(o.warnings, []);
      assert.equal(calls.length, 0);
    },
  );
});

test("check_code_health scan_run with apply starts the scan and journals it", async () => {
  freshRuntime();
  await withFetch(
    () => started("p9"),
    async (calls) => {
      const o = out(
        await healthTool.handler({
          scan_run: "suite",
          sys_id: "su1",
          apply: true,
        }),
      );
      assert.equal(o.executionId, "p9");
      assert.equal(o.scope, "instance");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].init.method, "POST");
      assert.match(calls[0].url, /\/instance_scan\/suite_scan\/su1$/);
      const full = out(
        await healthTool.handler({ scan_run: "full", apply: true }),
      );
      assert.equal(full.executionId, "p9");
      assert.match(calls[1].url, /\/instance_scan\/full_scan$/);
    },
  );
});

test("check_code_health scan_run refuses a target without its sys_id or table", async () => {
  freshRuntime();
  await withFetch(
    () => started("p1"),
    async (calls) => {
      for (const args of [
        { scan_run: "point", sys_id: "br1" },
        { scan_run: "point", scope: "sys_script" },
        { scan_run: "suite", apply: true },
        { scan_run: "suite", sys_id: "a b", apply: true },
      ]) {
        await assert.rejects(
          () => healthTool.handler(args),
          (e) =>
            e instanceof ServiceNowError &&
            e.code === "INVALID_INPUT" &&
            /needs|must be a sys_id/.test(e.message),
        );
      }
      assert.equal(calls.length, 0);
    },
  );
});

test("check_code_health scan_run with apply is refused in read-only mode", async () => {
  freshRuntime();
  await withFetch(
    () => started("p1"),
    async (calls) => {
      await withEnv({ SN_READONLY: "true" }, () =>
        assert.rejects(
          healthTool.handler({ scan_run: "full", apply: true }),
          (err) => err instanceof ServiceNowError && err.status === 403,
        ),
      );
      assert.equal(calls.length, 0);
    },
  );
});

test("an Instance Scan is refused on a prod-marked profile, plan and apply", async () => {
  freshRuntime();
  const prodRefusal = (err) =>
    err instanceof ServiceNowError &&
    err.status === 403 &&
    err.code === "POLICY_DENIED" &&
    /marked prod \(SN_ENV\)/.test(err.message);
  await withFetch(
    () => started("p1"),
    async (calls) => {
      await withEnv(
        {
          SN_ENV: "prod",
          SN_WRITE_MODE: "apply",
          SN_PROD_WRITES: "I_UNDERSTAND",
        },
        async () => {
          await assert.rejects(runInstanceScan({ kind: "full" }), prodRefusal);
          await assert.rejects(
            healthTool.handler({ scan_run: "full" }),
            prodRefusal,
          );
          await assert.rejects(
            healthTool.handler({
              scan_run: "suite",
              sys_id: "su1",
              apply: true,
            }),
            prodRefusal,
          );
        },
      );
      assert.equal(calls.length, 0);
      await withEnv({ SN_ENV: "test" }, async () => {
        await runInstanceScan({ kind: "full" });
      });
      assert.equal(calls.length, 1);
    },
  );
});
