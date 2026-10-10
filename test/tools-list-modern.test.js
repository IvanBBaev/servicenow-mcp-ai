// N-35 step 2 item 7: tools/list measured on the 2026-07-28 wire, apart from
// the legacy byte budget in test/output-schema.test.js. A modern request goes
// in process through the SDK's `createMcpHandler` (the handler the HTTP
// transport serves) to a server built by `buildMcpServer`, for every surface
// profile. The tools array must equal the legacy one byte for byte, so the
// legacy budget covers both wires; what the modern result adds around it (the
// envelope) is measured and capped here.
import test from "node:test";
import assert from "node:assert/strict";

import { createMcpHandler } from "@modelcontextprotocol/server";

import { buildMcpServer } from "../build/server.js";
import { currentRuntime } from "../build/core/runtime.js";
import { withEnv } from "./helpers.js";
import { listPublishedTools, PROFILES } from "./surface.js";

const MODERN = "2026-07-28";

/**
 * Bytes a modern tools/list result may add to the tools array: `resultType`,
 * the N-38 cache hints and the SDK's `_meta` server info stamp. Measured
 * 2026-10-10 at 962 B on every profile, most of it the M-1 data-URI icon in
 * the server info; the cap leaves room for a longer version string.
 */
const MAX_MODERN_ENVELOPE_BYTES = 1024;

const size = (value) => JSON.stringify(value).length;

/** One modern tools/list result (every page) under the profile's env. */
async function listModern(env) {
  return withEnv(
    {
      SN_TOOL_PACKAGES: undefined,
      SN_EXPERIMENTAL_TASKS: undefined,
      SN_LEGACY_TOOL_NAMES: undefined,
      ...env,
    },
    async () => {
      const handler = createMcpHandler(() => buildMcpServer(currentRuntime()), {
        legacy: "reject",
      });
      try {
        const pages = [];
        let cursor;
        do {
          const response = await handler.fetch(
            new Request("http://localhost/mcp", {
              method: "POST",
              headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json",
                "mcp-protocol-version": MODERN,
                "mcp-method": "tools/list",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
                params: {
                  ...(cursor ? { cursor } : {}),
                  _meta: {
                    "io.modelcontextprotocol/protocolVersion": MODERN,
                    "io.modelcontextprotocol/clientInfo": {
                      name: "surface-modern",
                      version: "0.0.0",
                    },
                    "io.modelcontextprotocol/clientCapabilities": {},
                  },
                },
              }),
            }),
          );
          const text = await response.text();
          const message = response.headers
            .get("content-type")
            ?.includes("text/event-stream")
            ? JSON.parse(
                text
                  .split("\n")
                  .filter((l) => l.startsWith("data:"))
                  .at(-1)
                  .slice(5),
              )
            : JSON.parse(text);
          assert.equal(message.error, undefined, JSON.stringify(message.error));
          pages.push(message.result);
          cursor = message.result.nextCursor;
        } while (cursor);
        return pages;
      } finally {
        await handler.close();
      }
    },
  );
}

for (const [profile, env] of Object.entries(PROFILES)) {
  test(`modern tools/list: ${profile} equals the legacy list, envelope capped (N-35)`, async () => {
    const pages = await listModern(env);
    assert.equal(pages.length, 1, "one page, as on the legacy wire");
    const [result] = pages;
    assert.equal(result.resultType, "complete");

    const legacy = await listPublishedTools(env);
    assert.equal(
      size(result.tools),
      size(legacy),
      `${profile}: the legacy budget covers the modern wire`,
    );
    assert.deepEqual(result.tools, legacy);

    const envelope = size(result) - size(result.tools);
    assert.ok(
      envelope <= MAX_MODERN_ENVELOPE_BYTES,
      `${profile}: modern envelope ${envelope} B > ${MAX_MODERN_ENVELOPE_BYTES} B`,
    );
  });
}
