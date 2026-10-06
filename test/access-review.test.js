// N-22 — access review: privileged accounts, grant paths, dormant flag, revokes;
// one user's role history.
import test from "node:test";
import assert from "node:assert/strict";

import {
  deletedRoleRow,
  groupAccounts,
  isDormant,
  privilegedContainers,
  readAccessReview,
  readRoleHistory,
  renderAccessReview,
  renderRoleHistory,
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

const U1 = "a".repeat(32);
const U2 = "b".repeat(32);
const payload = (user, role) =>
  `<?xml version="1.0" encoding="UTF-8"?><sys_user_has_role><user display_value="Alice">${user}</user><role display_value="${role}">${"c".repeat(32)}</role></sys_user_has_role>`;

test("deletedRoleRow reads the user and the role display value from the payload", () => {
  assert.deepEqual(deletedRoleRow(payload(U1, "a&amp;b")), {
    user: U1,
    role: "a&b",
  });
  assert.deepEqual(deletedRoleRow(`<role>${U2}</role>`), { role: U2 });
  assert.deepEqual(deletedRoleRow("not xml"), {});
});

function historyTables(over = {}) {
  return (url) => {
    const u = new URL(url);
    const table = u.pathname.split("/").pop();
    if (over[table]) return over[table](u);
    if (table === "sys_user_has_role") {
      return jsonResponse(200, {
        result: [
          {
            sys_id: "g2",
            "role.name": "itil",
            "granted_by.name": "Service Desk",
            state: "active",
            sys_created_by: "bob",
            sys_created_on: "2026-09-20 09:00:00",
          },
          {
            sys_id: "g1",
            "role.name": "admin",
            state: "pending",
            sys_created_by: "carol",
            sys_created_on: "2026-01-01 00:00:00",
          },
        ],
      });
    }
    if (table === "sys_audit_delete") {
      return jsonResponse(200, {
        result: [
          {
            documentkey: "g3",
            payload: payload(U1, "security_admin"),
            sys_created_by: "dave",
            sys_created_on: "2026-09-20 09:00:00",
          },
          {
            documentkey: "g4",
            payload: payload(U2, "admin"),
            sys_created_by: "dave",
            sys_created_on: "2026-09-21 09:00:00",
          },
        ],
      });
    }
    return jsonResponse(404, { error: { message: `Invalid table ${table}` } });
  };
}

test("readRoleHistory merges a user's grants and revokes, newest first", async () => {
  freshRuntime();
  await withFetch(historyTables(), async (calls) => {
    const h = await readRoleHistory({ user: U1, now: NOW });
    assert.equal(h.available, true);
    assert.deepEqual(
      h.events.map((e) => [e.action, e.role, e.rowId, e.by]),
      [
        ["revoked", "security_admin", "g3", "dave"],
        ["granted", "itil", "g2", "bob"],
        ["granted", "admin", "g1", "carol"],
      ],
      "another user's deleted row is dropped; a revoke sorts first at the same second",
    );
    assert.equal(h.events[1].path, "group");
    assert.equal(h.events[1].via, "Service Desk");
    assert.equal(h.events[1].state, undefined);
    assert.equal(h.events[2].state, "pending");
    const queries = calls.map((c) =>
      new URL(c.url).searchParams.get("sysparm_query"),
    );
    assert.match(queries[0], new RegExp(`^user=${U1}\\^`));
    assert.match(
      queries[1],
      new RegExp(`payloadLIKE${U1}\\^sys_created_on>=2026-07-07 00:00:00`),
    );
    const md = renderRoleHistory(h).join("\n");
    assert.match(md, /^2 role grant\(s\); 1 revoke\(s\) in the last 90 days\./);
    assert.match(
      md,
      /\| 2026-09-20 09:00:00 \| revoked \| security_admin \| {2}\|/,
    );
    assert.match(
      md,
      /\| granted \| admin \| direct \| {2}\| pending \| carol \|/,
    );
    assert.match(md, /unverified until O-5/);
  });
});

test("readRoleHistory degrades: audit only the revokes, the role table everything", async () => {
  freshRuntime();
  await withFetch(
    historyTables({
      sys_audit_delete: () =>
        jsonResponse(403, { error: { message: "denied" } }),
    }),
    async () => {
      const h = await readRoleHistory({ user: U1, now: NOW });
      assert.equal(h.available, true);
      assert.equal(h.events.length, 2);
      assert.equal(h.revokes.available, false);
      assert.match(
        renderRoleHistory(h).join("\n"),
        /revokes unavailable: .*sys_audit_delete is not readable/,
      );
    },
  );
  freshRuntime();
  await withFetch(
    () => jsonResponse(403, { error: { message: "denied" } }),
    async (calls) => {
      const h = await readRoleHistory({ user: U1, now: NOW });
      assert.equal(calls.length, 1);
      assert.equal(h.available, false);
      assert.match(
        renderRoleHistory(h).join("\n"),
        /^Unavailable: .*sys_user_has_role is not readable/,
      );
    },
  );
});

test("readRoleHistory needs a user sys_id", async () => {
  await assert.rejects(
    () => readRoleHistory({ user: "alice" }),
    /user's sys_id/,
  );
});
