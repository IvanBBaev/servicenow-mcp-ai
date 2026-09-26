// D-1: support-bundle building blocks and the doctor's CLI output helpers.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MASK,
  buildSupportBundle,
  isSecretSetting,
  npmLs,
  redactedSettings,
  scrubSecrets,
  tailFile,
} from "../build/api/support-bundle.js";
import {
  doctorChecks,
  envFileLine,
  shouldUseAscii,
  toAscii,
} from "../build/api/doctor.js";
import { withEnv } from "./helpers.js";

const sandbox = mkdtempSync(join(tmpdir(), "sn-bundle-"));
test.after(() => rmSync(sandbox, { recursive: true, force: true }));

test("isSecretSetting recognises credential-bearing names", () => {
  for (const name of [
    "SN_PASSWORD",
    "SN_PROFILE_QA_PASSWORD",
    "SN_OAUTH_CLIENT_SECRET",
    "SN_OAUTH_REFRESH_TOKEN",
    "SN_BEARER_TOKEN",
    "SN_API_KEY",
    "SN_OAUTH_JWT_KEY",
    "SN_MTLS_KEY",
    "SN_MTLS_PFX",
    "SN_MTLS_PASSPHRASE",
    "sn_password",
  ]) {
    assert.ok(isSecretSetting(name), name);
  }
  for (const name of ["SN_INSTANCE", "SN_USER", "SN_AUTH", "SN_LOG_FILE"]) {
    assert.ok(!isSecretSetting(name), name);
  }
});

test("redactedSettings keeps SN_* only, masks secrets, collects scrub values", () => {
  const { settings, secrets } = redactedSettings({
    PATH: "/bin",
    SN_USER: "alice",
    SN_PASSWORD: "longsecret",
    SN_API_KEY: "abc",
    SN_OAUTH_CLIENT_SECRET: "",
    SN_UNDEFINED: undefined,
  });
  assert.deepEqual(settings, {
    SN_API_KEY: MASK,
    SN_OAUTH_CLIENT_SECRET: "",
    SN_PASSWORD: MASK,
    SN_USER: "alice",
  });
  assert.deepEqual(Object.keys(settings), Object.keys(settings).sort());
  assert.deepEqual(
    secrets,
    ["longsecret"],
    "too-short values are not scrubbed",
  );
});

test("scrubSecrets masks longest first and the JSON-escaped spelling", () => {
  assert.equal(scrubSecrets("a abcd abcdef", ["abcd", "abcdef"]), "a *** ***");
  const quoted = 'pa"ss\\wd';
  const json = JSON.stringify({ v: quoted });
  assert.equal(scrubSecrets(json, [quoted]), '{"v":"***"}');
  assert.equal(scrubSecrets("nothing", []), "nothing");
});

test("tailFile returns the last lines and drops a partial first line", () => {
  const small = join(sandbox, "small.log");
  writeFileSync(small, "a\nb\nc\n");
  assert.deepEqual(tailFile(small, 2), ["b", "c"]);
  assert.deepEqual(tailFile(small), ["a", "b", "c"]);
  const big = join(sandbox, "big.log");
  const line = "x".repeat(99);
  writeFileSync(big, `${line}\n`.repeat(3000) + "last");
  const tail = tailFile(big, 5000);
  assert.ok(tail.length < 3000, "reads a bounded window");
  assert.equal(tail.at(-1), "last");
  assert.ok(
    tail.slice(0, -1).every((l) => l === line),
    "no partial line",
  );
});

test("buildSupportBundle: versions, settings, npm, missing log file recorded", async () => {
  await withEnv(
    { SN_LOG_FILE: join(sandbox, "absent.log"), SN_PASSWORD: "Zz-secret-1" },
    async () => {
      const text = await buildSupportBundle({
        doctor: { summary: "saw Zz-secret-1" },
        manifest: { manifestVersion: 2 },
        npm: async () => ({ ok: true }),
        now: new Date("2026-01-02T03:04:05.000Z"),
      });
      assert.ok(!text.includes("Zz-secret-1"));
      const bundle = JSON.parse(text);
      assert.equal(bundle.bundleVersion, 1);
      assert.equal(bundle.generatedAt, "2026-01-02T03:04:05.000Z");
      assert.equal(bundle.versions.node, process.versions.node);
      assert.equal(bundle.settings.SN_PASSWORD, MASK);
      assert.deepEqual(bundle.npm, { ok: true });
      assert.match(bundle.logTail.error, /ENOENT/);
      assert.equal(typeof bundle.envFile.exists, "boolean");
    },
  );
  await withEnv({ SN_LOG_FILE: undefined }, async () => {
    const bundle = JSON.parse(
      await buildSupportBundle({
        doctor: {},
        manifest: {},
        env: {},
        npm: async () => null,
      }),
    );
    assert.equal("logTail" in bundle, false);
    assert.deepEqual(bundle.settings, {});
  });
});

test("npmLs is best effort: a tree or an error object, never a throw", async () => {
  const result = await npmLs(30_000);
  assert.equal(typeof result, "object");
  assert.ok(result !== null);
  assert.ok("dependencies" in result || "error" in result || "name" in result);
  const timedOut = await npmLs(1);
  assert.equal(typeof timedOut, "object");
});

// ---------------------------------------------------------------------------
// doctor CLI helpers
// ---------------------------------------------------------------------------

test("shouldUseAscii: flag, non-TTY, Windows outside Windows Terminal", () => {
  assert.equal(shouldUseAscii({ flag: true, isTTY: true }), true);
  assert.equal(shouldUseAscii({ isTTY: false }), true);
  assert.equal(shouldUseAscii({ isTTY: true, platform: "darwin" }), false);
  assert.equal(
    shouldUseAscii({ isTTY: true, platform: "win32", env: {} }),
    true,
  );
  assert.equal(
    shouldUseAscii({
      isTTY: true,
      platform: "win32",
      env: { WT_SESSION: "1" },
    }),
    false,
  );
});

test("toAscii transliterates the report glyphs, unknown ones become ?", () => {
  assert.equal(
    toAscii("✓ ok — a–b … → · “q” ‘s’ ☃\tx\n"),
    `[ok] ok - a-b ... -> - "q" 's' ?\tx\n`,
  );
  assert.equal(toAscii("✗"), "[x]");
});

test("envFileLine and doctorChecks", () => {
  assert.equal(envFileLine("/p/.env", true), "env file: /p/.env (exists)");
  assert.equal(envFileLine("/p/.env", false), "env file: /p/.env (missing)");
  const config = {
    configured: true,
    profile: "qa",
    auth: "oauth",
    missing: [],
  };
  const checks = doctorChecks({
    status: "healthy",
    summary: "",
    config,
    connection: { ok: true, status: 200, latencyMs: 12 },
    capabilities: { degraded: false, summary: "all good" },
  });
  assert.deepEqual(checks, [
    { name: "credentials", ok: true, detail: 'profile "qa" (oauth)' },
    { name: "connectivity", ok: true, detail: "HTTP 200 in 12ms" },
    { name: "capabilities", ok: true, detail: "all good" },
  ]);
  const missing = doctorChecks({
    status: "not_configured",
    summary: "",
    config: { ...config, configured: false, missing: ["instance", "user"] },
  });
  assert.deepEqual(missing, [
    { name: "credentials", ok: false, detail: "missing: instance, user" },
  ]);
});
