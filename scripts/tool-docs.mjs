// N-42: the generated tool reference. From the live registry (the same
// source as the README tools table and the manifest) it renders
//
//   docs/tools/README.md        package index + the error-code table
//   docs/tools/<package>.md     per tool: purpose, parameters, output, writes
//   docs/llms-full.txt          README + SECURITY + the tool reference, one file
//   docs/llms.txt               the generated "Tool reference" link section
//   docs/index.md               the landing page as Markdown (scripts/landing-md.mjs)
//
// and N-53 checks `context7.json` (the agent documentation index) against
// the tree. `npm run docs:sync` writes all of it; `--check` lists the drift
// and exits 1. test/tool-docs.test.js is the guard that fails CI on drift.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { landingMarkdown } from "./landing-md.mjs";

export const TOOLS_DIR = "docs/tools";
export const LLMS_FULL = "docs/llms-full.txt";
export const LLMS = "docs/llms.txt";
export const CONTEXT7 = "context7.json";
export const LANDING_HTML = "docs/index.html";
export const LANDING_MD = "docs/index.md";

export const REPO_URL = "https://github.com/IvanBBaev/servicenow-mcp-ai";
export const SITE_URL = "https://ivanbbaev.github.io/servicenow-mcp-ai";

export const LLMS_BEGIN =
  "<!-- GENERATED:TOOL-REFERENCE:BEGIN (npm run docs:sync) -->";
export const LLMS_END = "<!-- GENERATED:TOOL-REFERENCE:END -->";

const GENERATED_NOTE =
  "_Generated from the tool registrations by `npm run docs:sync` — edit the tool definitions in `src/tools/`, not this file._";

/** One line, table-safe. */
function cell(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll("|", "\\|");
}

/** A compact type label for one JSON Schema node. */
export function typeLabel(schema) {
  if (!schema || typeof schema !== "object") return "any";
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }
  if ("const" in schema) return JSON.stringify(schema.const);
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    return [...new Set(union.map(typeLabel))].join(" | ");
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const labels = types.filter(Boolean).map((type) => {
    if (type === "array") return `${typeLabel(schema.items)}[]`;
    if (type === "object" && schema.additionalProperties) {
      return typeof schema.additionalProperties === "object"
        ? `record<${typeLabel(schema.additionalProperties)}>`
        : "object";
    }
    return type;
  });
  return labels.length > 0 ? labels.join(" | ") : "any";
}

/** How a tool touches the instance, from its MCP annotations and schema. */
export function writesLabel(tool, inputSchema) {
  const a = tool.annotations ?? {};
  if (a.readOnlyHint === true) return "Read-only.";
  const props = inputSchema?.properties ?? {};
  const parts = [a.destructiveHint === true ? "Destructive write" : "Write"];
  if (a.idempotentHint === true) parts.push("idempotent");
  let text = `${parts.join(", ")}.`;
  if ("apply" in props) {
    text +=
      " Plan and apply: without `apply: true` the call returns a non-mutating plan preview (unless `SN_WRITE_MODE=apply`).";
  }
  if ("plan_token" in props) {
    text +=
      " Under `SN_DESTRUCTIVE_CONFIRM=token|elicit` an apply needs the `plan_token` of a matching preview.";
  }
  return text;
}

function paramsTable(inputSchema) {
  const props = Object.entries(inputSchema?.properties ?? {});
  if (props.length === 0) return ["No parameters."];
  const required = new Set(inputSchema.required ?? []);
  return [
    "| Name | Type | Required | Description |",
    "| ---- | ---- | :------: | ----------- |",
    ...props.map(
      ([name, schema]) =>
        `| \`${name}\` | ${cell(typeLabel(schema))} | ${required.has(name) ? "yes" : "no"} | ${cell(schema.description)} |`,
    ),
  ];
}

function outputSection(outputSchema) {
  const props = Object.entries(outputSchema?.properties ?? {});
  if (props.length === 0) {
    return [
      "Free-form JSON text (no declared `outputSchema`); errors follow the [error contract](README.md#error-codes).",
    ];
  }
  return [
    "Declared `outputSchema` (more keys may be present); errors follow the [error contract](README.md#error-codes).",
    "",
    "| Field | Type | Description |",
    "| ----- | ---- | ----------- |",
    ...props.map(
      ([name, schema]) =>
        `| \`${name}\` | ${cell(typeLabel(schema))} | ${cell(schema.description)} |`,
    ),
  ];
}

