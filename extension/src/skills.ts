import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * N-52: the plugin's Agent Skills (`skills/sn-*`) are bundled into the
 * extension at package time (`scripts/bundle-skills.mjs`) and copied into a
 * workspace skills folder on request, so Copilot (and Codex / Cursor, which
 * read `.agents/skills/` too) can run them next to this server's tools.
 */

/** Workspace folders the supported agents read skills from (README). */
export const SKILL_TARGETS: ReadonlyArray<{
  folder: string;
  description: string;
}> = [
  {
    folder: ".agents/skills",
    description: "Copilot, Codex and Cursor",
  },
  { folder: ".github/skills", description: "Copilot" },
  { folder: ".claude/skills", description: "Copilot and Claude Code" },
];

/** The bundled skills folder, else the repository's `skills/` (dev host). */
export function skillsSource(extensionPath: string): string | undefined {
  for (const dir of [
    join(extensionPath, "skills"),
    join(extensionPath, "..", "skills"),
  ]) {
    if (listSkills(dir).length > 0) return dir;
  }
  return undefined;
}

/** The skill folders (`sn-*` with a `SKILL.md`) in `dir`, sorted. */
export function listSkills(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter(
      (name) =>
        name.startsWith("sn-") &&
        statSync(join(dir, name)).isDirectory() &&
        existsSync(join(dir, name, "SKILL.md")),
    )
    .sort();
}

export interface SkillCopyPlan {
  /** Skills not yet in the target. */
  added: string[];
  /** Skills already in the target; replaced only with `overwrite`. */
  existing: string[];
}

export function planSkillCopy(source: string, target: string): SkillCopyPlan {
  const plan: SkillCopyPlan = { added: [], existing: [] };
  for (const name of listSkills(source)) {
    (existsSync(join(target, name)) ? plan.existing : plan.added).push(name);
  }
  return plan;
}

/** Copy the skills into `target`; returns the folders written. */
export function copySkills(
  source: string,
  target: string,
  overwrite: boolean,
): string[] {
  const plan = planSkillCopy(source, target);
  const names = overwrite
    ? [...plan.added, ...plan.existing].sort()
    : plan.added;
  for (const name of names) {
    cpSync(join(source, name), join(target, name), {
      recursive: true,
      force: true,
    });
  }
  return names;
}
