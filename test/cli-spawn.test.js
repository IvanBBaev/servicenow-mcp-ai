// E-6: spawn-based CLI tests — the real entry points (the CommonJS launcher in
// bin/ and build/index.js) run as child processes with a controlled
// environment: no SN_* variables from the parent, a non-existent env file, a
// throw-away HOME / XDG_CONFIG_HOME / cwd, and nothing that reaches a network
// (no credentials, so no request is ever attempted).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const launcher = join(root, "bin", "servicenow-mcp-ai.cjs");
const entry = join(root, "build", "index.js");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** Same contract as test/mcp-smoke.test.js: the default (core) tool set. */
const CORE_TOOLS = [
  "servicenow_aggregate",
  "servicenow_check_capabilities",
  "servicenow_create_record",
  "servicenow_delete_attachment",
  "servicenow_delete_record",
  "servicenow_describe_table",
  "servicenow_disable_package",
  "servicenow_download_attachment",
  "servicenow_enable_package",
  "servicenow_explain_policy",
  "servicenow_find_tools",
  "servicenow_get_attachment",
  "servicenow_get_record",
  "servicenow_get_status",
  "servicenow_list_attachments",
  "servicenow_list_instances",
  "servicenow_list_packages",
  "servicenow_list_tables",
  "servicenow_query_table",
  "servicenow_set_credentials",
  "servicenow_test_connection",
  "servicenow_update_record",
  "servicenow_upload_attachment",
  "servicenow_upsert_record",
  "servicenow_use_instance",
];

const sandbox = mkdtempSync(join(tmpdir(), "sn-cli-"));
test.after(() => rmSync(sandbox, { recursive: true, force: true }));

/** The parent environment minus every SN_* key, pointed at the sandbox. */
function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("SN_")) {
      env[key] = value;
    }
  }
  return {
    ...env,
    HOME: sandbox,
    USERPROFILE: sandbox,
    XDG_CONFIG_HOME: join(sandbox, "config"),
    SN_ENV_FILE: join(sandbox, "does-not-exist.env"),
    SN_DOCS_DIR: join(sandbox, "docs"),
    SN_TRANSPORT: "stdio",
    SN_LOG_LEVEL: "warn",
    ...extra,
  };
}

/**
 * Run a command to completion; resolves with its exit code and streams.
 * `input` (D-1) is piped on stdin, then stdin is closed; without it stdin is
 * /dev/null.
 */
function run(args, { env = cleanEnv(), timeoutMs = 15_000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: sandbox,
      env,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (input !== undefined) child.stdin.end(input);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out: ${args.join(" ")}\n${stderr}`));
    }, timeoutMs);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/**
 * Start the server over stdio and speak newline-delimited JSON-RPC to it.
 * Every stdout line must be a JSON-RPC message — stdout is the protocol channel.
 */
function startStdioServer(args) {
  const child = spawn(process.execPath, args, {
    cwd: sandbox,
    env: cleanEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = [];
  const waiters = new Map();
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim() === "") continue;
      lines.push(line);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // asserted on below via `lines`
      }
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter(message);
      }
    }
  });
  const exited = new Promise((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal })),
  );
  let nextId = 1;
  return {
    child,
    lines,
    exited,
    stderr: () => stderr,
    send(message) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    },
    request(method, params) {
      const id = nextId++;
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no reply to ${method}\n${stderr}`)),
          15_000,
        );
        waiters.set(id, (m) => {
          clearTimeout(timer);
          resolve(m);
        });
      });
      this.send({ id, method, params });
      return reply;
    },
  };
}

test("bin launcher: stdio handshake, core tool list, JSON-only stdout, SIGTERM exits 0", async () => {
  const server = startStdioServer([launcher]);
  try {
    const init = await server.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "cli-spawn-test", version: "0.0.0" },
    });
    assert.equal(init.error, undefined, JSON.stringify(init.error));
    assert.equal(init.result.serverInfo.name, "servicenow-mcp-ai");
    assert.equal(init.result.serverInfo.version, pkg.version);
    assert.ok(init.result.capabilities.tools, "tools capability advertised");

    server.send({ method: "notifications/initialized" });
    const list = await server.request("tools/list", {});
    assert.equal(list.error, undefined, JSON.stringify(list.error));
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), CORE_TOOLS);

    for (const line of server.lines) {
      const message = JSON.parse(line); // throws on any non-JSON stdout line
      assert.equal(message.jsonrpc, "2.0", line);
    }
    // Without credentials the server still starts and says so on stderr only.
    assert.match(server.stderr(), /credentials are incomplete/);
  } finally {
    if (process.platform === "win32") server.child.kill();
    else server.child.kill("SIGTERM");
  }
  const { code, signal } = await server.exited;
  if (process.platform !== "win32") {
    assert.equal(signal, null, "graceful shutdown, not killed by the signal");
    assert.equal(code, 0, server.stderr());
  }
});

