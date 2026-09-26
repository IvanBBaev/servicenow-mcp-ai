// H-10 — HTTP client resilience + identity: dispatcher/proxy matrices, the
// OAuth token request on the shared primitive, error-body shaping, deadline
// and cancellation, the bounded queue, host:port policy and the breaker.
import test from "node:test";
import assert from "node:assert/strict";

import {
  _dispatcherCacheSize,
  _setUndiciLoader,
  dispatcherCacheKey,
  dispatcherOptions,
  disposeDispatchers,
  getDispatcher,
  noProxyMatches,
  resolveProxyForHost,
} from "../build/core/dispatcher.js";
import {
  MAX_JSON_DETAIL_CHARS,
  drainQueue,
  getBreakerStats,
  getQueueStats,
  resetBreakers,
} from "../build/core/http-util.js";
import { snRequest, getTelemetry } from "../build/core/http.js";
import { invalidateTokens } from "../build/core/auth.js";
import { resolveHost } from "../build/core/host.js";
import { testConnection } from "../build/api/diagnostics.js";
import { fail } from "../build/mcp/result.js";
import { ServiceNowError } from "../build/core/errors.js";
import {
  baselineEnv,
  fakeClock,
  flushAsync,
  freshRuntime,
  withEnv,
  withFetch,
  withFetchDouble,
  jsonResponse,
} from "./helpers.js";

baselineEnv();

// The developer's shell may carry proxy/TLS settings; every test starts clean.
const CLEAN = {
  SN_HTTPS_PROXY: undefined,
  HTTPS_PROXY: undefined,
  https_proxy: undefined,
  HTTP_PROXY: undefined,
  http_proxy: undefined,
  NO_PROXY: undefined,
  no_proxy: undefined,
  SN_TLS_CLIENT_CERT: undefined,
  SN_TLS_CLIENT_CERT_FILE: undefined,
  SN_TLS_CLIENT_KEY: undefined,
  SN_TLS_CLIENT_KEY_FILE: undefined,
  SN_TLS_CA: undefined,
  SN_TLS_CA_FILE: undefined,
  SN_TLS_REJECT_UNAUTHORIZED: undefined,
  SN_ALLOWED_HOSTS: undefined,
  SN_BREAKER_THRESHOLD: undefined,
};
for (const key of Object.keys(CLEAN)) delete process.env[key];

const HOST = "dev00000.service-now.com";

/** A stand-in for the optional undici module that records what was built. */
function fakeUndici() {
  const created = [];
  class Agent {
    constructor(opts) {
      this.kind = "Agent";
      this.opts = opts;
      this.closed = false;
      created.push(this);
    }
    close() {
      this.closed = true;
      return Promise.resolve();
    }
  }
  class ProxyAgent extends Agent {
    constructor(opts) {
      super(opts);
      this.kind = "ProxyAgent";
    }
  }
  return { created, module: { Agent, ProxyAgent } };
}

function useFakeUndici() {
  const fake = fakeUndici();
  freshRuntime();
  _setUndiciLoader(async () => fake.module);
  return fake;
}

function restoreUndici() {
  freshRuntime();
  _setUndiciLoader(null);
}

/**
 * A fetch that never answers until its signal aborts (timeouts, cancel). The
 * keep-alive timer stands in for the socket a real fetch would hold open:
 * AbortSignal.timeout() is unref'd and would not keep the test process alive.
 */
const hangUntilAbort = (_url, init) =>
  new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => undefined, 10_000);
    init.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(keepAlive);
        reject(init.signal.reason);
      },
      { once: true },
    );
  });

// --- dispatcher option matrix (8 combinations) -----------------------------

