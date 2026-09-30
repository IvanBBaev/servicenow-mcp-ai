// H-7 — HTTP transport v2: one transport + McpServer per session, session-
// scoped profiles, DNS-rebinding protection (Host / Origin), bearer auth,
// /healthz and /readyz, the idle TTL, the session cap, the require-token
// opt-in and an end-to-end run with the SDK's StreamableHTTPClientTransport.
import test from "node:test";
import assert from "node:assert/strict";
import {
  request as httpRequest,
  createServer as createHttpServer,
} from "node:http";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  connectTransport,
  closeHttpTransport,
  hostAllowed,
  originAllowed,
  resolveAllowedHosts,
  resetReadyProbe,
  LOOPBACK_HOST_NAMES,
} from "../build/mcp/transport.js";
import {
  HttpSessionManager,
  httpSessionInfo,
  MAX_INIT_BODY_BYTES,
} from "../build/mcp/http-sessions.js";
import { buildMcpServer } from "../build/server.js";
import {
  createRuntime,
  currentRuntime,
  defineRuntimePart,
} from "../build/core/runtime.js";
import {
  getHttpSessionTtlSec,
  getHttpKeepAliveMs,
  getHttpMaxSessions,
  getHttpAllowedHosts,
  getHttpAllowedOrigins,
  httpRequireToken,
} from "../build/core/settings.js";
import { activeProfile } from "../build/core/profile.js";
import { runInSession } from "../build/core/request-context.js";
import { readWriteJournal } from "../build/core/write-journal.js";
import {
  baselineEnv,
  flushAsync,
  jsonResponse,
  realFetch,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

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

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "h7-test", version: "0" },
  },
};

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

/** A raw request so the Host header can be set (fetch forbids it). */
function rawRequest(
  port,
  { method = "GET", path: p = "/", headers = {}, body },
) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method, path: p, headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, text }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Start the real HTTP transport with the production server factory. */
async function withHttp(env, fn, factory = (rt) => buildMcpServer(rt)) {
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
      assert.equal(await connectTransport(factory), "http");
      try {
        await fn(port, `http://127.0.0.1:${port}/`);
      } finally {
        await closeHttpTransport();
      }
    },
  );
}

async function connectClient(url, headers = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
    fetch: realFetch,
  });
  const client = new Client({ name: "h7-client", version: "0" });
  await client.connect(transport);
  return { client, transport };
}

const payload = (result) => {
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent ?? JSON.parse(result.content[0].text);
};

// ---------------------------------------------------------------------------
// Settings and security helpers
// ---------------------------------------------------------------------------

test("H-7 settings: defaults and overrides", async () => {
  await withEnv(
    {
      SN_HTTP_SESSION_TTL_SEC: undefined,
      SN_HTTP_KEEPALIVE_MS: undefined,
      SN_HTTP_MAX_SESSIONS: undefined,
      SN_HTTP_ALLOWED_HOSTS: undefined,
      SN_HTTP_ALLOWED_ORIGINS: undefined,
      SN_HTTP_REQUIRE_TOKEN: undefined,
    },
    () => {
      assert.equal(getHttpSessionTtlSec(), 1800);
      assert.equal(getHttpKeepAliveMs(), 25_000);
      assert.equal(getHttpMaxSessions(), 64);
      assert.deepEqual(getHttpAllowedHosts(), []);
      assert.deepEqual(getHttpAllowedOrigins(), []);
      assert.equal(httpRequireToken(), false);
    },
  );
  await withEnv(
    {
      SN_HTTP_SESSION_TTL_SEC: "0",
      SN_HTTP_KEEPALIVE_MS: "0",
      SN_HTTP_MAX_SESSIONS: "3",
      SN_HTTP_ALLOWED_HOSTS: "MCP.example.com, proxy:8443",
      SN_HTTP_ALLOWED_ORIGINS: "https://App.example.com",
      SN_HTTP_REQUIRE_TOKEN: "true",
    },
    () => {
      assert.equal(getHttpSessionTtlSec(), 0);
      assert.equal(getHttpKeepAliveMs(), 0);
      assert.equal(getHttpMaxSessions(), 3);
      assert.deepEqual(getHttpAllowedHosts(), [
        "mcp.example.com",
        "proxy:8443",
      ]);
      assert.deepEqual(getHttpAllowedOrigins(), ["https://app.example.com"]);
      assert.equal(httpRequireToken(), true);
    },
  );
});

