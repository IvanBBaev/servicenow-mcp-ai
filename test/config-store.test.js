import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

import {
  getCredentials,
  saveCredentials,
  reloadCredentialsFromEnv,
  hasCredentials,
  loadEnv,
  getEnvPath,
} from "../build/core/config.js";
import { baselineEnv, withEnv } from "./helpers.js";

baselineEnv();

test("getCredentials returns an atomic snapshot, not a live env view", () => {
  reloadCredentialsFromEnv();
  const before = getCredentials();
  assert.equal(before.user, "alice");

  // A direct env mutation (without reload) must NOT leak into readers —
  // that is the store contract; tests stage env via the helpers instead.
  process.env.SN_PASSWORD = "changed-behind-the-back";
  assert.equal(getCredentials().password, "s3cret");

  // An explicit reload picks it up.
  reloadCredentialsFromEnv();
  assert.equal(getCredentials().password, "changed-behind-the-back");

  baselineEnv();
});

test("the snapshot is a copy — mutating it cannot poison the store", () => {
  const snap = getCredentials();
  snap.user = "mallory";
  assert.equal(getCredentials().user, "alice");
});

test("hasCredentials is true only when instance+user+password are all set (QA-1)", async () => {
  baselineEnv();
  assert.equal(hasCredentials(), true);

  // Each missing field flips it to false.
  for (const drop of ["SN_INSTANCE", "SN_USER", "SN_PASSWORD"]) {
    await withEnv({ [drop]: undefined }, () => {
      assert.equal(hasCredentials(), false, `${drop} missing → no credentials`);
    });
  }

  // A named profile is judged independently of the default.
  await withEnv(
    {
      SN_PROFILE_DEV_INSTANCE: "dev.service-now.com",
      SN_PROFILE_DEV_USER: "dev",
      SN_PROFILE_DEV_PASSWORD: "p",
    },
    () => assert.equal(hasCredentials("dev"), true),
  );
  await withEnv(
    {
      SN_PROFILE_DEV_INSTANCE: "dev.service-now.com",
      SN_PROFILE_DEV_USER: "dev",
    },
    () =>
      assert.equal(
        hasCredentials("dev"),
        false,
        "a profile missing its password has no credentials",
      ),
  );
  baselineEnv();
});

test("loadEnv reads SN_ENV_FILE, stays env-first, and tolerates a missing file (QA-7/QA-8)", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "servicenow-mcp-loadenv-"),
  );
  const envFile = path.join(dir, ".env");
  await fs.writeFile(
    envFile,
    "SN_INSTANCE=fromfile.service-now.com\nSN_USER=filealice\nSN_PASSWORD=filepw\n",
  );
  const savedEnvFile = process.env.SN_ENV_FILE;
  try {
    // getEnvPath honours the explicit override without touching the filesystem.
    process.env.SN_ENV_FILE = envFile;
    assert.equal(getEnvPath(), envFile);

    // With those keys absent from the environment, loadEnv brings them in.
    delete process.env.SN_INSTANCE;
    delete process.env.SN_USER;
    delete process.env.SN_PASSWORD;
    loadEnv();
    assert.equal(getCredentials().instance, "fromfile.service-now.com");
    assert.equal(getCredentials().user, "filealice");

    // override:false — a value already in the environment beats the file.
    process.env.SN_USER = "envwins";
    loadEnv();
    assert.equal(getCredentials().user, "envwins");

    // A missing env file must not throw.
    process.env.SN_ENV_FILE = path.join(dir, "nope.env");
    assert.doesNotThrow(() => loadEnv());
  } finally {
    if (savedEnvFile === undefined) delete process.env.SN_ENV_FILE;
    else process.env.SN_ENV_FILE = savedEnvFile;
    await fs.rm(dir, { recursive: true, force: true });
    baselineEnv();
  }
});

test("saveCredentials persists, updates env and swaps the snapshot at once", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "servicenow-mcp-env-"));
  const envFile = path.join(dir, ".env");
  try {
    await withEnv({ SN_ENV_FILE: envFile }, async () => {
      const updated = saveCredentials({ user: "bob", password: "n3w" });
      // The returned snapshot is the new state; instance is preserved.
      assert.equal(updated.user, "bob");
      assert.equal(updated.instance, "ven03019.service-now.com");
      assert.equal(getCredentials().password, "n3w");

      // Persisted to the env file in dotenv round-trippable form.
      const parsed = dotenv.parse(await fs.readFile(envFile, "utf8"));
      assert.equal(parsed.SN_USER, "bob");
      assert.equal(parsed.SN_PASSWORD, "n3w");
      assert.equal(parsed.SN_INSTANCE, undefined, "untouched keys stay absent");
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    baselineEnv();
  }
});
