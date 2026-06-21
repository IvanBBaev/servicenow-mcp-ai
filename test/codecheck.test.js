import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  lintSource,
  lintScript,
  lintTable,
  codeHealth,
  securityScan,
} from "../build/api/codecheck.js";
import { baselineEnv, withFetch, withEnv, jsonResponse } from "./helpers.js";

baselineEnv();

const rules = (findings) => findings.map((f) => f.rule);

test("lintSource flags hard-coded sys_ids, eval and gs.log (FT-5)", () => {
  const src = [
    "var id = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';",
    "eval('x');",
    "gs.log('hi');",
  ].join("\n");
  const r = rules(lintSource(src, "server"));
  assert.ok(r.includes("hardcoded-sys-id"));
  assert.ok(r.includes("eval-usage"));
  assert.ok(r.includes("gs-log-deprecated"));
});

test("lintSource flags a GlideRecord query inside a loop (FT-5)", () => {
  const src = [
    "for (var i = 0; i < 10; i++) {",
    "  var gr = new GlideRecord('incident');",
    "  gr.addQuery('active', true);",
    "  gr.query();",
    "}",
  ].join("\n");
  assert.ok(rules(lintSource(src, "server")).includes("query-in-loop"));
});

test("lintSource flags an unbounded query and respects a bound one (FT-5)", () => {
  const unbounded = "var gr = new GlideRecord('incident');\ngr.query();";
  assert.ok(rules(lintSource(unbounded)).includes("gr-unbounded-query"));

  const bounded =
    "var gr = new GlideRecord('incident');\ngr.addQuery('active', true);\ngr.query();";
  assert.ok(!rules(lintSource(bounded)).includes("gr-unbounded-query"));
});

test("lintSource scopes client vs server rules (FT-5)", () => {
  const grLine = "var gr = new GlideRecord('incident');";
  assert.ok(rules(lintSource(grLine, "client")).includes("gr-on-client"));
  assert.ok(!rules(lintSource(grLine, "server")).includes("gr-on-client"));
});

test("lintSource reports a syntax error on the server (FT-5)", () => {
  assert.ok(
    rules(lintSource("function ( {", "server")).includes("syntax-error"),
  );
});

test("lintSource returns nothing for clean code (FT-5)", () => {
  assert.deepEqual(lintSource("var x = 1;\ngs.info('ok ' + x);", "server"), []);
});

test("lintScript fetches a business rule and lints its script field (FT-5)", async () => {
  await withFetch(
    (url) => {
      assert.match(url, /\/api\/now\/table\/sys_script\/br1(\?|$)/);
      return jsonResponse(200, {
        result: { name: "Bad BR", script: "eval('danger');" },
      });
    },
    async () => {
      const { results } = await lintScript("business_rule", "br1");
      assert.equal(results.length, 1);
      assert.equal(results[0].field, "script");
      assert.ok(rules(results[0].findings).includes("eval-usage"));
    },
  );
});

test("lintTable lints active scripts of a table via table_logic (FT-5)", async () => {
  await withFetch(
    (url) => {
      const m = /\/api\/now\/table\/([^/?]+)(?:\/([^/?]+))?/.exec(url);
      const table = m?.[1];
      const sysId = m?.[2];
      if (table === "sys_script" && sysId) {
        return jsonResponse(200, {
          result: { name: "BR", script: "gs.sleep(1000);" },
        });
      }
      if (table === "sys_script") {
        // the business-rule listing for tableLogic
        return jsonResponse(200, { result: [{ sys_id: "br1", name: "BR" }] });
      }
      // every other script-type listing in tableLogic returns empty
      return jsonResponse(200, { result: [] });
    },
    async () => {
      const res = await lintTable("incident");
      assert.equal(res.table, "incident");
      assert.ok(res.findingCount >= 1);
      assert.ok(res.bySeverity.warn >= 1);
    },
  );
});

test("codeHealth counts scripts and writes a report (FT-6)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sn-health-"));
  try {
    await withEnv({ SN_DOCS_DIR: dir }, async () => {
      await withFetch(
        (url) => {
          // DF-1: the security scan reads the ACL table.
          if (url.includes("/api/now/table/sys_security_acl")) {
            return jsonResponse(200, { result: [] });
          }
          // every script-type aggregate returns a count
          assert.match(url, /\/api\/now\/stats\//);
          return jsonResponse(200, { result: { stats: { count: "7" } } });
        },
        async () => {
          const health = await codeHealth();
          assert.equal(health.scope, "instance");
          assert.equal(health.scriptCounts.business_rule, 7);
          assert.equal(health.security.available, true);
          assert.ok(health.reportFile.endsWith("code-health.md"));
          assert.ok(existsSync(join(dir, health.reportFile)));
        },
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("securityScan flags eval and side-effects in ACL scripts (DF-1)", async () => {
  await withFetch(
    (url) => {
      assert.match(url, /\/api\/now\/table\/sys_security_acl/);
      return jsonResponse(200, {
        result: [
          {
            sys_id: "a1",
            name: "incident.read",
            operation: "read",
            script: "answer = eval(gs.getProperty('x'));",
            condition: "",
          },
          {
            sys_id: "a2",
            name: "incident.write",
            operation: "write",
            script: "gr.update();",
            condition: "active=true",
          },
        ],
      });
    },
    async () => {
      const scan = await securityScan();
      assert.equal(scan.available, true);
      assert.equal(scan.aclCount, 2);
      const ruleIds = scan.findings.map((f) => f.rule);
      assert.ok(ruleIds.includes("eval-in-acl"));
      assert.ok(ruleIds.includes("gr-write-in-acl"));
      assert.ok(scan.bySeverity.error >= 1);
    },
  );
});

test("securityScan flags a roles-only ACL with no script or condition (DF-1)", async () => {
  await withFetch(
    () =>
      jsonResponse(200, {
        result: [
          {
            sys_id: "a3",
            name: "incident.create",
            operation: "create",
            script: "",
            condition: "",
          },
        ],
      }),
    async () => {
      const scan = await securityScan();
      const f = scan.findings.find((x) => x.rule === "acl-roles-only");
      assert.ok(f);
      assert.equal(f.severity, "info");
    },
  );
});

test("securityScan degrades to available:false when the ACL table is forbidden (DF-1/DF-0)", async () => {
  await withFetch(
    () => jsonResponse(403, { error: { message: "no access" } }),
    async () => {
      const scan = await securityScan();
      assert.equal(scan.available, false);
      assert.match(scan.unavailableReason, /security_admin|admin/);
      assert.equal(scan.findings.length, 0);
    },
  );
});
