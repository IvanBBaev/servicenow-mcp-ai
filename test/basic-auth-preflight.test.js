import test from "node:test";
import assert from "node:assert/strict";

import {
  runDoctor,
  formatDoctorReport,
  doctorChecks,
  basicAuthVerdict,
} from "../build/api/doctor.js";
import {
  basicAuthPreflight,
  testConnection,
} from "../build/api/diagnostics.js";
import { queryTable } from "../build/api/table.js";
import { BASIC_AUTH_401_HINT } from "../build/core/auth.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

/**
 * N-75 — the instance's basic-auth restriction. The property family
 * (glide.authenticate.basic_auth.*) and the role snc_basic_auth_api_access
 * were verified on a PDI; here every read is a fetch double.
 */

const PREFIX = "glide.authenticate.basic_auth.";
const ROLE = "snc_basic_auth_api_access";
const ALICE_SYS_ID = "46d44a5dc0a8010a00f0f58a0b3b6b1a";

const rows = (result) => jsonResponse(200, { result });
const okRow = () => rows([{ sys_id: "1" }]);
const unauthorized = () =>
  jsonResponse(401, { error: { message: "User Not Authenticated" } });

/** Properties as the instance stores them: active, enforce, date, roles, users. */
const family = ({ active, enforce, date = "", roles = ROLE, users = "" }) => ({
  [`${PREFIX}restriction.active`]: active,
  [`${PREFIX}restriction.enforce`]: enforce,
  [`${PREFIX}restriction.enforcement_date`]: date,
  [`${PREFIX}allowed_roles`]: roles,
  [`${PREFIX}allowed_users`]: users,
  [`${PREFIX}allow_wsao`]: "true",
});

const queryOf = (url) => new URL(url).searchParams.get("sysparm_query") ?? "";

/** The preflight's three reads; everything else (probe, capabilities) is ok. */
const instance =
  ({ properties, roleRows = [], userRows = [], propertyStatus = 200 }) =>
  (url) => {
    const path = new URL(url).pathname;
    const query = queryOf(url);
    if (path.endsWith("/table/sys_properties")) {
      if (propertyStatus !== 200) {
        return jsonResponse(propertyStatus, { error: { message: "ACL" } });
      }
      return rows(
        Object.entries(properties).map(([name, value]) => ({ name, value })),
      );
    }
    if (
      path.endsWith("/table/sys_user_has_role") &&
      query.includes("role.nameIN")
    ) {
      return rows(roleRows);
    }
    if (path.endsWith("/table/sys_user") && query.startsWith("user_name=")) {
      return rows(userRows);
    }
    return okRow();
  };

const pathsOf = (calls) => calls.map((c) => new URL(c.url).pathname);

// -- basicAuthPreflight -------------------------------------------------------

test("preflight: enforced restriction, user holds the allowed role (two reads)", async () => {
  await withFetch(
    instance({
      properties: family({ active: "true", enforce: "true" }),
      roleRows: [{ "role.name": ROLE, state: "active" }],
    }),
    async (calls) => {
      const r = await basicAuthPreflight("alice");
      assert.deepEqual(r, {
        restriction: "enforced",
        allowedRoles: [ROLE],
        userAllowed: true,
        allowedBy: "role",
      });
      assert.deepEqual(pathsOf(calls), [
        "/api/now/table/sys_properties",
        "/api/now/table/sys_user_has_role",
      ]);
      assert.equal(queryOf(calls[0].url), `nameSTARTSWITH${PREFIX}`);
      assert.equal(
        queryOf(calls[1].url),
        `user.user_name=alice^role.nameIN${ROLE}`,
      );
      assert.equal(
        new URL(calls[1].url).searchParams.get("sysparm_fields"),
        "role.name,state",
      );
    },
  );
});