test(
  "build/index.js: SIGINT is a graceful shutdown too (exit 0)",
  {
    skip: process.platform === "win32" && "POSIX signals only",
  },
  async () => {
    const server = startStdioServer([entry]);
    const init = await server.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "cli-spawn-test", version: "0.0.0" },
    });
    assert.equal(init.result.serverInfo.name, "servicenow-mcp-ai");
    server.child.kill("SIGINT");
    const { code, signal } = await server.exited;
    assert.equal(signal, null);
    assert.equal(code, 0, server.stderr());
  },
);

test("doctor without credentials: exits 2 (not configured) and never touches the network", async () => {
  const result = await run([entry, "doctor"]);
  assert.equal(result.code, 2, result.stderr);
  assert.notEqual(result.stdout.trim(), "", "the report goes to stdout");
});

test("doctor via the bin launcher gives the same exit code", async () => {
  const result = await run([launcher, "doctor"]);
  assert.equal(result.code, 2, result.stderr);
});

test("drift without two profiles: exits 2 with the usage line on stderr", async () => {
  for (const args of [["drift"], ["drift", "only-one"]]) {
    const result = await run([entry, ...args]);
    assert.equal(result.code, 2, args.join(" "));
    assert.match(
      result.stderr,
      /Usage: servicenow-mcp-ai drift <profileA> <profileB>/,
    );
    assert.equal(result.stdout, "", "nothing on stdout");
  }
});

test("drift with unknown profiles: exits 2 (error), not 0 or 1", async () => {
  const result = await run([entry, "drift", "nope-a", "nope-b"]);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /Drift gate failed/);
});

const oldNode = join(import.meta.dirname, "fixtures", "old-node.cjs");

test("bin launcher: the Node version guard refuses an old runtime with exit 1", async () => {
  // Fake an old runtime by preloading a module that overrides process.versions.node;
  // the launcher reads it before importing the ESM graph.
  const result = await run(["--require", oldNode, launcher]);
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /requires Node\.js >= 22\.12, but this is 18\.0\.0/,
  );
  assert.equal(result.stdout, "");
});

test("bin launcher: E-1 — the floor is the minor, 22.11 is refused", async () => {
  const result = await run(["--require", oldNode, launcher], {
    env: cleanEnv({ FAKE_NODE_VERSION: "22.11.0" }),
  });
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /requires Node\.js >= 22\.12, but this is 22\.11\.0/,
  );
});

test("build/index.js: its own Node guard refuses an old runtime before the server boots", async () => {
  for (const version of ["18.0.0", "22.11.0"]) {
    const result = await run(["--require", oldNode, entry], {
      env: cleanEnv({ FAKE_NODE_VERSION: version }),
    });
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      new RegExp(
        `requires Node\\.js >= 22\\.12, but this is ${version.replaceAll(".", "\\.")}`,
      ),
    );
    assert.equal(result.stdout, "");
  }
});

// ---------------------------------------------------------------------------
// D-1: the real CLI (help, version, doctor output modes, init, support-bundle)
// ---------------------------------------------------------------------------

test("--help and --version print to stdout and exit 0", async () => {
  for (const args of [["--help"], ["-h"], ["help"]]) {
    const result = await run([entry, ...args]);
    assert.equal(result.code, 0, args.join(" "));
    assert.match(result.stdout, /^Usage: servicenow-mcp-ai \[command\]/);
    for (const cmd of ["init", "doctor", "login", "drift", "support-bundle"]) {
      assert.match(result.stdout, new RegExp(`\\n  ${cmd}\\b`));
    }
  }
  for (const args of [["--version"], ["-v"]]) {
    const result = await run([launcher, ...args]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, `${pkg.version}\n`);
  }
});

test("an unknown command or option exits 2 with usage on stderr, stdout empty", async () => {
  for (const args of [["bogus"], ["--bogus"], ["doctor", "--out", "x"]]) {
    const result = await run([entry, ...args]);
    assert.equal(result.code, 2, args.join(" "));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage: servicenow-mcp-ai/);
  }
});

test("doctor: the first line names the env file; piped stdout is ASCII", async () => {
  const env = cleanEnv();
  const result = await run([entry, "doctor"], { env });
  assert.equal(result.code, 2, result.stderr);
  assert.equal(
    result.stdout.split("\n")[0],
    `env file: ${env.SN_ENV_FILE} (missing, from SN_ENV_FILE)`,
  );
  assert.match(result.stdout, /^[\t\n\r\x20-\x7e]*$/, "non-TTY -> ASCII");
  assert.match(result.stdout, /\[x\] Credentials/);
});

