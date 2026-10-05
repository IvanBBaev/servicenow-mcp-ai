// N-23 — least-privilege advice: missing and excess access of the server's
// own account for the enabled packages, in `doctor`.
import test from "node:test";
import assert from "node:assert/strict";

import { advisePrivilege, ELEVATED_ROLES } from "../build/api/privilege.js";
import { formatDoctorReport, runDoctor } from "../build/api/doctor.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withFetch,
} from "./helpers.js";

baselineEnv();

const CORE = ["table", "schema", "aggregate", "attachment"];
const DEVELOPER = [
  "table",
  "schema",
  "aggregate",
  "scripts",
  "flows",
  "codecheck",
  "docs",
];

/** A capability report as checkCapabilities returns it. */
function report({ roles, unreadable = {}, matrix = {} } = {}) {
  const cap = (key) => ({
    achievable: !unreadable[key],
    label: key,
    unlocks: key,
    missing: unreadable[key] ?? [],
  });
  return {
    instance: "https://dev.service-now.com",
    user: "svc_mcp",
    probed: [],
    capabilities: {
      schema_reads: cap("schema_reads"),
      script_intelligence: cap("script_intelligence"),
      acl_audit: cap("acl_audit"),
    },
    degraded: Object.keys(unreadable).length > 0,
    recommendation: "",
    summary: "",
    matrix: {
      ...(roles === undefined
        ? {}
        : roles === null
          ? { roles: { status: "unknown", reason: "rows hidden" } }
          : {
              roles: {
                status: "available",
                detail: {
                  admin: roles.includes("admin"),
                  notable: roles.filter((r) => r in ELEVATED_ROLES),
                  roles,
                },
              },
            }),
      ...matrix,
    },
    sdkManaged: {},
  };
}

test("a read-role account on the core packages: nothing missing, nothing excess", () => {
  const advice = advisePrivilege(
    report({ roles: ["itil", "x_read_role"] }),
    CORE,
  );
  assert.equal(advice.status, "least");
  assert.equal(advice.rolesKnown, true);
  assert.deepEqual(advice.missing, []);
  assert.deepEqual(advice.excess, []);
  assert.deepEqual(advice.packages, [...CORE].sort());
});

test("admin is excess for any package set; security_admin only without codecheck/scripts", () => {
  const held = ["admin", "security_admin", "itil"];
  const core = advisePrivilege(report({ roles: held }), CORE);
  assert.equal(core.status, "advice");
  assert.deepEqual(
    core.excess.map((e) => e.role),
    ["admin", "security_admin"],
  );
  assert.match(core.summary, /excess: admin, security_admin/);

  const dev = advisePrivilege(report({ roles: held }), DEVELOPER);
  assert.deepEqual(
    dev.excess.map((e) => e.role),
    ["admin"],
  );
});

test("a package-specific admin role is justified only while its package is on", () => {
  const held = ["import_admin", "atf_test_admin"];
  assert.deepEqual(
    advisePrivilege(report({ roles: held }), ["table", "importset"]).excess.map(
      (e) => e.role,
    ),
    ["atf_test_admin"],
  );
});

test("unreadable tables are missing only for the packages that need them", () => {
  const r = report({
    roles: ["itil"],
    unreadable: {
      script_intelligence: ["sys_script", "sys_script_include"],
      acl_audit: ["sys_security_acl"],
    },
  });
  assert.equal(advisePrivilege(r, CORE).status, "least");

  const dev = advisePrivilege(r, DEVELOPER);
  assert.equal(dev.status, "advice");
  assert.deepEqual(dev.missing, [
    {
      need: "script_intelligence",
      packages: ["scripts", "flows", "codecheck", "docs"],
      tables: ["sys_script", "sys_script_include"],
      reason: "grant read access to sys_script, sys_script_include",
    },
    {
      need: "acl_audit",
      packages: ["codecheck"],
      tables: ["sys_security_acl"],
      reason: "grant read access to sys_security_acl",
    },
  ]);
});

test("an unavailable matrix group is missing for its enabled package only", () => {
  const r = report({
    roles: [],
    matrix: {
      email: { status: "unavailable", reason: "no access", httpStatus: 403 },
      atf: { status: "unknown" },
      version: { status: "unavailable" },
    },
  });
  assert.deepEqual(advisePrivilege(r, CORE).missing, []);
  assert.deepEqual(advisePrivilege(r, ["email", "atf"]).missing, [
    { need: "email", packages: ["email"], reason: "no access" },
  ]);
});

test("unreadable roles: excess is unknown and the status says so", () => {
  for (const roles of [undefined, null]) {
    const advice = advisePrivilege(report({ roles }), CORE);
    assert.equal(advice.status, "partial");
    assert.equal(advice.rolesKnown, false);
    assert.deepEqual(advice.excess, []);
    assert.match(advice.summary, /excess roles are unknown/);
  }
});

test("doctor adds the privilege section only when given the package set", async () => {
  freshRuntime();
  const instance = (url) =>
    new URL(url).pathname.endsWith("/table/sys_user_has_role")
      ? jsonResponse(200, {
          result: [{ "role.name": "admin" }, { "role.name": "itil" }],
        })
      : jsonResponse(200, { result: [{ sys_id: "1" }] });
  await withFetch(instance, async () => {
    const without = await runDoctor();
    assert.equal(without.privilege, undefined);
    assert.doesNotMatch(formatDoctorReport(without), /Privilege/);

    const r = await runDoctor({ packages: CORE });
    // Informational: an excess role never degrades the verdict.
    assert.equal(r.status, "healthy");
    assert.equal(r.privilege.status, "advice");
    assert.deepEqual(
      r.privilege.excess.map((e) => e.role),
      ["admin"],
    );
    const text = formatDoctorReport(r);
    assert.match(text, /Privilege — excess: admin/);
    assert.match(text, /excess admin: admin bypasses most ACLs/);
  });
});
