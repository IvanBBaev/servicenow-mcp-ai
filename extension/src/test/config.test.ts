import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  buildServerEnv,
  credentialsEnv,
  definitionVersion,
  describeCredentials,
  expandEnvFilePath,
  normalizeSettings,
  parseStoredCredentials,
  settingsEnv,
  validateInstance,
  type StoredCredentials,
} from "../config";

const home = resolve("/home/ada");
const ws = resolve("/work/repo");

test("normalizeSettings defaults, trims, lower-cases and de-duplicates", () => {
  assert.deepEqual(normalizeSettings({}), {
    envFile: "",
    packages: [],
    transport: "stdio",
  });
  assert.deepEqual(
    normalizeSettings({
      envFile: "  ~/x.env ",
      packages: ["Core", " scripts", "core", "", 7],
      transport: "http",
    }),
    { envFile: "~/x.env", packages: ["core", "scripts"], transport: "http" },
  );
  assert.equal(normalizeSettings({ transport: "sse" }).transport, "stdio");
  assert.deepEqual(
    normalizeSettings({ packages: "core, flows docs" }).packages,
    ["core", "flows", "docs"],
  );
});

test("expandEnvFilePath expands ~, ${userHome}, ${workspaceFolder} and relative paths", () => {
  const ctx = { home, workspaceFolder: ws };
  assert.equal(expandEnvFilePath("", ctx), undefined);
  assert.equal(expandEnvFilePath("~", ctx), home);
  assert.equal(expandEnvFilePath("~/sn/.env", ctx), join(home, "sn/.env"));
  assert.equal(
    expandEnvFilePath("${userHome}/sn/.env", ctx),
    resolve(home, "sn/.env"),
  );
  assert.equal(
    expandEnvFilePath("${workspaceFolder}/.env.dev", ctx),
    resolve(ws, ".env.dev"),
  );
  assert.equal(expandEnvFilePath(".env.dev", ctx), resolve(ws, ".env.dev"));
  assert.equal(
    expandEnvFilePath(".env.dev", { home }),
    resolve(home, ".env.dev"),
  );
  assert.equal(
    expandEnvFilePath("${workspaceFolder}/.env", { home }),
    undefined,
  );
  const abs = resolve("/etc/sn.env");
  assert.equal(expandEnvFilePath(abs, ctx), abs);
});

test("settingsEnv maps envFile and packages and omits empty settings", () => {
  const ctx = { home };
  assert.deepEqual(
    settingsEnv({ envFile: "", packages: [], transport: "stdio" }, ctx),
    {},
  );
  assert.deepEqual(
    settingsEnv(
      { envFile: "~/.sn", packages: ["core", "flows"], transport: "stdio" },
      ctx,
    ),
    { SN_ENV_FILE: join(home, ".sn"), SN_TOOL_PACKAGES: "core,flows" },
  );
});

test("credentialsEnv pins SN_AUTH and the default profile per method", () => {
  const base = { instance: "dev1", secret: "s3cret" };
  assert.deepEqual(credentialsEnv({ ...base, method: "basic", user: "ada" }), {
    SN_INSTANCE: "dev1",
    SN_ACTIVE_PROFILE: "default",
    SN_AUTH: "basic",
    SN_USER: "ada",
    SN_PASSWORD: "s3cret",
  });
  assert.deepEqual(credentialsEnv({ ...base, method: "apikey" }), {
    SN_INSTANCE: "dev1",
    SN_ACTIVE_PROFILE: "default",
    SN_AUTH: "apikey",
    SN_API_KEY: "s3cret",
  });
  assert.deepEqual(
    credentialsEnv({ ...base, method: "oauth", clientId: "cid" }),
    {
      SN_INSTANCE: "dev1",
      SN_ACTIVE_PROFILE: "default",
      SN_AUTH: "oauth",
      SN_OAUTH_GRANT: "client_credentials",
      SN_OAUTH_CLIENT_ID: "cid",
      SN_OAUTH_CLIENT_SECRET: "s3cret",
    },
  );
  assert.deepEqual(credentialsEnv({ ...base, method: "token" }), {
    SN_INSTANCE: "dev1",
    SN_ACTIVE_PROFILE: "default",
    SN_AUTH: "token",
    SN_BEARER_TOKEN: "s3cret",
  });
});

test("buildServerEnv layers credentials over settings", () => {
  const settings = normalizeSettings({ packages: ["all"] });
  assert.deepEqual(buildServerEnv(settings, { home }, undefined), {
    SN_TOOL_PACKAGES: "all",
  });
  const env = buildServerEnv(
    settings,
    { home },
    {
      instance: "dev1",
      method: "apikey",
      secret: "k",
    },
  );
  assert.equal(env.SN_TOOL_PACKAGES, "all");
  assert.equal(env.SN_API_KEY, "k");
});

test("parseStoredCredentials accepts valid documents and rejects anything else", () => {
  const ok: StoredCredentials = {
    instance: "dev1",
    method: "basic",
    user: "ada",
    secret: "pw",
  };
  assert.deepEqual(parseStoredCredentials(JSON.stringify(ok)), ok);
  assert.deepEqual(
    parseStoredCredentials(
      JSON.stringify({
        instance: " dev1 ",
        method: "oauth",
        clientId: " c ",
        secret: "x",
      }),
    ),
    { instance: "dev1", method: "oauth", clientId: "c", secret: "x" },
  );
  for (const bad of [
    undefined,
    "",
    "not json",
    "null",
    "[]",
    JSON.stringify({ instance: "dev1", method: "basic", secret: "pw" }),
    JSON.stringify({ instance: "dev1", method: "oauth", secret: "pw" }),
    JSON.stringify({ instance: "dev1", method: "none", secret: "pw" }),
    JSON.stringify({ instance: "", method: "apikey", secret: "pw" }),
    JSON.stringify({ instance: "dev1", method: "apikey", secret: "" }),
  ]) {
    assert.equal(parseStoredCredentials(bad), undefined, String(bad));
  }
});

test("validateInstance accepts names, hosts and https URLs only", () => {
  for (const ok of [
    "dev1",
    "dev1.service-now.com",
    "https://dev1.service-now.com/",
  ]) {
    assert.equal(validateInstance(ok), undefined, ok);
  }
  for (const bad of ["", "   ", "dev 1", "http://dev1.service-now.com"]) {
    assert.equal(typeof validateInstance(bad), "string", bad);
  }
});

test("describeCredentials never includes the secret", () => {
  for (const method of ["basic", "apikey", "oauth", "token"] as const) {
    const text = describeCredentials({
      instance: "dev1",
      method,
      user: "ada",
      clientId: "cid",
      secret: "TOP-SECRET",
    });
    assert.ok(text.startsWith("dev1"));
    assert.ok(!text.includes("TOP-SECRET"));
  }
});

test("definitionVersion changes with settings, identity and revision — not with the secret", () => {
  const s = normalizeSettings({});
  const c: StoredCredentials = {
    instance: "dev1",
    method: "apikey",
    secret: "a",
  };
  const v = definitionVersion(s, c, 1);
  assert.match(v, /^[0-9a-f]{8}$/);
  assert.equal(definitionVersion(s, { ...c, secret: "b" }, 1), v);
  assert.notEqual(definitionVersion(s, c, 2), v);
  assert.notEqual(definitionVersion(s, undefined, 1), v);
  assert.notEqual(
    definitionVersion(normalizeSettings({ packages: ["all"] }), c, 1),
    v,
  );
  assert.notEqual(
    definitionVersion(normalizeSettings({ transport: "http" }), c, 1),
    v,
  );
});
