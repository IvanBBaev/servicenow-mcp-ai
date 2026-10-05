// N-56 (TK-32): scans every piece of text the server hands to a model for the
// tool-poisoning patterns behind the 2026 MCP incidents. The surface:
//
//   the live server         tool titles, descriptions and every `title` /
//                           `description` in the input and output schemas;
//                           the server `instructions`; prompt descriptions,
//                           argument descriptions and rendered messages;
//                           resource and template names and descriptions,
//                           and the text of every static resource
//   skills/**, agents/**,   the Claude Code plugin's skills, subagents
//   hooks/**                and hooks
//   .claude-plugin/**       the plugin and marketplace manifests
//
// The server is built in-process from the TypeScript sources with every
// package enabled (no network: fetch is stubbed, a resource that needs the
// instance is skipped). The rules:
//
//   invisible-unicode      zero-width, bidirectional-control, tag
//                          (U+E0000 block) and other invisible code points
//   html-comment           `<!--` — invisible when rendered, read by a model
//   hidden-instruction     phrasing aimed at the model, not the user:
//                          "ignore previous …", `<IMPORTANT>`-style tags,
//                          "do not tell the user", secret-file paths
//   cross-tool-directive   a reference to a tool this server does not have
//                          (another server's `mcp__…` name or an unknown
//                          `servicenow_*` name), or phrasing that steers the
//                          model away from other tools ("before calling any
//                          other tool", "always use this tool", …)
//   url-not-allowlisted    an http(s) URL whose host is not in URL_ALLOWLIST
//   description-drift      a tool description whose SHA-256 differs from the
//                          checked-in manifest (run `npm run gen:manifest`
//                          after an intentional, reviewed change)
//
// A finding the repository intends is excused in ALLOWLIST, with a reason;
// the list is empty today and every entry is a reviewed edit.
//
//   npm run scan:surface             human-readable report, exit 1 on findings
//   npm run scan:surface -- --json   the same as JSON on stdout
//
// test/scan-surface.test.js covers each rule and keeps the live surface clean.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Plugin and skill trees scanned as files, relative to the repository root. */
export const FILE_ROOTS = ["skills", "agents", "hooks", ".claude-plugin"];

/**
 * Where a URL in model-facing text may point. An entry starting with a dot
 * matches the host and every subdomain; an entry with a path matches that
 * host and every path under the prefix (case-insensitive); any other entry
 * matches the host exactly.
 */
export const URL_ALLOWLIST = [
  // The project: landing page, repository, owner profile.
  "ivanbbaev.github.io",
  "github.com/IvanBBaev",
  // ServiceNow instances (examples) and the vendor's documentation.
  ".service-now.com",
  ".servicenow.com",
  // The protocol specification.
  "modelcontextprotocol.io",
  // The local HTTP transport and the OAuth callback.
  "localhost",
  "127.0.0.1",
];

/**
 * Intended findings, excused one by one: `rule`, the `source` it appears in,
 * the exact `match` text and the `reason`. Every entry is a reviewed edit.
 */
const MANUAL_MARKERS =
  "The docs store's manual-region markers (src/api/docs.ts): the model must write them verbatim, so the text quotes them.";
export const ALLOWLIST = [
  ...["<!-- sn:manual:start -->", "<!-- sn:manual:end -->"].map((match) => ({
    rule: "html-comment",
    source: "tool servicenow_write_doc description",
    match,
    reason: MANUAL_MARKERS,
  })),
  ...["<!-- sn:manual:start purpose -->", "<!-- sn:manual:end -->"].map(
    (match) => ({
      rule: "html-comment",
      source: "prompt servicenow_document_table message 0",
      match,
      reason: MANUAL_MARKERS,
    }),
  ),
];

/**
 * Invisible and bidirectional-control code points (global, Unicode). The
 * text / emoji presentation selectors U+FE0E and U+FE0F are left out: they
 * follow ordinary emoji. The other variation selectors are in, because runs
 * of them can smuggle bytes.
 */
const INVISIBLE =
  // eslint-disable-next-line no-misleading-character-class -- combining marks (CGJ, variation selectors) are matched one by one on purpose
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0D\uFEFF\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

/** An HTML comment, or an unterminated one up to the end of the text. */
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

