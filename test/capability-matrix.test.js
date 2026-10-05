// S-13 — capability preflight v2: the per-group probe matrix, its policy
// routing and its positive / negative / transport caching.
import test, { mock } from "node:test";
import assert from "node:assert/strict";

import {
  MATRIX_GROUPS,
  clearCapabilityCache,
  WORKSPACE_PROBE_LIMIT,
  probeCapabilityMatrix,
  probeWorkspaces,
  releaseFamily,
} from "../build/api/capability-matrix.js";
import { WORKSPACE_CATEGORY } from "../build/api/uib-workspace.js";
import { checkCapabilities } from "../build/api/capabilities.js";
import { formatDoctorReport, runDoctor } from "../build/api/doctor.js";
import {
  getCapabilityTtlMs,
  getPluginNegativeTtlMs,
} from "../build/core/settings.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const BUILDTAG = "glide-xanadu-07-02-2024__patch3-10-17-2024";

/** Answer each probe with a realistic 200 body. */
function okInstance(url) {
  const u = new URL(url);
  const p = u.pathname;
  if (p.endsWith("/table/sys_properties")) {
    return jsonResponse(200, { result: [{ value: BUILDTAG }] });
  }
  if (p.endsWith("/table/sys_user_has_role")) {
    return jsonResponse(200, {
      result: [
        { "role.name": "itil" },
        { "role.name": "admin" },
        { "role.name": "itil" },
      ],
    });
  }
  if (p.endsWith("/table/sys_user_preference")) {
    return jsonResponse(200, { result: [{ value: "abc123" }] });
  }
  if (p.endsWith("/stats/sys_user")) {
    return jsonResponse(200, { result: { stats: { count: "7" } } });
  }
  return jsonResponse(200, { result: [{ sys_id: "1" }] });
}

const hits = (calls, fragment) =>
  calls.filter((c) => new URL(c.url).pathname.includes(fragment)).length;

test("releaseFamily parses the build tag", () => {
  assert.equal(releaseFamily(BUILDTAG), "xanadu");
  assert.equal(releaseFamily(" glide-Washingtondc-12-2023 "), "washingtondc");
  assert.equal(releaseFamily("not-a-tag"), undefined);
});

test("TTL defaults: 10 min positive, 60 s negative; env overrides", async () => {
  assert.equal(getCapabilityTtlMs(), 600_000);
  assert.equal(getPluginNegativeTtlMs(), 60_000);
  await withEnv(
    { SN_CAPABILITY_TTL_MS: "1000", SN_PLUGIN_NEGATIVE_TTL_MS: "500" },
    async () => {
      assert.equal(getCapabilityTtlMs(), 1000);
      assert.equal(getPluginNegativeTtlMs(), 500);
    },
  );
});

test("every group on a healthy instance, one GET per network group", async () => {
  freshRuntime();
  await withEnv({ SN_WRITE_MODE: "apply" }, () =>
    withFetch(okInstance, async (calls) => {
      const m = await probeCapabilityMatrix();
      assert.deepEqual(Object.keys(m), [...MATRIX_GROUPS]);
      for (const g of MATRIX_GROUPS) {
        assert.equal(m[g].status, "available", `${g}: ${m[g].reason}`);
      }
      assert.equal(m.writes.detail.writeMode, "apply");
      assert.equal(m.update_sets.detail.current, "abc123");
      assert.deepEqual(m.version.detail, {
        buildtag: BUILDTAG,
        family: "xanadu",
      });
      assert.equal(m.roles.detail.admin, true);
      assert.deepEqual(m.roles.detail.roles, ["admin", "itil"]);
      assert.deepEqual(m.roles.detail.notable, ["admin", "itil"]);
      assert.equal(m.email.httpStatus, 200);
      // S-6: update_sets also reads sys_update_set (canRead / canSet).
      assert.equal(m.update_sets.detail.canRead, true);
      assert.equal(m.update_sets.detail.canSet, true);
      assert.equal(m.update_sets.detail.configured, null);
      // writes is local: 8 network groups + the sys_update_set read, all GETs.
      assert.equal(calls.length, 9);
      assert.ok(calls.every((c) => (c.init?.method ?? "GET") === "GET"));
      const roleCall = calls.find((c) => c.url.includes("sys_user_has_role"));
      assert.match(
        new URL(roleCall.url).searchParams.get("sysparm_query"),
        /^user\.user_name=alice\^state=active$/,
      );
    }),
  );
});

