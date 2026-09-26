import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  detectSdkManaged,
  scanSdkProjects,
  sdkProjectScan,
  clearSdkProjectScan,
  SDK_SCAN_LIMITS,
  SDK_SCAN_TTL_MS,
  DEFAULT_SDK_HEURISTICS,
} from "../build/core/artifacts/sdk-managed.js";
import { getSdkProjectDirs } from "../build/core/settings.js";
import { buildStatusPayload } from "../build/mcp/status.js";
import { checkCapabilities } from "../build/api/capabilities.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

baselineEnv();

/**
 * P-3 — SDK-managed scope detection. Fixture SDK projects are temporary
 * directories holding a `now.config.json`.
 */

const APP_ID = "0123456789abcdef0123456789abcdef";
const OTHER_ID = "fedcba9876543210fedcba9876543210";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sdk-managed-"));
}

function project(root, rel, config) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "now.config.json"),
    typeof config === "string" ? config : JSON.stringify(config),
  );
  return dir;
}

const ENV_OFF = {
  SN_SDK_MANAGED_SCOPES: undefined,
  SN_SDK_PROJECT_DIRS: undefined,
};

test("fixture project marks its scope yes; an unrelated scope is no", async () => {
  freshRuntime();
  const root = tmpRoot();
  project(root, "apps/acme", { scope: "x_acme_app", scopeId: APP_ID });
  await withEnv({ ...ENV_OFF, SN_SDK_PROJECT_DIRS: root }, async () => {
    const yes = await detectSdkManaged("x_acme_app");
    assert.equal(yes.managed, "yes");
    assert.equal(yes.unverified, false);
    const hit = yes.evidence.find((e) => e.matched);
    assert.equal(hit.source, "now.config.json");
    assert.equal(hit.verified, true);
    assert.match(hit.path, /apps.acme.now\.config\.json$/);

    // By sys_id (scopeId) too.
    assert.equal((await detectSdkManaged(APP_ID)).managed, "yes");
    assert.equal(
      (await detectSdkManaged({ scope: "x_acme_app", sys_id: APP_ID })).managed,
      "yes",
    );

    const no = await detectSdkManaged({ scope: "x_other", sys_id: OTHER_ID });
    assert.equal(no.managed, "no");
    assert.ok(no.evidence.every((e) => !e.matched));
    assert.match(no.authority, /pending O-6/);
  });
});

test("nothing configured → unknown, never no", async () => {
  freshRuntime();
  await withEnv(ENV_OFF, async () => {
    const r = await detectSdkManaged("x_acme_app");
    assert.equal(r.managed, "unknown");
    assert.deepEqual(r.evidence, []);
    assert.deepEqual(DEFAULT_SDK_HEURISTICS, []);
  });
});

test("owner declaration wins, by name or sys_id", async () => {
  freshRuntime();
  await withEnv(
    {
      ...ENV_OFF,
      SN_SDK_MANAGED_SCOPES: `X_Acme_App, ${APP_ID.toUpperCase()}`,
    },
    async () => {
      const byName = await detectSdkManaged("x_acme_app");
      assert.equal(byName.managed, "yes");
      assert.equal(byName.evidence[0].source, "declaration");
      const byId = await detectSdkManaged({ sys_id: APP_ID });
      assert.equal(byId.managed, "yes");
      assert.match(byId.evidence[0].detail, /sys_id/);
      // Full identity, not declared → no.
      const no = await detectSdkManaged({ scope: "x_b", sys_id: OTHER_ID });
      assert.equal(no.managed, "no");
      assert.match(no.evidence[0].detail, /not among the 2/);
      // Name only while a sys_id entry cannot be compared → unknown.
      assert.equal((await detectSdkManaged("x_b")).managed, "unknown");
    },
  );
});

test("a scopeId conflict is not a match; a name-only config needs a name", async () => {
  freshRuntime();
  const root = tmpRoot();
  project(root, "a", { scope: "x_acme_app", scopeId: OTHER_ID });
  project(root, "b", { scope: "x_named_only" });
  await withEnv({ ...ENV_OFF, SN_SDK_PROJECT_DIRS: root }, async () => {
    const r = await detectSdkManaged({ scope: "x_acme_app", sys_id: APP_ID });
    assert.equal(r.managed, "no");
    assert.ok(r.evidence.some((e) => /scopeId .* differs/.test(e.detail)));
    // A sys_id alone cannot be compared with the name-only project → unknown.
    assert.equal((await detectSdkManaged(APP_ID)).managed, "unknown");
  });
});

