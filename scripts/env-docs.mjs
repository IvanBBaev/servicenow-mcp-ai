// D-3: renders every environment-variable reference from the E-4 settings
// manifest (src/core/settings-manifest.ts), so the docs cannot drift from the
// code:
//
//   README.md       the env tables between the GENERATED:ENV markers
//   .env.example    the body between the GENERATED:ENV markers
//   server.json     packages[0].environmentVariables (the keys with a
//                   `registry` text) — JSON has no comments, so that array
//                   itself is the generated region
//
// Prose outside the markers is preserved.
//
//   npm run docs:env               rewrite the three files in place
//   npm run docs:env -- --check    dry run: list the stale files, exit 1
//
// test/env-docs-generated.test.js is the guard that fails CI on drift.

import { readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const README_BEGIN = "<!-- GENERATED:ENV:BEGIN (npm run docs:env) -->";
export const README_END = "<!-- GENERATED:ENV:END -->";
export const EXAMPLE_BEGIN = "# GENERATED:ENV:BEGIN (npm run docs:env)";
export const EXAMPLE_END = "# GENERATED:ENV:END";

const WIDTH = 78;

/** Human text for a spec's default (mirrors defaultText() in the manifest). */
function defaultCell(spec) {
  if (spec.defaultText !== undefined) return spec.defaultText;
  if (spec.default === undefined) return "—";
  return `\`${String(spec.default)}\``;
}

/** Markdown → plain text for `.env.example` comments. */
export function stripMarkdown(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1");
}

function cell(text) {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function sinceCell(spec) {
  return spec.since === "unreleased" ? "next" : spec.since;
}

function readmeDescription(spec) {
  let text = spec.description;
  if (spec.aliases?.length) {
    text += ` Also read as ${spec.aliases.map((a) => `\`${a}\``).join(", ")}.`;
  }
  if (spec.pattern && spec.example) {
    const lines = spec.example.split("\n").map((l) => `\`${l}\``);
    text += ` Example: ${lines.join(", ")}.`;
  }
  return cell(text);
}

/** The README env reference: one table per manifest section. */
export function buildReadmeEnv(settings, sections) {
  const out = [
    README_BEGIN,
    "",
    "_These tables are generated from the settings manifest",
    "(`src/core/settings-manifest.ts`) — edit the manifest, then run",
    "`npm run docs:env`._",
  ];
  for (const section of sections) {
    const specs = settings.filter((s) => s.section === section.id);
    if (specs.length === 0) continue;
    out.push("", `#### ${section.title}`, "", section.blurb, "");
    out.push("| Variable | Required | Default | Since | Description |");
    out.push("| -------- | :------: | ------- | ----- | ----------- |");
    for (const spec of specs) {
      out.push(
        `| \`${spec.key}\` | ${spec.required ? "yes" : "no"} | ${cell(defaultCell(spec))} | ${sinceCell(spec)} | ${readmeDescription(spec)} |`,
      );
    }
  }
  out.push("", README_END);
  return out.join("\n");
}

/** Word-wrap `text` into `# `-prefixed comment lines. */
function comment(text) {
  const lines = [];
  let line = "#";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line.length + 1 + word.length > WIDTH && line !== "#") {
      lines.push(line);
      line = "#";
    }
    line += ` ${word}`;
  }
  if (line !== "#") lines.push(line);
  return lines;
}

function exampleValue(spec) {
  if (spec.example !== undefined) return spec.example;
  if (spec.default !== undefined) return String(spec.default);
  return "";
}

