import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  exchangeAuthorizationCode,
  getAuthProvider,
  invalidateTokens,
  reloadBearerTokenFile,
} from "../build/core/auth.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

baselineEnv();

const HOST = "dev00000.service-now.com";

const b64urlToBuf = (s) =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const decodeJwtPart = (s) => JSON.parse(b64urlToBuf(s).toString("utf8"));

function tempDir() {
  return mkdtempSync(join(tmpdir(), "sn-auth-edges-"));
}

async function headers() {
  invalidateTokens();
  return getAuthProvider().headers(HOST);
}

const OAUTH = {
  SN_AUTH: "oauth",
  SN_OAUTH_CLIENT_ID: "cid",
  SN_OAUTH_CLIENT_SECRET: "csecret",
};

// ---------- API key / bearer token ----------

test("apikey mode without SN_API_KEY names the missing variable", async () => {
  await withEnv({ SN_AUTH: "apikey", SN_API_KEY: undefined }, async () => {
    await assert.rejects(headers(), /SN_API_KEY/);
  });
});

test("token mode without a token names both sources", async () => {
  await withEnv(
    { SN_AUTH: "token", SN_BEARER_TOKEN: undefined, SN_TOKEN_FILE: undefined },
    async () => {
      await assert.rejects(headers(), /SN_BEARER_TOKEN or SN_TOKEN_FILE/);
    },
  );
});

