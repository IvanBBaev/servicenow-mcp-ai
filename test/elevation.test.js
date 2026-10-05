// N-20 EL-2 — a 403 on a write the platform gates behind an elevated role
// surfaces as ELEVATION_REQUIRED with a hint naming the role.
import test from "node:test";
import assert from "node:assert/strict";

import {
  ELEVATED_TABLES,
  elevationHint,
  elevationNeeded,
} from "../build/core/elevation.js";
import { snRequest } from "../build/core/http.js";
import { ERROR_CODES } from "../build/core/errors.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withFetch,
} from "./helpers.js";

baselineEnv();

test("elevationNeeded: only Table API writes to a gated table qualify", () => {
  const acl = { table: "sys_security_acl", role: "security_admin" };
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "patch"]) {
    assert.deepEqual(
      elevationNeeded(method, "/api/now/table/sys_security_acl"),
      acl,
    );
  }
  assert.deepEqual(
    elevationNeeded("PATCH", "/api/now/v2/table/sys_security_acl/abc123?x=1"),
    acl,
  );
  assert.deepEqual(
    elevationNeeded("DELETE", "/api/now/table/sys_security_acl_role/abc"),
    { table: "sys_security_acl_role", role: "security_admin" },
  );
  // Reads, other tables and a table whose name only starts the same: none.
  assert.equal(
    elevationNeeded("GET", "/api/now/table/sys_security_acl"),
    undefined,
  );
  assert.equal(elevationNeeded("POST", "/api/now/table/incident"), undefined);
  assert.equal(
    elevationNeeded("POST", "/api/now/table/sys_security_acl_x"),
    undefined,
  );
  assert.equal(
    elevationNeeded("POST", "/api/now/import/sys_security_acl"),
    undefined,
  );
});

test("every gated table names a role, and the hint names it", () => {
  for (const [table, role] of Object.entries(ELEVATED_TABLES)) {
    assert.ok(role);
    const hint = elevationHint({ table, role });
    assert.match(hint, new RegExp(table));
    assert.match(hint, new RegExp(role));
    assert.match(hint, /update set/);
  }
  assert.equal(ERROR_CODES.ELEVATION_REQUIRED.source, "servicenow");
});

test("a 403 on a gated write becomes ELEVATION_REQUIRED; other 403s stay generic", async () => {
  freshRuntime();
  const denied = () =>
    jsonResponse(403, {
      error: { message: "Operation Failed", detail: "ACL Exception" },
    });
  await withFetch(denied, async () => {
    await assert.rejects(
      snRequest({
        method: "PATCH",
        path: "/api/now/table/sys_security_acl/abc",
        body: { active: "false" },
      }),
      (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, "ELEVATION_REQUIRED");
        assert.match(err.hint, /security_admin/);
        return true;
      },
    );
    await assert.rejects(
      snRequest({
        method: "PATCH",
        path: "/api/now/table/incident/abc",
        body: { state: "2" },
      }),
      (err) => {
        assert.equal(err.code, "INSTANCE_HTTP_403");
        return true;
      },
    );
    await assert.rejects(
      snRequest({ method: "GET", path: "/api/now/table/sys_security_acl" }),
      (err) => {
        assert.equal(err.code, "INSTANCE_HTTP_403");
        return true;
      },
    );
  });
});