/** Phrasing addressed to the model that a user-facing text has no need for. */
const HIDDEN_INSTRUCTION = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding|original|system)\s+(?:instructions?|prompts?|rules?|messages?|context)\b/gi,
  /<\s*\/?\s*(?:important|system|instructions?|secret|hidden|admin|assistant)\s*>/gi,
  /\b(?:do\s+not|don't|never)\s+(?:tell|inform|notify|mention\s+(?:this\s+)?to|reveal\s+(?:this\s+)?to|show)\s+the\s+user\b/gi,
  /\bwithout\s+(?:telling|informing|notifying|alerting)\s+the\s+user\b/gi,
  /\b(?:you\s+are\s+now\b|new\s+instructions?\s*:|from\s+now\s+on,?\s+you\b)/gi,
  /(?:~\/\.ssh|\bid_rsa\b|\/etc\/(?:passwd|shadow)\b|~\/\.aws\/credentials|\bmcp\.json\b)/gi,
];

/** Phrasing that steers the model between tools instead of describing one. */
const CROSS_TOOL_PHRASES = [
  /\b(?:before|instead\s+of)\s+(?:calling|using|invoking)\s+(?:any|every|all)\s+(?:other\s+)?tools?\b/gi,
  /\b(?:do\s+not|don't|never)\s+(?:call|use|invoke|trust)\s+(?:any\s+)?(?:other|another|the\s+other)\s+(?:tools?|servers?)\b/gi,
  /\b(?:always|must)\s+(?:call|use|invoke)\s+this\s+tool\b/gi,
  /\b(?:other|another|those)\s+(?:tools?|servers?)\s+(?:are|is)\s+(?:deprecated|broken|unsafe|insecure|malicious|compromised)\b/gi,
];

/** Another client's qualified tool name (`mcp__<server>__<tool>`). */
const QUALIFIED_TOOL = /\bmcp__[A-Za-z0-9_-]+__[A-Za-z0-9_]+/g;

/**
 * This server's own tools as the Claude Code plugin qualifies them (plugin
 * `servicenow-mcp-ai`, MCP server key `servicenow`); the subagents' `tools:`
 * allowlists name them. Excused only when the tool exists.
 */
export const PLUGIN_TOOL_PREFIX = "mcp__plugin_servicenow-mcp-ai_servicenow__";

/** A name in this server's tool namespace. */
const SERVER_TOOL = /\bservicenow_[a-z0-9_]+\b/g;

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>()[\]`{}\\]+/gi;

/** Whether `url` is on URL_ALLOWLIST (or `allowlist`); false when unparsable. */
export function urlAllowed(url, allowlist = URL_ALLOWLIST) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const where = `${host}${parsed.pathname.toLowerCase()}`;
  return allowlist.some((raw) => {
    const entry = raw.toLowerCase();
    if (entry.startsWith(".")) {
      return host === entry.slice(1) || host.endsWith(entry);
    }
    if (entry.includes("/")) {
      return where === entry || where.startsWith(`${entry}/`);
    }
    return host === entry;
  });
}

/** `U+XXXX` for each code point of `text`. */
const codePoints = (text) =>
  [...text]
    .map(
      (c) =>
        `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
    )
    .join(" ");

/** 1-based line of `index` in `text`. */
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/**
 * Every finding in one text. `knownTools` is the set of tool (and prompt)
 * names this server owns; without it the unknown-name check is skipped.
 */
export function scanText(text, source, { knownTools } = {}) {
  const findings = [];
  const add = (rule, index, match) =>
    findings.push({ rule, source, line: lineOf(text, index), match });

  for (const m of text.matchAll(INVISIBLE)) {
    add("invisible-unicode", m.index, codePoints(m[0]));
  }
  for (const m of text.matchAll(HTML_COMMENT)) {
    add("html-comment", m.index, m[0].slice(0, 120));
  }
  for (const pattern of HIDDEN_INSTRUCTION) {
    for (const m of text.matchAll(pattern)) {
      add("hidden-instruction", m.index, m[0]);
    }
  }
  for (const pattern of CROSS_TOOL_PHRASES) {
    for (const m of text.matchAll(pattern)) {
      add("cross-tool-directive", m.index, m[0]);
    }
  }
  for (const m of text.matchAll(QUALIFIED_TOOL)) {
    const own = m[0].startsWith(PLUGIN_TOOL_PREFIX)
      ? m[0].slice(PLUGIN_TOOL_PREFIX.length)
      : undefined;
    if (own && knownTools?.has(own)) continue;
    add("cross-tool-directive", m.index, m[0]);
  }
  if (knownTools) {
    for (const m of text.matchAll(SERVER_TOOL)) {
      if (!knownTools.has(m[0])) add("cross-tool-directive", m.index, m[0]);
    }
  }
  for (const m of text.matchAll(URL_PATTERN)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    if (!urlAllowed(url)) add("url-not-allowlisted", m.index, url);
  }
  return findings;
}

