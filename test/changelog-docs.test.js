// D-3: the site's changelog page and footer release links follow CHANGELOG.md.
// Run `npm run docs:sync` when the guard fails.
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
  CHANGELOG_PAGE,
  LANDING_HTML,
  RELEASES_BEGIN,
  RELEASES_END,
  buildChangelogPage,
  buildReleaseLinks,
  parseReleases,
  syncChangelogDocs,
} from "../scripts/changelog-docs.mjs";

const root = path.join(import.meta.dirname, "..");

const CHANGELOG = [
  "# Changelog",
  "",
  "Intro.",
  "",
  "## [Unreleased]",
  "",
  "- Not yet.",
  "",
  "## [1.1.0-beta.1] - 2026-02-01",
  "",
  "- Beta.",
  "",
  "## [1.0.0] - 2026-01-01",
  "",
  "- First.",
  "",
  "[Unreleased]: https://example.test/compare/v1.1.0-beta.1...HEAD",
  "[1.0.0]: https://example.test/releases/tag/v1.0.0",
  "",
].join("\n");

test("the changelog page and the footer release links are current", () => {
  assert.deepEqual(
    syncChangelogDocs({ root, check: true }),
    [],
    "release docs drift — run `npm run docs:sync`",
  );
});

test("parseReleases lists released versions newest first", () => {
  assert.deepEqual(parseReleases(CHANGELOG), [
    { version: "1.1.0-beta.1", date: "2026-02-01" },
    { version: "1.0.0", date: "2026-01-01" },
  ]);
});

test("the page keeps the released versions and drops Unreleased", () => {
  const page = buildChangelogPage(CHANGELOG);
  assert.match(page, /^# Changelog\n\n> Released versions/);
  assert.match(page, /## \[1\.0\.0\] - 2026-01-01/);
  assert.match(page, /\[1\.0\.0\]: https:\/\/example\.test/);
  assert.doesNotMatch(page, /Unreleased\]|Not yet|Intro\./);
  assert.throws(() => buildChangelogPage("no title\n"), /"# " title/);
  assert.throws(
    () => buildChangelogPage("# Changelog\n\n## [Unreleased]\n"),
    /no released version/,
  );
});

test("the footer links the page and the newest versions", () => {
  const block = buildReleaseLinks(
    [
      { version: "2.0.0", date: "2026-03-01" },
      { version: "1.0.0", date: "" },
    ],
    1,
  );
  assert.ok(block.startsWith(RELEASES_BEGIN));
  assert.ok(block.endsWith(RELEASES_END));
  assert.match(block, /href="changelog\.md">Changelog</);
  assert.match(
    block,
    /releases\/tag\/v2\.0\.0"[^>]*title="Released 2026-03-01"/,
  );
  assert.doesNotMatch(block, /v1\.0\.0/);
});

test("a drifting site is reported under --check and rewritten otherwise", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sn-changelog-docs-"));
  try {
    mkdirSync(path.join(dir, "docs"));
    writeFileSync(path.join(dir, "CHANGELOG.md"), CHANGELOG);
    const html = `<footer>\n${RELEASES_BEGIN}\nstale\n${RELEASES_END}\n</footer>\n`;
    writeFileSync(path.join(dir, LANDING_HTML), html);
    assert.deepEqual(syncChangelogDocs({ root: dir, check: true }), [
      CHANGELOG_PAGE,
      LANDING_HTML,
    ]);
    assert.equal(readFileSync(path.join(dir, LANDING_HTML), "utf8"), html);
    syncChangelogDocs({ root: dir });
    assert.deepEqual(syncChangelogDocs({ root: dir, check: true }), []);
    assert.match(
      readFileSync(path.join(dir, LANDING_HTML), "utf8"),
      /v1\.1\.0-beta\.1/,
    );
    writeFileSync(path.join(dir, LANDING_HTML), "<footer></footer>\n");
    assert.throws(
      () => syncChangelogDocs({ root: dir, check: true }),
      /markers not found/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
