import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createPkcePair, createState } from "../build/core/pkce.js";
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  invalidateTokens,
} from "../build/core/auth.js";
import {
  browserCommand,
  parseRedirect,
  runOAuthLogin,
} from "../build/core/oauth-login.js";
import { queryTable } from "../build/api/table.js";
import {
  baselineEnv,
  withEnv,
  withFetch,
  jsonResponse,
  realFetch,
} from "./helpers.js";

baselineEnv();

const b64url = (buf) =>
  buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((res) => {
    const s = createServer();
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

test("createPkcePair makes a valid S256 verifier/challenge", () => {
  const { verifier, challenge, method } = createPkcePair();
  assert.equal(method, "S256");
  assert.equal(verifier.length, 43); // 32 bytes -> 43 base64url chars
  assert.doesNotMatch(verifier, /[+/=]/, "verifier is base64url, no padding");
  assert.equal(
    challenge,
    b64url(createHash("sha256").update(verifier).digest()),
  );
  assert.notEqual(createState(), createState());
});

test("buildAuthorizeUrl carries PKCE + state + redirect (OAuth 2.1)", () => {
  const url = buildAuthorizeUrl("dev.service-now.com", {
    clientId: "cid",
    redirectUri: "http://localhost:53682/callback",
    codeChallenge: "chal",
    state: "st",
    scope: "useraccount",
  });
  const u = new URL(url);
  assert.equal(
    u.origin + u.pathname,
    "https://dev.service-now.com/oauth_auth.do",
  );
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("client_id"), "cid");
  assert.equal(u.searchParams.get("code_challenge"), "chal");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("state"), "st");
  assert.equal(u.searchParams.get("scope"), "useraccount");
});

test("exchangeAuthorizationCode posts the code + verifier and returns the refresh token", async () => {
  await withFetch(
    (url, init) => {
      assert.match(url, /\/oauth_token\.do$/);
      const body = String(init.body);
      assert.match(body, /grant_type=authorization_code/);
      assert.match(body, /code=thecode/);
      assert.match(body, /code_verifier=ver123/);
      assert.match(body, /redirect_uri=/);
      return jsonResponse(200, {
        access_token: "at",
        refresh_token: "rt",
        expires_in: 1800,
      });
    },
    async () => {
      const t = await exchangeAuthorizationCode("dev.service-now.com", {
        clientId: "cid",
        clientSecret: "sec",
        code: "thecode",
        codeVerifier: "ver123",
        redirectUri: "http://localhost:53682/callback",
      });
      assert.equal(t.accessToken, "at");
      assert.equal(t.refreshToken, "rt");
      assert.equal(t.expiresIn, 1800);
    },
  );
});

test("parseRedirect validates state and extracts the code", () => {
  assert.deepEqual(parseRedirect("/callback?code=abc&state=s1", "s1"), {
    code: "abc",
  });
  assert.ok(parseRedirect("/callback?code=abc&state=other", "s1").error);
  assert.match(
    parseRedirect("/callback?error=access_denied&state=s1", "s1").error,
    /access_denied/,
  );
  assert.ok(parseRedirect("/callback?state=s1", "s1").error);
  // GA-5: error_description (human text) is preferred over the error code.
  assert.equal(
    parseRedirect(
      "/callback?error=access_denied&error_description=User+denied&state=s1",
      "s1",
    ).error,
    "User denied",
  );
  // GA-5: an unparseable request-URL is an error, not an exception.
  assert.equal(
    parseRedirect("http://[bad", "s1").error,
    "malformed redirect request",
  );
});

