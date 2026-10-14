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
  NESTED_NAME,
  OUTPUT_DIR,
  ROOT_OUTPUT,
  ROOT_SOURCE,
  SOURCE_DIR,
  parseSource,
  render,
  renderNested,
  renderRoot,
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
    "bad nested value":
      '---\napplyTo:\n  - "src/**"\nnested: yes\n---\n\nbody\n',
    "nested without a dir glob":
      '---\napplyTo:\n  - "src/*.ts"\nnested: true\n---\n\nbody\n',
    "nested under a dot dir":
      '---\napplyTo:\n  - ".github/workflows/**"\nnested: true\n---\n\nbody\n',
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

test("N-43: the Copilot file is AGENTS.md under a generated banner", () => {
  const agents = readFileSync(path.join(root, ROOT_SOURCE), "utf8");
  const copilot = readFileSync(path.join(root, ROOT_OUTPUT), "utf8");
  assert.equal(copilot, renderRoot(agents));
  assert.match(copilot, /^<!-- Generated from AGENTS\.md /);
  assert.ok(copilot.endsWith(agents.trim() + "\n"));
});

test("N-43: AGENTS.md quotes the live tool and package counts", async () => {
  const { describeAllTools } = await import("../build/mcp/registry.js");
  const tools = describeAllTools();
  const packages = new Set(tools.map((t) => t.package)).size;
  const agents = readFileSync(path.join(root, ROOT_SOURCE), "utf8");
  assert.match(
    agents,
    new RegExp(`\\b${tools.length} tools in ${packages} packages\\b`),
  );
});

test("N-43: AGENTS.md drift is reported, written and then clean", () => {
  const dir = scratch();
  try {
    syncInstructions({ root: dir });
    assert.deepEqual(syncInstructions({ root: dir, check: true }), []);

    writeFileSync(path.join(dir, ROOT_SOURCE), "# Agents\n\n- rule\n");
    assert.deepEqual(syncInstructions({ root: dir, check: true }), [
      ROOT_OUTPUT,
    ]);
    assert.equal(existsSync(path.join(dir, ROOT_OUTPUT)), false);
    assert.deepEqual(syncInstructions({ root: dir }), [ROOT_OUTPUT]);
    assert.equal(
      readFileSync(path.join(dir, ROOT_OUTPUT), "utf8"),
      renderRoot("# Agents\n\n- rule\n"),
    );
    assert.deepEqual(syncInstructions({ root: dir, check: true }), []);

    writeFileSync(path.join(dir, ROOT_SOURCE), "\n");
    assert.throws(() => syncInstructions({ root: dir }), /AGENTS\.md: empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const NESTED = SAMPLE.replace("---\n\n#", "nested: true\n---\n\n#");

test("N-46b: the opted-in areas have a nested AGENTS.md, the rest none", () => {
  const nested = new Set(
    [
      "src/api",
      "src/core",
      "src/mcp",
      "src/tools",
      "test",
      "scripts",
      "extension",
    ].map((dir) => `${dir}/${NESTED_NAME}`),
  );
  for (const rel of nested) assert.ok(existsSync(path.join(root, rel)), rel);
  for (const dir of ["docs", ".github/workflows", "skills"])
    assert.equal(existsSync(path.join(root, dir, NESTED_NAME)), false, dir);
  const ignore = readFileSync(
    path.join(root, "extension/.vscodeignore"),
    "utf8",
  );
  assert.match(ignore, /^AGENTS\.md$/m, "the .vsix never ships it");
});

test("N-46b: parseSource takes the nested dir from the first glob", () => {
  assert.equal(parseSource(SAMPLE).nestedDir, undefined);
  const parsed = parseSource(NESTED);
  assert.equal(parsed.nestedDir, "src/api");
  const text = renderNested("api", parsed);
  assert.match(
    text,
    /^<!-- Generated from \.github\/agent-instructions\/api\.md /,
  );
  assert.ok(text.endsWith("# Title\n\n- rule\n"));
});

test("N-46b: nested files are written, kept in sync and removed when stale", () => {
  const dir = scratch({ api: NESTED });
  const nested = `src/api/${NESTED_NAME}`;
  try {
    const first = syncInstructions({ root: dir, check: true });
    assert.ok(first.includes(nested));
    assert.equal(
      existsSync(path.join(dir, nested)),
      false,
      "check never writes",
    );
    syncInstructions({ root: dir });
    assert.equal(
      readFileSync(path.join(dir, nested), "utf8"),
      renderNested("api", parseSource(NESTED)),
    );
    assert.deepEqual(syncInstructions({ root: dir, check: true }), []);

    writeFileSync(
      path.join(dir, nested),
      "<!-- Generated from .github/agent-instructions/api.md -->\nedit\n",
    );
    assert.deepEqual(syncInstructions({ root: dir, check: true }), [nested]);
    syncInstructions({ root: dir });

    // The source drops the opt-in: the generated file is stale and removed;
    // a hand-written AGENTS.md elsewhere is left alone.
    writeFileSync(path.join(dir, SOURCE_DIR, "api.md"), SAMPLE);
    mkdirSync(path.join(dir, "src/other"), { recursive: true });
    writeFileSync(path.join(dir, "src/other", NESTED_NAME), "# mine\n");
    assert.deepEqual(syncInstructions({ root: dir, check: true }), [nested]);
    syncInstructions({ root: dir });
    assert.equal(existsSync(path.join(dir, nested)), false);
    assert.equal(existsSync(path.join(dir, "src/other", NESTED_NAME)), true);
    assert.deepEqual(syncInstructions({ root: dir, check: true }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("N-46b: a hand-written file or a second area on the same dir throws", () => {
  const handWritten = scratch({ api: NESTED });
  const twice = scratch({ api: NESTED, core: NESTED });
  try {
    writeFileSync(path.join(handWritten, "src/api", NESTED_NAME), "# mine\n");
    assert.throws(
      () => syncInstructions({ root: handWritten, check: true }),
      /src\/api\/AGENTS\.md: hand-written file/,
    );
    assert.throws(
      () => syncInstructions({ root: twice, check: true }),
      /already rendered by another area/,
    );
  } finally {
    for (const d of [handWritten, twice])
      rmSync(d, { recursive: true, force: true });
  }
});
