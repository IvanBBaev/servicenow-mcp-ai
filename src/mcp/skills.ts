import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceTemplate,
  type ServerContext,
  type ServerOptions,
} from "@modelcontextprotocol/server";
import { STATIC_RESOURCE_HINT } from "./cache-hints.js";
import { packageSessionOf } from "./packages.js";
import { logger } from "../core/logging.js";
import { IntegrationError } from "../core/errors.js";

/**
 * N-76 — the plugin's Agent Skills over MCP (SEP-2640, the
 * `io.modelcontextprotocol/skills` extension).
 *
 * `npm run build` copies `skills/sn-*` to `build/skills/` (the npm tarball,
 * the container image and the .mcpb bundle all carry build/). Each file is a
 * `skill://<name>/<path>` resource; `skills/list` and `skills/get` return
 * the skill entries (verbatim frontmatter, every file with its sha256 digest
 * and byte size). The skills ride on the `docs` package: the extension is
 * declared unless docs is denied, and the catalog is served only while docs
 * is enabled in the session (a toggle shows or hides it, the resources
 * included). The files are part of the package, so the catalog is read once.
 */

export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
export const SKILL_SCHEME = "skill:";
const SKILL_FILE = "SKILL.md";
/** SEP-2640 limits per skill. */
export const SKILL_MAX_FILES = 512;
export const SKILL_MAX_BYTES = 16 * 1024 * 1024;
/** The skills' frontmatter `name` (the Agent Skills name rule). */
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOCS = "docs";
/** skills/list freshness on the 2026-07-28 wire (the files never change). */
const LIST_CACHE = { ttlMs: 3_600_000, cacheScope: "public" } as const;

export interface SkillFile {
  uri: string;
  digest: string;
  size: number;
}

/** A SKILL.md frontmatter: `name` and `description`, then any other key. */
export type Frontmatter = Record<string, string> & {
  name: string;
  description: string;
};

export interface SkillEntry {
  uri: string;
  frontmatter: Frontmatter;
  resources: SkillFile[];
}

interface LoadedSkill {
  entry: SkillEntry;
  /** Raw bytes by URI, the same bytes the digests cover. */
  files: Map<string, Buffer>;
}

/** Default location: build/skills, next to this module's build/mcp. */
export function defaultSkillsDir(): string {
  return fileURLToPath(new URL("../skills/", import.meta.url));
}

/** A skill folder that breaks a SEP-2640 or Agent Skills rule. */
function invalidSkill(message: string): IntegrationError {
  return new IntegrationError(message, undefined, undefined, {
    code: "INVALID_INPUT",
  });
}

/** Strip one pair of matching quotes from a YAML scalar. */
function unquote(value: string): string {
  const match = /^(["'])(.*)\1$/.exec(value);
  return match ? match[2]! : value;
}

/**
 * The frontmatter of a SKILL.md as JSON. Only flat `key: scalar` lines are
 * accepted (what the skills here use); anything else throws, so the
 * listing never carries a curated subset of what the author wrote.
 */
export function parseFrontmatter(text: string, file = SKILL_FILE): Frontmatter {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") throw invalidSkill(`${file}: missing frontmatter`);
  const end = lines.indexOf("---", 1);
  if (end === -1) throw invalidSkill(`${file}: unterminated frontmatter`);
  const out: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z][\w-]*):\s+(\S.*)$/.exec(line);
    if (!match) throw invalidSkill(`${file}: unsupported frontmatter: ${line}`);
    out[match[1]!] = unquote(match[2]!.trim());
  }
  for (const key of ["name", "description"]) {
    if (!out[key]) throw invalidSkill(`${file}: frontmatter has no ${key}`);
  }
  return out as Frontmatter;
}

const digestOf = (bytes: Buffer) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Every file under `dir`, as POSIX paths relative to it, sorted. */
function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => {
      const rel = prefix ? `${prefix}/${d.name}` : d.name;
      if (d.isDirectory()) return filesUnder(path.join(dir, d.name), rel);
      return d.isFile() ? [rel] : [];
    })
    .sort();
}

function loadSkill(dir: string, name: string): LoadedSkill {
  const root = path.join(dir, name);
  const paths = filesUnder(root);
  if (!paths.includes(SKILL_FILE))
    throw invalidSkill(`${name}: no ${SKILL_FILE}`);
  if (paths.length > SKILL_MAX_FILES) {
    throw invalidSkill(
      `${name}: ${paths.length} files (limit ${SKILL_MAX_FILES})`,
    );
  }
  const files = new Map<string, Buffer>();
  const resources: SkillFile[] = [];
  let total = 0;
  for (const rel of paths) {
    const bytes = readFileSync(path.join(root, rel));
    const uri = `skill://${name}/${rel}`;
    files.set(uri, bytes);
    resources.push({ uri, digest: digestOf(bytes), size: bytes.length });
    total += bytes.length;
  }
  if (total > SKILL_MAX_BYTES) {
    throw invalidSkill(`${name}: ${total} bytes (limit ${SKILL_MAX_BYTES})`);
  }
  const uri = `skill://${name}/${SKILL_FILE}`;
  const frontmatter = parseFrontmatter(
    files.get(uri)!.toString("utf8"),
    `${name}/${SKILL_FILE}`,
  );
  // SEP-2640: the final path segment is the frontmatter name.
  if (frontmatter.name !== name || !NAME_RE.test(name)) {
    throw invalidSkill(`${name}: frontmatter name is '${frontmatter.name}'`);
  }
  return { entry: { uri, frontmatter, resources }, files };
}