/** The page of one package. */
export function buildPackagePage({ name, tools, schemas, core }) {
  const writes = tools.filter((t) => !t.readOnly).length;
  const lines = [
    `# \`${name}\` tools`,
    "",
    GENERATED_NOTE,
    "",
    `${tools.length} tool${tools.length === 1 ? "" : "s"} (${tools.length - writes} read-only, ${writes} write). ${
      name === "admin"
        ? "Always on."
        : core
          ? "In the default `core` profile."
          : `Opt-in: add \`${name}\` to \`SN_TOOL_PACKAGES\`, or call \`servicenow_enable_package\`.`
    } [All packages](README.md).`,
    "",
    "| Tool | Read-only | Title |",
    "| ---- | :-------: | ----- |",
    ...tools.map(
      (t) =>
        `| [\`${t.name}\`](#${t.name}) | ${t.readOnly ? "yes" : "no"} | ${cell(t.title)} |`,
    ),
  ];
  for (const tool of tools) {
    const schema = schemas.get(tool.name) ?? {};
    lines.push(
      "",
      `## ${tool.name}`,
      "",
      `**${tool.title}.** ${tool.description.trim()}`,
      "",
      `**Writes:** ${writesLabel(tool, schema.inputSchema)}`,
      "",
      "### Parameters",
      "",
      ...paramsTable(schema.inputSchema),
      "",
      "### Output",
      "",
      ...outputSection(schema.outputSchema),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The index page: packages and the error-code table. */
export function buildIndexPage({ packages, errorCodes }) {
  const lines = [
    "# Tool reference",
    "",
    GENERATED_NOTE,
    "",
    `${packages.reduce((n, p) => n + p.tools.length, 0)} tools in ${packages.length} packages. Select packages with \`SN_TOOL_PACKAGES\` (default \`core\`); the \`admin\` tools are always on. Setup and settings are in the [README](../../README.md).`,
    "",
    "| Package | Tools | Read-only | Default `core` |",
    "| ------- | ----: | --------: | :------------: |",
    ...packages.map(
      (p) =>
        `| [\`${p.name}\`](${p.name}.md) | ${p.tools.length} | ${p.tools.filter((t) => t.readOnly).length} | ${p.name === "admin" || p.core ? "yes" : "no"} |`,
    ),
    "",
    "## Error codes",
    "",
    "A failed call returns `isError: true` with one JSON object: `error` (the message), `code`, `source` (`servicenow`, `policy` or `server`) and, where one helps, `hint` and `detail`.",
    "",
    "| Code | Source | Meaning |",
    "| ---- | ------ | ------- |",
    ...Object.entries(errorCodes)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([code, e]) =>
          `| \`${code}\` | ${cell(e.source)} | ${cell(e.description)} |`,
      ),
  ];
  return `${lines.join("\n")}\n`;
}

/** The generated link section of docs/llms.txt. */
export function buildLlmsSection(packages) {
  return [
    LLMS_BEGIN,
    "",
    "## Tool reference",
    "",
    `- [Full documentation in one file](${SITE_URL}/llms-full.txt): README, SECURITY and the tool reference`,
    `- [Documentation site as Markdown](${SITE_URL}/index.md): the landing page without the markup`,
    `- [Tool reference index](${REPO_URL}/blob/main/${TOOLS_DIR}/README.md): packages and error codes`,
    ...packages.map(
      (p) =>
        `- [${p.name}](${REPO_URL}/blob/main/${TOOLS_DIR}/${p.name}.md): ${p.tools.length} tool${p.tools.length === 1 ? "" : "s"}`,
    ),
    "",
    LLMS_END,
  ].join("\n");
}

/** Every generated file under `root`, as a Map of relative path → content. */
export function generateToolDocs({
  root,
  tools,
  schemas,
  errorCodes,
  corePackages,
}) {
  const bySchema = new Map(schemas.map((s) => [s.name, s]));
  const order = [];
  const grouped = new Map();
  for (const tool of tools) {
    if (!grouped.has(tool.package)) {
      grouped.set(tool.package, []);
      order.push(tool.package);
    }
    grouped.get(tool.package).push(tool);
  }
  const packages = order.map((name) => ({
    name,
    tools: grouped.get(name),
    core: corePackages.has(name),
  }));

  const files = new Map();
  const index = buildIndexPage({ packages, errorCodes });
  files.set(`${TOOLS_DIR}/README.md`, index);
  const pages = packages.map((p) => {
    const page = buildPackagePage({ ...p, schemas: bySchema });
    files.set(`${TOOLS_DIR}/${p.name}.md`, page);
    return page;
  });

  const read = (file) => readFileSync(path.join(root, file), "utf8").trim();
  files.set(
    LLMS_FULL,
    [
      "# servicenow-mcp-ai — full documentation",
      "",
      `> README, SECURITY and the tool reference in one Markdown file for LLM context. Generated by \`npm run docs:sync\`; the short index is ${SITE_URL}/llms.txt.`,
      "",
      read("README.md"),
      read("SECURITY.md"),
      index.trim(),
      ...pages.map((p) => p.trim()),
    ].join("\n\n---\n\n") + "\n",
  );

  files.set(
    LANDING_MD,
    landingMarkdown(readFileSync(path.join(root, LANDING_HTML), "utf8"), {
      siteUrl: SITE_URL,
    }),
  );

  const llms = read(LLMS) + "\n";
  const b = llms.indexOf(LLMS_BEGIN);
  const e = llms.indexOf(LLMS_END);
  if (b === -1 || e === -1 || e < b) {
    throw new Error(`${LLMS}: markers not found (${LLMS_BEGIN} … ${LLMS_END})`);
  }
  files.set(
    LLMS,
    llms.slice(0, b) +
      buildLlmsSection(packages) +
      llms.slice(e + LLMS_END.length),
  );
  return files;
}

/**
 * Bring the generated files under `root` in line with `files`; with `check`
 * nothing is written. A stale page in docs/tools/ counts as drift (and is
 * removed). Returns the drifting paths.
 */
export function syncToolDocs({ root, files, check = false }) {
  const drift = [];
  for (const [file, content] of files) {
    const abs = path.join(root, file);
    const current = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
    if (current === content) continue;
    drift.push(file);
    if (!check) {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  }
  const dir = path.join(root, TOOLS_DIR);
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      const file = `${TOOLS_DIR}/${name}`;
      if (files.has(file)) continue;
      drift.push(file);
      if (!check) rmSync(path.join(root, file), { recursive: true });
    }
  }
  return drift;
}

