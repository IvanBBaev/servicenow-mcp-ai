// D-3: the documentation site carries the release notes.
//
//   docs/changelog.md   the released versions of CHANGELOG.md, served next to
//                       the landing page (docs/.nojekyll: Markdown is served
//                       as is, like docs/index.md)
//   docs/index.html     the footer's release links: the changelog page and
//                       one link per recent version, between the
//                       GENERATED:RELEASES markers
//
// Run by `npm run docs:sync` (scripts/docs-sync.mjs) before the tool reference,
// whose docs/index.md is rendered from docs/index.html.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CHANGELOG = "CHANGELOG.md";
export const CHANGELOG_PAGE = "docs/changelog.md";
export const LANDING_HTML = "docs/index.html";
export const RELEASES_BEGIN =
  "<!-- GENERATED:RELEASES:BEGIN (npm run docs:sync) -->";
export const RELEASES_END = "<!-- GENERATED:RELEASES:END -->";
/** How many released versions the footer links. */
export const FOOTER_VERSIONS = 5;

const REPO_URL = "https://github.com/IvanBBaev/servicenow-mcp-ai";

/** Released versions in CHANGELOG order (newest first), without Unreleased. */
export function parseReleases(changelog) {
  const out = [];
  for (const m of changelog.matchAll(
    /^## \[(\d+\.\d+\.\d+(?:-[\w.]+)?)\](?: - (\d{4}-\d{2}-\d{2}))?/gm,
  )) {
    out.push({ version: m[1], date: m[2] ?? "" });
  }
  return out;
}

/**
 * The site page: the CHANGELOG title, a generated note and the released
 * versions. [Unreleased] stays on GitHub, so a new CHANGELOG entry does not
 * drift the page until a release heading is cut.
 */
export function buildChangelogPage(changelog) {
  const nl = changelog.indexOf("\n");
  if (!changelog.startsWith("# ") || nl === -1) {
    throw new Error(`${CHANGELOG}: expected a "# " title on the first line`);
  }
  const first = changelog.search(/^## \[\d/m);
  if (first === -1) {
    throw new Error(`${CHANGELOG}: no released version headings found`);
  }
  const note = `> Released versions of servicenow-mcp-ai, generated from [CHANGELOG.md](${REPO_URL}/blob/main/CHANGELOG.md) by \`npm run docs:sync\`. Unreleased changes are listed in that file.`;
  const body = changelog.slice(first).replace(/^\[Unreleased\]: .*\n/m, "");
  return `${changelog.slice(0, nl)}\n\n${note}\n\n${body}`;
}

/** The footer block of docs/index.html, markers included. */
export function buildReleaseLinks(releases, limit = FOOTER_VERSIONS) {
  const links = releases
    .slice(0, limit)
    .map(
      (r) =>
        `<a href="${REPO_URL}/releases/tag/v${r.version}" target="_blank" rel="noopener"${r.date ? ` title="Released ${r.date}"` : ""}>v${r.version}</a>`,
    );
  return [
    RELEASES_BEGIN,
    `          <span class="foot-releases">Releases: <a href="changelog.md">Changelog</a>${links.map((l) => ` · ${l}`).join("")}</span>`,
    `          ${RELEASES_END}`,
  ].join("\n");
}

/** Every file this generator owns under `root`, as path → content. */
export function generateChangelogDocs({ root }) {
  const read = (file) => readFileSync(path.join(root, file), "utf8");
  const changelog = read(CHANGELOG);
  const releases = parseReleases(changelog);
  if (releases.length === 0) {
    throw new Error(`${CHANGELOG}: no released version headings found`);
  }
  const html = read(LANDING_HTML);
  const b = html.indexOf(RELEASES_BEGIN);
  const e = html.indexOf(RELEASES_END);
  if (b === -1 || e === -1 || e < b) {
    throw new Error(
      `${LANDING_HTML}: markers not found (${RELEASES_BEGIN} … ${RELEASES_END})`,
    );
  }
  return new Map([
    [CHANGELOG_PAGE, buildChangelogPage(changelog)],
    [
      LANDING_HTML,
      html.slice(0, b) +
        buildReleaseLinks(releases) +
        html.slice(e + RELEASES_END.length),
    ],
  ]);
}

/**
 * Bring the files of `generateChangelogDocs` in line under `root`; with
 * `check` nothing is written. Returns the drifting paths.
 */
export function syncChangelogDocs({ root, check = false }) {
  const drift = [];
  for (const [file, content] of generateChangelogDocs({ root })) {
    const abs = path.join(root, file);
    if (existsSync(abs) && readFileSync(abs, "utf8") === content) continue;
    drift.push(file);
    if (!check) writeFileSync(abs, content);
  }
  return drift;
}
