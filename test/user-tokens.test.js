// N-17 phase 2 — per-user ServiceNow tokens on the HTTP transport: an OAuth
// subject links its own ServiceNow account once (URL elicitation → the
// instance's authorize page → the callback), the refresh token is stored
// encrypted, and every later call reaches the instance as that user.
import test from "node:test";
import assert from "node:assert/strict";
import {
  request as httpRequest,
  createServer as createHttpServer,
} from "node:http";
import { createServer } from "node:net";
import {
  createDecipheriv,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
} from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  connectTransport,
  closeHttpTransport,
} from "../build/mcp/transport.js";
import { getHttpUserTokens } from "../build/core/settings.js";
import { getCredentials } from "../build/core/config.js";
import { cached, peekSchemaCache } from "../build/core/cache.js";
import { runInSession } from "../build/core/request-context.js";
import { CALLBACK_PATH, linkKey } from "../build/core/user-tokens.js";
import { buildMcpServer } from "../build/server.js";
import { baselineEnv, jsonResponse, withEnv, withFetch } from "./helpers.js";

baselineEnv();

const HOST = "dev00000.service-now.com";
const TOKEN_KEY = randomBytes(32);

// ---------------------------------------------------------------------------
// Settings, marker, cache
// ---------------------------------------------------------------------------

test("N-17 user tokens: the settings getter is off by default and validates its inputs", async () => {
  await withEnv({ SN_HTTP_OAUTH_USER_TOKENS: undefined }, async () => {
    assert.equal(getHttpUserTokens(), undefined);
  });
  const on = {
    SN_HTTP_OAUTH_USER_TOKENS: "true",
    SN_HTTP_OAUTH_ISSUER: "https://as.example.com",
    SN_HTTP_OAUTH_RESOURCE: "https://mcp.example.com/mcp",
    SN_HTTP_OAUTH_TOKEN_KEY: TOKEN_KEY.toString("hex"),
    SN_HTTP_OAUTH_USER_MATCH: undefined,
  };
  await withEnv(on, async () => {
    const s = getHttpUserTokens();
    assert.equal(s.claim, "email");
    assert.equal(s.field, "email");
    assert.ok(TOKEN_KEY.equals(s.key));
  });
  await withEnv(
    {
      ...on,
      SN_HTTP_OAUTH_TOKEN_KEY: TOKEN_KEY.toString("base64"),
      SN_HTTP_OAUTH_USER_MATCH: "preferred_username=user_name",
    },
    async () => {
      const s = getHttpUserTokens();
      assert.equal(s.claim, "preferred_username");
      assert.equal(s.field, "user_name");
      assert.ok(TOKEN_KEY.equals(s.key));
    },
  );
  await withEnv({ ...on, SN_HTTP_OAUTH_ISSUER: undefined }, async () => {
    assert.throws(() => getHttpUserTokens(), /SN_HTTP_OAUTH_ISSUER/);
  });
  await withEnv({ ...on, SN_HTTP_OAUTH_USER_MATCH: "email" }, async () => {
    assert.throws(() => getHttpUserTokens(), /SN_HTTP_OAUTH_USER_MATCH/);
  });
  await withEnv(
    { ...on, SN_HTTP_OAUTH_USER_MATCH: "email=Email; drop" },
    async () => {
      assert.throws(() => getHttpUserTokens(), /SN_HTTP_OAUTH_USER_MATCH/);
    },
  );
  await withEnv({ ...on, SN_HTTP_OAUTH_TOKEN_KEY: "short" }, async () => {
    assert.throws(() => getHttpUserTokens(), /SN_HTTP_OAUTH_TOKEN_KEY/);
  });
});

test("N-17 user tokens: a delegated request reports a per-subject marker, never the shared credential", async () => {
  await withEnv({ SN_HTTP_OAUTH_USER_TOKENS: "true" }, async () => {
    const alice = runInSession({ id: "", subject: "alice" }, () =>
      getCredentials(),
    );
    const bob = runInSession({ id: "", subject: "bob" }, () =>
      getCredentials(),
    );
    assert.match(alice.user, /^\^subject:[0-9a-f]{16}$/);
    assert.notEqual(alice.user, bob.user);
    assert.equal(alice.password, "");
    assert.ok(!alice.user.includes("alice"), "the subject is hashed");
    // No subject (stdio, the static bearer): the shared credential.
    assert.equal(getCredentials().user, "alice");
  });
  await withEnv({ SN_HTTP_OAUTH_USER_TOKENS: undefined }, async () => {
    const shared = runInSession({ id: "", subject: "alice" }, () =>
      getCredentials(),
    );
    assert.equal(shared.user, "alice");
    assert.equal(shared.password, "s3cret");
  });
});