test("preflight: tracking mode without the role — a future lockout, with the enforcement date", async () => {
  await withFetch(
    instance({
      properties: family({
        active: "true",
        enforce: "false",
        date: "2026-12-01 00:00:00",
        roles: `${ROLE}, rest_api_explorer`,
      }),
    }),
    async (calls) => {
      const r = await basicAuthPreflight("alice");
      assert.deepEqual(r, {
        restriction: "tracking",
        enforcementDate: "2026-12-01 00:00:00",
        allowedRoles: [ROLE, "rest_api_explorer"],
        userAllowed: false,
      });
      // No allow list, so the user's sys_id is never looked up.
      assert.equal(
        pathsOf(calls).filter((p) => p.endsWith("/sys_user")).length,
        0,
      );
      assert.match(
        queryOf(calls[1].url),
        /role\.nameINsnc_basic_auth_api_access,rest_api_explorer$/,
      );
    },
  );
});

test("preflight: a user in allowed_users keeps basic auth (third read for the sys_id)", async () => {
  await withFetch(
    instance({
      properties: family({
        active: "true",
        enforce: "true",
        users: `${ALICE_SYS_ID},0000000000000000000000000000beef`,
      }),
      userRows: [{ sys_id: ALICE_SYS_ID }],
    }),
    async (calls) => {
      const r = await basicAuthPreflight("alice");
      assert.equal(r.userAllowed, true);
      assert.equal(r.allowedBy, "allow_list");
      assert.deepEqual(pathsOf(calls), [
        "/api/now/table/sys_properties",
        "/api/now/table/sys_user_has_role",
        "/api/now/table/sys_user",
      ]);
      assert.equal(queryOf(calls[2].url), "user_name=alice");
    },
  );
});

test("preflight: an inactive role grant does not count", async () => {
  await withFetch(
    instance({
      properties: family({ active: "true", enforce: "true" }),
      roleRows: [{ "role.name": ROLE, state: "inactive" }],
    }),
    async () => {
      const r = await basicAuthPreflight("alice");
      assert.equal(r.userAllowed, false);
      assert.equal(r.allowedBy, undefined);
    },
  );
});

test("preflight: restriction off", async () => {
  await withFetch(
    instance({ properties: family({ active: "false", enforce: "true" }) }),
    async () => {
      const r = await basicAuthPreflight("alice");
      assert.equal(r.restriction, "off");
      assert.equal(r.userAllowed, false);
    },
  );
});

test("preflight: unreadable properties (403) or an instance without the family — unknown, no role read", async () => {
  await withFetch(
    instance({ properties: {}, propertyStatus: 403 }),
    async (calls) => {
      assert.deepEqual(await basicAuthPreflight("alice"), {
        restriction: "unknown",
      });
      assert.equal(calls.length, 1);
    },
  );
  // Rows without the family's names (an older instance, or a generic double).
  await withFetch(okRow, async (calls) => {
    assert.deepEqual(await basicAuthPreflight("alice"), {
      restriction: "unknown",
    });
    assert.equal(calls.length, 1);
  });
});

test("preflight: a user name that cannot enter an encoded query skips the role read", async () => {
  await withFetch(
    instance({ properties: family({ active: "true", enforce: "false" }) }),
    async (calls) => {
      const r = await basicAuthPreflight("ali^ce");
      assert.equal(r.restriction, "tracking");
      assert.equal(r.userAllowed, undefined);
      assert.equal(calls.length, 1);
    },
  );
});

test("preflight: a failing role read leaves the user clause out, never throws", async () => {
  await withFetch(
    (url) =>
      new URL(url).pathname.endsWith("/table/sys_user_has_role")
        ? jsonResponse(403, { error: { message: "ACL" } })
        : instance({ properties: family({ active: "true", enforce: "true" }) })(
            url,
          ),
    async () => {
      const r = await basicAuthPreflight("alice");
      assert.equal(r.restriction, "enforced");
      assert.equal(r.userAllowed, undefined);
    },
  );
});

// -- basicAuthVerdict ---------------------------------------------------------