test("resolveAllowedHosts: env list, loopback defaults, none on a public bind", async () => {
  await withEnv({ SN_HTTP_ALLOWED_HOSTS: undefined }, () => {
    assert.deepEqual(resolveAllowedHosts("127.0.0.1"), LOOPBACK_HOST_NAMES);
    assert.deepEqual(resolveAllowedHosts("localhost"), LOOPBACK_HOST_NAMES);
    assert.equal(resolveAllowedHosts("0.0.0.0"), null);
  });
  await withEnv({ SN_HTTP_ALLOWED_HOSTS: "mcp.internal" }, () => {
    assert.deepEqual(resolveAllowedHosts("0.0.0.0"), ["mcp.internal"]);
    assert.deepEqual(resolveAllowedHosts("127.0.0.1"), ["mcp.internal"]);
  });
});

test("hostAllowed: name on any port, name:port exactly, IPv6, missing header", () => {
  const list = ["localhost", "127.0.0.1", "[::1]", "proxy:8443"];
  assert.equal(hostAllowed("localhost:3000", list), true);
  assert.equal(hostAllowed("LOCALHOST", list), true);
  assert.equal(hostAllowed("127.0.0.1:1", list), true);
  assert.equal(hostAllowed("[::1]:3000", list), true);
  assert.equal(hostAllowed("proxy:8443", list), true);
  assert.equal(hostAllowed("proxy:8444", list), false);
  assert.equal(hostAllowed("proxy", list), false);
  assert.equal(hostAllowed("evil.example:3000", list), false);
  assert.equal(hostAllowed(undefined, list), false);
  assert.equal(hostAllowed("anything", null), true);
});

test("originAllowed: no Origin passes, loopback default, exact list, wildcard", () => {
  assert.equal(originAllowed(undefined, []), true);
  assert.equal(originAllowed("http://localhost:5173", []), true);
  assert.equal(originAllowed("https://127.0.0.1", []), true);
  assert.equal(originAllowed("http://[::1]:8080", []), true);
  assert.equal(originAllowed("https://evil.example", []), false);
  assert.equal(originAllowed("http://localhost.evil.example", []), false);
  const list = ["https://app.example.com"];
  assert.equal(originAllowed("https://app.example.com/", list), true);
  assert.equal(originAllowed("https://APP.example.com", list), true);
  assert.equal(originAllowed("http://app.example.com", list), false);
  assert.equal(originAllowed("http://localhost:5173", list), false);
  assert.equal(originAllowed("https://anything.example", ["*"]), true);
});

// ---------------------------------------------------------------------------
// Runtime scopes and the session profile
// ---------------------------------------------------------------------------

test("a child runtime shares process parts and owns session parts", async () => {
  const shared = defineRuntimePart("h7-shared", () => ({ n: 0 }), undefined, {
    scope: "process",
  });
  const own = defineRuntimePart("h7-own", () => ({ n: 0 }));
  const parent = createRuntime();
  const a = createRuntime({ parent });
  const b = createRuntime({ parent });
  assert.equal(a.parent, parent);
  assert.equal(a.get(shared), b.get(shared));
  assert.equal(a.get(shared), parent.get(shared));
  assert.notEqual(a.get(own), b.get(own));
  const sharedState = a.get(shared);
  await a.dispose();
  assert.equal(
    parent.get(shared),
    sharedState,
    "a child never clears shared parts",
  );
  await parent.dispose();
});

