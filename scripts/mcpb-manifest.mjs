// N-51 / TK-27: generates mcpb/manifest.json, the manifest of the MCP bundle
// (`.mcpb`, formerly DXT) that Claude Desktop and other MCPB hosts install in
// one click. Nothing in it is hand-written:
//
//   name, version, description, author, license, links   package.json
//   user_config + server.mcp_config.env                   the E-4 settings
//                                                         manifest (secrets ->
//                                                         `sensitive: true`)
//   tools                                                 the live registry
//
// Spec: https://github.com/modelcontextprotocol/mcpb (MANIFEST.md, manifest
// version 0.3 — 0.4 only adds the Python `uv` server type).
//
// Which settings become user_config: every connection setting (instance,
// auth method, credentials, OAuth / JWT details) plus every key the MCP
// registry publishes (`registry` in the manifest, e.g. SN_TOOL_PACKAGES). The
// rest stays reachable through the env file (`SN_ENV_FILE` / the XDG file).
//
// No user_config entry carries a `default`: a host substitutes defaults into
// the env, and an explicit value would shadow the env file (for example the
// SN_OAUTH_GRANT=refresh_token that `login` writes). The server's own default
// applies instead and is quoted in the description. An optional field the
// user leaves empty reaches the server as the literal `${user_config.<key>}`
// placeholder in some hosts; loadEnv() drops such values (src/core/config.ts).
//
//   npm run mcpb:manifest               rewrite mcpb/manifest.json
//   npm run mcpb:manifest -- --check    dry run: exit 1 when it is stale
//
// test/mcpb-manifest.test.js is the guard that fails CI on drift.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";

/** The bundle manifest, relative to the repository root. */
export const MCPB_MANIFEST = "mcpb/manifest.json";

/** MCPB manifest spec version the generated manifest conforms to. */
export const MCPB_MANIFEST_VERSION = "0.3";

/** The bundle's entry point, relative to the bundle root. */
export const ENTRY_POINT = "build/index.js";

/**
 * MC-7: the Claude Desktop versions the bundle supports (semver range): the
 * release line that installs MCPB 0.3 bundles with `user_config`
 * substitution and `sensitive` (keychain) fields.
 */
export const CLAUDE_DESKTOP_RANGE = ">=0.10.0";

/** The icon file at the bundle root (copied from extension/icon.png). */
export const ICON = "icon.png";

const DISPLAY_NAME = "ServiceNow MCP";
const DOCUMENTATION = "https://ivanbbaev.github.io/servicenow-mcp-ai/";

/** Word spellings for user_config titles (anything else is lower case). */
const WORDS = {
  API: "API",
  AUD: "aud",
  ID: "ID",
  ISS: "iss",
  JWT: "JWT",
  KID: "kid",
  OAUTH: "OAuth",
  SEC: "(seconds)",
  SUB: "sub",
  URI: "URI",
};

/** Markdown -> plain text (descriptions are shown as plain text). */
export function plainText(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replaceAll("\\|", "|");
}

/** True when a setting is offered in the bundle's settings form. */
export function isBundleSetting(spec) {
  if (spec.pattern || spec.external) return false;
  return spec.section === "connection" || spec.registry !== undefined;
}

/** `SN_OAUTH_CLIENT_ID` -> `oauth_client_id` (the user_config key). */
export function userConfigKey(envKey) {
  return envKey.replace(/^SN_/, "").toLowerCase();
}

