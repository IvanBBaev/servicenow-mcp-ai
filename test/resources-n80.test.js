import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerAllTools, registerResources } from "../build/mcp/registry.js";
import { registerPrompts } from "../build/mcp/prompts.js";
import { LIST_CAP, resourceError } from "../build/mcp/resources.js";
import { SERVER_ICONS } from "../build/mcp/icons.js";
import { ServiceNowError } from "../build/core/errors.js";
import { currentRuntime } from "../build/core/runtime.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

/**
 * N-80: resource and prompt polish — icons on prompts and app views, the
 * assistant audience on the reference resources, size and lastModified on
 * docs entries, a "N more" entry on a capped list and `uri` in a
 * not-found resource error.
 */

const DOCS_DIR = path.join(os.tmpdir(), `servicenow-mcp-n80-${process.pid}`);
process.env.SN_DOCS_DIR = DOCS_DIR;
baselineEnv();

const ENV = { SN_TOOL_PACKAGES: "all", SN_MCP_APPS: "1" };

test.beforeEach(async () => {
  freshRuntime();
  await fs.rm(DOCS_DIR, { recursive: true, force: true });
});

test.after(async () => {
  await fs.rm(DOCS_DIR, { recursive: true, force: true });
});

async function startServer() {
  const server = new McpServer({ name: "t", version: "0.0.0" });
  registerAllTools(server, currentRuntime());
  registerResources(server);
  registerPrompts(server);
  const client = new Client({ name: "c", version: "0.0.0" });
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

async function withServer(fn) {
  await withEnv(ENV, async () => {
    const { client, close } = await startServer();
    try {
      await fn(client);
    } finally {
      await close();
    }
  });
}

test("every prompt and every app view carries the server icon", async () => {
  await withServer(async (client) => {
    const { prompts } = await client.listPrompts();
    assert.ok(prompts.length > 0);
    for (const p of prompts) assert.deepEqual(p.icons, SERVER_ICONS, p.name);

    const views = (await client.listResources()).resources.filter((r) =>
      r.uri.startsWith("ui://"),
    );
    assert.ok(views.length > 0, "SN_MCP_APPS lists the views");
    for (const v of views) assert.deepEqual(v.icons, SERVER_ICONS, v.uri);
  });
});

test("the reference resources are addressed to the assistant", async () => {
  await withServer(async (client) => {
    const { resources } = await client.listResources();
    for (const uri of [
      "servicenow://reference/tools",
      "servicenow://reference/encoded-query",
      "servicenow://policy",
    ]) {
      const entry = resources.find((r) => r.uri === uri);
      assert.ok(entry, uri);
      assert.deepEqual(entry.annotations?.audience, ["assistant"], uri);
    }
    const { resourceTemplates } = await client.listResourceTemplates();
    const tool = resourceTemplates.find(
      (t) => t.uriTemplate === "servicenow://reference/tools/{name}",
    );
    assert.deepEqual(tool?.annotations?.audience, ["assistant"]);
    // Instance data is for the user and the assistant alike.
    const schema = resourceTemplates.find(
      (t) => t.uriTemplate === "servicenow://schema/{table}",
    );
    assert.equal(schema?.annotations, undefined);
  });
});

test("docs entries carry size and lastModified; the index counts what the cap left out", async () => {
  await fs.mkdir(DOCS_DIR, { recursive: true });
  const files = Array.from({ length: 150 }, (_, i) => ({
    path: `doc-${String(i).padStart(3, "0")}.md`,
    kind: null,
    title: null,
    profile: null,
    generator: null,
    generated_at: null,
    source_hash: null,
    bytes: 1,
    headings: [],
  }));
  await fs.writeFile(
    path.join(DOCS_DIR, "index.json"),
    JSON.stringify({ schema_version: 1, files }),
  );
  await fs.writeFile(path.join(DOCS_DIR, "doc-000.md"), "# Zero\n");
  await fs.writeFile(path.join(DOCS_DIR, "index.md"), "# Index\n\nall\n");

  await withServer(async (client) => {
    const docs = (await client.listResources()).resources.filter((r) =>
      r.uri.startsWith("servicenow://docs/"),
    );
    assert.equal(docs.length, LIST_CAP);
    const first = docs.find((d) => d.uri === "servicenow://docs/doc-000.md");
    assert.equal(first.size, 7);
    assert.ok(!Number.isNaN(Date.parse(first.annotations.lastModified)));
    // A manifest entry without a file on disk lists without the facts.
    const missing = docs.find((d) => d.uri === "servicenow://docs/doc-001.md");
    assert.equal(missing.size, undefined);
    assert.equal(missing.annotations, undefined);

    const index = docs.at(-1);
    assert.equal(index.uri, "servicenow://docs/index.md");
    assert.equal(index.size, 13);
    assert.match(index.description, /150 documents \(51 not listed here/);
  });
});

test("a docs index under the cap says nothing about left-out entries", async () => {
  await fs.mkdir(DOCS_DIR, { recursive: true });
  await fs.writeFile(
    path.join(DOCS_DIR, "index.json"),
    JSON.stringify({
      schema_version: 1,
      files: [
        {
          path: "a.md",
          kind: null,
          title: null,
          profile: null,
          generator: null,
          generated_at: null,
          source_hash: null,
          bytes: 1,
          headings: [],
        },
      ],
    }),
  );
  await withServer(async (client) => {
    const index = (await client.listResources()).resources.find(
      (r) => r.uri === "servicenow://docs/index.md",
    );
    assert.equal(index.description, "Index of all 1 documents");
  });
});

test("a capped schema list ends with an entry naming how many were left out", async () => {
  const rows = Array.from({ length: 150 }, (_, i) => ({
    name: `u_t${String(i).padStart(3, "0")}`,
    label: `T${i}`,
    "super_class.name": "",
  }));
  const fetchTables = (url) => {
    const u = new URL(url);
    if (!u.pathname.includes("/table/sys_db_object")) {
      return jsonResponse(404, { error: { message: "unmocked" } });
    }
    const offset = Number(u.searchParams.get("sysparm_offset") ?? 0);
    return jsonResponse(200, { result: offset === 0 ? rows : [] });
  };
  await withServer(async (client) => {
    await withFetch(fetchTables, () =>
      client.readResource({ uri: "servicenow://tables" }),
    );
    const { resources } = await client.listResources();
    const at = resources.findIndex((r) => r.name.includes(" more — narrow"));
    assert.ok(at > 0, "the synthetic entry is listed");
    const schema = resources
      .slice(0, at)
      .filter((r) => r.uri.startsWith("servicenow://schema/"));
    assert.equal(schema.length, LIST_CAP - 1);
    const more = resources[at];
    assert.equal(more.uri, "servicenow://tables");
    assert.match(
      more.name,
      /^\d+ more — narrow with servicenow:\/\/schema\/\{table\}$/,
    );
    assert.match(more.description, /cap 100/);
  });
});

test("resourceError names the uri on a not-found code only", () => {
  const uri = new URL("servicenow://schema/u_gone");
  const gone = resourceError(
    "schema",
    new ServiceNowError("gone", 404, undefined, { source: "servicenow" }),
    {},
    uri,
  );
  assert.deepEqual(gone.data, {
    code: "INSTANCE_HTTP_404",
    source: "servicenow",
    uri: "servicenow://schema/u_gone",
  });

  const down = resourceError(
    "schema",
    new ServiceNowError("x", undefined, undefined, { code: "UNREACHABLE" }),
    {},
    uri,
  );
  assert.equal(down.data.uri, undefined);
});
