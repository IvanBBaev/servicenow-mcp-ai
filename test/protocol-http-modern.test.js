import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";

import {
  connectTransport,
  closeHttpTransport,
} from "../build/mcp/transport.js";
import { buildMcpServer } from "../build/server.js";
import { PROFILES, listPublishedTools } from "./surface.js";
import { baselineEnv, jsonResponse, withEnv, withFetch } from "./helpers.js";

/**
 * N-35 / ADR 0008, conformance step `http`: the 2026-07-28 Streamable HTTP
 * rules on the shipped transport (`connectTransport` with the production
 * server factory). Every request is a raw POST, so the tests set the
 * standard headers (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`) by hand
 * and read the HTTP status, content type and SSE frames as a client would.
 */

baselineEnv();

const MODERN = "2026-07-28";
const ACCEPT = "application/json, text/event-stream";

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

/** Start the real HTTP transport; `fn` gets the port. */
async function withHttp(fn, env = {}) {
  const port = await freePort();
  await withEnv(
    {
      SN_TRANSPORT: "http",
      SN_PORT: String(port),
      SN_HTTP_HOST: "127.0.0.1",
      SN_HTTP_TOKEN: undefined,
      SN_LOG_LEVEL: "error",
      ...env,
    },
    async () => {
      assert.equal(await connectTransport((rt) => buildMcpServer(rt)), "http");
      try {
        await fn(port);
      } finally {
        await closeHttpTransport();
      }
    },
  );
}

/** The envelope every 2026-07-28 request carries in `params._meta`. */
const envelope = (extra = {}) => ({
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "http-step", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
  ...extra,
});

/** Standard headers for `method` (and `name`), overridable per test. */
const headersFor = (method, name, extra = {}) => ({
  "content-type": "application/json",
  accept: ACCEPT,
  "mcp-protocol-version": MODERN,
  "mcp-method": method,
  ...(name === undefined ? {} : { "mcp-name": name }),
  ...extra,
});

const rpc = (method, params, id = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

/** One raw POST: status, headers, body text and the parsed messages. */
function post(port, headers, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: "POST", path: "/", headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          const sse =
            res.headers["content-type"]?.includes("text/event-stream");
          const messages = sse
            ? text
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => JSON.parse(l.slice(5)))
            : text
              ? [JSON.parse(text)]
              : [];
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            messages,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const STATUS = "servicenow_get_status";
const statusCall = (meta = envelope()) =>
  rpc("tools/call", { name: STATUS, arguments: {}, _meta: meta });

/** Asserts a 400 whose JSON-RPC error carries `code`; returns the error. */
function assertRefused(res, code, status = 400) {
  assert.equal(res.status, status, res.text);
  assert.match(res.headers["content-type"], /application\/json/);
  const [message] = res.messages;
  assert.equal(message.error?.code, code, res.text);
  return message.error;
}

const tableRows = () =>
  jsonResponse(200, { result: [{ sys_id: "a1" }] }, { "x-total-count": "1" });

test("modern HTTP: a request is answered as JSON or as SSE that carries X-Accel-Buffering: no, only its own notifications and ends with the response", async () => {
  await withHttp(
    async (port) => {
      const json = await post(
        port,
        headersFor("tools/call", STATUS),
        statusCall(),
      );
      assert.equal(json.status, 200);
      assert.match(json.headers["content-type"], /^application\/json/);
      assert.equal(json.messages.length, 1);
      assert.equal(json.messages[0].id, 1);

      await withFetch(tableRows, async () => {
        const res = await post(
          port,
          headersFor("tools/call", "servicenow_query_table"),
          rpc(
            "tools/call",
            {
              name: "servicenow_query_table",
              arguments: { table: "incident", limit: 1 },
              _meta: envelope({
                progressToken: 41,
                "io.modelcontextprotocol/logLevel": "debug",
              }),
            },
            41,
          ),
        );
        assert.equal(res.status, 200);
        assert.match(res.headers["content-type"], /^text\/event-stream/);
        assert.equal(res.headers["x-accel-buffering"], "no");
        const notifications = res.messages.slice(0, -1);
        assert.ok(notifications.length > 0, "the debug lines stream first");
        for (const n of notifications) {
          assert.equal(n.id, undefined, "no request on the stream");
          if (n.method === "notifications/progress") {
            assert.equal(n.params.progressToken, 41);
          } else {
            assert.equal(n.method, "notifications/message");
            assert.equal(n.params.data.requestId, "41", JSON.stringify(n));
          }
        }
        // The response is the last frame, and the stream ended after it.
        assert.equal(res.messages.at(-1).id, 41);
        assert.ok(res.messages.at(-1).result, res.text);
      });
    },
    { SN_LOG_LEVEL: "debug" },
  );
});

test("modern HTTP: an accepted notification gets 202 with no body; a malformed one an HTTP error", async () => {
  await withHttp(async (port) => {
    const accepted = await post(
      port,
      headersFor("notifications/cancelled"),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 9, _meta: envelope() },
      }),
    );
    assert.equal(accepted.status, 202);
    assert.equal(accepted.text, "");

    const malformed = await post(
      port,
      headersFor("notifications/cancelled"),
      "{not json",
    );
    assert.equal(malformed.status, 400);
    assert.equal(malformed.messages[0].error.code, -32700);
  });
});

