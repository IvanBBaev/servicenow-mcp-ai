import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { securityScan, codeHealth } from "../build/api/codecheck.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withMetadataFetch,
  jsonResponse,
} from "./helpers.js";

baselineEnv();

const SEC_ADMIN_ACL = "a".repeat(32);

/** A small instance covering every S-3 finding kind. */
const fixture = () => ({
  sys_security_acl: [
    // eval in the script (DF-1)
    {
      sys_id: "acl1",
      name: "incident",
      operation: "read",
      script: "answer = eval(x);",
      condition: "",
      "type.name": "record",
    },
    // no role, no condition, no script on a write → acl-open (warn)
    {
      sys_id: "acl2",
      name: "x_app_ok",
      operation: "write",
      script: "",
      condition: "",
      "type.name": "record",
    },
    // public role on create → acl-public-role (warn)
    {
      sys_id: "acl3",
      name: "u_child.*",
      operation: "create",
      script: "",
      condition: "",
      "type.name": "record",
    },
    // gated on security_admin (elevated), inherited by a custom role
    {
      sys_id: SEC_ADMIN_ACL,
      name: "sys_properties",
      operation: "write",
      script: "",
      condition: "active=true",
      "type.name": "record",
    },
    // a wildcard ACL (covers nothing specific)
    {
      sys_id: "acl5",
      name: "*",
      operation: "read",
      script: "",
      condition: "",
      "type.name": "record",
    },
    // a non-record ACL does not cover its "table"
    {
      sys_id: "acl6",
      name: "u_orphan",
      operation: "execute",
      script: "",
      condition: "",
      "type.name": "rest_endpoint",
    },
  ],
  sys_security_acl_role: [
    { sys_security_acl: "acl3", "sys_user_role.name": "public" },
    { sys_security_acl: "acl5", "sys_user_role.name": "itil" },
    { sys_security_acl: "acl5", "sys_user_role.name": "itil" }, // duplicate
    { sys_security_acl: SEC_ADMIN_ACL, "sys_user_role.name": "security_admin" },
    { sys_security_acl: "", "sys_user_role.name": "ignored" },
  ],
  sys_user_role_contains: [
    { "role.name": "u_super", "contains.name": "u_mid" },
    { "role.name": "u_mid", "contains.name": "admin" },
    { "role.name": "u_secops", "contains.name": "security_admin" },
    { "role.name": "admin", "contains.name": "security_admin" },
    { "role.name": "itil", "contains.name": "itil" }, // self-loop ignored
    { "role.name": "u_loop_a", "contains.name": "u_loop_b" },
    { "role.name": "u_loop_b", "contains.name": "u_loop_a" },
  ],
  sys_user_role: [{ name: "security_admin" }],
  sys_ws_operation: [
    {
      sys_id: "ws1",
      name: "Get status",
      http_method: "GET",
      operation_uri: "/api/x_app/status",
      "web_service_definition.name": "Status API",
    },
    {
      sys_id: "ws2",
      name: "Hook",
      http_method: "post",
      operation_uri: "",
      "web_service_definition.name": "",
    },
  ],
  sys_public: [
    { sys_id: "p1", page: "x_app_landing.do" },
    { sys_id: "p2", page: "login.do" },
    { sys_id: "p3", page: "" },
  ],
  sys_ui_page: [{ name: "x_app_landing" }],
  sys_db_object: [
    // own ACL
    { sys_id: "t1", name: "x_app_ok", "super_class.name": "" },
    // covered by an ACL on its parent (outside the custom set)
    { sys_id: "t2", name: "x_app_task", "super_class.name": "incident" },
    // covered through a custom parent chain
    { sys_id: "t3", name: "u_grandchild", "super_class.name": "u_child" },
    { sys_id: "t4", name: "u_child", "super_class.name": "" },
    // no ACL anywhere (the rest_endpoint ACL does not count)
    { sys_id: "t5", name: "u_orphan", "super_class.name": "cmdb_ci" },
    { sys_id: "t6", name: "", "super_class.name": "" },
  ],
});

/**
 * Route Table API reads by table. `tables[t]` is an array of rows, or a number
 * (an HTTP status to fail with). Honours sysparm_limit / sysparm_offset and
 * sends X-Total-Count so fetchAll stops cleanly.
 */
