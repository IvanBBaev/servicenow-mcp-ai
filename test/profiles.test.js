import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

import {
  listProfiles,
  activeProfile,
  getCredentials,
  saveCredentials,
  useProfile,
} from "../build/core/config.js";
import { baselineEnv, withEnv } from "./helpers.js";

baselineEnv();

const DEV = {
  SN_PROFILE_DEV_INSTANCE: "dev1.service-now.com",
  SN_PROFILE_DEV_USER: "dev-user",
  SN_PROFILE_DEV_PASSWORD: "dev-pass",
};

test("the legacy keys are the 'default' profile (MI-1 back-compat)", () => {
  assert.deepEqual(listProfiles(), ["default"]);
  assert.equal(activeProfile(), "default");
  assert.equal(getCredentials().instance, "ven03019.service-now.com");
});

test("prefixed env keys define named profiles, default listed first", async () => {
  await withEnv(DEV, async () => {
    assert.deepEqual(listProfiles(), ["default", "dev"]);

    // Explicit profile read; the active profile is untouched.
    const dev = getCredentials("dev");
    assert.equal(dev.instance, "dev1.service-now.com");
    assert.equal(dev.user, "dev-user");
    assert.equal(getCredentials().user, "alice");

    // SN_ACTIVE_PROFILE switches what no-argument readers see.
    await withEnv({ SN_ACTIVE_PROFILE: "dev" }, () => {
      assert.equal(activeProfile(), "dev");
      assert.equal(getCredentials().user, "dev-user");
    });
  });
});

test("saveCredentials on a named profile writes prefixed keys only", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sincronia-prof-"));
  const envFile = path.join(dir, ".env");
  try {
    await withEnv({ SN_ENV_FILE: envFile, ...DEV }, async () => {
      saveCredentials({ user: "new-dev-user" }, "dev");
      assert.equal(getCredentials("dev").user, "new-dev-user");
      assert.equal(
        getCredentials("default").user,
        "alice",
        "default untouched",
      );

      const parsed = dotenv.parse(await fs.readFile(envFile, "utf8"));
      assert.equal(parsed.SN_PROFILE_DEV_USER, "new-dev-user");
      assert.equal(parsed.SN_USER, undefined, "bare keys must not be written");
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    baselineEnv();
  }
});

test("useProfile switches and persists; unknown/invalid names throw", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sincronia-prof-"));
  const envFile = path.join(dir, ".env");
  try {
    await withEnv({ SN_ENV_FILE: envFile, ...DEV }, async () => {
      const switched = useProfile("dev");
      assert.equal(switched.instance, "dev1.service-now.com");
      assert.equal(activeProfile(), "dev");
      assert.equal(getCredentials().user, "dev-user");

      const parsed = dotenv.parse(await fs.readFile(envFile, "utf8"));
      assert.equal(parsed.SN_ACTIVE_PROFILE, "dev");

      assert.throws(() => useProfile("prod"), /Unknown profile "prod"/);
      assert.throws(() => useProfile("Bad Name!"), /Invalid profile name/);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    baselineEnv();
  }
});