test("modern HTTP: MCP-Protocol-Version must match the envelope, name a supported version and be present", async () => {
  await withHttp(async (port) => {
    // The header and the body envelope disagree: HeaderMismatch.
    assertRefused(
      await post(
        port,
        headersFor("tools/call", STATUS),
        statusCall(
          envelope({ "io.modelcontextprotocol/protocolVersion": "2025-11-25" }),
        ),
      ),
      -32020,
    );
    // A version the server does not implement: the supported list.
    const unsupported = assertRefused(
      await post(
        port,
        headersFor("tools/call", STATUS, {
          "mcp-protocol-version": "2099-01-01",
        }),
        statusCall(
          envelope({ "io.modelcontextprotocol/protocolVersion": "2099-01-01" }),
        ),
      ),
      -32022,
    );
    assert.ok(unsupported.data.supported.includes(MODERN));
    // A modern body without the header: refused, not read as 2025-03-26.
    const headers = headersFor("tools/call", STATUS);
    delete headers["mcp-protocol-version"];
    assertRefused(await post(port, headers, statusCall()), -32020);
  });
});

test("modern HTTP: an unknown method is 404 with -32601", async () => {
  await withHttp(async (port) => {
    assertRefused(
      await post(
        port,
        headersFor("foo/bar"),
        rpc("foo/bar", { _meta: envelope() }),
      ),
      -32601,
      404,
    );
  });
});

test("modern HTTP: Mcp-Method and Mcp-Name are required and must match the body", async () => {
  await withHttp(async (port) => {
    const noMethod = headersFor("tools/call", STATUS);
    delete noMethod["mcp-method"];
    assertRefused(await post(port, noMethod, statusCall()), -32020);
    assertRefused(
      await post(port, headersFor("tools/list", STATUS), statusCall()),
      -32020,
    );
    assertRefused(
      await post(port, headersFor("tools/call"), statusCall()),
      -32020,
    );
    assertRefused(
      await post(
        port,
        headersFor("tools/call", "servicenow_list_instances"),
        statusCall(),
      ),
      -32020,
    );

    const uri = "servicenow://reference/encoded-query";
    const read = rpc("resources/read", { uri, _meta: envelope() });
    assertRefused(
      await post(port, headersFor("resources/read", `${uri}x`), read),
      -32020,
    );
    assert.equal(
      (await post(port, headersFor("resources/read", uri), read)).status,
      200,
    );

    const prompt = rpc("prompts/get", {
      name: "servicenow_instance_overview",
      _meta: envelope(),
    });
    assertRefused(await post(port, headersFor("prompts/get"), prompt), -32020);
  });
});

test("modern HTTP: a Base64 sentinel Mcp-Name is decoded before the comparison; only the lowercase markers count", async () => {
  const sentinel = (s) => `=?base64?${Buffer.from(s).toString("base64")}?=`;
  await withHttp(async (port) => {
    const ok = await post(
      port,
      headersFor("tools/call", sentinel(STATUS)),
      statusCall(),
    );
    assert.equal(ok.status, 200, ok.text);
    assert.ok(ok.messages[0].result);

    // Uppercase markers are no sentinel: the raw value mismatches.
    assertRefused(
      await post(
        port,
        headersFor("tools/call", sentinel(STATUS).replace("base64", "BASE64")),
        statusCall(),
      ),
      -32020,
    );
    // An encoded value of another name, and a broken encoding.
    assertRefused(
      await post(
        port,
        headersFor("tools/call", sentinel("servicenow_list_instances")),
        statusCall(),
      ),
      -32020,
    );
    assertRefused(
      await post(
        port,
        headersFor("tools/call", "=?base64?!!!?="),
        statusCall(),
      ),
      -32020,
    );
  });
});

