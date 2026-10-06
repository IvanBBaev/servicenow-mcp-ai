import assert from "node:assert/strict";
import { test } from "node:test";
import { SERVER_SPEC } from "../config";
import { extractJson, serverLaunch, summarizeDoctor } from "../doctor";

const report = {
  envFile: { path: "/home/ada/.config/servicenow-mcp-ai/.env", exists: true },
  status: "degraded",
  summary: "Connected, but 2 capabilities are missing",
  checks: [
    { name: "credentials", ok: true, detail: 'profile "default" (basic)' },
    { name: "connectivity", ok: true, detail: "HTTP 200 in 120ms" },
    { name: "capabilities", ok: false, detail: "sys_script unreadable" },
  ],
  config: { configured: true, warnings: ["token expires in 3 h"] },
  serverStatus: {},
};

test("serverLaunch pins the server major (D-6) and needs a shell only on win32", () => {
  assert.match(SERVER_SPEC, /^servicenow-mcp-ai@\d+\.x$/);
  assert.deepEqual(serverLaunch([], "linux"), {
    command: "npx",
    args: ["-y", SERVER_SPEC],
    shell: false,
  });
  assert.deepEqual(serverLaunch(["doctor", "--json"], "win32"), {
    command: "npx",
    args: ["-y", SERVER_SPEC, "doctor", "--json"],
    shell: true,
  });
});

test("extractJson tolerates npx notices before the document", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('npm warn exec something\n{\n  "a": 1\n}\n'), {
    a: 1,
  });
  assert.equal(extractJson(""), undefined);
  assert.equal(extractJson("no json here"), undefined);
});

test("summarizeDoctor reads status, checks, env file and warnings", () => {
  const s = summarizeDoctor({
    stdout: JSON.stringify(report, null, 2),
    stderr: "",
    exitCode: 1,
  });
  assert.equal(s.status, "degraded");
  assert.equal(s.headline, `ServiceNow doctor: ${report.summary}`);
  assert.equal(s.checks.length, 3);
  assert.deepEqual(s.envFile, report.envFile);
  assert.deepEqual(s.warnings, ["token expires in 3 h"]);
  assert.match(s.text, /^Status: degraded$/m);
  assert.match(s.text, /\[x\] capabilities: sys_script unreadable/);
  assert.match(s.text, /\[ok\] connectivity: HTTP 200 in 120ms/);
  assert.match(s.text, /warning: token expires in 3 h/);
});

test("summarizeDoctor handles a not-configured report with sparse fields", () => {
  const s = summarizeDoctor({
    stdout: JSON.stringify({
      status: "not_configured",
      checks: [{ name: "credentials", ok: false }, "junk", { ok: true }],
    }),
    stderr: "",
    exitCode: 2,
  });
  assert.equal(s.status, "not_configured");
  assert.deepEqual(s.checks, [{ name: "credentials", ok: false, detail: "" }]);
  assert.equal(s.envFile, undefined);
  assert.deepEqual(s.warnings, []);
});

test("summarizeDoctor reports an error without a usable report", () => {
  const failed = summarizeDoctor({
    stdout: "",
    stderr: "npm ERR! 404 Not Found\nnpm ERR! could not resolve",
    exitCode: 1,
  });
  assert.equal(failed.status, "error");
  assert.equal(failed.headline, "Doctor failed: npm ERR! could not resolve");
  assert.match(failed.text, /exit 1/);

  const odd = summarizeDoctor({
    stdout: JSON.stringify({ status: "weird" }),
    stderr: "",
    exitCode: 0,
  });
  assert.equal(odd.status, "error");
  assert.match(odd.headline, /exit code 0 without a JSON report/);

  const killed = summarizeDoctor({ stdout: "", stderr: "", exitCode: null });
  assert.match(killed.headline, /did not exit normally/);
});
