import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * N-76 — `servicenow-mcp-ai skills install --target <agent>`: copy the
 * Agent Skills the package carries (build/skills, N-76 part 1) into the
 * folder an agent reads skills from, in the workspace (the current
 * directory) or, with `--global`, in the user's home. The same skills are
 * served over MCP (SEP-2640) to a client that reads them there.
 */

export interface SkillTarget {
  /** Folder relative to the workspace. */
  workspace: string;
  /** Folder relative to the home directory (`--global`). */
  user: string;
  /** Who reads it. */
  agents: string;
}

/** The skills folders of the supported agents (their docs, 2026-10). */
export const SKILL_TARGETS = {
  agents: {
    workspace: ".agents/skills",
    user: ".agents/skills",
    agents: "Codex, Cursor, Gemini CLI and Copilot",
  },
  codex: {
    workspace: ".agents/skills",
    user: ".agents/skills",
    agents: "Codex",
  },
  cursor: {
    workspace: ".cursor/skills",
    user: ".cursor/skills",
    agents: "Cursor",
  },
  gemini: {
    workspace: ".gemini/skills",
    user: ".gemini/skills",
    agents: "Gemini CLI",
  },
  claude: {
    workspace: ".claude/skills",
    user: ".claude/skills",
    agents: "Claude Code",
  },
  copilot: {
    workspace: ".github/skills",
    user: ".copilot/skills",
    agents: "GitHub Copilot",
  },
} as const satisfies Record<string, SkillTarget>;

export type SkillTargetName = keyof typeof SKILL_TARGETS;

export function isSkillTarget(name: string): name is SkillTargetName {
  return Object.hasOwn(SKILL_TARGETS, name);
}

/** build/skills, next to this module's build/skills-install.js. */
export function bundledSkillsDir(): string {
  return fileURLToPath(new URL("./skills/", import.meta.url));
}

/** The skill folders (`sn-*` with a SKILL.md) in `dir`, sorted. */
export function listSkillFolders(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // swallowed: no folder is no skills
    return [];
  }
  return names
    .filter(
      (name) =>
        name.startsWith("sn-") &&
        statSync(join(dir, name)).isDirectory() &&
        existsSync(join(dir, name, "SKILL.md")),
    )
    .sort();
}

export interface SkillInstallResult {
  target: string;
  /** Skills written (new, or replaced under `force`). */
  written: string[];
  /** Skills already in the target and left alone (no `force`). */
  skipped: string[];
}

/**
 * Copy every skill in `source` to `target`. A skill already there is kept
 * unless `force`; `dryRun` only reports what would be written.
 */
export function installSkills(options: {
  source: string;
  target: string;
  force: boolean;
  dryRun?: boolean;
}): SkillInstallResult {
  const result: SkillInstallResult = {
    target: options.target,
    written: [],
    skipped: [],
  };
  for (const name of listSkillFolders(options.source)) {
    const to = join(options.target, name);
    if (existsSync(to) && !options.force) {
      result.skipped.push(name);
      continue;
    }
    if (!options.dryRun) {
      cpSync(join(options.source, name), to, { recursive: true, force: true });
    }
    result.written.push(name);
  }
  return result;
}

/** The folder a target resolves to for `cwd` or (global) `home`. */
export function targetFolder(
  name: SkillTargetName,
  where: { cwd: string; home: string; global: boolean },
): string {
  const target = SKILL_TARGETS[name];
  return where.global
    ? resolve(where.home, target.user)
    : resolve(where.cwd, target.workspace);
}
