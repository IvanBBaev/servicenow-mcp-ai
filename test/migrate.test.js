// `servicenow-mcp-ai migrate` (owner, 2026-10-14): a 2.x env file carries over
// to 3.x — reserved profiles renamed, values 3.x rejects commented out, the
// project-root file moved to XDG, SN_COMPAT=2 added. The plan is pure; the
// command is checked in-process and through the real entry point, which must
// not refuse the 2.x file before migrate runs.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { Writable } from "node:stream";

import { runCli } from "../build/cli.js";
import { planMigration } from "../build/migrate.js";
import { validateSettings } from "../build/core/settings-manifest.js";
import { freshRuntime, withEnv } from "./helpers.js";

freshRuntime();

const sandbox = mkdtempSync(join(tmpdir(), "sn-migrate-"));
test.after(() => rmSync(sandbox, { recursive: true, force: true }));
let seq = 0;
const dir = () => {
  const d = join(sandbox, `case-${++seq}`);
  mkdirSync(d, { recursive: true });
  return d;
};

const V2_FILE = [
  "# my 2.x settings",
  "SN_INSTANCE=dev1.service-now.com",
  "SN_USER=admin",
  "SN_PASSWORD='p#ss word'",
  "SN_ACTIVE_PROFILE=docs",
  "SN_PROFILE_DOCS_INSTANCE=docs1.service-now.com",
  "SN_PROFILE_DOCS_USER=reader",
  "SN_PROFILE_DOCS_READONLY=1",
  "SN_PROFILE_DOCS_EU_INSTANCE=eu1.service-now.com",
  "SN_WRITE_MODE=sometimes",
  "SN_TIMEOUT_MS=30000",
  "",
].join("\n");

const plan = (text, extra = {}) =>
  planMigration({ text, source: "/x/.env", target: "/x/.env", ...extra });