test("activeProfile: the session profile sits between the request and the env", async () => {
  await withEnv({ SN_ACTIVE_PROFILE: "envprof" }, () => {
    assert.equal(activeProfile(), "envprof");
    runInSession({ id: "s1", profile: "sessprof" }, () => {
      assert.equal(activeProfile(), "sessprof");
    });
    runInSession({ id: "s2" }, () => {
      assert.equal(activeProfile(), "envprof");
    });
  });
});

// ---------------------------------------------------------------------------
// End to end — the SDK client over a real listener
// ---------------------------------------------------------------------------

test("e2e: two concurrent sessions on different profiles do not cross-talk", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "snmcp-h7-"));
  const envFile = path.join(dir, ".env");
  try {
    await withHttp(
      {
        SN_ENV_FILE: envFile,
        SN_DOCS_DIR: dir,
        SN_PROFILE_DEV_INSTANCE: "dev11111.service-now.com",
        SN_PROFILE_DEV_USER: "bob",
        SN_PROFILE_DEV_PASSWORD: "dev-pw",
      },
      async (_port, url) => {
        const a = await connectClient(url);
        const b = await connectClient(url);
        try {
          assert.ok(a.transport.sessionId);
          assert.ok(b.transport.sessionId);
          assert.notEqual(a.transport.sessionId, b.transport.sessionId);

          const switched = payload(
            await a.client.callTool({
              name: "servicenow_use_instance",
              arguments: { name: "dev" },
            }),
          );
          assert.equal(switched.scope, "session");
          assert.equal(switched.persisted, false);
          assert.equal(
            existsSync(envFile),
            false,
            "no env write without persist",
          );
          assert.equal(process.env.SN_ACTIVE_PROFILE, undefined);

          const [statusA, statusB] = await Promise.all([
            a.client.callTool({ name: "servicenow_get_status", arguments: {} }),
            b.client.callTool({ name: "servicenow_get_status", arguments: {} }),
          ]).then((r) => r.map(payload));
          assert.equal(statusA.activeProfile, "dev");
          assert.equal(statusA.profileSource.source, "session");
          assert.match(statusA.instance, /dev11111/);
          assert.equal(statusA.server.http.sessionId, a.transport.sessionId);
          assert.equal(statusA.server.http.sessions, 2);
          assert.equal(statusB.activeProfile, "default");
          assert.match(statusB.instance, /dev00000/);
          assert.equal(statusB.server.http.sessionId, b.transport.sessionId);

          // Concurrent instance calls reach each session's own instance.
          await withFetch(
            (u, init) =>
              u.includes("service-now.com")
                ? jsonResponse(200, { result: [{ sys_id: "x" }] })
                : realFetch(u, init),
            async (calls) => {
              const [ra, rb] = await Promise.all([
                a.client.callTool({
                  name: "servicenow_test_connection",
                  arguments: {},
                }),
                b.client.callTool({
                  name: "servicenow_test_connection",
                  arguments: {},
                }),
              ]);
              assert.ok(!ra.isError && !rb.isError);
              const hosts = calls
                .map((c) => c.url)
                .filter((u) => u.includes("service-now.com"))
                .map((u) => new URL(u).host)
                .sort();
              assert.deepEqual(hosts, [
                "dev00000.service-now.com",
                "dev11111.service-now.com",
              ]);
            },
          );

          // A package toggle is per session as well.
          payload(
            await a.client.callTool({
              name: "servicenow_enable_package",
              arguments: { name: "cmdb" },
            }),
          );
          const toolsA = (await a.client.listTools()).tools.map((t) => t.name);
          const toolsB = (await b.client.listTools()).tools.map((t) => t.name);
          assert.ok(toolsA.length > toolsB.length, "B kept its package set");
        } finally {
          await a.client.close();
          await b.client.close();
        }
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: use_instance persist:true over HTTP writes the env file and journals it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "snmcp-h7-"));
  const envFile = path.join(dir, ".env");
  try {
    await withHttp(
      {
        SN_ENV_FILE: envFile,
        SN_DOCS_DIR: dir,
        SN_ACTIVE_PROFILE: undefined,
        SN_PROFILE_DEV_INSTANCE: "dev11111.service-now.com",
        SN_PROFILE_DEV_USER: "bob",
        SN_PROFILE_DEV_PASSWORD: "dev-pw",
      },
      async (_port, url) => {
        const a = await connectClient(url);
        try {
          const switched = payload(
            await a.client.callTool({
              name: "servicenow_use_instance",
              arguments: { name: "dev", persist: true },
            }),
          );
          assert.equal(switched.scope, "session");
          assert.equal(switched.persisted, true);
          const saved = dotenv.parse(readFileSync(envFile, "utf8"));
          assert.equal(saved.SN_ACTIVE_PROFILE, "dev");
          const { entries } = readWriteJournal({ action: "config" });
          assert.ok(
            entries.some((e) => e.keys?.includes("SN_ACTIVE_PROFILE")),
            JSON.stringify(entries),
          );
          const bad = await a.client.callTool({
            name: "servicenow_use_instance",
            arguments: { name: "nope" },
          });
          assert.equal(bad.isError, true);
        } finally {
          await a.client.close();
        }
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: DELETE ends a session (404 afterwards) and the client can reconnect", async () => {
  await withHttp({}, async (port, url) => {
    const first = await connectClient(url);
    const oldId = first.transport.sessionId;
    await first.transport.terminateSession();
    await first.client.close();
    assert.equal(httpSessionInfo().sessions, 0);

    const stale = await rawRequest(port, {
      method: "POST",
      headers: { ...MCP_HEADERS, "mcp-session-id": oldId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    assert.equal(stale.status, 404);
    assert.equal(JSON.parse(stale.text).error.code, -32001);

    const again = await connectClient(url);
    try {
      assert.ok(again.transport.sessionId);
      assert.notEqual(again.transport.sessionId, oldId);
      await again.client.ping();
    } finally {
      await again.client.close();
    }
  });
});

test("HTTP: requests without a valid session are refused with JSON-RPC errors", async () => {
  await withHttp({ SN_HTTP_MAX_SESSIONS: "1" }, async (port) => {
    const get = await rawRequest(port, { method: "GET", headers: MCP_HEADERS });
    assert.equal(get.status, 400);
    const notInit = await rawRequest(port, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(notInit.status, 400);
    const badJson = await rawRequest(port, {
      method: "POST",
      headers: MCP_HEADERS,
      body: "{nope",
    });
    assert.equal(badJson.status, 400);
    assert.equal(JSON.parse(badJson.text).error.code, -32700);
    const tooBig = await rawRequest(port, {
      method: "POST",
      headers: MCP_HEADERS,
      body: "x".repeat(MAX_INIT_BODY_BYTES + 1),
    });
    assert.equal(tooBig.status, 413);

    const init = await rawRequest(port, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(INIT),
    });
    assert.equal(init.status, 200);
    const capped = await rawRequest(port, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(INIT),
    });
    assert.equal(capped.status, 503, "SN_HTTP_MAX_SESSIONS caps sessions");
    assert.equal(capped.headers["retry-after"], "5");
  });
});

test("HTTP: a failed initialize releases what was built for it", async () => {
  let disposed = 0;
  await withHttp(
    {},
    async (port) => {
      // Accept header without text/event-stream: the SDK refuses with 406
      // before a session id is issued.
      const res = await rawRequest(port, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/html" },
        body: JSON.stringify(INIT),
      });
      assert.equal(res.status, 406);
      await flushAsync();
      assert.equal(disposed, 1);
      assert.equal(httpSessionInfo().sessions, 0);
    },
    (rt) => {
      rt.onDispose(() => {
        disposed += 1;
      });
      return new McpServer({ name: "h7", version: "0" });
    },
  );
});

test("DNS rebinding: a foreign Host or Origin is refused with 403", async () => {
  await withHttp({}, async (port) => {
    const badHost = await rawRequest(port, {
      method: "POST",
      headers: { ...MCP_HEADERS, host: `evil.example:${port}` },
      body: JSON.stringify(INIT),
    });
    assert.equal(badHost.status, 403);
    assert.match(JSON.parse(badHost.text).error.message, /Host/);

    const badOrigin = await rawRequest(port, {
      method: "POST",
      headers: { ...MCP_HEADERS, origin: "https://evil.example" },
      body: JSON.stringify(INIT),
    });
    assert.equal(badOrigin.status, 403);
    assert.match(JSON.parse(badOrigin.text).error.message, /Origin/);

    const goodOrigin = await rawRequest(port, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        host: `localhost:${port}`,
        origin: "http://localhost:5173",
      },
      body: JSON.stringify(INIT),
    });
    assert.equal(goodOrigin.status, 200);
  });
  await withHttp(
    {
      SN_HTTP_ALLOWED_HOSTS: "mcp.example.com",
      SN_HTTP_ALLOWED_ORIGINS: "https://app.example.com",
    },
    async (port) => {
      const loopbackName = await rawRequest(port, {
        method: "GET",
        path: "/metrics",
      });
      assert.equal(
        loopbackName.status,
        403,
        "the env list replaces the defaults",
      );
      const ok = await rawRequest(port, {
        method: "POST",
        headers: {
          ...MCP_HEADERS,
          host: "mcp.example.com",
          origin: "https://app.example.com",
        },
        body: JSON.stringify(INIT),
      });
      assert.equal(ok.status, 200);
    },
  );
});

test("bearer: MCP requests need the token; /healthz and plain /readyz do not", async () => {
  resetReadyProbe();
  await withHttp({ SN_HTTP_TOKEN: "h7-token" }, async (port, url) => {
    const anon = await rawRequest(port, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(INIT),
    });
    assert.equal(anon.status, 401);
    assert.equal(anon.headers["www-authenticate"], "Bearer");

    const health = await rawRequest(port, { path: "/healthz" });
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.text), { status: "ok" });
    const ready = await rawRequest(port, { path: "/readyz" });
    assert.equal(ready.status, 200);
    assert.equal(JSON.parse(ready.text).status, "ready");

    const probeAnon = await rawRequest(port, { path: "/readyz?probe=1" });
    assert.equal(probeAnon.status, 401, "the deep probe sits behind the token");

    const auth = { authorization: "Bearer h7-token" };
    await withFetch(
      () => jsonResponse(200, { result: [{ sys_id: "x" }] }),
      async (calls) => {
        const probed = await rawRequest(port, {
          path: "/readyz?probe=1",
          headers: auth,
        });
        assert.equal(probed.status, 200);
        const body = JSON.parse(probed.text);
        assert.equal(body.ok, true);
        assert.equal(body.instanceStatus, 200);
        await rawRequest(port, { path: "/readyz?probe=1", headers: auth });
        assert.equal(calls.length, 1, "the probe result is cached briefly");
      },
    );
    resetReadyProbe();
    await withFetch(
      () => jsonResponse(401, { error: { message: "no" } }),
      async () => {
        const probed = await rawRequest(port, {
          path: "/readyz?probe=1",
          headers: auth,
        });
        assert.equal(probed.status, 503);
        assert.equal(JSON.parse(probed.text).ok, false);
      },
    );
    resetReadyProbe();

    const client = await connectClient(url, auth);
    try {
      await client.client.ping();
    } finally {
      await client.client.close();
    }
  });
});

