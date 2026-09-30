// E-4: the declarative settings manifest — parsing, profile scoping, the
// invalid-value policy (warn + default, or a startup error under
// SN_STRICT_SETTINGS), unknown-key reporting and the secret flags that feed
// the D-5 resolver and the support bundle.
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SETTINGS,
  SETTING_SECTIONS,
  applySettingsAtStartup,
  defaultText,
  fileSourceKeys,
  invalidMessage,
  isDeclaredSetting,
  isSecretFileSource,
  isSecretKey,
  parseSetting,
  profileEnvKey,
  rawSetting,
  readBool,
  readEnum,
  readInt,
  readSetting,
  readString,
  resetSettingWarnings,
  settingSource,
  settingSpec,
  startupSettings,
  validateSettings,
} from "../build/core/settings-manifest.js";
import {
  getMaxConcurrent,
  getMaxRecords,
  getMaxResultChars,
  getMaxRetries,
  getTimeoutMs,
} from "../build/core/settings.js";
import { envFileChoice } from "../build/core/config.js";
import { envFileLine } from "../build/api/doctor.js";
import { setLogSink } from "../build/core/logging.js";
import { withEnv } from "./helpers.js";

/** Collect the logger's warnings while `fn` runs. */
async function captureWarnings(fn) {
  const warnings = [];
  const real = console.error;
  console.error = () => {};
  setLogSink((level, message) => {
    if (level === "warn") warnings.push(message);
  });
  try {
    await fn();
  } finally {
    setLogSink(null);
    console.error = real;
  }
  return warnings;
}

test("every spec is well formed: unique key, known section, parseable default", () => {
  const sections = new Set(SETTING_SECTIONS.map((s) => s.id));
  const keys = new Set();
  for (const spec of SETTINGS) {
    assert.ok(!keys.has(spec.key), `duplicate ${spec.key}`);
    keys.add(spec.key);
    assert.ok(
      sections.has(spec.section),
      `${spec.key}: section ${spec.section}`,
    );
    assert.ok(spec.description.length > 0, `${spec.key}: description`);
    assert.ok(spec.since, `${spec.key}: since`);
    if (
      spec.pattern ||
      spec.default === undefined ||
      Array.isArray(spec.default)
    ) {
      continue;
    }
    const parsed = parseSetting(spec, String(spec.default));
    assert.ok(parsed.ok, `${spec.key}: default ${spec.default} does not parse`);
    assert.equal(parsed.value, spec.default, `${spec.key}: default round-trip`);
  }
  // Every section is used.
  for (const id of sections) {
    assert.ok(
      SETTINGS.some((s) => s.section === id),
      `section ${id} has no settings`,
    );
  }
});

test("the manifest defaults agree with the getters", async () => {
  await withEnv(
    {
      SN_TIMEOUT_MS: undefined,
      SN_MAX_RETRIES: undefined,
      SN_MAX_RECORDS: undefined,
      SN_MAX_RESULT_CHARS: undefined,
      SN_MAX_CONCURRENT: undefined,
    },
    () => {
      for (const [key, getter] of [
        ["SN_TIMEOUT_MS", getTimeoutMs],
        ["SN_MAX_RETRIES", getMaxRetries],
        ["SN_MAX_RECORDS", getMaxRecords],
        ["SN_MAX_RESULT_CHARS", getMaxResultChars],
        ["SN_MAX_CONCURRENT", getMaxConcurrent],
      ]) {
        const spec = settingSpec(key);
        if (spec.default !== undefined) {
          assert.equal(getter(), spec.default, `${key} default`);
        }
      }
    },
  );
});

test("settingSpec throws on an undeclared key; isDeclaredSetting says so", () => {
  assert.throws(() => settingSpec("SN_NOT_A_SETTING"), /Undeclared setting/);
  assert.equal(isDeclaredSetting("SN_NOT_A_SETTING"), false);
  assert.equal(isDeclaredSetting("SN_TIMEOUT_MS"), true);
  // A documentation-only pattern row is not a readable setting.
  assert.equal(isDeclaredSetting("SN_PROFILE_<NAME>_*"), false);
});

