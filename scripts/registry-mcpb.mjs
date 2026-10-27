// N-91: register the release bundle (.mcpb) in the MCP Registry next to the
// npm package. The registry requires `fileSha256` on an `mcpb` package and
// HEADs its identifier URL, so the entry can only be written once CI has built
// and attached the bundle: the committed server.json carries the npm package
// alone (scripts/sync-version.mjs keeps its version current) and
// .github/workflows/publish-mcp.yml runs this script after
// `gh release download v<version> --pattern '*.mcpb'`, right before
// `mcp-publisher publish`:
//
//   node scripts/registry-mcpb.mjs dist/mcpb/servicenow-mcp-ai-3.1.0.mcpb
//   node scripts/registry-mcpb.mjs --check <bundle>   print the entry, write nothing
//
// The identifier is the release asset URL,
// <repository.url>/releases/download/v<version>/<bundle name>. The bundle name
// must be the one scripts/mcpb-pack.mjs produces for server.json's version
// (`<npm identifier>-<version>.mcpb`), so a stale download can never be
// registered under a newer version. test/registry-mcpb.test.js is the guard.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SERVER_JSON = "server.json";

/** Hex SHA-256 of a buffer — the registry's `fileSha256`. */
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The `mcpb` package entry for `server` (a parsed server.json) and a bundle. */
export function mcpbPackage(server, { file, bytes }) {
  const repo = server.repository?.url?.replace(/\/+$/, "");
  if (!repo) throw new Error(`${SERVER_JSON}: repository.url is missing`);
  if (!server.version) throw new Error(`${SERVER_JSON}: version is missing`);
  const npm = (server.packages ?? []).find((p) => p.registryType === "npm");
  if (!npm) {
    throw new Error(`${SERVER_JSON}: no npm package to name the bundle after`);
  }
  const name = path.basename(file);
  const expected = `${npm.identifier}-${server.version}.mcpb`;
  if (name !== expected) {
    throw new Error(
      `${name}: the bundle of ${SERVER_JSON} ${server.version} is ${expected}`,
    );
  }
  return {
    registryType: "mcpb",
    identifier: `${repo}/releases/download/v${server.version}/${name}`,
    version: server.version,
    fileSha256: sha256(bytes),
    transport: { type: "stdio" },
  };
}

/** `server` with `entry` as its only `mcpb` package, after the others. */
export function withMcpbPackage(server, entry) {
  const packages = (server.packages ?? []).filter(
    (p) => p.registryType !== "mcpb",
  );
  return { ...server, packages: [...packages, entry] };
}

/** `{ file, check }` from argv: one bundle path and the optional --check. */
export function parseArgs(argv) {
  const check = argv.includes("--check");
  const files = argv.filter((a) => !a.startsWith("--"));
  if (files.length !== 1) {
    throw new Error(
      "usage: node scripts/registry-mcpb.mjs [--check] <bundle.mcpb>",
    );
  }
  return { file: files[0], check };
}

/** Add the bundle named in `argv` to `<root>/server.json`; returns the entry. */
export function run(argv, { root = process.cwd(), log = () => {} } = {}) {
  const { file, check } = parseArgs(argv);
  const serverPath = path.join(root, SERVER_JSON);
  const server = JSON.parse(readFileSync(serverPath, "utf8"));
  const abs = path.resolve(root, file);
  const entry = mcpbPackage(server, { file: abs, bytes: readFileSync(abs) });
  if (!check) {
    writeFileSync(
      serverPath,
      JSON.stringify(withMcpbPackage(server, entry), null, 2) + "\n",
    );
  }
  log(
    `registry-mcpb: ${check ? "would add" : "added"} ${entry.identifier} (sha256 ${entry.fileSha256}) to ${SERVER_JSON}`,
  );
  return entry;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    run(process.argv.slice(2), { log: console.log });
  } catch (err) {
    console.error(`registry-mcpb: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
