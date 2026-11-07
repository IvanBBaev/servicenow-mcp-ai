// D-3: the tool and package counts quoted across README, package.json,
// server.json, the extension, the Claude plugin and the landing page follow
// the live registry. Run `npm run docs:sync` when this fails.
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

import {
  SITES,
  checkPublicClaims,
  countSurface,
  countTools,
  syncCounts,
} from "../scripts/docs-sync.mjs";
import { describeAllTools } from "../build/mcp/registry.js";

const root = path.join(import.meta.dirname, "..");

test("every site quotes the live tool and package counts", () => {
  const counts = { ...countTools(describeAllTools()), ...countSurface(root) };
  assert.ok(counts.tools > 50 && counts.packages > 10, JSON.stringify(counts));
  assert.ok(counts.resources > 5 && counts.prompts > 5, JSON.stringify(counts));
  assert.deepEqual(
    syncCounts({ root, counts, check: true }),
    [],
    "counts drift — run `npm run docs:sync`",
  );
});

test("countTools counts tools and distinct packages", () => {
  assert.deepEqual(
    countTools([{ package: "a" }, { package: "a" }, { package: "b" }]),
    { tools: 3, packages: 2 },
  );
});

test("a drifting site is reported under --check and rewritten otherwise", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sn-docs-sync-"));
  try {
    for (const site of SITES) {
      const abs = path.join(dir, site.file);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, readFileSync(path.join(root, site.file), "utf8"));
    }
    const counts = { tools: 123, packages: 45, resources: 15, prompts: 15 };
    const all = SITES.map((s) => s.file);
    assert.deepEqual(syncCounts({ root: dir, counts, check: true }), all);
    assert.deepEqual(syncCounts({ root: dir, counts }), all);
    assert.deepEqual(syncCounts({ root: dir, counts, check: true }), []);
    const pkg = readFileSync(path.join(dir, "package.json"), "utf8");
    assert.match(pkg, /123 tools in 45 packages/);
    const html = readFileSync(path.join(dir, "docs/index.html"), "utf8");
    assert.match(html, /<b>123<\/b><span>tools<\/span>/);
    assert.match(html, /<b>45<\/b><span>packages<\/span>/);
    assert.match(
      readFileSync(path.join(dir, "README.md"), "utf8"),
      /badge\/tools-123-blue/,
    );
    // A reworded site fails loudly rather than dropping out of the sync.
    writeFileSync(path.join(dir, "server.json"), "{}\n");
    assert.throws(
      () => syncCounts({ root: dir, counts, check: true }),
      /server\.json: pattern .* no longer matches/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a planted wrong prompt count is drift (N-99)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sn-docs-sync-"));
  try {
    writeFileSync(
      path.join(dir, "site.html"),
      "<b>3</b><span>prompts</span>\n<b>6</b><span>MCP resources</span>\n",
    );
    const sites = SITES.filter((site) => site.file === "docs/index.html").map(
      (site) => ({
        file: "site.html",
        patterns: site.patterns.filter((p) =>
          /prompts|resources/.test(p.source),
        ),
      }),
    );
    const counts = { resources: 15, prompts: 15 };
    assert.deepEqual(syncCounts({ root: dir, counts, check: true, sites }), [
      "site.html",
    ]);
    syncCounts({ root: dir, counts, sites });
    assert.match(
      readFileSync(path.join(dir, "site.html"), "utf8"),
      /<b>15<\/b><span>prompts/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the public copy has no stale claim and one licence (N-99)", () => {
  assert.deepEqual(checkPublicClaims({ root }), []);
});

test("a stale claim and a licence mismatch are reported (N-99)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sn-docs-sync-"));
  try {
    writeFileSync(path.join(dir, "README.md"), "A suite of 406 tests.\n");
    writeFileSync(path.join(dir, "package.json"), '{"license":"GPL"}');
    writeFileSync(path.join(dir, "other.json"), '{"license":"MIT"}');
    const problems = checkPublicClaims({
      root: dir,
      claims: [{ files: ["README.md"], pattern: /\d+ tests/, why: "stale" }],
      manifests: ["other.json"],
    });
    assert.equal(problems.length, 2);
    assert.match(problems[0], /406 tests/);
    assert.match(problems[1], /other\.json: license MIT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
