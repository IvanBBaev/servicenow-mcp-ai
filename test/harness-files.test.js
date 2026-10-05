// N-45 / TK-21: assistant harness files are local to each contributor and never
// tracked. A tracked settings file once shipped permissions that let an agent
// stage and commit without asking; this guard keeps that from coming back.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

const HARNESS = [
  /^CLAUDE\.md$/,
  /^CLAUDE\.local\.md$/,
  /^WORKLOG\.md$/,
  /^\.claude\//,
  /^docs\/ai\//,
];

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
    const tracked = files.filter((f) => HARNESS.some((re) => re.test(f)));
    assert.deepEqual(
      tracked,
      [],
      `harness files must stay untracked: ${tracked.join(", ")}`,
    );
  },
);
