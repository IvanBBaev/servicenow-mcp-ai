// N-99 (DX-I2): the README and the site stay true to the code. Every relative
// README link is a tracked file, every `servicenow_*({...})` example uses
// parameters the tool has, and the package list names every package.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  describeAllTools,
  describeToolSchemas,
} from "../build/mcp/registry.js";

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .trim()
  .split("\n");
const readme = readFileSync("README.md", "utf8");

/** Parameter names of an example's `{a, b?, c | d, e: 1}` argument list. */
function exampleKeys(list) {
  return list
    .split(/[,|]/)
    .map((part) => part.trim().split(":")[0].replace(/\?$/, "").trim())
    .filter((key) => /^[a-zA-Z_]\w*$/.test(key));
}

test("exampleKeys reads the shorthand of an example", () => {
  assert.deepEqual(exampleKeys('kind:"playbook", sys_id | key, runs?'), [
    "kind",
    "sys_id",
    "key",
    "runs",
  ]);
});

test("every relative README link is a tracked file (N-99)", () => {
  const untracked = [...readme.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1].split("#")[0])
    .filter((target) => target && !/^[a-z]+:/.test(target))
    .filter(
      (target) =>
        !tracked.some(
          (file) =>
            file === target || file.startsWith(`${target.replace(/\/$/, "")}/`),
        ),
    );
  assert.deepEqual(untracked, []);
});

test("every servicenow_*({...}) example fits the tool's schema (N-99)", () => {
  const schemas = new Map(
    describeToolSchemas().map((tool) => [tool.name, tool.inputSchema]),
  );
  const pages = tracked.filter(
    (file) =>
      file === "README.md" ||
      (/^docs\/.*\.(md|html)$/.test(file) && file !== "docs/changelog.md"),
  );
  const wrong = [];
  let examples = 0;
  for (const file of pages) {
    const text = readFileSync(file, "utf8");
    for (const [, name, list] of text.matchAll(
      /\b(servicenow_\w+)\(\{([^{}]*)\}\)/g,
    )) {
      examples += 1;
      const known = Object.keys(schemas.get(name)?.properties ?? {});
      const unknown = exampleKeys(list).filter((key) => !known.includes(key));
      if (unknown.length > 0) wrong.push(`${file}: ${name}: ${unknown}`);
    }
  }
  assert.ok(examples >= 4, `only ${examples} examples found`);
  assert.deepEqual(wrong, []);
});

test("the README package list names every package (N-99)", () => {
  const list = readme.match(/- Individual packages: ([^]*?)\n\n/)[1];
  const named = new Set(
    [...list.matchAll(/`(\w+)`/g)].map((match) => match[1]),
  );
  const missing = [...new Set(describeAllTools().map((tool) => tool.package))]
    .filter((pkg) => pkg !== "admin")
    .filter((pkg) => !named.has(pkg));
  assert.deepEqual(missing, []);
});