test("writes group follows SN_WRITE_MODE and SN_READONLY without a request", async () => {
  freshRuntime();
  await withFetch(okInstance, async (calls) => {
    await withEnv({ SN_WRITE_MODE: "plan" }, async () => {
      const m = await probeCapabilityMatrix(["writes"]);
      assert.equal(m.writes.status, "plan-only");
    });
    await withEnv({ SN_WRITE_MODE: "apply", SN_READONLY: "true" }, async () => {
      const m = await probeCapabilityMatrix(["writes"]);
      assert.equal(m.writes.status, "read-only");
    });
    await withEnv(
      { SN_WRITE_MODE: "apply", SN_PACKAGES_READONLY: "table" },
      async () => {
        const m = await probeCapabilityMatrix(["writes"]);
        assert.equal(m.writes.status, "available");
        assert.deepEqual(m.writes.detail.readOnlyPackages, ["table"]);
      },
    );
    assert.equal(calls.length, 0);
  });
});

test("allow/deny matrix: a denied table or package is not probed and reads unknown", async () => {
  const cases = [
    ["SN_TABLES_DENY", "sys_user_has_role", "roles", "sys_user_has_role"],
    ["SN_TABLES_DENY", "sys_properties", "version", "sys_properties"],
    [
      "SN_TABLES_DENY",
      "sys_user_preference",
      "update_sets",
      "sys_user_preference",
    ],
    ["SN_TABLES_DENY", "sys_attachment", "attachments", "/attachment"],
    ["SN_TABLES_DENY", "sys_user", "aggregate", "/stats/"],
    ["SN_PACKAGES_DENY", "email", "email", "sys_email"],
    ["SN_PACKAGES_DENY", "atf", "atf", "sys_atf_test"],
    ["SN_PACKAGES_DENY", "importset", "import_sets", "sys_import_set"],
    ["SN_PACKAGES_DENY", "attachment", "attachments", "/attachment"],
    ["SN_PACKAGES_DENY", "aggregate", "aggregate", "/stats/"],
  ];
  for (const [key, value, group, fragment] of cases) {
    freshRuntime();
    await withEnv({ [key]: value }, () =>
      withFetch(okInstance, async (calls) => {
        const m = await probeCapabilityMatrix();
        assert.equal(m[group].status, "unknown", `${key}=${value}`);
        assert.match(m[group].reason, /^not probed/);
        assert.equal(hits(calls, fragment), 0, `${group} must not be probed`);
        // Every other network group still ran.
        for (const g of MATRIX_GROUPS) {
          if (g !== group && g !== "writes") {
            assert.equal(m[g].status, "available", `${key}=${value} → ${g}`);
          }
        }
      }),
    );
  }
});

test("SN_TABLES_ALLOW: tables outside the allow-list are not probed", async () => {
  freshRuntime();
  await withEnv({ SN_TABLES_ALLOW: "sys_email,sys_properties" }, () =>
    withFetch(okInstance, async (calls) => {
      const m = await probeCapabilityMatrix();
      assert.equal(m.email.status, "available");
      assert.equal(m.version.status, "available");
      assert.equal(m.roles.status, "unknown");
      assert.equal(m.atf.status, "unknown");
      assert.equal(calls.length, 2);
    }),
  );
});

test("gap-doc acceptance: roles denied → unknown; plan mode → plan-only", async () => {
  freshRuntime();
  await withEnv(
    { SN_TABLES_DENY: "sys_user_has_role", SN_WRITE_MODE: "plan" },
    () =>
      withFetch(okInstance, async () => {
        const r = await checkCapabilities();
        assert.equal(r.matrix.roles.status, "unknown");
        assert.equal(r.matrix.writes.status, "plan-only");
      }),
  );
});

test("401/403/404 → unavailable; other HTTP errors → unknown", async () => {
  freshRuntime();
  await withFetch(
    (url) => {
      const p = new URL(url).pathname;
      if (p.includes("sys_email"))
        return jsonResponse(403, { error: { message: "ACL" } });
      if (p.includes("sys_atf_test"))
        return jsonResponse(404, { error: { message: "no table" } });
      if (p.includes("/attachment"))
        return jsonResponse(401, { error: { message: "nope" } });
      if (p.includes("sys_import_set"))
        return jsonResponse(500, { error: { message: "boom" } });
      return okInstance(url);
    },
    async () => {
      const m = await probeCapabilityMatrix();
      assert.equal(m.email.status, "unavailable");
      assert.equal(m.email.httpStatus, 403);
      assert.match(m.email.reason, /no access/);
      assert.equal(m.atf.status, "unavailable");
      assert.match(m.atf.reason, /not present/);
      assert.equal(m.attachments.status, "unavailable");
      assert.equal(m.import_sets.status, "unknown");
      assert.match(m.import_sets.reason, /^HTTP 500/);
    },
  );
});