test("N-17 user tokens: the schema cache is per subject while delegated", async () => {
  await withEnv(
    { SN_HTTP_OAUTH_USER_TOKENS: "true", SN_SCHEMA_CACHE_TTL: undefined },
    async () => {
      const key = `n17-${randomBytes(4).toString("hex")}|incident`;
      let loads = 0;
      const load = (v) => async () => {
        loads += 1;
        return v;
      };
      const as = (subject, fn) => runInSession({ id: "", subject }, fn);
      assert.equal(await as("alice", () => cached(key, load("a"))), "a");
      assert.equal(await as("alice", () => cached(key, load("x"))), "a");
      assert.equal(await as("bob", () => cached(key, load("b"))), "b");
      assert.equal(await cached(key, load("shared")), "shared");
      assert.equal(loads, 3);
      // peek strips the subject prefix, so callers keep comparing raw keys.
      assert.deepEqual(
        as("alice", () => peekSchemaCache(key)),
        [[key, "a"]],
      );
      assert.deepEqual(peekSchemaCache(key), [[key, "shared"]]);
    },
  );
});

// ---------------------------------------------------------------------------
// End to end: the HTTP transport, an authorization server, the instance
// ---------------------------------------------------------------------------

const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const nowSec = () => Math.floor(Date.now() / 1000);
const KEY = (() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: pair.privateKey,
    jwk: {
      ...pair.publicKey.export({ format: "jwk" }),
      kid: "u",
      alg: "RS256",
    },
  };
})();

function jwt(claims) {
  const input = `${enc({ alg: "RS256", kid: "u", typ: "at+jwt" })}.${enc(claims)}`;
  const sig = cryptoSign("sha256", Buffer.from(input), KEY.privateKey);
  return `${input}.${sig.toString("base64url")}`;
}

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

/** Discovery + JWKS on a loopback issuer, plus the shipped HTTP transport. */
async function withServers(env, fn) {
  const asPort = await freePort();
  const issuer = `http://127.0.0.1:${asPort}`;
  const as = createHttpServer((req, res) => {
    const send = (body) =>
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(body));
    if (req.url === "/.well-known/openid-configuration") {
      send({ issuer, jwks_uri: `${issuer}/jwks` });
    } else if (req.url === "/jwks") send({ keys: [KEY.jwk] });
    else res.writeHead(404).end();
  });
  await new Promise((resolve) => as.listen(asPort, "127.0.0.1", resolve));
  const dir = mkdtempSync(path.join(tmpdir(), "sn-n17u-"));
  const store = path.join(dir, "tokens", "store.json");
  const port = await freePort();
  const resource = `http://127.0.0.1:${port}/mcp`;
  try {
    await withEnv(
      {
        SN_TRANSPORT: "http",
        SN_PORT: String(port),
        SN_HTTP_HOST: "127.0.0.1",
        SN_HTTP_TOKEN: undefined,
        SN_LOG_LEVEL: "error",
        SN_HTTP_OAUTH_ISSUER: issuer,
        SN_HTTP_OAUTH_RESOURCE: resource,
        SN_HTTP_OAUTH_SCOPES: "mcp:tools",
        SN_HTTP_OAUTH_USER_TOKENS: "true",
        SN_HTTP_OAUTH_USER_MATCH: undefined,
        SN_HTTP_OAUTH_TOKEN_KEY: TOKEN_KEY.toString("base64"),
        SN_HTTP_OAUTH_TOKEN_STORE: store,
        SN_OAUTH_CLIENT_ID: "sn-client",
        SN_OAUTH_CLIENT_SECRET: "sn-secret",
        SN_DOCS_DIR: dir,
        ...env,
      },
      async () => {
        assert.equal(
          await connectTransport((rt) => buildMcpServer(rt)),
          "http",
        );
        try {
          const bearer = (sub, email = `${sub}@example.com`) =>
            `Bearer ${jwt({
              iss: issuer,
              aud: resource,
              sub,
              ...(email ? { email } : {}),
              scope: "mcp:tools",
              exp: nowSec() + 300,
            })}`;
          await fn({ port, store, bearer });
        } finally {
          await closeHttpTransport();
        }
      },
    );
  } finally {
    await new Promise((resolve) => as.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

const parseMessages = (res) =>
  res.headers["content-type"]?.includes("text/event-stream")
    ? res.text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => JSON.parse(l.slice(5)))
    : [JSON.parse(res.text)];

/** One 2026-07-28 tools/call of servicenow_get_record. */
async function getRecord(port, authorization, capabilities = {}, extra = {}) {
  const res = await rawRequest(port, {
    method: "POST",
    path: "/mcp",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization,
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "servicenow_get_record",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "servicenow_get_record",
        arguments: { table: "incident", sys_id: "a".repeat(32) },
        ...extra,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "n17", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": capabilities,
        },
      },
    }),
  });
  assert.equal(res.status, 200, res.text);
  return parseMessages(res).at(-1);
}