/** `SN_OAUTH_CLIENT_ID` -> `OAuth client ID` (the form label). */
export function userConfigTitle(envKey) {
  const words = envKey
    .replace(/^SN_/, "")
    .split("_")
    .map((w) => WORDS[w] ?? w.toLowerCase());
  const [first = "", ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

/** user_config `type` for a settings-manifest kind. */
export function userConfigType(kind) {
  switch (kind) {
    case "int":
      return "number";
    case "bool":
      return "boolean";
    case "path":
      return "file";
    default:
      return "string";
  }
}

function defaultNote(spec) {
  if (spec.defaultText !== undefined) {
    return ` Default: ${plainText(spec.defaultText)}.`;
  }
  if (spec.default === undefined) return "";
  const value = Array.isArray(spec.default)
    ? spec.default.join(", ")
    : String(spec.default);
  return ` Default: ${value}.`;
}

/** One user_config entry for a setting spec. */
export function userConfigEntry(spec) {
  const type = userConfigType(spec.kind);
  const entry = {
    type,
    title: userConfigTitle(spec.key),
    description: `${plainText(spec.description)}${defaultNote(spec)} (${spec.key})`,
    required: spec.registryRequired === true,
  };
  if (spec.secret) entry.sensitive = true;
  return entry;
}

/** `Name <email>` -> the MCPB author object. */
export function authorOf(pkg) {
  const author = pkg.author;
  if (author && typeof author === "object") return { ...author };
  const match = /^([^<(]+?)\s*(?:<([^>]+)>)?\s*(?:\(([^)]+)\))?$/.exec(
    String(author ?? ""),
  );
  if (!match) throw new Error("package.json has no author");
  return {
    name: match[1],
    ...(match[2] ? { email: match[2] } : {}),
    ...(match[3] ? { url: match[3] } : {}),
  };
}

function repositoryOf(pkg) {
  const repo = pkg.repository;
  if (!repo) return undefined;
  const url = typeof repo === "string" ? repo : repo.url;
  return { type: "git", url: url.replace(/^git\+/, "") };
}

/**
 * Build the MCPB manifest from package.json, the settings manifest and the
 * tool registry (ToolInfo[]: at least `name` and `title`).
 */
export function buildMcpbManifest({ pkg, settings, tools }) {
  const specs = settings.filter(isBundleSetting);
  const keys = new Map();
  for (const spec of specs) {
    const key = userConfigKey(spec.key);
    if (keys.has(key)) {
      throw new Error(
        `user_config key "${key}" is shared by ${keys.get(key)} and ${spec.key}`,
      );
    }
    keys.set(key, spec.key);
  }
  const userConfig = Object.fromEntries(
    specs.map((spec) => [userConfigKey(spec.key), userConfigEntry(spec)]),
  );
  const env = Object.fromEntries(
    specs.map((spec) => [
      spec.key,
      `\${user_config.${userConfigKey(spec.key)}}`,
    ]),
  );
  const repository = repositoryOf(pkg);
  return {
    manifest_version: MCPB_MANIFEST_VERSION,
    name: pkg.name,
    display_name: DISPLAY_NAME,
    version: pkg.version,
    description: pkg.description,
    author: authorOf(pkg),
    ...(repository ? { repository } : {}),
    homepage: pkg.homepage,
    documentation: DOCUMENTATION,
    support: pkg.bugs?.url,
    icon: ICON,
    server: {
      type: "node",
      entry_point: ENTRY_POINT,
      mcp_config: {
        command: "node",
        args: [`\${__dirname}/${ENTRY_POINT}`],
        env,
      },
    },
    tools: [...tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ name: t.name, description: t.title })),
    // MC-7: the session's tool list follows SN_TOOL_PACKAGES and
    // servicenow_enable_package, so the list above is the full catalogue, not
    // what a given session exposes; hosts ask the server (tools/list).
    tools_generated: true,
    prompts_generated: true,
    keywords: pkg.keywords ?? [],
    license: pkg.license,
    compatibility: {
      claude_desktop: CLAUDE_DESKTOP_RANGE,
      platforms: ["darwin", "win32", "linux"],
      runtimes: { node: pkg.engines.node },
    },
    user_config: userConfig,
  };
}

/**
 * The manifest as written to disk: prettier-formatted JSON (the same shape
 * `npm run format` would give it, so format:check stays green).
 */
export async function renderMcpbManifest(input, root = process.cwd()) {
  const prettier = await import("prettier");
  const file = path.join(root, MCPB_MANIFEST);
  const options = (await prettier.resolveConfig(file)) ?? {};
  return prettier.format(JSON.stringify(buildMcpbManifest(input)), {
    ...options,
    parser: "json",
  });
}

/**
 * Write (or, with `check`, only compare) mcpb/manifest.json under `root`.
 * Returns true when the file on disk was stale.
 */
export async function syncMcpbManifest({ root, check = false, ...input }) {
  const file = path.join(root, MCPB_MANIFEST);
  const next = await renderMcpbManifest(input, root);
  let current;
  try {
    current = readFileSync(file, "utf8");
  } catch {
    current = undefined;
  }
  if (current === next) return false;
  if (!check) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, next);
  }
  return true;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  const check = process.argv.includes("--check");
  const root = path.join(import.meta.dirname, "..");
  try {
    register("./ts-source-loader.mjs", import.meta.url);
    const { SETTINGS } = await import("../src/core/settings-manifest.ts");
    const { loadToolsFromSource } = await import("./registry-from-source.mjs");
    const tools = await loadToolsFromSource();
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json")));
    const stale = await syncMcpbManifest({
      root,
      check,
      pkg,
      settings: SETTINGS,
      tools,
    });
    if (!stale) {
      console.log(`mcpb:manifest: ${MCPB_MANIFEST} is current`);
    } else if (check) {
      console.error(
        `mcpb:manifest: ${MCPB_MANIFEST} drifts from package.json, the settings manifest or the tool registry\nRun: npm run mcpb:manifest`,
      );
      process.exit(1);
    } else {
      console.log(`mcpb:manifest: regenerated ${MCPB_MANIFEST}`);
    }
  } catch (err) {
    console.error(`mcpb:manifest: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
