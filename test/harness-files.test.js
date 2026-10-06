// N-45 / TK-21: assistant harness files are local to each contributor and never
// tracked. A tracked settings file once shipped permissions that let an agent
// stage and commit without asking; this guard keeps that from coming back.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

// CLAUDE.md / CLAUDE.local.md are flagged at any depth: a nested memory file
// (packages/x/CLAUDE.md, extension/CLAUDE.md) is just as local as the root one.
const HARNESS = [
  /(^|\/)CLAUDE(\.local)?\.md$/,
  /^WORKLOG\.md$/,
  /^\.claude\//,
  /^docs\/ai\//,
];

const isHarness = (file) => HARNESS.some((re) => re.test(file));

test("the harness patterns match nested memory files, not look-alikes", () => {
  for (const file of [
    "CLAUDE.md",
    "CLAUDE.local.md",
    "extension/CLAUDE.md",
    "src/api/CLAUDE.local.md",
    "WORKLOG.md",
    ".claude/settings.json",
    "docs/ai/HANDOFF.md",
  ]) {
    assert.ok(isHarness(file), `${file} should be flagged`);
  }
  for (const file of [
    "MY-CLAUDE.md",
    "docs/CLAUDE.md.txt",
    "skills/sn-uib/SKILL.md",
    "src/WORKLOG.md",
  ]) {
    assert.ok(!isHarness(file), `${file} should not be flagged`);
  }
});

function trackedFiles() {
  try {
    return execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

test(
  "no assistant harness file is tracked",
  { skip: !existsSync(join(root, ".git")) && "not a git checkout" },
  () => {
    const files = trackedFiles();
    if (!files) return;
    const tracked = files.filter(isHarness);
    assert.deepEqual(
      tracked,
      [],
      `harness files must stay untracked: ${tracked.join(", ")}`,
    );
  },
);
