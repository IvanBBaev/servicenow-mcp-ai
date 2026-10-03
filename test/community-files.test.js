// D-9 / L9-10, L9-11: the security policy and the community standard files.
// They are docs, but three promises in them are contracts: the bug form asks
// for `doctor --json`, SECURITY.md names the current release line in its
// supported-versions table and routes reports to a private advisory, and the
// CLI commands SUPPORT.md tells users to run really exist.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { USAGE } from "../build/cli.js";

const root = join(import.meta.dirname, "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const pkg = JSON.parse(read("package.json"));
const ADVISORY_URL =
  "https://github.com/IvanBBaev/servicenow-mcp-ai/security/advisories/new";

const COMMUNITY_FILES = [
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "SUPPORT.md",
  "CONTRIBUTING.md",
  ".github/CODEOWNERS",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/pull_request_template.md",
  ".github/release.yml",
];

test("every community standard file exists and none is published to npm", () => {
  for (const file of COMMUNITY_FILES) {
    assert.ok(existsSync(join(root, file)), `${file} is missing`);
  }
  // The tarball is `files` (build + bin) plus what npm always adds; none of
  // the community files may be listed there.
  for (const entry of pkg.files) {
    for (const file of COMMUNITY_FILES) {
      assert.ok(
        !file.startsWith(entry.replace(/^!/, "")),
        `package.json files entry "${entry}" would publish ${file}`,
      );
    }
  }
});

test("the bug form requires the doctor --json output, version, client and transport", () => {
  const bug = read(".github/ISSUE_TEMPLATE/bug_report.yml");
  const block = (id) => {
    const start = bug.indexOf(`    id: ${id}\n`);
    assert.ok(start > 0, `bug form has no field "${id}"`);
    const next = bug.indexOf("\n  - type:", start);
    return bug.slice(start, next === -1 ? undefined : next);
  };
  const doctor = block("doctor");
  assert.match(doctor, /doctor --json/);
  assert.match(doctor, /required: true/);
  for (const id of ["version", "client", "transport"]) {
    assert.match(block(id), /required: true/, `"${id}" must be required`);
  }
  const config = read(".github/ISSUE_TEMPLATE/config.yml");
  assert.match(config, /^blank_issues_enabled: false$/m);
  assert.ok(config.includes(ADVISORY_URL), "chooser links the private form");
});

test("SECURITY.md has a supported-versions table naming the current line and a private channel", () => {
  const security = read("SECURITY.md");
  const major = pkg.version.split(".")[0];
  const section = security.slice(
    security.indexOf("## Supported versions"),
    security.indexOf("## Reporting a vulnerability"),
  );
  // Prettier pads table cells, so match with flexible whitespace.
  assert.match(section, /^\| Version +\| Status +\| Security fixes +\|$/m);
  assert.match(
    section,
    new RegExp(`^\\| ${major}\\.x +\\| Current line +\\| Yes`, "m"),
    "the table names the current major line as supported",
  );
  assert.ok(security.includes(ADVISORY_URL));
  assert.match(security, /## Response targets/);
  assert.match(security, /## Scope/);
  assert.doesNotMatch(
    security,
    /via\s+\[GitHub issues\]/,
    "vulnerabilities are never reported in public issues",
  );
});

test("SUPPORT.md only names CLI commands and flags that exist", () => {
  const support = read("SUPPORT.md");
  for (const token of [
    "doctor",
    "support-bundle",
    "--json",
    "--out",
    "--profile",
  ]) {
    assert.ok(support.includes(token), `SUPPORT.md mentions ${token}`);
    assert.ok(USAGE.includes(token), `the CLI knows ${token}`);
  }
});
