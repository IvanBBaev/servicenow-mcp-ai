import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { registerAllTools, registerResources } from "../build/mcp/registry.js";
import { setServer } from "../build/mcp/context.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

/**
 * Boot the real server wiring (registry + resources) against an in-memory
 * client. This exercises the actual MCP surface: zod input schemas, argument
 * mapping, ok()/fail() envelopes and package gating — none of which the api/
 * unit tests touch.
 */
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

const toolNames = async (client) =>
  (await client.listTools()).tools.map((t) => t.name).sort();

/** The contract for the default (core) profile: admin + table/schema/aggregate/attachment. */
const CORE_TOOLS = [
  "servicenow_aggregate",
  "servicenow_check_capabilities",
  "servicenow_create_record",
  "servicenow_delete_attachment",
  "servicenow_delete_record",
  "servicenow_describe_table",
  "servicenow_download_attachment",
  "servicenow_get_attachment",
  "servicenow_get_record",
  "servicenow_get_status",
  "servicenow_list_attachments",
  "servicenow_list_instances",
  "servicenow_list_tables",
  "servicenow_query_table",
  "servicenow_set_credentials",
  "servicenow_test_connection",
  "servicenow_update_record",
  "servicenow_upload_attachment",
  "servicenow_use_instance",
];

test("core profile exposes exactly the contracted tool set", async () => {
  await withEnv({ SN_TOOL_PACKAGES: undefined }, async () => {
    const { client, close } = await startServer();
    try {
      assert.deepEqual(await toolNames(client), CORE_TOOLS);
    } finally {
      await close();
    }
  });
});

test("the all profile is a superset of core and includes the gated packages", async () => {
  await withEnv({ SN_TOOL_PACKAGES: "all" }, async () => {
    const { client, close } = await startServer();
    try {
      const names = await toolNames(client);
      for (const t of CORE_TOOLS) assert.ok(names.includes(t), t);
      for (const t of [
        "servicenow_batch",
        "servicenow_list_changes",
        "servicenow_order_catalog_item",
        "servicenow_search_knowledge",
        "servicenow_table_logic",
        "servicenow_docs_read",
      ]) {
        assert.ok(names.includes(t), t);
      }
    } finally {
      await close();
    }
  });
});

test("callTool servicenow_query_table goes through schema, mapping and ok()", async () => {
  await withEnv({ SN_TOOL_PACKAGES: undefined }, async () => {
    const { client, close } = await startServer();
    try {
      await withFetch(
        (url) => {
          const u = new URL(url);
          assert.match(u.pathname, /\/api\/now\/table\/incident$/);
          assert.equal(u.searchParams.get("sysparm_limit"), "2");
          return jsonResponse(
            200,
            { result: [{ number: "INC001" }, { number: "INC002" }] },
            { "x-total-count": "7" },
          );
        },
        async () => {
          const res = await client.callTool({
            name: "servicenow_query_table",
            arguments: { table: "incident", limit: 2 },
          });
          assert.ok(!res.isError);
          const payload = JSON.parse(res.content[0].text);
          assert.equal(payload.count, 2);
          assert.equal(payload.total, 7);
          assert.equal(payload.records[1].number, "INC002");
        },
      );
    } finally {
      await close();
    }
  });
});

test("invalid arguments are rejected by the zod schema before any network call", async () => {
  await withEnv({ SN_TOOL_PACKAGES: undefined }, async () => {
    const { client, close } = await startServer();
    try {
      await withFetch(
        () => {
          throw new Error("fetch must not be called for invalid input");
        },
        async (calls) => {
          const res = await client.callTool({
            name: "servicenow_query_table",
            arguments: { table: "incident", limit: -2 },
          });
          assert.ok(res.isError, "schema violation must surface as an error");
          assert.equal(calls.length, 0);
        },
      );
    } finally {
      await close();
    }
  });
});

test("an unknown argument (typo) is a validation error, not silently stripped (S2-1)", async () => {
  await withEnv({ SN_TOOL_PACKAGES: undefined }, async () => {
    const { client, close } = await startServer();
    try {
      await withFetch(
        () => {
          throw new Error("fetch must not be called for an unknown argument");
        },
        async (calls) => {
          const res = await client.callTool({
            name: "servicenow_query_table",
            arguments: { tabel: "incident" },
          });
          assert.ok(res.isError, "typo'd argument must surface as an error");
          assert.equal(calls.length, 0);
        },
      );
    } finally {
      await close();
    }
  });
});

