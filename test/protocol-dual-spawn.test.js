// N-35 / ADR 0008: the real stdio entry point (build/index.js) on the v2 SDK.
// Each test spawns the server with a sandboxed environment (no SN_* variables,
// no credentials, so nothing reaches a network) and connects with the v2
// client on the legacy `initialize` wire (2025-11-25). The 2026-07-28 cases
// (server/discover, auto negotiation, identical tools/list on both wires) land
// with the modern-era server factory (H-7).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = join(import.meta.dirname, "..");
const entry = join(root, "build", "index.js");

const LEGACY = "2025-11-25";

const sandbox = mkdtempSync(join(tmpdir(), "sn-dual-"));
test.after(() => rmSync(sandbox, { recursive: true, force: true }));

/** The parent environment minus every SN_* key, pointed at the sandbox. */
function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("SN_") && value !== undefined) {
      env[key] = value;
    }
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

/** Spawn build/index.js and connect with the given negotiation mode. */
async function connect(mode) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: cleanEnv(),
    cwd: sandbox,
    stderr: "ignore",
  });
  const client = new Client(
    { name: "dual-spawn-test", version: "0.0.0" },
    { versionNegotiation: { mode } },
  );
  await client.connect(transport);
  return client;
}

/** Run `body` against a connected client and always close it. */
async function withClient(mode, body) {
  const client = await connect(mode);
  try {
    return await body(client);
  } finally {
    await client.close();
  }
}

/** Every page of tools/list, sorted by name. */
async function allTools(client) {
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

test("legacy wire: initialize negotiates 2025-11-25 and serves tools", async () => {
  await withClient("legacy", async (client) => {
    assert.equal(client.getProtocolEra(), "legacy");
    assert.equal(client.getNegotiatedProtocolVersion(), LEGACY);
    assert.equal(client.getDiscoverResult(), undefined);
    assert.ok(client.getServerCapabilities()?.tools);

    const tools = await allTools(client);
    assert.ok(tools.some((t) => t.name === "servicenow_get_status"));

    const status = await client.callTool({
      name: "servicenow_get_status",
      arguments: {},
    });
    assert.notEqual(status.isError, true);
  });
});

test("pinning an unsupported revision fails loudly instead of falling back", async () => {
  await assert.rejects(connect({ pin: "2099-01-01" }));
});
