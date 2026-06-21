import test from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getTransport,
  getHttpPort,
  getHttpHost,
  getHttpToken,
} from "../build/core/settings.js";
import { connectTransport, httpAuthorized } from "../build/mcp/transport.js";
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

test("HTTP host defaults to loopback; SN_HTTP_HOST overrides (guard)", async () => {
  assert.equal(getHttpHost(), "127.0.0.1");
  await withEnv({ SN_HTTP_HOST: "0.0.0.0" }, () =>
    assert.equal(getHttpHost(), "0.0.0.0"),
  );
});

test("HTTP token is unset by default; SN_HTTP_TOKEN sets it (guard)", async () => {
  assert.equal(getHttpToken(), undefined);
  await withEnv({ SN_HTTP_TOKEN: "s3cr3t" }, () =>
    assert.equal(getHttpToken(), "s3cr3t"),
  );
});

test("httpAuthorized accepts the exact bearer and rejects everything else", () => {
  assert.equal(httpAuthorized("Bearer s3cr3t", "s3cr3t"), true);
  assert.equal(httpAuthorized("Bearer wrong", "s3cr3t"), false);
  assert.equal(httpAuthorized("s3cr3t", "s3cr3t"), false); // no Bearer prefix
  assert.equal(httpAuthorized(undefined, "s3cr3t"), false);
  assert.equal(httpAuthorized("Bearer ", "s3cr3t"), false);
});