test("a ServiceNow error comes back as a structured fail() payload", async () => {
  await withEnv({ SN_TOOL_PACKAGES: undefined }, async () => {
    const { client, close } = await startServer();
    try {
      await withFetch(
        () => jsonResponse(403, { error: { message: "Insufficient rights" } }),
        async () => {
          const res = await client.callTool({
            name: "servicenow_query_table",
            arguments: { table: "incident" },
          });
          assert.ok(res.isError);
          const payload = JSON.parse(res.content[0].text);
          assert.equal(payload.error.status, 403);
          assert.equal(payload.error.snDetail.message, "Insufficient rights");
        },
      );
    } finally {
      await close();
    }
  });
});

test("gated tools are absent from core and cannot be called", async () => {
  await withEnv({ SN_TOOL_PACKAGES: undefined }, async () => {
    const { client, close } = await startServer();
    try {
      // Depending on the SDK version this surfaces as a protocol error or an
      // isError result — either way it must not succeed.
      const res = await client
        .callTool({ name: "servicenow_batch", arguments: { requests: [] } })
        .catch((err) => err);
      const failed = res instanceof Error || res.isError === true;
      assert.ok(failed, "calling a gated tool must fail");
    } finally {
      await close();
    }
  });
});

test("SN_PACKAGES_DENY removes a whole package even when 'all' is requested", async () => {
  await withEnv(
    { SN_TOOL_PACKAGES: "all", SN_PACKAGES_DENY: "change" },
    async () => {
      const { client, close } = await startServer();
      try {
        const names = await toolNames(client);
        assert.ok(
          !names.includes("servicenow_list_changes"),
          "change is denied",
        );
        assert.ok(!names.includes("servicenow_create_change"));
        assert.ok(names.includes("servicenow_list_catalogs"), "others remain");
      } finally {
        await close();
      }
    },
  );
});

test("SN_PACKAGES_READONLY keeps a package's read tools and drops its writes", async () => {
  await withEnv(
    { SN_TOOL_PACKAGES: "all", SN_PACKAGES_READONLY: "catalog" },
    async () => {
      const { client, close } = await startServer();
      try {
        const names = await toolNames(client);
        assert.ok(names.includes("servicenow_list_catalogs"));
        assert.ok(names.includes("servicenow_get_catalog_item"));
        assert.ok(
          !names.includes("servicenow_order_catalog_item"),
          "the write tool must not be registered",
        );
        // Other packages keep their write tools.
        assert.ok(names.includes("servicenow_create_record"));
      } finally {
        await close();
      }
    },
  );
});

test("servicenow_aggregate without any aggregation fails fast, offline", async () => {
  await withEnv({ SN_TOOL_PACKAGES: undefined }, async () => {
    const { client, close } = await startServer();
    try {
      await withFetch(
        () => {
          throw new Error("no network call expected");
        },
        async (calls) => {
          const res = await client.callTool({
            name: "servicenow_aggregate",
            arguments: { table: "incident", group_by: ["state"] },
          });
          assert.ok(res.isError);
          assert.match(res.content[0].text, /At least one aggregation/);
          assert.equal(calls.length, 0);
        },
      );
    } finally {
      await close();
    }
  });
});

test("test_connection reports ok/latency on success and structured failure (X-6)", async () => {
  await withEnv({ SN_TOOL_PACKAGES: undefined }, async () => {
    const { client, close } = await startServer();
    try {
      await withFetch(
        (url) => {
          assert.match(url, /\/api\/now\/table\/sys_user\?/);
          return jsonResponse(200, { result: [{ sys_id: "x" }] });
        },
        async () => {
          const res = await client.callTool({
            name: "servicenow_test_connection",
            arguments: {},
          });
          const payload = JSON.parse(res.content[0].text);
          assert.equal(payload.ok, true);
          assert.equal(payload.status, 200);
          assert.equal(payload.user, "alice");
          assert.ok(payload.latencyMs >= 0);
        },
      );
      await withFetch(
        () => jsonResponse(401, { error: { message: "auth failed" } }),
        async () => {
          const res = await client.callTool({
            name: "servicenow_test_connection",
            arguments: {},
          });
          assert.ok(!res.isError, "failure is structured, not an exception");
          const payload = JSON.parse(res.content[0].text);
          assert.equal(payload.ok, false);
          assert.equal(payload.status, 401);
          assert.match(payload.message, /401/);
        },
      );
    } finally {
      await close();
    }
  });
});