test("empty role / property / preference reads", async () => {
  freshRuntime();
  await withFetch(
    () => jsonResponse(200, { result: [] }),
    async () => {
      const m = await probeCapabilityMatrix([
        "roles",
        "version",
        "update_sets",
      ]);
      assert.deepEqual(Object.keys(m), ["update_sets", "version", "roles"]);
      assert.equal(m.roles.status, "unknown");
      assert.equal(m.version.status, "unknown");
      assert.equal(m.update_sets.status, "available");
      assert.equal(m.update_sets.detail.current, null);
      assert.match(m.update_sets.reason, /No update set selected/);
    },
  );
});

test("many roles are capped; build tag without a family keeps the raw tag", async () => {
  freshRuntime();
  const many = Array.from({ length: 60 }, (_, i) => ({
    "role.name": { value: `r${String(i).padStart(2, "0")}` },
  }));
  await withFetch(
    (url) =>
      new URL(url).pathname.includes("sys_user_has_role")
        ? jsonResponse(200, { result: many })
        : jsonResponse(200, { result: [{ value: "custom-build" }] }),
    async () => {
      const m = await probeCapabilityMatrix(["roles", "version"]);
      assert.equal(m.roles.detail.roles.length, 50);
      assert.equal(m.roles.detail.truncated, 60);
      assert.equal(m.roles.detail.admin, false);
      assert.deepEqual(m.version.detail, { buildtag: "custom-build" });
    },
  );
});

test("N-20 EL-1: roles flagged elevated_privilege are listed as elevatable", async () => {
  freshRuntime();
  const rows = [
    { "role.name": "security_admin", "role.elevated_privilege": "true" },
    { "role.name": "itil", "role.elevated_privilege": "false" },
    {
      "role.name": { value: "x_elev" },
      "role.elevated_privilege": { value: "true" },
    },
    { "role.name": "security_admin", "role.elevated_privilege": "true" },
  ];
  await withFetch(
    () => jsonResponse(200, { result: rows }),
    async (calls) => {
      const m = await probeCapabilityMatrix(["roles"]);
      assert.deepEqual(m.roles.detail.elevatable, ["security_admin", "x_elev"]);
      const fields = new URL(calls[0].url).searchParams.get("sysparm_fields");
      assert.match(fields, /role\.elevated_privilege/);
    },
  );
});

test("per-user groups are unknown without a usable user name", async () => {
  freshRuntime();
  await withEnv({ SN_USER: "bad^user" }, () =>
    withFetch(okInstance, async (calls) => {
      const m = await probeCapabilityMatrix(["roles", "update_sets"]);
      assert.equal(m.roles.status, "unknown");
      assert.equal(m.update_sets.status, "unknown");
      assert.match(m.roles.reason, /No user name/);
      assert.equal(calls.length, 0);
    }),
  );
});

test("positive results are cached; refresh / clearCapabilityCache re-probe", async () => {
  freshRuntime();
  await withFetch(okInstance, async (calls) => {
    const first = await probeCapabilityMatrix(["email"]);
    assert.equal(first.email.cached, undefined);
    const second = await probeCapabilityMatrix(["email"]);
    assert.equal(second.email.cached, true);
    assert.equal(second.email.status, "available");
    assert.equal(calls.length, 1);

    const r = await checkCapabilities({ groups: ["email"], refresh: true });
    assert.deepEqual(Object.keys(r.matrix), ["email"]);
    assert.equal(r.matrix.email.cached, undefined);
    assert.equal(hits(calls, "sys_email"), 2);

    clearCapabilityCache();
    await probeCapabilityMatrix(["email"]);
    assert.equal(hits(calls, "sys_email"), 3);
  });
});

test("positive cache expires after SN_CAPABILITY_TTL_MS", async () => {
  freshRuntime();
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    await withFetch(okInstance, async (calls) => {
      await probeCapabilityMatrix(["email"]);
      mock.timers.tick(599_999);
      assert.equal((await probeCapabilityMatrix(["email"])).email.cached, true);
      mock.timers.tick(2);
      assert.equal(
        (await probeCapabilityMatrix(["email"])).email.cached,
        undefined,
      );
      assert.equal(calls.length, 2);
    });
  } finally {
    mock.timers.reset();
  }
});

