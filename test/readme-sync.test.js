import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { BEGIN, END, buildToolsSection } from "../scripts/readme-tools.mjs";
import { describeAllTools } from "../build/mcp/registry.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("README tools section matches the live tool registrations", () => {
  const begin = readme.indexOf(BEGIN);
  const end = readme.indexOf(END);
  assert.ok(
    begin >= 0 && end > begin,
    "generator markers must exist in README",
  );
  const actual = readme.slice(begin, end + END.length);
  assert.equal(
    actual,
    buildToolsSection(describeAllTools()),
    "README is stale — run `npm run docs:readme` and commit the result",
  );
});

test("describeAllTools sees every package and the admin group", () => {
  const tools = describeAllTools();
  const packages = new Set(tools.map((t) => t.package));
  for (const pkg of [
    "table",
    "schema",
    "aggregate",
    "attachment",
    "importset",
    "batch",
    "catalog",
    "change",
    "knowledge",
    "cmdb",
    "scripts",
    "docs",
    "admin",
  ]) {
    assert.ok(packages.has(pkg), `package ${pkg} must contribute tools`);
  }
  // Every tool must declare a name, a description and its read-only stance.
  for (const t of tools) {
    assert.ok(t.name.startsWith("servicenow_"), t.name);
    assert.ok(t.description.length > 0, `${t.name} needs a description`);
    assert.equal(typeof t.readOnly, "boolean");
  }
});

test("package.json description states the real tool and package counts", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const tools = describeAllTools();
  const packages = new Set(tools.map((t) => t.package));
  assert.ok(
    pkg.description.includes(`${tools.length} tools`),
    `description must say "${tools.length} tools" (says: ${pkg.description})`,
  );
  assert.ok(
    pkg.description.includes(`${packages.size} packages`),
    `description must say "${packages.size} packages" (says: ${pkg.description})`,
  );
});