const router = (tables) => (url) => {
  const u = new URL(url);
  const m = u.pathname.match(/\/api\/now\/table\/([^/]+)$/);
  if (!m) {
    // script-count aggregates for codeHealth
    return jsonResponse(200, { result: { stats: { count: "1" } } });
  }
  const entry = tables[m[1]];
  if (typeof entry === "number") {
    return jsonResponse(entry, { error: { message: `status ${entry}` } });
  }
  const rows = entry ?? [];
  const limit = Number(u.searchParams.get("sysparm_limit") ?? "10");
  const offset = Number(u.searchParams.get("sysparm_offset") ?? "0");
  return jsonResponse(
    200,
    { result: rows.slice(offset, offset + limit) },
    { "x-total-count": String(rows.length) },
  );
};

const byRule = (scan, rule) => scan.findings.filter((f) => f.rule === rule);

test("securityScan lists every S-3 finding kind on the fixture instance", async () => {
  freshRuntime();
  await withMetadataFetch(router(fixture()), async () => {
    const scan = await securityScan();
    assert.equal(scan.available, true);
    assert.equal(scan.aclCount, 6);
    assert.equal(scan.truncated, undefined);
    for (const c of Object.values(scan.checks)) assert.equal(c.available, true);

    // DF-1 rules are unchanged.
    assert.equal(byRule(scan, "eval-in-acl").length, 1);
    const rolesOnly = byRule(scan, "acl-roles-only");
    assert.ok(rolesOnly.length >= 1);
    assert.ok(rolesOnly.every((f) => Array.isArray(f.roles)));

    // Roles joined: open ACL on a write, public role on a create.
    const open = byRule(scan, "acl-open");
    assert.deepEqual(
      open.map((f) => [f.sys_id, f.severity]),
      [
        ["acl2", "warn"],
        ["acl6", "info"],
      ],
    );
    const pub = byRule(scan, "acl-public-role");
    assert.equal(pub.length, 1);
    assert.equal(pub[0].severity, "warn");
    assert.equal(pub[0].table, "u_child");
    assert.deepEqual(pub[0].roles, ["public"]);
    // Duplicate role links collapse; the wildcard ACL keeps its table as `*`.
    assert.deepEqual(scan.checks.acl_roles.scanned, 5);

    // Elevated privilege, with inheritance resolved (admin and u_secops, plus
    // u_mid / u_super through admin).
    const elevated = byRule(scan, "acl-elevated-privilege");
    assert.equal(elevated.length, 1);
    assert.equal(elevated[0].severity, "warn");
    assert.deepEqual(elevated[0].grantedBy, [
      "admin",
      "u_mid",
      "u_secops",
      "u_super",
    ]);
    assert.equal(scan.checks.elevated_privilege_acls.findings, 1);

    // Admin overlap: u_mid / u_super reach admin (error), u_secops reaches
    // security_admin (warn); admin itself and the loop roles are not flagged.
    const overlap = byRule(scan, "admin-overlap-role");
    assert.deepEqual(
      overlap.map((f) => [f.name, f.severity]),
      [
        ["u_mid", "error"],
        ["u_secops", "warn"],
        ["u_super", "error"],
      ],
    );
    assert.equal(overlap[0].kind, "role");
    assert.deepEqual(overlap[0].grantedBy, ["admin", "security_admin"]);

    // Public Scripted REST resources: GET warns, a write method errors.
    const rest = byRule(scan, "public-rest-resource");
    assert.deepEqual(
      rest.map((f) => [f.name, f.operation, f.severity]),
      [
        ["Status API: /api/x_app/status", "GET", "warn"],
        ["Hook", "POST", "error"],
      ],
    );

    // Public pages: a UI page warns, another public page is info.
    assert.equal(byRule(scan, "public-ui-page")[0].name, "x_app_landing.do");
    assert.equal(byRule(scan, "public-page")[0].name, "login.do");
    assert.equal(scan.checks.public_ui_pages.findings, 2);

    // Tables with no ACL: only u_orphan (the wildcard hint is used).
    const noAcl = byRule(scan, "table-no-acl");
    assert.deepEqual(
      noAcl.map((f) => f.name),
      ["u_orphan"],
    );
    assert.match(noAcl[0].hint, /'\*' wildcard/);

    const total = Object.values(scan.bySeverity).reduce((a, b) => a + b, 0);
    assert.equal(total, scan.findings.length);
  });
});

