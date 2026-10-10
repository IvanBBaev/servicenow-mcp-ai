// N-38 — cache hints (MCP 2026-07-28, caching.mdx). On the 2026-07-28 wire
// every cacheable result carries the decided ttlMs / cacheScope: the lists
// and server/discover from LIST_CACHE_HINTS, the static references from
// their per-resource STATIC_RESOURCE_HINT, every other read the private
// default. The legacy wire carries neither field.
//
// The server is buildMcpServer itself, served in-process on both wires by
// the SDK's createMcpHandler, with the v2 client's fetch routed to it.
import test from "node:test";
import assert from "node:assert/strict";

import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import { buildMcpServer } from "../build/server.js";
import { currentRuntime } from "../build/core/runtime.js";
import {
  LIST_CACHE_HINTS,
  STATIC_RESOURCE_HINT,
} from "../build/mcp/cache-hints.js";
import { appViewUri } from "../build/mcp/apps.js";
import { APP_VIEW_IDS } from "../build/mcp/apps-views.js";
import { baselineEnv, withEnv } from "./helpers.js";

baselineEnv();

const MODERN = "2026-07-28";
const ENDPOINT = "http://127.0.0.1/mcp";
const ENV = {
  SN_TOOL_PACKAGES: "all",
  SN_MCP_APPS: "1",
  SN_RESULT_SIZE_HINTS: "0",
  SN_LOG_LEVEL: "warn",
};

const buildHintedServer = (runtime) => buildMcpServer(runtime);

/**
 * Serve `factory` in-process with createMcpHandler (2026-07-28, and the
 * stateless fallback for the 2025 wire) and run `body` with a v2 client
 * negotiated by `mode`. The raw JSON-RPC results are captured from the
 * response bodies, so the assertions see the wire, not the client's parse.
 */
async function withClient(mode, factory, body) {
  return withEnv(ENV, async () => {
    const handler = createMcpHandler(() => factory(currentRuntime()));
    const wire = new Map();
    const fetch = async (input, init) => {
      const request = new Request(input, init);
      const sent =
        request.method === "POST" ? await request.clone().json() : undefined;
      const response = await handler.fetch(request);
      if (sent?.method) {
        const text = await response.clone().text();
        const json = text.startsWith("{")
          ? JSON.parse(text)
          : JSON.parse(
              text
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5))
                .at(-1) ?? "null",
            );
        if (json?.result) wire.set(sent.method, json.result);
      }
      return response;
    };
    const client = new Client(
      { name: "cache-hints-test", version: "0.0.0" },
      { versionNegotiation: { mode } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(ENDPOINT), { fetch }),
    );
    try {
      return await body(client, wire);
    } finally {
      await client.close();
      await handler.close();
    }
  });
}

/** Assert one wire result carries exactly `hint`. */
function assertHint(result, hint, what) {
  assert.ok(result, `${what}: no result captured`);
  assert.ok(
    Number.isSafeInteger(result.ttlMs) && result.ttlMs >= 0,
    `${what}: ttlMs ${result.ttlMs} is not a non-negative integer`,
  );
  assert.deepEqual(
    { ttlMs: result.ttlMs, cacheScope: result.cacheScope },
    hint,
    what,
  );
}

const STATIC_URIS = [
  "servicenow://reference/encoded-query",
  "servicenow://artifact-types",
  ...APP_VIEW_IDS.map((view) => appViewUri(view)),
];
// Local reads with session state (no instance call): the private default.
// The tools reference reports registration, which enable/disable_package changes.
const DYNAMIC_URIS = [
  "servicenow://status",
  "servicenow://policy",
  "servicenow://reference/tools",
  "servicenow://reference/tools/servicenow_query_table",
];

const CACHEABLE_LISTS = {
  "tools/list": (c) => c.listTools(),
  "prompts/list": (c) => c.listPrompts(),
  "resources/list": (c) => c.listResources(),
  "resources/templates/list": (c) => c.listResourceTemplates(),
};

test("N-38: the hint constants are the owner-decided values", () => {
  assert.deepEqual(LIST_CACHE_HINTS, {
    "server/discover": { ttlMs: 300000, cacheScope: "private" },
    "tools/list": { ttlMs: 300000, cacheScope: "public" },
    "prompts/list": { ttlMs: 300000, cacheScope: "public" },
    "resources/templates/list": { ttlMs: 300000, cacheScope: "public" },
    "resources/list": { ttlMs: 0, cacheScope: "private" },
    "resources/read": { ttlMs: 0, cacheScope: "private" },
  });
  assert.deepEqual(STATIC_RESOURCE_HINT, {
    ttlMs: 3600000,
    cacheScope: "public",
  });
});

test("N-38: 2026-07-28 lists and server/discover carry the decided hints", async () => {
  await withClient({ pin: MODERN }, buildHintedServer, async (client, wire) => {
    assert.equal(client.getNegotiatedProtocolVersion(), MODERN);
    assertHint(
      wire.get("server/discover"),
      LIST_CACHE_HINTS["server/discover"],
      "server/discover",
    );
    for (const [method, call] of Object.entries(CACHEABLE_LISTS)) {
      await call(client);
      assertHint(wire.get(method), LIST_CACHE_HINTS[method], method);
    }
  });
});

test("N-38: static references read 1 h public, other reads 0 private", async () => {
  await withClient({ pin: MODERN }, buildHintedServer, async (client, wire) => {
    const listed = new Set(
      (await client.listResources()).resources.map((r) => r.uri),
    );
    for (const uri of STATIC_URIS) {
      assert.ok(listed.has(uri), `${uri} is not listed`);
      await client.readResource({ uri });
      assertHint(wire.get("resources/read"), STATIC_RESOURCE_HINT, uri);
    }
    for (const uri of DYNAMIC_URIS) {
      await client.readResource({ uri });
      assertHint(
        wire.get("resources/read"),
        { ttlMs: 0, cacheScope: "private" },
        uri,
      );
    }
  });
});

test("N-38: the legacy wire carries no ttlMs / cacheScope", async () => {
  await withClient("legacy", buildHintedServer, async (client, wire) => {
    assert.notEqual(client.getNegotiatedProtocolVersion(), MODERN);
    const seen = [];
    const check = (method) => {
      const result = wire.get(method);
      assert.ok(result, `${method}: no result captured`);
      assert.ok(!("ttlMs" in result), `${method} carries ttlMs`);
      assert.ok(!("cacheScope" in result), `${method} carries cacheScope`);
      seen.push(method);
    };
    check("initialize");
    for (const [method, call] of Object.entries(CACHEABLE_LISTS)) {
      await call(client);
      check(method);
    }
    for (const uri of [...STATIC_URIS, ...DYNAMIC_URIS]) {
      await client.readResource({ uri });
      check("resources/read");
    }
    assert.equal(seen.length, 5 + STATIC_URIS.length + DYNAMIC_URIS.length);
  });
});

// cache-03/04: a list's hint is bound per method, so every page of one list
// would carry it; the server answers each list in one page (no nextCursor),
// and that page carries the method's hint.
test("N-38: every 2026-07-28 list answers in a single page that carries the method's hint", async () => {
  await withClient({ pin: MODERN }, buildHintedServer, async (client, wire) => {
    for (const [method, call] of Object.entries(CACHEABLE_LISTS)) {
      const page = await call(client);
      assert.equal(page.nextCursor, undefined, `${method} returned a cursor`);
      assert.equal(wire.get(method).nextCursor, undefined, method);
      assertHint(wire.get(method), LIST_CACHE_HINTS[method], method);
    }
  });
});
