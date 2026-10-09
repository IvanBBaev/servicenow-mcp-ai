// N-35 / ADR 0008 — server/discover (MCP 2026-07-28, server/discover.mdx).
// The modern wire has no initialize: a client learns the supported revisions,
// the capabilities, the instructions and the server identity from one
// server/discover request. Driven through the real server factory
// (buildMcpServer) behind the SDK's modern HTTP handler with raw JSON-RPC, so
// the assertions see the wire result, not a client's parse of it.
import test from "node:test";
import assert from "node:assert/strict";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { buildMcpServer } from "../build/server.js";
import { SERVER_VERSION } from "../build/core/identity.js";
import {
  buildServerInstructions,
  serverImplementation,
} from "../build/mcp/server-info.js";
import { SERVER_NAME } from "../build/mcp/status.js";
import { baselineEnv, freshRuntime, withEnv } from "./helpers.js";

baselineEnv();

const MODERN = "2026-07-28";
const LEGACY = "2025-11-25";
const SERVER_INFO = "io.modelcontextprotocol/serverInfo";
const ENV = { SN_LOG_LEVEL: "warn" };

/** One raw JSON-RPC POST to `handler`; the parsed response body. */
async function post(handler, method, params, { version = MODERN } = {}) {
  const res = await handler.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(version ? { "mcp-protocol-version": version } : {}),
        "mcp-method": method,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const text = await res.text();
  // The legacy fallback may answer as an SSE stream: take the last data line.
  if (text.startsWith("{")) return JSON.parse(text);
  const data = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .at(-1);
  return JSON.parse(data?.slice(5) ?? "null");
}

/** The envelope every 2026-07-28 request carries in `params._meta`. */
const envelope = () => ({
  _meta: {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientInfo": {
      name: "discover-test",
      version: "0",
    },
    "io.modelcontextprotocol/clientCapabilities": {},
  },
});

/** Serve buildMcpServer on the modern wire only and send server/discover. */
async function discover() {
  return withEnv(ENV, async () => {
    const runtime = freshRuntime();
    const handler = createMcpHandler(() => buildMcpServer(runtime), {
      legacy: "reject",
    });
    try {
      const msg = await post(handler, "server/discover", envelope());
      assert.ok(msg.result, `no result: ${JSON.stringify(msg)}`);
      return {
        result: msg.result,
        instructions: buildServerInstructions(SERVER_VERSION),
      };
    } finally {
      await handler.close();
    }
  });
}

test("discover: server/discover is implemented and answers a complete result", async () => {
  const { result } = await discover();
  assert.equal(result.resultType, "complete");
  assert.ok(Array.isArray(result.supportedVersions));
  assert.equal(typeof result.capabilities, "object");
});

test("discover: supportedVersions advertises 2026-07-28; 2025-11-25 stays negotiable via initialize", async () => {
  const { result } = await discover();
  assert.ok(
    result.supportedVersions.includes(MODERN),
    JSON.stringify(result.supportedVersions),
  );
  // The SDK lists only the modern revisions here: a 2025-era revision is
  // negotiated by initialize, which the dual-wire handler still answers.
  await withEnv(ENV, async () => {
    const runtime = freshRuntime();
    const handler = createMcpHandler(() => buildMcpServer(runtime));
    try {
      const msg = await post(
        handler,
        "initialize",
        {
          protocolVersion: LEGACY,
          capabilities: {},
          clientInfo: { name: "discover-test", version: "0" },
        },
        { version: null },
      );
      assert.equal(msg.result?.protocolVersion, LEGACY, JSON.stringify(msg));
    } finally {
      await handler.close();
    }
  });
});

test("discover: capabilities declare tools, resources and prompts with listChanged, and logging", async () => {
  const { result } = await discover();
  const caps = result.capabilities;
  assert.equal(caps.tools?.listChanged, true);
  assert.equal(caps.resources?.listChanged, true);
  assert.equal(caps.prompts?.listChanged, true);
  assert.deepEqual(caps.logging, {});
});

test("discover: the result names the server identity in _meta serverInfo", async () => {
  const { result } = await discover();
  const info = result._meta?.[SERVER_INFO];
  assert.ok(info, `no ${SERVER_INFO} in ${JSON.stringify(result._meta)}`);
  assert.deepEqual(info, serverImplementation(SERVER_VERSION));
  assert.equal(info.name, SERVER_NAME);
  assert.equal(info.title, "ServiceNow MCP");
  assert.equal(info.version, SERVER_VERSION);
});

test("discover: the result carries the server instructions", async () => {
  const { result, instructions } = await discover();
  assert.equal(typeof result.instructions, "string");
  assert.ok(result.instructions.length > 0);
  assert.equal(result.instructions, instructions);
});