for (const cert of [false, true]) {
  for (const ca of [false, true]) {
    for (const verifyOff of [false, true]) {
      const label = `cert=${cert} ca=${ca} verify=${verifyOff ? "off" : "on"}`;
      test(`dispatcher matrix — ${label}`, async () => {
        const fake = useFakeUndici();
        try {
          await withEnv(
            {
              ...CLEAN,
              SN_TLS_CLIENT_CERT: cert ? "CERT-PEM" : undefined,
              SN_TLS_CLIENT_KEY: cert ? "KEY-PEM" : undefined,
              SN_TLS_CA: ca ? "CA-PEM" : undefined,
              SN_TLS_REJECT_UNAUTHORIZED: verifyOff ? "false" : undefined,
            },
            async () => {
              const d = await getDispatcher(HOST);
              if (!cert && !ca && !verifyOff) {
                assert.equal(d, undefined, "defaults use Node's own fetch");
                assert.equal(fake.created.length, 0);
                return;
              }
              assert.equal(fake.created.length, 1);
              assert.equal(d, fake.created[0]);
              assert.equal(d.kind, "Agent");
              const c = d.opts.connect;
              assert.equal(c.cert, cert ? "CERT-PEM" : undefined);
              assert.equal(c.key, cert ? "KEY-PEM" : undefined);
              assert.equal(c.ca, ca ? "CA-PEM" : undefined);
              assert.equal(c.rejectUnauthorized, !verifyOff);

              // The Jira twin never presents the ServiceNow client identity
              // but keeps the CA and verification policy.
              const j = await getDispatcher("acme.atlassian.net", {
                clientCert: false,
              });
              if (!ca && !verifyOff) {
                assert.equal(j, undefined);
              } else {
                assert.equal(j.opts.connect.cert, undefined);
                assert.equal(j.opts.connect.key, undefined);
                assert.equal(j.opts.connect.ca, ca ? "CA-PEM" : undefined);
                assert.equal(j.opts.connect.rejectUnauthorized, !verifyOff);
              }
            },
          );
        } finally {
          restoreUndici();
        }
      });
    }
  }
}

test("dispatcher — a lone cert or key is a configuration error", () => {
  assert.throws(
    () =>
      dispatcherOptions(HOST, {
        env: { SN_TLS_CLIENT_CERT: "CERT-PEM" },
      }),
    (err) => err instanceof ServiceNowError && /both/.test(err.message),
  );
});

test("dispatcher — cached per material digest and profile, disposed on demand", async () => {
  const fake = useFakeUndici();
  try {
    await withEnv({ ...CLEAN, SN_TLS_CA: "CA-ONE" }, async () => {
      const a = await getDispatcher(HOST);
      assert.equal(await getDispatcher(HOST), a, "same config → same agent");
      process.env.SN_TLS_CA = "CA-TWO";
      const b = await getDispatcher(HOST);
      assert.notEqual(b, a, "different CA → different agent");
      process.env.SN_TLS_CA = "CA-ONE";
      await withEnv({ SN_ACTIVE_PROFILE: "other" }, async () => {
        const c = await getDispatcher(HOST);
        assert.notEqual(c, a, "different profile → different agent");
      });
      assert.equal(_dispatcherCacheSize(), 3);

      disposeDispatchers();
      assert.equal(_dispatcherCacheSize(), 0);
      assert.ok(fake.created.every((agent) => agent.closed));
    });
    // The key is a digest: the PEM itself never appears in it.
    const key = dispatcherCacheKey(
      { tls: { ca: "SECRET-PEM", rejectUnauthorized: true } },
      "default",
    );
    assert.match(key, /^[0-9a-f]{64}\|default$/);
  } finally {
    restoreUndici();
  }
});

test("dispatcher — clear error when undici is not installed", async () => {
  freshRuntime();
  _setUndiciLoader(async () => {
    throw new Error("Cannot find package 'undici'");
  });
  try {
    await withEnv({ ...CLEAN, HTTPS_PROXY: "http://proxy.corp:3128" }, () =>
      assert.rejects(
        getDispatcher(HOST),
        (err) =>
          err instanceof ServiceNowError &&
          /HTTPS proxy/.test(err.message) &&
          /npm install undici/.test(err.message),
      ),
    );
  } finally {
    restoreUndici();
  }
});

// --- proxy / NO_PROXY matrix ------------------------------------------------

