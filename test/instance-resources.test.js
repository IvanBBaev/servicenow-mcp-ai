import test from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerAllTools, registerResources } from "../build/mcp/registry.js";
import { clearSchemaCache } from "../build/core/cache.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

const PROD_HOST = "prod99999.service-now.com";
const PROFILE_ENV = {
  SN_TOOL_PACKAGES: "all",
  SN_PROFILE_PROD_INSTANCE: PROD_HOST,
  SN_PROFILE_PROD_USER: "prod.user",
  SN_PROFILE_PROD_PASSWORD: "pr0d",
};

/** In-memory MCP pair with the full package set (instance included). */
async function startServer() {
  const server = new McpServer({
    name: "servicenow-mcp-test",
    version: "0.0.0",
  });
  registerAllTools(server);
  registerResources(server);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** sys_db_object/sys_dictionary on two hosts: prod's column type differs. */
function schemaFetch(url) {
  const u = new URL(url);
  const prod = u.hostname === PROD_HOST;
  if (u.pathname.includes("/table/sys_db_object")) {
    return jsonResponse(200, { result: [{ name: "incident" }] });
  }
  if (u.pathname.includes("/table/sys_dictionary")) {
    return jsonResponse(200, {
      result: [
        {
          element: "severity",
          column_label: "Severity",
          internal_type: prod ? "string" : "integer",
          name: "incident",
        },
      ],
    });
  }
  return jsonResponse(404, { error: { message: `unmocked: ${u.pathname}` } });
}

test("servicenow://instances lists profiles without passwords", async () => {
  baselineEnv();
  await withEnv(PROFILE_ENV, async () => {
    const { client, close } = await startServer();
    try {
      const res = await client.readResource({ uri: "servicenow://instances" });
      const payload = JSON.parse(res.contents[0].text);
      assert.equal(payload.count, 2);
      assert.equal(payload.activeProfile, "default");
      const prod = payload.profiles.find((p) => p.name === "prod");
      assert.equal(prod.instance, PROD_HOST);
      assert.equal(prod.hasCredentials, true);
      assert.doesNotMatch(res.contents[0].text, /pr0d|s3cret/);
    } finally {
      await close();
    }
  });
});

test("servicenow://<profile>/schema/<table> reads through that profile", async () => {
  baselineEnv();
  clearSchemaCache();
  await withEnv(PROFILE_ENV, async () => {
    const { client, close } = await startServer();
    try {
      await withFetch(schemaFetch, async (calls) => {
        const res = await client.readResource({
          uri: `servicenow://prod/schema/incident`,
        });
        const payload = JSON.parse(res.contents[0].text);
        assert.equal(payload.profile, "prod");
        assert.equal(payload.table, "incident");
        assert.equal(payload.columns[0].type, "string");
        // Every HTTP call went to the prod host, not the active profile's.
        assert.ok(calls.length > 0);
        for (const call of calls) {
          assert.match(call.url, new RegExp(PROD_HOST));
        }
      });
    } finally {
      await close();
    }
  });
});

test("unknown profile in the schema URI returns a JSON error payload", async () => {
  baselineEnv();
  await withEnv(PROFILE_ENV, async () => {
    const { client, close } = await startServer();
    try {
      const res = await client.readResource({
        uri: "servicenow://nope/schema/incident",
      });
      const payload = JSON.parse(res.contents[0].text);
      assert.match(payload.error, /Unknown connection profile "nope"/);
    } finally {
      await close();
    }
  });
});