test("verdict: tracking without the role warns and names the role, the date and OAuth", () => {
  const v = basicAuthVerdict(
    {
      restriction: "tracking",
      enforcementDate: "2026-12-01 00:00:00",
      allowedRoles: [ROLE],
      userAllowed: false,
    },
    "alice",
  );
  assert.equal(v.ok, false);
  assert.match(
    v.detail,
    /not enforced \(enforcement date 2026-12-01 00:00:00\)/,
  );
  assert.match(v.detail, /user alice holds none of snc_basic_auth_api_access/);
  assert.match(v.hint, /Grant alice one of snc_basic_auth_api_access/);
  assert.match(v.hint, /before the restriction is enforced/);
  assert.match(v.hint, /SN_AUTH=oauth/);
});

test("verdict: enforced with the role, allow-list entry, off, and unknown", () => {
  assert.deepEqual(
    basicAuthVerdict(
      {
        restriction: "enforced",
        allowedRoles: [ROLE],
        userAllowed: true,
        allowedBy: "role",
      },
      "alice",
    ),
    {
      ok: true,
      detail: "restriction enforced; user alice holds an allowed role",
    },
  );
  assert.deepEqual(
    basicAuthVerdict(
      {
        restriction: "enforced",
        allowedRoles: [ROLE],
        userAllowed: true,
        allowedBy: "allow_list",
      },
      "alice",
    ),
    {
      ok: true,
      detail: "restriction enforced; user alice is in allowed_users",
    },
  );
  // Off: informational even without the role — nothing refuses the user today.
  const off = basicAuthVerdict(
    { restriction: "off", allowedRoles: [ROLE], userAllowed: false },
    "alice",
  );
  assert.equal(off.ok, true);
  assert.match(off.detail, /^restriction off; user alice holds none of/);
  assert.equal(off.hint, undefined);
  // Enforced without the role: the hint has no "before" clause.
  const locked = basicAuthVerdict(
    { restriction: "enforced", allowedRoles: [ROLE], userAllowed: false },
    "alice",
  );
  assert.equal(locked.ok, false);
  assert.doesNotMatch(locked.hint, /before the restriction/);
  // Roles unreadable: no user clause.
  assert.equal(
    basicAuthVerdict({ restriction: "enforced", allowedRoles: [ROLE] }, "alice")
      .detail,
    "restriction enforced",
  );
  assert.equal(
    basicAuthVerdict({ restriction: "unknown" }, "alice"),
    undefined,
  );
});

// -- doctor -------------------------------------------------------------------

test("doctor: a basic-auth profile in tracking mode without the role — healthy, with a warning line and a basic_auth check", async () => {
  await withFetch(
    instance({
      properties: family({
        active: "true",
        enforce: "false",
        date: "2026-12-01 00:00:00",
      }),
    }),
    async (calls) => {
      const r = await runDoctor();
      assert.equal(r.status, "healthy");
      assert.equal(r.basicAuth.restriction, "tracking");
      assert.equal(r.basicAuth.userAllowed, false);
      const text = formatDoctorReport(r);
      assert.match(
        text,
        /^! Basic auth — restriction active but not enforced/m,
      );
      assert.match(text, /Grant alice one of snc_basic_auth_api_access/);
      assert.match(text, /SN_AUTH=oauth/);
      const check = doctorChecks(r).find((c) => c.name === "basic_auth");
      assert.equal(check.ok, false);
      assert.match(check.hint, /allowed_users/);
      // The preflight ran after the probe and the capabilities, once (the
      // capability matrix reads sys_properties too, for glide.buildtag).
      const preflightReads = calls.filter((c) =>
        queryOf(c.url).startsWith(`nameSTARTSWITH${PREFIX}`),
      );
      assert.equal(preflightReads.length, 1);
      const last = pathsOf(calls);
      assert.ok(
        last.indexOf("/api/now/table/sys_user_has_role") >
          last.indexOf("/api/now/table/sys_user"),
      );
    },
  );
});

test("doctor: enforced restriction with the role — a check mark, no hint", async () => {
  await withFetch(
    instance({
      properties: family({ active: "true", enforce: "true" }),
      roleRows: [{ "role.name": ROLE, state: "active" }],
    }),
    async () => {
      const r = await runDoctor();
      assert.equal(r.status, "healthy");
      const text = formatDoctorReport(r);
      assert.match(
        text,
        /^✓ Basic auth — restriction enforced; user alice holds an allowed role$/m,
      );
      assert.doesNotMatch(text, /Grant alice/);
      const check = doctorChecks(r).find((c) => c.name === "basic_auth");
      assert.deepEqual(check, {
        name: "basic_auth",
        ok: true,
        detail: "restriction enforced; user alice holds an allowed role",
      });
    },
  );
});

