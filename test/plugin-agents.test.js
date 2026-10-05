// N-47: the plugin's subagents are read-only by construction — their tool
// allowlist may name only tools this server registers with readOnlyHint, under
// the plugin's MCP prefix, so a renamed tool or a write tool fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(
  readFileSync(join(root, "test/fixtures/tools-manifest.json"), "utf8"),
);
const tools = new Map(manifest.tools.map((t) => [t.name, t]));
const plugin = JSON.parse(
  readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"),
);

// mcp__plugin_<plugin>_<server>__<tool> — how Claude Code names a plugin's
// MCP tools.
const PREFIX = `mcp__plugin_${plugin.name}_${Object.keys(plugin.mcpServers)[0]}__`;
const agentsDir = join(root, "agents");

/** A minimal frontmatter reader: `key: value` lines and `key:` + `- item` lists. */
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return undefined;
  const fields = {};
  let list;
  for (const line of m[1].split("\n")) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && list) {
      list.push(item[1].trim());
      continue;
    }
    const kv = /^([a-zA-Z-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[2].trim() === "") {
      list = [];
      fields[kv[1]] = list;
    } else {
      list = undefined;
      fields[kv[1]] = kv[2].trim();
    }
  }
  return fields;
}

const agents = existsSync(agentsDir)
  ? readdirSync(agentsDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
  : [];

test("the plugin ships the two read-only subagents", () => {
  assert.deepEqual(agents, ["sn-change-reviewer.md", "sn-investigator.md"]);
});

test("plugin.json leaves agents/ to the default scan", () => {
  // Setting `agents` in plugin.json replaces the default agents/ directory.
  assert.equal(plugin.agents, undefined);
});

for (const file of agents) {
  const text = readFileSync(join(agentsDir, file), "utf8");
  const fm = frontmatter(text);

  test(`agent ${file} has valid frontmatter`, () => {
    assert.ok(fm, "an agent needs a frontmatter block");
    assert.equal(fm.name, file.slice(0, -3));
    assert.match(fm.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(
      typeof fm.description === "string" &&
        fm.description.length > 20 &&
        fm.description.length <= 1024,
      "description should say when to use the agent",
    );
    // Plugin agents ignore these; declaring them would mislead a reader.
    for (const key of ["hooks", "mcpServers", "permissionMode"])
      assert.equal(fm[key], undefined, `${key} is ignored for plugin agents`);
    const body = text.slice(text.indexOf("\n---\n", 4) + 5).trim();
    assert.ok(body.length > 200, "an agent needs a system prompt");
  });

  test(`agent ${file} allowlists only read-only tools of this server`, () => {
    assert.ok(
      Array.isArray(fm.tools) && fm.tools.length > 0,
      "tools must be an explicit allowlist",
    );
    assert.equal(new Set(fm.tools).size, fm.tools.length, "duplicate tools");
    for (const entry of fm.tools) {
      assert.ok(entry.startsWith(PREFIX), `${entry} is not a plugin MCP tool`);
      const name = entry.slice(PREFIX.length);
      const tool = tools.get(name);
      assert.ok(tool, `${name} is not a registered tool`);
      assert.equal(
        tool.annotations?.readOnlyHint,
        true,
        `${name} is not read-only`,
      );
    }
  });

  test(`agent ${file} names only allowlisted tools in its prompt`, () => {
    const allowed = new Set(fm.tools.map((t) => t.slice(PREFIX.length)));
    const named = new Set(text.match(/\bservicenow_[a-z0-9_]+\b/g) ?? []);
    for (const name of named) {
      assert.ok(tools.has(name), `${name} is not a registered tool`);
      // A tool outside the allowlist may be named only as advice to the
      // caller (the reviewer recommends check_code_health).
      if (!allowed.has(name))
        assert.match(
          text,
          new RegExp(`\\(\`${name}\`\\)[^.]*outside your tools`),
          `${name} is named but not allowlisted`,
        );
    }
  });
}