test("an unreadable SN_TOKEN_FILE fails with code UNREADABLE", async () => {
  const dir = tempDir();
  try {
    freshRuntime();
    await withEnv(
      { SN_AUTH: "token", SN_TOKEN_FILE: join(dir, "missing.txt") },
      async () => {
        await assert.rejects(headers(), (err) => {
          assert.equal(err.code, "UNREADABLE");
          assert.match(err.message, /Cannot read SN_TOKEN_FILE/);
          return true;
        });
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty SN_TOKEN_FILE fails with code UNREADABLE", async () => {
  const dir = tempDir();
  const file = join(dir, "token.txt");
  writeFileSync(file, "  \n");
  try {
    freshRuntime();
    await withEnv({ SN_AUTH: "token", SN_TOKEN_FILE: file }, async () => {
      await assert.rejects(headers(), (err) => {
        assert.equal(err.code, "UNREADABLE");
        assert.match(err.message, /SN_TOKEN_FILE is empty/);
        return true;
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reloadBearerTokenFile reports only a changed, readable token", async () => {
  await withEnv({ SN_TOKEN_FILE: undefined }, async () => {
    assert.equal(reloadBearerTokenFile(), false);
  });

  const dir = tempDir();
  const file = join(dir, "token.txt");
  writeFileSync(file, "tok-1\n");
  try {
    freshRuntime();
    await withEnv({ SN_AUTH: "token", SN_TOKEN_FILE: file }, async () => {
      assert.deepEqual(await headers(), { Authorization: "Bearer tok-1" });
      // Unchanged file: no retry is worthwhile.
      assert.equal(reloadBearerTokenFile(), false);
      writeFileSync(file, "tok-2\n");
      // The cached token is served until a reload.
      assert.deepEqual(await headers(), { Authorization: "Bearer tok-1" });
      assert.equal(reloadBearerTokenFile(), true);
      assert.deepEqual(await headers(), { Authorization: "Bearer tok-2" });
      // A read error keeps the last good token.
      rmSync(file);
      assert.equal(reloadBearerTokenFile(), false);
      assert.deepEqual(await headers(), { Authorization: "Bearer tok-2" });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- OAuth configuration ----------

test("oauth without a client id fails before any request", async () => {
  await withEnv(
    { SN_AUTH: "oauth", SN_OAUTH_CLIENT_ID: undefined },
    async () => {
      await withFetch(
        () => assert.fail("no token request expected"),
        async () => {
          await assert.rejects(headers(), /SN_OAUTH_CLIENT_ID/);
        },
      );
    },
  );
});

test("an unsupported SN_OAUTH_GRANT is NOT_CONFIGURED", async () => {
  await withEnv({ ...OAUTH, SN_OAUTH_GRANT: "Implicit" }, async () => {
    await assert.rejects(headers(), (err) => {
      assert.equal(err.code, "NOT_CONFIGURED");
      assert.match(err.message, /Unsupported SN_OAUTH_GRANT "implicit"/);
      return true;
    });
  });
});

test("the password grant requires SN_USER and SN_PASSWORD", async () => {
  await withEnv(
    { ...OAUTH, SN_OAUTH_GRANT: "password", SN_USER: undefined },
    async () => {
      await assert.rejects(headers(), /requires SN_USER and SN_PASSWORD/);
    },
  );
});

test("the refresh_token grant requires SN_OAUTH_REFRESH_TOKEN", async () => {
  await withEnv(
    {
      ...OAUTH,
      SN_OAUTH_GRANT: "refresh_token",
      SN_OAUTH_REFRESH_TOKEN: undefined,
    },
    async () => {
      await assert.rejects(headers(), /SN_OAUTH_REFRESH_TOKEN/);
    },
  );
});

// ---------- token responses ----------

test("a token response without access_token is UNEXPECTED_RESPONSE", async () => {
  await withEnv(
    { ...OAUTH, SN_OAUTH_GRANT: "client_credentials" },
    async () => {
      await withFetch(
        () => jsonResponse(200, { token_type: "Bearer" }),
        async () => {
          await assert.rejects(headers(), (err) => {
            assert.equal(err.code, "UNEXPECTED_RESPONSE");
            assert.match(err.message, /did not contain an access_token/);
            return true;
          });
        },
      );
    },
  );
});

test("a token error surfaces error_description, else error", async () => {
  await withEnv(
    { ...OAUTH, SN_OAUTH_GRANT: "client_credentials" },
    async () => {
      await withFetch(
        () =>
          jsonResponse(401, {
            error: "invalid_client",
            error_description: "Client authentication failed",
          }),
        async () => {
          await assert.rejects(headers(), /Client authentication failed/);
        },
      );
      await withFetch(
        () => jsonResponse(401, { error: "invalid_client" }),
        async () => {
          await assert.rejects(headers(), /invalid_client/);
        },
      );
    },
  );
});

test("a missing or invalid expires_in falls back to the default TTL", async () => {
  await withEnv(
    { ...OAUTH, SN_OAUTH_GRANT: "client_credentials" },
    async () => {
      await withFetch(
        () => jsonResponse(200, { access_token: "at-1", expires_in: "soon" }),
        async (calls) => {
          assert.deepEqual(await headers(), { Authorization: "Bearer at-1" });
          // Cached for the default TTL, so a second call makes no request.
          await getAuthProvider().headers(HOST);
          assert.equal(calls.length, 1);
        },
      );
    },
  );
});

// ---------- JWT bearer ----------

test("jwt_bearer reads the key file and honours the claim overrides", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const dir = tempDir();
  const keyFile = join(dir, "key.pem");
  writeFileSync(keyFile, privateKey);
  try {
    await withEnv(
      {
        ...OAUTH,
        SN_OAUTH_GRANT: "jwt_bearer",
        SN_OAUTH_JWT_KEY: undefined,
        SN_OAUTH_JWT_KEY_FILE: keyFile,
        SN_OAUTH_JWT_SUB: "svc.integration",
        SN_OAUTH_JWT_ISS: "issuer-x",
        SN_OAUTH_JWT_AUD: "aud-y",
        SN_OAUTH_JWT_KID: "kid-1",
        SN_OAUTH_JWT_EXP_SEC: "120.9",
      },
      async () => {
        await withFetch(
          () => jsonResponse(200, { access_token: "jwt-at", expires_in: 600 }),
          async (calls) => {
            assert.deepEqual(await headers(), {
              Authorization: "Bearer jwt-at",
            });
            const body = new URLSearchParams(calls[0].init.body);
            const [h, p] = body.get("assertion").split(".");
            assert.equal(decodeJwtPart(h).kid, "kid-1");
            const claims = decodeJwtPart(p);
            assert.equal(claims.iss, "issuer-x");
            assert.equal(claims.aud, "aud-y");
            assert.equal(claims.sub, "svc.integration");
            assert.equal(claims.exp - claims.iat, 120);
          },
        );
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("jwt_bearer without a subject names SN_OAUTH_JWT_SUB", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await withEnv(
    {
      ...OAUTH,
      SN_OAUTH_GRANT: "jwt_bearer",
      SN_OAUTH_JWT_KEY: privateKey,
      SN_OAUTH_JWT_SUB: undefined,
      SN_USER: undefined,
    },
    async () => {
      await withFetch(
        () => assert.fail("no token request expected"),
        async () => {
          await assert.rejects(headers(), /SN_OAUTH_JWT_SUB or SN_USER/);
        },
      );
    },
  );
});

// ---------- Authorization Code exchange ----------

test("an authorization code exchange without access_token is UNEXPECTED_RESPONSE", async () => {
  await withFetch(
    () => jsonResponse(200, { refresh_token: "rt" }),
    async () => {
      await assert.rejects(
        exchangeAuthorizationCode(HOST, {
          clientId: "cid",
          code: "c0de",
          codeVerifier: "v",
          redirectUri: "http://127.0.0.1:8765/callback",
        }),
        (err) => {
          assert.equal(err.code, "UNEXPECTED_RESPONSE");
          assert.match(err.message, /did not return an access_token/);
          return true;
        },
      );
    },
  );
});
