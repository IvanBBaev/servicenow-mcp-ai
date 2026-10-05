// N-51 / TK-27: the MCP bundle (.mcpb). mcpb/manifest.json is generated from
// package.json, the E-4 settings manifest and the tool registry
// (scripts/mcpb-manifest.mjs) — these tests pin the mapping (user_config
// types, sensitive secrets, required keys, the env wiring), fail on drift,
// cover the zip writer of scripts/mcpb-pack.mjs and the loadEnv() guard that
// drops unsubstituted `${user_config.*}` placeholders. The release asset job
// stays dormant until O-22.
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { SETTINGS } from "../build/core/settings-manifest.js";
import { describeAllTools } from "../build/mcp/registry.js";
import { dropUnsetBundleValues } from "../build/core/config.js";
import {
  MCPB_MANIFEST,
  buildMcpbManifest,
  isBundleSetting,
  syncMcpbManifest,
  userConfigEntry,
  userConfigKey,
  userConfigTitle,
  userConfigType,
} from "../scripts/mcpb-manifest.mjs";
import { excluded, zip } from "../scripts/mcpb-pack.mjs";

const root = path.join(import.meta.dirname, "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const pkg = JSON.parse(read("package.json"));
const tools = describeAllTools();
const input = { pkg, settings: SETTINGS, tools };
const manifest = buildMcpbManifest(input);
const bundleSpecs = SETTINGS.filter(isBundleSetting);

// The option keys the MCPB 0.3 schema accepts (a strict object).
const USER_CONFIG_KEYS = new Set([
  "type",
  "title",
  "description",
  "required",
  "default",
  "multiple",
  "sensitive",
  "min",
  "max",
]);

test("N-51: mcpb/manifest.json is current (npm run mcpb:manifest)", async () => {
  assert.equal(await syncMcpbManifest({ root, check: true, ...input }), false);
  assert.deepEqual(JSON.parse(read(MCPB_MANIFEST)), manifest);
});

test("N-51: identity comes from package.json", () => {
  assert.equal(manifest.manifest_version, "0.3");
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.description, pkg.description);
  assert.equal(manifest.license, pkg.license);
  assert.deepEqual(manifest.keywords, pkg.keywords);
  assert.deepEqual(manifest.author, {
    name: "Ivan Baev",
    email: "ivanbbaev@gmail.com",
  });
  assert.equal(manifest.compatibility.runtimes.node, pkg.engines.node);
  assert.doesNotMatch(manifest.repository.url, /^git\+/);
});

test("N-51: the server entry runs the built CLI with every bundle setting", () => {
  const { server } = manifest;
  assert.equal(server.type, "node");
  assert.equal(server.entry_point, "build/index.js");
  assert.deepEqual(server.mcp_config.args, ["${__dirname}/build/index.js"]);
  assert.deepEqual(
    Object.keys(server.mcp_config.env),
    bundleSpecs.map((s) => s.key),
  );
  for (const [envKey, value] of Object.entries(server.mcp_config.env)) {
    const key = userConfigKey(envKey);
    assert.equal(value, `\${user_config.${key}}`);
    assert.ok(manifest.user_config[key], `${envKey} has no user_config entry`);
  }
});

test("N-51: user_config covers the connection section and the registry keys", () => {
  const keys = new Set(bundleSpecs.map((s) => s.key));
  for (const spec of SETTINGS) {
    if (spec.pattern || spec.external) {
      assert.ok(!keys.has(spec.key), `${spec.key} is a pattern/external key`);
    } else if (spec.section === "connection" || spec.registry !== undefined) {
      assert.ok(keys.has(spec.key), `${spec.key} is missing`);
    }
  }
  for (const key of [
    "SN_INSTANCE",
    "SN_PASSWORD",
    "SN_OAUTH_CLIENT_SECRET",
    "SN_TOOL_PACKAGES",
  ]) {
    assert.ok(keys.has(key), `${key} is missing`);
  }
  assert.equal(Object.keys(manifest.user_config).length, bundleSpecs.length);
});

