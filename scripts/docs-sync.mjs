// D-3: keeps the tool and package counts quoted across the distribution
// surfaces in step with the live registry (src/mcp/registry.ts):
//
//   README.md                        the tools badge, the "(N packages)" layout note
//   package.json                     "N tools in M packages" in the description
//   server.json                      "N tools" in the description
//   extension/package.json           "N tools" in the description
//   extension/README.md              "N tools"
//   .claude-plugin/plugin.json       "N tools"
//   .claude-plugin/marketplace.json  "N tools"
//   docs/index.html                  meta descriptions, hero stats, the tools intro
//
// The same run regenerates the tool reference (N-42: docs/tools/, the
// docs/llms-full.txt bundle, the docs/llms.txt link section, the docs/index.md
// Markdown alternate of the landing page) and checks
// context7.json (N-53) — see scripts/tool-docs.mjs.
//
// Every pattern must match at least once, so a reworded sentence fails loudly
// instead of silently dropping out of the sync. Test and coverage counts are
// not tracked: they change with every test added and only the run knows them.
//
//   npm run docs:sync               rewrite the counts in place
//   npm run docs:sync -- --check    dry run: list the drift, exit 1
//
// test/docs-sync.test.js is the guard that fails CI on drift.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  loadCorePackagesFromSource,
  loadErrorCodesFromSource,
  loadToolSchemasFromSource,
  loadToolsFromSource,
} from "./registry-from-source.mjs";
import { checkContext7, generateToolDocs, syncToolDocs } from "./tool-docs.mjs";

/**
 * Each site: a file and its patterns. A pattern's capture groups are named
 * `tools` and/or `packages`; only those groups are rewritten.
 */
export const SITES = [
  {
    file: "README.md",
    patterns: [
      /badge\/tools-(?<tools>\d+)-blue/g,
      /one file per package \((?<packages>\d+) packages\)/g,
    ],
  },
  {
    file: "package.json",
    patterns: [/(?<tools>\d+) tools in (?<packages>\d+) packages/g],
  },
  { file: "server.json", patterns: [/(?<tools>\d+) tools over/g] },
  { file: "extension/package.json", patterns: [/(?<tools>\d+) tools over/g] },
  { file: "extension/README.md", patterns: [/(?<tools>\d+) tools over/g] },
  {
    file: ".claude-plugin/plugin.json",
    patterns: [/(?<tools>\d+) tools over/g],
  },
  {
    file: ".claude-plugin/marketplace.json",
    patterns: [/MCP server — (?<tools>\d+) tools/g],
  },
  {
    file: "docs/index.html",
    patterns: [
      /(?<tools>\d+) tools, (?<packages>\d+) packages/g,
      /<b>(?<tools>\d+)<\/b><span>tools<\/span>/g,
      /<b>(?<packages>\d+)<\/b><span>packages<\/span>/g,
      /(?<tools>\d+) tools across (?<packages>\d+) packages/g,
      /even with (?<tools>\d+) tools on the page/g,
    ],
  },
];

/** Rewrite the named count groups of every match of `pattern` in `text`. */
function rewrite(text, pattern, counts) {
  let hits = 0;
  const next = text.replace(pattern, (...args) => {
    hits += 1;
    const match = args[0];
    const offset = args.at(-3);
    const groups = args.at(-1);
    const indices = new RegExp(pattern.source, "d").exec(
      text.slice(offset, offset + match.length),
    ).indices.groups;
    let out = match;
    // Replace right-to-left so earlier indices stay valid.
    const names = Object.keys(groups)
      .filter((name) => indices[name])
      .sort((a, b) => indices[b][0] - indices[a][0]);
    for (const name of names) {
      const [from, to] = indices[name];
      out = out.slice(0, from) + String(counts[name]) + out.slice(to);
    }
    return out;
  });
  return { next, hits };
}

/** Tool and package counts from a ToolInfo[] (each carries `package`). */
export function countTools(tools) {
  return {
    tools: tools.length,
    packages: new Set(tools.map((t) => t.package)).size,
  };
}

/**
 * Bring every site under `root` to `counts`. With `check` nothing is written.
 * Returns the drifting files; throws when a pattern no longer matches.
 */
export function syncCounts({ root, counts, check = false, sites = SITES }) {
  const drift = [];
  for (const site of sites) {
    const abs = path.join(root, site.file);
    const text = readFileSync(abs, "utf8");
    let next = text;
    for (const pattern of site.patterns) {
      const result = rewrite(next, pattern, counts);
      if (result.hits === 0) {
        throw new Error(`${site.file}: pattern ${pattern} no longer matches`);
      }
      next = result.next;
    }
    if (next === text) continue;
    drift.push(site.file);
    if (!check) writeFileSync(abs, next);
  }
  return drift;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  const check = process.argv.includes("--check");
  const root = path.join(import.meta.dirname, "..");
  try {
    const tools = await loadToolsFromSource();
    const counts = countTools(tools);
    // Counts first: the generated files quote README.md and docs/index.html.
    const countDrift = syncCounts({ root, counts, check });
    const files = generateToolDocs({
      root,
      tools,
      schemas: await loadToolSchemasFromSource(),
      errorCodes: await loadErrorCodesFromSource(),
      corePackages: await loadCorePackagesFromSource(),
    });
    const drift = [...countDrift, ...syncToolDocs({ root, files, check })];
    const problems = checkContext7(root);
    const label = `${counts.tools} tools, ${counts.packages} packages`;
    if (problems.length > 0) {
      console.error(`docs:sync: ${problems.join("\n  ")}`);
      process.exit(1);
    }
    if (drift.length === 0) {
      console.log(
        `docs:sync: every site says ${label}; the tool reference is current`,
      );
    } else if (check) {
      console.error(
        `docs:sync: ${drift.length} file(s) drift from the registry (${label}):\n` +
          drift.map((file) => `  ${file}`).join("\n") +
          "\nRun: npm run docs:sync",
      );
      process.exit(1);
    } else {
      console.log(`docs:sync: wrote ${drift.join(", ")} (${label})`);
    }
  } catch (err) {
    console.error(`docs:sync: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