test("a 503-then-200 probe recovers only after the 60 s negative TTL", async () => {
  freshRuntime();
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    let down = true;
    await withFetch(
      (url) =>
        down
          ? jsonResponse(503, { error: { message: "maintenance" } })
          : okInstance(url),
      async (calls) => {
        const a = await probeCapabilityMatrix(["version"]);
        assert.equal(a.version.status, "unknown");
        assert.equal(a.version.httpStatus, 503);
        down = false;

        mock.timers.tick(59_000);
        const b = await probeCapabilityMatrix(["version"]);
        assert.equal(b.version.status, "unknown");
        assert.equal(b.version.cached, true);
        assert.equal(calls.length, 1);

        mock.timers.tick(1_001);
        const c = await probeCapabilityMatrix(["version"]);
        assert.equal(c.version.status, "available");
        assert.equal(c.version.detail.family, "xanadu");
        assert.equal(calls.length, 2);
      },
    );
  } finally {
    mock.timers.reset();
  }
});

test("transport errors are reported unknown and never cached", async () => {
  freshRuntime();
  let fail = true;
  await withFetch(
    (url) => {
      if (fail) throw new TypeError("fetch failed: ECONNRESET");
      return okInstance(url);
    },
    async (calls) => {
      const a = await probeCapabilityMatrix(["email"]);
      assert.equal(a.email.status, "unknown");
      assert.match(a.email.reason, /without an HTTP answer/);
      fail = false;
      const b = await probeCapabilityMatrix(["email"]);
      assert.equal(b.email.status, "available");
      assert.equal(b.email.cached, undefined);
      assert.equal(calls.length, 2);
    },
  );
});

test("the table preflight is policy-routed: a denied table is not requested", async () => {
  freshRuntime();
  await withEnv({ SN_TABLES_DENY: "sys_security_acl" }, () =>
    withFetch(okInstance, async (calls) => {
      const r = await checkCapabilities({ groups: [] });
      const acl = r.probed.find((p) => p.table === "sys_security_acl");
      assert.equal(acl.readable, false);
      assert.equal(acl.policyDenied, true);
      assert.equal(r.capabilities.acl_audit.achievable, false);
      assert.deepEqual(r.matrix, {});
      assert.equal(
        calls.filter((c) =>
          new URL(c.url).pathname.endsWith("/table/sys_security_acl"),
        ).length,
        0,
      );
    }),
  );
});

