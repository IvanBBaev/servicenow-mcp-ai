// D-3: keeps the tool and package counts quoted across the distribution
// surfaces in step with the live registry (src/mcp/registry.ts):
//
//   README.md                        the "(N packages)" layout note
//   extension/README.md              "N tools"
//   docs/index.html                  hero stats, the tools intro
//   AGENTS.md                        "N tools in M packages" (N-43; rendered to
//                                    .github/copilot-instructions.md by docs:instructions)
//
// The same run regenerates the tool reference (N-42: docs/tools/, the
// docs/llms-full.txt bundle, the docs/llms.txt link section, the docs/index.md
// Markdown alternate of the landing page, docs/sitemap.xml) and checks
// context7.json (N-53) — see scripts/tool-docs.mjs — and the site's
// changelog page and footer release links — see scripts/changelog-docs.mjs.
//
// Every pattern must match at least once, so a reworded sentence fails loudly
// instead of silently dropping out of the sync. Test and coverage counts are
// not tracked: they change with every test added and only the run knows them.
// N-99 adds the prompt and resource counts of the landing page, and refuses a
// public copy of what cannot be tracked (STALE_CLAIMS) or a licence that
// differs from package.json.
// N-98 renders docs/positioning.json — the one tagline, value statement and
// manifest descriptions — into the README and site heroes, the site's meta
// descriptions, docs/llms.txt and the descriptions of package.json,
// server.json, extension/package.json and .claude-plugin/*.json (POSITIONING).
// mcpb/manifest.json follows package.json through mcpb:manifest.
//
//   npm run docs:sync               rewrite the counts in place
//   npm run docs:sync -- --check    dry run: list the drift, exit 1
//
// test/docs-sync.test.js is the guard that fails CI on drift.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { syncChangelogDocs } from "./changelog-docs.mjs";
import {
  loadCorePackagesFromSource,
  loadErrorCodesFromSource,
  loadToolSchemasFromSource,
  loadToolsFromSource,
} from "./registry-from-source.mjs";
import { checkContext7, generateToolDocs, syncToolDocs } from "./tool-docs.mjs";

/**
 * Each site: a file and its patterns. A pattern's capture groups are named
 * `tools`, `packages`, `resources` or `prompts`; only those groups are rewritten.
 */
export const SITES = [
  {
    file: "README.md",
    patterns: [/one file per package \((?<packages>\d+) packages\)/g],
  },
  { file: "extension/README.md", patterns: [/(?<tools>\d+) tools over/g] },
  {
    file: "AGENTS.md",
    patterns: [/(?<tools>\d+) tools in (?<packages>\d+) packages/g],
  },
  {
    file: "docs/index.html",
    patterns: [
      /(?<tools>\d+) tools, (?<packages>\d+) packages/g,
      /<b>(?<tools>\d+)<\/b><span>tools<\/span>/g,
      /<b>(?<packages>\d+)<\/b><span>packages<\/span>/g,
      /<b>(?<resources>\d+)<\/b><span>MCP resources<\/span>/g,
      /<b>(?<prompts>\d+)<\/b><span>prompts<\/span>/g,
      /(?<tools>\d+) tools across (?<packages>\d+) packages/g,
      /even with (?<tools>\d+) tools on the page/g,
    ],
  },
];

/** N-99: public text that goes stale by itself, so no copy may exist. */
export const STALE_CLAIMS = [
  {
    files: ["README.md", "docs/index.html", "extension/README.md"],
    pattern: /\b\d[\d,]* tests\b/,
    why: "a test count; only the run knows it, so say it without a number",
  },
  {
    files: ["project/COMPETITIVE-ANALYSIS.md"],
    pattern: /\(MIT\)/,
    why: "the licence is GPL since 3.0",
  },
];

/** N-99: manifests whose `license` must equal the one in package.json. */
export const LICENCE_MANIFESTS = [
  "extension/package.json",
  "mcpb/manifest.json",
  ".claude-plugin/plugin.json",
];

/** N-98: the registry caps the server.json description (MCP Registry schema). */
export const REGISTRY_DESCRIPTION_MAX = 100;

const htmlText = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const htmlAttr = (text) => htmlText(text).replaceAll('"', "&quot;");

/**
 * N-98: each place docs/positioning.json is rendered into. `pattern` keeps its
 * first and last groups and swaps what lies between them for `render(texts)`.
 */
export const POSITIONING = [
  ...[
    ["package.json", "package"],
    ["server.json", "registry"],
    ["extension/package.json", "extension"],
    [".claude-plugin/plugin.json", "plugin"],
    [".claude-plugin/marketplace.json", "marketplace"],
  ].map(([file, key]) => ({
    file,
    pattern: /(?<pre>"description": )"(?:[^"\\]|\\.)*"(?<post>)/,
    render: (t) => JSON.stringify(t.descriptions[key]),
  })),
  {
    file: "README.md",
    pattern:
      /(?<pre><!-- positioning:start[^>]*-->\n)[\s\S]*?(?<post><!-- positioning:end -->)/,
    render: (t) => `**${t.tagline}** ${t.what}\n${t.value}\n\n${t.counts}\n`,
  },
  {
    file: "docs/index.html",
    pattern:
      /(?<pre><!-- positioning:start[^>]*-->\n)[\s\S]*?(?<post>\s*<!-- positioning:end -->)/,
    render: (t) =>
      `          <h1>${htmlText(t.headline[0])} <span class="accent">${htmlText(t.headline[1])}</span></h1>\n` +
      `          <p class="lead">${htmlText(t.what)} ${htmlText(t.value)}</p>`,
  },
  ...[
    'name="description"',
    'property="og:description"',
    'name="twitter:description"',
  ].map((attr) => ({
    file: "docs/index.html",
    pattern: new RegExp(`(?<pre>${attr}\\s+content=")[^"]*(?<post>")`),
    render: (t) => htmlAttr(t.descriptions.meta),
  })),
  {
    file: "docs/index.html",
    pattern:
      /(?<pre>"applicationCategory"[\s\S]*?"description": )"[^"]*"(?<post>)/,
    render: (t) => JSON.stringify(t.descriptions.meta),
  },
  {
    file: "docs/llms.txt",
    pattern: /(?<pre>^> ).*(?<post>)$/m,
    render: (t) => `${t.what} ${t.value} ${t.counts} ${t.disclaimer}`,
  },
];