test("the sys_scope lookup completes the identity (resolver and instance)", async () => {
  freshRuntime();
  const root = tmpRoot();
  project(root, "p", { scope: "x_acme_app" });
  await withEnv({ ...ENV_OFF, SN_SDK_PROJECT_DIRS: root }, async () => {
    const viaResolver = await detectSdkManaged(APP_ID, {
      resolveScope: async () => ({ scope: "x_acme_app", sys_id: APP_ID }),
    });
    assert.equal(viaResolver.managed, "yes");
    assert.equal(viaResolver.scope, "x_acme_app");

    const missing = await detectSdkManaged(APP_ID, {
      resolveScope: async () => null,
    });
    assert.equal(missing.managed, "unknown");
    assert.match(missing.warnings.join(), /not found/);

    const failing = await detectSdkManaged(APP_ID, {
      resolveScope: async () => {
        throw new Error("boom");
      },
    });
    assert.match(failing.warnings.join(), /lookup failed: boom/);

    await withFetch(
      (url) => {
        const u = new URL(url);
        assert.equal(u.pathname, "/api/now/table/sys_scope");
        assert.equal(u.searchParams.get("sysparm_query"), `sys_id=${APP_ID}`);
        return jsonResponse(200, {
          result: [{ sys_id: APP_ID, scope: "x_acme_app" }],
        });
      },
      async (calls) => {
        const r = await detectSdkManaged(APP_ID, { lookup: true });
        assert.equal(r.managed, "yes");
        assert.equal(calls.length, 1);
      },
    );
    await withFetch(
      () => jsonResponse(200, { result: [] }),
      async () => {
        const r = await detectSdkManaged("x_unknown", { lookup: true });
        assert.equal(r.managed, "no");
        assert.match(r.warnings.join(), /not found/);
      },
    );
    // A name that is not a plain identifier never reaches the query.
    await withFetch(
      () => assert.fail("no request expected"),
      async () => {
        const r = await detectSdkManaged("x^ORactive=true", { lookup: true });
        assert.match(r.warnings.join(), /not found/);
      },
    );
  });
});

test("heuristics are unverified: they raise unknown → yes but never make no", async () => {
  freshRuntime();
  const raising = {
    id: "fake-marker",
    description: "test marker",
    run: async () => ({ raised: true, detail: "marker present" }),
  };
  const silent = { id: "silent", description: "", run: async () => null };
  const broken = {
    id: "broken",
    description: "",
    run: async () => {
      throw new Error("nope");
    },
  };
  await withEnv(ENV_OFF, async () => {
    const r = await detectSdkManaged("x_acme_app", {
      heuristics: [silent, broken, raising],
    });
    assert.equal(r.managed, "yes");
    assert.equal(r.unverified, true);
    const ev = r.evidence.find((e) => e.source === "heuristic");
    assert.equal(ev.verified, false);
    assert.equal(ev.heuristic, "fake-marker");
    assert.match(ev.detail, /unverified heuristic/);
    assert.match(r.warnings.join(), /heuristic broken failed: nope/);

    const lowered = await detectSdkManaged("x_acme_app", {
      heuristics: [
        { ...raising, run: async () => ({ raised: false, detail: "absent" }) },
      ],
    });
    assert.equal(lowered.managed, "unknown");
  });
  // Deterministic sources configured and not matching → no, the raised
  // heuristic stays evidence only.
  await withEnv(
    { ...ENV_OFF, SN_SDK_MANAGED_SCOPES: "x_declared" },
    async () => {
      const r = await detectSdkManaged("x_acme_app", { heuristics: [raising] });
      assert.equal(r.managed, "no");
      assert.ok(r.evidence.some((e) => e.source === "heuristic" && e.matched));
    },
  );
});

test("an incomplete scan never yields no", async () => {
  freshRuntime();
  const root = tmpRoot();
  project(root, "bad", "{ not json");
  await withEnv({ ...ENV_OFF, SN_SDK_PROJECT_DIRS: root }, async () => {
    const r = await detectSdkManaged({ scope: "x_a", sys_id: APP_ID });
    assert.equal(r.managed, "unknown");
    assert.match(r.warnings.join(), /SN_SDK_PROJECT_DIRS: .*now\.config\.json/);
  });
  freshRuntime();
  await withEnv(
    { ...ENV_OFF, SN_SDK_PROJECT_DIRS: path.join(root, "missing") },
    async () => {
      const r = await detectSdkManaged({ scope: "x_a", sys_id: APP_ID });
      assert.equal(r.managed, "unknown");
    },
  );
});

