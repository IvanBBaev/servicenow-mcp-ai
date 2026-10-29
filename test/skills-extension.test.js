// N-76 — the Agent Skills over MCP (SEP-2640): skill:// resources, the
// io.modelcontextprotocol/skills extension, skills/list and skills/get, all
// riding on the docs package.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as z from "zod";

import { buildMcpServer } from "../build/server.js";
import {
  SKILLS_EXTENSION,
  SKILL_MAX_FILES,
  defaultSkillsDir,
  loadSkills,
  parseFrontmatter,
} from "../build/mcp/skills.js";
import { currentRuntime } from "../build/core/runtime.js";
import { baselineEnv, freshRuntime, withEnv } from "./helpers.js";

baselineEnv();
test.beforeEach(() => {
  freshRuntime();
});

const DOCS_ON = { SN_TOOL_PACKAGES: "table,docs" };
const ANY = z.looseObject({});
const REPO_SKILLS = path.join(import.meta.dirname, "..", "skills");

async function connect() {
  const server = buildMcpServer(currentRuntime());
  const client = new Client({ name: "skills", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function withClient(env, fn) {
  await withEnv(env, async () => {
    const { client, close } = await connect();
    try {
      await fn(client);
    } finally {
      await close();
    }
  });
}

test("parseFrontmatter: flat scalars, quotes stripped, name and description required", () => {
  assert.deepEqual(
    parseFrontmatter(
      "---\nname: a-b\ndescription: 'Do it'\nlicense: MIT\n---\n# x",
    ),
    { name: "a-b", description: "Do it", license: "MIT" },
  );
  assert.deepEqual(
    parseFrontmatter(
      '---\r\n# c\r\n\r\nname: a\r\ndescription: "d"\r\n---\r\n',
    ),
    { name: "a", description: "d" },
  );
  assert.throws(() => parseFrontmatter("# none"), /missing frontmatter/);
  assert.throws(() => parseFrontmatter("---\nname: a\n"), /unterminated/);
  assert.throws(
    () => parseFrontmatter("---\nname: a\nmetadata:\n  v: 1\n---\n"),
    /unsupported frontmatter/,
  );
  assert.throws(
    () => parseFrontmatter("---\nname: a\n---\n"),
    /has no description/,
  );
});

test("the build carries every skill of the repository, digests over the raw bytes", async () => {
  const repo = (await fs.readdir(REPO_SKILLS)).filter((n) =>
    n.startsWith("sn-"),
  );
  const skills = loadSkills(defaultSkillsDir());
  assert.deepEqual(
    skills.map((s) => s.entry.frontmatter.name),
    repo.sort(),
  );
  for (const { entry } of skills) {
    const name = entry.frontmatter.name;
    assert.equal(entry.uri, `skill://${name}/SKILL.md`);
    const bytes = await fs.readFile(path.join(REPO_SKILLS, name, "SKILL.md"));
    assert.deepEqual(entry.resources, [
      {
        uri: entry.uri,
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        size: bytes.length,
      },
    ]);
  }
});

test("loadSkills leaves out a skill that breaks a rule; no folder is no skills", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sn-skills-"));
  try {
    const write = async (rel, text) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), text);
    };
    const md = (name) => `---\nname: ${name}\ndescription: d\n---\n`;
    await write("good/SKILL.md", md("good"));
    await write("good/refs/a.md", "# a");
    await write("renamed/SKILL.md", md("other"));
    await write("empty/notes.md", "x");
    await write("Bad_Name/SKILL.md", md("Bad_Name"));
    await write("many/SKILL.md", md("many"));
    for (let i = 0; i < SKILL_MAX_FILES; i += 1) {
      await write(`many/f/${i}.md`, "x");
    }
    await fs.writeFile(path.join(dir, "loose.md"), "not a skill folder");
    const skills = loadSkills(dir);
    assert.deepEqual(
      skills.map((s) => s.entry.resources.map((r) => r.uri)),
      [["skill://good/SKILL.md", "skill://good/refs/a.md"]],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  assert.deepEqual(loadSkills(path.join(dir, "gone")), []);
});

test("docs on: the extension, skills/list, skills/get and skill:// reads agree", async () => {
  await withClient(DOCS_ON, async (client) => {
    const caps = client.getServerCapabilities();
    assert.deepEqual(caps.extensions?.[SKILLS_EXTENSION], {});
    assert.ok(caps.resources);

    const { skills } = await client.request(
      { method: "skills/list", params: {} },
      ANY,
    );
    assert.ok(skills.length >= 8);
    // The legacy wire carries no list-caching attributes.
    const listed = await client.request(
      { method: "skills/list", params: {} },
      ANY,
    );
    assert.equal(listed.ttlMs, undefined);

    const triage = skills.find((s) => s.frontmatter.name === "sn-triage");
    const { skill } = await client.request(
      { method: "skills/get", params: { uri: triage.uri } },
      ANY,
    );
    assert.deepEqual(skill, triage);

    const { contents } = await client.readResource({ uri: triage.uri });
    assert.equal(contents[0].mimeType, "text/markdown");
    const bytes = Buffer.from(contents[0].text, "utf8");
    assert.equal(bytes.length, triage.resources[0].size);
    assert.equal(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      triage.resources[0].digest,
    );

    const listedResources = (await client.listResources()).resources.filter(
      (r) => r.uri.startsWith("skill://"),
    );
    assert.equal(listedResources.length, skills.length);
    const entry = listedResources.find((r) => r.uri === triage.uri);
    assert.equal(entry.name, "sn-triage");
    assert.equal(entry.description, triage.frontmatter.description);
    assert.equal(entry.size, triage.resources[0].size);

    await assert.rejects(
      client.request(
        { method: "skills/get", params: { uri: "skill://nope/SKILL.md" } },
        ANY,
      ),
      (e) => e.code === -32602,
    );
    await assert.rejects(
      client.readResource({ uri: "skill://nope/SKILL.md" }),
      (e) => e.code === -32602,
    );
    await assert.rejects(
      client.request({ method: "skills/list", params: { cursor: "x" } }, ANY),
      (e) => e.code === -32602 && /single page/.test(e.message),
    );
  });
});

test("docs off: the extension is declared but serves nothing until docs is enabled", async () => {
  await withClient({ SN_TOOL_PACKAGES: "table" }, async (client) => {
    assert.ok(client.getServerCapabilities().extensions?.[SKILLS_EXTENSION]);
    const empty = await client.request(
      { method: "skills/list", params: {} },
      ANY,
    );
    assert.deepEqual(empty.skills, []);
    assert.ok(
      !(await client.listResources()).resources.some((r) =>
        r.uri.startsWith("skill://"),
      ),
    );

    await client.callTool({
      name: "servicenow_enable_package",
      arguments: { name: "docs" },
    });
    const after = await client.request(
      { method: "skills/list", params: {} },
      ANY,
    );
    assert.ok(after.skills.length >= 8);
  });
});

test("docs denied: no extension and no skills methods", async () => {
  await withClient(
    { SN_TOOL_PACKAGES: "table", SN_PACKAGES_DENY: "docs" },
    async (client) => {
      assert.equal(
        client.getServerCapabilities().extensions?.[SKILLS_EXTENSION],
        undefined,
      );
      await assert.rejects(
        client.request({ method: "skills/list", params: {} }, ANY),
        (e) => e.code === -32601,
      );
    },
  );
});

test("2026-07-28 wire: skills/list carries resultType, ttlMs and cacheScope", async () => {
  await withEnv(DOCS_ON, async () => {
    const runtime = currentRuntime();
    const handler = createMcpHandler(() => buildMcpServer(runtime), {
      legacy: "reject",
      onerror: () => {},
    });
    try {
      const res = await handler.fetch(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "skills/list",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "skills/list",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": {
                  name: "skills",
                  version: "0",
                },
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        }),
      );
      const text = await res.text();
      const message = res.headers
        .get("content-type")
        ?.includes("text/event-stream")
        ? JSON.parse(
            text
              .split("\n")
              .find((l) => l.startsWith("data:") && l.includes('"id":1'))
              .slice(5),
          )
        : JSON.parse(text);
      const { result } = message;
      assert.equal(result.resultType, "complete");
      assert.equal(result.ttlMs, 3_600_000);
      assert.equal(result.cacheScope, "public");
      assert.ok(result.skills.length >= 8);
    } finally {
      await handler.close();
    }
  });
});