const URL_CAPS = { elicitation: { url: {} } };

const headerOf = (init, name) => {
  const h = init?.headers;
  if (!h) return undefined;
  if (typeof h.get === "function") return h.get(name) ?? undefined;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name);
  return key ? h[key] : undefined;
};

/**
 * The instance: the token endpoint (codes and refresh tokens it issued), the
 * identity read, and every other Table API read answered as the bearer's user.
 */
function instanceDouble() {
  const users = new Map(); // access token → email
  const refresh = new Map(); // refresh token → email
  const codes = new Map(); // code → email
  const seen = [];
  const reject = { refresh: false, records: new Set() };
  let n = 0;
  const issue = (email) => {
    n += 1;
    const access = `at${n}`;
    const rt = `rt${n}`;
    users.set(access, email);
    refresh.set(rt, email);
    return {
      access_token: access,
      refresh_token: rt,
      token_type: "Bearer",
      expires_in: 1800,
    };
  };
  const handler = (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/oauth_token.do") {
      const body = new URLSearchParams(String(init.body));
      seen.push({ token: body.get("grant_type"), body });
      if (body.get("grant_type") === "authorization_code") {
        const email = codes.get(body.get("code"));
        if (!email) return jsonResponse(400, { error: "invalid_grant" });
        codes.delete(body.get("code"));
        return jsonResponse(200, issue(email));
      }
      const email = refresh.get(body.get("refresh_token"));
      if (!email || reject.refresh) {
        return jsonResponse(401, {
          error: "invalid_grant",
          error_description: "refresh token expired",
        });
      }
      refresh.delete(body.get("refresh_token"));
      return jsonResponse(200, issue(email));
    }
    const auth = headerOf(init, "authorization") ?? "";
    const email = users.get(auth.replace(/^Bearer /, ""));
    seen.push({ path: u.pathname, auth });
    if (!email || reject.records.has(auth)) {
      return jsonResponse(401, {
        error: { message: "User Not Authenticated" },
      });
    }
    if (u.pathname === "/api/now/table/sys_user") {
      assert.equal(
        u.searchParams.get("sysparm_query"),
        "sys_id=javascript:gs.getUserID()",
      );
      return jsonResponse(200, { result: [{ sys_id: "u1", email }] });
    }
    return jsonResponse(200, {
      result: { sys_id: "a".repeat(32), number: "INC1", opened_by: email },
    });
  };
  return { handler, codes, seen, reject, users };
}

/** Pull the link URL out of an input_required round. */
function linkOf(result) {
  assert.equal(
    result.result?.resultType,
    "input_required",
    JSON.stringify(result),
  );
  const req = result.result.inputRequests.servicenow_link;
  assert.ok(req, JSON.stringify(result.result));
  assert.equal(req.params.mode, "url");
  return new URL(req.params.url);
}

/** Simulate the browser: the instance redirects back with a code. */
async function finishLink(port, link, codes, email) {
  const redirect = new URL(link.searchParams.get("redirect_uri"));
  assert.equal(redirect.pathname, CALLBACK_PATH);
  const code = `code-${randomBytes(4).toString("hex")}`;
  codes.set(code, email);
  return rawRequest(port, {
    path: `${CALLBACK_PATH}?code=${code}&state=${link.searchParams.get("state")}`,
  });
}

function unsealStore(store, key) {
  const file = JSON.parse(readFileSync(store, "utf8"));
  const entry = file.entries[key];
  if (!entry) return undefined;
  const d = createDecipheriv(
    "aes-256-gcm",
    TOKEN_KEY,
    Buffer.from(entry.iv, "base64"),
  );
  d.setAAD(Buffer.from(key, "utf8"));
  d.setAuthTag(Buffer.from(entry.tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      d.update(Buffer.from(entry.data, "base64")),
      d.final(),
    ]).toString("utf8"),
  );
}

