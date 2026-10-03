// D-6: the GitHub Release for a tag carries the CHANGELOG section of that
// version. The publish workflow runs
//
//   node scripts/release-notes.mjs 3.0.0 > release-notes.md
//
// and hands the file to `gh release create --notes-file`. The section is the
// text between `## [3.0.0] …` and the next `## ` heading (or the link
// reference block at the end of the file), trimmed. A version without a
// section exits 1 — a tag must never ship with empty notes.
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

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  const version = process.argv[2];
  const file = path.join(import.meta.dirname, "../CHANGELOG.md");
  const notes = version
    ? extractReleaseNotes(readFileSync(file, "utf8"), version)
    : undefined;
  if (!notes) {
    console.error(
      version
        ? `release-notes: CHANGELOG.md has no section for ${version}`
        : "usage: node scripts/release-notes.mjs <version>",
    );
    process.exit(1);
  }
  process.stdout.write(notes);
}