/** Whether ALLOWLIST (or `allowlist`) excuses `finding`. */
export function isAllowed(finding, allowlist = ALLOWLIST) {
  return allowlist.some(
    (a) =>
      a.rule === finding.rule &&
      a.source === finding.source &&
      a.match === finding.match,
  );
}

/** Scan every `{ source, text }` item; allowlisted findings are dropped. */
export function scanItems(items, options = {}) {
  const { allowlist = ALLOWLIST, ...scanOptions } = options;
  return items
    .flatMap(({ source, text }) => scanText(text, source, scanOptions))
    .filter((f) => !isAllowed(f, allowlist));
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * description-drift: tools (`{ name, description }`) whose description no
 * longer hashes to the manifest's `description_sha256`. A tool the manifest
 * does not list is the manifest snapshot test's concern, not this one.
 */
export function descriptionDrift(tools, manifest) {
  const pinned = new Map(
    (manifest?.tools ?? []).map((t) => [t.name, t.description_sha256]),
  );
  return tools
    .filter(
      (t) => pinned.has(t.name) && pinned.get(t.name) !== sha256(t.description),
    )
    .map((t) => ({
      rule: "description-drift",
      source: `tool ${t.name} description`,
      line: 1,
      match:
        "description_sha256 differs from test/fixtures/tools-manifest.json",
    }));
}

/** Every `{ source, text }` file under `dirs` (relative to `root`), sorted. */
export function collectFiles(root, dirs = FILE_ROOTS) {
  const items = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (statSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
      for (const entry of readdirSync(abs).sort()) {
        walk(path.posix.join(rel, entry));
      }
    } else if (statSync(abs, { throwIfNoEntry: false })?.isFile()) {
      items.push({ source: rel, text: readFileSync(abs, "utf8") });
    }
  };
  for (const dir of dirs) walk(dir);
  return items;
}