test("e2e N-17 user tokens: link once, then every call reaches the instance as the user", async () => {
  await withServers({}, async ({ port, store, bearer }) => {
    const sn = instanceDouble();
    await withFetch(sn.handler, async () => {
      // 1. Not linked: a URL elicitation — the instance's authorize page.
      const first = await getRecord(port, bearer("alice"), URL_CAPS);
      const link = linkOf(first);
      assert.equal(link.origin, `https://${HOST}`);
      assert.equal(link.pathname, "/oauth_auth.do");
      assert.equal(link.searchParams.get("client_id"), "sn-client");
      assert.equal(link.searchParams.get("code_challenge_method"), "S256");
      assert.equal(sn.seen.length, 0, "nothing reached the instance");
      // No end-user data and nothing pre-authenticated in the URL: the user
      // signs in on the instance itself.
      assert.deepEqual([...link.searchParams.keys()].sort(), [
        "client_id",
        "code_challenge",
        "code_challenge_method",
        "redirect_uri",
        "response_type",
        "state",
      ]);
      assert.ok(!/alice|example\.com|sn-secret/i.test(link.href), link.href);

      // A retry before the link completes reuses the same pending link.
      const again = linkOf(await getRecord(port, bearer("alice"), URL_CAPS));
      assert.equal(again.href, link.href);

      // A client without URL elicitation gets the link in an error result.
      const plain = (await getRecord(port, bearer("alice"))).result;
      assert.equal(plain.isError, true);
      assert.ok(JSON.stringify(plain).includes(link.searchParams.get("state")));
      assert.match(JSON.stringify(plain), /NOT_CONFIGURED/);

      // 2. The callback: code → tokens → identity check → encrypted store.
      const done = await finishLink(port, link, sn.codes, "Alice@Example.com");
      assert.equal(done.status, 200, done.text);
      assert.match(done.headers["content-type"], /text\/html/);
      assert.equal(done.headers["cache-control"], "no-store");
      assert.match(
        done.headers["content-security-policy"],
        /default-src 'none'/,
      );
      const exchange = sn.seen.find((s) => s.token === "authorization_code");
      assert.equal(exchange.body.get("client_id"), "sn-client");
      assert.ok(exchange.body.get("code_verifier"));
      assert.equal(
        exchange.body.get("redirect_uri"),
        `http://127.0.0.1:${port}${CALLBACK_PATH}`,
      );

      // The store: mode 0600, nothing readable without the key.
      const raw = readFileSync(store, "utf8");
      assert.ok(!raw.includes("rt1") && !raw.includes("alice"), raw);
      if (process.platform !== "win32") {
        assert.equal(statSync(store).mode & 0o777, 0o600);
        assert.equal(statSync(path.dirname(store)).mode & 0o777, 0o700);
      }
      const key = linkKey("alice", "default", HOST);
      assert.deepEqual(unsealStore(store, key), {
        refreshToken: "rt1",
        login: "alice@example.com",
      });

      // The state is single-use.
      const replay = await rawRequest(port, {
        path: `${CALLBACK_PATH}?code=x&state=${link.searchParams.get("state")}`,
      });
      assert.equal(replay.status, 400);

      // 3. Linked: the call runs as alice, with her token.
      sn.seen.length = 0;
      const ok = (await getRecord(port, bearer("alice"), URL_CAPS)).result;
      assert.notEqual(ok.isError, true, JSON.stringify(ok));
      assert.match(JSON.stringify(ok), /alice@example\.com/i);
      // The instance's tokens never reach the MCP client.
      assert.ok(!/\b(at|rt)1\b/.test(JSON.stringify(ok)));
      for (const s of sn.seen) {
        if (s.auth !== undefined) assert.equal(s.auth, "Bearer at1");
      }

      // Bob is a different subject: his own link, not alice's account.
      const bob = linkOf(await getRecord(port, bearer("bob"), URL_CAPS));
      assert.notEqual(
        bob.searchParams.get("state"),
        link.searchParams.get("state"),
      );
    });
  });
});

