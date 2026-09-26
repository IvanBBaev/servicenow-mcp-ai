import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";

import { queryTable } from "../build/api/table.js";
import { getAuthMode, invalidateTokens } from "../build/core/auth.js";
import { signJwtRS256 } from "../build/core/jwt.js";
import { getTlsDispatcher } from "../build/core/mtls.js";
import { ServiceNowError } from "../build/core/errors.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
  realFetch,
} from "./helpers.js";

baselineEnv();

const b64urlToBuf = (s) =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const decodeJwtPart = (s) => JSON.parse(b64urlToBuf(s).toString("utf8"));

test("API Key auth sends the x-sn-apikey header", async () => {
  await withEnv({ SN_AUTH: "apikey", SN_API_KEY: "key-123" }, async () => {
    assert.equal(getAuthMode(), "apikey");
    await withFetch(
      (url, init) => {
        assert.equal(init.headers["x-sn-apikey"], "key-123");
        assert.equal(init.headers.Authorization, undefined);
        return jsonResponse(200, { result: [] });
      },
      async () => {
        await queryTable({ table: "incident" });
      },
    );
  });
});

test("a static bearer token is sent verbatim", async () => {
  await withEnv({ SN_AUTH: "token", SN_BEARER_TOKEN: "tok-xyz" }, async () => {
    assert.equal(getAuthMode(), "token");
    await withFetch(
      (url, init) => {
        assert.equal(init.headers.Authorization, "Bearer tok-xyz");
        return jsonResponse(200, { result: [] });
      },
      async () => {
        await queryTable({ table: "incident" });
      },
    );
  });
});

test("SN_AUTH=none sends no auth header (certificate-only)", async () => {
  await withEnv({ SN_AUTH: "none" }, async () => {
    assert.equal(getAuthMode(), "none");
    await withFetch(
      (url, init) => {
        assert.equal(init.headers.Authorization, undefined);
        assert.equal(init.headers["x-sn-apikey"], undefined);
        return jsonResponse(200, { result: [] });
      },
      async () => {
        await queryTable({ table: "incident" });
      },
    );
  });
});

test("getAuthMode infers the method from the present keys", async () => {
  await withEnv({ SN_API_KEY: "k" }, async () =>
    assert.equal(getAuthMode(), "apikey"),
  );
  await withEnv({ SN_BEARER_TOKEN: "t" }, async () =>
    assert.equal(getAuthMode(), "token"),
  );
  await withEnv({ SN_OAUTH_CLIENT_ID: "c" }, async () =>
    assert.equal(getAuthMode(), "oauth"),
  );
  // Baseline (just user/password) is Basic.
  assert.equal(getAuthMode(), "basic");
});

test("signJwtRS256 produces a verifiable RS256 JWS", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const jwt = signJwtRS256({ iss: "a", sub: "b" }, privateKey, "kid1");
  const [h, p, sig] = jwt.split(".");
  assert.equal(decodeJwtPart(h).alg, "RS256");
  assert.equal(decodeJwtPart(h).kid, "kid1");
  assert.equal(decodeJwtPart(p).sub, "b");
  const v = createVerify("RSA-SHA256");
  v.update(`${h}.${p}`);
  assert.ok(v.verify(publicKey, b64urlToBuf(sig)), "signature verifies");
});

test("OAuth JWT-bearer grant signs an assertion and exchanges it for a token", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  await withEnv(
    {
      SN_AUTH: "oauth",
      SN_OAUTH_CLIENT_ID: "jwtcli",
      SN_OAUTH_GRANT: "jwt_bearer",
      SN_OAUTH_JWT_KEY: privateKey,
      SN_OAUTH_JWT_SUB: "svc.user",
    },
    async () => {
      invalidateTokens();
      let assertion;
      globalThis.fetch = async (url, init) => {
        if (String(url).endsWith("/oauth_token.do")) {
          const body = new URLSearchParams(String(init.body));
          assert.equal(
            body.get("grant_type"),
            "urn:ietf:params:oauth:grant-type:jwt-bearer",
          );
          assertion = body.get("assertion");
          return jsonResponse(200, {
            access_token: "at-jwt",
            expires_in: 3600,
          });
        }
        assert.equal(init.headers.Authorization, "Bearer at-jwt");
        return jsonResponse(200, { result: [] });
      };
      try {
        await queryTable({ table: "incident" });
        assert.ok(assertion, "an assertion was sent");
        const [h, p, sig] = assertion.split(".");
        const payload = decodeJwtPart(p);
        assert.equal(payload.iss, "jwtcli");
        assert.equal(payload.sub, "svc.user");
        assert.match(payload.aud, /\/oauth_token\.do$/);
        const v = createVerify("RSA-SHA256");
        v.update(`${h}.${p}`);
        assert.ok(v.verify(publicKey, b64urlToBuf(sig)), "assertion is signed");
      } finally {
        globalThis.fetch = realFetch;
        invalidateTokens();
      }
    },
  );
});

test("mutual TLS: no dispatcher unless configured; clear error when undici is absent", async () => {
  freshRuntime();
  assert.equal(
    await getTlsDispatcher(),
    undefined,
    "unconfigured → no dispatcher",
  );

  await withEnv(
    {
      SN_TLS_CLIENT_CERT:
        "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----",
      SN_TLS_CLIENT_KEY:
        "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
    },
    async () => {
      freshRuntime();
      // undici is an optional dependency and is not installed in this project.
      await assert.rejects(
        getTlsDispatcher(),
        (err) => err instanceof ServiceNowError && /undici/.test(err.message),
      );
    },
  );
  freshRuntime();
});

test("OAuth client_credentials grant mints a bearer token", async () => {
  await withEnv(
    {
      SN_AUTH: "oauth",
      SN_OAUTH_CLIENT_ID: "cc",
      SN_OAUTH_CLIENT_SECRET: "s",
      SN_OAUTH_GRANT: "client_credentials",
    },
    async () => {
      invalidateTokens();
      globalThis.fetch = async (url, init) => {
        if (String(url).endsWith("/oauth_token.do")) {
          assert.match(String(init.body), /grant_type=client_credentials/);
          return jsonResponse(200, { access_token: "at-cc", expires_in: 3600 });
        }
        assert.equal(init.headers.Authorization, "Bearer at-cc");
        return jsonResponse(200, { result: [] });
      };
      try {
        await queryTable({ table: "incident" });
      } finally {
        globalThis.fetch = realFetch;
        invalidateTokens();
      }
    },
  );
});

test("jwt_bearer without a key reports a clear error before any request", async () => {
  await withEnv(
    {
      SN_AUTH: "oauth",
      SN_OAUTH_CLIENT_ID: "j",
      SN_OAUTH_GRANT: "jwt_bearer",
      SN_OAUTH_JWT_SUB: "u",
    },
    async () => {
      invalidateTokens();
      await withFetch(
        () => {
          throw new Error("no token request without a key");
        },
        async (calls) => {
          await assert.rejects(queryTable({ table: "incident" }), (err) =>
            /SN_OAUTH_JWT_KEY/.test(err.message),
          );
          assert.equal(calls.length, 0);
        },
      );
      invalidateTokens();
    },
  );
});