test("doctor: an unreadable restriction renders nothing (the generic double stays as before)", async () => {
  await withFetch(okRow, async () => {
    const r = await runDoctor();
    assert.equal(r.status, "healthy");
    assert.deepEqual(r.basicAuth, { restriction: "unknown" });
    assert.doesNotMatch(formatDoctorReport(r), /Basic auth/);
    assert.equal(
      doctorChecks(r).some((c) => c.name === "basic_auth"),
      false,
    );
  });
});

test("doctor: a 401 under basic auth names the restriction, the role and OAuth", async () => {
  await withFetch(unauthorized, async () => {
    const r = await runDoctor();
    assert.equal(r.status, "degraded");
    assert.equal(r.basicAuth, undefined);
    // From the http layer (servicenow_test_connection carries the same hint).
    assert.equal(r.connection.code, "INSTANCE_HTTP_401");
    assert.equal(r.connection.hint, BASIC_AUTH_401_HINT);
    assert.match(
      r.hint,
      /glide\.authenticate\.basic_auth\.restriction\.enforce/,
    );
    assert.match(r.hint, /snc_basic_auth_api_access/);
    assert.match(r.hint, /SN_AUTH=oauth/);
    assert.match(
      r.hint,
      /servicenow_set_credentials updates them at runtime\.$/,
    );
    const connectivity = doctorChecks(r).find((c) => c.name === "connectivity");
    assert.equal(connectivity.hint, r.hint);
  });
});

test("doctor: another auth method keeps the generic 401 fix and runs no preflight", async () => {
  await withEnv({ SN_AUTH: "apikey", SN_API_KEY: "k-1" }, async () => {
    await withFetch(unauthorized, async () => {
      const r = await runDoctor();
      assert.equal(r.config.auth, "apikey");
      assert.match(
        r.hint,
        /^Check the credentials: Set SN_INSTANCE and SN_API_KEY/,
      );
      assert.doesNotMatch(r.hint, /basic_auth/);
      assert.doesNotMatch(r.connection.hint ?? "", /basic_auth/);
    });
    await withFetch(
      instance({ properties: family({ active: "true", enforce: "false" }) }),
      async (calls) => {
        const r = await runDoctor();
        assert.equal(r.status, "healthy");
        assert.equal(r.basicAuth, undefined);
        assert.equal(
          calls.some((c) =>
            queryOf(c.url).startsWith(`nameSTARTSWITH${PREFIX}`),
          ),
          false,
        );
      },
    );
  });
});

// -- the http layer -----------------------------------------------------------

test("http: a 401 under basic auth keeps INSTANCE_HTTP_401 and carries the basic-auth hint", async () => {
  await withFetch(unauthorized, async (calls) => {
    await assert.rejects(queryTable({ table: "incident" }), (err) => {
      assert.equal(err.code, "INSTANCE_HTTP_401");
      assert.equal(err.status, 401);
      assert.equal(err.hint, BASIC_AUTH_401_HINT);
      return true;
    });
    assert.equal(calls.length, 1);
    const probe = await testConnection();
    assert.equal(probe.ok, false);
    assert.equal(probe.hint, BASIC_AUTH_401_HINT);
  });
});

test("http: a 401 under an API key keeps the generic hint", async () => {
  await withEnv({ SN_AUTH: "apikey", SN_API_KEY: "k-1" }, async () => {
    await withFetch(unauthorized, async () => {
      await assert.rejects(queryTable({ table: "incident" }), (err) => {
        assert.equal(err.code, "INSTANCE_HTTP_401");
        assert.match(
          err.hint,
          /servicenow_test_connection or `servicenow-mcp-ai doctor`/,
        );
        assert.doesNotMatch(err.hint, /basic_auth/);
        return true;
      });
    });
  });
});
