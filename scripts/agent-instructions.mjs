// N-46 (TK-22): path-scoped agent instructions. One committed source per code
// area in .github/agent-instructions/<area>.md (YAML frontmatter with an
// `applyTo` list of globs, then Markdown) is rendered to the GitHub Copilot
// path-specific format:
//
//   .github/instructions/<area>.instructions.md
//     ---
//     applyTo: "glob1,glob2"
//     ---
//     <generated banner> + the source body
//
// so an assistant editing src/api/** reads only the api rules instead of one
// flat file. Every glob must name an existing directory or file prefix, so a
// moved area fails here instead of silently matching nothing. Output files
// with no source are stale and removed.
//
// N-43 (O-20, ADR 0011): the root AGENTS.md is the single source of the
// repository-wide agent instructions; .github/copilot-instructions.md is
// rendered from it (a generated banner + the same body), so the two cannot
// drift. Its tool and package counts are kept by `npm run docs:sync`.
//
// N-46b (O-20, ADR 0011): a source with `nested: true` is also rendered to
// <dir>/AGENTS.md, where its first glob is `<dir>/**`, for agents that read
// the nearest AGENTS.md (Codex and others). A generated nested file whose
// source is gone or no longer opted in is removed; a hand-written AGENTS.md
// (no generated banner) is never touched.
//
// N-76: the same sources reach Cursor and Gemini CLI. Each area is also
// rendered to .cursor/rules/<area>.mdc (an auto-attached Cursor rule: the
// area's title as `description`, its globs as `globs`), and AGENTS.md to the
// root GEMINI.md. A generated rule whose source is gone is removed; a
// hand-written rule (no generated banner) is never touched.
//
// The sources are the single place to edit.
//
//   npm run docs:instructions               rewrite the generated files
//   npm run docs:instructions -- --check    dry run: list the stale files, exit 1
//
// test/agent-instructions.test.js is the guard that fails CI on drift.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const SOURCE_DIR = ".github/agent-instructions";
export const OUTPUT_DIR = ".github/instructions";
export const OUTPUT_SUFFIX = ".instructions.md";
export const ROOT_SOURCE = "AGENTS.md";
export const ROOT_OUTPUT = ".github/copilot-instructions.md";
export const GEMINI_OUTPUT = "GEMINI.md";
export const CURSOR_DIR = ".cursor/rules";
export const CURSOR_SUFFIX = ".mdc";