test("runOAuthLogin completes the PKCE flow and stores the refresh token", async () => {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "sn-oauth-"));
  const envFile = join(dir, ".env");
  try {
    await withEnv(
      {
        SN_INSTANCE: "dev00000.service-now.com",
        SN_OAUTH_CLIENT_ID: "cid",
        SN_OAUTH_CLIENT_SECRET: "sec",
        SN_OAUTH_REDIRECT_URI: `http://localhost:${port}/callback`,
        SN_ENV_FILE: envFile,
        SN_ACTIVE_PROFILE: "default",
      },
      async () => {
        let tokenBody;
        globalThis.fetch = async (url, init) => {
          tokenBody = String(init.body);
          return jsonResponse(200, {
            access_token: "at",
            refresh_token: "rt-123",
            expires_in: 1800,
          });
        };
        try {
          let authUrl;
          const p = runOAuthLogin({
            open: false,
            onAuthUrl: (u) => (authUrl = u),
          });
          for (let i = 0; i < 300 && !authUrl; i++) await delay(10);
          assert.ok(authUrl, "the authorization URL was emitted");
          assert.match(authUrl, /\/oauth_auth\.do\?/);
          assert.match(authUrl, /code_challenge_method=S256/);
          const state = new URL(authUrl).searchParams.get("state");

          // Drive the loopback redirect with the REAL http client.
          await realFetch(
            `http://localhost:${port}/callback?code=thecode&state=${state}`,
          );
          const result = await p;

          assert.equal(result.profile, "default");
          assert.match(tokenBody, /grant_type=authorization_code/);
          assert.match(tokenBody, /code=thecode/);
          assert.equal(process.env.SN_OAUTH_REFRESH_TOKEN, "rt-123");
          assert.equal(process.env.SN_OAUTH_GRANT, "refresh_token");
          assert.match(
            readFileSync(envFile, "utf8"),
            /SN_OAUTH_REFRESH_TOKEN=rt-123/,
          );
        } finally {
          globalThis.fetch = realFetch;
          delete process.env.SN_OAUTH_REFRESH_TOKEN;
          delete process.env.SN_OAUTH_GRANT;
          delete process.env.SN_AUTH;
          invalidateTokens();
        }
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the stored refresh token mints a bearer at runtime (post-login path)", async () => {
  await withEnv(
    {
      SN_AUTH: "oauth",
      SN_OAUTH_CLIENT_ID: "cid2",
      SN_OAUTH_GRANT: "refresh_token",
      SN_OAUTH_REFRESH_TOKEN: "rt-9",
    },
    async () => {
      invalidateTokens();
      let tokenCalls = 0;
      globalThis.fetch = async (url, init) => {
        if (String(url).endsWith("/oauth_token.do")) {
          tokenCalls += 1;
          assert.match(String(init.body), /grant_type=refresh_token/);
          assert.match(String(init.body), /refresh_token=rt-9/);
          return jsonResponse(200, { access_token: "at-rt", expires_in: 3600 });
        }
        assert.equal(init.headers.Authorization, "Bearer at-rt");
        return jsonResponse(200, { result: [] });
      };
      try {
        await queryTable({ table: "incident" });
        assert.equal(tokenCalls, 1);
      } finally {
        globalThis.fetch = realFetch;
        invalidateTokens();
      }
    },
  );
});

test("runOAuthLogin validates instance, client id and a loopback redirect", async () => {
  await withEnv({ SN_INSTANCE: undefined }, async () => {
    await assert.rejects(runOAuthLogin({ open: false }), {
      code: "NOT_CONFIGURED",
      message: /SN_INSTANCE/,
    });
  });
  await withEnv(
    { SN_INSTANCE: "dev00000.service-now.com", SN_OAUTH_CLIENT_ID: undefined },
    async () => {
      await assert.rejects(runOAuthLogin({ open: false }), {
        code: "NOT_CONFIGURED",
        message: /SN_OAUTH_CLIENT_ID/,
      });
    },
  );
  await withEnv(
    {
      SN_INSTANCE: "dev00000.service-now.com",
      SN_OAUTH_CLIENT_ID: "c",
      SN_OAUTH_REDIRECT_URI: "https://evil.example/cb",
    },
    async () => {
      await assert.rejects(runOAuthLogin({ open: false }), {
        code: "NOT_CONFIGURED",
        message: /loopback/,
      });
    },
  );
});

test("browserCommand never hands the URL to a shell (N-56, MCP05)", () => {
  const url =
    "https://dev.service-now.com/oauth_auth.do?response_type=code&client_id=a&state=b";
  assert.deepEqual(browserCommand(url, "win32"), {
    cmd: "rundll32",
    args: ["url.dll,FileProtocolHandler", url],
  });
  assert.deepEqual(browserCommand(url, "darwin"), { cmd: "open", args: [url] });
  assert.deepEqual(browserCommand(url, "linux"), {
    cmd: "xdg-open",
    args: [url],
  });
});

test("browserCommand opens only http(s) URLs", () => {
  for (const url of [
    "file:///C:/Windows/System32/calc.exe",
    "javascript:x",
    "not a url",
  ]) {
    for (const platform of ["win32", "darwin", "linux"]) {
      assert.equal(
        browserCommand(url, platform),
        undefined,
        `${platform} ${url}`,
      );
    }
  }
});