test("/readyz answers 503 without credentials", async () => {
  resetReadyProbe();
  await withHttp(
    { SN_INSTANCE: undefined, SN_USER: undefined, SN_PASSWORD: undefined },
    async (port) => {
      const ready = await rawRequest(port, { path: "/readyz" });
      assert.equal(ready.status, 503);
      assert.equal(JSON.parse(ready.text).status, "not-configured");
      const probed = await rawRequest(port, { path: "/readyz?probe=1" });
      assert.equal(probed.status, 503);
    },
  );
});

test("SN_HTTP_REQUIRE_TOKEN refuses a public bind without a token; the default only warns", async () => {
  const port = await freePort();
  const factory = () => new McpServer({ name: "h7", version: "0" });
  await withEnv(
    {
      SN_TRANSPORT: "http",
      SN_PORT: String(port),
      SN_HTTP_HOST: "0.0.0.0",
      SN_HTTP_TOKEN: undefined,
      SN_HTTP_TOKEN_FILE: undefined,
      SN_LOG_LEVEL: "error",
    },
    async () => {
      await withEnv({ SN_HTTP_REQUIRE_TOKEN: "1" }, async () => {
        await assert.rejects(connectTransport(factory), /Refusing to bind/);
      });
      await withEnv({ SN_HTTP_REQUIRE_TOKEN: undefined }, async () => {
        try {
          assert.equal(await connectTransport(factory), "http");
        } finally {
          await closeHttpTransport();
        }
      });
    },
  );
});

