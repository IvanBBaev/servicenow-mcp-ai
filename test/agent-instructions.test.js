// N-46: the path-scoped agent instructions in .github/instructions/ are
// generated from .github/agent-instructions/ — this is the guard that fails CI
// when they drift, plus the generator's own behaviour on a scratch tree.
import test from "node:test";
import assert from "node:assert/strict";
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
import path from "node:path";

import {
  OUTPUT_DIR,
  SOURCE_DIR,
  parseSource,
  render,
  staticPrefix,
  syncInstructions,
} from "../scripts/agent-instructions.mjs";

const root = path.resolve(import.meta.dirname, "..");

const SAMPLE = `---
applyTo:
  - "src/api/**"
  - 'src/*.ts'
---

# Title

- rule
`;

/** A scratch repo with one source and the paths its globs name. */
function scratch(sources = { api: SAMPLE }) {
  const dir = mkdtempSync(path.join(tmpdir(), "sn-agent-instr-"));
  mkdirSync(path.join(dir, "src/api"), { recursive: true });
  mkdirSync(path.join(dir, SOURCE_DIR), { recursive: true });
  for (const [area, text] of Object.entries(sources))
    writeFileSync(path.join(dir, SOURCE_DIR, `${area}.md`), text);
  return dir;
}

test("N-46: the generated instructions match their sources", () => {
  assert.deepEqual(syncInstructions({ root, check: true }), []);
});

test("N-46: every live file uses the Copilot applyTo frontmatter", () => {
  const files = readdirSync(path.join(root, OUTPUT_DIR));
  assert.ok(files.length >= 8, "one file per area");
  for (const name of files) {
    assert.match(name, /\.instructions\.md$/);
    const text = readFileSync(path.join(root, OUTPUT_DIR, name), "utf8");
    assert.match(text, /^---\napplyTo: "[^"\n]+"\n---\n/, name);
  }
});

test("N-46: parseSource reads applyTo, excludeAgent and the body", () => {
  const parsed = parseSource(SAMPLE);
  assert.deepEqual(parsed.applyTo, ["src/api/**", "src/*.ts"]);
  assert.equal(parsed.excludeAgent, undefined);
  assert.equal(parsed.body, "# Title\n\n- rule");

  const withExclude = parseSource(
    SAMPLE.replace("---\n\n#", 'excludeAgent: "code-review"\n---\n\n#'),
  );
  assert.equal(withExclude.excludeAgent, "code-review");
  assert.match(render("api", withExclude), /\nexcludeAgent: "code-review"\n/);
});

test("N-46: parseSource rejects malformed sources", () => {
  const cases = {
    "no frontmatter": "# Title\n",
    unterminated: "---\napplyTo:\n",
    "no globs": "---\napplyTo:\n---\n\nbody\n",
    "stray item": '---\n  - "src/**"\n---\n\nbody\n',
    "unknown key": '---\napplyTo:\n  - "src/**"\nfoo: bar\n---\n\nbody\n',
    "bad excludeAgent":
      '---\napplyTo:\n  - "src/**"\nexcludeAgent: "all"\n---\n\nbody\n',
    "unparsable line": '---\napplyTo:\n  - "src/**"\n???\n---\n\nbody\n',
    "comma glob": '---\napplyTo:\n  - "a/**,b/**"\n---\n\nbody\n',
    "absolute glob": '---\napplyTo:\n  - "/src/**"\n---\n\nbody\n',
    "empty body": '---\napplyTo:\n  - "src/**"\n---\n\n',
  };
  for (const [name, text] of Object.entries(cases))
    assert.throws(() => parseSource(text, "x.md"), /^Error: x\.md: /, name);
});

test("N-46: staticPrefix keeps the literal path before a wildcard", () => {
  assert.equal(staticPrefix("src/api/**"), "src/api/");
  assert.equal(staticPrefix("src/*.ts"), "src/");
  assert.equal(staticPrefix("**/*.ts"), "");
  assert.equal(staticPrefix("README.md"), "README.md");
});

test("N-46: render joins the globs and stamps the source", () => {
  const text = render("api", parseSource(SAMPLE));
  assert.ok(text.startsWith('---\napplyTo: "src/api/**,src/*.ts"\n---\n\n'));
  assert.match(text, /Generated from \.github\/agent-instructions\/api\.md/);
  assert.ok(text.endsWith("# Title\n\n- rule\n"));
});

test("N-46: check reports drift, a write fixes it and removes stale files", () => {
  const dir = scratch();
  try {
    const out = path.join(dir, OUTPUT_DIR);
    const expected = [`${OUTPUT_DIR}/api.instructions.md`];
    assert.deepEqual(syncInstructions({ root: dir, check: true }), expected);
    assert.equal(existsSync(out), false, "check never writes");

    assert.deepEqual(syncInstructions({ root: dir }), expected);
    assert.deepEqual(syncInstructions({ root: dir, check: true }), []);

    writeFileSync(path.join(out, "gone.instructions.md"), "stale");
    writeFileSync(path.join(out, "notes.md"), "not ours");
    writeFileSync(path.join(out, "api.instructions.md"), "hand edit");
    const drift = [
      `${OUTPUT_DIR}/api.instructions.md`,
      `${OUTPUT_DIR}/gone.instructions.md`,
    ];
    assert.deepEqual(syncInstructions({ root: dir, check: true }), drift);
    assert.deepEqual(syncInstructions({ root: dir }), drift);
    assert.equal(existsSync(path.join(out, "gone.instructions.md")), false);
    assert.equal(existsSync(path.join(out, "notes.md")), true);
    assert.deepEqual(syncInstructions({ root: dir, check: true }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("N-46: a glob over a missing path or a bad area name throws", () => {
  const moved = scratch({ api: SAMPLE.replace("src/api/**", "src/gone/**") });
  const badName = scratch({ API_Area: SAMPLE });
  const empty = scratch({});
  try {
    assert.throws(
      () => syncInstructions({ root: moved, check: true }),
      /"src\/gone\/\*\*" matches nothing/,
    );
    assert.throws(
      () => syncInstructions({ root: badName, check: true }),
      /area name must match/,
    );
    assert.throws(
      () => syncInstructions({ root: empty, check: true }),
      /no sources/,
    );
  } finally {
    for (const dir of [moved, badName, empty])
      rmSync(dir, { recursive: true, force: true });
  }
});
