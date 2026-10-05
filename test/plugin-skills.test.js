// D-8 / L4-02: plugin skills (and commands, when present) may only name tools
// the server really registers — a renamed or removed tool must fail here, not
// in a user's session.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(
  readFileSync(join(root, "test/fixtures/tools-manifest.json"), "utf8"),
);
const known = new Set(manifest.tools.map((t) => t.name));

const TOOL_NAME = /\bservicenow_[a-z0-9_]+\b/g;

/** The top-level frontmatter keys of the Agent Skills spec (agentskills.io). */
const PORTABLE_KEYS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

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

test("the plugin ships the six workflow skills", () => {
  const skills = docs.filter((d) => d.kind === "skill").map((d) => d.name);
  for (const name of [
    "sn-discover",
    "sn-triage",
    "sn-impact",
    "sn-drift",
    "sn-safe-write",
    "sn-uib",
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

    // N-52: the skills are portable Agent Skills (agentskills.io) — VS Code
    // Copilot, Codex and Cursor load the same SKILL.md, so the frontmatter
    // stays inside the open spec and the body names tools by their bare MCP
    // name, never by a Claude-Code-only `mcp__…` prefix.
    test(`skill ${doc.name} stays a portable Agent Skill`, () => {
      const text = readFileSync(doc.file, "utf8");
      const fm = frontmatter(text);
      assert.ok(fm.name.length <= 64, "name is at most 64 characters");
      assert.match(
        fm.name,
        /^[a-z0-9]+(-[a-z0-9]+)*$/,
        "name is lowercase letters, digits and single hyphens",
      );
      for (const key of Object.keys(fm))
        assert.ok(
          PORTABLE_KEYS.has(key),
          `frontmatter key "${key}" is not in the Agent Skills spec`,
        );
      assert.doesNotMatch(
        text,
        /\bmcp__/,
        "name tools without a client prefix",
      );
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
  // D-8 / N-48: the hooks ship at the default location, hooks/hooks.json
  // (auto-discovered from the plugin root; test/plugin-hook*.test.js cover it).
  assert.equal(existsSync(join(root, "hooks/hooks.json")), true);
  assert.equal(plugin.hooks, undefined);
});
