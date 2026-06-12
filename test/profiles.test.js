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
import { createRecord, ServiceNowError } from "../build/api/table.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "servicenow-mcp-prof-"));
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

test("per-profile policy: prod read-only, dev writes (MI-2)", async () => {
  const PROD = {
    SN_PROFILE_PROD_INSTANCE: "prod1.service-now.com",
    SN_PROFILE_PROD_USER: "prod-user",
    SN_PROFILE_PROD_PASSWORD: "prod-pass",
    SN_PROFILE_PROD_READONLY: "true",
  };

  // prod active: writes refused before any network call.
  await withEnv({ ...DEV, ...PROD, SN_ACTIVE_PROFILE: "prod" }, () =>
    withFetch(
      () => {
        throw new Error("no fetch in read-only profile");
      },
      async (calls) => {
        await assert.rejects(
          createRecord("incident", { short_description: "x" }),
          (err) => err instanceof ServiceNowError && err.status === 403,
        );
        assert.equal(calls.length, 0);
      },
    ),
  );

  // dev active: the global SN_READONLY is overridden per profile to allow writes.
  await withEnv(
    {
      ...DEV,
      SN_READONLY: "true",
      SN_PROFILE_DEV_READONLY: "false",
      SN_ACTIVE_PROFILE: "dev",
    },
    () =>
      withFetch(
        (url) => {
          assert.match(url, /dev1\.service-now\.com/);
          return jsonResponse(201, { result: { sys_id: "new1" } });
        },
        async (calls) => {
          const rec = await createRecord("incident", { a: "1" });
          assert.equal(rec.sys_id, "new1");
          assert.equal(calls.length, 1);
        },
      ),
  );
});

test("the automatic instance argument routes a single call (MI-3)", async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } =
    await import("@modelcontextprotocol/sdk/inMemory.js");
  const { registerAllTools } = await import("../build/mcp/registry.js");

  await withEnv({ ...DEV, SN_TOOL_PACKAGES: undefined }, async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerAllTools(server);
    const client = new Client({ name: "c", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      await withFetch(
        (url) => {
          const host = new URL(url).host;
          return jsonResponse(200, { result: [{ host }] });
        },
        async (calls) => {
          // Explicit profile → dev host; the active profile stays default.
          const dev = await client.callTool({
            name: "servicenow_query_table",
            arguments: { table: "incident", instance: "dev", limit: 1 },
          });
          assert.ok(!dev.isError);
          assert.match(calls[0].url, /dev1\.service-now\.com/);

          const def = await client.callTool({
            name: "servicenow_query_table",
            arguments: { table: "incident", limit: 1 },
          });
          assert.ok(!def.isError);
          assert.match(calls[1].url, /ven03019\.service-now\.com/);

          // Unknown profile → clear failure, no network.
          const bad = await client.callTool({
            name: "servicenow_query_table",
            arguments: { table: "incident", instance: "prod" },
          });
          assert.ok(bad.isError);
          assert.match(bad.content[0].text, /Unknown connection profile/);
          assert.equal(calls.length, 2);
        },
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("useProfile switches and persists; unknown/invalid names throw", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "servicenow-mcp-prof-"));
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
