import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";

import {
  connectTransport,
  closeHttpTransport,
} from "../build/mcp/transport.js";
import { buildMcpServer } from "../build/server.js";
import { baselineEnv, jsonResponse, withEnv, withFetch } from "./helpers.js";

/**
 * N-35 / N-38, conformance rows cache-05 and cache-07: what `cacheScope`
 * promises and what it does not. A `public` result may be shared between
 * callers, so it must carry nothing about the caller, the instance or the
 * credentials; and since a shared list may come from another server, access
 * is enforced on every call, never by the scope. Driven against the shipped
 * modern HTTP transport with raw 2026-07-28 requests.
 */

baselineEnv();

const MODERN = "2026-07-28";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Start the real HTTP transport under `env`; `fn` gets a request function. */
async function withHttp(env, fn) {
  const port = await freePort();
  await withEnv(
    {
      SN_TRANSPORT: "http",
      SN_PORT: String(port),
      SN_HTTP_HOST: "127.0.0.1",
      SN_HTTP_TOKEN: undefined,
      SN_LOG_LEVEL: "error",
      SN_PACKAGES_DENY: "",
      SN_PACKAGES_READONLY: "",
      ...env,
    },
    async () => {
      assert.equal(await connectTransport((rt) => buildMcpServer(rt)), "http");
      try {
        await fn((method, params, clientInfo) =>
          call(port, method, params, clientInfo),
        );
      } finally {
        await closeHttpTransport();
      }
    },
  );
}

/** One raw 2026-07-28 POST; resolves to the JSON-RPC message. */
function call(
  port,
  method,
  params = {},
  clientInfo = { name: "a", version: "0" },
) {
  const name = params.name ?? params.uri;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN,
        "io.modelcontextprotocol/clientInfo": clientInfo,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MODERN,
          "mcp-method": method,
          ...(name === undefined ? {} : { "mcp-name": name }),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          const json = text.startsWith("{")
            ? text
            : text
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5))
                .at(-1);
          resolve(JSON.parse(json));
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** The public results a shared cache may hand to any caller. */
const PUBLIC = [
  ["tools/list", {}],
  ["prompts/list", {}],
  ["resources/templates/list", {}],
  ["resources/read", { uri: "servicenow://reference/encoded-query" }],
];

/** Every public result, as seen by one caller on one instance. */
async function publicResults(env, clientInfo) {
  const out = [];
  await withHttp(env, async (rpc) => {
    for (const [method, params] of PUBLIC) {
      const message = await rpc(method, params, clientInfo);
      assert.ok(message.result, JSON.stringify(message).slice(0, 300));
      assert.equal(message.result.cacheScope, "public", method);
      out.push(message.result);
    }
    // What does depend on the caller stays private.
    for (const [method, params] of [
      ["server/discover", {}],
      ["resources/list", {}],
      ["resources/read", { uri: "servicenow://status" }],
    ]) {
      const message = await rpc(method, params, clientInfo);
      assert.equal(message.result?.cacheScope, "private", method);
    }
  });
  return out;
}

test("cache scope: a public result carries nothing of the caller, the instance or the credentials — two callers get identical results", async () => {
  const alpha = await publicResults(
    {
      SN_INSTANCE: "alpha-tenant.service-now.com",
      SN_USER: "alpha-user",
      SN_PASSWORD: "alpha-secret",
    },
    { name: "client-alpha", version: "1.0.0" },
  );
  const beta = await publicResults(
    {
      SN_INSTANCE: "beta-tenant.service-now.com",
      SN_USER: "beta-user",
      SN_PASSWORD: "beta-secret",
    },
    { name: "client-beta", version: "9.9.9" },
  );
  assert.deepEqual(beta, alpha);
  const text = JSON.stringify(alpha);
  for (const leak of ["alpha-", "client-alpha", "dev00000", "s3cret"]) {
    assert.ok(!text.includes(leak), `a public result carries ${leak}`);
  }
});

test("cache scope: access is checked on every call, never inferred from a cached public list", async () => {
  // A shared tools/list may come from a server where these are allowed; here
  // they are not, and each call is refused without reaching the instance.
  await withHttp(
    { SN_TOOL_PACKAGES: "table", SN_TABLES_DENY: "sys_user" },
    async (rpc) => {
      await withFetch(
        () => jsonResponse(200, { result: [] }),
        async (calls) => {
          const notServed = await rpc("tools/call", {
            name: "servicenow_list_update_sets",
            arguments: {},
          });
          assert.ok(
            notServed.error || notServed.result?.isError,
            JSON.stringify(notServed),
          );

          const denied = await rpc("tools/call", {
            name: "servicenow_query_table",
            arguments: { table: "sys_user", limit: 1 },
          });
          assert.equal(denied.result?.isError, true, JSON.stringify(denied));
          assert.match(denied.result.content[0].text, /POLICY_DENIED|denied/i);

          assert.equal(calls.length, 0, "no instance call for a refused one");
        },
      );
    },
  );
});
