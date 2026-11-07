// D-3: the tool and package counts quoted across README, AGENTS.md, the
// extension README and the landing page follow the live registry; N-98: the
// positioning copy (README hero, site hero and meta, llms.txt, the manifest
// descriptions) comes from docs/positioning.json. Run `npm run docs:sync` when
// this fails.
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
  POSITIONING,
  REGISTRY_DESCRIPTION_MAX,
  SITES,
  checkPublicClaims,
  countSurface,
  countTools,
  renderPositioning,
  syncCounts,
  syncPositioning,
} from "../scripts/docs-sync.mjs";
import {
  describeAllTools,
  resolveEnabledPackages,
} from "../build/mcp/registry.js";

const root = path.join(import.meta.dirname, "..");

test("every site quotes the live tool and package counts", () => {
  const counts = {
    ...countTools(describeAllTools(), resolveEnabledPackages(["discovery"])),
    ...countSurface(root),
  };
  assert.ok(counts.tools > 50 && counts.packages > 10, JSON.stringify(counts));
  assert.ok(counts.resources > 5 && counts.prompts > 5, JSON.stringify(counts));
  assert.deepEqual(
    syncCounts({ root, counts, check: true }),
    [],
    "counts drift — run `npm run docs:sync`",
  );
  assert.deepEqual(
    syncPositioning({ root, counts, check: true }),
    [],
    "positioning drift — run `npm run docs:sync`",
  );
});

test("countTools counts tools and distinct packages", () => {
  assert.deepEqual(
    countTools([{ package: "a" }, { package: "a" }, { package: "b" }]),
    { tools: 3, packages: 2, defaultTools: 0 },
  );
  assert.deepEqual(
    countTools(
      [{ package: "admin" }, { package: "table" }, { package: "b" }],
      new Set(["table"]),
    ),
    { tools: 3, packages: 3, defaultTools: 2 },
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
    const agents = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    assert.match(agents, /123 tools in 45 packages/);
    const html = readFileSync(path.join(dir, "docs/index.html"), "utf8");
    assert.match(html, /<b>123<\/b><span>tools<\/span>/);
    assert.match(html, /<b>45<\/b><span>packages<\/span>/);
    assert.match(
      readFileSync(path.join(dir, "README.md"), "utf8"),
      /one file per package \(45 packages\)/,
    );
    // A reworded site fails loudly rather than dropping out of the sync.
    writeFileSync(path.join(dir, "AGENTS.md"), "no counts\n");
    assert.throws(
      () => syncCounts({ root: dir, counts, check: true }),
      /AGENTS\.md: pattern .* no longer matches/,
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

const POSITIONING_FIXTURE = {
  headline: ["Safe writes", "for X."],
  what: "A server.",
  value: "Writes are previewed.",
  counts: "{tools} tools, {defaultTools} by default.",
  disclaimer: "Not affiliated.",
  descriptions: {
    registry: "Safe writes: {tools} tools.",
    package: "Safe writes in {packages} packages.",
  },
};

test("renderPositioning fills the counts and joins the headline (N-98)", () => {
  const texts = renderPositioning(POSITIONING_FIXTURE, {
    tools: 7,
    packages: 3,
    defaultTools: 2,
  });
  assert.equal(texts.tagline, "Safe writes for X.");
  assert.equal(texts.counts, "7 tools, 2 by default.");
  assert.equal(texts.descriptions.registry, "Safe writes: 7 tools.");
  assert.equal(texts.descriptions.package, "Safe writes in 3 packages.");
});

test("renderPositioning rejects a count-first or an over-long description (N-98)", () => {
  const counts = { tools: 7, packages: 3, defaultTools: 2 };
  const withDescription = (key, text) => ({
    ...POSITIONING_FIXTURE,
    descriptions: { ...POSITIONING_FIXTURE.descriptions, [key]: text },
  });
  assert.throws(
    () =>
      renderPositioning(withDescription("package", "{tools} tools."), counts),
    /"package" opens with a count/,
  );
  assert.throws(
    () =>
      renderPositioning(
        withDescription("registry", "x".repeat(REGISTRY_DESCRIPTION_MAX + 1)),
        counts,
      ),
    /registry description has 101 characters/,
  );
  assert.throws(
    () => renderPositioning(POSITIONING_FIXTURE, { tools: 7, packages: 3 }),
    /no count for \{defaultTools\}/,
  );
});

test("the live positioning copy fits the registry limit (N-98)", () => {
  const positioning = JSON.parse(
    readFileSync(path.join(root, "docs/positioning.json"), "utf8"),
  );
  const texts = renderPositioning(positioning, {
    tools: 100,
    packages: 28,
    defaultTools: 20,
  });
  assert.ok(texts.descriptions.registry.length <= REGISTRY_DESCRIPTION_MAX);
  assert.ok(POSITIONING.length > 5);
});

test("a drifting positioning site is reported, rewritten, and a lost one throws (N-98)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sn-docs-sync-"));
  try {
    mkdirSync(path.join(dir, "docs"));
    writeFileSync(
      path.join(dir, "docs/positioning.json"),
      JSON.stringify(POSITIONING_FIXTURE),
    );
    writeFileSync(path.join(dir, "m.json"), '{\n  "description": "old"\n}\n');
    const sites = [
      {
        file: "m.json",
        pattern: /(?<pre>"description": )"(?:[^"\\]|\\.)*"(?<post>)/,
        render: (t) => JSON.stringify(t.descriptions.registry),
      },
    ];
    const counts = { tools: 7, packages: 3, defaultTools: 2 };
    assert.deepEqual(
      syncPositioning({ root: dir, counts, check: true, sites }),
      ["m.json"],
    );
    assert.match(readFileSync(path.join(dir, "m.json"), "utf8"), /"old"/);
    assert.deepEqual(syncPositioning({ root: dir, counts, sites }), ["m.json"]);
    assert.equal(
      JSON.parse(readFileSync(path.join(dir, "m.json"), "utf8")).description,
      "Safe writes: 7 tools.",
    );
    assert.deepEqual(
      syncPositioning({ root: dir, counts, check: true, sites }),
      [],
    );
    writeFileSync(path.join(dir, "m.json"), "{}\n");
    assert.throws(
      () => syncPositioning({ root: dir, counts, check: true, sites }),
      /m\.json: positioning site .* no longer matches/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
