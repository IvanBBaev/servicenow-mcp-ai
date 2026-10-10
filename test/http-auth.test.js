// N-17 — the HTTP transport as an OAuth 2.1 resource server: RFC 9728
// protected-resource metadata, RFC 6750 challenges, JWT access tokens
// validated locally against the issuer's JWKS (audience-bound, RFC 8707),
// the static bearer next to it, and the per-subject isolation of sessions,
// plan tokens and the write journal.
import test from "node:test";
import assert from "node:assert/strict";
import {
  request as httpRequest,
  createServer as createHttpServer,
} from "node:http";
import { createServer } from "node:net";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  connectTransport,
  closeHttpTransport,
} from "../build/mcp/transport.js";
import {
  OAuthResourceServer,
  PRM_WELL_KNOWN,
  JWKS_REFETCH_MIN_MS,
  canonicalResource,
  staticBearerMatches,
  validateOAuthConfig,
} from "../build/mcp/http-auth.js";
import { getHttpOAuth } from "../build/core/settings.js";
import { buildMcpServer } from "../build/server.js";
import { readWriteJournal } from "../build/core/write-journal.js";
import { baselineEnv, jsonResponse, withEnv, withFetch } from "./helpers.js";

baselineEnv();

// ---------------------------------------------------------------------------
// Keys and tokens
// ---------------------------------------------------------------------------

const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

function keyPair(alg, kid) {
  const pair =
    alg === "ES256"
      ? generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      : alg === "EdDSA"
        ? generateKeyPairSync("ed25519")
        : generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid, alg };
  return { alg, kid, privateKey: pair.privateKey, jwk };
}