/** Every `title` / `description` string in a JSON Schema, with its path. */
export function schemaTexts(schema, base) {
  const out = [];
  const walk = (node, at) => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${at}[${i}]`));
    } else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (
          (key === "title" || key === "description") &&
          typeof value === "string"
        ) {
          out.push({
            source: `${base}.${at ? `${at}.` : ""}${key}`,
            text: value,
          });
        } else {
          walk(value, at ? `${at}.${key}` : key);
        }
      }
    }
  };
  walk(schema, "");
  return out;
}

/** Text content of a prompt message or a resource content entry. */
const textOf = (content) =>
  typeof content?.text === "string" ? content.text : "";

/**
 * The model-facing text a connected MCP `client` sees: instructions, tools,
 * prompts (rendered with a placeholder for every argument) and resources.
 * A resource whose read fails (it needs the instance) contributes its
 * listing only. Returns `{ items, tools }` — `tools` for the drift check.
 */
export async function collectClientSurface(client) {
  const items = [];
  const instructions = client.getInstructions?.();
  if (instructions)
    items.push({ source: "server instructions", text: instructions });

  const { tools } = await client.listTools();
  for (const tool of tools) {
    const base = `tool ${tool.name}`;
    for (const key of ["title", "description"]) {
      if (typeof tool[key] === "string")
        items.push({ source: `${base} ${key}`, text: tool[key] });
    }
    if (typeof tool.annotations?.title === "string") {
      items.push({
        source: `${base} annotations.title`,
        text: tool.annotations.title,
      });
    }
    items.push(...schemaTexts(tool.inputSchema, `${base} inputSchema`));
    if (tool.outputSchema)
      items.push(...schemaTexts(tool.outputSchema, `${base} outputSchema`));
  }

  const { prompts } = await client.listPrompts();
  for (const prompt of prompts) {
    const base = `prompt ${prompt.name}`;
    for (const key of ["title", "description"]) {
      if (typeof prompt[key] === "string")
        items.push({ source: `${base} ${key}`, text: prompt[key] });
    }
    const args = {};
    for (const arg of prompt.arguments ?? []) {
      if (arg.description)
        items.push({
          source: `${base} argument ${arg.name}`,
          text: arg.description,
        });
      args[arg.name] = "placeholder";
    }
    const rendered = await client.getPrompt({
      name: prompt.name,
      arguments: args,
    });
    rendered.messages.forEach((message, i) =>
      items.push({
        source: `${base} message ${i}`,
        text: textOf(message.content),
      }),
    );
  }

  const { resources } = await client.listResources();
  const { resourceTemplates } = await client.listResourceTemplates();
  for (const entry of [...resources, ...resourceTemplates]) {
    const base = `resource ${entry.uri ?? entry.uriTemplate}`;
    for (const key of ["name", "title", "description"]) {
      if (typeof entry[key] === "string")
        items.push({ source: `${base} ${key}`, text: entry[key] });
    }
  }
  for (const resource of resources) {
    try {
      const { contents } = await client.readResource({ uri: resource.uri });
      contents.forEach((content, i) =>
        items.push({
          source: `resource ${resource.uri} content ${i}`,
          text: textOf(content),
        }),
      );
    } catch {
      // Needs the instance: the listing above is all a client sees offline.
    }
  }
  return { items, tools };
}

/** The tool and prompt names this server owns, plus the v2 rename sources. */
export function knownToolNames(tools, prompts, manifest) {
  return new Set([
    ...tools.map((t) => t.name),
    ...prompts,
    ...(manifest?.toolRenames ?? []).flatMap((r) => [r.from, r.to]),
  ]);
}

/** One human-readable line per finding. */
export function formatFindings(findings) {
  return findings
    .map(
      (f) => `  ${f.rule}  ${f.source}:${f.line}  ${JSON.stringify(f.match)}`,
    )
    .join("\n");
}

/**
 * Build the server from the TypeScript sources with every package on, scan
 * its surface and the plugin files under `root`. Returns
 * `{ findings, counts }`.
 */
async function scanRepository(root) {
  // Deterministic: every package, no ambient credentials, quiet logs.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SN_")) delete process.env[key];
  }
  process.env.SN_TOOL_PACKAGES = "all";
  process.env.SN_LOG_LEVEL = "error";
  globalThis.fetch = () =>
    Promise.reject(new Error("scan:surface makes no network calls"));

  const { loadServerFromSource } = await import("./registry-from-source.mjs");
  const { buildMcpServer, createRuntime, installRuntime } =
    await loadServerFromSource();
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } =
    await import("@modelcontextprotocol/sdk/inMemory.js");
  const manifest = JSON.parse(
    readFileSync(path.join(root, "test/fixtures/tools-manifest.json"), "utf8"),
  );

  const runtime = createRuntime();
  installRuntime(runtime);
  const server = buildMcpServer(runtime);
  const client = new Client({ name: "scan-surface", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const { items, tools } = await collectClientSurface(client);
    const { prompts } = await client.listPrompts();
    const knownTools = knownToolNames(
      tools,
      prompts.map((p) => p.name),
      manifest,
    );
    const files = collectFiles(root);
    const findings = [
      ...scanItems([...items, ...files], { knownTools }),
      ...descriptionDrift(tools, manifest).filter((f) => !isAllowed(f)),
    ];
    return {
      findings,
      counts: { tools: tools.length, items: items.length, files: files.length },
    };
  } finally {
    await client.close();
    await server.close();
    await runtime.dispose();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  const json = process.argv.includes("--json");
  const root = path.join(import.meta.dirname, "..");
  try {
    const { findings, counts } = await scanRepository(root);
    if (json) {
      console.log(JSON.stringify({ findings, counts }, null, 2));
    } else if (findings.length === 0) {
      console.log(
        `scan:surface: clean — ${counts.tools} tools, ${counts.items} server texts, ${counts.files} plugin files`,
      );
    } else {
      console.error(
        `scan:surface: ${findings.length} finding(s):\n${formatFindings(findings)}\n` +
          "Fix the text, or excuse an intended finding in ALLOWLIST (scripts/scan-surface.mjs) with a reason.",
      );
    }
    process.exitCode = findings.length === 0 ? 0 : 1;
  } catch (err) {
    console.error(`scan:surface: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
