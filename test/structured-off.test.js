// N-39 (O-21 (d)) — SN_STRUCTURED=false: no outputSchema in tools/list and no
// structuredContent in results, so every payload goes out once, as text.
// The default (on) keeps the dual wire.
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerAllTools } from "../build/mcp/registry.js";
import { defineTool, runSpec } from "../build/mcp/define.js";
import { ok, okStructured } from "../build/mcp/result.js";
import { currentRuntime } from "../build/core/runtime.js";
import { baselineEnv, withEnv } from "./helpers.js";
import { listPublishedTools, PROFILES } from "./surface.js";

baselineEnv();

const fakeTool = (handler) =>
  defineTool({
    name: "servicenow_n39_fake",
    title: "N-39 fake",
    description: "Test double.",
    package: "table",
    annotations: { readOnlyHint: true },
    input: {},
    output: { n: z.number() },
    handler,
  });

async function withClient(fn) {
  const server = new McpServer({ name: "n39-test", version: "0.0.0" });
  registerAllTools(server, currentRuntime());
  const client = new Client({ name: "n39-client", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const withSchema = (tools) => tools.filter((t) => t.outputSchema).length;

test("N-39: tools/list publishes outputSchema by default and none when off", async () => {
  const on = await listPublishedTools(PROFILES.all);
  assert.ok(withSchema(on) > 0, "default keeps the output schemas");
  for (const value of ["0", "false", "off"]) {
    const off = await listPublishedTools({
      ...PROFILES.all,
      SN_STRUCTURED: value,
    });
    assert.equal(off.length, on.length, value);
    assert.equal(withSchema(off), 0, value);
  }
});

test("N-39: runSpec drops structuredContent when off", async () => {
  await withEnv({ SN_STRUCTURED: "0" }, async () => {
    for (const handler of [() => ok({ n: 1 }), () => okStructured({ n: 2 })]) {
      const res = await runSpec(fakeTool(handler), {});
      assert.equal(res.structuredContent, undefined);
      assert.equal(typeof JSON.parse(res.content[0].text).n, "number");
    }
  });
  const res = await runSpec(
    fakeTool(() => okStructured({ n: 3 })),
    {},
  );
  assert.deepEqual(res.structuredContent, { n: 3 }, "default keeps it");
});

test("N-39: a client call answers with text only when off", async () => {
  await withEnv({ SN_STRUCTURED: "0" }, () =>
    withClient(async (client) => {
      const { tools } = await client.listTools();
      assert.equal(withSchema(tools), 0);
      const res = await client.callTool({
        name: "servicenow_get_status",
        arguments: {},
      });
      assert.ok(!res.isError, res.content[0].text);
      assert.equal(res.structuredContent, undefined);
      assert.equal(typeof JSON.parse(res.content[0].text), "object");
    }),
  );
});
