// Generates the README "Tools" table from the live tool registrations
// (build/registry.js#describeAllTools), so the docs cannot drift from the
// code. Run `npm run docs:readme` after adding or changing a tool;
// test/readme-sync.test.js fails when the section is stale.
//
// M-7 (B2): the same run renders the v2 -> v3 tool rename table into README
// and CHANGELOG from the one alias map (src/mcp/naming.ts TOOL_RENAMES).

import { readFileSync, writeFileSync } from "node:fs";

import {
  loadNamingFromSource,
  loadToolsFromSource,
} from "./registry-from-source.mjs";
import { join } from "node:path";

export const BEGIN = "<!-- GENERATED:TOOLS:BEGIN (npm run docs:readme) -->";
export const END = "<!-- GENERATED:TOOLS:END -->";

export const RENAMES_BEGIN =
  "<!-- GENERATED:TOOL-RENAMES:BEGIN (npm run docs:readme) -->";
export const RENAMES_END = "<!-- GENERATED:TOOL-RENAMES:END -->";

const README_PATH = join(import.meta.dirname, "../README.md");
const CHANGELOG_PATH = join(import.meta.dirname, "../CHANGELOG.md");

/** First sentence of a tool description, table-safe and capped in length. */
function summary(description) {
  const sentence = (description.split(/(?<=\.)\s/)[0] ?? "").trim();
  const safe = sentence.replaceAll("|", "\\|").replace(/\.$/, "");
  return safe.length > 110 ? `${safe.slice(0, 107)}…` : safe;
}

/** Render the Tools table from a ToolInfo[] (the sync test passes its own). */
export function buildToolsSection(tools) {
  const rows = tools.map(
    (t) =>
      `| \`${t.package}\` | \`${t.name}\` | ${t.readOnly ? "yes" : "no"} | ${summary(t.description)} |`,
  );
  return [
    BEGIN,
    "",
    "_This table is generated from the tool registrations — edit the tool",
    "definitions in `src/tools/`, then run `npm run docs:readme`._",
    "",
    "| Package | Tool | Read-only | Description |",
    "| ------- | ---- | :-------: | ----------- |",
    ...rows,
    "",
    END,
  ].join("\n");
}

/**
 * Render the v2 -> v3 rename table from `TOOL_RENAMES` (M-7). Columns are
 * padded the way Prettier aligns Markdown tables, so the generated block is
 * stable under `npm run format` (CHANGELOG.md is Prettier-checked).
 */
export function buildRenamesSection(renames) {
  const header = ["v2 name", "v3 name", "Why"];
  const body = [...renames]
    .sort((a, b) => a.from.localeCompare(b.from))
    .map((r) => [
      `\`${r.from}\``,
      `\`${r.to}\``,
      r.reason.replaceAll("|", "\\|"),
    ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i].length)),
  );
  const line = (cells) =>
    `| ${cells.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;
  return [
    RENAMES_BEGIN,
    "",
    "_Generated from `TOOL_RENAMES` in `src/mcp/naming.ts` — run",
    "`npm run docs:readme` after changing it._",
    "",
    line(header),
    line(widths.map((w) => "-".repeat(w))),
    ...body.map(line),
    "",
    RENAMES_END,
  ].join("\n");
}

/** Replace the text between two markers; throws when they are missing. */
function replaceBetween(source, begin, end, section, label) {
  const b = source.indexOf(begin);
  const e = source.indexOf(end);
  if (b === -1 || e === -1 || e < b) {
    throw new Error(`${label} markers not found (${begin} … ${end}).`);
  }
  return source.slice(0, b) + section + source.slice(e + end.length);
}

export function updateReadme(tools, path = README_PATH, renames) {
  const source = readFileSync(path, "utf8");
  let updated = replaceBetween(
    source,
    BEGIN,
    END,
    buildToolsSection(tools),
    "README",
  );
  if (renames) {
    updated = replaceBetween(
      updated,
      RENAMES_BEGIN,
      RENAMES_END,
      buildRenamesSection(renames),
      "README renames",
    );
  }
  if (updated !== source) writeFileSync(path, updated);
  return updated !== source;
}

/** Rewrite the CHANGELOG rename table (M-7); true when it changed. */
export function updateChangelogRenames(renames, path = CHANGELOG_PATH) {
  const source = readFileSync(path, "utf8");
  const updated = replaceBetween(
    source,
    RENAMES_BEGIN,
    RENAMES_END,
    buildRenamesSection(renames),
    "CHANGELOG renames",
  );
  if (updated !== source) writeFileSync(path, updated);
  return updated !== source;
}

if (process.argv[1] === import.meta.filename) {
  const { renames } = await loadNamingFromSource();
  const changed = updateReadme(
    await loadToolsFromSource(),
    README_PATH,
    renames,
  );
  const changelog = updateChangelogRenames(renames);
  console.error(
    changed
      ? "README tools and renames sections regenerated."
      : "README already up to date.",
  );
  console.error(
    changelog
      ? "CHANGELOG renames table regenerated."
      : "CHANGELOG renames table already up to date.",
  );
}
