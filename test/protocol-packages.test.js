// O-19 (d) / ADR 0008 — on the 2026-07-28 wire tools/list, prompts/list and
// resources/list are fixed per server: they come from configuration
// (SN_TOOL_PACKAGES, the profile) and must not vary per connection or as a
// side effect of another request (tools-04, resources-03, prompts-03). The
// runtime toggles servicenow_enable_package / _disable_package (M-5) refuse
// there and keep working on the 2025-11-25 wire, unchanged.
//
// Two harnesses: the modern HTTP handler in-process (a fresh McpServer per
// request on one runtime) and the real stdio entry point spawned, where the
// modern era pins one McpServer for the whole connection — the case in which
// a toggle would otherwise change the next list.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { buildMcpServer } from "../build/server.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import { baselineEnv, freshRuntime, withEnv } from "./helpers.js";

baselineEnv();

const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";
const LISTS = ["tools/list", "prompts/list", "resources/list"];
const PACKAGE = "codecheck";
const PACKAGE_TOOLS = ALL_TOOLS.filter((t) => t.package === PACKAGE)
  .map((t) => t.name)
  .sort();

const root = join(import.meta.dirname, "..");
const entry = join(root, "build", "index.js");
const sandbox = mkdtempSync(join(tmpdir(), "sn-packages-"));
test.after(() => rmSync(sandbox, { recursive: true, force: true }));

/** The parent environment minus every SN_* key, pointed at the sandbox. */
function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("SN_") && value !== undefined) env[key] = value;
  }
  return {
    ...env,
    HOME: sandbox,
    USERPROFILE: sandbox,
    XDG_CONFIG_HOME: join(sandbox, "config"),
    SN_ENV_FILE: join(sandbox, "does-not-exist.env"),
    SN_DOCS_DIR: join(sandbox, "docs"),
    SN_TRANSPORT: "stdio",
    SN_LOG_LEVEL: "warn",
  };
}

/** Spawn build/index.js over stdio and run `body` with a v2 client. */
async function withStdioClient(mode, body) {
  const client = new Client(
    { name: "packages-test", version: "0.0.0" },
    { versionNegotiation: { mode } },
  );
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: cleanEnv(),
      cwd: sandbox,
      stderr: "ignore",
    }),
  );
  try {
    return await body(client);
  } finally {
    await client.close();
  }
}

/** The three lists as the client sees them (one page each). */
async function clientLists(client) {
  const [tools, prompts, resources] = await Promise.all([
    client.listTools(),
    client.listPrompts(),
    client.listResources(),
  ]);
  return {
    tools: tools.tools.map((t) => t.name),
    prompts: prompts.prompts.map((p) => p.name),
    resources: resources.resources.map((r) => r.uri),
  };
}

/** A raw modern-wire client: one fresh McpServer per request, one runtime. */
function modernHttp(runtime) {
  const handler = createMcpHandler(() => buildMcpServer(runtime), {
    legacy: "reject",
  });
  let id = 0;
  async function rpc(method, params = {}) {
    id += 1;
    const res = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MODERN,
          "mcp-method": method,
          ...(params.name ? { "mcp-name": params.name } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": MODERN,
              "io.modelcontextprotocol/clientInfo": {
                name: "packages-test",
                version: "0",
              },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }),
    );
    const msg = await res.json();
    assert.ok(msg.result, `${method}: ${JSON.stringify(msg).slice(0, 400)}`);
    return msg.result;
  }
  /** The raw wire results of every list, keyed by method. */
  const lists = async () =>
    Object.fromEntries(
      await Promise.all(LISTS.map(async (m) => [m, await rpc(m)])),
    );
  return { rpc, lists, close: () => handler.close() };
}

const payload = (result) => JSON.parse(result.content[0].text);

/** Assert a toggle was refused on the modern wire and changed nothing. */
function assertRefused(result) {
  assert.equal(result.isError, true, JSON.stringify(result));
  const body = payload(result);
  assert.equal(body.code, "NO_PACKAGE_SESSION");
  assert.match(JSON.stringify(body), /2026-07-28/);
  assert.match(JSON.stringify(body), /SN_TOOL_PACKAGES/);
}

test("packages: two 2026-07-28 requests see identical tools, prompts and resources lists", async () => {
  await withEnv({ SN_LOG_LEVEL: "warn" }, async () => {
    const client = modernHttp(freshRuntime());
    try {
      const first = await client.lists();
      const second = await client.lists();
      assert.ok(first["tools/list"].tools.length > 0);
      assert.deepEqual(second, first);
    } finally {
      await client.close();
    }
  });
});

test("packages: a 2026-07-28 enable_package / disable_package is refused and the lists stay identical", async () => {
  await withEnv({ SN_LOG_LEVEL: "warn" }, async () => {
    const client = modernHttp(freshRuntime());
    try {
      const before = await client.lists();
      assertRefused(
        await client.rpc("tools/call", {
          name: "servicenow_enable_package",
          arguments: { name: PACKAGE },
        }),
      );
      assert.deepEqual(await client.lists(), before);
      assertRefused(
        await client.rpc("tools/call", {
          name: "servicenow_disable_package",
          arguments: { name: "table" },
        }),
      );
      assert.deepEqual(await client.lists(), before);
    } finally {
      await client.close();
    }
  });
});

test("packages: on a pinned 2026-07-28 stdio connection enable_package does not change the lists", async () => {
  await withStdioClient({ pin: MODERN }, async (client) => {
    assert.equal(client.getNegotiatedProtocolVersion(), MODERN);
    const before = await clientLists(client);
    assert.ok(!before.tools.includes(PACKAGE_TOOLS[0]));
    assertRefused(
      await client.callTool({
        name: "servicenow_enable_package",
        arguments: { name: PACKAGE },
      }),
    );
    assert.deepEqual(await clientLists(client), before);
    assert.deepEqual(await clientLists(client), before);
  });
});

test("packages: the 2025-11-25 wire still toggles a package at runtime (M-5)", async () => {
  await withStdioClient("legacy", async (client) => {
    assert.equal(client.getNegotiatedProtocolVersion(), LEGACY);
    const before = await clientLists(client);
    assert.ok(!before.tools.includes(PACKAGE_TOOLS[0]));
    const result = await client.callTool({
      name: "servicenow_enable_package",
      arguments: { name: PACKAGE },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent.changed, true);
    const after = await clientLists(client);
    for (const name of PACKAGE_TOOLS) assert.ok(after.tools.includes(name));
    const off = await client.callTool({
      name: "servicenow_disable_package",
      arguments: { name: PACKAGE },
    });
    assert.equal(off.structuredContent.changed, true);
    assert.deepEqual((await clientLists(client)).tools, before.tools);
  });
});
