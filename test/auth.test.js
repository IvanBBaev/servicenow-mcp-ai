import test from "node:test";
import assert from "node:assert/strict";

import { queryTable } from "../build/servicenow.js";
import { invalidateTokens } from "../build/auth.js";
import { baselineEnv, realFetch } from "./helpers.js";

// OAuth password-grant configuration on top of the shared baseline. A unique
// client id keeps this file's token cache entry independent of other tests.
baselineEnv();
process.env.SN_AUTH = "oauth";
process.env.SN_OAUTH_CLIENT_ID = "client-abc";
process.env.SN_OAUTH_CLIENT_SECRET = "shhh";
process.env.SN_OAUTH_GRANT = "password";

test("OAuth: fetches a bearer token and caches it across requests", async () => {
  let tokenCalls = 0;
  let tableCalls = 0;

  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/oauth_token.do")) {
      tokenCalls += 1;
      assert.equal(init.method, "POST");
      assert.match(init.headers["Content-Type"], /x-www-form-urlencoded/);
      assert.match(init.body, /grant_type=password/);
      assert.match(init.body, /client_id=client-abc/);
      return new Response(
        JSON.stringify({ access_token: "tok-123", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    tableCalls += 1;
    assert.equal(init.headers.Authorization, "Bearer tok-123");
    return new Response(JSON.stringify({ result: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await queryTable({ table: "incident" });
    await queryTable({ table: "incident" });
    assert.equal(tokenCalls, 1, "token endpoint should be hit once (cached)");
    assert.equal(tableCalls, 2, "table endpoint should be hit per query");

    // After a credential change the cache must be dropped: the same key would
    // otherwise keep serving a token obtained with the old password.
    invalidateTokens();
    await queryTable({ table: "incident" });
    assert.equal(tokenCalls, 2, "invalidateTokens must force a fresh token");
  } finally {
    globalThis.fetch = realFetch;
  }
});