test("graceful shutdown: an in-flight call finishes before its session closes", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const factory = () => {
    const s = new McpServer({ name: "h7", version: "0" });
    s.registerTool("slow", { description: "slow" }, async () => {
      await gate;
      return { content: [{ type: "text", text: "done" }] };
    });
    return s;
  };
  const port = await freePort();
  await withEnv(
    {
      SN_TRANSPORT: "http",
      SN_PORT: String(port),
      SN_HTTP_HOST: "127.0.0.1",
      SN_HTTP_TOKEN: undefined,
      SN_LOG_LEVEL: "error",
    },
    async () => {
      await connectTransport(factory);
      const { client } = await connectClient(`http://127.0.0.1:${port}/`);
      const call = client.callTool({ name: "slow", arguments: {} });
      await new Promise((r) => setTimeout(r, 50));
      const closing = closeHttpTransport(2_000);
      await new Promise((r) => setTimeout(r, 20));
      release();
      const result = await call;
      assert.equal(result.content[0].text, "done");
      await closing;
      await client.close().catch(() => undefined);
      assert.equal(httpSessionInfo().sessions, 0);
    },
  );
});

// ---------------------------------------------------------------------------
// Idle TTL — fake timers drive the sweeper, an injected clock ages sessions
// ---------------------------------------------------------------------------