test("kinds parse: int, bool, enum, url, date, profile name", () => {
  assert.deepEqual(parseSetting(settingSpec("SN_TIMEOUT_MS"), " 1500.7 "), {
    ok: true,
    value: 1500,
  });
  assert.equal(parseSetting(settingSpec("SN_TIMEOUT_MS"), "0").ok, false);
  assert.equal(parseSetting(settingSpec("SN_TIMEOUT_MS"), "abc").ok, false);
  assert.equal(parseSetting(settingSpec("SN_MAX_RETRIES"), "0").value, 0);
  assert.equal(parseSetting(settingSpec("SN_METRICS"), "YES").value, true);
  assert.equal(parseSetting(settingSpec("SN_METRICS"), "off").value, false);
  assert.match(
    parseSetting(settingSpec("SN_METRICS"), "maybe").error,
    /expected one of/,
  );
  assert.equal(
    parseSetting(settingSpec("SN_LOG_LEVEL"), "DEBUG").value,
    "debug",
  );
  assert.equal(parseSetting(settingSpec("SN_LOG_LEVEL"), "loud").ok, false);
  assert.equal(
    parseSetting(settingSpec("HTTPS_PROXY"), "http://proxy:3128").ok,
    true,
  );
  assert.equal(parseSetting(settingSpec("HTTPS_PROXY"), "ftp://x").ok, false);
  assert.equal(parseSetting(settingSpec("HTTPS_PROXY"), "not a url").ok, false);
  assert.equal(
    parseSetting(settingSpec("SN_TOKEN_EXPIRES_AT"), "2026-12-31T00:00:00Z").ok,
    true,
  );
  assert.equal(
    parseSetting(settingSpec("SN_TOKEN_EXPIRES_AT"), "soon").ok,
    false,
  );
  assert.equal(
    parseSetting(settingSpec("SN_ACTIVE_PROFILE"), "Dev").value,
    "dev",
  );
  assert.equal(parseSetting(settingSpec("SN_ACTIVE_PROFILE"), "a-b").ok, false);
  // Empty counts as unset.
  assert.deepEqual(parseSetting(settingSpec("SN_TIMEOUT_MS"), "  "), {
    ok: true,
  });
});

test("defaultText renders the default, a computed text or a dash", () => {
  assert.equal(defaultText(settingSpec("SN_AUTH")), "auto");
  assert.equal(defaultText(settingSpec("SN_API_KEY")), "—");
  assert.equal(
    defaultText({
      ...settingSpec("SN_METRICS"),
      defaultText: undefined,
      default: false,
    }),
    "`false`",
  );
  assert.equal(
    defaultText({
      ...settingSpec("SN_METRICS"),
      defaultText: undefined,
      default: ["a", "b"],
    }),
    "`a,b`",
  );
});

test("profile scopes: override, fallback and isolated", () => {
  const env = {
    SN_WRITE_MODE: "direct",
    SN_PROFILE_PROD_WRITE_MODE: "",
    SN_AUTH: "basic",
    SN_PROFILE_PROD_AUTH: " ",
    SN_INSTANCE: "dev.service-now.com",
  };
  assert.equal(profileEnvKey("SN_INSTANCE", "default"), "SN_INSTANCE");
  assert.equal(
    profileEnvKey("SN_INSTANCE", "prod"),
    "SN_PROFILE_PROD_INSTANCE",
  );
  // override: a defined profile key wins even when empty.
  assert.equal(rawSetting("SN_WRITE_MODE", { env, profile: "prod" }), "");
  assert.equal(
    settingSource("SN_WRITE_MODE", { env, profile: "prod" }),
    "SN_PROFILE_PROD_WRITE_MODE",
  );
  assert.equal(rawSetting("SN_WRITE_MODE", { env, profile: "qa" }), "direct");
  // fallback: a blank profile key falls back to the global one.
  assert.equal(rawSetting("SN_AUTH", { env, profile: "prod" }), "basic");
  assert.equal(settingSource("SN_AUTH", { env, profile: "prod" }), "SN_AUTH");
  env.SN_PROFILE_PROD_AUTH = "apikey";
  assert.equal(readEnum("SN_AUTH", { env, profile: "prod" }), "apikey");
  // isolated: a named profile never sees the global key.
  assert.equal(rawSetting("SN_INSTANCE", { env, profile: "prod" }), undefined);
  assert.equal(
    rawSetting("SN_INSTANCE", { env, profile: "default" }),
    "dev.service-now.com",
  );
});