test("migrate keeps every 2.x value and only fixes what 3.x refuses", () => {
  const p = plan(V2_FILE);
  const env = parseEnv(p.text);
  assert.equal(env.SN_INSTANCE, "dev1.service-now.com");
  assert.equal(env.SN_PASSWORD, "p#ss word");
  assert.equal(env.SN_TIMEOUT_MS, "30000");
  assert.match(p.text, /^# my 2\.x settings$/m);
  // B13: `docs` is reserved; its keys and the active profile move to docs_v2,
  // while the `docs_eu` profile is left alone.
  assert.equal(env.SN_ACTIVE_PROFILE, "docs_v2");
  assert.equal(env.SN_PROFILE_DOCS_V2_INSTANCE, "docs1.service-now.com");
  assert.equal(env.SN_PROFILE_DOCS_V2_USER, "reader");
  assert.equal(env.SN_PROFILE_DOCS_V2_READONLY, "1");
  assert.equal(env.SN_PROFILE_DOCS_EU_INSTANCE, "eu1.service-now.com");
  assert.equal(env.SN_PROFILE_DOCS_INSTANCE, undefined);
  // B5: the invalid safety value is commented out (the default applies).
  assert.equal(env.SN_WRITE_MODE, undefined);
  assert.match(p.text, /^# SN_WRITE_MODE=sometimes$/m);
  assert.equal(env.SN_COMPAT, "2");
  assert.deepEqual(p.changes.map((c) => c.kind).sort(), [
    "compat",
    "invalid-value",
    "rename-profile",
  ]);
  // The migrated file loads without a startup error.
  const { issues } = validateSettings({ ...env, SN_COMPAT: undefined });
  assert.deepEqual(
    issues.filter((i) => i.level === "error"),
    [],
  );
});

test("migrate: --v3-defaults and an existing SN_COMPAT add no compat line", () => {
  assert.equal(
    parseEnv(plan(V2_FILE, { v3Defaults: true }).text).SN_COMPAT,
    undefined,
  );
  const p = plan("SN_INSTANCE=dev1\nSN_COMPAT=3\n");
  assert.deepEqual(p.changes, []);
  assert.equal(p.text, "SN_INSTANCE=dev1\nSN_COMPAT=3\n");
});

test("migrate: a project-root file moves to the target", () => {
  const p = plan("SN_INSTANCE=dev1\n", {
    source: "/repo/.env",
    target: "/home/u/.config/servicenow-mcp-ai/.env",
    v3Defaults: true,
  });
  assert.deepEqual(
    p.changes.map((c) => c.kind),
    ["location"],
  );
});

class Sink extends Writable {
  text = "";
  _write(chunk, _enc, cb) {
    this.text += chunk;
    cb();
  }
}
const io = () => ({
  stdin: process.stdin,
  stdout: new Sink(),
  stderr: new Sink(),
  platform: "linux",
  env: process.env,
  cwd: sandbox,
});

test("migrate is a dry run until --write, which keeps a 0600 backup", async () => {
  const file = join(dir(), ".env");
  writeFileSync(file, V2_FILE, { mode: 0o600 });
  await withEnv({ SN_ENV_FILE: file }, async () => {
    const dry = io();
    assert.equal(await runCli(["migrate"], dry), 0);
    assert.match(dry.stdout.text, /Dry run/);
    assert.equal(readFileSync(file, "utf8"), V2_FILE);

    const wet = io();
    assert.equal(await runCli(["migrate", "--write"], wet), 0);
    assert.equal(readFileSync(`${file}.v2.bak`, "utf8"), V2_FILE);
    assert.equal(parseEnv(readFileSync(file, "utf8")).SN_COMPAT, "2");
    if (process.platform !== "win32") {
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(`${file}.v2.bak`).mode & 0o777, 0o600);
    }
    // A second run finds nothing left to do.
    const again = io();
    assert.equal(await runCli(["migrate"], again), 0);
    assert.match(again.stdout.text, /Nothing to change/);
  });
});

test("migrate --from copies a 2.x file to the env file and refuses to overwrite one", async () => {
  const d = dir();
  const from = join(d, "old.env");
  const target = join(d, "new", ".env");
  writeFileSync(from, V2_FILE);
  await withEnv({ SN_ENV_FILE: target }, async () => {
    assert.equal(await runCli(["migrate", "--from", from, "--write"], io()), 0);
    assert.equal(readFileSync(from, "utf8"), V2_FILE);
    assert.equal(
      parseEnv(readFileSync(target, "utf8")).SN_ACTIVE_PROFILE,
      "docs_v2",
    );
    const refused = io();
    assert.equal(await runCli(["migrate", "--from", from], refused), 1);
    assert.match(refused.stderr.text, /already exists/);
  });
});

test("migrate: no env file is nothing to do", async () => {
  await withEnv({ SN_ENV_FILE: join(dir(), "none", ".env") }, async () => {
    const out = io();
    assert.equal(await runCli(["migrate"], out), 0);
    assert.match(out.stdout.text, /No env file to migrate/);
  });
});

test("the entry point runs migrate on a 2.x file it would refuse to serve", () => {
  const d = dir();
  const file = join(d, ".env");
  writeFileSync(file, V2_FILE);
  const env = {
    PATH: process.env.PATH,
    HOME: d,
    XDG_CONFIG_HOME: d,
    SN_ENV_FILE: file,
  };
  const entry = join(import.meta.dirname, "..", "build", "index.js");
  const out = execFileSync(process.execPath, [entry, "migrate", "--write"], {
    env,
    encoding: "utf8",
  });
  assert.match(out, /Wrote /);
  assert.ok(existsSync(`${file}.v2.bak`));
  // The migrated file passes the startup checks (--version loads and
  // validates the env file, and reaches no network).
  const version = execFileSync(process.execPath, [entry, "--version"], {
    env,
    encoding: "utf8",
  });
  assert.match(version, /^\d+\.\d+\.\d+/);
});
