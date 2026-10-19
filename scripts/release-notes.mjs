// D-6: the GitHub Release for a tag carries the CHANGELOG section of that
// version. The publish workflow runs
//
//   node scripts/release-notes.mjs 3.0.0 > release-notes.md
//
// and hands the file to `gh release create --notes-file`. The section is the
// text between `## [3.0.0] …` and the next `## ` heading (or the link
// reference block at the end of the file), trimmed. A prerelease (a version
// with a `-`, e.g. `3.0.0-beta.1`) without a section of its own takes the
// `## [Unreleased]` notes, because betas keep them there until GA (ADR 0012).
// A version without notes exits 1 — a tag must never ship with empty notes.
// GitHub rejects a release body over 125 000 characters, so notes longer than
// that are cut at a line break and end with a link to the full CHANGELOG.
import { readFileSync } from "node:fs";
import path from "node:path";

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The body of the `## [<version>]` section of a Keep-a-Changelog file, without
 * its heading, or `undefined` when the version has no section (or an empty
 * one). A leading `v` on the version is accepted.
 */
export function extractReleaseNotes(changelog, version) {
  const v = String(version).trim().replace(/^v/, "");
  if (!v) return undefined;
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const heading = new RegExp(`^## \\[${escape(v)}\\](?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return undefined;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    // The next version heading, or the link references at the end of the file.
    if (/^## /.test(line) || /^\[[^\]]+\]:\s/.test(line)) break;
    body.push(line);
  }
  const text = body.join("\n").trim();
  return text ? text + "\n" : undefined;
}

/**
 * The release notes for a tag: the version's own section, or for a prerelease
 * without one the `## [Unreleased]` section. `undefined` when neither applies.
 */
export function releaseNotesFor(changelog, version) {
  const v = String(version).trim().replace(/^v/, "");
  const own = extractReleaseNotes(changelog, v);
  if (own || !/^\d+\.\d+\.\d+-/.test(v)) return own;
  return extractReleaseNotes(changelog, "Unreleased");
}

/** GitHub's release body limit is 125 000 characters; keep a margin. */
export const MAX_RELEASE_NOTES = 120_000;

const CHANGELOG_URL =
  "https://github.com/IvanBBaev/servicenow-mcp-ai/blob/{tag}/CHANGELOG.md";

/**
 * The notes unchanged when they fit in `max` characters; otherwise cut at the
 * last line break that leaves room for a pointer to the full CHANGELOG at
 * the tag.
 */
export function fitReleaseNotes(notes, version, max = MAX_RELEASE_NOTES) {
  if (notes.length <= max) return notes;
  const tag = "v" + String(version).trim().replace(/^v/, "");
  const tail =
    "\n\n---\n\n_The notes are cut here to fit the GitHub Release limit. " +
    `The full list is in [CHANGELOG.md](${CHANGELOG_URL.replace("{tag}", tag)})._\n`;
  const room = max - tail.length;
  const cut = notes.lastIndexOf("\n", room);
  return notes.slice(0, cut > 0 ? cut : room).trimEnd() + tail;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  const version = process.argv[2];
  const file = path.join(import.meta.dirname, "../CHANGELOG.md");
  const notes = version
    ? releaseNotesFor(readFileSync(file, "utf8"), version)
    : undefined;
  if (!notes) {
    console.error(
      version
        ? `release-notes: CHANGELOG.md has no section for ${version}`
        : "usage: node scripts/release-notes.mjs <version>",
    );
    process.exit(1);
  }
  process.stdout.write(fitReleaseNotes(notes, version));
}