test("aliases are read when the key itself is unset", () => {
  assert.equal(
    readEnum("SN_LOG_LEVEL", { env: { LOG_LEVEL: "warn" } }),
    "warn",
  );
  assert.equal(
    settingSource("SN_LOG_LEVEL", { env: { LOG_LEVEL: "warn" } }),
    "LOG_LEVEL",
  );
  assert.equal(
    readEnum("SN_LOG_LEVEL", {
      env: { SN_LOG_LEVEL: "error", LOG_LEVEL: "warn" },
    }),
    "error",
  );
  assert.equal(
    rawSetting("HTTPS_PROXY", { env: { https_proxy: "http://p:1" } }),
    "http://p:1",
  );
  assert.equal(settingSource("SN_LOG_LEVEL", { env: {} }), "SN_LOG_LEVEL");
});

test("an invalid value warns once and keeps the default", async () => {
  resetSettingWarnings();
  const env = { SN_TIMEOUT_MS: "-5" };
  const warnings = await captureWarnings(() => {
    assert.equal(
      readInt("SN_TIMEOUT_MS", { env }),
      settingSpec("SN_TIMEOUT_MS").default,
    );
    readInt("SN_TIMEOUT_MS", { env });
    assert.equal(
      readBool("SN_METRICS", { env: { SN_METRICS: "perhaps" } }),
      false,
    );
  });
  assert.equal(warnings.length, 2, warnings.join("\n"));
  assert.match(
    warnings[0],
    /Invalid SN_TIMEOUT_MS="-5": expected a number >= 1/,
  );
  assert.match(warnings[1], /Invalid SN_METRICS="perhaps"/);
  resetSettingWarnings();
});

test("a secret's invalid value is never echoed", () => {
  const spec = { ...settingSpec("SN_PASSWORD"), secret: true };
  const message = invalidMessage(spec, "SN_PASSWORD", "hunter2", "nope");
  assert.ok(!message.includes("hunter2"));
  assert.match(message, /<redacted>/);
});

test("readString trims and maps blank to undefined; readSetting returns defaults", () => {
  assert.equal(
    readString("SN_USER_AGENT_SUFFIX", {
      env: { SN_USER_AGENT_SUFFIX: " x " },
    }),
    "x",
  );
  assert.equal(
    readString("SN_USER_AGENT_SUFFIX", { env: { SN_USER_AGENT_SUFFIX: "  " } }),
    undefined,
  );
  assert.equal(
    readSetting("SN_METRICS", { env: {} }),
    settingSpec("SN_METRICS").default,
  );
});

test("D-5 sources and secret keys come from the manifest", () => {
  const keys = fileSourceKeys();
  for (const key of [
    "SN_PASSWORD",
    "SN_API_KEY",
    "SN_BEARER_TOKEN",
    "SN_OAUTH_CLIENT_SECRET",
    "SN_OAUTH_REFRESH_TOKEN",
    "SN_HTTP_TOKEN",
  ]) {
    assert.ok(keys.includes(key), `${key} is a file source`);
    assert.ok(isSecretFileSource(`${key}_FILE`), `${key}_FILE`);
    assert.ok(isDeclaredSetting(`${key}_FILE`), `${key}_FILE is declared`);
    assert.equal(isSecretKey(key), true, `${key} is secret`);
    assert.equal(isSecretKey(`${key}_FILE`), false, `${key}_FILE holds a path`);
  }
  assert.ok(isSecretFileSource("SN_PROFILE_PROD_PASSWORD_FILE"));
  assert.ok(isSecretFileSource("SN_PROFILE_PROD_API_KEY_FILE"));
  assert.equal(isSecretKey("SN_PROFILE_PROD_PASSWORD"), true);
  // Paths with their own meaning are not sources.
  for (const name of [
    "SN_TOKEN_FILE",
    "SN_OAUTH_JWT_KEY_FILE",
    "SN_TLS_CLIENT_CERT_FILE",
    "SN_PASSWORD",
    "SN_PROFILE_A-B_PASSWORD_FILE",
  ]) {
    assert.equal(isSecretFileSource(name), false, name);
  }
  assert.equal(isSecretKey("SN_INSTANCE"), false);
  assert.equal(isSecretKey("SN_UNKNOWN"), false);
});

