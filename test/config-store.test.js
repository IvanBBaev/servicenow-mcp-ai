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
