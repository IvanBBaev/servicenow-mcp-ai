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
// The sources are the single place to edit. A nested AGENTS.md target would be
// one more renderer over the same sources — it waits for owner gate O-20.
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

/** Copilot's optional excludeAgent values. */
const EXCLUDE_AGENTS = new Set(["code-review", "cloud-agent"]);
const AREA_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Strip one pair of matching quotes from a YAML scalar. */
function unquote(value) {
  const match = /^(["'])(.*)\1$/.exec(value);
  return match ? match[2] : value;
}

/**
 * Parse a source file: a frontmatter block with `applyTo` (a YAML list of
 * globs) and an optional `excludeAgent`, then the Markdown body. Only that
 * small YAML subset is accepted; anything else throws with the file name.
 */
export function parseSource(text, file = "source") {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") throw new Error(`${file}: missing frontmatter`);
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error(`${file}: unterminated frontmatter`);

  const applyTo = [];
  let excludeAgent;
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
  return { applyTo, excludeAgent, body };
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

/** Render one Copilot path-specific instructions file. */
export function render(area, source) {
  const front = [`applyTo: "${source.applyTo.join(",")}"`];
  if (source.excludeAgent) front.push(`excludeAgent: "${source.excludeAgent}"`);
  return [
    "---",
    ...front,
    "---",
    "",
    `<!-- Generated from ${SOURCE_DIR}/${area}.md by scripts/agent-instructions.mjs — edit the source, then run: npm run docs:instructions -->`,
    "",
    source.body,
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
 * Bring .github/instructions/ in line with the sources. Returns the
 * repo-relative paths that were (check: would be) written or removed.
 */
export function syncInstructions({ root, check = false }) {
  const outDir = path.join(root, OUTPUT_DIR);
  const wanted = new Map(
    readSources(root).map(({ area, source }) => [
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