test("e2e N-17 user tokens: an account that is not the subject's is refused and nothing is stored", async () => {
  await withServers({}, async ({ port, store, bearer }) => {
    const sn = instanceDouble();
    await withFetch(sn.handler, async () => {
      const link = linkOf(await getRecord(port, bearer("alice"), URL_CAPS));
      const res = await finishLink(port, link, sn.codes, "mallory@example.com");
      assert.equal(res.status, 403);
      assert.match(res.text, /not yours/);
      assert.ok(!existsSync(store), "no store written");
      // Still not linked: a fresh link is offered.
      const next = linkOf(await getRecord(port, bearer("alice"), URL_CAPS));
      assert.notEqual(
        next.searchParams.get("state"),
        link.searchParams.get("state"),
      );

      const unknown = await rawRequest(port, {
        path: `${CALLBACK_PATH}?code=x&state=nope`,
      });
      assert.equal(unknown.status, 400);
      const denied = await rawRequest(port, {
        path: `${CALLBACK_PATH}?error=access_denied&state=${next.searchParams.get("state")}`,
      });
      assert.equal(denied.status, 400);
      assert.match(denied.text, /access_denied/);
    });
  });
});

test("e2e N-17 user tokens: a token without the match claim cannot be delegated", async () => {
  await withServers({}, async ({ port, bearer }) => {
    const sn = instanceDouble();
    await withFetch(sn.handler, async () => {
      const res = (await getRecord(port, bearer("carol", null), URL_CAPS))
        .result;
      assert.equal(res.isError, true);
      assert.match(JSON.stringify(res), /carries no .{0,8}email.{0,8} claim/);
      assert.equal(sn.seen.length, 0);
    });
  });
});

test("e2e N-17 user tokens: a 401 refreshes once and rotates the stored refresh token", async () => {
  await withServers({}, async ({ port, store, bearer }) => {
    const sn = instanceDouble();
    await withFetch(sn.handler, async () => {
      const link = linkOf(await getRecord(port, bearer("alice"), URL_CAPS));
      assert.equal(
        (await finishLink(port, link, sn.codes, "alice@example.com")).status,
        200,
      );
      // The instance revokes the access token: one refresh, one retry.
      sn.reject.records.add("Bearer at1");
      const ok = (await getRecord(port, bearer("alice"), URL_CAPS)).result;
      assert.notEqual(ok.isError, true, JSON.stringify(ok));
      const refreshes = sn.seen.filter((s) => s.token === "refresh_token");
      assert.equal(refreshes.length, 1);
      assert.equal(refreshes[0].body.get("refresh_token"), "rt1");
      assert.equal(
        unsealStore(store, linkKey("alice", "default", HOST)).refreshToken,
        "rt2",
      );

      // A refused refresh drops the link: the next call asks to link again.
      sn.reject.records.add("Bearer at2");
      sn.reject.refresh = true;
      const relink = await getRecord(port, bearer("alice"), URL_CAPS);
      linkOf(relink);
      assert.equal(
        unsealStore(store, linkKey("alice", "default", HOST)),
        undefined,
      );
    });
  });
});

test("e2e N-17 user tokens: a 2025 session gets -32042 with the link", async () => {
  await withServers({}, async ({ port, bearer }) => {
    const sn = instanceDouble();
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: bearer("alice"),
    };
    await withFetch(sn.handler, async () => {
      const init = await rawRequest(port, {
        method: "POST",
        path: "/mcp",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: { elicitation: { url: {} } },
            clientInfo: { name: "n17", version: "0" },
          },
        }),
      });
      assert.equal(init.status, 200, init.text);
      const session = {
        ...headers,
        "mcp-session-id": init.headers["mcp-session-id"],
        "mcp-protocol-version": "2025-11-25",
      };
      await rawRequest(port, {
        method: "POST",
        path: "/mcp",
        headers: session,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      });
      const res = await rawRequest(port, {
        method: "POST",
        path: "/mcp",
        headers: session,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "servicenow_get_record",
            arguments: { table: "incident", sys_id: "a".repeat(32) },
          },
        }),
      });
      const msg = parseMessages(res).at(-1);
      assert.equal(msg.error?.code, -32042, JSON.stringify(msg));
      const [elicitation] = msg.error.data.elicitations;
      assert.equal(elicitation.mode, "url");
      assert.ok(elicitation.elicitationId);
      assert.match(elicitation.url, /\/oauth_auth\.do\?/);
    });
  });
});

test("e2e N-17 user tokens: off, the callback route does not exist", async () => {
  await withServers(
    { SN_HTTP_OAUTH_USER_TOKENS: undefined },
    async ({ port }) => {
      const res = await rawRequest(port, {
        path: `${CALLBACK_PATH}?state=x&code=y`,
      });
      assert.notEqual(res.status, 200);
    },
  );
});
