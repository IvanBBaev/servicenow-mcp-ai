// D-1: the CLI (src/cli.ts) in-process — argument parsing, the dispatch, and
// every subcommand with injected streams and an injected doctor, so nothing
// touches a network or the real env file. The spawned end-to-end checks live
// in test/cli-spawn.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  USAGE,
  collectInitAnswers,
  createPrompter,
  defaultBundlePath,
  doctorPayload,
  parseCli,
  runCli,
} from "../build/cli.js";
import { SERVER_VERSION } from "../build/core/identity.js";
import { reloadCredentialsFromEnv } from "../build/core/config.js";
import { freshRuntime } from "./helpers.js";

freshRuntime();

const sandbox = mkdtempSync(join(tmpdir(), "sn-cli-unit-"));
test.after(() => rmSync(sandbox, { recursive: true, force: true }));

let seq = 0;
const savedEnv = { ...process.env };

/** A clean SN_* environment with a fresh, non-existent env file. */
function isolate(extra = {}) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SN_")) delete process.env[key];
  }
  const envFile = join(sandbox, `env-${++seq}`, ".env");
  Object.assign(process.env, { SN_ENV_FILE: envFile, ...extra });
  reloadCredentialsFromEnv();
  return envFile;
}

test.afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  reloadCredentialsFromEnv();
});

class Sink extends Writable {
  text = "";
  constructor(isTTY = false) {
    super();
    this.isTTY = isTTY;
  }
  _write(chunk, _enc, cb) {
    this.text += chunk;
    cb();
  }
}

/** Injected streams; `input` lines are piped on stdin, then stdin ends. */
function fakeIO({ input = [], isTTY = false, stdoutTTY = false } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = isTTY;
  if (input !== null) stdin.end(input.map((l) => l + "\n").join(""));
  return {
    stdin,
    stdout: new Sink(stdoutTTY),
    stderr: new Sink(),
    platform: "linux",
    env: process.env,
    cwd: sandbox,
  };
}

const report = (status = "not_configured", extra = {}) => ({
  status,
  summary: `summary — ${status}`,
  config: {
    configured: status !== "not_configured",
    profile: "default",
    instance: status === "not_configured" ? null : "dev1",
    user: null,
    auth: "basic",
    missing: status === "not_configured" ? ["instance"] : [],
    warnings: [],
  },
  ...extra,
});

const deps = (r = report(), more = {}) => ({
  runDoctor: async () => r,
  npm: async () => ({ name: "servicenow-mcp-ai" }),
  ...more,
});

// ---------------------------------------------------------------------------
// parseCli
// ---------------------------------------------------------------------------

test("parseCli: help, version and the default serve", () => {
  assert.deepEqual(parseCli(["--help"]), { kind: "help" });
  assert.deepEqual(parseCli(["-h"]), { kind: "help" });
  assert.deepEqual(parseCli(["help"]), { kind: "help" });
  assert.deepEqual(parseCli(["doctor", "--help"]), { kind: "help" });
  assert.deepEqual(parseCli(["--version"]), { kind: "version" });
  assert.deepEqual(parseCli(["-v"]), { kind: "version" });
  const serve = parseCli([]);
  assert.equal(serve.kind, "run");
  assert.equal(serve.command, "serve");
});

test("parseCli: commands, options and positionals", () => {
  const doctor = parseCli(["doctor", "--json", "--ascii", "--profile", "QA"]);
  assert.equal(doctor.command, "doctor");
  assert.equal(doctor.json, true);
  assert.equal(doctor.ascii, true);
  assert.equal(doctor.profile, "qa", "profile names are lower-cased");
  const drift = parseCli(["drift", "a", "b"]);
  assert.deepEqual(drift.args, ["a", "b"]);
  const bundle = parseCli(["support-bundle", "--out", "x.json"]);
  assert.equal(bundle.out, "x.json");
  const init = parseCli(["init", "--skip-doctor"]);
  assert.equal(init.skipDoctor, true);
  assert.equal(init.profile, undefined);
});

test("parseCli: usage errors never throw", () => {
  const cases = [
    [["bogus"], /Unknown command "bogus"/],
    [["--nope"], /Unknown option/],
    [["--json"], /--json needs a command/],
    [["init", "--json"], /--json does not apply to "init"/],
    [["doctor", "extra"], /Too many arguments for "doctor"/],
    [["drift", "a", "b", "c"], /Too many arguments for "drift"/],
    [["doctor", "--profile", "bad name!"], /profile/i],
    [["doctor", "--profile"], /argument missing|--profile/],
  ];
  for (const [argv, re] of cases) {
    const parsed = parseCli(argv);
    assert.equal(parsed.kind, "error", argv.join(" "));
    assert.match(parsed.message, re, argv.join(" "));
  }
});

