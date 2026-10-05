// H-2 — credential host binding for servicenow_set_credentials: a host change
// must carry the auth material meant for the new host, the confirmation fails
// closed on clients that cannot ask, and every identity-scoped cache is
// dropped after an accepted change. Complements the X-2 elicitation test in
// mcp-smoke.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv as parseEnvFile } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { ALL_TOOLS } from "../build/mcp/registry.js";
import { runSpec } from "../build/mcp/define.js";
import { getCredentials, envFileAclWarning } from "../build/core/config.js";
import { resolveHost } from "../build/core/host.js";
import { cached } from "../build/core/cache.js";
import { getAuthProvider } from "../build/core/auth.js";
import { pluginCall, pluginAvailability } from "../build/api/plugin.js";
import { ServiceNowError } from "../build/core/errors.js";
import { allowUnconfirmedCredentialChange } from "../build/core/settings.js";
import { setServer } from "../build/mcp/context.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

// E-2: Node's env-file parser (dotenv's replacement); a plain object, since
// Node 26 returns a null-prototype one that deepStrictEqual would reject.
const parseEnv = (text) => ({ ...parseEnvFile(text) });

baselineEnv();

const spec = ALL_TOOLS.find((s) => s.name === "servicenow_set_credentials");
const setCredentials = (args) => runSpec(spec, args);
const payload = (res) => JSON.parse(res.content[0].text);
const errorMessage = (res) => payload(res).error;
// M-2: the fix travels in `hint`, the stable identifier in `code`.
const errorHint = (res) => payload(res).hint ?? "";

const BASELINE = {
  instance: "dev00000.service-now.com",
  user: "alice",
  password: "s3cret",
};

/**
 * Run `fn` against a throw-away env file with the baseline credentials in
 * place. Every key the tool may write is listed so withEnv restores it; `env`
 * adds per-test overrides (undefined deletes a key).
 */
async function withScratchStore(env, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "servicenow-mcp-h2-"));
  const envFile = path.join(dir, ".env");
  try {
    await withEnv(
      {
        SN_ENV_FILE: envFile,
        // H-5: the credential change is journalled — keep it out of the repo.
        SN_DOCS_DIR: dir,
        SN_INSTANCE: BASELINE.instance,
        SN_USER: BASELINE.user,
        SN_PASSWORD: BASELINE.password,
        SN_ACTIVE_PROFILE: undefined,
        SN_PROFILE_FRESH_INSTANCE: undefined,
        SN_PROFILE_FRESH_USER: undefined,
        SN_PROFILE_FRESH_PASSWORD: undefined,
        SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE: undefined,
        ...env,
      },
      () => fn(envFile),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    baselineEnv();
  }
}

const savedFile = async (envFile) =>
  existsSync(envFile) ? parseEnv(await fs.readFile(envFile, "utf8")) : null;

/** The store still holds the baseline and nothing reached the env file. */
async function assertUntouched(envFile) {
  const current = getCredentials();
  assert.equal(current.instance, BASELINE.instance);
  assert.equal(current.user, BASELINE.user);
  assert.equal(current.password, BASELINE.password);
  assert.equal(await savedFile(envFile), null, "env file must not be written");
}

/**
 * A live server/client pair over an in-memory transport so getServer() sees
 * real client capabilities. `onElicit` answers elicitation requests (only
 * wired when the client declares the capability).
 */
async function connectedServer(clientCapabilities, onElicit) {
  const server = new McpServer({ name: "h2-test", version: "0.0.0" });
  setServer(server);
  const client = new Client(
    { name: "h2-client", version: "0.0.0" },
    { capabilities: clientCapabilities },
  );
  if (clientCapabilities.elicitation && onElicit) {
    client.setRequestHandler(ElicitRequestSchema, onElicit);
  }
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    close: async () => {
      setServer(null);
      await client.close();
      await server.close();
    },
  };
}

test("H-2: an instance-only change on a configured profile is refused with CREDENTIALS_INCOMPLETE and touches nothing", async () => {
  await withScratchStore(
    { SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE: "1" },
    async (envFile) => {
      const attempts = [
        { instance: "dev99999" },
        { instance: "dev99999", user: "bob" },
        {
          instance: "https://dev99999.service-now.com/nav_to.do",
          password: "new-secret-value",
        },
      ];
      for (const args of attempts) {
        const res = await setCredentials(args);
        assert.equal(res.isError, true, JSON.stringify(args));
        const message = errorMessage(res);
        assert.equal(payload(res).code, "CREDENTIALS_INCOMPLETE");
        assert.equal(payload(res).source, "policy");
        assert.match(message, /"default"/);
        assert.match(message, /dev99999\.service-now\.com/);
        assert.doesNotMatch(message, /new-secret-value|s3cret/);
      }
      await assertUntouched(envFile);
    },
  );
});