const PROXY_CASES = [
  { name: "nothing set", env: {}, want: undefined },
  {
    name: "HTTPS_PROXY",
    env: { HTTPS_PROXY: "http://p1.corp:3128" },
    want: ["HTTPS_PROXY", "p1.corp:3128"],
  },
  {
    name: "lower-case https_proxy",
    env: { https_proxy: "http://p1.corp:3128" },
    want: ["HTTPS_PROXY", "p1.corp:3128"],
  },
  {
    name: "HTTP_PROXY only",
    env: { HTTP_PROXY: "http://p2.corp" },
    want: ["HTTP_PROXY", "p2.corp:80"],
  },
  {
    name: "HTTPS_PROXY beats HTTP_PROXY",
    env: { HTTPS_PROXY: "https://p1.corp", HTTP_PROXY: "http://p2.corp" },
    want: ["HTTPS_PROXY", "p1.corp:443"],
  },
  {
    name: "NO_PROXY exact host",
    env: { HTTPS_PROXY: "http://p1.corp:3128", NO_PROXY: HOST },
    want: undefined,
  },
  {
    name: "NO_PROXY dotted suffix",
    env: { HTTPS_PROXY: "http://p1.corp:3128", NO_PROXY: ".service-now.com" },
    want: undefined,
  },
  {
    name: "NO_PROXY bare suffix with port, mixed case",
    env: {
      HTTPS_PROXY: "http://p1.corp:3128",
      no_proxy: "localhost, Service-Now.com:443",
    },
    want: undefined,
  },
  {
    name: "NO_PROXY wildcard",
    env: { HTTP_PROXY: "http://p2.corp", NO_PROXY: "*" },
    want: undefined,
  },
  {
    name: "NO_PROXY not matching",
    env: {
      HTTPS_PROXY: "http://p1.corp:3128",
      NO_PROXY: "example.com,now.com",
    },
    want: ["HTTPS_PROXY", "p1.corp:3128"],
  },
  {
    name: "SN_HTTPS_PROXY ignores NO_PROXY and beats HTTPS_PROXY",
    env: {
      SN_HTTPS_PROXY: "http://user:pw@sn.corp:8080",
      HTTPS_PROXY: "http://p1.corp:3128",
      NO_PROXY: "*",
    },
    want: ["SN_HTTPS_PROXY", "sn.corp:8080"],
  },
];

for (const c of PROXY_CASES) {
  test(`proxy matrix — ${c.name}`, () => {
    const choice = resolveProxyForHost(HOST, c.env);
    if (c.want === undefined) {
      assert.equal(choice, undefined);
    } else {
      assert.equal(choice.source, c.want[0]);
      assert.equal(choice.host, c.want[1]);
      assert.doesNotMatch(choice.host, /user|pw/, "credentials never in host");
    }
  });
}

test("proxy — NO_PROXY matching ignores ports and does not match partial labels", () => {
  assert.equal(noProxyMatches("a.example.com:8443", "example.com"), true);
  assert.equal(noProxyMatches("badexample.com", "example.com"), false);
  assert.equal(noProxyMatches("x.y", ""), false);
});

test("proxy — a malformed proxy URL fails without echoing the value", () => {
  assert.throws(
    () => resolveProxyForHost(HOST, { HTTPS_PROXY: "not a url secret:pw" }),
    (err) =>
      err instanceof ServiceNowError &&
      /HTTPS_PROXY/.test(err.message) &&
      !err.message.includes("secret"),
  );
  assert.throws(
    () => resolveProxyForHost(HOST, { HTTPS_PROXY: "socks5://p.corp:1080" }),
    /http:\/\/ or https:\/\//,
  );
});

test("proxy — getDispatcher builds a ProxyAgent carrying the TLS options", async () => {
  useFakeUndici();
  try {
    await withEnv(
      { ...CLEAN, HTTPS_PROXY: "http://p1.corp:3128", SN_TLS_CA: "CA-PEM" },
      async () => {
        const d = await getDispatcher(HOST);
        assert.equal(d.kind, "ProxyAgent");
        assert.equal(d.opts.uri, "http://p1.corp:3128/");
        assert.equal(d.opts.requestTls.ca, "CA-PEM");
      },
    );
    await withEnv(
      { ...CLEAN, HTTPS_PROXY: "http://p1.corp:3128", NO_PROXY: HOST },
      async () => {
        assert.equal(await getDispatcher(HOST), undefined, "bypassed host");
      },
    );
  } finally {
    restoreUndici();
  }
});