test("resources follow the package policy (K-7)", async () => {
  const resourceNames = async (client) => {
    const direct = (await client.listResources()).resources.map((r) => r.name);
    const templated = (
      await client.listResourceTemplates()
    ).resourceTemplates.map((r) => r.name);
    return [...direct, ...templated].sort();
  };

  // table package only: no schema, no docs → only the always-on admin
  // resources (connection status + the capability preflight).
  await withEnv({ SN_TOOL_PACKAGES: "table" }, async () => {
    const { client, close } = await startServer();
    try {
      assert.deepEqual(await resourceNames(client), ["capabilities", "status"]);
    } finally {
      await close();
    }
  });

  // all packages: capabilities + status + tables + schema + docs + the instance pair (MI-8).
  await withEnv({ SN_TOOL_PACKAGES: "all" }, async () => {
    const { client, close } = await startServer();
    try {
      assert.deepEqual(await resourceNames(client), [
        "capabilities",
        "docs",
        "instances",
        "profile-schema",
        "schema",
        "status",
        "tables",
      ]);
    } finally {
      await close();
    }
  });
});

test("set_credentials asks for confirmation via elicitation; decline saves nothing (X-2)", async () => {
  await withEnv(
    {
      SN_TOOL_PACKAGES: undefined,
      SN_ENV_FILE: "/nonexistent/never-written.env",
    },
    async () => {
      const server = new McpServer({
        name: "servicenow-mcp-test",
        version: "0.0.0",
      });
      registerAllTools(server);
      setServer(server);
      const client = new Client(
        { name: "test-client", version: "0.0.0" },
        { capabilities: { elicitation: {} } },
      );
      const answer = { action: "decline" };
      client.setRequestHandler(ElicitRequestSchema, async () => answer);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), client.connect(ct)]);
      try {
        // Decline → refusal, nothing saved.
        const declined = await client.callTool({
          name: "servicenow_set_credentials",
          arguments: { user: "mallory" },
        });
        assert.ok(declined.isError);
        assert.match(declined.content[0].text, /not confirmed/);

        const status = await client.callTool({
          name: "servicenow_get_status",
          arguments: {},
        });
        assert.equal(JSON.parse(status.content[0].text).user, "alice");

        // Accept path (Q2-5): confirm=true lets the change through, persisted
        // to a temp env file.
        const dir = await fs.mkdtemp(
          path.join(os.tmpdir(), "servicenow-mcp-elicit-"),
        );
        try {
          await withEnv({ SN_ENV_FILE: path.join(dir, ".env") }, async () => {
            answer.action = "accept";
            answer.content = { confirm: true };
            const accepted = await client.callTool({
              name: "servicenow_set_credentials",
              arguments: { user: "bob" },
            });
            assert.ok(!accepted.isError, "accepted change must save");
            assert.equal(JSON.parse(accepted.content[0].text).user, "bob");
          });
        } finally {
          await fs.rm(dir, { recursive: true, force: true });
          // saveCredentials mutated process.env (SN_USER=bob) — restore the
          // full baseline, which also reloads the credential store.
          baselineEnv();
        }
      } finally {
        setServer(null);
        await client.close();
        await server.close();
      }
    },
  );
});

test("set_credentials rejects an invalid/blocked host without persisting (K-6)", async () => {
  await withEnv(
    {
      SN_TOOL_PACKAGES: undefined,
      SN_ENV_FILE: "/nonexistent/never-written.env",
    },
    async () => {
      const { client, close } = await startServer();
      try {
        for (const instance of [
          "127.0.0.1",
          "foo.internal",
          "user:pass@evil.com",
        ]) {
          const res = await client.callTool({
            name: "servicenow_set_credentials",
            arguments: { instance },
          });
          assert.ok(res.isError, `expected rejection for ${instance}`);
        }
        // The env file path was never touched and the live config is intact.
        const status = await client.callTool({
          name: "servicenow_get_status",
          arguments: {},
        });
        const payload = JSON.parse(status.content[0].text);
        assert.equal(payload.instance, "dev00000.service-now.com");
      } finally {
        await close();
      }
    },
  );
});

test("the servicenow://status resource reports the connection shape", async () => {
  await withEnv({ SN_TOOL_PACKAGES: undefined }, async () => {
    const { client, close } = await startServer();
    try {
      const res = await client.readResource({ uri: "servicenow://status" });
      const payload = JSON.parse(res.contents[0].text);
      assert.equal(payload.configured, true);
      assert.equal(payload.instance, "dev00000.service-now.com");
      assert.equal(payload.user, "alice");
      assert.equal(payload.passwordSet, true);
      assert.equal(payload.readOnly, false);
      // Shared payload (A-5): the resource and the tool report packages too.
      assert.ok(Array.isArray(payload.enabledPackages));
      assert.ok(!("password" in payload), "password must never appear");
    } finally {
      await close();
    }
  });
});