test("validateSettings reports invalid values, profile keys and unknown SN_ keys", () => {
  const result = validateSettings({
    SN_TIMEOUT_MS: "abc",
    SN_PROFILE_PROD_WRITE_MODE: "sideways",
    SN_PROFILE_PROD_INSTANCE: "prod.service-now.com",
    SN_PASSWORD: "s3cret",
    SN_TIMEOUTMS: "5",
    PATH: "/bin",
  });
  const byKey = Object.fromEntries(result.issues.map((i) => [i.key, i]));
  assert.equal(byKey.SN_TIMEOUT_MS.level, "error");
  assert.equal(byKey.SN_PROFILE_PROD_WRITE_MODE.level, "error");
  assert.equal(byKey.SN_TIMEOUTMS.level, "warning");
  assert.match(byKey.SN_TIMEOUTMS.message, /Unknown setting SN_TIMEOUTMS/);
  assert.equal(byKey.SN_PROFILE_PROD_INSTANCE, undefined);
  assert.equal(byKey.PATH, undefined);
  assert.equal(result.strict, false);
  assert.equal(result.settings.SN_PASSWORD, "<set>");
  assert.equal(
    result.settings.SN_TIMEOUT_MS,
    settingSpec("SN_TIMEOUT_MS").default,
  );
  assert.deepEqual(validateSettings({ SN_STRICT_SETTINGS: "1" }).strict, true);
});

test("applySettingsAtStartup: warns by default, throws under SN_STRICT_SETTINGS", async () => {
  resetSettingWarnings();
  const env = { SN_MAX_RECORDS: "lots", SN_BOGUS_KEY: "1" };
  const warnings = await captureWarnings(() => {
    const result = applySettingsAtStartup(env);
    assert.equal(result.issues.length, 2);
    assert.equal(startupSettings(), result);
    applySettingsAtStartup(env); // once per issue
  });
  assert.equal(warnings.length, 2, warnings.join("\n"));
  assert.throws(
    () => applySettingsAtStartup({ ...env, SN_STRICT_SETTINGS: "true" }),
    /Invalid settings \(SN_STRICT_SETTINGS is on\): Invalid SN_MAX_RECORDS="lots"/,
  );
  // Strict mode with only unknown keys (warnings) does not throw.
  resetSettingWarnings();
  await captureWarnings(() =>
    applySettingsAtStartup({ SN_BOGUS_KEY: "1", SN_STRICT_SETTINGS: "1" }),
  );
  resetSettingWarnings();
});

test("envFileChoice names why the env file was chosen; doctor prints it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sn-env-choice-"));
  try {
    await withEnv({ SN_ENV_FILE: path.join(dir, "explicit.env") }, () => {
      assert.deepEqual(envFileChoice(), {
        path: path.join(dir, "explicit.env"),
        source: "SN_ENV_FILE",
      });
    });
    const xdgFile = path.join(dir, "servicenow-mcp-ai", ".env");
    mkdirSync(path.dirname(xdgFile));
    writeFileSync(xdgFile, "SN_INSTANCE=x\n");
    await withEnv({ SN_ENV_FILE: undefined, XDG_CONFIG_HOME: dir }, () => {
      assert.deepEqual(envFileChoice(), { path: xdgFile, source: "xdg" });
    });
    rmSync(xdgFile);
    await withEnv({ SN_ENV_FILE: undefined, XDG_CONFIG_HOME: dir }, () => {
      const choice = envFileChoice();
      // The project-root fallback only applies when that file exists.
      if (!existsSync(choice.path) || choice.source !== "project") {
        assert.deepEqual(choice, { path: xdgFile, source: "xdg-default" });
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(envFileLine("/a/.env", true), "env file: /a/.env (exists)");
  assert.equal(
    envFileLine("/a/.env", false, "SN_ENV_FILE"),
    "env file: /a/.env (missing, from SN_ENV_FILE)",
  );
  assert.match(
    envFileLine("/a/.env", true, "project"),
    /deprecated — removed in 3\.0/,
  );
  assert.match(envFileLine("/a/.env", true, "xdg"), /XDG config\)$/);
  assert.match(envFileLine("/a/.env", true, "other"), /\(exists, other\)$/);
});