test("doctor prints the capability matrix without changing the verdict", async () => {
  freshRuntime();
  await withEnv(
    { SN_WRITE_MODE: "plan", SN_TABLES_DENY: "sys_user_has_role" },
    () =>
      withFetch(okInstance, async () => {
        const report = await runDoctor();
        assert.equal(report.status, "healthy");
        const text = formatDoctorReport(report);
        assert.match(text, /Capability matrix/);
        assert.match(text, /- writes: plan-only/);
        assert.match(text, /✓ version: available/);
        assert.match(text, /\? roles: unknown \(not probed/);
      }),
  );
});

test("S-6: update_sets canRead / canSet follow the reads and the write policy", async () => {
  const noSets = (url) =>
    new URL(url).pathname.endsWith("/table/sys_update_set")
      ? jsonResponse(200, { result: [] })
      : okInstance(url);
  freshRuntime();
  await withEnv({ SN_UPDATE_SET: "Sprint 12" }, () =>
    withFetch(noSets, async () => {
      const m = await probeCapabilityMatrix(["update_sets"]);
      assert.equal(m.update_sets.detail.canRead, false);
      assert.equal(m.update_sets.detail.canSet, false);
      assert.equal(m.update_sets.detail.configured, "Sprint 12");
    }),
  );
  freshRuntime();
  await withEnv({ SN_READONLY: "true" }, () =>
    withFetch(okInstance, async (calls) => {
      const m = await probeCapabilityMatrix(["update_sets"]);
      assert.equal(m.update_sets.detail.canRead, true);
      assert.equal(m.update_sets.detail.canSet, false);
      assert.equal(calls.length, 2);
      // The sys_update_set read is cached like the group probe.
      await probeCapabilityMatrix(["update_sets"]);
      assert.equal(calls.length, 2);
    }),
  );
  freshRuntime();
  await withEnv({ SN_TABLES_DENY: "sys_update_set" }, () =>
    withFetch(okInstance, async (calls) => {
      const m = await probeCapabilityMatrix(["update_sets"]);
      assert.equal(m.update_sets.detail.canRead, null);
      assert.equal(m.update_sets.detail.canSet, false);
      assert.equal(hits(calls, "sys_update_set"), 0);
    }),
  );
});

// N-30 — the workspace inventory probe beside the matrix.

/** Answer the two workspace reads with `ux` / `aw` rows or an HTTP status. */
const workspaceFetch = (ux, aw) => (url) => {
  const p = new URL(url).pathname;
  const answer = p.endsWith("/table/sys_ux_registry_m2m_category")
    ? ux
    : p.endsWith("/table/sys_aw_master_config")
      ? aw
      : undefined;
  if (answer === undefined) return okInstance(url);
  if (typeof answer === "number" && answer >= 400) {
    return jsonResponse(answer, { error: { message: `status ${answer}` } });
  }
  return jsonResponse(200, {
    result: Array.from({ length: answer }, (_, i) => ({ sys_id: `w${i}` })),
  });
};

test("workspaces: counts configurable vs Agent Workspace and classifies the instance; cached", async () => {
  freshRuntime();
  await withFetch(workspaceFetch(2, 1), async (calls) => {
    const w = await probeWorkspaces();
    assert.equal(w.status, "available");
    assert.deepEqual(w.detail, { kind: "mixed", configurable: 2, agent: 1 });
    assert.match(w.reason, /migration is pending/);
    const ux = calls.find((c) =>
      c.url.includes("/table/sys_ux_registry_m2m_category"),
    );
    const q = new URL(ux.url).searchParams;
    assert.equal(
      q.get("sysparm_query"),
      `experience_category=${WORKSPACE_CATEGORY}`,
    );
    assert.equal(q.get("sysparm_fields"), "sys_id");
    assert.equal(q.get("sysparm_limit"), String(WORKSPACE_PROBE_LIMIT));
    assert.equal(calls.length, 2);
    const again = await probeWorkspaces();
    assert.equal(again.cached, true);
    assert.equal(calls.length, 2);
  });
});

test("workspaces: a missing Agent Workspace plugin is none; kinds and the row floor", async () => {
  const cases = [
    [
      3,
      404,
      { kind: "configurable", configurable: 3, agent: 0 },
      /3 configurable/,
    ],
    [0, 2, { kind: "agent", configurable: 0, agent: 2 }, /superseded/],
    [0, 404, { kind: "none", configurable: 0, agent: 0 }, /No configurable/],
    [
      WORKSPACE_PROBE_LIMIT,
      0,
      {
        kind: "configurable",
        configurable: WORKSPACE_PROBE_LIMIT,
        agent: 0,
        truncated: true,
      },
      /100\+ configurable/,
    ],
  ];
  for (const [ux, aw, detail, reason] of cases) {
    freshRuntime();
    await withFetch(workspaceFetch(ux, aw), async () => {
      const w = await probeWorkspaces();
      assert.equal(w.status, "available");
      assert.deepEqual(w.detail, detail);
      assert.match(w.reason, reason);
    });
  }
});

test("workspaces: one unreadable table is named, both unreadable is unavailable, denied tables are not probed", async () => {
  freshRuntime();
  await withFetch(workspaceFetch(403, 1), async () => {
    const w = await probeWorkspaces();
    assert.equal(w.status, "available");
    assert.deepEqual(w.detail, { kind: "agent", agent: 1 });
    assert.match(w.reason, /Not readable: sys_ux_registry_m2m_category/);
  });
  freshRuntime();
  await withFetch(workspaceFetch(403, 403), async () => {
    const w = await probeWorkspaces();
    assert.equal(w.status, "unavailable");
    assert.match(w.reason, /could not be read/);
  });
  freshRuntime();
  await withFetch(
    (url) => {
      throw new TypeError(`fetch failed: ${url}`);
    },
    async (calls) => {
      const w = await probeWorkspaces();
      assert.equal(w.status, "unknown");
      await probeWorkspaces();
      assert.equal(calls.length, 4, "transport failures are not cached");
    },
  );
  freshRuntime();
  await withEnv({ SN_TABLES_DENY: "sys_aw_master_config" }, () =>
    withFetch(
      () => assert.fail("a denied table must not be probed"),
      async () => {
        const w = await probeWorkspaces();
        assert.equal(w.status, "unknown");
        assert.match(w.reason, /not probed/);
      },
    ),
  );
});

test("check_capabilities: full run reports workspaces; narrowed run skips it", async () => {
  freshRuntime();
  await withFetch(workspaceFetch(1, 0), async () => {
    const full = await checkCapabilities();
    assert.equal(full.workspaces.detail.kind, "configurable");
  });
  freshRuntime();
  await withFetch(workspaceFetch(1, 0), async (calls) => {
    const narrow = await checkCapabilities({ groups: [] });
    assert.equal("workspaces" in narrow, false);
    assert.ok(
      !calls.some((c) => c.url.includes("/table/sys_aw_master_config")),
    );
  });
});
