// N-91: the release bundle (.mcpb) reaches the MCP Registry as an `mcpb`
// package with its sha256 — appended to server.json at publish time by
// scripts/registry-mcpb.mjs and never committed, because the hash is only
// known once CI has built and attached the bundle.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  mcpbPackage,
  parseArgs,
  run,
  sha256,
  withMcpbPackage,
} from "../scripts/registry-mcpb.mjs";

const root = path.join(import.meta.dirname, "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));

const server = () => ({
  name: "io.github.Example/demo-mcp",
  version: "3.1.0",
  repository: { url: "https://github.com/Example/demo-mcp/", source: "github" },
  packages: [
    {
      registryType: "npm",
      identifier: "demo-mcp",
      version: "3.1.0",
      transport: { type: "stdio" },
    },
  ],
});
const bytes = Buffer.from("not really a zip");
const bundle = "demo-mcp-3.1.0.mcpb";

test("N-91: the entry is the release asset URL, the file hash and stdio", () => {
  const entry = mcpbPackage(server(), { file: `/tmp/x/${bundle}`, bytes });
  assert.deepEqual(entry, {
    registryType: "mcpb",
    identifier: `https://github.com/Example/demo-mcp/releases/download/v3.1.0/${bundle}`,
    version: "3.1.0",
    fileSha256: createHash("sha256").update(bytes).digest("hex"),
    transport: { type: "stdio" },
  });
  assert.equal(sha256(bytes), entry.fileSha256);
  // The registry validator's rules for an mcpb package: an https GitHub
  // release-asset URL that mentions "mcp", a sha256, no registryBaseUrl.
  assert.match(
    entry.identifier,
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/v\d+\.\d+\.\d+\/[^/]+\.mcpb$/,
  );
  assert.match(entry.identifier, /mcp/);
  assert.match(entry.fileSha256, /^[0-9a-f]{64}$/);
  assert.equal("registryBaseUrl" in entry, false);
});

test("N-91: a bundle of another version or name, or a bare server.json, is refused", () => {
  const expected = /is demo-mcp-3\.1\.0\.mcpb/;
  assert.throws(
    () => mcpbPackage(server(), { file: "demo-mcp-3.0.0.mcpb", bytes }),
    expected,
  );
  assert.throws(
    () => mcpbPackage(server(), { file: "other-3.1.0.mcpb", bytes }),
    expected,
  );
  assert.throws(
    () =>
      mcpbPackage(
        { ...server(), repository: undefined },
        { file: bundle, bytes },
      ),
    /repository\.url/,
  );
  assert.throws(
    () => mcpbPackage({ ...server(), version: "" }, { file: bundle, bytes }),
    /version is missing/,
  );
  assert.throws(
    () => mcpbPackage({ ...server(), packages: [] }, { file: bundle, bytes }),
    /no npm package/,
  );
});

test("N-91: withMcpbPackage appends once and keeps the npm package first", () => {
  const entry = mcpbPackage(server(), { file: bundle, bytes });
  const once = withMcpbPackage(server(), entry);
  const twice = withMcpbPackage(once, { ...entry, fileSha256: "0".repeat(64) });
  assert.deepEqual(
    once.packages.map((p) => p.registryType),
    ["npm", "mcpb"],
  );
  assert.deepEqual(
    twice.packages.map((p) => p.registryType),
    ["npm", "mcpb"],
  );
  assert.equal(twice.packages[1].fileSha256, "0".repeat(64));
  assert.deepEqual(withMcpbPackage({}, entry).packages, [entry]);
});

test("N-91: run writes server.json, --check only reports", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sn-registry-mcpb-"));
  try {
    writeFileSync(
      path.join(dir, "server.json"),
      JSON.stringify(server(), null, 2) + "\n",
    );
    writeFileSync(path.join(dir, bundle), bytes);
    const lines = [];
    const log = (line) => lines.push(line);

    run(["--check", bundle], { root: dir, log });
    assert.equal(
      JSON.parse(readFileSync(path.join(dir, "server.json"), "utf8")).packages
        .length,
      1,
      "--check wrote",
    );
    assert.equal(
      lines[0],
      `registry-mcpb: would add https://github.com/Example/demo-mcp/releases/download/v3.1.0/${bundle} (sha256 ${sha256(bytes)}) to server.json`,
    );

    run([bundle], { root: dir, log });
    const text = readFileSync(path.join(dir, "server.json"), "utf8");
    assert.ok(text.endsWith("}\n"), "canonical 2-space JSON with a newline");
    const written = JSON.parse(text);
    assert.deepEqual(
      written.packages.map((p) => p.registryType),
      ["npm", "mcpb"],
    );
    assert.equal(written.packages[1].fileSha256, sha256(bytes));
    assert.match(lines[1], /^registry-mcpb: added /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(["a.mcpb", "b.mcpb"]), /usage/);
  assert.deepEqual(parseArgs(["--check", "a.mcpb"]), {
    file: "a.mcpb",
    check: true,
  });
});

test("N-91: the committed server.json: npm only, the site, one templated remote", () => {
  const s = json("server.json");
  assert.deepEqual(
    s.packages.map((p) => p.registryType),
    ["npm"],
    "the mcpb package is added at publish time, never committed",
  );
  assert.equal(s.websiteUrl, "https://ivanbbaev.github.io/servicenow-mcp-ai/");
  assert.equal(s.remotes.length, 1);
  const [remote] = s.remotes;
  assert.equal(remote.type, "streamable-http");
  assert.match(remote.url, /^https:\/\/\{host\}\//);
  assert.equal(remote.variables.host.isRequired, true);
  // Every {variable} in the URL and the headers is declared next to it.
  for (const [, name] of remote.url.matchAll(/\{(\w+)\}/g)) {
    assert.ok(remote.variables[name], `url variable ${name} is undeclared`);
  }
  for (const header of remote.headers) {
    for (const [, name] of header.value.matchAll(/\{(\w+)\}/g)) {
      assert.ok(
        header.variables?.[name],
        `${header.name}: variable ${name} is undeclared`,
      );
    }
  }
  const auth = remote.headers.find((h) => h.name === "Authorization");
  assert.equal(auth.isSecret, true);
  assert.equal(auth.variables.token.isSecret, true);
  // The entry built for the live file names the asset the mcpb-asset release
  // job uploads (scripts/mcpb-pack.mjs: <name>-<version>.mcpb).
  const pkg = json("package.json");
  const entry = mcpbPackage(s, {
    file: `${pkg.name}-${pkg.version}.mcpb`,
    bytes,
  });
  assert.equal(
    entry.identifier,
    `https://github.com/IvanBBaev/servicenow-mcp-ai/releases/download/v${pkg.version}/${pkg.name}-${pkg.version}.mcpb`,
  );
});

test("N-91: publish-mcp.yml downloads the bundle and runs the script before publishing", () => {
  const yml = read(".github/workflows/publish-mcp.yml");
  const download = yml.indexOf("gh release download");
  const script = yml.indexOf("node scripts/registry-mcpb.mjs");
  const publish = yml.indexOf("./mcp-publisher publish");
  assert.ok(download > -1, "no gh release download step");
  assert.ok(script > download, "the script must run after the download");
  assert.ok(
    publish > script,
    "the script must run before mcp-publisher publish",
  );
  assert.match(yml, /--pattern '\*\.mcpb'/);
});
