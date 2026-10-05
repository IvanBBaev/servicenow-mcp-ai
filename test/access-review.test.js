// N-22 — access review: privileged accounts, grant paths, dormant flag, revokes.
import test from "node:test";
import assert from "node:assert/strict";

import {
  groupAccounts,
  isDormant,
  privilegedContainers,
  readAccessReview,
  renderAccessReview,
} from "../build/api/access-review.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withFetch,
} from "./helpers.js";

baselineEnv();

const NOW = Date.parse("2026-10-05T00:00:00Z");

test("dormant: active and no login within the threshold, or never", () => {
  assert.equal(isDormant(true, undefined, NOW), true);
  assert.equal(isDormant(true, "2026-09-01 10:00:00", NOW), false);
  assert.equal(isDormant(true, "2026-06-01 10:00:00", NOW), true);
  assert.equal(isDormant(true, "2026-06-01 10:00:00", NOW, 200), false);
  assert.equal(isDormant(false, undefined, NOW), false);
  assert.equal(isDormant(true, "garbage", NOW), false);
});

test("containment closes transitively over privileged roles", () => {
  const base = new Set(["admin", "security_admin"]);
  const out = privilegedContainers(base, [
    ["super", "mid"],
    ["mid", "admin"],
    ["other", "itil"],
    ["loop", "loop2"],
    ["loop2", "loop"],
    ["admin", "itil"],
  ]);
  assert.deepEqual(out, { super: ["admin"], mid: ["admin"] });
});

test("grant paths: direct, group, contained role", () => {
  const user = {
    user: "u1",
    "user.user_name": "alice",
    "user.active": "true",
    "user.last_login_time": "2026-10-01 08:00:00",
  };
  const accounts = groupAccounts(
    [
      {
        ...user,
        "role.name": "admin",
        sys_created_by: "bob",
        sys_created_on: "2026-01-01 00:00:00",
      },
      { ...user, "role.name": "admin", "granted_by.name": "Admins" },
      {
        ...user,
        "role.name": "security_admin",
        inherited: "true",
        "included_in_role.name": "super",
      },
      { ...user, "role.name": "admin" }, // duplicate direct grant
      {
        user: "u2",
        "user.user_name": "zed",
        "user.active": "true",
        "role.name": "admin",
      },
    ],
    NOW,
  );
  assert.deepEqual(
    accounts.map((a) => [a.userName, a.dormant]),
    [
      ["zed", true],
      ["alice", false],
    ],
  );
  const alice = accounts[1];
  assert.deepEqual(
    alice.grants.map((g) => [g.role, g.path, g.via]),
    [
      ["admin", "direct", undefined],
      ["admin", "group", "Admins"],
      ["security_admin", "contained_role", "super"],
    ],
  );
  assert.equal(alice.grants[0].grantedBy, "bob");
});

function tables(over = {}) {
  return (url) => {
    const u = new URL(url);
    const table = u.pathname.split("/").pop();
    if (over[table]) return over[table](u);
    switch (table) {
      case "sys_user_role":
        return jsonResponse(200, {
          result: [
            { name: "admin" },
            { name: "security_admin" },
            { name: "x_elev" },
          ],
        });
      case "sys_user_role_contains":
        return jsonResponse(200, {
          result: [{ "role.name": "x_super", "contains.name": "admin" }],
        });
      case "sys_user_has_role":
        return jsonResponse(200, {
          result: [
            {
              user: "u1",
              "user.user_name": "alice",
              "user.active": "true",
              "user.last_login_time": "2026-01-01 00:00:00",
              "role.name": "x_super",
            },
          ],
        });
      case "sys_audit_delete":
        return jsonResponse(200, {
          result: [
            {
              documentkey: "g1",
              sys_created_by: "bob",
              sys_created_on: "2026-09-30 12:00:00",
            },
          ],
        });
      default:
        return jsonResponse(404, {
          error: { message: `Invalid table ${table}` },
        });
    }
  };
}

test("readAccessReview reads roles, containers, holders and revokes", async () => {
  freshRuntime();
  await withFetch(tables(), async (calls) => {
    const r = await readAccessReview({ now: NOW });
    assert.equal(r.available, true);
    assert.deepEqual(r.roles, ["admin", "security_admin", "x_elev", "x_super"]);
    assert.deepEqual(r.containers, { x_super: ["admin"] });
    const holderCall = calls
      .map((c) => new URL(c.url))
      .find((u) => u.pathname.endsWith("/sys_user_has_role"));
    assert.match(
      holderCall.searchParams.get("sysparm_query"),
      /^role\.nameINadmin,security_admin,x_elev,x_super/,
    );
    assert.equal(r.accounts.length, 1);
    assert.equal(r.accounts[0].dormant, true);
    assert.equal(r.revokes.available, true);
    assert.deepEqual(r.revokes.rows, [
      { sys_id: "g1", revokedBy: "bob", revokedOn: "2026-09-30 12:00:00" },
    ]);
    const md = renderAccessReview(r).join("\n");
    assert.match(
      md,
      /1 account\(s\) hold a privileged role \(4 role\(s\)\); 1 dormant/,
    );
    assert.match(md, /`x_super` \(contains admin\)/);
    assert.match(
      md,
      /\| alice \| {2}\| yes \| 2026-01-01 00:00:00 \| \*\*yes\*\* \| x_super \| direct \|/,
    );
    assert.match(md, /\| g1 \| bob \| 2026-09-30 12:00:00 \|/);
    assert.match(md, /unverified until O-5/);
  });
});

test("an unreadable audit degrades only the revoke section", async () => {
  freshRuntime();
  await withFetch(
    tables({
      sys_audit_delete: () =>
        jsonResponse(403, { error: { message: "denied" } }),
    }),
    async () => {
      const r = await readAccessReview({ now: NOW });
      assert.equal(r.available, true);
      assert.equal(r.accounts.length, 1);
      assert.equal(r.revokes.available, false);
      assert.match(
        r.revokes.unavailableReason,
        /sys_audit_delete is not readable/,
      );
      assert.match(
        renderAccessReview(r).join("\n"),
        /### Role revokes[\s\S]*Unavailable:/,
      );
    },
  );
});

test("unreadable role tables degrade to unavailable", async () => {
  freshRuntime();
  await withFetch(
    tables({
      sys_user_has_role: () =>
        jsonResponse(403, { error: { message: "denied" } }),
    }),
    async () => {
      const r = await readAccessReview({ now: NOW });
      assert.equal(r.available, false);
      assert.match(r.unavailableReason, /sys_user_has_role is not readable/);
      assert.ok(r.roles.includes("x_super"));
      assert.match(renderAccessReview(r).join("\n"), /^Unavailable:/);
    },
  );

  freshRuntime();
  await withFetch(
    () => jsonResponse(403, { error: { message: "denied" } }),
    async (calls) => {
      const r = await readAccessReview({ now: NOW });
      assert.equal(calls.length, 1);
      assert.equal(r.available, false);
      assert.match(r.unavailableReason, /sys_user_role is not readable/);
    },
  );
});