test("H-2: instance + user + password in one call moves the profile to the new host", async () => {
  await withScratchStore(
    { SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE: "1" },
    async (envFile) => {
      const res = await setCredentials({
        instance: "dev99999.service-now.com",
        user: "bob",
        password: "pw-for-dev99999",
      });
      assert.equal(res.isError, undefined, JSON.stringify(res));
      assert.deepEqual(payload(res), {
        message: "Credentials saved",
        profile: "default",
        instance: "dev99999.service-now.com",
        user: "bob",
        password: "***",
        auth: "basic",
        configured: true,
        // L2-11: set_credentials adds the env-file ACL warning on win32.
        ...(envFileAclWarning() ? { warnings: [envFileAclWarning()] } : {}),
      });
      const stored = getCredentials();
      assert.equal(stored.instance, "dev99999.service-now.com");
      assert.equal(stored.user, "bob");
      assert.equal(stored.password, "pw-for-dev99999");
      const file = await savedFile(envFile);
      assert.equal(file.SN_INSTANCE, "dev99999.service-now.com");
      assert.equal(file.SN_USER, "bob");
      assert.equal(file.SN_PASSWORD, "pw-for-dev99999");
    },
  );
});

test("H-2: same-instance updates of user or password alone stay allowed", async () => {
  await withScratchStore(
    { SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE: "1" },
    async (envFile) => {
      let res = await setCredentials({ user: "bob" });
      assert.equal(res.isError, undefined, JSON.stringify(res));
      assert.equal(getCredentials().user, "bob");
      assert.equal(getCredentials().instance, BASELINE.instance);

      res = await setCredentials({ password: "rotated" });
      assert.equal(res.isError, undefined, JSON.stringify(res));
      assert.equal(getCredentials().password, "rotated");

      // Re-spelling the same host (case, short form) is not a host change.
      res = await setCredentials({ instance: "DEV00000" });
      assert.equal(res.isError, undefined, JSON.stringify(res));
      assert.equal(
        resolveHost(getCredentials().instance).toLowerCase(),
        BASELINE.instance,
      );
      assert.equal(getCredentials().user, "bob");
      assert.equal(getCredentials().password, "rotated");

      const file = await savedFile(envFile);
      assert.equal(file.SN_USER, "bob");
      assert.equal(file.SN_PASSWORD, "rotated");
    },
  );
});

test("H-2: a first-time set with the instance alone is allowed (nothing stored yet)", async () => {
  await withScratchStore(
    { SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE: "1" },
    async (envFile) => {
      const res = await setCredentials({
        instance: "dev55555.service-now.com",
        profile: "fresh",
      });
      assert.equal(res.isError, undefined, JSON.stringify(res));
      assert.equal(payload(res).profile, "fresh");
      assert.equal(
        getCredentials("fresh").instance,
        "dev55555.service-now.com",
      );
      // The active profile is neither switched nor modified.
      const current = getCredentials();
      assert.equal(current.instance, BASELINE.instance);
      assert.equal(current.user, BASELINE.user);
      assert.equal(current.password, BASELINE.password);
      const file = await savedFile(envFile);
      assert.equal(file.SN_PROFILE_FRESH_INSTANCE, "dev55555.service-now.com");
    },
  );
});

test("H-2: without a client that can confirm, the change is refused unless the operator opted out", async () => {
  await withScratchStore({}, async (envFile) => {
    setServer(null);
    const res = await setCredentials({ user: "bob" });
    assert.equal(res.isError, true);
    assert.match(errorMessage(res), /cannot confirm/);
    assert.match(errorHint(res), /SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE=1/);
    assert.equal(payload(res).code, "CREDENTIALS_UNCONFIRMED");
    await assertUntouched(envFile);

    for (const value of ["0", "false", "off", ""]) {
      await withEnv(
        { SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE: value },
        async () => {
          assert.equal(allowUnconfirmedCredentialChange(), false, value);
          const refused = await setCredentials({ user: "bob" });
          assert.equal(refused.isError, true, JSON.stringify(value));
        },
      );
    }
    await assertUntouched(envFile);

    for (const value of ["1", "true", "YES", " on "]) {
      await withEnv({ SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE: value }, () => {
        assert.equal(allowUnconfirmedCredentialChange(), true, value);
      });
    }
    await withEnv(
      { SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE: "true" },
      async () => {
        const accepted = await setCredentials({ user: "bob" });
        assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
        assert.equal(getCredentials().user, "bob");
        assert.equal((await savedFile(envFile)).SN_USER, "bob");
      },
    );
  });
});

