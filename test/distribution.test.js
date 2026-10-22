// D-6: distribution hygiene. Static guards over the files that decide what
// users install: the extension launches one pinned server major through one
// constant, the publish workflows reach Open VSX and create a GitHub Release
// from the CHANGELOG, every third-party action stays SHA-pinned (H-9), and no
// distribution file points at the pre-rename `LeassTaTT` namespace.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  extractReleaseNotes,
  fitReleaseNotes,
  MAX_RELEASE_NOTES,
  releaseNotesFor,
} from "../scripts/release-notes.mjs";

const root = path.join(import.meta.dirname, "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));

const extensionSources = readdirSync(path.join(root, "extension/src"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => `extension/src/${f}`);

// --- the pinned server major -------------------------------------------------

test("D-6: the extension pins the server major in one constant", () => {
  const config = read("extension/src/config.ts");
  const range = config.match(/export const SERVER_VERSION_RANGE = "([^"]+)";/);
  assert.ok(range, "SERVER_VERSION_RANGE is not declared in config.ts");
  // `N.x` — a whole major, and caret-free so cmd.exe cannot mangle it.
  assert.match(range[1], /^\d+\.x$/);
  // MC-2: the extension follows package.json (version:sync), so the pin is the
  // package.json major — a major bump that leaves it behind fails here (B9:
  // the 3.0.0 bump raises it to 3.x together with the version).
  const major = json("package.json").version.split(".")[0];
  assert.equal(
    range[1],
    `${major}.x`,
    `the extension must launch the server major it ships with (package.json ${major}.x)`,
  );
  assert.equal(json("extension/package.json").version.split(".")[0], major);
  assert.match(
    config,
    /export const SERVER_SPEC = `\$\{SERVER_PACKAGE\}@\$\{SERVER_VERSION_RANGE\}`;/,
  );
});

test("D-6: every launcher goes through serverLaunch and SERVER_SPEC", () => {
  const doctor = read("extension/src/doctor.ts");
  assert.match(doctor, /args: \["-y", SERVER_SPEC, \.\.\.extraArgs\]/);

  for (const file of extensionSources) {
    const src = read(file);
    if (file !== "extension/src/config.ts") {
      assert.ok(
        !/\bSERVER_PACKAGE\b/.test(src),
        `${file} uses the unpinned SERVER_PACKAGE`,
      );
    }
    // Any process spawn or stdio definition must take its command line from
    // serverLaunch() in the same file.
    if (/\bspawn\(|McpStdioServerDefinition\(/.test(src)) {
      assert.match(
        src,
        /serverLaunch\(/,
        `${file} spawns without serverLaunch`,
      );
      assert.ok(
        !/["']servicenow-mcp-ai["']\s*[,\]]/.test(src),
        `${file} passes a bare package name`,
      );
    }
  }
  // The three launchers named in D-6.
  assert.match(read("extension/src/extension.ts"), /serverLaunch\(\)/);
  assert.match(read("extension/src/extension.ts"), /serverLaunch\(\["doctor"/);
  assert.match(read("extension/src/http-process.ts"), /serverLaunch\(\)/);
});

// --- publish workflows -------------------------------------------------------

test("D-6: publish-vscode.yml publishes one .vsix to the Marketplace and Open VSX", () => {
  const wf = read(".github/workflows/publish-vscode.yml");
  assert.match(wf, /vsce package --no-dependencies -o servicenow-mcp-ai\.vsix/);
  // --skip-duplicate on both registries, so a re-run never fails on a version
  // one of them already has.
  assert.match(
    wf,
    /vsce publish .*--skip-duplicate --packagePath servicenow-mcp-ai\.vsix/,
  );
  assert.match(wf, /OVSX_PAT: \$\{\{ secrets\.OVSX_PAT \}\}/);
  assert.match(wf, /OVSX_VERSION: \d+\.\d+\.\d+\n/, "ovsx is not pinned");
  const step = wf.slice(wf.indexOf("- name: Publish to Open VSX"));
  assert.match(step, /if: \$\{\{ env\.OVSX_PAT != '' \}\}/);
  assert.match(
    step,
    /npx --yes "ovsx@\$\{OVSX_VERSION\}" publish servicenow-mcp-ai\.vsix --skip-duplicate -p "\$OVSX_PAT"/,
  );
});

test("D-6: publish.yml creates a GitHub Release from the CHANGELOG section", () => {
  const wf = read(".github/workflows/publish.yml");
  const job = wf.slice(wf.indexOf("  github-release:"));
  assert.ok(job.length < wf.length, "no github-release job");
  assert.match(job, /needs: publish/);
  assert.match(job, /contents: write/);
  assert.match(
    job,
    /node scripts\/release-notes\.mjs "\$\{GITHUB_REF_NAME#v\}" > release-notes\.md/,
  );
  assert.match(job, /gh release create "\$GITHUB_REF_NAME" --verify-tag/);
  assert.match(job, /--notes-file release-notes\.md/);
  // The workflow-level token stays read-only; only the release job writes.
  assert.match(wf, /^permissions:\n {2}contents: read$/m);
  // npm provenance keeps working next to publishConfig.
  assert.match(wf, /npm publish --provenance --access public/);
});

test("O-14: a prerelease tag goes to npm next, a prerelease GitHub Release, and no registry", () => {
  const wf = read(".github/workflows/publish.yml");
  const tag = wf.slice(wf.indexOf("- name: Choose the npm dist-tag"));
  assert.match(tag, /\*-\*\) echo "NPM_DIST_TAG=next" >> "\$GITHUB_ENV"/);
  assert.match(tag, /\*\) echo "NPM_DIST_TAG=latest" >> "\$GITHUB_ENV"/);
  assert.match(wf, /npm publish [^\n]*--tag "\$NPM_DIST_TAG"/);
  const job = wf.slice(wf.indexOf("  github-release:"));
  assert.match(job, /\*-\*\) pre=--prerelease/);
  assert.match(
    job,
    /gh release create "\$GITHUB_REF_NAME" --verify-tag \$pre \\/,
  );
  assert.match(job, /gh release edit [^\n]*release-notes\.md \$pre\n/);
  // The MCP Registry and the extension move only on a GA tag.
  assert.match(
    read(".github/workflows/publish-mcp.yml"),
    /!contains\(github\.event\.workflow_run\.head_branch, '-'\)/,
  );
  assert.match(
    read(".github/workflows/publish-vscode.yml"),
    /publish-vscode:\n {4}if: \$\{\{ github\.event_name == 'workflow_dispatch' \|\| !contains\(github\.ref_name, '-'\) \}\}/,
  );
});

test("H-9: every workflow action is pinned to a commit SHA", () => {
  const dir = path.join(root, ".github/workflows");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
    const text = readFileSync(path.join(dir, file), "utf8");
    for (const [, ref] of text.matchAll(/^\s*-?\s*uses:\s*(\S+.*)$/gm)) {
      assert.match(
        ref,
        /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d/,
        `${file}: "${ref}" is not SHA-pinned with a version comment`,
      );
    }
  }
});

test("D-6: package.json publishConfig matches the publish workflow", () => {
  const pkg = json("package.json");
  assert.deepEqual(pkg.publishConfig, { access: "public", provenance: true });
});

// --- the exports map (B23) ---------------------------------------------------

test("B23: only the entry point and package.json are exported", () => {
  const pkg = json("package.json");
  assert.deepEqual(pkg.exports, {
    ".": "./build/index.js",
    "./package.json": "./package.json",
  });
  assert.equal(pkg.main, pkg.exports["."]);
  // The entry point runs the CLI when it is imported; every other module is
  // free of import-time effects (D-1), so only the entry is listed.
  assert.deepEqual(pkg.sideEffects, ["./build/index.js"]);
});

test("B23: deep imports stop resolving through the package name", () => {
  const resolve = (spec) => import.meta.resolve(spec);
  assert.equal(
    resolve("servicenow-mcp-ai"),
    new URL("../build/index.js", import.meta.url).href,
  );
  assert.equal(
    resolve("servicenow-mcp-ai/package.json"),
    new URL("../package.json", import.meta.url).href,
  );
  for (const deep of [
    "servicenow-mcp-ai/build/cli.js",
    "servicenow-mcp-ai/build/server.js",
    "servicenow-mcp-ai/bin/servicenow-mcp-ai.cjs",
  ]) {
    assert.throws(
      () => resolve(deep),
      { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
      deep,
    );
  }
});

test("B23: no shipped file deep-imports the package by name", () => {
  const files = [
    "bin/servicenow-mcp-ai.cjs",
    ...extensionSources,
    ...readdirSync(path.join(root, "scripts"))
      .filter((f) => /\.(c|m)?js$/.test(f))
      .map((f) => `scripts/${f}`),
  ];
  for (const file of files) {
    assert.doesNotMatch(
      read(file),
      /["']servicenow-mcp-ai\/(?!package\.json["'])/,
      `${file} deep-imports servicenow-mcp-ai`,
    );
  }
});

// --- stale registry namespace ------------------------------------------------

test("D-6: no distribution file names the stale LeassTaTT namespace", () => {
  const files = [
    "package.json",
    "server.json",
    "smithery.yaml",
    "Dockerfile",
    "README.md",
    "docs/index.html",
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    "extension/package.json",
    "extension/README.md",
    ...readdirSync(path.join(root, ".github/workflows")).map(
      (f) => `.github/workflows/${f}`,
    ),
    ...extensionSources,
  ];
  for (const file of files) {
    assert.ok(!/LeassTaTT/i.test(read(file)), `${file} names LeassTaTT`);
  }
  assert.equal(json("server.json").name, json("package.json").mcpName);
  assert.match(json("package.json").mcpName, /^io\.github\.IvanBBaev\//);
});

// --- scripts/release-notes.mjs -----------------------------------------------

const changelog = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- next",
  "",
  "## [3.0.0] - 2026-10-01",
  "",
  "Intro line.",
  "",
  "### Breaking changes",
  "",
  "- one",
  "",
  "## [2.0.1] - 2026-06-27",
  "",
  "- fix",
  "",
  "## [2.0.0]",
  "",
  "[Unreleased]: https://example.com/compare/v3.0.0...HEAD",
  "[3.0.0]: https://example.com/compare/v2.0.1...v3.0.0",
  "",
].join("\r\n");

test("release-notes: extracts one version's section without its heading", () => {
  assert.equal(
    extractReleaseNotes(changelog, "3.0.0"),
    "Intro line.\n\n### Breaking changes\n\n- one\n",
  );
  assert.equal(extractReleaseNotes(changelog, "v2.0.1"), "- fix\n");
  assert.equal(
    extractReleaseNotes(changelog, "Unreleased"),
    "### Added\n\n- next\n",
  );
});

test("release-notes: a missing, empty or partial version gives undefined", () => {
  assert.equal(extractReleaseNotes(changelog, "9.9.9"), undefined);
  // The last section stops at the link references and is empty.
  assert.equal(extractReleaseNotes(changelog, "2.0.0"), undefined);
  // A prefix of another version does not match it; dots are literal.
  assert.equal(extractReleaseNotes(changelog, "3.0"), undefined);
  assert.equal(extractReleaseNotes(changelog, "3x0x0"), undefined);
  assert.equal(extractReleaseNotes(changelog, ""), undefined);
  assert.equal(extractReleaseNotes(changelog, "v"), undefined);
});

test("release-notes: a prerelease without its own section takes [Unreleased]", () => {
  // Betas keep their notes under [Unreleased] until GA (ADR 0012).
  assert.equal(
    releaseNotesFor(changelog, "3.1.0-beta.1"),
    "### Added\n\n- next\n",
  );
  assert.equal(
    releaseNotesFor(changelog, "v3.1.0-rc.2"),
    "### Added\n\n- next\n",
  );
  // A version's own section still wins, also for a prerelease.
  assert.equal(
    releaseNotesFor(changelog, "3.0.0"),
    extractReleaseNotes(changelog, "3.0.0"),
  );
  // A GA version never falls back.
  assert.equal(releaseNotesFor(changelog, "9.9.9"), undefined);
  assert.equal(releaseNotesFor(changelog, "beta-1"), undefined);
  const noUnreleased = changelog.replace(
    /## \[Unreleased\][\s\S]*?(?=## \[3\.0\.0\])/,
    "",
  );
  assert.equal(releaseNotesFor(noUnreleased, "3.1.0-beta.1"), undefined);
});

test("release-notes: notes over the GitHub limit are cut with a CHANGELOG link", () => {
  assert.equal(fitReleaseNotes("- a\n- b\n", "3.0.0", 100), "- a\n- b\n");
  const long = Array.from({ length: 200 }, (_, i) => `- item ${i}`).join("\n");
  const cut = fitReleaseNotes(long, "3.0.0-beta.1", 500);
  assert.ok(cut.length <= 500, `${cut.length} > 500`);
  assert.match(cut, /^- item 0\n/);
  assert.match(cut, /- item \d+\n\n---\n/); // cut at a whole line
  assert.match(cut, /blob\/v3\.0\.0-beta\.1\/CHANGELOG\.md\)/);
  // The real notes for the current version fit GitHub's limit after the cut.
  const version = json("package.json").version;
  const notes = releaseNotesFor(read("CHANGELOG.md"), version);
  assert.ok(fitReleaseNotes(notes, version).length <= MAX_RELEASE_NOTES);
});

test("release-notes: the real CHANGELOG has notes for the current version", () => {
  const version = json("package.json").version;
  const notes = releaseNotesFor(read("CHANGELOG.md"), version);
  assert.ok(notes, `CHANGELOG.md has no section for ${version}`);
  assert.ok(!notes.startsWith("## "));
});