test("doctor --json: parseable JSON on stdout, same exit code", async () => {
  const env = cleanEnv();
  const result = await run([entry, "doctor", "--json"], { env });
  assert.equal(result.code, 2, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "not_configured");
  assert.deepEqual(payload.envFile, {
    path: env.SN_ENV_FILE,
    exists: false,
    source: "SN_ENV_FILE",
  });
  assert.deepEqual(
    payload.checks.map((c) => [c.name, c.ok]),
    [["credentials", false]],
  );
  assert.equal(typeof payload.serverStatus, "object");
});

test("doctor --profile: validates the name and checks that profile", async () => {
  const bad = await run([entry, "doctor", "--profile", "no way"]);
  assert.equal(bad.code, 2);
  const env = cleanEnv({ SN_PROFILE_QA_USER: "someone" });
  const result = await run([entry, "doctor", "--json", "--profile", "qa"], {
    env,
  });
  assert.equal(result.code, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).config.profile, "qa");
});

test("init with piped answers into a temp HOME writes the XDG env file and runs doctor", async () => {
  const home = mkdtempSync(join(sandbox, "home-"));
  const xdg = join(home, ".config");
  const env = cleanEnv({
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdg,
    // A closed local port: doctor fails fast and never leaves the machine.
    SN_ALLOWED_HOSTS: "127.0.0.1:9",
  });
  delete env.SN_ENV_FILE;
  const secret = "Init-Spawn-Pw-42";
  const result = await run([entry, "init"], {
    env,
    input: `127.0.0.1:9\nbasic\nalice\n${secret}\n`,
    timeoutMs: 30_000,
  });
  const envFile = join(xdg, "servicenow-mcp-ai", ".env");
  assert.ok(existsSync(envFile), result.stderr);
  const written = readFileSync(envFile, "utf8");
  assert.match(written, /^SN_INSTANCE=127\.0\.0\.1:9$/m);
  assert.match(written, /^SN_AUTH=basic$/m);
  assert.match(written, /^SN_USER=alice$/m);
  assert.ok(written.includes(secret));
  assert.ok(!result.stdout.includes(secret), "the secret is never echoed");
  assert.ok(!result.stderr.includes(secret), "the secret is never logged");
  assert.match(
    result.stdout,
    new RegExp(`Wrote .* to ${envFile.replace(/[.\\]/g, "\\$&")}`),
  );
  assert.match(result.stdout, /servicenow-mcp-ai doctor/, "doctor ran");
  assert.equal(result.code, 1, "the doctor verdict: configured, unreachable");
});

test("init on a non-TTY without piped input refuses cleanly (exit 2)", async () => {
  const env = cleanEnv();
  for (const input of [undefined, ""]) {
    const result = await run([entry, "init"], { env, input });
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /interactive terminal/);
    assert.equal(existsSync(env.SN_ENV_FILE), false, "nothing written");
  }
});

test("support-bundle: one JSON file, its path on stdout, no seeded secret inside", async () => {
  const dir = mkdtempSync(join(sandbox, "bundle-"));
  const secrets = {
    SN_PASSWORD: "Seed-Pw-Alpha-1",
    SN_OAUTH_CLIENT_SECRET: "Seed-Client-Secret-2",
    SN_OAUTH_REFRESH_TOKEN: "Seed-Refresh-Token-3",
    SN_API_KEY: "Seed-Api-Key-4",
    SN_BEARER_TOKEN: "Seed-Bearer-5",
    SN_PROFILE_QA_PASSWORD: "Seed-Qa-Pw-6",
  };
  const log = join(dir, "server.log");
  writeFileSync(log, `{"message":"oops ${secrets.SN_PASSWORD}"}\n`);
  const envFile = join(dir, ".env");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    envFile,
    [
      // A blocked host: doctor's probe fails before any network I/O.
      "SN_INSTANCE=localhost.localdomain",
      "SN_USER=alice",
      `SN_LOG_FILE=${log}`,
      ...Object.entries(secrets).map(([k, v]) => `${k}=${v}`),
    ].join("\n") + "\n",
  );
  const out = join(dir, "bundle.json");
  const result = await run([entry, "support-bundle", "--out", out], {
    env: cleanEnv({ SN_ENV_FILE: envFile }),
    timeoutMs: 60_000,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `${out}\n`);
  const text = readFileSync(out, "utf8");
  for (const [key, value] of Object.entries(secrets)) {
    assert.ok(!text.includes(value), `${key} leaked into the bundle`);
    assert.ok(!result.stdout.includes(value) && !result.stderr.includes(value));
  }
  const bundle = JSON.parse(text);
  assert.equal(bundle.versions.server, pkg.version);
  assert.equal(bundle.settings.SN_USER, "alice");
  assert.equal(bundle.settings.SN_PASSWORD, "***");
  assert.equal(bundle.envFile.path, envFile);
  assert.ok(bundle.doctor.status, "the doctor JSON is embedded");
  assert.equal(bundle.manifest.manifestVersion, 3);
  assert.ok(bundle.npm && typeof bundle.npm === "object");
  assert.equal(bundle.logTail.lines.length, 1);
});