/** Copilot's optional excludeAgent values. */
const EXCLUDE_AGENTS = new Set(["code-review", "cloud-agent"]);
const AREA_RE = /^[a-z0-9][a-z0-9-]*$/;
/** A nested file's directory: the literal part of a `<dir>/**` glob. */
const NESTED_GLOB_RE = /^([^.*?[{/][^*?[{]*)\/\*\*$/;
export const NESTED_NAME = "AGENTS.md";
/** Directories the stale nested-file scan never enters. */
const SCAN_SKIP = new Set(["node_modules", "build", "coverage", "out"]);

/** Strip one pair of matching quotes from a YAML scalar. */
function unquote(value) {
  const match = /^(["'])(.*)\1$/.exec(value);
  return match ? match[2] : value;
}

/**
 * Parse a source file: a frontmatter block with `applyTo` (a YAML list of
 * globs), an optional `excludeAgent` and an optional `nested` flag, then the
 * Markdown body. Only that
 * small YAML subset is accepted; anything else throws with the file name.
 */
export function parseSource(text, file = "source") {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") throw new Error(`${file}: missing frontmatter`);
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error(`${file}: unterminated frontmatter`);

  const applyTo = [];
  let excludeAgent;
  let nested = false;
  let inList = false;
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item) {
      if (!inList) throw new Error(`${file}: unexpected list item "${line}"`);
      applyTo.push(unquote(item[1].trim()));
      continue;
    }
    inList = false;
    const pair = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!pair) throw new Error(`${file}: cannot parse "${line}"`);
    const [, key, value] = pair;
    if (key === "applyTo" && value === "") inList = true;
    else if (key === "excludeAgent" && EXCLUDE_AGENTS.has(unquote(value)))
      excludeAgent = unquote(value);
    else if (key === "nested" && (value === "true" || value === "false"))
      nested = value === "true";
    else throw new Error(`${file}: unsupported frontmatter "${line}"`);
  }

  if (applyTo.length === 0) throw new Error(`${file}: applyTo has no globs`);
  for (const glob of applyTo) {
    if (glob === "" || glob.includes(",") || glob.startsWith("/"))
      throw new Error(`${file}: invalid glob "${glob}"`);
  }
  const body = lines
    .slice(end + 1)
    .join("\n")
    .trim();
  if (body === "") throw new Error(`${file}: empty body`);
  let nestedDir;
  if (nested) {
    const match = NESTED_GLOB_RE.exec(applyTo[0]);
    if (!match)
      throw new Error(
        `${file}: nested needs a first applyTo glob of the form "<dir>/**"`,
      );
    nestedDir = match[1];
  }
  return { applyTo, excludeAgent, nestedDir, body };
}

/**
 * The literal path part of a glob, up to the last `/` before its first
 * wildcard: `src/api/**` → `src/api/`, `src/*.ts` → `src/`, `README.md` →
 * `README.md`.
 */
export function staticPrefix(glob) {
  const wild = glob.search(/[*?[{]/);
  if (wild === -1) return glob;
  return glob.slice(0, glob.lastIndexOf("/", wild) + 1);
}

/** The banner that stamps a file generated from an area source. */
function banner(area) {
  return `<!-- Generated from ${SOURCE_DIR}/${area}.md by scripts/agent-instructions.mjs — edit the source, then run: npm run docs:instructions -->`;
}

/** Render one Copilot path-specific instructions file. */
export function render(area, source) {
  const front = [`applyTo: "${source.applyTo.join(",")}"`];
  if (source.excludeAgent) front.push(`excludeAgent: "${source.excludeAgent}"`);
  return ["---", ...front, "---", "", banner(area), "", source.body, ""].join(
    "\n",
  );
}

/**
 * Render one Cursor rule (N-76): auto-attached to the area's globs, with the
 * body's first heading as its description.
 */
export function renderCursor(area, source) {
  const title = /^#\s+(.+)$/m.exec(source.body)?.[1].trim() ?? area;
  return [
    "---",
    `description: ${title.replace(/\s+/g, " ")}`,
    `globs: ${source.applyTo.join(",")}`,
    "alwaysApply: false",
    "---",
    "",
    banner(area),
    "",
    source.body,
    "",
  ].join("\n");
}

/** Render one nested <dir>/AGENTS.md (N-46b): the banner and the body. */
export function renderNested(area, source) {
  return [banner(area), "", source.body, ""].join("\n");
}

/** True when a file's text starts with an area-source banner. */
function isGenerated(text) {
  return text.startsWith(`<!-- Generated from ${SOURCE_DIR}/`);
}

/** True when a Cursor rule carries an area-source banner after its frontmatter. */
function isGeneratedRule(text) {
  return text.includes(`\n---\n\n<!-- Generated from ${SOURCE_DIR}/`);
}

/** Write `text` to `rel` unless it is already there; returns true on drift. */
function syncFile(root, rel, text, check) {
  const target = path.join(root, rel);
  const current = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (current === text) return false;
  if (!check) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return true;
}

/**
 * Repo-relative paths of every nested AGENTS.md below the root (the root
 * file itself excluded), skipping dot directories and build output.
 */
function findNested(root, rel = "") {
  const found = [];
  for (const entry of readdirSync(path.join(root, rel), {
    withFileTypes: true,
  })) {
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SCAN_SKIP.has(entry.name)) continue;
      found.push(...findNested(root, child));
    } else if (rel !== "" && entry.isFile() && entry.name === NESTED_NAME) {
      found.push(child);
    }
  }
  return found;
}

/** Render .github/copilot-instructions.md from the AGENTS.md text. */
export function renderRoot(text) {
  const body = text.replace(/\r\n/g, "\n").trim();
  if (body === "") throw new Error(`${ROOT_SOURCE}: empty`);
  return [
    `<!-- Generated from ${ROOT_SOURCE} by scripts/agent-instructions.mjs — edit the source, then run: npm run docs:instructions -->`,
    "",
    body,
    "",
  ].join("\n");
}

/** Every area source as { area, file, source }, sorted by area. */
export function readSources(root) {
  const dir = path.join(root, SOURCE_DIR);
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  if (names.length === 0) throw new Error(`${SOURCE_DIR}: no sources`);
  return names.map((name) => {
    const area = name.slice(0, -".md".length);
    const file = `${SOURCE_DIR}/${name}`;
    if (!AREA_RE.test(area))
      throw new Error(`${file}: area name must match ${AREA_RE}`);
    const source = parseSource(
      readFileSync(path.join(dir, name), "utf8"),
      file,
    );
    for (const glob of source.applyTo) {
      const prefix = staticPrefix(glob);
      if (prefix !== "" && !existsSync(path.join(root, prefix)))
        throw new Error(
          `${file}: "${glob}" matches nothing (${prefix} missing)`,
        );
    }
    return { area, file, source };
  });
}

/**
 * Bring .github/instructions/, the nested AGENTS.md files, the Cursor rules,
 * .github/copilot-instructions.md and GEMINI.md in line with the sources. Returns the
 * repo-relative paths that were (check: would be) written or removed.
 */
export function syncInstructions({ root, check = false }) {
  const outDir = path.join(root, OUTPUT_DIR);
  const sources = readSources(root);
  const wanted = new Map(
    sources.map(({ area, source }) => [
      `${area}${OUTPUT_SUFFIX}`,
      render(area, source),
    ]),
  );
  const existing = existsSync(outDir)
    ? readdirSync(outDir).filter((name) => name.endsWith(OUTPUT_SUFFIX))
    : [];

  const drift = [];
  for (const [name, text] of wanted) {
    const target = path.join(outDir, name);
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (current === text) continue;
    drift.push(`${OUTPUT_DIR}/${name}`);
    if (!check) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(target, text);
    }
  }
  for (const name of existing.sort()) {
    if (wanted.has(name)) continue;
    drift.push(`${OUTPUT_DIR}/${name}`);
    if (!check) rmSync(path.join(outDir, name));
  }
  drift.push(...syncNested(root, sources, check));
  drift.push(...syncCursor(root, sources, check));
  // N-43: a tree without AGENTS.md has no repository-wide file to render.
  // N-76: Gemini CLI reads the same text as GEMINI.md.
  const rootSource = path.join(root, ROOT_SOURCE);
  if (existsSync(rootSource)) {
    const text = renderRoot(readFileSync(rootSource, "utf8"));
    for (const rel of [ROOT_OUTPUT, GEMINI_OUTPUT]) {
      if (syncFile(root, rel, text, check)) drift.push(rel);
    }
  }
  return drift;
}

/** N-76: write the Cursor rules, remove the stale generated ones. */
function syncCursor(root, sources, check) {
  const wanted = new Map(
    sources.map(({ area, source }) => [
      `${area}${CURSOR_SUFFIX}`,
      renderCursor(area, source),
    ]),
  );
  const drift = [];
  for (const [name, text] of wanted) {
    const rel = `${CURSOR_DIR}/${name}`;
    if (syncFile(root, rel, text, check)) drift.push(rel);
  }
  const dir = path.join(root, CURSOR_DIR);
  const existing = existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith(CURSOR_SUFFIX))
    : [];
  for (const name of existing.sort()) {
    if (wanted.has(name)) continue;
    if (!isGeneratedRule(readFileSync(path.join(dir, name), "utf8"))) continue;
    drift.push(`${CURSOR_DIR}/${name}`);
    if (!check) rmSync(path.join(dir, name));
  }
  return drift;
}

/** N-46b: write the opted-in nested files, remove the stale generated ones. */
function syncNested(root, sources, check) {
  const wanted = new Map();
  for (const { area, file, source } of sources) {
    if (source.nestedDir === undefined) continue;
    const rel = `${source.nestedDir}/${NESTED_NAME}`;
    if (wanted.has(rel))
      throw new Error(`${file}: ${rel} is already rendered by another area`);
    wanted.set(rel, renderNested(area, source));
  }
  const drift = [];
  for (const [rel, text] of wanted) {
    const target = path.join(root, rel);
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (current === text) continue;
    if (current !== null && !isGenerated(current))
      throw new Error(
        `${rel}: hand-written file in the way of a nested source`,
      );
    drift.push(rel);
    if (!check) writeFileSync(target, text);
  }
  for (const rel of findNested(root).sort()) {
    if (wanted.has(rel)) continue;
    if (!isGenerated(readFileSync(path.join(root, rel), "utf8"))) continue;
    drift.push(rel);
    if (!check) rmSync(path.join(root, rel));
  }
  return drift;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  const check = process.argv.includes("--check");
  const root = path.resolve(import.meta.dirname, "..");
  try {
    const drift = syncInstructions({ root, check });
    if (drift.length === 0) {
      console.log("docs:instructions: up to date.");
    } else if (check) {
      console.error(
        `docs:instructions: stale — ${drift.join(", ")}.\nRun: npm run docs:instructions`,
      );
      process.exit(1);
    } else {
      console.log(`docs:instructions: updated ${drift.join(", ")}.`);
    }
  } catch (error) {
    console.error(`docs:instructions: ${error.message}`);
    process.exit(1);
  }
}
