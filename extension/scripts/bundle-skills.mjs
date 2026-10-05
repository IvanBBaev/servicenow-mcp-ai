// N-52: copy the plugin's Agent Skills (../skills/sn-*) into the extension
// package before `vsce package`, for the "Add Agent Skills to Workspace"
// command. The copy is a build output (the root .gitignore).
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const source = join(import.meta.dirname, "..", "..", "skills");
const target = join(import.meta.dirname, "..", "skills");
rmSync(target, { recursive: true, force: true });
const names = readdirSync(source).filter(
  (name) =>
    name.startsWith("sn-") && existsSync(join(source, name, "SKILL.md")),
);
if (names.length === 0) throw new Error(`No skills found in ${source}`);
for (const name of names) {
  cpSync(join(source, name), join(target, name), { recursive: true });
}
console.log(`bundle-skills: ${names.length} skills -> extension/skills/`);
