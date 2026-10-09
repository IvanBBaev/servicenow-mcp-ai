// N-65 — resource_link results: a file delivery (format:"file") gains a
// resource_link block to servicenow://docs/<path> while the docs package is
// on (servicenow://exports/<path> without it, none with docs denied), and the
// docs and exports resources read the delivered .jsonl / .csv / .mmd files.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { fileLinkOf } from "../build/mcp/file-link.js";
import { defineTool, runSpec } from "../build/mcp/define.js";
import { ok } from "../build/mcp/result.js";
import {
  registerDocsResources,
  registerExportsResource,
} from "../build/mcp/resources.js";
import { baselineEnv, withEnv } from "./helpers.js";

const DOCS_DIR = mkdtempSync(path.join(tmpdir(), "sn-n65-"));
process.env.SN_DOCS_DIR = DOCS_DIR;
baselineEnv();
test.after(() => rmSync(DOCS_DIR, { recursive: true, force: true }));

const delivery = (rel, extra = {}) =>
  JSON.stringify({ format: "file", path: rel, bytes: 12, ...extra });

test("N-65: fileLinkOf links each delivered file type", () => {
  const cases = [
    ["default/exports/incident-1.jsonl", "application/x-ndjson"],
    ["default/exports/incident-1.csv", "text/csv"],
    ["default/exports/snapshot-1.json", "application/json"],
    ["default/diagrams/my flow.mmd", "text/plain"],
  ];
  for (const [rel, mimeType] of cases) {
    assert.deepEqual(fileLinkOf(delivery(rel)), {
      type: "resource_link",
      uri: `servicenow://docs/${encodeURI(rel)}`,
      name: path.posix.basename(rel),
      mimeType,
      size: 12,
    });
  }
  assert.equal(
    fileLinkOf(delivery("default/exports/a.csv").replace(":", ": ")).uri,
    "servicenow://docs/default/exports/a.csv",
    "pretty JSON",
  );
});

test("N-65: fileLinkOf ignores what is not a single-file delivery", () => {
  for (const text of [
    JSON.stringify({ format: "json", path: "default/exports/a.csv" }),
    JSON.stringify({ format: "file", files: ["a.ts"] }),
    delivery("default/fluent/app/a.ts"),
    '"format":"file" but not JSON',
  ]) {
    assert.equal(fileLinkOf(text), undefined, text);
  }
});

const fakeTool = (body) =>
  defineTool({
    name: "servicenow_n65_fake",
    title: "N-65 fake",
    description: "Test double.",
    package: "table",
    annotations: { readOnlyHint: true },
    input: {},
    handler: async () => body,
  });

test("N-65: runSpec links docs, exports without docs, nothing with docs denied", async () => {
  const spec = fakeTool(ok(JSON.parse(delivery("default/exports/a.csv"))));
  await withEnv({ SN_TOOL_PACKAGES: "core,docs" }, async () => {
    const res = await runSpec(spec, {});
    assert.equal(res.content.length, 2);
    assert.equal(res.content[0].type, "text");
    assert.equal(res.content[1].type, "resource_link");
    assert.equal(res.content[1].uri, "servicenow://docs/default/exports/a.csv");
  });
  await withEnv({ SN_TOOL_PACKAGES: "core" }, async () => {
    const res = await runSpec(spec, {});
    assert.equal(res.content.length, 2);
    assert.equal(
      res.content[1].uri,
      "servicenow://exports/default/exports/a.csv",
      "no docs package: the always-on exports resource",
    );
  });
  await withEnv(
    { SN_TOOL_PACKAGES: "core,docs", SN_PACKAGES_DENY: "docs" },
    async () => {
      const res = await runSpec(spec, {});
      assert.equal(res.content.length, 1, "docs denied: no link");
    },
  );
  await withEnv({ SN_TOOL_PACKAGES: "core,docs" }, async () => {
    const plain = await runSpec(fakeTool(ok({ n: 1 })), {});
    assert.equal(plain.content.length, 1, "an inline result is unchanged");
  });
});

test("N-65: the docs resource reads a linked export", async () => {
  mkdirSync(path.join(DOCS_DIR, "default", "exports"), { recursive: true });
  writeFileSync(
    path.join(DOCS_DIR, "default", "exports", "inc-1.csv"),
    "sys_id,n\ns1,1\n",
  );
  const server = new McpServer({ name: "n65-test", version: "0.0.0" });
  registerDocsResources(server);
  const client = new Client({ name: "n65-client", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const link = fileLinkOf(delivery("default/exports/inc-1.csv"));
    const read = await client.readResource({ uri: link.uri });
    assert.equal(read.contents[0].mimeType, "text/csv");
    assert.match(read.contents[0].text, /s1,1/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("N-65: the exports resource reads a delivery and refuses a document", async () => {
  mkdirSync(path.join(DOCS_DIR, "default", "diagrams"), { recursive: true });
  writeFileSync(
    path.join(DOCS_DIR, "default", "diagrams", "f 1.mmd"),
    "flowchart TD\n  a-->b\n",
  );
  writeFileSync(path.join(DOCS_DIR, "default", "notes.md"), "# private\n");
  const server = new McpServer({ name: "n65-exports", version: "0.0.0" });
  registerExportsResource(server);
  const client = new Client({ name: "n65-client", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const link = fileLinkOf(delivery("default/diagrams/f 1.mmd"), "exports");
    assert.equal(link.uri, "servicenow://exports/default/diagrams/f%201.mmd");
    const read = await client.readResource({ uri: link.uri });
    assert.equal(read.contents[0].mimeType, "text/plain");
    assert.match(read.contents[0].text, /a-->b/);
    await assert.rejects(
      client.readResource({ uri: "servicenow://exports/default/notes.md" }),
      /Not a file delivery/,
    );
    await assert.rejects(
      client.readResource({
        uri: "servicenow://exports/default/exports/missing.csv",
      }),
      /not found/i,
    );
    await assert.rejects(
      client.readResource({ uri: "servicenow://exports/../../etc/x.csv" }),
    );
    const { resources } = await client.listResources();
    assert.deepEqual(resources, [], "deliveries are not listed");
  } finally {
    await client.close();
    await server.close();
  }
});
