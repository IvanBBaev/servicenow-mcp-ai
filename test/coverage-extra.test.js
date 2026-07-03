import test from "node:test";
import assert from "node:assert/strict";

import { testConnection } from "../build/api/diagnostics.js";
import { checkCapabilities } from "../build/api/capabilities.js";
import { resultSysId } from "../build/mcp/write-mode.js";
import { whereUsed } from "../build/api/whereused.js";
import { generateErDiagram } from "../build/api/diagrams.js";
import { buildStatusPayload, profilesPayload } from "../build/mcp/status.js";
import { appendWriteJournal } from "../build/core/write-journal.js";
import { snRequest } from "../build/core/http.js";
import { lintSource } from "../build/api/codecheck.js";
import { redactRecords } from "../build/mcp/redact.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

test("resultSysId handles missing / string / nested / invalid sys_id", () => {
  assert.equal(resultSysId(null), undefined);
  assert.equal(resultSysId({}), undefined);
  assert.equal(resultSysId({ sys_id: "abc" }), "abc");
  assert.equal(resultSysId({ sys_id: { value: "xyz" } }), "xyz");
  assert.equal(resultSysId({ sys_id: { value: 5 } }), undefined);
  assert.equal(resultSysId({ sys_id: 42 }), undefined);
});

test("testConnection returns ok:false with the status on a ServiceNow error", async () => {
  await withFetch(
    () => jsonResponse(401, { error: { message: "auth" } }),
    async () => {
      const r = await testConnection();
      assert.equal(r.ok, false);
      assert.equal(r.status, 401);
    },
  );
});

test("checkCapabilities records 401 and 404 reasons per table (DF-0)", async () => {
  await withFetch(
    (url) => {
      const seg = new URL(url).pathname.split("/").pop();
      if (seg === "sys_security_acl") {
        return jsonResponse(401, { error: { message: "x" } });
      }
      if (seg === "sys_ws_operation") {
        return jsonResponse(404, { error: { message: "x" } });
      }
      return jsonResponse(200, { result: [{ sys_id: "1" }] });
    },
    async () => {
      const r = await checkCapabilities();
      const acl = r.probed.find((p) => p.table === "sys_security_acl");
      assert.equal(acl.status, 401);
      assert.match(acl.reason, /authentication/);
      const ws = r.probed.find((p) => p.table === "sys_ws_operation");
      assert.equal(ws.status, 404);
      assert.match(ws.reason, /not present/);
    },
  );
});

test("status payload reports '(not set)' for an unconfigured profile", async () => {
  await withEnv(
    { SN_INSTANCE: undefined, SN_USER: undefined, SN_PASSWORD: undefined },
    () => {
      const s = buildStatusPayload();
      assert.equal(s.instance, "(not set)");
      assert.equal(s.user, "(not set)");
      assert.ok(Array.isArray(profilesPayload().profiles));
    },
  );
});

test("whereUsed(script) builds a mermaid graph from references (DF-4)", async () => {
  await withFetch(
    (url) => {
      const seg = new URL(url).pathname.split("/").pop();
      if (seg === "sys_script_include") {
        return jsonResponse(200, {
          result: [{ sys_id: "si1", name: "MyUtil", script: "MyUtil.run()" }],
        });
      }
      return jsonResponse(200, { result: [] });
    },
    async () => {
      const r = await whereUsed("script", "MyUtil", { mermaid: true });
      assert.equal(r.kind, "script");
      assert.match(r.mermaid, /graph LR/);
    },
  );
});

test("generateErDiagram rejects an empty table list", async () => {
  await assert.rejects(generateErDiagram([]), /at least one table/);
});

test("appendWriteJournal never throws on a bad docs dir (best-effort)", async () => {
  // A path under a file makes mkdir fail; the journal must still not throw.
  await withEnv({ SN_DOCS_DIR: "/dev/null/nope" }, () => {
    const entry = appendWriteJournal({
      action: "create",
      table: "incident",
      sys_id: "x",
    });
    assert.equal(entry.action, "create");
  });
});

test("snRequest fails clearly when no instance is configured", async () => {
  await withEnv({ SN_INSTANCE: undefined }, async () => {
    await assert.rejects(
      snRequest({ method: "GET", path: "/api/now/table/x" }),
      /not configured/,
    );
  });
});

test("snRequest joins params with & when the path already carries a query string", async () => {
  await withFetch(
    (url) => {
      assert.equal(
        url,
        "https://dev00000.service-now.com/api/now/table/incident?sysparm_query=active%3Dtrue&sysparm_limit=1",
      );
      return jsonResponse(200, { result: [] });
    },
    async () => {
      await snRequest({
        method: "GET",
        path: "/api/now/table/incident?sysparm_query=active%3Dtrue",
        params: new URLSearchParams({ sysparm_limit: "1" }),
      });
    },
  );
});

test("snRequest maps a timeout and a transport error to clear messages", async () => {
  await withFetch(
    () => {
      const e = new Error("t");
      e.name = "TimeoutError";
      throw e;
    },
    async () => {
      await assert.rejects(
        snRequest({ method: "GET", path: "/api/now/table/x" }),
        /timed out/,
      );
    },
  );
  await withFetch(
    () => {
      throw new TypeError("network down");
    },
    async () => {
      await assert.rejects(
        snRequest({ method: "GET", path: "/api/now/table/x" }),
        /Could not reach/,
      );
    },
  );
});

test("lintSource flags the remaining server and client rules", () => {
  const server = lintSource(
    "gs.sleep(1000); setWorkflow(false); current.update(); var u='https://dev1.service-now.com';",
    "server",
  );
  const sr = server.map((f) => f.rule);
  assert.ok(sr.includes("gs-sleep"));
  assert.ok(sr.includes("set-workflow-false"));
  assert.ok(sr.includes("current-update-in-br"));
  assert.ok(sr.includes("hardcoded-instance-url"));

  const client = lintSource(
    "var gr = new GlideRecord('x'); var r = g.getReference('u');",
    "client",
  );
  const cr = client.map((f) => f.rule);
  assert.ok(cr.includes("gr-on-client"));
  assert.ok(cr.includes("sync-get-reference"));
});

test("redactRecords masks both named fields and PII together", async () => {
  await withEnv({ SN_REDACT_FIELDS: "ssn", SN_REDACT_PII: "true" }, () => {
    const r = redactRecords([
      { ssn: "123456789", note: "mail me at a@b.com", ref: { value: "x" } },
    ]);
    assert.equal(r.records[0].ssn, "[redacted]");
    assert.equal(r.records[0].note.includes("a@b.com"), false);
    assert.ok(r.redacted >= 2);
  });
});