test("modern HTTP: header names compare case-insensitively, header values case-sensitively", async () => {
  await withHttp(async (port) => {
    const mixed = await post(
      port,
      {
        "Content-Type": "application/json",
        Accept: ACCEPT,
        "MCP-PROTOCOL-VERSION": MODERN,
        "MCP-Method": "tools/call",
        "mcp-NAME": STATUS,
      },
      statusCall(),
    );
    assert.equal(mixed.status, 200, mixed.text);
    assertRefused(
      await post(port, headersFor("TOOLS/CALL", STATUS), statusCall()),
      -32020,
    );
  });
});

test("modern HTTP: a malformed envelope and a missing client capability are refused with 400", async () => {
  await withHttp(async (port) => {
    assertRefused(
      await post(
        port,
        headersFor("tools/list"),
        rpc("tools/list", {
          _meta: { "io.modelcontextprotocol/protocolVersion": MODERN },
        }),
      ),
      -32602,
    );
    // Task notifications on a listen stream need the tasks extension.
    const missing = assertRefused(
      await post(
        port,
        headersFor("subscriptions/listen"),
        rpc("subscriptions/listen", {
          notifications: { taskIds: [] },
          _meta: envelope(),
        }),
      ),
      -32021,
    );
    assert.ok(missing.data.requiredCapabilities);
  });
});

test("modern HTTP: closing the response stream cancels the request and stops its upstream work", async () => {
  await withHttp(
    async (port) => {
      let started;
      let aborted;
      const startedP = new Promise((resolve) => (started = resolve));
      const abortedP = new Promise((resolve) => (aborted = resolve));
      await withFetch(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            started();
            init.signal.addEventListener("abort", () => {
              aborted(init.signal.reason);
              reject(init.signal.reason);
            });
          }),
        async (calls) => {
          let contentType;
          const frames = [];
          const req = httpRequest(
            {
              host: "127.0.0.1",
              port,
              method: "POST",
              path: "/",
              headers: headersFor("tools/call", "servicenow_query_table"),
            },
            (res) => {
              contentType = res.headers["content-type"];
              res.setEncoding("utf8");
              res.on("data", (chunk) => frames.push(chunk));
              res.on("error", () => {});
            },
          );
          req.on("error", () => {});
          req.end(
            rpc("tools/call", {
              name: "servicenow_query_table",
              arguments: { table: "incident", limit: 1 },
              _meta: envelope({ "io.modelcontextprotocol/logLevel": "debug" }),
            }),
          );
          await startedP;
          // Wait for the stream to open (the first debug line), then hang up.
          for (let i = 0; i < 100 && frames.length === 0; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.match(contentType, /^text\/event-stream/);
          req.destroy();
          const reason = await Promise.race([
            abortedP,
            new Promise((resolve) =>
              setTimeout(() => resolve("timeout"), 2000),
            ),
          ]);
          assert.notEqual(
            reason,
            "timeout",
            "the upstream call was not aborted",
          );
          await new Promise((resolve) => setTimeout(resolve, 100));
          assert.equal(calls.length, 1, "no work after the cancellation");
          assert.ok(
            !frames.join("").includes('"result"'),
            "no response for the cancelled request",
          );
        },
      );
    },
    { SN_LOG_LEVEL: "debug" },
  );
});

test("modern HTTP: no tool declares x-mcp-header, so no Mcp-Param header is expected and an unknown one is ignored", async () => {
  for (const profile of Object.keys(PROFILES)) {
    const tools = await listPublishedTools(PROFILES[profile]);
    for (const tool of tools) {
      assert.ok(
        !JSON.stringify(tool.inputSchema).includes('"x-mcp-header"'),
        `${profile} ${tool.name}`,
      );
    }
  }
  await withHttp(async (port) => {
    const res = await post(
      port,
      headersFor("tools/call", STATUS, {
        "mcp-param-region": "eu-west, unknown",
      }),
      statusCall(),
    );
    assert.equal(res.status, 200, res.text);
  });
});