/** The `.env.example` body: every setting, grouped and commented. */
export function buildEnvExample(settings, sections) {
  const out = [EXAMPLE_BEGIN];
  for (const section of sections) {
    const specs = settings.filter((s) => s.section === section.id);
    if (specs.length === 0) continue;
    out.push("", `# --- ${section.title} ---`);
    out.push(...comment(stripMarkdown(section.blurb)));
    for (const spec of specs) {
      let text = stripMarkdown(spec.description);
      if (spec.defaultText !== undefined) {
        text += ` Default: ${stripMarkdown(spec.defaultText)}.`;
      } else if (
        spec.example !== undefined &&
        spec.default !== undefined &&
        spec.example !== String(spec.default)
      ) {
        text += ` Default: ${String(spec.default)}.`;
      }
      if (spec.aliases?.length) {
        text += ` Also read as ${spec.aliases.join(", ")}.`;
      }
      out.push("", ...comment(text));
      if (spec.pattern) {
        for (const line of (spec.example ?? "").split("\n").filter(Boolean)) {
          out.push(`# ${line}`);
        }
      } else if (spec.required && spec.example !== undefined) {
        out.push(`${spec.key}=${spec.example}`);
      } else {
        out.push(`# ${spec.key}=${exampleValue(spec)}`);
      }
    }
  }
  out.push("", EXAMPLE_END);
  return out.join("\n");
}

/** server.json `environmentVariables`: the keys with a registry text. */
export function buildServerEnv(settings) {
  return settings
    .filter((s) => s.registry)
    .map((s) => ({
      name: s.key,
      description: s.registry,
      isRequired: s.registryRequired === true,
      ...(s.secret ? { isSecret: true } : {}),
      format: "string",
    }));
}

function replaceBetween(source, begin, end, block, file) {
  const from = source.indexOf(begin);
  const to = source.indexOf(end);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`${file}: markers not found (${begin} … ${end}).`);
  }
  return source.slice(0, from) + block + source.slice(to + end.length);
}

/**
 * The next content of each generated file under `root`, keyed by the path
 * relative to root. Pure apart from reading the current files.
 */
export function renderEnvDocs({ root, settings, sections }) {
  const read = (file) => readFileSync(path.join(root, file), "utf8");
  const server = JSON.parse(read("server.json"));
  if (!server.packages?.[0]) throw new Error("server.json: no packages[0]");
  server.packages[0].environmentVariables = buildServerEnv(settings);
  return {
    "README.md": replaceBetween(
      read("README.md"),
      README_BEGIN,
      README_END,
      buildReadmeEnv(settings, sections),
      "README.md",
    ),
    ".env.example": replaceBetween(
      read(".env.example"),
      EXAMPLE_BEGIN,
      EXAMPLE_END,
      buildEnvExample(settings, sections),
      ".env.example",
    ),
    "server.json": JSON.stringify(server, null, 2) + "\n",
  };
}

/** Write (or, with `check`, only compare) the generated files. */
export function syncEnvDocs({ root, settings, sections, check = false }) {
  const next = renderEnvDocs({ root, settings, sections });
  const stale = [];
  for (const [file, text] of Object.entries(next)) {
    const abs = path.join(root, file);
    if (readFileSync(abs, "utf8") === text) continue;
    stale.push(file);
    if (!check) writeFileSync(abs, text);
  }
  return stale;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const check = process.argv.includes("--check");
  const root = fileURLToPath(new URL("..", import.meta.url));
  try {
    register("./ts-source-loader.mjs", import.meta.url);
    const { SETTINGS, SETTING_SECTIONS } =
      await import("../src/core/settings-manifest.ts");
    const stale = syncEnvDocs({
      root,
      settings: SETTINGS,
      sections: SETTING_SECTIONS,
      check,
    });
    if (stale.length === 0) {
      console.log(
        "docs:env: README.md, .env.example and server.json are current",
      );
    } else if (check) {
      console.error(
        `docs:env: ${stale.length} file(s) drift from the settings manifest:\n` +
          stale.map((file) => `  ${file}`).join("\n") +
          "\nRun: npm run docs:env",
      );
      process.exit(1);
    } else {
      console.log(`docs:env: regenerated ${stale.join(", ")}`);
    }
  } catch (err) {
    console.error(`docs:env: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
