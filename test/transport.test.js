import test from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getTransport, getHttpPort } from "../build/core/settings.js";
import { connectTransport } from "../build/mcp/transport.js";
import { withEnv } from "./helpers.js";

test("transport defaults to stdio (DF-6)", () => {
  assert.equal(getTransport(), "stdio");
});

test("SN_TRANSPORT=http selects http (DF-6)", async () => {
  await withEnv({ SN_TRANSPORT: "http" }, () => {
    assert.equal(getTransport(), "http");
  });
});

test("getHttpPort defaults to 3000 and validates SN_PORT (DF-6)", async () => {
  assert.equal(getHttpPort(), 3000);
  await withEnv({ SN_PORT: "8080" }, () => assert.equal(getHttpPort(), 8080));
  await withEnv({ SN_PORT: "not-a-port" }, () =>
    assert.equal(getHttpPort(), 3000),
  );
  await withEnv({ SN_PORT: "70000" }, () => assert.equal(getHttpPort(), 3000));
});

test("connectTransport wires up stdio and reports the kind (DF-6)", async () => {
  const server = new McpServer({ name: "transport-test", version: "0.0.0" });
  try {
    const kind = await connectTransport(server);
    assert.equal(kind, "stdio");
  } finally {
    await server.close();
  }
});
