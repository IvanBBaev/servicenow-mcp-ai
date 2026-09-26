// L9-12: one version, everywhere. package.json is the source of truth; every
// other file that carries the version — both lockfiles, server.json, the VS
// Code extension, the Claude plugin manifest and the docs site — must agree,
// and .claude-plugin/marketplace.json must not grow a version of its own that
// could drift. scripts/sync-version.mjs is the writer (wired into `npm
// version`); this test is the reader that fails CI on skew, plus fixture runs
// of the writer itself.
//
// It also pins the bin launcher's Node guard to engines.node: the CI
// launcher-node12 probe derives its expected message from engines.node, so the
// launcher literal and the engines field cannot be bumped independently.
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
import { fileURLToPath } from "node:url";
import { FOLLOWERS, syncVersion } from "../scripts/sync-version.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));

const rootVersion = json("package.json").version;

test("version-sync: every version-bearing file agrees with package.json", () => {
  assert.match(rootVersion, /^\d+\.\d+\.\d+/);

  const lock = json("package-lock.json");
  const server = json("server.json");
  const extension = json("extension/package.json");
  const extensionLock = json("extension/package-lock.json");
  const plugin = json(".claude-plugin/plugin.json");
  const site = read("docs/index.html");

  assert.ok(server.packages.length > 0, "server.json lists no packages");
  const seen = {
    "package-lock.json version": lock.version,
    'package-lock.json packages[""].version': lock.packages[""].version,
    "server.json version": server.version,
    ...Object.fromEntries(
      server.packages.map((pkg, i) => [
        `server.json packages[${i}].version`,
        pkg.version,
      ]),
    ),
    "extension/package.json version": extension.version,
    "extension/package-lock.json version": extensionLock.version,
    'extension/package-lock.json packages[""].version':
      extensionLock.packages[""].version,
    ".claude-plugin/plugin.json version": plugin.version,
  };
  for (const [where, version] of Object.entries(seen)) {
    assert.equal(version, rootVersion, `${where} drifts from package.json`);
  }

  assert.ok(
    site.includes(`"softwareVersion": "${rootVersion}"`),
    "docs/index.html softwareVersion drifts from package.json",
  );
  assert.ok(
    site.includes(`<span class="ver-pill">v${rootVersion}</span>`),
    "docs/index.html ver-pill drifts from package.json",
  );
});

test("version-sync: marketplace.json carries no version of its own", () => {
  const marketplace = json(".claude-plugin/marketplace.json");
  // The marketplace manifest points at the plugin; the version lives in
  // plugin.json only. Should a version ever be added here, it must be synced.
  if ("version" in marketplace) {
    assert.equal(marketplace.version, rootVersion);
  } else {
    assert.equal(marketplace.version, undefined);
  }
  for (const plugin of marketplace.plugins) {
    if ("version" in plugin) assert.equal(plugin.version, rootVersion);
  }
});

test("launcher: the Node guard in bin/servicenow-mcp-ai.cjs pins engines.node", () => {
  const enginesNode = json("package.json").engines.node;
  const major = enginesNode.replace(/\D/g, "");
  assert.match(major, /^\d+$/, `engines.node "${enginesNode}" has no major`);

  const launcher = read("bin/servicenow-mcp-ai.cjs");
  const guard = launcher.match(/if \(major < (\d+)\)/);
  const message = launcher.match(/requires Node\.js >= (\d+)/);
  assert.equal(guard?.[1], major, "launcher guard major != engines.node");
  assert.equal(message?.[1], major, "launcher message major != engines.node");
});

// --- scripts/sync-version.mjs against a fixture tree ---------------------

const canonical = (value) => JSON.stringify(value, null, 2) + "\n";

function writeFixture(dir, rel, text) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

/** A minimal repo where every follower sits at `stale` and package.json at `next`. */
function fixture(t, { next, stale }) {
  const dir = mkdtempSync(path.join(tmpdir(), "version-sync-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockfile = canonical({
    name: "x",
    version: stale,
    lockfileVersion: 3,
    packages: {
      "": { name: "x", version: stale },
      "node_modules/dep": { version: "9.9.9" },
    },
  });
  writeFixture(dir, "package.json", canonical({ name: "x", version: next }));
  writeFixture(dir, "package-lock.json", lockfile);
  writeFixture(
    dir,
    "server.json",
    canonical({
      name: "io.github.x/x",
      version: stale,
      packages: [
        { registryType: "npm", version: stale },
        { registryType: "mcpb", version: stale },
      ],
    }),
  );
  writeFixture(
    dir,
    "extension/package.json",
    canonical({ name: "x", version: stale }),
  );
  writeFixture(dir, "extension/package-lock.json", lockfile);
  // prettier-shaped: the array stays on one line, which is not the
  // JSON.stringify form — the sync must not reflow it.
  writeFixture(
    dir,
    ".claude-plugin/plugin.json",
    `{\n  "name": "x",\n  "version": "${stale}",\n  "keywords": ["a", "b"],\n  "mcpServers": { "x": { "command": "npx" } }\n}\n`,
  );
  writeFixture(
    dir,
    "docs/index.html",
    `<script type="application/ld+json">{ "softwareVersion": "${stale}", "x": "${stale}" }</script>\n` +
      `<span class="ver-pill">v${stale}</span> v${stale}\n`,
  );
  return dir;
}

