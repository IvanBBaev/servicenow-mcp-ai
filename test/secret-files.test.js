// D-5 / L2-12: <KEY>_FILE secret sources — resolution matrix per secret class
// (global and per-profile), the <KEY> / <KEY>_FILE conflict, unreadable and
// empty files (the error names the setting, never the content), the env-file
// writer guard and the one-line startup error of the real entry point.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isSecretFileKey,
  readSecretFile,
  resolveSecretFiles,
  secretFileSourceFor,
} from "../build/core/secret-files.js";
import {
  getCredentials,
  loadEnv,
  persistEnv,
  saveCredentials,
} from "../build/core/config.js";
import { authEnv } from "../build/core/auth.js";
import { getHttpToken } from "../build/core/settings.js";
import { baselineEnv, withEnv } from "./helpers.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "sn-secret-files-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
/** Write `content` to a fresh file in the sandbox and return its path. */
function secretFile(content) {
  const path = join(dir, `secret-${++n}`);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

const GLOBAL_KEYS = [
  "SN_PASSWORD",
  "SN_API_KEY",
  "SN_BEARER_TOKEN",
  "SN_OAUTH_CLIENT_SECRET",
  "SN_OAUTH_REFRESH_TOKEN",
  "SN_HTTP_TOKEN",
];
const PROFILE_KEYS = [
  "SN_PROFILE_PROD_PASSWORD",
  "SN_PROFILE_PROD_API_KEY",
  "SN_PROFILE_PROD_BEARER_TOKEN",
  "SN_PROFILE_PROD_OAUTH_CLIENT_SECRET",
  "SN_PROFILE_PROD_OAUTH_REFRESH_TOKEN",
  "SN_PROFILE_MY_ORG_2_PASSWORD",
];

test("isSecretFileKey: every secret class and profile form, never the existing file settings", () => {
  for (const key of [...GLOBAL_KEYS, ...PROFILE_KEYS]) {
    assert.equal(isSecretFileKey(`${key}_FILE`), true, key);
  }
  for (const key of [
    "SN_TOKEN_FILE",
    "SN_OAUTH_JWT_KEY_FILE",
    "SN_PROFILE_PROD_OAUTH_JWT_KEY_FILE",
    "SN_TLS_CLIENT_CERT_FILE",
    "SN_TLS_CLIENT_KEY_FILE",
    "SN_TLS_CA_FILE",
    "SN_ENV_FILE",
    "SN_USER_FILE",
    "SN_INSTANCE_FILE",
    "SN_PROFILE_PROD_HTTP_TOKEN_FILE",
    "SN_PASSWORD",
  ]) {
    assert.equal(isSecretFileKey(key), false, key);
  }
});

test("resolveSecretFiles: each class loads from its file, one trailing newline trimmed", () => {
  for (const key of [...GLOBAL_KEYS, ...PROFILE_KEYS]) {
    const env = { [`${key}_FILE`]: secretFile(`v-${key}\n`) };
    assert.deepEqual(resolveSecretFiles(env), [key]);
    assert.equal(env[key], `v-${key}`, key);
  }
});

test("readSecretFile: trims exactly one \\n or \\r\\n, keeps other whitespace", () => {
  assert.equal(readSecretFile("K_FILE", secretFile("abc")), "abc");
  assert.equal(readSecretFile("K_FILE", secretFile("abc\r\n")), "abc");
  assert.equal(readSecretFile("K_FILE", secretFile("abc\n\n")), "abc\n");
  assert.equal(readSecretFile("K_FILE", secretFile(" a b \n")), " a b ");
});

test("resolveSecretFiles: both <KEY> and <KEY>_FILE set fails fast naming the pair", () => {
  const env = {
    SN_PASSWORD: "inline",
    SN_PASSWORD_FILE: secretFile("fromfile\n"),
  };
  assert.throws(
    () => resolveSecretFiles(env),
    (error) =>
      /Both SN_PASSWORD and SN_PASSWORD_FILE are set/.test(error.message) &&
      !error.message.includes("fromfile") &&
      !error.message.includes("inline"),
  );
  const profileEnv = {
    SN_PROFILE_PROD_API_KEY: "inline",
    SN_PROFILE_PROD_API_KEY_FILE: secretFile("k"),
  };
  assert.throws(
    () => resolveSecretFiles(profileEnv),
    /Both SN_PROFILE_PROD_API_KEY and SN_PROFILE_PROD_API_KEY_FILE are set/,
  );
});

test("resolveSecretFiles: an empty <KEY> or an empty <KEY>_FILE is not a conflict", () => {
  const env = { SN_PASSWORD: "", SN_PASSWORD_FILE: secretFile("pw") };
  resolveSecretFiles(env);
  assert.equal(env.SN_PASSWORD, "pw");
  const unset = { SN_API_KEY: "inline", SN_API_KEY_FILE: "  " };
  assert.deepEqual(resolveSecretFiles(unset), []);
  assert.equal(unset.SN_API_KEY, "inline");
});

test("resolveSecretFiles: a repeated resolve is not a conflict and re-reads the file", () => {
  const path = secretFile("one\n");
  const env = { SN_BEARER_TOKEN_FILE: path };
  resolveSecretFiles(env);
  assert.equal(env.SN_BEARER_TOKEN, "one");
  writeFileSync(path, "two\n");
  resolveSecretFiles(env);
  assert.equal(env.SN_BEARER_TOKEN, "two");
  // A value changed by someone else afterwards is a real conflict again.
  env.SN_BEARER_TOKEN = "hand-set";
  assert.throws(() => resolveSecretFiles(env), /Both SN_BEARER_TOKEN/);
});

test("resolveSecretFiles: a missing file errors with the setting and path, not content", () => {
  const missing = join(dir, "no-such-secret");
  assert.throws(
    () => resolveSecretFiles({ SN_OAUTH_CLIENT_SECRET_FILE: missing }),
    (error) =>
      error.message.includes("Cannot read SN_OAUTH_CLIENT_SECRET_FILE") &&
      error.message.includes(missing) &&
      error.message.includes("ENOENT"),
  );
  // A directory is unreadable as a file too.
  assert.throws(
    () => resolveSecretFiles({ SN_HTTP_TOKEN_FILE: dir }),
    /Cannot read SN_HTTP_TOKEN_FILE/,
  );
});

test("resolveSecretFiles: an empty file is an error", () => {
  assert.throws(
    () => resolveSecretFiles({ SN_PASSWORD_FILE: secretFile("\n") }),
    /SN_PASSWORD_FILE \(.+\) is empty/,
  );
});

test("secretFileSourceFor names the _FILE setting only when it is set", () => {
  assert.equal(
    secretFileSourceFor("SN_PASSWORD", { SN_PASSWORD_FILE: "/x" }),
    "SN_PASSWORD_FILE",
  );
  assert.equal(secretFileSourceFor("SN_PASSWORD", {}), undefined);
  assert.equal(
    secretFileSourceFor("SN_USER", { SN_USER_FILE: "/x" }),
    undefined,
  );
});

test("loadEnv wires _FILE sources into credentials, auth and the HTTP token", async () => {
  await withEnv(
    {
      SN_ENV_FILE: join(dir, "absent.env"),
      SN_PASSWORD: undefined,
      SN_PASSWORD_FILE: secretFile("pw-from-file\n"),
      SN_HTTP_TOKEN: undefined,
      SN_HTTP_TOKEN_FILE: secretFile("http-token\n"),
      SN_API_KEY: undefined,
      SN_API_KEY_FILE: secretFile("global-key"),
    },
    async () => {
      loadEnv();
      assert.equal(getCredentials().password, "pw-from-file");
      assert.equal(getHttpToken(), "http-token");
      assert.equal(authEnv("API_KEY"), "global-key");
      // Idempotent: a second load is not a conflict with its own injection.
      assert.doesNotThrow(() => loadEnv());
    },
  );
  delete process.env.SN_HTTP_TOKEN;
  delete process.env.SN_API_KEY;
  baselineEnv();
});

test("loadEnv resolves per-profile _FILE sources for the active profile", async () => {
  await withEnv(
    {
      SN_ENV_FILE: join(dir, "absent.env"),
      SN_ACTIVE_PROFILE: "prod",
      SN_PROFILE_PROD_INSTANCE: "prod.service-now.com",
      SN_PROFILE_PROD_USER: "bob",
      SN_PROFILE_PROD_PASSWORD: undefined,
      SN_PROFILE_PROD_PASSWORD_FILE: secretFile("prod-pw\n"),
      SN_PROFILE_PROD_OAUTH_CLIENT_SECRET: undefined,
      SN_PROFILE_PROD_OAUTH_CLIENT_SECRET_FILE: secretFile("prod-cs\n"),
    },
    async () => {
      loadEnv();
      const creds = getCredentials();
      assert.equal(creds.instance, "prod.service-now.com");
      assert.equal(creds.password, "prod-pw");
      assert.equal(authEnv("OAUTH_CLIENT_SECRET"), "prod-cs");
    },
  );
  delete process.env.SN_PROFILE_PROD_PASSWORD;
  delete process.env.SN_PROFILE_PROD_OAUTH_CLIENT_SECRET;
  baselineEnv();
});

test("the env-file writer refuses a key that a _FILE source supplies", async () => {
  const envFile = join(dir, "writer.env");
  writeFileSync(envFile, "SN_INSTANCE=a.service-now.com\n");
  await withEnv(
    {
      SN_ENV_FILE: envFile,
      SN_OAUTH_REFRESH_TOKEN_FILE: "/run/secrets/refresh",
      SN_PASSWORD_FILE: "/run/secrets/pw",
    },
    async () => {
      assert.throws(
        () => persistEnv({ SN_OAUTH_REFRESH_TOKEN: "rotated" }),
        /SN_OAUTH_REFRESH_TOKEN is loaded from SN_OAUTH_REFRESH_TOKEN_FILE — update that file/,
      );
      assert.throws(
        () =>
          saveCredentials({
            instance: "b.service-now.com",
            user: "u",
            password: "p",
          }),
        /SN_PASSWORD is loaded from SN_PASSWORD_FILE/,
      );
      assert.equal(
        readFileSync(envFile, "utf8"),
        "SN_INSTANCE=a.service-now.com\n",
      );
    },
  );
  baselineEnv();
});

test("the real entry point exits 1 with a one-line conflict error", async () => {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("SN_")) env[key] = value;
  }
  Object.assign(env, {
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, "config"),
    SN_ENV_FILE: join(dir, "absent.env"),
    SN_TRANSPORT: "stdio",
    SN_PASSWORD: "inline-secret",
    SN_PASSWORD_FILE: secretFile("file-secret\n"),
  });
  const { code, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(root, "bin", "servicenow-mcp-ai.cjs"), "--version"],
      { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (c) => resolve({ code: c, stderr: err }));
  });
  assert.equal(code, 1);
  assert.match(
    stderr,
    /^servicenow-mcp-ai: Both SN_PASSWORD and SN_PASSWORD_FILE are set/,
  );
  assert.ok(!stderr.includes("inline-secret"), "no value in the error");
  assert.ok(!stderr.includes("file-secret"), "no value in the error");
  assert.ok(!stderr.includes("    at "), "no stack trace");
});