test("codeHealth reports the new finding kinds and a per-check table (S-3 acceptance)", async () => {
  freshRuntime();
  const dir = mkdtempSync(join(tmpdir(), "sn-sec-"));
  try {
    await withEnv({ SN_DOCS_DIR: dir }, () =>
      withMetadataFetch(router(fixture()), async () => {
        const health = await codeHealth();
        const kinds = new Set(health.security.findings.map((f) => f.rule));
        for (const rule of [
          "public-rest-resource",
          "public-ui-page",
          "table-no-acl",
          "admin-overlap-role",
          "acl-elevated-privilege",
        ]) {
          assert.ok(kinds.has(rule), `missing ${rule}`);
        }
        const md = readFileSync(join(dir, health.reportFile), "utf8");
        assert.match(md, /\| public_rest_resources \| ok \| 2 \| 2 \|/);
        assert.match(md, /\| Item \| Operation \| Rule \| Severity \|/);
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("securityScan pages past one page and reports truncated at SN_MAX_RECORDS", async () => {
  freshRuntime();
  const acls = Array.from({ length: 5 }, (_, i) => ({
    sys_id: `acl${i}`,
    name: `u_t${i}`,
    operation: "read",
    script: "",
    condition: "x=1",
  }));
  await withEnv({ SN_MAX_RECORDS: "3" }, () =>
    withMetadataFetch(
      router({ ...fixture(), sys_security_acl: acls }),
      async () => {
        const scan = await securityScan();
        assert.equal(scan.aclCount, 3);
        assert.equal(scan.truncated, true);
        assert.equal(scan.truncatedReason, "cap");
        // A partial ACL read cannot prove a missing ACL.
        assert.equal(scan.checks.tables_without_acl.available, false);
        assert.match(
          scan.checks.tables_without_acl.unavailableReason,
          /partial/,
        );
        assert.equal(scan.checks.public_rest_resources.available, true);
        assert.equal(byRule(scan, "table-no-acl").length, 0);
      },
    ),
  );
});

test("securityScan applies its own ceiling and marks every clipped read", async () => {
  freshRuntime();
  await withMetadataFetch(router(fixture()), async () => {
    const scan = await securityScan(2);
    assert.equal(scan.aclCount, 2);
    assert.equal(scan.truncated, true);
    assert.equal(scan.truncatedReason, "ceiling");
    assert.equal(scan.checks.acl_roles.truncated, true);
    assert.equal(scan.checks.role_inheritance.truncated, true);
    assert.equal(scan.checks.admin_overlap_roles.truncated, true);
    assert.equal(scan.checks.elevated_privilege_acls.truncated, true);
    assert.equal(scan.checks.public_ui_pages.truncated, true);
    assert.equal(scan.checks.public_rest_resources.truncated, undefined);
  });
});

test("securityScan reports rows withheld from the ACL read as filtered", async () => {
  freshRuntime();
  await withMetadataFetch(
    (url) => {
      if (/\/sys_security_acl\?/.test(url)) {
        // The instance counts 3 rows but returns 1 (row-level ACLs).
        return jsonResponse(
          200,
          { result: [fixture().sys_security_acl[0]] },
          { "x-total-count": "3" },
        );
      }
      return jsonResponse(200, { result: [] }, { "x-total-count": "0" });
    },
    async () => {
      const scan = await securityScan();
      assert.equal(scan.aclCount, 1);
      assert.equal(scan.filtered, 2);
      assert.equal(scan.truncated, undefined);
    },
  );
});

test("each S-3 check degrades to available:false on its own (403/404/500)", async () => {
  freshRuntime();
  await withMetadataFetch(
    router({
      ...fixture(),
      sys_security_acl_role: 403,
      sys_user_role_contains: 404,
      sys_user_role: 403,
      sys_ws_operation: 500,
      sys_public: 401,
      sys_db_object: 403,
    }),
    async () => {
      const scan = await securityScan();
      assert.equal(scan.available, true);
      assert.equal(scan.aclCount, 6);
      const c = scan.checks;
      assert.match(c.acl_roles.unavailableReason, /sys_security_acl_role.*403/);
      assert.match(c.role_inheritance.unavailableReason, /404/);
      assert.match(c.admin_overlap_roles.unavailableReason, /404/);
      assert.equal(c.elevated_privilege_acls.available, false);
      assert.match(
        c.public_rest_resources.unavailableReason,
        /could not be read/,
      );
      assert.match(c.public_ui_pages.unavailableReason, /sys_public.*401/);
      assert.match(c.tables_without_acl.unavailableReason, /sys_db_object/);
      // DF-1 rules still run; nothing role-based is claimed.
      assert.equal(byRule(scan, "eval-in-acl").length, 1);
      assert.equal(byRule(scan, "acl-open").length, 0);
      assert.ok(byRule(scan, "acl-roles-only").every((f) => !f.roles));
    },
  );
});

test("elevated roles fall back to security_admin; unreadable sys_ui_page leaves a note", async () => {
  freshRuntime();
  await withMetadataFetch(
    router({ ...fixture(), sys_user_role: 403, sys_ui_page: 403 }),
    async () => {
      const scan = await securityScan();
      assert.equal(byRule(scan, "acl-elevated-privilege").length, 1);
      assert.match(
        scan.checks.elevated_privilege_acls.note,
        /assumed to be security_admin/,
      );
      assert.match(scan.checks.admin_overlap_roles.note, /security_admin/);
      assert.match(scan.checks.public_ui_pages.note, /sys_ui_page/);
      assert.equal(byRule(scan, "public-ui-page").length, 0);
      assert.equal(byRule(scan, "public-page").length, 2);
    },
  );
});

test("elevated ACL without inheritance data is info; no wildcard hint without '*' ACLs", async () => {
  freshRuntime();
  const f = fixture();
  await withMetadataFetch(
    router({
      ...f,
      sys_security_acl: f.sys_security_acl.filter((a) => a.name !== "*"),
      sys_user_role_contains: 403,
    }),
    async () => {
      const scan = await securityScan();
      const elevated = byRule(scan, "acl-elevated-privilege");
      assert.equal(elevated[0].severity, "info");
      assert.equal(elevated[0].grantedBy, undefined);
      const noAcl = byRule(scan, "table-no-acl");
      assert.doesNotMatch(noAcl[0].hint, /wildcard/);
    },
  );
});

test("a policy-denied table degrades its check, not the scan (SN_TABLES_DENY)", async () => {
  freshRuntime();
  await withEnv({ SN_TABLES_DENY: "sys_ws_operation,sys_db_object" }, () =>
    withMetadataFetch(router(fixture()), async (calls) => {
      const scan = await securityScan();
      assert.equal(scan.available, true);
      assert.match(
        scan.checks.public_rest_resources.unavailableReason,
        /SN_TABLES_DENY/,
      );
      assert.equal(scan.checks.tables_without_acl.available, false);
      assert.ok(!calls.some((c) => c.url.includes("/sys_ws_operation")));
    }),
  );
});

test("an unreadable ACL table still runs the checks that do not need it", async () => {
  freshRuntime();
  await withMetadataFetch(
    router({ ...fixture(), sys_security_acl: 404 }),
    async () => {
      const scan = await securityScan();
      assert.equal(scan.available, false);
      assert.match(scan.unavailableReason, /security_admin/);
      assert.equal(scan.aclCount, 0);
      assert.equal(scan.checks.acl_roles.available, false);
      assert.equal(scan.checks.tables_without_acl.available, false);
      assert.equal(scan.checks.elevated_privilege_acls.available, false);
      assert.equal(scan.checks.public_rest_resources.available, true);
      assert.ok(byRule(scan, "public-rest-resource").length > 0);
      assert.ok(byRule(scan, "admin-overlap-role").length > 0);
    },
  );
});

test("a non-access ACL read failure still propagates (codeHealth warns)", async () => {
  freshRuntime();
  await withMetadataFetch(router({ sys_security_acl: 500 }), async () => {
    await assert.rejects(() => securityScan());
  });
});

test("public pages with no candidate names skip the sys_ui_page lookup", async () => {
  freshRuntime();
  await withMetadataFetch(
    router({ ...fixture(), sys_public: [{ sys_id: "p", page: "a,b.do" }] }),
    async (calls) => {
      const scan = await securityScan();
      assert.equal(byRule(scan, "public-page").length, 1);
      assert.ok(!calls.some((c) => c.url.includes("/sys_ui_page")));
    },
  );
});

test("the report lists unavailable checks and a partial ACL read", async () => {
  freshRuntime();
  const dir = mkdtempSync(join(tmpdir(), "sn-sec-"));
  try {
    await withEnv({ SN_DOCS_DIR: dir, SN_MAX_RECORDS: "2" }, () =>
      withMetadataFetch(router({ ...fixture(), sys_public: 403 }), async () => {
        const health = await codeHealth();
        const md = readFileSync(join(dir, health.reportFile), "utf8");
        assert.match(md, /_Partial:_ the ACL read stopped early \(cap\)/);
        assert.match(md, /\| public_ui_pages \| unavailable — sys_public/);
        assert.match(md, /\| acl_roles \| partial \|/);
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ID-27: a record-data read during the security scan fails the metadata guard", async () => {
  freshRuntime();
  await assert.rejects(
    withMetadataFetch(router(fixture()), async () => {
      await securityScan();
      await globalThis
        .fetch("https://dev00000.service-now.com/api/now/table/incident")
        .catch(() => undefined);
    }),
    /non-metadata table: incident/,
  );
});