test("sync-version: --check reports every drifting follower and writes nothing", (t) => {
  const dir = fixture(t, { next: "3.1.0", stale: "3.0.0" });
  const before = Object.fromEntries(
    FOLLOWERS.map((f) => [
      f.file,
      readFileSync(path.join(dir, f.file), "utf8"),
    ]),
  );

  const result = syncVersion({ root: dir, check: true });

  assert.equal(result.version, "3.1.0");
  assert.deepEqual(
    result.drift,
    FOLLOWERS.map((f) => f.file),
  );
  for (const f of FOLLOWERS) {
    assert.equal(readFileSync(path.join(dir, f.file), "utf8"), before[f.file]);
  }
});

test("sync-version: writes the root version into every follower, then is a no-op", (t) => {
  const dir = fixture(t, { next: "3.1.0", stale: "3.0.0" });
  const at = (rel) => readFileSync(path.join(dir, rel), "utf8");

  const first = syncVersion({ root: dir });
  assert.equal(first.drift.length, FOLLOWERS.length);

  const lock = JSON.parse(at("package-lock.json"));
  assert.equal(lock.version, "3.1.0");
  assert.equal(lock.packages[""].version, "3.1.0");
  assert.equal(lock.packages["node_modules/dep"].version, "9.9.9");
  const server = JSON.parse(at("server.json"));
  assert.equal(server.version, "3.1.0");
  assert.deepEqual(
    server.packages.map((p) => p.version),
    ["3.1.0", "3.1.0"],
  );
  assert.equal(JSON.parse(at("extension/package.json")).version, "3.1.0");
  const extensionLock = JSON.parse(at("extension/package-lock.json"));
  assert.equal(extensionLock.version, "3.1.0");
  assert.equal(extensionLock.packages[""].version, "3.1.0");

  const plugin = at(".claude-plugin/plugin.json");
  assert.equal(JSON.parse(plugin).version, "3.1.0");
  assert.ok(
    plugin.includes('"keywords": ["a", "b"]'),
    "plugin.json was reflowed",
  );
  assert.ok(plugin.includes('"mcpServers": { "x": { "command": "npx" } }'));

  const site = at("docs/index.html");
  assert.ok(site.includes('"softwareVersion": "3.1.0"'));
  assert.ok(site.includes('<span class="ver-pill">v3.1.0</span>'));
  // Only the two documented patterns move; other occurrences are untouched.
  assert.ok(site.includes('"x": "3.0.0"'));
  assert.ok(site.endsWith("</span> v3.0.0\n"));

  const second = syncVersion({ root: dir, check: true });
  assert.deepEqual(second.drift, []);
});

test("sync-version: rejects a non-canonical follower with nested version fields", (t) => {
  const dir = fixture(t, { next: "3.1.0", stale: "3.0.0" });
  // A prettier-shaped server.json whose packages[].version the top-level line
  // patch cannot reach must fail loudly rather than sync half of the file.
  writeFixture(
    dir,
    "server.json",
    '{\n  "version": "3.0.0",\n  "packages": [{ "version": "3.0.0" }]\n}\n',
  );
  assert.throws(
    () => syncVersion({ root: dir, check: true }),
    /server\.json: not in canonical JSON form/,
  );
});

test("sync-version: rejects a docs page without both version patterns", (t) => {
  const dir = fixture(t, { next: "3.1.0", stale: "3.0.0" });
  writeFixture(
    dir,
    "docs/index.html",
    '<span class="ver-pill">v3.0.0</span>\n',
  );
  assert.throws(
    () => syncVersion({ root: dir }),
    /docs\/index\.html: expected both "softwareVersion"/,
  );
});

test("sync-version: rejects a package.json without a version", (t) => {
  const dir = fixture(t, { next: "3.1.0", stale: "3.0.0" });
  writeFixture(dir, "package.json", canonical({ name: "x" }));
  assert.throws(
    () => syncVersion({ root: dir }),
    /package\.json: missing version/,
  );
});