test("N-51: every secret is sensitive, nothing else is", () => {
  const secrets = bundleSpecs.filter((s) => s.secret);
  assert.ok(secrets.length >= 6, "the connection section lost its secrets");
  for (const spec of bundleSpecs) {
    const entry = manifest.user_config[userConfigKey(spec.key)];
    if (spec.secret) assert.equal(entry.sensitive, true, spec.key);
    else assert.equal(entry.sensitive, undefined, spec.key);
  }
  for (const key of [
    "password",
    "api_key",
    "bearer_token",
    "oauth_client_secret",
    "oauth_refresh_token",
    "oauth_jwt_key",
  ]) {
    assert.equal(manifest.user_config[key].sensitive, true, key);
  }
});

test("N-51: only the instance is required, and no field carries a default", () => {
  const required = Object.entries(manifest.user_config)
    .filter(([, e]) => e.required)
    .map(([k]) => k);
  assert.deepEqual(required, ["instance"]);
  for (const [key, entry] of Object.entries(manifest.user_config)) {
    // A default would be substituted into the env and shadow the env file.
    assert.equal(entry.default, undefined, key);
    for (const prop of Object.keys(entry)) {
      assert.ok(USER_CONFIG_KEYS.has(prop), `${key}.${prop} is not in 0.3`);
    }
    assert.ok(entry.title && entry.description, key);
    assert.match(entry.description, /\(SN_[A-Z_]+\)$/);
    assert.doesNotMatch(entry.description, /\*\*|`/, `${key}: raw markdown`);
  }
});

test("N-51: setting kinds map onto user_config types", () => {
  assert.equal(userConfigType("int"), "number");
  assert.equal(userConfigType("bool"), "boolean");
  assert.equal(userConfigType("path"), "file");
  for (const kind of ["string", "secret", "enum", "url", "date", "list"]) {
    assert.equal(userConfigType(kind), "string", kind);
  }
  assert.equal(manifest.user_config.oauth_jwt_exp_sec.type, "number");
  assert.equal(manifest.user_config.token_file.type, "file");
  assert.equal(
    manifest.user_config.allow_unconfirmed_credential_change.type,
    "boolean",
  );
});

test("N-51: titles and descriptions", () => {
  assert.equal(userConfigTitle("SN_OAUTH_CLIENT_ID"), "OAuth client ID");
  assert.equal(userConfigTitle("SN_API_KEY"), "API key");
  assert.equal(userConfigTitle("SN_OAUTH_JWT_ISS"), "OAuth JWT iss");
  const entry = userConfigEntry({
    key: "SN_X_LIMIT",
    section: "connection",
    kind: "int",
    description: "A **bold** `code` [link](https://example.com).",
    default: 5,
  });
  assert.deepEqual(entry, {
    type: "number",
    title: "X limit",
    description: "A bold code link. Default: 5. (SN_X_LIMIT)",
    required: false,
  });
  const secret = userConfigEntry({
    key: "SN_X_TOKEN",
    section: "connection",
    kind: "secret",
    description: "Token.",
    secret: true,
    registryRequired: true,
  });
  assert.equal(secret.sensitive, true);
  assert.equal(secret.required, true);
});

test("N-51: two settings may not collapse onto one user_config key", () => {
  const settings = [
    { key: "SN_A", section: "connection", kind: "string", description: "a" },
    { key: "SN_a", section: "connection", kind: "string", description: "b" },
  ];
  assert.throws(
    () => buildMcpbManifest({ pkg, settings, tools: [] }),
    /shared by SN_A and SN_a/,
  );
});

test("N-51: tools are the registry's, by name", () => {
  assert.equal(manifest.tools.length, tools.length);
  const names = manifest.tools.map((t) => t.name);
  assert.deepEqual(
    names,
    [...names].sort((a, b) => a.localeCompare(b)),
  );
  for (const tool of manifest.tools) {
    assert.deepEqual(Object.keys(tool), ["name", "description"]);
    assert.ok(tool.description, tool.name);
  }
  assert.equal(manifest.prompts_generated, true);
});

test("N-51: --check reports drift and writes nothing; a write fixes it", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "mcpb-manifest-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "mcpb"));
  const file = path.join(dir, MCPB_MANIFEST);
  const stale = read(MCPB_MANIFEST).replace(
    '"oauth_client_secret": {',
    '"oauth_client_secret_typo": {',
  );
  writeFileSync(file, stale);

  assert.equal(
    await syncMcpbManifest({ root: dir, check: true, ...input }),
    true,
  );
  assert.equal(readFileSync(file, "utf8"), stale);

  assert.equal(await syncMcpbManifest({ root: dir, ...input }), true);
  assert.equal(readFileSync(file, "utf8"), read(MCPB_MANIFEST));
  assert.equal(
    await syncMcpbManifest({ root: dir, check: true, ...input }),
    false,
  );

  // A setting change is drift too.
  const changed = SETTINGS.map((s) =>
    s.key === "SN_USER" ? { ...s, secret: true } : s,
  );
  assert.equal(
    await syncMcpbManifest({
      root: dir,
      check: true,
      ...input,
      settings: changed,
    }),
    true,
  );
});

test("N-51: the pack never ships source maps, typings or the dark Jira client", () => {
  assert.equal(excluded("build/index.js"), false);
  assert.equal(excluded("build/index.js.map"), true);
  assert.equal(excluded("build/core/jira/client.js"), true);
  assert.equal(excluded("node_modules/zod/index.d.ts"), true);
  assert.equal(excluded("node_modules/x/index.d.cts"), true);
  assert.equal(excluded("node_modules/.bin/acorn"), true);
  assert.equal(excluded("node_modules/jira/index.js"), false);
});

/** Read back a zip written by zip(): { name -> { data, mode } }. */
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "no end of central directory");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const mode = buf.readUInt32LE(at + 38) >>> 16;
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    const localName = buf.readUInt16LE(offset + 26);
    const start = offset + 30 + localName + buf.readUInt16LE(offset + 28);
    const body = buf.subarray(start, start + size);
    const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
    assert.equal(zlib.crc32(data), crc, name);
    out[name] = { data, mode: mode & 0o777 };
    at += 46 + nameLen;
  }
  return out;
}

test("N-51: the zip writer round-trips and is deterministic", () => {
  const entries = [
    { name: "manifest.json", data: Buffer.from('{"a":1}') },
    {
      name: "build/index.js",
      data: Buffer.from("x".repeat(4096)),
      mode: 0o755,
    },
    { name: "empty.txt", data: Buffer.alloc(0) },
  ];
  const archive = zip(entries);
  assert.deepEqual(zip(entries), archive);
  const files = unzip(archive);
  assert.deepEqual(
    Object.keys(files),
    entries.map((e) => e.name),
  );
  assert.equal(files["manifest.json"].data.toString(), '{"a":1}');
  assert.equal(files["build/index.js"].data.length, 4096);
  assert.equal(files["build/index.js"].mode, 0o755);
  assert.equal(files["manifest.json"].mode, 0o644);
  assert.equal(files["empty.txt"].data.length, 0);
});

test("N-51: loadEnv drops unsubstituted ${user_config.*} placeholders only", () => {
  const env = {
    SN_INSTANCE: "dev1",
    SN_USER: "${user_config.user}",
    SN_PASSWORD: "${user_config.password}",
    SN_OAUTH_SCOPE: "",
    OTHER: "prefix ${user_config.x}",
  };
  const dropped = dropUnsetBundleValues(env);
  assert.deepEqual(dropped.sort(), ["SN_PASSWORD", "SN_USER"]);
  assert.deepEqual(env, {
    SN_INSTANCE: "dev1",
    SN_OAUTH_SCOPE: "",
    OTHER: "prefix ${user_config.x}",
  });
});

test("N-51: the release asset job is dormant until O-22 (MCPB_RELEASE)", () => {
  const wf = read(".github/workflows/publish.yml");
  const at = wf.indexOf("  mcpb-asset:");
  assert.ok(at > 0, "no mcpb-asset job");
  const job = wf.slice(at);
  assert.match(job, /needs: github-release/);
  assert.match(job, /if: \$\{\{ vars\.MCPB_RELEASE == 'true' \}\}/);
  assert.match(job, /npm run mcpb:pack/);
  assert.match(
    job,
    /gh release upload "\$GITHUB_REF_NAME" dist\/mcpb\/\*\.mcpb/,
  );
  // The bundle is never part of the npm package.
  assert.ok(!pkg.files.some((f) => f.includes("mcpb") || f.includes("dist")));
  assert.match(read(".gitignore"), /^\*\.mcpb$/m);
});
