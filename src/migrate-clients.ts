import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { planEnv, type MigrationChange } from "./migrate.js";

/**
 * `servicenow-mcp-ai migrate`, part two (owner, 2026-10-14): 2.x settings set
 * in an MCP client's `env` block (Claude Desktop, Claude Code, Cursor, VS
 * Code, Windsurf) reach the server as process environment, which wins over
 * the env file — so they are migrated where they are, with the same rules as
 * the env file (reserved profiles, values 3.x refuses, SN_COMPAT=2). A file
 * that is not plain JSON (VS Code allows comments) is only reported.
 */

export interface ClientConfigFile {
  client: string;
  path: string;
}

/** The MCP client config files `migrate` looks at (they may not exist). */
export function clientConfigFiles(options: {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): ClientConfigFile[] {
  const { platform, home, env, cwd } = options;
  const appData =
    platform === "darwin"
      ? join(home, "Library", "Application Support")
      : platform === "win32"
        ? env.APPDATA?.trim() || join(home, "AppData", "Roaming")
        : env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  const files: ClientConfigFile[] = [
    {
      client: "Claude Desktop",
      path: join(appData, "Claude", "claude_desktop_config.json"),
    },
    { client: "Claude Code", path: join(home, ".claude.json") },
    { client: "Claude Code (project)", path: join(cwd, ".mcp.json") },
    { client: "Cursor", path: join(home, ".cursor", "mcp.json") },
    { client: "Cursor (project)", path: join(cwd, ".cursor", "mcp.json") },
    { client: "VS Code", path: join(appData, "Code", "User", "mcp.json") },
    { client: "VS Code (workspace)", path: join(cwd, ".vscode", "mcp.json") },
    {
      client: "Windsurf",
      path: join(home, ".codeium", "windsurf", "mcp_config.json"),
    },
  ];
  // The project files are the user-level ones when run from the home folder.
  const seen = new Set<string>();
  return files.filter((f) => !seen.has(f.path) && seen.add(f.path));
}

export interface ClientServerPlan {
  /** Where the entry sits, e.g. `mcpServers.servicenow`. */
  entry: string;
  changes: MigrationChange[];
  /** A VS Code `envFile` the entry loads: migrate it with `--from`. */
  envFile?: string;
}

export interface ClientFilePlan extends ClientConfigFile {
  servers: ClientServerPlan[];
  /** The rewritten file; undefined when it is not plain JSON (report only). */
  text?: string;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An entry that launches this server (npx, a global bin or a local build). */
function isServiceNowServer(entry: Json): boolean {
  const args: unknown[] = Array.isArray(entry.args) ? entry.args : [];
  return /servicenow-mcp/i.test(
    [entry.command, ...args].filter((v) => typeof v === "string").join(" "),
  );
}

/** Every `mcpServers` / `servers` map: top level, and Claude Code's `projects.*`. */
function serverMaps(root: Json): { at: string; map: Json }[] {
  const maps: { at: string; map: Json }[] = [];
  const collect = (node: Json, at: string): void => {
    for (const key of ["mcpServers", "servers"]) {
      const map = node[key];
      if (isObject(map)) maps.push({ at: `${at}${key}`, map });
    }
  };
  collect(root, "");
  if (isObject(root.projects)) {
    for (const [project, node] of Object.entries(root.projects)) {
      if (isObject(node))
        collect(node, `projects[${JSON.stringify(project)}].`);
    }
  }
  return maps;
}

/** Migrate one entry's `env` in place; returns its changes. */
function migrateEntry(
  entry: Json,
  v3Defaults: boolean | undefined,
): { changes: MigrationChange[]; envFile?: string } {
  const envFile = typeof entry.envFile === "string" ? entry.envFile : undefined;
  if (!isObject(entry.env)) return { changes: [], envFile };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry.env)) {
    if (typeof value === "string") env[key] = value;
  }
  // An entry with no SN_ setting of its own takes them all from the env file.
  if (!Object.keys(env).some((key) => key.startsWith("SN_"))) {
    return { changes: [], envFile };
  }
  const plan = planEnv(env, { v3Defaults, removal: "removed" });
  const next: Json = {};
  for (const [key, value] of Object.entries(entry.env)) {
    const to = plan.keyFor(key);
    if (plan.invalid.has(to)) continue;
    next[to] =
      to === "SN_ACTIVE_PROFILE" && plan.activeTo ? plan.activeTo : value;
  }
  if (plan.compat) next.SN_COMPAT = "2";
  entry.env = next;
  return { changes: plan.changes, envFile };
}

/** Plan the migration of one client config file `text` (pure). */
export function planClientFile(
  file: ClientConfigFile,
  text: string,
  v3Defaults?: boolean,
): ClientFilePlan {
  let root: unknown;
  let plainJson = true;
  try {
    root = JSON.parse(text);
  } catch {
    // swallowed: not plain JSON; the JSONC retry below decides
    plainJson = false;
    // JSONC (comments, trailing commas): parse a stripped copy to report.
    try {
      root = JSON.parse(stripJsonc(text));
    } catch {
      // swallowed: not JSON at all; the file is reported with no servers
      return { ...file, servers: [] };
    }
  }
  if (!isObject(root)) return { ...file, servers: [] };
  const servers: ClientServerPlan[] = [];
  for (const { at, map } of serverMaps(root)) {
    for (const [name, entry] of Object.entries(map)) {
      if (!isObject(entry) || !isServiceNowServer(entry)) continue;
      const { changes, envFile } = migrateEntry(entry, v3Defaults);
      if (changes.length || envFile) {
        servers.push({
          entry: `${at}.${name}`,
          changes,
          ...(envFile ? { envFile } : {}),
        });
      }
    }
  }
  const changed = servers.some((s) => s.changes.length);
  const indent = /^[{[]\r?\n([ \t]+)/.exec(text)?.[1] ?? "  ";
  return {
    ...file,
    servers,
    ...(plainJson && changed
      ? {
          text: `${JSON.stringify(root, null, indent)}${text.endsWith("\n") ? "\n" : ""}`,
        }
      : {}),
  };
}

/** Drop `//` and block comments and trailing commas outside strings. */
function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = i;
      const m = end.exec(text);
      const s = m ? m[0] : text.slice(i);
      out += s;
      i += s.length - 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 1;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Read and plan every existing client config file. */
export function planClientFiles(
  files: ClientConfigFile[],
  v3Defaults?: boolean,
): ClientFilePlan[] {
  const plans: ClientFilePlan[] = [];
  for (const file of files) {
    if (!existsSync(file.path)) continue;
    let text: string;
    try {
      text = readFileSync(file.path, "utf8");
    } catch {
      // swallowed: an unreadable client file is skipped, not migrated
      continue;
    }
    const plan = planClientFile(file, text, v3Defaults);
    if (plan.servers.length) plans.push(plan);
  }
  return plans;
}

/**
 * Write a client file plan: the file is first backed up as `<file>.v2.bak`
 * (0600, kept if one is already there: it holds the 2.x original), then
 * replaced atomically with its own mode.
 * Returns the backup path.
 */
export function writeClientFile(plan: ClientFilePlan): string {
  if (plan.text === undefined) {
    throw new Error(`${plan.path} is not plain JSON — edit it by hand.`);
  }
  const backup = `${plan.path}.v2.bak`;
  const mode = statSync(plan.path).mode & 0o777;
  if (!existsSync(backup)) {
    copyFileSync(plan.path, backup);
    chmodSync(backup, 0o600);
  }
  const tmp = `${plan.path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, plan.text, { mode });
  renameSync(tmp, plan.path);
  chmodSync(plan.path, mode);
  return backup;
}