test("idle TTL: the sweeper closes a session idle past SN_HTTP_SESSION_TTL_SEC", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let clock = 1_000_000;
  let disposed = 0;
  const manager = new HttpSessionManager({
    factory: (rt) => {
      rt.onDispose(() => {
        disposed += 1;
      });
      return new McpServer({ name: "h7-ttl", version: "0" });
    },
    parent: currentRuntime(),
    ttlMs: 1_000,
    keepAliveMs: 0,
    maxSessions: 4,
    now: () => clock,
  });
  const server = createHttpServer((req, res) => void manager.handle(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const init = await rawRequest(port, {
      method: "POST",
      headers: MCP_HEADERS,
      body: JSON.stringify(INIT),
    });
    assert.equal(init.status, 200);
    const sid = init.headers["mcp-session-id"];
    assert.ok(manager.has(sid));

    clock += 500;
    t.mock.timers.tick(1_000);
    await flushAsync(10);
    assert.ok(manager.has(sid), "not idle long enough");

    clock += 600;
    t.mock.timers.tick(1_000);
    await flushAsync(10);
    assert.equal(manager.has(sid), false, "expired after the TTL");
    assert.equal(disposed, 1, "its runtime was disposed");

    const after = await rawRequest(port, {
      method: "POST",
      headers: { ...MCP_HEADERS, "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    assert.equal(after.status, 404);
  } finally {
    await manager.closeAll();
    await new Promise((r) => server.close(r));
  }
});

test("idle TTL 0 keeps sessions until DELETE", async () => {
  const manager = new HttpSessionManager({
    factory: () => new McpServer({ name: "h7", version: "0" }),
    parent: currentRuntime(),
    ttlMs: 0,
    keepAliveMs: 0,
    maxSessions: 1,
  });
  assert.deepEqual(await manager.sweep(Number.MAX_SAFE_INTEGER), []);
  await manager.closeAll();
});
