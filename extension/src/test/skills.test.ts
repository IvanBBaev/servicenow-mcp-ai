import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  SKILL_TARGETS,
  copySkills,
  listSkills,
  planSkillCopy,
  skillsSource,
} from "../skills";

function tree(): { root: string; source: string; target: string } {
  const root = mkdtempSync(join(tmpdir(), "sn-skills-"));
  const source = join(root, "ext", "skills");
  for (const name of ["sn-triage", "sn-discover"]) {
    mkdirSync(join(source, name), { recursive: true });
    writeFileSync(join(source, name, "SKILL.md"), `# ${name}\n`);
  }
  mkdirSync(join(source, "sn-empty"));
  mkdirSync(join(source, "notes"));
  writeFileSync(join(source, "README.md"), "not a skill\n");
  return { root, source, target: join(root, "ws", ".agents", "skills") };
}

test("listSkills returns sn-* folders with a SKILL.md, sorted", () => {
  const { root, source } = tree();
  try {
    assert.deepEqual(listSkills(source), ["sn-discover", "sn-triage"]);
    assert.deepEqual(listSkills(join(root, "missing")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skillsSource prefers the bundled folder, then the repository one", () => {
  const { root } = tree();
  try {
    assert.equal(skillsSource(join(root, "ext")), join(root, "ext", "skills"));
    // Dev host: the extension folder sits next to the repository's skills/.
    assert.equal(
      skillsSource(join(root, "ext", "extension")),
      join(root, "ext", "extension", "..", "skills"),
    );
    assert.equal(skillsSource(join(root, "ws")), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copySkills adds new skills and keeps existing ones unless told to overwrite", () => {
  const { root, source, target } = tree();
  try {
    mkdirSync(join(target, "sn-triage"), { recursive: true });
    writeFileSync(join(target, "sn-triage", "SKILL.md"), "local edit\n");
    assert.deepEqual(planSkillCopy(source, target), {
      added: ["sn-discover"],
      existing: ["sn-triage"],
    });

    assert.deepEqual(copySkills(source, target, false), ["sn-discover"]);
    assert.equal(
      readFileSync(join(target, "sn-triage", "SKILL.md"), "utf8"),
      "local edit\n",
    );
    assert.equal(
      readFileSync(join(target, "sn-discover", "SKILL.md"), "utf8"),
      "# sn-discover\n",
    );

    assert.deepEqual(copySkills(source, target, true), [
      "sn-discover",
      "sn-triage",
    ]);
    assert.equal(
      readFileSync(join(target, "sn-triage", "SKILL.md"), "utf8"),
      "# sn-triage\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the default target is the folder every supported agent reads", () => {
  assert.equal(SKILL_TARGETS[0]?.folder, ".agents/skills");
});