// ---------------------------------------------------------------------------
// runCli — dispatch
// ---------------------------------------------------------------------------

test("runCli: --help / --version / usage error / serve", async () => {
  let io = fakeIO();
  assert.equal(await runCli(["--help"], io, deps()), 0);
  assert.equal(io.stdout.text, USAGE);
  io = fakeIO();
  assert.equal(await runCli(["--version"], io, deps()), 0);
  assert.equal(io.stdout.text, SERVER_VERSION + "\n");
  io = fakeIO();
  assert.equal(await runCli(["bogus"], io, deps()), 2);
  assert.equal(io.stdout.text, "", "usage errors go to stderr only");
  assert.match(io.stderr.text, /Unknown command[\s\S]*Usage:/);
  assert.equal(await runCli([], fakeIO(), deps()), "serve");
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

test("doctor: env-file first line, exit code of the verdict", async () => {
  const envFile = isolate();
  for (const [status, code] of [
    ["not_configured", 2],
    ["degraded", 1],
    ["healthy", 0],
  ]) {
    const io = fakeIO({ stdoutTTY: true });
    assert.equal(await runCli(["doctor"], io, deps(report(status))), code);
    const [first] = io.stdout.text.split("\n");
    assert.equal(first, `env file: ${envFile} (missing, from SN_ENV_FILE)`);
  }
});

test("doctor: ASCII on a non-TTY or with --ascii, glyphs on a TTY", async () => {
  isolate();
  const ascii = /^[\t\n\r\x20-\x7e]*$/;
  const tty = fakeIO({ stdoutTTY: true });
  await runCli(["doctor"], tty, deps());
  assert.ok(!ascii.test(tty.stdout.text), "a TTY keeps the glyphs");
  const flagged = fakeIO({ stdoutTTY: true });
  await runCli(["doctor", "--ascii"], flagged, deps());
  assert.match(flagged.stdout.text, ascii);
  const piped = fakeIO();
  await runCli(["doctor"], piped, deps());
  assert.match(piped.stdout.text, ascii);
  assert.match(piped.stdout.text, /\[x\] Credentials/);
});

test("doctor --json: one JSON document with checks and the status payload", async () => {
  const envFile = isolate();
  const io = fakeIO();
  const code = await runCli(
    ["doctor", "--json"],
    io,
    deps(
      report("degraded", {
        connection: { ok: false, status: 401, latencyMs: 5 },
      }),
    ),
  );
  assert.equal(code, 1);
  const payload = JSON.parse(io.stdout.text);
  assert.deepEqual(payload.envFile, {
    path: envFile,
    exists: false,
    source: "SN_ENV_FILE",
  });
  assert.equal(payload.status, "degraded");
  assert.deepEqual(
    payload.checks.map((c) => [c.name, c.ok]),
    [
      ["credentials", true],
      ["connectivity", false],
    ],
  );
  assert.match(payload.checks[1].detail, /401/);
  assert.equal(typeof payload.serverStatus, "object");
  assert.ok(payload.connection);
});

test("doctor --profile runs the doctor for that profile", async () => {
  isolate();
  const seen = [];
  const { activeProfile } = await import("../build/core/config.js");
  const io = fakeIO();
  await runCli(
    ["doctor", "--profile", "qa"],
    io,
    deps(report(), {
      runDoctor: async () => {
        seen.push(activeProfile());
        return report();
      },
    }),
  );
  assert.deepEqual(seen, ["qa"]);
});

test("doctor: a thrown doctor exits 1 with a stderr message", async () => {
  isolate();
  const io = fakeIO();
  const code = await runCli(["doctor"], io, {
    runDoctor: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(code, 1);
  assert.match(io.stderr.text, /Doctor failed: boom/);
});

test("doctorPayload omits the stages the report skipped", async () => {
  isolate();
  const payload = await doctorPayload(report());
  assert.equal("connection" in payload, false);
  assert.equal("capabilities" in payload, false);
  assert.equal("privilege" in payload, false);
  assert.equal(payload.checks.length, 1);
});

test("doctorPayload carries the N-23 privilege advice", async () => {
  isolate();
  const privilege = { status: "least", missing: [], excess: [] };
  const payload = await doctorPayload(report("healthy", { privilege }));
  assert.deepEqual(payload.privilege, privilege);
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

const readEnv = (file) =>
  Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

test("init (basic): writes the env file 0600, never prints the password, runs doctor", async () => {
  const envFile = isolate();
  const io = fakeIO({ input: ["dev12345", "", "alice", "Pw-Secret-1"] });
  let doctorRan = false;
  const code = await runCli(
    ["init"],
    io,
    deps(report("healthy"), {
      runDoctor: async () => {
        doctorRan = true;
        return report("healthy");
      },
    }),
  );
  assert.equal(code, 0, io.stderr.text);
  assert.ok(doctorRan);
  assert.deepEqual(readEnv(envFile), {
    SN_INSTANCE: "dev12345",
    SN_AUTH: "basic",
    SN_USER: "alice",
    SN_PASSWORD: "Pw-Secret-1",
  });
  if (process.platform !== "win32") {
    assert.equal(statSync(envFile).mode & 0o777, 0o600);
  }
  assert.ok(!io.stdout.text.includes("Pw-Secret-1"));
  assert.ok(!io.stderr.text.includes("Pw-Secret-1"));
  assert.match(
    io.stdout.text,
    /Wrote SN_AUTH, SN_INSTANCE, SN_PASSWORD, SN_USER/,
  );
  assert.match(
    io.stdout.text,
    new RegExp(`env file: .*\\(exists, from SN_ENV_FILE\\)`),
  );
});

test("init: the exit code is the doctor's; --skip-doctor exits 0", async () => {
  isolate();
  let io = fakeIO({ input: ["dev1", "basic", "a", "b"] });
  assert.equal(await runCli(["init"], io, deps(report("degraded"))), 1);
  isolate();
  io = fakeIO({ input: ["dev1", "basic", "a", "b"] });
  let ran = false;
  const code = await runCli(
    ["init", "--skip-doctor"],
    io,
    deps(report(), {
      runDoctor: async () => {
        ran = true;
        return report();
      },
    }),
  );
  assert.equal(code, 0);
  assert.equal(ran, false);
});

test("init: every auth method writes its own keys (profile-scoped)", async () => {
  const cases = [
    [["apikey", "KEY-123456"], { SN_PROFILE_QA_API_KEY: "KEY-123456" }],
    [["token", "TOK-123456"], { SN_PROFILE_QA_BEARER_TOKEN: "TOK-123456" }],
    [
      ["oauth", "", "cid", "CSECRET-1"],
      {
        SN_PROFILE_QA_OAUTH_CLIENT_ID: "cid",
        SN_PROFILE_QA_OAUTH_CLIENT_SECRET: "CSECRET-1",
        SN_PROFILE_QA_OAUTH_GRANT: "client_credentials",
      },
    ],
    [
      ["oauth", "password", "cid", "CSECRET-2", "bob", "PW-2"],
      {
        SN_PROFILE_QA_OAUTH_CLIENT_ID: "cid",
        SN_PROFILE_QA_OAUTH_CLIENT_SECRET: "CSECRET-2",
        SN_PROFILE_QA_OAUTH_GRANT: "password",
        SN_PROFILE_QA_USER: "bob",
        SN_PROFILE_QA_PASSWORD: "PW-2",
      },
    ],
  ];
  for (const [answers, expected] of cases) {
    const envFile = isolate();
    const io = fakeIO({ input: ["qa1.service-now.com", ...answers] });
    const code = await runCli(
      ["init", "--profile", "qa", "--skip-doctor"],
      io,
      deps(),
    );
    assert.equal(code, 0, io.stderr.text);
    const written = readEnv(envFile);
    assert.equal(written.SN_PROFILE_QA_INSTANCE, "qa1.service-now.com");
    assert.equal(written.SN_PROFILE_QA_AUTH, answers[0]);
    for (const [k, v] of Object.entries(expected)) assert.equal(written[k], v);
    assert.match(io.stdout.text, /--profile qa/);
    for (const v of Object.values(expected)) {
      if (/SECRET|KEY-|TOK-|PW-/.test(v)) {
        assert.ok(!io.stdout.text.includes(v), `${v} leaked to stdout`);
      }
    }
  }
});

test("init (oauth authorization_code): optional secret, points at login", async () => {
  let envFile = isolate();
  let io = fakeIO({
    input: ["dev1", "oauth", "authorization_code", "cid", ""],
  });
  let ran = false;
  const noDoctor = deps(report(), {
    runDoctor: async () => {
      ran = true;
      return report();
    },
  });
  assert.equal(await runCli(["init"], io, noDoctor), 0);
  assert.equal(ran, false, "doctor waits for the login");
  assert.match(io.stdout.text, /run `servicenow-mcp-ai login`/);
  assert.equal(readEnv(envFile).SN_OAUTH_CLIENT_SECRET, undefined);
  envFile = isolate();
  io = fakeIO({
    input: ["dev1", "oauth", "authorization_code", "cid", "S3CRET-X"],
  });
  assert.equal(await runCli(["init", "--profile", "p2"], io, noDoctor), 0);
  assert.equal(readEnv(envFile).SN_PROFILE_P2_OAUTH_CLIENT_SECRET, "S3CRET-X");
  assert.match(io.stdout.text, /login --profile p2/);
});

test("init: invalid answers are re-asked, three strikes abort without writing", async () => {
  let envFile = isolate();
  let io = fakeIO({
    input: ["", "127.0.0.1", "dev1", "kerberos", "basic", "", "u", "p"],
  });
  assert.equal(await runCli(["init", "--skip-doctor"], io, deps()), 0);
  assert.match(io.stderr.text, /instance is required/);
  assert.match(io.stderr.text, /loopback/);
  assert.match(io.stderr.text, /Choose one of: basic, oauth, apikey, token/);
  assert.match(io.stderr.text, /user name is required/);
  assert.equal(readEnv(envFile).SN_USER, "u");

  envFile = isolate();
  io = fakeIO({ input: ["x..y", "127.0.0.1", "10.0.0.1"] });
  assert.equal(await runCli(["init"], io, deps()), 2);
  assert.match(io.stderr.text, /Too many invalid answers/);
  assert.equal(existsSync(envFile), false);
});

test("init: stdin that ends early refuses cleanly (exit 2, nothing written)", async () => {
  const envFile = isolate();
  const io = fakeIO({ input: [] });
  assert.equal(await runCli(["init"], io, deps()), 2);
  assert.match(io.stderr.text, /interactive terminal or pipe its answers/);
  assert.equal(existsSync(envFile), false);
});

test("init: an already configured profile asks before overwriting", async () => {
  const envFile = isolate({ SN_INSTANCE: "old1" });
  let io = fakeIO({ input: ["n"] });
  assert.equal(await runCli(["init"], io, deps()), 0);
  assert.match(io.stdout.text, /Nothing changed/);
  assert.equal(existsSync(envFile), false);
  io = fakeIO({ input: ["yes", "new1", "apikey", "K-1234"] });
  assert.equal(await runCli(["init", "--skip-doctor"], io, deps()), 0);
  assert.equal(readEnv(envFile).SN_INSTANCE, "new1");
});

test("init: a failed write exits 1", async () => {
  isolate();
  const blocker = join(sandbox, `blocker-${++seq}`);
  writeFileSync(blocker, "x");
  process.env.SN_ENV_FILE = join(blocker, "sub", ".env");
  const io = fakeIO({ input: ["dev1", "token", "T-1234"] });
  assert.equal(await runCli(["init"], io, deps()), 1);
  assert.match(io.stderr.text, /could not write/);
  assert.ok(!io.stderr.text.includes("T-1234"));
});

test("createPrompter: a hidden prompt on a terminal does not echo", async () => {
  const io = fakeIO({ input: null, isTTY: true, stdoutTTY: true });
  const prompter = createPrompter(io);
  const visible = prompter.ask("Name: ");
  io.stdin.write("alice\r");
  assert.equal(await visible, "alice");
  const hidden = prompter.askHidden("Password: ");
  io.stdin.write("Hidden-Pw-9\r");
  assert.equal(await hidden, "Hidden-Pw-9");
  prompter.close();
  assert.match(io.stdout.text, /Name: [\s\S]*alice/, "a visible answer echoes");
  assert.ok(!io.stdout.text.includes("Hidden-Pw-9"), "a hidden one does not");
});

test("collectInitAnswers is usable on its own", async () => {
  isolate();
  const io = fakeIO({ input: ["dev1", "token", "TT-1234"] });
  const prompter = createPrompter(io);
  const result = await collectInitAnswers(prompter, io, "default");
  prompter.close();
  assert.deepEqual(result, {
    updates: {
      SN_INSTANCE: "dev1",
      SN_AUTH: "token",
      SN_BEARER_TOKEN: "TT-1234",
    },
    needsLogin: false,
  });
});

// ---------------------------------------------------------------------------
// support-bundle
// ---------------------------------------------------------------------------

test("support-bundle: writes one JSON file, prints its path, masks every secret", async () => {
  const log = join(sandbox, `sn-${++seq}.log`);
  writeFileSync(log, "line one\nleaked Bundle-Pw-7 here\n");
  isolate({
    SN_INSTANCE: "dev1",
    SN_USER: "alice",
    SN_PASSWORD: "Bundle-Pw-7",
    SN_PROFILE_QA_API_KEY: "Api-Key-8",
    SN_LOG_FILE: log,
  });
  const out = join(sandbox, `bundle-${seq}.json`);
  const io = fakeIO();
  const code = await runCli(
    ["support-bundle", "--out", out],
    io,
    deps(report("healthy", { summary: "echo Api-Key-8" })),
  );
  assert.equal(code, 0, io.stderr.text);
  assert.equal(io.stdout.text, out + "\n");
  assert.match(io.stderr.text, /review it before attaching/);
  const text = readFileSync(out, "utf8");
  for (const secret of ["Bundle-Pw-7", "Api-Key-8"]) {
    assert.ok(!text.includes(secret), `${secret} leaked into the bundle`);
  }
  const bundle = JSON.parse(text);
  assert.equal(bundle.settings.SN_PASSWORD, "***");
  assert.equal(bundle.settings.SN_USER, "alice");
  assert.equal(bundle.doctor.status, "healthy");
  assert.equal(bundle.manifest.manifestVersion, 3);
  assert.equal(bundle.manifest.serverVersion, SERVER_VERSION);
  assert.ok(bundle.manifest.toolCount >= bundle.manifest.activeTools.length);
  assert.deepEqual(bundle.npm, { name: "servicenow-mcp-ai" });
  assert.deepEqual(bundle.logTail.lines, ["line one", "leaked *** here"]);
  if (process.platform !== "win32") {
    assert.equal(statSync(out).mode & 0o777, 0o600);
  }
});

test("support-bundle: a failing doctor is recorded, the default path is in cwd", async () => {
  isolate();
  const io = fakeIO();
  const now = new Date("2026-09-26T10:11:12.345Z");
  const code = await runCli(["support-bundle", "--profile", "qa"], io, {
    runDoctor: async () => {
      throw new Error("doctor down");
    },
    npm: async () => ({ error: "no npm" }),
    now: () => now,
  });
  assert.equal(code, 0, io.stderr.text);
  const path = io.stdout.text.trim();
  assert.equal(path, defaultBundlePath(sandbox, now));
  assert.match(path, /servicenow-mcp-ai-support-2026-09-26T10-11-12Z\.json$/);
  const bundle = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(bundle.doctor, { error: "doctor down" });
  assert.equal("logTail" in bundle, false);
});

test("support-bundle: an unwritable --out exits 1", async () => {
  isolate();
  const blocker = join(sandbox, `blk-${++seq}`);
  writeFileSync(blocker, "x");
  const io = fakeIO();
  const code = await runCli(
    ["support-bundle", "--out", join(blocker, "b.json")],
    io,
    deps(),
  );
  assert.equal(code, 1);
  assert.match(io.stderr.text, /support-bundle failed/);
  assert.equal(io.stdout.text, "");
});

// ---------------------------------------------------------------------------
// login / drift (the moved dispatch)
// ---------------------------------------------------------------------------

test("login without an instance fails with exit 1", async () => {
  isolate();
  const io = fakeIO();
  assert.equal(await runCli(["login"], io, deps()), 1);
  assert.match(io.stderr.text, /Login failed/);
  const scoped = fakeIO();
  assert.equal(await runCli(["login", "--profile", "qa"], scoped, deps()), 1);
});

test("drift: usage and unknown profiles exit 2", async () => {
  isolate();
  let io = fakeIO();
  assert.equal(await runCli(["drift", "a"], io, deps()), 2);
  assert.match(io.stderr.text, /Usage: servicenow-mcp-ai drift/);
  io = fakeIO();
  assert.equal(await runCli(["drift", "nope1", "nope2"], io, deps()), 2);
  assert.match(io.stderr.text, /Drift gate failed/);
});