/** A signed JWT; `header` overrides the default `{alg, kid}`. */
function jwt(key, claims, header = {}) {
  const input = `${enc({ alg: key.alg, kid: key.kid, typ: "at+jwt", ...header })}.${enc(claims)}`;
  const sig =
    key.alg === "EdDSA"
      ? cryptoSign(null, Buffer.from(input), key.privateKey)
      : cryptoSign("sha256", Buffer.from(input), {
          key: key.privateKey,
          ...(key.alg === "ES256" ? { dsaEncoding: "ieee-p1363" } : {}),
        });
  return `${input}.${sig.toString("base64url")}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

const ISSUER = "https://as.example.com";
const RESOURCE = "https://mcp.example.com/mcp";
const RSA = keyPair("RS256", "k1");

const claimsFor = (over = {}) => ({
  iss: ISSUER,
  aud: RESOURCE,
  sub: "alice",
  client_id: "vscode",
  scope: "mcp:tools",
  exp: nowSec() + 300,
  ...over,
});

/** An authorization server double: discovery + JWKS, counting fetches. */
function authServerFetch({ issuer = ISSUER, keys = () => [RSA.jwk] } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url) === `${issuer}/.well-known/openid-configuration`) {
      return jsonResponse(200, { issuer, jwks_uri: `${issuer}/jwks` });
    }
    if (String(url) === `${issuer}/jwks`) {
      return jsonResponse(200, { keys: keys() });
    }
    return jsonResponse(404, {});
  };
  return { fetchImpl, calls };
}

const server = (config = {}, fetchOptions = {}, now) => {
  const as = authServerFetch(fetchOptions);
  const rs = new OAuthResourceServer(
    { issuer: ISSUER, resource: RESOURCE, scopes: ["mcp:tools"], ...config },
    as.fetchImpl,
    now,
  );
  return { rs, calls: as.calls };
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test("N-17 canonicalResource lowercases scheme and host and drops a root slash", () => {
  assert.equal(
    canonicalResource("HTTPS://MCP.Example.COM/"),
    "https://mcp.example.com",
  );
  assert.equal(
    canonicalResource("https://mcp.example.com/MCP"),
    "https://mcp.example.com/MCP",
  );
  assert.equal(canonicalResource("https://mcp.example.com/mcp#x"), undefined);
  assert.equal(canonicalResource("https://u:p@mcp.example.com/"), undefined);
  assert.equal(canonicalResource("ftp://mcp.example.com/"), undefined);
});

test("N-17 config: a non-loopback issuer must be https; the resource must be valid", () => {
  assert.throws(
    () =>
      validateOAuthConfig({
        issuer: "http://as.example.com",
        resource: RESOURCE,
      }),
    /https/,
  );
  assert.throws(
    () => validateOAuthConfig({ issuer: ISSUER, resource: "not a uri" }),
    /resource/i,
  );
  assert.doesNotThrow(() =>
    validateOAuthConfig({
      issuer: "http://127.0.0.1:9000",
      resource: RESOURCE,
    }),
  );
});

test("N-17 settings: SN_HTTP_OAUTH_ISSUER needs SN_HTTP_OAUTH_RESOURCE", async () => {
  await withEnv(
    { SN_HTTP_OAUTH_ISSUER: undefined, SN_HTTP_OAUTH_RESOURCE: undefined },
    () => assert.equal(getHttpOAuth(), undefined),
  );
  await withEnv(
    { SN_HTTP_OAUTH_ISSUER: ISSUER, SN_HTTP_OAUTH_RESOURCE: undefined },
    () => assert.throws(() => getHttpOAuth(), /SN_HTTP_OAUTH_RESOURCE/),
  );
  await withEnv(
    {
      SN_HTTP_OAUTH_ISSUER: ISSUER,
      SN_HTTP_OAUTH_RESOURCE: RESOURCE,
      SN_HTTP_OAUTH_SCOPES: "mcp:tools, mcp:admin",
      SN_HTTP_OAUTH_AUDIENCE: "api://servicenow-mcp",
    },
    () => {
      const config = getHttpOAuth();
      assert.equal(config.issuer, ISSUER);
      assert.deepEqual(config.scopes, ["mcp:tools", "mcp:admin"]);
      assert.deepEqual(config.audiences, ["api://servicenow-mcp"]);
    },
  );
});

test("N-17 staticBearerMatches compares the whole header", () => {
  assert.equal(staticBearerMatches("Bearer abc", "abc"), true);
  assert.equal(staticBearerMatches("Bearer abcd", "abc"), false);
  assert.equal(staticBearerMatches(undefined, "abc"), false);
});

// ---------------------------------------------------------------------------
// Metadata and challenges
// ---------------------------------------------------------------------------

test("N-17 metadata names the resource, the issuer and the scopes without offline_access", () => {
  const { rs } = server({ scopes: ["mcp:tools", "offline_access"] });
  assert.deepEqual(rs.metadataPaths(), [
    `${PRM_WELL_KNOWN}/mcp`,
    PRM_WELL_KNOWN,
  ]);
  assert.equal(
    rs.metadataUrl(),
    "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
  );
  const doc = rs.metadata();
  assert.equal(doc.resource, RESOURCE);
  assert.deepEqual(doc.authorization_servers, [ISSUER]);
  assert.deepEqual(doc.bearer_methods_supported, ["header"]);
  assert.deepEqual(doc.scopes_supported, ["mcp:tools"]);
});

test("N-17 a request without a token gets 401 with resource_metadata and scope", async () => {
  const { rs, calls } = server();
  const out = await rs.authenticate(undefined);
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
  assert.match(
    out.challenge,
    /^Bearer resource_metadata="https:\/\/mcp\.example\.com\/\.well-known\/oauth-protected-resource\/mcp", scope="mcp:tools"$/,
  );
  assert.equal(calls.length, 0, "no key fetch without a token");
});

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

test("N-17 a valid token yields the subject, the client and the scopes", async () => {
  const { rs, calls } = server();
  const token = jwt(RSA, claimsFor());
  const out = await rs.authenticate(`Bearer ${token}`);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.subject, "alice");
  assert.equal(out.auth.clientId, "vscode");
  assert.deepEqual(out.auth.scopes, ["mcp:tools"]);
  assert.equal(out.auth.resource.href, RESOURCE);
  assert.deepEqual(out.auth.extra, { subject: "alice" });
  assert.deepEqual(calls, [
    `${ISSUER}/.well-known/openid-configuration`,
    `${ISSUER}/jwks`,
  ]);
  // The keys are cached.
  assert.equal((await rs.authenticate(`Bearer ${token}`)).ok, true);
  assert.equal(calls.length, 2);
});

test("N-17 ES256, PS256 and EdDSA tokens validate", async () => {
  const es = keyPair("ES256", "e1");
  const ed = keyPair("EdDSA", "d1");
  const ps = { ...keyPair("RS256", "p1"), alg: "PS256" };
  const { rs } = server(
    {},
    { keys: () => [es.jwk, ed.jwk, { ...ps.jwk, alg: "PS256" }] },
  );
  for (const key of [es, ed]) {
    const out = await rs.authenticate(`Bearer ${jwt(key, claimsFor())}`);
    assert.equal(out.ok, true, `${key.alg}: ${JSON.stringify(out)}`);
  }
  const input = `${enc({ alg: "PS256", kid: "p1" })}.${enc(claimsFor())}`;
  const sig = cryptoSign("sha256", Buffer.from(input), {
    key: ps.privateKey,
    padding: 6, // RSA_PKCS1_PSS_PADDING
    saltLength: -1, // RSA_PSS_SALTLEN_DIGEST
  });
  const out = await rs.authenticate(
    `Bearer ${input}.${sig.toString("base64url")}`,
  );
  assert.equal(out.ok, true, JSON.stringify(out));
});

test("N-17 a token for another audience is rejected (RFC 8707)", async () => {
  const { rs } = server();
  const out = await rs.authenticate(
    `Bearer ${jwt(RSA, claimsFor({ aud: "https://other.example.com/mcp" }))}`,
  );
  assert.equal(out.status, 401);
  assert.match(out.challenge, /error="invalid_token"/);
  assert.match(out.message, /not issued for this resource/);
});

test("N-17 an extra configured audience and a non-canonical resource spelling are accepted", async () => {
  const { rs } = server({ audiences: ["api://servicenow-mcp"] });
  for (const aud of [
    ["x", "api://servicenow-mcp"],
    "HTTPS://MCP.EXAMPLE.COM/mcp",
  ]) {
    const out = await rs.authenticate(`Bearer ${jwt(RSA, claimsFor({ aud }))}`);
    assert.equal(out.ok, true, JSON.stringify(out));
  }
});

test("N-17 expired, not-yet-valid, wrong-issuer and subject-less tokens are rejected", async () => {
  const { rs } = server();
  const cases = [
    [{ exp: nowSec() - 120 }, /expired/],
    [{ exp: undefined }, /no expiry/],
    [{ nbf: nowSec() + 600 }, /not yet valid/],
    [{ iss: "https://evil.example.com" }, /wrong issuer/],
    [{ sub: undefined }, /no subject/],
  ];
  for (const [over, message] of cases) {
    const out = await rs.authenticate(`Bearer ${jwt(RSA, claimsFor(over))}`);
    assert.equal(out.status, 401, JSON.stringify(over));
    assert.match(out.message, message);
  }
  // Within the clock leeway.
  const late = await rs.authenticate(
    `Bearer ${jwt(RSA, claimsFor({ exp: nowSec() - 10 }))}`,
  );
  assert.equal(late.ok, true);
});

test("N-17 a forged signature, alg none and HS256 are rejected", async () => {
  const { rs } = server();
  const other = keyPair("RS256", "k1");
  const forged = await rs.authenticate(`Bearer ${jwt(other, claimsFor())}`);
  assert.match(forged.message, /bad signature/);

  const none = `${enc({ alg: "none", kid: "k1" })}.${enc(claimsFor())}.`;
  assert.match(
    (await rs.authenticate(`Bearer ${none}`)).message,
    /not a JWT|algorithm/,
  );
  const noneSig = `${enc({ alg: "none", kid: "k1" })}.${enc(claimsFor())}.AA`;
  assert.match(
    (await rs.authenticate(`Bearer ${noneSig}`)).message,
    /algorithm/,
  );

  const hs = `${enc({ alg: "HS256", kid: "k1" })}.${enc(claimsFor())}.AAAA`;
  assert.match((await rs.authenticate(`Bearer ${hs}`)).message, /algorithm/);

  const crit = jwt(RSA, claimsFor(), { crit: ["exp"] });
  assert.match((await rs.authenticate(`Bearer ${crit}`)).message, /critical/);

  // An RSA key cannot verify an ES256 header.
  const confused = jwt(RSA, claimsFor(), { alg: "ES256" });
  const out = await rs.authenticate(`Bearer ${confused}`);
  assert.equal(out.ok, false);
});

test("N-17 a token without the configured scope gets 403 insufficient_scope", async () => {
  const { rs } = server({ scopes: ["mcp:tools", "mcp:write"] });
  const out = await rs.authenticate(`Bearer ${jwt(RSA, claimsFor())}`);
  assert.equal(out.status, 403);
  assert.match(out.challenge, /error="insufficient_scope"/);
  assert.match(out.challenge, /scope="mcp:tools mcp:write"/);
  const scp = await rs.authenticate(
    `Bearer ${jwt(RSA, claimsFor({ scope: undefined, scp: ["mcp:tools", "mcp:write"] }))}`,
  );
  assert.equal(scp.ok, true, JSON.stringify(scp));
});

test("N-17 an unknown kid refetches the JWKS at most every 30 s (key rotation)", async () => {
  let t = Date.now();
  const rotated = keyPair("RS256", "k2");
  let keys = [RSA.jwk];
  const { rs, calls } = server({}, { keys: () => keys }, () => t);
  assert.equal(
    (await rs.authenticate(`Bearer ${jwt(RSA, claimsFor())}`)).ok,
    true,
  );
  const jwksFetches = () => calls.filter((u) => u.endsWith("/jwks")).length;
  assert.equal(jwksFetches(), 1);

  keys = [RSA.jwk, rotated.jwk];
  // Within the refetch floor the unknown kid is not looked up again.
  t += 1_000;
  const early = await rs.authenticate(`Bearer ${jwt(rotated, claimsFor())}`);
  assert.match(early.message, /unknown signing key/);
  assert.equal(jwksFetches(), 1);

  t += JWKS_REFETCH_MIN_MS;
  const later = await rs.authenticate(`Bearer ${jwt(rotated, claimsFor())}`);
  assert.equal(later.ok, true, JSON.stringify(later));
  assert.equal(jwksFetches(), 2);
});

test("N-17 an unreachable authorization server is a 503, not a 401", async () => {
  const rs = new OAuthResourceServer(
    { issuer: ISSUER, resource: RESOURCE },
    async () => {
      throw new Error("ECONNREFUSED");
    },
  );
  const out = await rs.authenticate(`Bearer ${jwt(RSA, claimsFor())}`);
  assert.equal(out.status, 503);
});

test("N-17 a discovery document naming another issuer is refused", async () => {
  const rs = new OAuthResourceServer(
    { issuer: ISSUER, resource: RESOURCE },
    async () =>
      jsonResponse(200, {
        issuer: "https://evil.example.com",
        jwks_uri: `${ISSUER}/jwks`,
      }),
  );
  const out = await rs.authenticate(`Bearer ${jwt(RSA, claimsFor())}`);
  assert.equal(out.status, 503);
  assert.match(out.message, /issuer mismatch/);
});

// ---------------------------------------------------------------------------
// End to end over the shipped transport
// ---------------------------------------------------------------------------

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

/** A local authorization server (discovery + JWKS) on a loopback issuer. */
async function withAuthServer(keys, fn) {
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const srv = createHttpServer((req, res) => {
    const send = (body) =>
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(body));
    if (req.url === "/.well-known/openid-configuration") {
      send({ issuer, jwks_uri: `${issuer}/jwks` });
    } else if (req.url === "/jwks") {
      send({ keys });
    } else res.writeHead(404).end();
  });
  await new Promise((resolve) => srv.listen(port, "127.0.0.1", resolve));
  try {
    await fn(issuer);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
}

/** The shipped HTTP transport as a resource server of `issuer`. */
async function withResourceServer(issuer, env, fn) {
  const port = await freePort();
  const resource = `http://127.0.0.1:${port}/mcp`;
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
      ...env,
    },
    async () => {
      assert.equal(await connectTransport((rt) => buildMcpServer(rt)), "http");
      try {
        await fn(port, resource);
      } finally {
        await closeHttpTransport();
      }
    },
  );
}

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