test("scan: bounded depth, skipped dirs, no symlinks, only now.config.json", () => {
  const root = tmpRoot();
  project(root, "a", { scope: "x_a", scopeId: APP_ID });
  project(root, "1/2/3/4", { scope: "x_depth4" });
  project(root, "1/2/3/4/5", { scope: "x_too_deep" });
  project(root, "node_modules/pkg", { scope: "x_dep" });
  project(root, ".hidden", { scope: "x_hidden" });
  project(root, "noscope", { name: "nothing" });
  project(root, "array", "[]");
  fs.writeFileSync(path.join(root, "a", "other.json"), "{}");

  // A symlinked directory and a symlinked config pointing outside the root.
  const outside = tmpRoot();
  project(outside, "escape", { scope: "x_outside" });
  fs.symlinkSync(path.join(outside, "escape"), path.join(root, "link"));
  fs.mkdirSync(path.join(root, "filelink"));
  fs.symlinkSync(
    path.join(outside, "escape", "now.config.json"),
    path.join(root, "filelink", "now.config.json"),
  );

  const scan = scanSdkProjects([root]);
  const scopes = scan.projects.map((p) => p.scope).sort();
  assert.deepEqual(scopes, ["x_a", "x_depth4"]);
  assert.equal(scan.truncated, false);
  assert.equal(scan.projects.find((p) => p.scope === "x_a").scopeId, APP_ID);
  assert.ok(scan.warnings.some((w) => /noscope.*no scope or scopeId/.test(w)));
  assert.ok(scan.warnings.some((w) => /array.*no scope or scopeId/.test(w)));

  // Oversized file and limits.
  const big = tmpRoot();
  project(big, "x", { scope: "x_big", pad: "y".repeat(64) });
  const tiny = { ...SDK_SCAN_LIMITS, maxFileBytes: 16 };
  assert.match(
    scanSdkProjects([big], tiny).warnings[0],
    /larger than 16 bytes/,
  );
  const fewDirs = scanSdkProjects([root], { ...SDK_SCAN_LIMITS, maxDirs: 2 });
  assert.equal(fewDirs.truncated, true);
  const fewConfigs = scanSdkProjects([root], {
    ...SDK_SCAN_LIMITS,
    maxConfigs: 1,
  });
  assert.equal(fewConfigs.truncated, true);
  assert.equal(fewConfigs.projects.length, 1);
  // A limit hit on the first root skips the rest.
  assert.equal(
    scanSdkProjects([root, big], { ...SDK_SCAN_LIMITS, maxDirs: 1 }).truncated,
    true,
  );

  // A file root, a missing root.
  const file = path.join(root, "a", "other.json");
  assert.match(scanSdkProjects([file]).warnings[0], /not a directory/);
  assert.match(
    scanSdkProjects([path.join(root, "gone")]).warnings[0],
    /ENOENT/,
  );
});

test("scan is cached in the runtime for the TTL", async () => {
  const root = tmpRoot();
  project(root, "a", { scope: "x_a" });
  freshRuntime();
  await withEnv({ ...ENV_OFF, SN_SDK_PROJECT_DIRS: root }, async () => {
    const first = sdkProjectScan(1_000);
    project(root, "b", { scope: "x_b" });
    assert.equal(sdkProjectScan(2_000), first, "served from the cache");
    assert.notEqual(sdkProjectScan(1_000 + SDK_SCAN_TTL_MS), first);
    assert.equal(sdkProjectScan(1_000 + SDK_SCAN_TTL_MS).projects.length, 2);
    clearSdkProjectScan();
    const again = sdkProjectScan();
    assert.equal(again.projects.length, 2);
    freshRuntime();
    assert.notEqual(sdkProjectScan(), again, "a new runtime rescans");
  });
});

test("SN_SDK_PROJECT_DIRS splits on commas and the path delimiter", async () => {
  await withEnv(
    { SN_SDK_PROJECT_DIRS: `a, b${path.delimiter}a ,, ` },
    async () => {
      assert.deepEqual(getSdkProjectDirs(), [
        path.resolve("a"),
        path.resolve("b"),
      ]);
    },
  );
  await withEnv({ SN_SDK_PROJECT_DIRS: "  " }, async () => {
    assert.deepEqual(getSdkProjectDirs(), []);
  });
});

test("get_status and check_capabilities list the detected SDK-managed scopes", async () => {
  freshRuntime();
  const root = tmpRoot();
  project(root, "a", { scope: "x_acme_app", scopeId: APP_ID });
  project(root, "b", { scope: "x_b" });
  await withEnv(
    {
      SN_SDK_MANAGED_SCOPES: `x_acme_app ${OTHER_ID}`,
      SN_SDK_PROJECT_DIRS: root,
    },
    async () => {
      const status = buildStatusPayload().sdkManaged;
      assert.deepEqual(status.declared, ["x_acme_app", OTHER_ID]);
      assert.deepEqual(status.projectDirs, [path.resolve(root)]);
      assert.deepEqual(
        status.scopes.map((s) => [s.scope, s.scopeId, s.sources.join("+")]),
        [
          ["x_acme_app", APP_ID, "declaration+now.config.json"],
          [null, OTHER_ID, "declaration"],
          ["x_b", null, "now.config.json"],
        ],
      );
      assert.match(status.heuristics, /unverified/);
      assert.match(status.authority, /O-6/);

      await withFetch(
        () => jsonResponse(200, { result: [{ sys_id: "1" }] }),
        async () => {
          const report = await checkCapabilities();
          assert.equal(report.sdkManaged.scopes.length, 3);
        },
      );
    },
  );
  freshRuntime();
  await withEnv(ENV_OFF, async () => {
    const empty = buildStatusPayload().sdkManaged;
    assert.deepEqual(empty.scopes, []);
    assert.deepEqual(empty.projectDirs, []);
  });
});
