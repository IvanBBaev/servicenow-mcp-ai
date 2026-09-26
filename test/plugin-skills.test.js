// D-8 / L4-02: plugin skills (and commands, when present) may only name tools
// the server really registers — a renamed or removed tool must fail here, not
// in a user's session.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(join(root, "test/fixtures/tools-manifest.json"), "utf8"),
);
const known = new Set(manifest.tools.map((t) => t.name));

const TOOL_NAME = /\bservicenow_[a-z0-9_]+\b/g;

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return undefined;
  const fields = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

function pluginDocs() {
  const docs = [];
  const skillsDir = join(root, "skills");
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir).sort()) {
      const file = join(skillsDir, name, "SKILL.md");
      if (existsSync(file)) docs.push({ kind: "skill", name, file });
    }
  }
  const commandsDir = join(root, "commands");
  if (existsSync(commandsDir)) {
    for (const f of readdirSync(commandsDir).sort()) {
      if (f.endsWith(".md"))
        docs.push({
          kind: "command",
          name: f.slice(0, -3),
          file: join(commandsDir, f),
        });
    }
  }
  return docs;
}

const docs = pluginDocs();

test("the plugin ships the five workflow skills", () => {
  const skills = docs.filter((d) => d.kind === "skill").map((d) => d.name);
  for (const name of [
    "sn-discover",
    "sn-triage",
    "sn-impact",
    "sn-drift",
    "sn-safe-write",
  ])
    assert.ok(skills.includes(name), `missing skill ${name}`);
});

for (const doc of docs) {
  test(`${doc.kind} ${doc.name} names only registered tools`, () => {
    const text = readFileSync(doc.file, "utf8");
    const names = [...new Set(text.match(TOOL_NAME) ?? [])];
    if (doc.kind === "skill")
      assert.ok(names.length > 0, "a skill should name at least one tool");
    const unknown = names.filter((n) => !known.has(n));
    assert.deepEqual(unknown, [], `unknown tool names in ${doc.file}`);
  });

  if (doc.kind === "skill") {
    test(`skill ${doc.name} has matching frontmatter`, () => {
      const fm = frontmatter(readFileSync(doc.file, "utf8"));
      assert.ok(fm, "SKILL.md needs a frontmatter block");
      assert.equal(fm.name, doc.name);
      assert.ok(
        fm.description && fm.description.length > 20,
        "description is required",
      );
      assert.ok(fm.description.length <= 1024, "description stays short");
    });
  }
}

test("sn-discover delegates to the native document_instance generator", () => {
  const text = readFileSync(join(root, "skills/sn-discover/SKILL.md"), "utf8");
  assert.match(text, /servicenow_document_instance/);
  assert.match(text, /depth/);
});

test("the walker rejects a made-up tool name", () => {
  assert.equal(known.has("servicenow_does_not_exist"), false);
  assert.ok(known.has("servicenow_document_instance"));
});

test("plugin.json stays consistent with package.json", () => {
  const plugin = JSON.parse(
    readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"),
  );
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(plugin.name, pkg.name);
  assert.equal(plugin.version, pkg.version);
  assert.deepEqual(plugin.mcpServers.servicenow.args, ["-y", pkg.name]);
  // The blocking PreToolUse hook waits for H-3 (owner gate O-4): no hooks yet.
  assert.equal(existsSync(join(root, "hooks/hooks.json")), false);
  assert.equal(plugin.hooks, undefined);
});