async function modernCall(port, authorization, method, params, name) {
  const res = await rawRequest(port, {
    method: "POST",
    path: "/mcp",
    headers: {
      ...MCP_HEADERS,
      ...(authorization ? { authorization } : {}),
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(name ? { "mcp-name": name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "n17", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  if (res.status !== 200) return res;
  const messages = res.headers["content-type"]?.includes("text/event-stream")
    ? res.text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => JSON.parse(l.slice(5)))
    : [JSON.parse(res.text)];
  return { ...res, ...messages.at(-1) };
}

const payload = (result) => {
  assert.ok(!result.isError, JSON.stringify(result));
  return result.structuredContent ?? JSON.parse(result.content[0].text);
};

const headerOf = (init, name) => {
  const h = init?.headers;
  if (!h) return undefined;
  if (typeof h.get === "function") return h.get(name) ?? undefined;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name);
  return key ? h[key] : undefined;
};

test("e2e N-17: metadata is public at both well-known paths; MCP needs a token", async () => {
  const key = keyPair("RS256", "e2e");
  await withAuthServer([key.jwk], async (issuer) => {
    await withResourceServer(issuer, {}, async (port, resource) => {
      for (const p of [`${PRM_WELL_KNOWN}/mcp`, PRM_WELL_KNOWN]) {
        const res = await rawRequest(port, { path: p });
        assert.equal(res.status, 200, p);
        assert.equal(res.headers["access-control-allow-origin"], "*");
        const doc = JSON.parse(res.text);
        assert.equal(doc.resource, resource);
        assert.deepEqual(doc.authorization_servers, [issuer]);
      }

      const anon = await modernCall(port, undefined, "tools/list", {});
      assert.equal(anon.status, 401);
      assert.equal(anon.headers["cache-control"], "no-store");
      assert.equal(
        anon.headers["www-authenticate"],
        `Bearer resource_metadata="http://127.0.0.1:${port}${PRM_WELL_KNOWN}/mcp", scope="mcp:tools"`,
      );

      const claims = {
        iss: issuer,
        aud: resource,
        sub: "alice",
        scope: "mcp:tools",
        exp: nowSec() + 300,
      };
      const ok = await modernCall(
        port,
        `Bearer ${jwt(key, claims)}`,
        "tools/list",
        {},
      );
      assert.equal(ok.status, 200);
      assert.ok(Array.isArray(ok.result.tools));

      const wrongAud = await modernCall(
        port,
        `Bearer ${jwt(key, { ...claims, aud: "http://127.0.0.1:1/mcp" })}`,
        "tools/list",
        {},
      );
      assert.equal(wrongAud.status, 401);
      assert.match(
        wrongAud.headers["www-authenticate"],
        /error="invalid_token"/,
      );

      const narrow = await modernCall(
        port,
        `Bearer ${jwt(key, { ...claims, scope: "openid" })}`,
        "tools/list",
        {},
      );
      assert.equal(narrow.status, 403);
      assert.match(
        narrow.headers["www-authenticate"],
        /error="insufficient_scope"/,
      );
    });
  });
});

test("e2e N-17: the static SN_HTTP_TOKEN still works next to OAuth", async () => {
  const key = keyPair("RS256", "e2e");
  await withAuthServer([key.jwk], async (issuer) => {
    await withResourceServer(
      issuer,
      { SN_HTTP_TOKEN: "static-secret" },
      async (port) => {
        const res = await modernCall(
          port,
          "Bearer static-secret",
          "tools/list",
          {},
        );
        assert.equal(res.status, 200);
        const bad = await modernCall(
          port,
          "Bearer static-secreT",
          "tools/list",
          {},
        );
        assert.equal(bad.status, 401);
      },
    );
  });
});

test("e2e N-17: the MCP token never reaches the instance; plan tokens and journal lines are per subject", async () => {
  const key = keyPair("RS256", "e2e");
  const sysId = "b".repeat(32);
  const docs = mkdtempSync(path.join(tmpdir(), "sn-n17-"));
  const deletes = [];
  const instanceAuth = new Set();
  const instance = (url, init) => {
    instanceAuth.add(headerOf(init, "authorization"));
    if (init?.method === "DELETE") {
      deletes.push(url);
      return new Response(null, { status: 204 });
    }
    return jsonResponse(200, {
      result: { sys_id: sysId, number: "INC1", sys_mod_count: "1" },
    });
  };
  try {
    await withAuthServer([key.jwk], async (issuer) => {
      await withResourceServer(
        issuer,
        { SN_DOCS_DIR: docs },
        async (port, resource) => {
          const bearer = (sub) =>
            `Bearer ${jwt(key, {
              iss: issuer,
              aud: resource,
              sub,
              scope: "mcp:tools",
              exp: nowSec() + 300,
            })}`;
          const del = (sub, args) =>
            modernCall(
              port,
              bearer(sub),
              "tools/call",
              {
                name: "servicenow_delete_record",
                arguments: { table: "incident", sys_id: sysId, ...args },
              },
              "servicenow_delete_record",
            );
          await withFetch(instance, async () => {
            const preview = (await del("alice", {})).result;
            const token = payload(preview).plan_token;
            assert.match(token, /^pt[a-z]+$/);

            // Another subject cannot redeem alice's plan token.
            const stolen = (
              await del("bob", { apply: true, plan_token: token })
            ).result;
            assert.equal(stolen.isError, true, JSON.stringify(stolen));
            assert.match(JSON.stringify(stolen), /plan.?token/i);
            assert.equal(deletes.length, 0);

            const applied = (
              await del("alice", { apply: true, plan_token: token })
            ).result;
            assert.notEqual(applied.isError, true, JSON.stringify(applied));
            assert.equal(deletes.length, 1);
          });
          for (const auth of instanceAuth) {
            assert.match(
              auth ?? "",
              /^Basic /,
              "the instance sees the service account",
            );
          }
          const lines = readWriteJournal({}).entries;
          const subjects = lines.map((l) => l.subject);
          assert.ok(subjects.includes("alice"), JSON.stringify(lines));
          assert.ok(!subjects.includes(undefined), JSON.stringify(lines));
          // The access token is not stored anywhere the server writes.
          assert.ok(
            !JSON.stringify(lines).includes("eyJ"),
            "no token in the journal",
          );
        },
      );
    });
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
});

test("e2e N-17: a 2025 session answers only the subject that opened it", async () => {
  const key = keyPair("RS256", "e2e");
  await withAuthServer([key.jwk], async (issuer) => {
    await withResourceServer(issuer, {}, async (port, resource) => {
      const bearer = (sub) =>
        `Bearer ${jwt(key, {
          iss: issuer,
          aud: resource,
          sub,
          scope: "mcp:tools",
          exp: nowSec() + 300,
        })}`;
      const init = await rawRequest(port, {
        method: "POST",
        path: "/mcp",
        headers: { ...MCP_HEADERS, authorization: bearer("alice") },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "n17", version: "0" },
          },
        }),
      });
      assert.equal(init.status, 200, init.text);
      const sessionId = init.headers["mcp-session-id"];
      assert.ok(sessionId);
      const list = (sub) =>
        rawRequest(port, {
          method: "POST",
          path: "/mcp",
          headers: {
            ...MCP_HEADERS,
            authorization: bearer(sub),
            "mcp-session-id": sessionId,
            "mcp-protocol-version": "2025-03-26",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        });
      assert.equal((await list("bob")).status, 404);
      assert.equal((await list("alice")).status, 200);
    });
  });
});
