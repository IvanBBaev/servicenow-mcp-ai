// N-76 (part 2) — `servicenow-mcp-ai skills install --target <agent>`: the
// bundled Agent Skills copied into an agent's skills folder.
import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCli, runCli } from "../build/cli.js";
import {
  SKILL_TARGETS,
  bundledSkillsDir,
  installSkills,
  listSkillFolders,
  targetFolder,
} from "../build/skills-install.js";

const sandbox = mkdtempSync(join(tmpdir(), "sn-cli-skills-"));
test.after(() => rmSync(sandbox, { recursive: true, force: true }));
let seq = 0;

class Sink extends Writable {
  text = "";
  _write(chunk, _enc, cb) {
    this.text += chunk;
    cb();
  }
}

/** A fresh workspace and home under the sandbox. */
function fakeIO() {
  const root = join(sandbox, `run-${++seq}`);
  const cwd = join(root, "work");
  const home = join(root, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  return {
    stdin: process.stdin,
    stdout: new Sink(),
    stderr: new Sink(),
    platform: "linux",
    env: { HOME: home },
    cwd,
  };
}

const BUNDLED = listSkillFolders(bundledSkillsDir());

test("the build carries the repository's skills", () => {
  const repo = readdirSync(join(import.meta.dirname, "..", "skills"))
    .filter((n) => n.startsWith("sn-"))
    .sort();
  assert.ok(repo.length >= 8);
  assert.deepEqual(BUNDLED, repo);
});

test("parseCli: skills takes install, --target, --global and --force", () => {
  const parsed = parseCli([
    "skills",
    "install",
    "--target",
    "gemini",
    "--global",
    "--force",
  ]);
  assert.equal(parsed.command, "skills");
  assert.deepEqual(parsed.args, ["install"]);
  assert.equal(parsed.target, "gemini");
  assert.equal(parsed.global, true);
  assert.equal(parsed.force, true);
  const doctor = parseCli(["doctor", "--target", "x"]);
  assert.equal(doctor.kind, "error");
  assert.match(doctor.message, /--target does not apply to "doctor"/);
  assert.match(
    parseCli(["skills", "install", "extra"]).message,
    /Too many arguments/,
  );
});

test("skills install: every target, workspace and global folder", async () => {
  for (const [name, target] of Object.entries(SKILL_TARGETS)) {
    for (const global of [false, true]) {
      const io = fakeIO();
      const argv = ["skills", "install", "--target", name.toUpperCase()];
      if (global) argv.push("--global");
      assert.equal(await runCli(argv, io), 0, `${name} ${global}`);
      const folder = global
        ? join(io.env.HOME, target.user)
        : join(io.cwd, target.workspace);
      assert.equal(
        folder,
        targetFolder(name, { cwd: io.cwd, home: io.env.HOME, global }),
      );
      assert.deepEqual(listSkillFolders(folder), BUNDLED);
      assert.ok(io.stdout.text.startsWith(`${target.agents}: ${folder}\n`));
      assert.equal(
        io.stdout.text.match(/^- installed /gm)?.length,
        BUNDLED.length,
      );
      assert.equal(io.stderr.text, "");
    }
  }
});

test("skills install: a skill already there is kept unless --force", async () => {
  const io = fakeIO();
  const folder = join(io.cwd, ".claude", "skills", BUNDLED[0]);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), "mine");
  const argv = ["skills", "install", "--target", "claude"];
  assert.equal(await runCli(argv, io), 0);
  assert.equal(readFileSync(join(folder, "SKILL.md"), "utf8"), "mine");
  assert.match(io.stdout.text, new RegExp(`- kept ${BUNDLED[0]} `));
  assert.match(io.stdout.text, /--force/);

  const forced = { ...io, stdout: new Sink() };
  assert.equal(await runCli([...argv, "--force"], forced), 0);
  assert.equal(
    readFileSync(join(folder, "SKILL.md"), "utf8"),
    readFileSync(join(bundledSkillsDir(), BUNDLED[0], "SKILL.md"), "utf8"),
  );
  assert.doesNotMatch(forced.stdout.text, /kept/);
});

test("skills install: usage errors exit 2 on stderr", async () => {
  const cases = [
    [["skills"], /needs a subcommand/],
    [["skills", "list"], /Unknown skills subcommand "list"/],
    [["skills", "install"], /needs --target \(agents, codex/],
    [["skills", "install", "--target", " "], /needs --target/],
    [["skills", "install", "--target", "vim"], /Unknown target "vim"/],
  ];
  for (const [argv, re] of cases) {
    const io = fakeIO();
    assert.equal(await runCli(argv, io), 2, argv.join(" "));
    assert.match(io.stderr.text, re);
    assert.match(io.stderr.text, /Usage:/);
    assert.equal(io.stdout.text, "");
  }
});

test("installSkills: dry run, an empty source and a failed copy", async () => {
  const target = join(sandbox, "dry");
  const dry = installSkills({
    source: bundledSkillsDir(),
    target,
    force: false,
    dryRun: true,
  });
  assert.deepEqual(dry.written, BUNDLED);
  assert.equal(existsSync(target), false);
  assert.deepEqual(
    installSkills({ source: join(sandbox, "none"), target, force: false }),
    { target, written: [], skipped: [] },
  );

  // A file where the target folder should be: the copy fails, exit 1.
  const io = fakeIO();
  mkdirSync(join(io.cwd, ".gemini"));
  writeFileSync(join(io.cwd, ".gemini", "skills"), "x");
  assert.equal(
    await runCli(["skills", "install", "--target", "gemini"], io),
    1,
  );
  assert.notEqual(io.stderr.text, "");
});
