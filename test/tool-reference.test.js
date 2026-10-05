import test from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import {
  registerAllTools,
  registerResources,
  describeAllTools,
  describeToolSchemas,
} from "../build/mcp/registry.js";
import {
  TOOL_REFERENCE_TEMPLATE,
  toolReferenceUri,
} from "../build/mcp/resources.js";
import { currentRuntime } from "../build/core/runtime.js";
import { baselineEnv, freshRuntime, withEnv } from "./helpers.js";

/**
 * N-37 (TK-08): servicenow://reference/tools/{name} — one tool's full
 * definition, so lean descriptions can point at it. Always on like the tool
 * list; it documents unregistered tools too and says so.
 */

baselineEnv();
test.beforeEach(() => freshRuntime());

async function startServer() {
  const server = new McpServer({ name: "t", version: "0.0.0" });
  registerAllTools(server, currentRuntime());
  registerResources(server);
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

async function withServer(env, fn) {
  await withEnv(env, async () => {
    const { client, close } = await startServer();
    try {
      await fn(client);
    } finally {
      await close();
    }
  });
}

const read = async (client, name) =>
  JSON.parse(
    (await client.readResource({ uri: toolReferenceUri(name) })).contents[0]
      .text,
  );

test("the template is listed, lists no entries and completes tool names", async () => {
  await withServer({ SN_TOOL_PACKAGES: "table" }, async (client) => {
    const { resourceTemplates } = await client.listResourceTemplates();
    const template = resourceTemplates.find(
      (t) => t.uriTemplate === TOOL_REFERENCE_TEMPLATE,
    );
    assert.ok(template, "servicenow://reference/tools/{name} is a template");
    assert.equal(template.name, "tool-reference");
    assert.equal(template.mimeType, "application/json");

    const { resources } = await client.listResources();
    assert.ok(
      !resources.some((r) => r.uri.startsWith("servicenow://reference/tools/")),
      "no per-tool entries crowd resources/list",
    );

    const { completion } = await client.complete({
      ref: { type: "ref/resource", uri: TOOL_REFERENCE_TEMPLATE },
      argument: { name: "name", value: "servicenow_query_t" },
    });
    assert.deepEqual(completion.values, ["servicenow_query_table"]);
  });
});

test("a known tool returns its full definition", async () => {
  await withServer({ SN_TOOL_PACKAGES: "table" }, async (client) => {
    const name = "servicenow_query_table";
    const ref = await read(client, name);
    const info = describeAllTools().find((t) => t.name === name);
    const schemas = describeToolSchemas().find((s) => s.name === name);
    assert.equal(ref.name, name);
    assert.equal(ref.title, info.title);
    assert.equal(ref.package, "table");
    assert.equal(ref.packageState, "enabled");
    assert.equal(ref.access, "read");
    assert.equal(ref.registered, true);
    assert.equal(ref.description, info.description, "the full description");
    assert.deepEqual(ref.annotations, info.annotations);
    assert.deepEqual(ref.inputSchema, schemas.inputSchema);
    assert.deepEqual(ref.outputSchema, schemas.outputSchema ?? null);
    assert.equal(ref.errorCodes.scope, "global");
    assert.ok(ref.errorCodes.bySource.server.includes("NOT_CONFIGURED"));
    assert.ok(ref.errorCodes.bySource.policy.includes("POLICY_DENIED"));
    assert.ok(
      ref.errorCodes.bySource.servicenow.includes("INSTANCE_HTTP_<status>"),
    );
  });
});

test("every tool has a reference whose schemas match tools/list", async () => {
  await withServer({ SN_TOOL_PACKAGES: "all" }, async (client) => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const ref = await read(client, tool.name);
      assert.equal(ref.description, tool.description, tool.name);
      assert.deepEqual(ref.inputSchema, tool.inputSchema, tool.name);
      assert.deepEqual(ref.outputSchema, tool.outputSchema ?? null, tool.name);
      assert.equal(ref.registered, true, tool.name);
    }
    assert.equal(tools.length, describeAllTools().length);
  });
});

test("the reference follows the package policy without hiding tools", async () => {
  await withServer(
    { SN_TOOL_PACKAGES: "table", SN_PACKAGES_READONLY: "table" },
    async (client) => {
      const docs = await read(client, "servicenow_write_doc");
      assert.equal(docs.packageState, "not enabled");
      assert.equal(docs.registered, false);
      assert.equal(docs.access, "write");

      const write = await read(client, "servicenow_create_record");
      assert.equal(write.packageState, "enabled, read-only");
      assert.equal(write.registered, false);

      const query = await read(client, "servicenow_query_table");
      assert.equal(query.registered, true);

      // admin is always on.
      const status = await read(client, "servicenow_get_status");
      assert.equal(status.packageState, "enabled");
      assert.equal(status.registered, true);
    },
  );
});

test("an unknown tool is an InvalidParams McpError with NOT_FOUND", async () => {
  await withServer({ SN_TOOL_PACKAGES: "table" }, async (client) => {
    await assert.rejects(
      client.readResource({ uri: toolReferenceUri("servicenow_nope") }),
      (err) => {
        assert.equal(err.code, ErrorCode.InvalidParams);
        assert.match(err.message, /Unknown tool "servicenow_nope"/);
        assert.equal(err.data?.code, "NOT_FOUND");
        assert.equal(err.data?.source, "server");
        assert.match(err.data?.hint, /servicenow:\/\/reference\/tools/);
        return true;
      },
    );
    // A retired (M-7) name points at its successor.
    await assert.rejects(
      client.readResource({
        uri: toolReferenceUri("servicenow_artifact_dependencies"),
      }),
      (err) => {
        assert.equal(err.data?.code, "NOT_FOUND");
        assert.match(
          err.data?.hint,
          /servicenow:\/\/reference\/tools\/servicenow_get_artifact_dependencies/,
        );
        return true;
      },
    );
  });
});
