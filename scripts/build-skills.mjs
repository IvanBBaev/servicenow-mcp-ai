// N-76: copy the plugin's Agent Skills (skills/sn-*) into build/skills, the
// folder the server serves them from as skill:// resources (src/mcp/skills.ts).
// Under build/, so the npm tarball, the container image and the .mcpb bundle
// carry them without a new top-level entry. Run by `npm run build`.
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const source = join(root, "skills");
const target = join(root, "build", "skills");
rmSync(target, { recursive: true, force: true });
const names = readdirSync(source).filter(
  (name) =>
    name.startsWith("sn-") && existsSync(join(source, name, "SKILL.md")),
);
if (names.length === 0) throw new Error(`No skills found in ${source}`);
for (const name of names) {
  cpSync(join(source, name), join(target, name), { recursive: true });
}