test("H-2: a connected client without the elicitation capability is refused (fail closed)", async () => {
  await withScratchStore({}, async (envFile) => {
    const { close } = await connectedServer({}, null);
    try {
      const res = await setCredentials({ user: "bob" });
      assert.equal(res.isError, true);
      assert.match(errorMessage(res), /no elicitation support/);
      assert.match(errorHint(res), /SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE=1/);
      await assertUntouched(envFile);

      await withEnv(
        { SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE: "1" },
        async () => {
          const accepted = await setCredentials({ user: "bob" });
          assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
          assert.equal(getCredentials().user, "bob");
        },
      );
    } finally {
      await close();
    }
  });
});

test("H-2: an explicit decline is refused even with the opt-out; a prompt error fails closed without it", async () => {
  await withScratchStore({}, async (envFile) => {
    let answer = { action: "decline" };
    const { close } = await connectedServer({ elicitation: {} }, async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    try {
      // Decline and a non-confirming accept: refused regardless of the opt-out.
      await withEnv(
        { SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE: "1" },
        async () => {
          for (const reply of [
            { action: "decline" },
            { action: "cancel" },
            { action: "accept", content: { confirm: false } },
          ]) {
            answer = reply;
            const res = await setCredentials({ user: "bob" });
            assert.equal(res.isError, true, JSON.stringify(reply));
            assert.match(errorMessage(res), /not confirmed/);
            assert.equal(payload(res).code, "CREDENTIALS_UNCONFIRMED");
          }
          await assertUntouched(envFile);
        },
      );

      // A protocol-level failure of the prompt: closed without the opt-out…
      answer = new Error("elicitation exploded");
      const failed = await setCredentials({ user: "bob" });
      assert.equal(failed.isError, true);
      assert.match(errorMessage(failed), /confirmation prompt failed/);
      assert.match(
        errorHint(failed),
        /SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE=1/,
      );
      await assertUntouched(envFile);

      // …and open with it.
      await withEnv(
        { SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE: "1" },
        async () => {
          const accepted = await setCredentials({ user: "bob" });
          assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
          assert.equal(getCredentials().user, "bob");
        },
      );

      // A confirmed accept needs no opt-out at all.
      answer = { action: "accept", content: { confirm: true } };
      const confirmed = await setCredentials({ password: "rotated" });
      assert.equal(confirmed.isError, undefined, JSON.stringify(confirmed));
      assert.equal(getCredentials().password, "rotated");
      assert.equal((await savedFile(envFile)).SN_PASSWORD, "rotated");
    } finally {
      await close();
    }
  });
});

test("H-2: an accepted change drops the schema cache, cached OAuth tokens and plugin availability", async () => {
  await withScratchStore(
    {
      SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE: "1",
      SN_AUTH: "oauth",
      SN_OAUTH_CLIENT_ID: "client-id",
      SN_OAUTH_CLIENT_SECRET: "client-secret",
      SN_OAUTH_GRANT: "client_credentials",
      SN_SCHEMA_CACHE_TTL_SEC: undefined,
    },
    async () => {
      setServer(null);

      // Seed the schema cache: the second reader must see the first value.
      assert.equal(await cached("h2:schema", async () => "first"), "first");
      assert.equal(await cached("h2:schema", async () => "second"), "first");

      // Seed the plugin-availability cache with a namespace 404.
      await assert.rejects(
        pluginCall("H2Plugin", async () => {
          throw new ServiceNowError(
            "Requested URI does not represent any resource",
            404,
          );
        }),
      );
      assert.equal(pluginAvailability().H2Plugin, "unavailable");

      await withFetch(
        async (url) => {
          assert.match(url, /\/oauth_token\.do$/);
          return jsonResponse(200, {
            access_token: "tok",
            token_type: "Bearer",
            expires_in: 3600,
          });
        },
        async (calls) => {
          const provider = getAuthProvider();
          assert.equal(provider.mode, "oauth");
          const headers = await provider.headers(BASELINE.instance);
          assert.ok(Object.values(headers).includes("Bearer tok"));
          await provider.headers(BASELINE.instance);
          assert.equal(calls.length, 1, "the token is cached");

          const res = await setCredentials({ password: "rotated" });
          assert.equal(res.isError, undefined, JSON.stringify(res));

          await getAuthProvider().headers(BASELINE.instance);
          assert.equal(
            calls.length,
            2,
            "the credential change invalidated the cached token",
          );
          assert.equal(
            await cached("h2:schema", async () => "second"),
            "second",
            "the schema cache was cleared",
          );
          assert.equal(
            pluginAvailability().H2Plugin,
            undefined,
            "the plugin-availability cache was cleared",
          );
        },
      );
    },
  );
});
