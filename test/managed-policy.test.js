// N-108 (GV-I1): the managed policy file — floors the user can only tighten,
// the host → environment map, and fail-closed loading.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  managedPolicySummary,
  osPolicyPath,
  parseManagedPolicy,
} from "../build/core/managed-policy.js";
import {
  applySettingsAtStartup,
  settingSource,
} from "../build/core/settings-manifest.js";
import {
  getDeniedTables,
  getAllowedTables,
  isReadOnly,
  protectedTablesWrite,
} from "../build/core/policy.js";
import {
  getDestructiveConfirm,
  getMaxDeletesPerSession,
  getMaxWritesPerSession,
  getProfileEnv,
} from "../build/core/settings.js";
import { policyPayload } from "../build/mcp/policy-view.js";
import { baselineEnv, freshRuntime, withEnv } from "./helpers.js";

baselineEnv();

async function withPolicy(policy, env, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "snmcp-n108-"));
  const file = path.join(dir, "policy.json");
  writeFileSync(
    file,
    typeof policy === "string" ? policy : JSON.stringify(policy),
  );
  freshRuntime();
  try {
    await withEnv({ SN_MANAGED_POLICY_FILE: file, ...env }, () => fn(file));
  } finally {
    freshRuntime();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a managed flag locks read-only on; the user cannot turn it off", async () => {
  await withPolicy(
    { settings: { SN_READONLY: true } },
    { SN_READONLY: "false" },
    (file) => {
      assert.equal(isReadOnly(), true);
      assert.match(String(settingSource("SN_READONLY")), /policy\.json/);
      assert.ok(file);
    },
  );
  await withPolicy({ disableWrites: true }, {}, () => {
    assert.equal(isReadOnly(), true);
  });
  // `false` locks nothing.
  await withPolicy({ settings: { SN_READONLY: false } }, {}, () => {
    assert.equal(isReadOnly(), false);
  });
});

test("ordered settings take the stricter value", async () => {
  await withPolicy(
    {
      settings: {
        SN_DESTRUCTIVE_CONFIRM: "token",
        SN_PROTECTED_TABLES_WRITE: "confirm",
      },
    },
    { SN_DESTRUCTIVE_CONFIRM: "off", SN_PROTECTED_TABLES_WRITE: "deny" },
    () => {
      assert.equal(getDestructiveConfirm(), "token");
      // The user's stricter choice stays.
      assert.equal(protectedTablesWrite(), "deny");
    },
  );
  await withPolicy(
    { settings: { SN_DESTRUCTIVE_CONFIRM: "token" } },
    { SN_DESTRUCTIVE_CONFIRM: "elicit" },
    () => assert.equal(getDestructiveConfirm(), "elicit"),
  );
});

test("deny lists are unioned and allowlists replaced", async () => {
  await withPolicy(
    {
      settings: {
        SN_TABLES_DENY: ["sys_user", "sys_properties"],
        SN_TABLES_ALLOW: "incident",
      },
    },
    { SN_TABLES_DENY: "cmdb_ci", SN_TABLES_ALLOW: "incident,problem" },
    () => {
      assert.deepEqual([...getDeniedTables()].sort(), [
        "cmdb_ci",
        "sys_properties",
        "sys_user",
      ]);
      assert.deepEqual(getAllowedTables(), ["incident"]);
    },
  );
});

test("a managed cap wins over no cap and a looser cap, not a tighter one", async () => {
  await withPolicy(
    {
      settings: {
        SN_MAX_WRITES_PER_SESSION: 10,
        SN_MAX_DELETES_PER_SESSION: 5,
      },
    },
    { SN_MAX_WRITES_PER_SESSION: "0", SN_MAX_DELETES_PER_SESSION: "3" },
    () => {
      assert.equal(getMaxWritesPerSession(), 10);
      assert.equal(getMaxDeletesPerSession(), 3);
    },
  );
  await withPolicy(
    { settings: { SN_MAX_DELETES_PER_SESSION: 5 } },
    { SN_MAX_DELETES_PER_SESSION: "50" },
    () => assert.equal(getMaxDeletesPerSession(), 5),
  );
});

test("the environment map marks a host prod over SN_ENV", async () => {
  await withPolicy(
    {
      environments: {
        "dev00000.service-now.com": "test",
        "*.service-now.com": "prod",
      },
    },
    { SN_ENV: "dev" },
    () => assert.equal(getProfileEnv(), "test"),
  );
  await withPolicy(
    { environments: { "dev?????.service-now.com": "prod" } },
    { SN_ENV: "dev" },
    () => {
      assert.equal(getProfileEnv(), "prod");
      assert.equal(getDestructiveConfirm(), "elicit");
      const summary = managedPolicySummary();
      assert.deepEqual(summary.locked, ["SN_ENV"]);
      assert.equal(policyPayload().managed.locked[0], "SN_ENV");
    },
  );
  await withPolicy(
    { environments: { "acme.service-now.com": "prod" } },
    { SN_ENV: "dev" },
    () => assert.equal(getProfileEnv(), "dev"),
  );
});

test("an invalid file stops startup (fail closed)", async () => {
  for (const bad of [
    "{ not json",
    { settings: { SN_LOG_LEVEL: "debug" } },
    { settings: { SN_DESTRUCTIVE_CONFIRM: "sometimes" } },
    { unknown: true },
    { environments: { "*.service-now.com": "staging" } },
  ]) {
    await withPolicy(bad, {}, () => {
      assert.throws(
        () => applySettingsAtStartup(process.env),
        (e) => e.code === "MANAGED_POLICY_INVALID",
      );
      assert.throws(() => isReadOnly(), /Managed policy/);
    });
  }
});

test("no managed file: nothing changes and nothing is reported", async () => {
  freshRuntime();
  await withEnv({ SN_MANAGED_POLICY_FILE: undefined }, () => {
    assert.equal(managedPolicySummary(), undefined);
    assert.equal(policyPayload().managed, undefined);
    assert.equal(isReadOnly(), false);
  });
});

test("the OS path per platform", () => {
  assert.equal(osPolicyPath("linux"), "/etc/servicenow-mcp-ai/policy.json");
  assert.equal(
    osPolicyPath("darwin"),
    "/Library/Application Support/servicenow-mcp-ai/policy.json",
  );
  assert.equal(
    osPolicyPath("win32", "D:\\Data"),
    "D:\\Data\\servicenow-mcp-ai\\policy.json",
  );
  assert.equal(
    osPolicyPath("win32", undefined),
    "C:\\ProgramData\\servicenow-mcp-ai\\policy.json",
  );
});

test("parseManagedPolicy normalises lists and lowercases host patterns", () => {
  const p = parseManagedPolicy(
    JSON.stringify({
      settings: { SN_REDACT_FIELDS: ["a", "b"] },
      environments: { "ACME.service-now.com": "prod" },
    }),
    "x.json",
  );
  assert.equal(p.settings.get("SN_REDACT_FIELDS"), "a,b");
  assert.deepEqual(p.environments, [["acme.service-now.com", "prod"]]);
});