/**
 * Read the skills in `dir` (one folder per skill). A skill that breaks a
 * rule is left out with a warning; a missing folder is an empty catalog.
 */
export function loadSkills(dir: string): LoadedSkill[] {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => statSync(path.join(dir, n)).isDirectory())
      .sort();
  } catch {
    // swallowed: a build without skills serves an empty catalog
    return [];
  }
  return names.flatMap((name) => {
    try {
      return [loadSkill(dir, name)];
    } catch (error) {
      logger.warn("Skill left out", {
        skill: name,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  });
}

let catalog: LoadedSkill[] | undefined;
let catalogDir: string | undefined;

/** The catalog, read once per directory. */
export function skillCatalog(dir = defaultSkillsDir()): LoadedSkill[] {
  if (!catalog || catalogDir !== dir) {
    catalog = loadSkills(dir);
    catalogDir = dir;
  }
  return catalog;
}

/** The package policy the skills follow (registry.effectivePackages()). */
export interface SkillPackages {
  enabled: readonly string[];
  denied: readonly string[];
}

/** Declare the skills extension unless the docs package is denied. */
export function withSkillsExtension(
  options: ServerOptions,
  packages: SkillPackages,
): ServerOptions {
  if (packages.denied.includes(DOCS)) return options;
  return {
    ...options,
    capabilities: {
      ...options.capabilities,
      // SEP-2640 needs the resources capability: the always-on reference
      // resources declare it when they register. Declaring it here would
      // make the SDK install its resources handlers at construction, before
      // the -32602 mapping (params-errors.ts) is in place.
      extensions: {
        ...options.capabilities?.extensions,
        [SKILLS_EXTENSION]: {},
      },
    },
  };
}

/** True while the docs package is enabled for `server`'s session. */
function skillsServed(server: McpServer, packages: SkillPackages): boolean {
  const session = packageSessionOf(server);
  return (session?.enabledPackages() ?? packages.enabled).includes(DOCS);
}

function unknownSkill(uri: string): ProtocolError {
  return new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `Not a skill this server serves: ${uri}`,
    { uri },
  );
}

const listParams = z.looseObject({ cursor: z.string().optional() }).optional();
const getParams = z.looseObject({ uri: z.string() });

/** skills/list and skills/get (no-op when docs is denied). */
export function installSkillHandlers(
  server: McpServer,
  packages: SkillPackages,
  dir = defaultSkillsDir(),
): void {
  if (packages.denied.includes(DOCS)) return;
  const entries = () =>
    skillsServed(server, packages) ? skillCatalog(dir).map((s) => s.entry) : [];
  server.server.setRequestHandler(
    "skills/list",
    { params: listParams },
    (params, ctx: ServerContext) => {
      // One page: this server never issues a cursor.
      if (params?.cursor !== undefined) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          "Invalid cursor: skills/list returns a single page.",
        );
      }
      return {
        skills: entries(),
        // SEP-2640: list-caching attributes on the 2026-07-28 wire only.
        ...(ctx.mcpReq.envelope !== undefined ? LIST_CACHE : {}),
      };
    },
  );
  server.server.setRequestHandler(
    "skills/get",
    { params: getParams },
    ({ uri }) => {
      const skill = entries().find((e) => e.uri === uri);
      if (!skill) throw unknownSkill(uri);
      return { skill };
    },
  );
}

const MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".json": "application/json",
};

/** The `skill://` resources: each SKILL.md listed, every file readable. */
export function registerSkillResources(
  server: McpServer,
  dir = defaultSkillsDir(),
): void {
  server.registerResource(
    "skills",
    new ResourceTemplate("skill://{name}/{+path}", {
      list: () => ({
        resources: skillCatalog(dir).map(({ entry }) => ({
          uri: entry.uri,
          name: entry.frontmatter.name,
          description: entry.frontmatter.description,
          mimeType: "text/markdown",
          size: entry.resources.find((r) => r.uri === entry.uri)!.size,
        })),
      }),
    }),
    {
      title: "ServiceNow Agent Skills",
      description:
        "A file of one of this server's Agent Skills (SEP-2640). URI: skill://<name>/SKILL.md; skills/list gives every file with its digest.",
      cacheHint: STATIC_RESOURCE_HINT,
    },
    (uri) => {
      const bytes = skillCatalog(dir)
        .map((s) => s.files.get(uri.href))
        .find((b) => b !== undefined);
      if (!bytes) throw unknownSkill(uri.href);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType:
              MIME[path.posix.extname(uri.pathname).toLowerCase()] ??
              "text/plain",
            text: bytes.toString("utf8"),
          },
        ],
      };
    },
  );
}