// --- OAuth token request on the shared primitive ---------------------------

const OAUTH = {
  SN_AUTH: "oauth",
  SN_OAUTH_CLIENT_ID: "h10-client",
  SN_OAUTH_CLIENT_SECRET: "h10-secret",
  SN_OAUTH_GRANT: "password",
};

for (const mode of ["proxy", "mtls"]) {
  test(`OAuth token request under ${mode} uses the dispatcher, UA and the auth bucket`, async () => {
    const fake = useFakeUndici();
    invalidateTokens();
    freshRuntime();
    const extra =
      mode === "proxy"
        ? { SN_HTTPS_PROXY: "http://p1.corp:3128" }
        : { SN_TLS_CLIENT_CERT: "CERT-PEM", SN_TLS_CLIENT_KEY: "KEY-PEM" };
    try {
      await withEnv({ ...CLEAN, ...OAUTH, ...extra }, () =>
        withFetch(
          (url) =>
            url.endsWith("/oauth_token.do")
              ? jsonResponse(200, { access_token: "tok", expires_in: 3600 })
              : jsonResponse(200, { result: [] }),
          async (calls) => {
            await snRequest({ method: "GET", path: "/api/now/table/incident" });
            assert.equal(calls.length, 2);
            const [token, api] = calls;
            assert.match(token.url, /\/oauth_token\.do$/);
            assert.equal(fake.created.length, 1);
            const agent = fake.created[0];
            assert.equal(agent.kind, mode === "proxy" ? "ProxyAgent" : "Agent");
            assert.equal(token.init.dispatcher, agent, "token call dispatched");
            assert.equal(api.init.dispatcher, agent, "API call dispatched");
            assert.match(
              token.init.headers["User-Agent"],
              /^servicenow-mcp-ai\/\S+ \(node\/\d+; /,
            );
            assert.equal(api.init.headers.Authorization, "Bearer tok");
            const perHost = getTelemetry().perHost;
            assert.equal(
              perHost.auth.requests,
              1,
              "token request → auth bucket",
            );
            assert.equal(perHost[HOST].requests, 1);
          },
        ),
      );
    } finally {
      invalidateTokens();
      restoreUndici();
    }
  });
}

test("OAuth token request errors are shaped like API errors (HTML page → UPSTREAM_HTML)", async () => {
  invalidateTokens();
  try {
    await withEnv({ ...CLEAN, ...OAUTH }, () =>
      withFetch(
        () =>
          new Response(`<html><body><h1>Proxy login</h1></body></html>`, {
            status: 407,
            headers: { "content-type": "text/html" },
          }),
        () =>
          assert.rejects(
            snRequest({ method: "GET", path: "/api/now/table/incident" }),
            (err) =>
              err.code === "UPSTREAM_HTML" &&
              /OAuth token request failed \(407\): Proxy login/.test(
                err.message,
              ),
          ),
      ),
    );
  } finally {
    invalidateTokens();
  }
});

// --- error-body shaping ------------------------------------------------------

test("a 300 KB HTML 502 yields an error of at most 1 KB", async () => {
  const filler = "<p>upstream failure &amp; more</p>".repeat(10_000);
  const html = `<!DOCTYPE html><html><head><style>body{color:red}</style><script>var secret=1;</script></head><body>${filler}</body></html>`;
  assert.ok(html.length >= 300_000);
  await withEnv({ ...CLEAN, SN_MAX_RETRIES: "0" }, () =>
    withFetch(
      () =>
        new Response(html, {
          status: 502,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      async () => {
        const err = await snRequest({
          method: "GET",
          path: "/api/now/table/incident",
        }).then(
          () => assert.fail("should have thrown"),
          (e) => e,
        );
        assert.equal(err.status, 502);
        assert.equal(err.code, "UPSTREAM_HTML");
        assert.ok(err.hint);
        assert.doesNotMatch(err.message, /<|secret|color:red/);
        assert.match(err.message, /upstream failure & more/);
        const text = fail(err).content[0].text;
        assert.ok(text.length <= 1024, `tool error is ${text.length} chars`);
        assert.ok(JSON.stringify(err.detail).length <= 1024);
      },
    ),
  );
});

test("a plain-text error body is capped and not classified as HTML", async () => {
  await withEnv({ ...CLEAN, SN_MAX_RETRIES: "0" }, () =>
    withFetch(
      () =>
        new Response("x".repeat(5000), {
          status: 500,
          headers: { "content-type": "text/plain" },
        }),
      () =>
        assert.rejects(
          snRequest({ method: "GET", path: "/api/now/table/incident" }),
          (err) => err.code === undefined && err.message.length < 600,
        ),
    ),
  );
});

test("a JSON error detail is capped at 2 KB", async () => {
  const big = { error: { message: "m".repeat(10_000), detail: "d" } };
  await withEnv({ ...CLEAN, SN_MAX_RETRIES: "0" }, () =>
    withFetch(
      () => jsonResponse(400, big),
      async () => {
        const err = await snRequest({
          method: "GET",
          path: "/api/now/table/incident",
        }).then(
          () => assert.fail("should have thrown"),
          (e) => e,
        );
        assert.equal(err.status, 400);
        assert.equal(err.detail.truncated, true);
        assert.ok(err.detail.raw.length <= MAX_JSON_DETAIL_CHARS);
        assert.ok(err.message.length <= MAX_JSON_DETAIL_CHARS + 64);
      },
    ),
  );
});

// --- deadline, timeout override, cancellation, Retry-After cap -------------

test("SN_DEADLINE_MS: a retry that cannot fit fails fast with DEADLINE_EXCEEDED", async (t) => {
  // E-6 / L9-01: fetch double + fake clock — "fails fast" is asserted as
  // zero virtual time spent, not as a wall-clock bound.
  const clock = fakeClock(t);
  await withEnv({ ...CLEAN, SN_MAX_RETRIES: "5", SN_DEADLINE_MS: "300" }, () =>
    withFetchDouble(
      (d) =>
        d.route("GET", "/api/now/table/incident", {
          status: 503,
          headers: { "retry-after": "2" },
          body: "busy",
        }),
      async (d) => {
        await assert.rejects(
          clock.run(
            snRequest({ method: "GET", path: "/api/now/table/incident" }),
          ),
          (err) =>
            err.code === "DEADLINE_EXCEEDED" &&
            /300ms deadline/.test(err.message),
        );
        assert.equal(d.calls.length, 1, "no doomed retry was attempted");
        assert.equal(clock.elapsed(), 0, "no time was spent on the retry");
      },
    ),
  );
});

test("SN_DEADLINE_MS: backoff retries run until the next wait no longer fits", async (t) => {
  const clock = fakeClock(t);
  await withEnv(
    { ...CLEAN, SN_MAX_RETRIES: "10", SN_DEADLINE_MS: "2500" },
    () =>
      withFetchDouble(
        (d) =>
          d.route("GET", "/api/now/table/incident", {
            status: 503,
            body: "busy",
          }),
        async (d) => {
          await assert.rejects(
            clock.run(
              snRequest({ method: "GET", path: "/api/now/table/incident" }),
              { step: 10 },
            ),
            (err) => err.code === "DEADLINE_EXCEEDED",
          );
          // Backoffs of ~500 and ~1000 ms fit in 2.5 s; the ~2000 ms third
          // one does not, so exactly three attempts are made.
          assert.equal(d.calls.length, 3);
          assert.ok(clock.elapsed() < 2500, `stopped inside the deadline`);
        },
      ),
  );
});

test("SN_DEADLINE_MS clips the last attempt's timeout → DEADLINE_EXCEEDED", async () => {
  await withEnv(
    {
      ...CLEAN,
      SN_MAX_RETRIES: "0",
      SN_TIMEOUT_MS: "5000",
      SN_DEADLINE_MS: "80",
    },
    () =>
      withFetch(hangUntilAbort, () =>
        assert.rejects(
          snRequest({ method: "GET", path: "/api/now/table/incident" }),
          (err) => err.code === "DEADLINE_EXCEEDED",
        ),
      ),
  );
});

test("per-call timeoutMs overrides SN_TIMEOUT_MS", async () => {
  await withEnv({ ...CLEAN, SN_MAX_RETRIES: "0", SN_TIMEOUT_MS: "30000" }, () =>
    withFetch(hangUntilAbort, async () => {
      // AbortSignal.timeout runs on real time (mock.timers cannot drive it);
      // the message proves the 50 ms override won over SN_TIMEOUT_MS.
      await assert.rejects(
        snRequest({
          method: "GET",
          path: "/api/now/table/incident",
          timeoutMs: 50,
        }),
        /timed out after 50ms/,
      );
    }),
  );
});

test("the caller's AbortSignal cancels the attempt and is never retried", async () => {
  await withEnv({ ...CLEAN, SN_MAX_RETRIES: "3" }, () =>
    withFetchDouble(
      (d) => d.route("GET", "/api/now/table/incident", { hang: true }),
      async (d) => {
        const controller = new AbortController();
        const pending = snRequest({
          method: "GET",
          path: "/api/now/table/incident",
          signal: controller.signal,
        });
        // Abort once the attempt is in flight — no timer involved.
        while (d.calls.length === 0) await flushAsync(1);
        controller.abort();
        await assert.rejects(pending, /cancelled by the caller/);
        assert.equal(d.calls.length, 1);
      },
    ),
  );
});

test("an abort during the retry backoff ends the wait at once (virtual time)", async (t) => {
  const clock = fakeClock(t);
  await withEnv({ ...CLEAN, SN_MAX_RETRIES: "3" }, () =>
    withFetchDouble(
      (d) =>
        d.route("GET", "/api/now/table/incident", {
          status: 503,
          body: "busy",
        }),
      async (d) => {
        const controller = new AbortController();
        const pending = snRequest({
          method: "GET",
          path: "/api/now/table/incident",
          signal: controller.signal,
        });
        pending.catch(() => {});
        await clock.flush();
        assert.equal(d.calls.length, 1, "parked in the backoff");
        controller.abort();
        await assert.rejects(pending, (err) => err.code === "CANCELLED");
        clock.tick(60_000);
        await clock.flush();
        assert.equal(d.calls.length, 1, "no retry after the abort");
        assert.equal(clock.elapsed(), 60_000);
      },
    ),
  );
});

test("SN_RETRY_AFTER_MAX_MS caps an absurd Retry-After", async (t) => {
  const clock = fakeClock(t);
  await withEnv(
    { ...CLEAN, SN_MAX_RETRIES: "1", SN_RETRY_AFTER_MAX_MS: "20" },
    () =>
      withFetchDouble(
        (d) =>
          d.route("GET", "/api/now/table/incident", [
            { status: 429, headers: { "retry-after": "3600" }, body: "" },
            { json: { result: [] } },
          ]),
        async (d) => {
          await clock.run(
            snRequest({ method: "GET", path: "/api/now/table/incident" }),
            { step: 5 },
          );
          assert.equal(d.calls.length, 2);
          assert.equal(
            d.calls[1].at - d.calls[0].at,
            20,
            "waited the cap, not the hour",
          );
        },
      ),
  );
});

// --- bounded queue -----------------------------------------------------------

test("the 65th queued call fails fast with BUSY; diagnostics bypass the queue", async (t) => {
  freshRuntime();
  const clock = fakeClock(t);
  const gates = [];
  await withEnv(
    {
      ...CLEAN,
      SN_MAX_CONCURRENT: "1",
      SN_MAX_QUEUE: undefined, // default 64
      SN_QUEUE_TIMEOUT_MS: "60000",
    },
    () =>
      withFetch(
        (url) => {
          if (url.includes("/api/now/table/sys_user")) {
            return jsonResponse(200, { result: [{ user_name: "alice" }] });
          }
          return new Promise((resolve) =>
            gates.push(() => resolve(jsonResponse(200, { result: [] }))),
          );
        },
        async () => {
          const call = () =>
            snRequest({ method: "GET", path: "/api/now/table/incident" });
          const pending = Array.from({ length: 65 }, call); // 1 active + 64 queued
          for (let i = 0; i < 50 && gates.length === 0; i++) {
            await new Promise((r) => setImmediate(r));
          }
          assert.deepEqual(getQueueStats()[HOST], { active: 1, queued: 64 });

          await assert.rejects(
            call(),
            (err) =>
              err instanceof ServiceNowError &&
              err.code === "BUSY" &&
              /queue .* is full/.test(err.message),
          );
          assert.equal(clock.elapsed(), 0, "rejected without waiting");

          // test_connection (and doctor through it) still answers.
          const probe = await testConnection();
          assert.equal(probe.ok, true);

          // Drain the line: each release hands the slot to the next waiter.
          let settled = false;
          const all = Promise.all(pending).then(() => {
            settled = true;
          });
          while (!settled) {
            while (gates.length) gates.shift()();
            await flushAsync(1);
          }
          await all;
          assert.deepEqual(getQueueStats(), {});
        },
      ),
  );
});

test("SN_QUEUE_TIMEOUT_MS: a waiter that cannot get a slot in time gets BUSY", async (t) => {
  // E-6 / L9-01: on the fetch double and fake clock — the waiter is released
  // exactly when the virtual queue timeout passes, not "some time later".
  freshRuntime();
  const clock = fakeClock(t);
  let release;
  await withEnv(
    { ...CLEAN, SN_MAX_CONCURRENT: "1", SN_QUEUE_TIMEOUT_MS: "30" },
    () =>
      withFetchDouble(
        (d) =>
          d.route(
            "GET",
            "/api/now/table/a",
            () =>
              new Promise((resolve) => {
                release = () => resolve({ json: { result: [] } });
              }),
          ),
        async (d) => {
          const first = snRequest({ method: "GET", path: "/api/now/table/a" });
          await clock.flush();
          const second = snRequest({ method: "GET", path: "/api/now/table/b" });
          second.catch(() => {});
          await clock.flush();
          clock.tick(29);
          await clock.flush();
          assert.deepEqual(getQueueStats()[HOST], { active: 1, queued: 1 });
          await assert.rejects(
            clock.run(second, { step: 1 }),
            (err) =>
              err.code === "BUSY" && /Timed out after 30ms/.test(err.message),
          );
          assert.equal(clock.elapsed(), 30);
          assert.equal(d.callsTo("GET", "/api/now/table/b").length, 0);
          release();
          await first;
        },
      ),
  );
});

test("drainQueue rejects every waiter with BUSY (lifecycle dispose hook)", async () => {
  freshRuntime();
  let release;
  await withEnv(
    { ...CLEAN, SN_MAX_CONCURRENT: "1", SN_QUEUE_TIMEOUT_MS: "60000" },
    () =>
      withFetch(
        () =>
          new Promise((resolve) => {
            // Stands in for the open socket (the queue timer is unref'd).
            const keepAlive = setTimeout(() => undefined, 10_000);
            release = () => {
              clearTimeout(keepAlive);
              resolve(jsonResponse(200, { result: [] }));
            };
          }),
        async () => {
          const first = snRequest({ method: "GET", path: "/api/now/table/a" });
          const queued = snRequest({ method: "GET", path: "/api/now/table/b" });
          await new Promise((r) => setImmediate(r));
          assert.equal(drainQueue(), 1);
          await assert.rejects(
            queued,
            (err) => err.code === "BUSY" && /drained/.test(err.message),
          );
          release();
          await first;
        },
      ),
  );
});

// --- host:port and IPv6 policy ---------------------------------------------

test("explicit port and bracketed IPv6 are accepted only when allow-listed", async () => {
  await withEnv({ ...CLEAN }, () => {
    assert.throws(() => resolveHost("dev1.service-now.com:8443"), /port 8443/);
    assert.throws(() => resolveHost("[2001:db8::1]"), /IPv6/);
    assert.equal(
      resolveHost("dev1.service-now.com:443"),
      "dev1.service-now.com",
      "the https default port is dropped",
    );
    assert.throws(() => resolveHost("dev1.service-now.com:99999"), /Invalid/);
  });
  await withEnv(
    { ...CLEAN, SN_ALLOWED_HOSTS: "sn.corp.example:8443,[2001:db8::1]" },
    () => {
      assert.equal(
        resolveHost("https://sn.corp.example:8443/x"),
        "sn.corp.example:8443",
      );
      assert.equal(resolveHost("[2001:DB8::1]"), "[2001:db8::1]");
      assert.throws(() => resolveHost("sn.corp.example"), /not permitted/);
      assert.throws(() => resolveHost("sn.corp.example:9443"), /not permitted/);
      assert.throws(() => resolveHost("[2001:db8::2]"), /not permitted/);
    },
  );
  await withEnv({ ...CLEAN, SN_ALLOWED_HOSTS: "corp.example" }, () => {
    assert.throws(
      () => resolveHost("sn.corp.example:8443"),
      /not permitted/,
      "a portless entry does not open other ports",
    );
  });
});

// --- circuit breaker (opt-in) ------------------------------------------------

test("breaker: opens after SN_BREAKER_THRESHOLD failures, spares diagnostics, resets", async () => {
  resetBreakers();
  await withEnv(
    {
      ...CLEAN,
      SN_MAX_RETRIES: "0",
      SN_BREAKER_THRESHOLD: "2",
      SN_BREAKER_RESET_MS: "60000",
    },
    () =>
      withFetch(
        (url) =>
          url.includes("sys_user")
            ? jsonResponse(503, { error: { message: "down" } })
            : jsonResponse(503, { error: { message: "down" } }),
        async (calls) => {
          const call = () =>
            snRequest({ method: "GET", path: "/api/now/table/incident" });
          await assert.rejects(call(), (e) => e.status === 503);
          await assert.rejects(call(), (e) => e.status === 503);
          assert.deepEqual(getBreakerStats()[HOST], {
            failures: 2,
            open: true,
          });
          await assert.rejects(
            call(),
            (e) => e.code === "CIRCUIT_OPEN" && e.hint !== undefined,
          );
          assert.equal(calls.length, 2, "an open breaker sends nothing");

          const probe = await testConnection();
          assert.equal(probe.status, 503, "diagnostics still reach the host");
          assert.equal(calls.length, 3);

          resetBreakers();
          await assert.rejects(call(), (e) => e.status === 503);
          assert.equal(calls.length, 4);
        },
      ),
  );
  resetBreakers();
});

test("breaker: half-open after the reset window; a success closes it", async (t) => {
  resetBreakers();
  const clock = fakeClock(t);
  let healthy = false;
  await withEnv(
    {
      ...CLEAN,
      SN_MAX_RETRIES: "0",
      SN_BREAKER_THRESHOLD: "1",
      SN_BREAKER_RESET_MS: "20",
    },
    () =>
      withFetch(
        () =>
          healthy
            ? jsonResponse(200, { result: [] })
            : new Response("", { status: 500 }),
        async () => {
          const call = () =>
            snRequest({ method: "GET", path: "/api/now/table/incident" });
          await assert.rejects(call(), (e) => e.status === 500);
          await assert.rejects(call(), (e) => e.code === "CIRCUIT_OPEN");
          clock.tick(30); // the breaker window is Date-based
          healthy = true;
          await call();
          assert.deepEqual(getBreakerStats(), {});
        },
      ),
  );
});

test("breaker: disabled by default — repeated failures never open it", async () => {
  resetBreakers();
  await withEnv({ ...CLEAN, SN_MAX_RETRIES: "0" }, () =>
    withFetch(
      () => new Response("", { status: 500 }),
      async (calls) => {
        for (let i = 0; i < 8; i++) {
          await assert.rejects(
            snRequest({ method: "GET", path: "/api/now/table/incident" }),
            (e) => e.status === 500,
          );
        }
        assert.equal(calls.length, 8);
        assert.deepEqual(getBreakerStats(), {});
      },
    ),
  );
});
