// Generates the README "Tools" table from the live tool registrations
// (build/registry.js#describeAllTools), so the docs cannot drift from the
// code. Run `npm run docs:readme` after adding or changing a tool;
// test/readme-sync.test.js fails when the section is stale.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadToolsFromSource } from "./registry-from-source.mjs";

export const BEGIN = "<!-- GENERATED:TOOLS:BEGIN (npm run docs:readme) -->";
export const END = "<!-- GENERATED:TOOLS:END -->";

const README_PATH = fileURLToPath(new URL("../README.md", import.meta.url));

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

export function updateReadme(tools, path = README_PATH) {
  const source = readFileSync(path, "utf8");
  const begin = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`README markers not found (${BEGIN} … ${END}).`);
  }
  const updated =
    source.slice(0, begin) +
    buildToolsSection(tools) +
    source.slice(end + END.length);
  if (updated !== source) writeFileSync(path, updated);
  return updated !== source;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const changed = updateReadme(await loadToolsFromSource());
  console.error(
    changed
      ? "README tools section regenerated."
      : "README already up to date.",
  );
}