/**
 * N-53: `context7.json` must parse, name the project, index the generated
 * docs (`docs/`, which holds docs/tools/ and llms-full.txt), and keep the
 * planning and test trees out. Returns the problems found.
 */
export function checkContext7(root) {
  const abs = path.join(root, CONTEXT7);
  if (!existsSync(abs)) return [`${CONTEXT7} is missing`];
  let config;
  try {
    config = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    return [`${CONTEXT7}: ${err instanceof Error ? err.message : err}`];
  }
  const problems = [];
  if (typeof config.projectTitle !== "string" || !config.projectTitle) {
    problems.push(`${CONTEXT7}: projectTitle is missing`);
  }
  for (const key of ["folders", "excludeFolders", "excludeFiles", "rules"]) {
    if (!Array.isArray(config[key])) {
      problems.push(`${CONTEXT7}: ${key} must be an array`);
    }
  }
  for (const folder of config.folders ?? []) {
    if (!existsSync(path.join(root, folder))) {
      problems.push(`${CONTEXT7}: folder ${folder} does not exist`);
    }
  }
  if (!(config.folders ?? []).includes("docs")) {
    problems.push(`${CONTEXT7}: folders must include docs`);
  }
  for (const required of ["project", "test", "docs/ai", "docs/instance"]) {
    if (!(config.excludeFolders ?? []).includes(required)) {
      problems.push(`${CONTEXT7}: excludeFolders must include ${required}`);
    }
  }
  return problems;
}