/** N-98: fill the count placeholders and derive the shared texts. */
export function renderPositioning(positioning, counts) {
  const fill = (text) =>
    text.replace(/\{(tools|packages|defaultTools)\}/g, (_, name) => {
      if (counts[name] === undefined) throw new Error(`no count for {${name}}`);
      return String(counts[name]);
    });
  const descriptions = Object.fromEntries(
    Object.entries(positioning.descriptions).map(([k, v]) => [k, fill(v)]),
  );
  for (const [key, text] of Object.entries(descriptions)) {
    if (/^\d/.test(text)) {
      throw new Error(`positioning: description "${key}" opens with a count`);
    }
  }
  if (descriptions.registry.length > REGISTRY_DESCRIPTION_MAX) {
    throw new Error(
      `positioning: the registry description has ${descriptions.registry.length} characters, the limit is ${REGISTRY_DESCRIPTION_MAX}`,
    );
  }
  return {
    ...positioning,
    tagline: positioning.headline.join(" "),
    counts: fill(positioning.counts),
    descriptions,
  };
}

/**
 * N-98: bring every POSITIONING site under `root` to docs/positioning.json.
 * With `check` nothing is written. Returns the drifting files; throws when a
 * site no longer matches.
 */
export function syncPositioning({
  root,
  counts,
  check = false,
  sites = POSITIONING,
}) {
  const texts = renderPositioning(
    JSON.parse(readFileSync(path.join(root, "docs/positioning.json"), "utf8")),
    counts,
  );
  const files = new Map();
  for (const site of sites) {
    const abs = path.join(root, site.file);
    if (!files.has(abs))
      files.set(abs, { file: site.file, before: readFileSync(abs, "utf8") });
    const entry = files.get(abs);
    const text = entry.after ?? entry.before;
    const match = site.pattern.exec(text);
    if (!match)
      throw new Error(
        `${site.file}: positioning site ${site.pattern} no longer matches`,
      );
    const { pre, post } = match.groups;
    entry.after =
      text.slice(0, match.index) +
      pre +
      site.render(texts) +
      post +
      text.slice(match.index + match[0].length);
  }
  const drift = [];
  for (const [abs, { file, before, after }] of files) {
    if (after === before) continue;
    drift.push(file);
    if (!check) writeFileSync(abs, after);
  }
  return drift;
}

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

/**
 * Tool and package counts from a ToolInfo[] (each carries `package`). With the
 * core packages, `defaultTools` counts what a default profile loads: those
 * packages plus `admin`, which is always on.
 */
export function countTools(tools, corePackages = []) {
  const core = new Set([...corePackages, "admin"]);
  return {
    tools: tools.length,
    packages: new Set(tools.map((t) => t.package)).size,
    defaultTools: tools.filter((t) => core.has(t.package)).length,
  };
}

/** N-99: resources and prompts, from their registrations in src/mcp. */
export function countSurface(root) {
  const calls = (file, method) =>
    readFileSync(path.join(root, file), "utf8").split(`.${method}(`).length - 1;
  return {
    resources: calls("src/mcp/resources.ts", "registerResource"),
    prompts: calls("src/mcp/prompts.ts", "registerPrompt"),
  };
}

/** N-99: every stale claim and licence mismatch under `root`, as messages. */
export function checkPublicClaims({
  root,
  claims = STALE_CLAIMS,
  manifests = LICENCE_MANIFESTS,
}) {
  const read = (file) => readFileSync(path.join(root, file), "utf8");
  const problems = [];
  for (const { files, pattern, why } of claims) {
    for (const file of files) {
      const hit = pattern.exec(read(file));
      if (hit) problems.push(`${file}: "${hit[0]}" is ${why}`);
    }
  }
  const { license } = JSON.parse(read("package.json"));
  for (const file of manifests) {
    const found = JSON.parse(read(file)).license;
    if (found !== license) {
      problems.push(`${file}: license ${found}, package.json has ${license}`);
    }
  }
  return problems;
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
    const corePackages = await loadCorePackagesFromSource();
    const counts = {
      ...countTools(tools, corePackages),
      ...countSurface(root),
    };
    // Counts first: the generated files quote README.md and docs/index.html.
    const countDrift = [
      ...syncCounts({ root, counts, check }),
      ...syncPositioning({ root, counts, check }),
    ];
    // Release links next: docs/index.md is rendered from docs/index.html.
    const releaseDrift = syncChangelogDocs({ root, check });
    const files = generateToolDocs({
      root,
      tools,
      schemas: await loadToolSchemasFromSource(),
      errorCodes: await loadErrorCodesFromSource(),
      corePackages,
    });
    const drift = [
      ...countDrift,
      ...releaseDrift,
      ...syncToolDocs({ root, files, check }),
    ];
    const problems = [...checkContext7(root), ...checkPublicClaims({ root })];
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
