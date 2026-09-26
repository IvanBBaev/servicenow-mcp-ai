import test from "node:test";
import assert from "node:assert/strict";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { logger } from "../build/core/logging.js";
import {
  formatLogLine,
  redactLogFields,
  writeLogFile,
} from "../build/core/log-file.js";
import {
  DIAGNOSTICS_CHANNELS,
  TOOL_SAMPLE_SIZE,
  getRateLimitStats,
  getToolStats,
  parseRateLimit,
  percentile,
  recordToolCall,
  timeToolCall,
} from "../build/core/metrics.js";
import {
  getLogFile,
  getLogFileMaxBytes,
  getLogFormat,
  metricsEnabled,
} from "../build/core/settings.js";
import { queryTable } from "../build/api/table.js";
import { buildStatusPayload } from "../build/mcp/status.js";
import { escapeLabel, renderPrometheus } from "../build/mcp/observability.js";
import {
  closeHttpTransport,
  connectTransport,
  isMetricsRequest,
} from "../build/mcp/transport.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

/** Capture console.error lines (raw strings) while `fn` runs. */
async function captureStderr(fn) {
  const lines = [];
  const real = console.error;
  console.error = (line) => lines.push(String(line));
  try {
    await fn();
  } finally {
    console.error = real;
  }
  return lines;
}

// --- settings ----------------------------------------------------------------

test("E-5 settings: defaults and parsing", async () => {
  await withEnv(
    {
      SN_LOG_FORMAT: undefined,
      SN_LOG_FILE: undefined,
      SN_LOG_FILE_MAX_BYTES: undefined,
      SN_METRICS: undefined,
    },
    () => {
      assert.equal(getLogFormat(), "json");
      assert.equal(getLogFile(), undefined);
      assert.equal(getLogFileMaxBytes(), 10 * 1024 * 1024);
      assert.equal(metricsEnabled(), false);
    },
  );
  await withEnv(
    {
      SN_LOG_FORMAT: "TEXT",
      SN_LOG_FILE: "rel/out.log",
      SN_LOG_FILE_MAX_BYTES: "2048",
      SN_METRICS: "1",
    },
    () => {
      assert.equal(getLogFormat(), "text");
      assert.equal(getLogFile(), path.resolve("rel/out.log"));
      assert.equal(getLogFileMaxBytes(), 2048);
      assert.equal(metricsEnabled(), true);
    },
  );
  await withEnv({ SN_LOG_FORMAT: "yaml", SN_METRICS: "no" }, () => {
    assert.equal(getLogFormat(), "json", "an unknown format keeps json");
    assert.equal(metricsEnabled(), false);
  });
});

// --- log format, redaction, file sink ------------------------------------------

test("SN_LOG_FORMAT=text renders a readable line; json stays the default", async () => {
  const entry = {
    ts: "2026-09-24T10:11:12.000Z",
    level: "warn",
    message: "Slow request",
    url: "/api/now/table/incident",
    note: "two words",
    ms: 42,
    nested: { a: 1 },
  };
  await withEnv({ SN_LOG_FORMAT: undefined }, () => {
    assert.deepEqual(JSON.parse(formatLogLine(entry)), entry);
  });
  await withEnv({ SN_LOG_FORMAT: "text" }, () => {
    const line = formatLogLine(entry);
    assert.match(
      line,
      /^\d\d:\d\d:\d\d warn {2}Slow request url=\/api\/now\/table\/incident note="two words" ms=42 nested=\{"a":1\}$/,
    );
  });
  const lines = await captureStderr(() =>
    withEnv({ SN_LOG_FORMAT: "text", SN_LOG_LEVEL: "info" }, () =>
      logger.info("hello", { k: "v" }),
    ),
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], / info {2}hello k=v$/);
});

test("the logger masks credential-named fields in every sink", async () => {
  const masked = redactLogFields({
    password: "hunter2",
    nested: { access_token: "abc", Authorization: "Bearer x", keep: "ok" },
    list: [{ client_secret: "s" }],
    empty: { token: "" },
  });
  assert.deepEqual(masked, {
    password: "***",
    nested: { access_token: "***", Authorization: "***", keep: "ok" },
    list: [{ client_secret: "***" }],
    empty: { token: "" },
  });
  assert.equal(redactLogFields(undefined), undefined);

  const lines = await captureStderr(() =>
    withEnv({ SN_LOG_LEVEL: "info" }, () =>
      logger.info("login", { user: "alice", password: "hunter2" }),
    ),
  );
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.password, "***");
  assert.equal(entry.user, "alice");
  assert.ok(!lines[0].includes("hunter2"));

  // SN_REDACT_PII applies on top.
  const pii = await captureStderr(() =>
    withEnv({ SN_LOG_LEVEL: "info", SN_REDACT_PII: "true" }, () =>
      logger.info("mail", { to: "bob@example.com" }),
    ),
  );
  assert.ok(!pii[0].includes("bob@example.com"));
});

test("SN_LOG_FILE appends JSON lines, rotates by size and never touches stdout", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sn-log-"));
  const file = path.join(dir, "sub", "server.log");
  const realWrite = process.stdout.write;
  let stdoutBytes = 0;
  process.stdout.write = (...args) => {
    stdoutBytes += String(args[0]).length;
    return true;
  };
  try {
    const stderr = await captureStderr(() =>
      withEnv(
        {
          SN_LOG_FILE: file,
          SN_LOG_FILE_MAX_BYTES: "300",
          SN_LOG_LEVEL: "info",
          SN_LOG_FORMAT: "text",
        },
        () => {
          for (let i = 0; i < 12; i++) {
            logger.info(`line ${i}`, { i, token: "t0ps3cret" });
          }
        },
      ),
    );
    assert.equal(stderr.length, 12, "stderr keeps working");
    assert.equal(stdoutBytes, 0, "stdout is never written");

    assert.ok(existsSync(file));
    assert.ok(existsSync(`${file}.1`), "rotated at least once");
    assert.ok(statSync(file).size <= 300);
    if (process.platform !== "win32") {
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
    const live = readFileSync(file, "utf8").trim().split("\n");
    const last = JSON.parse(live.at(-1));
    assert.equal(last.message, "line 11", "the file is JSON even in text mode");
    assert.equal(last.token, "***");
    assert.ok(!readFileSync(`${file}.1`, "utf8").includes("t0ps3cret"));
    assert.ok(!existsSync(`${file}.6`), "at most five generations are kept");
  } finally {
    process.stdout.write = realWrite;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing file sink warns once on stderr and never throws", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sn-log-"));
  // A directory where the file should be: appendFileSync fails (EISDIR).
  const file = dir;
  try {
    const lines = await captureStderr(() =>
      withEnv({ SN_LOG_FILE: file }, () => {
        const entry = {
          ts: new Date().toISOString(),
          level: "info",
          message: "x",
        };
        writeLogFile(entry);
        writeLogFile(entry);
      }),
    );
    assert.equal(lines.length, 1);
    assert.match(JSON.parse(lines[0]).message, /sink disabled/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- tool statistics -------------------------------------------------------------

test("percentile uses the nearest rank", () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([7], 95), 7);
  const xs = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(xs, 50), 50);
  assert.equal(percentile(xs, 95), 95);
});

test("tool stats count calls and errors; the sample ring stays bounded", async () => {
  freshRuntime();
  for (let i = 1; i <= 100; i++) recordToolCall("b_tool", i, i % 10 === 0);
  // Push the early samples out of the window: the last TOOL_SAMPLE_SIZE are 1000s.
  for (let i = 0; i < TOOL_SAMPLE_SIZE; i++)
    recordToolCall("a_tool", 1000, false);
  recordToolCall("a_tool", 1, false);
  const stats = getToolStats();
  assert.deepEqual(Object.keys(stats), ["a_tool", "b_tool"]);
  assert.deepEqual(stats.b_tool, {
    count: 100,
    errors: 10,
    p50: 50,
    p95: 95,
    totalMs: 5050,
  });
  assert.equal(stats.a_tool.count, TOOL_SAMPLE_SIZE + 1);
  assert.equal(stats.a_tool.p50, 1000);

  const ok = await timeToolCall("c_tool", async () => ({ isError: false }));
  assert.deepEqual(ok, { isError: false });
  await timeToolCall("c_tool", async () => ({ isError: true }));
  await assert.rejects(
    timeToolCall("c_tool", async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(getToolStats().c_tool.count, 3);
  assert.equal(getToolStats().c_tool.errors, 2);

  freshRuntime();
  assert.deepEqual(getToolStats(), {}, "a fresh runtime starts empty");
});

// --- rate limits -----------------------------------------------------------------

test("parseRateLimit reads limit / remaining / reset (epoch or delta)", () => {
  const now = Date.parse("2026-09-24T00:00:00Z");
  assert.equal(parseRateLimit(new Headers(), now), undefined);
  assert.deepEqual(
    parseRateLimit(
      new Headers({
        "X-RateLimit-Limit": "1000",
        "X-RateLimit-Remaining": "998",
        "X-RateLimit-Reset": String(now / 1000 + 60),
      }),
      now,
    ),
    {
      limit: 1000,
      remaining: 998,
      resetAt: "2026-09-24T00:01:00.000Z",
      observedAt: "2026-09-24T00:00:00.000Z",
    },
  );
  assert.equal(
    parseRateLimit(new Headers({ "X-RateLimit-Reset": "30" }), now).resetAt,
    "2026-09-24T00:00:30.000Z",
  );
  assert.equal(
    parseRateLimit(new Headers({ "X-RateLimit-Limit": "lots" }), now),
    undefined,
    "non-numeric values are ignored",
  );
});

// --- diagnostics_channel + status + prometheus ---------------------------------

function listen() {
  const events = [];
  const handlers = {};
  for (const [key, name] of Object.entries(DIAGNOSTICS_CHANNELS)) {
    handlers[name] = (message) => events.push({ key, message });
    subscribe(name, handlers[name]);
  }
  return {
    events,
    stop: () => {
      for (const [name, fn] of Object.entries(handlers)) unsubscribe(name, fn);
    },
  };
}

test("the request loop publishes start / retry / end with redacted metadata", async () => {
  freshRuntime();
  const sub = listen();
  try {
    await withEnv({ SN_MAX_RETRIES: "1" }, () =>
      withFetch(
        (_url, _init, callNo) =>
          callNo === 1
            ? jsonResponse(429, {}, { "retry-after": "0" })
            : jsonResponse(
                200,
                { result: [] },
                { "x-ratelimit-limit": "500", "x-ratelimit-remaining": "499" },
              ),
        () =>
          queryTable({ table: "incident", query: "short_description=secret" }),
      ),
    );
  } finally {
    sub.stop();
  }
  const kinds = sub.events.map((e) => e.key);
  assert.deepEqual(kinds, ["requestStart", "requestRetry", "requestEnd"]);
  const [start, retry, end] = sub.events.map((e) => e.message);
  assert.equal(start.system, "ServiceNow");
  assert.equal(start.method, "GET");
  assert.equal(start.host, "dev00000.service-now.com");
  assert.equal(
    start.url,
    "https://dev00000.service-now.com/api/now/table/incident",
  );
  assert.equal(retry.id, start.id);
  assert.equal(retry.reason, "HTTP 429");
  assert.equal(retry.attempt, 1);
  assert.equal(end.id, start.id);
  assert.equal(end.status, 200);
  assert.equal(end.attempts, 2);
  const serialized = JSON.stringify(sub.events);
  assert.ok(
    !serialized.includes("secret"),
    "no query string reaches a message",
  );
  assert.ok(!serialized.includes("s3cret"), "no credentials");
  assert.ok(!/authorization/i.test(serialized), "no headers");

  assert.deepEqual(getRateLimitStats()["dev00000.service-now.com"].limit, 500);
  freshRuntime();
});

test("a failing request publishes start / error with status and attempts", async () => {
  freshRuntime();
  const sub = listen();
  try {
    await withFetch(
      () => jsonResponse(403, { error: { message: "denied" } }),
      () => assert.rejects(queryTable({ table: "incident" })),
    );
  } finally {
    sub.stop();
  }
  assert.deepEqual(
    sub.events.map((e) => e.key),
    ["requestStart", "requestError"],
  );
  const err = sub.events[1].message;
  assert.equal(err.status, 403);
  assert.equal(err.attempts, 1);
  assert.equal(err.errorName, "ServiceNowError");
  assert.match(err.errorMessage, /403/);
  freshRuntime();
});

test("get_status carries the observability block", async () => {
  freshRuntime();
  recordToolCall("servicenow_query_table", 12, false);
  await withEnv({ SN_MAX_RETRIES: "1" }, () =>
    withFetch(
      (_url, _init, callNo) =>
        callNo === 1
          ? jsonResponse(503, {}, { "retry-after": "0" })
          : jsonResponse(200, { result: [] }, { "x-ratelimit-remaining": "7" }),
      () => queryTable({ table: "incident" }),
    ),
  );
  const o = buildStatusPayload().observability;
  assert.deepEqual(Object.keys(o), [
    "tools",
    "sampleWindow",
    "cache",
    "retries",
    "queue",
    "breakers",
    "rateLimit",
  ]);
  assert.equal(o.tools.servicenow_query_table.count, 1);
  assert.equal(o.sampleWindow, TOOL_SAMPLE_SIZE);
  for (const key of ["size", "max", "hits", "misses", "evictions"]) {
    assert.equal(typeof o.cache.schema[key], "number", key);
  }
  assert.equal(o.retries["dev00000.service-now.com"], 1);
  assert.equal(typeof o.queue.limits.maxConcurrent, "number");
  assert.deepEqual(o.queue.hosts, {});
  assert.equal(typeof o.breakers, "object");
  assert.equal(o.rateLimit["dev00000.service-now.com"].remaining, 7);
  freshRuntime();
});

test("renderPrometheus emits the documented families with escaped labels", async () => {
  freshRuntime();
  recordToolCall('odd"tool', 5, true);
  await withFetch(
    () => jsonResponse(200, { result: [] }, { "x-ratelimit-limit": "10" }),
    () => queryTable({ table: "incident" }),
  );
  const text = renderPrometheus();
  assert.match(text, /# TYPE servicenow_mcp_tool_calls_total counter/);
  assert.match(text, /servicenow_mcp_tool_calls_total\{tool="odd\\"tool"\} 1/);
  assert.match(text, /servicenow_mcp_tool_errors_total\{tool="odd\\"tool"\} 1/);
  assert.match(
    text,
    /servicenow_mcp_tool_duration_ms\{tool="odd\\"tool",quantile="0.95"\} 5/,
  );
  assert.match(
    text,
    /servicenow_mcp_http_requests_total\{host="dev00000.service-now.com"\} 1/,
  );
  assert.match(text, /servicenow_mcp_schema_cache_hits_total 0/);
  assert.match(
    text,
    /servicenow_mcp_ratelimit_limit\{host="dev00000.service-now.com"\} 10/,
  );
  assert.ok(text.endsWith("\n"));
  assert.equal(escapeLabel('a\\b\n"c"'), 'a\\\\b\\n\\"c\\"');
  freshRuntime();
});

// --- GET /metrics over the HTTP transport --------------------------------------

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

async function withHttp(env, fn) {
  const port = await freePort();
  await withEnv(
    {
      SN_TRANSPORT: "http",
      SN_PORT: String(port),
      SN_HTTP_HOST: "127.0.0.1",
      SN_LOG_LEVEL: "error",
      ...env,
    },
    async () => {
      const server = new McpServer({ name: "metrics-test", version: "0" });
      await connectTransport(server);
      try {
        await fn(`http://127.0.0.1:${port}/metrics`);
      } finally {
        await server.close().catch(() => undefined);
        await closeHttpTransport();
      }
    },
  );
}

test("isMetricsRequest matches GET /metrics only", () => {
  assert.equal(isMetricsRequest("GET", "/metrics"), true);
  assert.equal(isMetricsRequest("GET", "/metrics?x=1"), true);
  assert.equal(isMetricsRequest("POST", "/metrics"), false);
  assert.equal(isMetricsRequest("GET", "/"), false);
  assert.equal(isMetricsRequest(undefined, undefined), false);
});

test("GET /metrics: served with SN_METRICS=1 and the bearer token", async () => {
  freshRuntime();
  await withHttp({ SN_METRICS: "1", SN_HTTP_TOKEN: "tok" }, async (url) => {
    const ok = await fetch(url, {
      headers: { authorization: "Bearer tok" },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(ok.status, 200);
    assert.match(
      ok.headers.get("content-type"),
      /^text\/plain; version=0\.0\.4/,
    );
    assert.match(
      await ok.text(),
      /# TYPE servicenow_mcp_tool_calls_total counter/,
    );

    const denied = await fetch(url, { signal: AbortSignal.timeout(5000) });
    assert.equal(denied.status, 401);
    await denied.text();
  });
});

test("GET /metrics is not served without SN_METRICS or without a token", async () => {
  await withHttp(
    { SN_METRICS: undefined, SN_HTTP_TOKEN: "tok" },
    async (url) => {
      const res = await fetch(url, {
        headers: { authorization: "Bearer tok" },
        signal: AbortSignal.timeout(5000),
      });
      assert.notEqual(res.status, 200);
      assert.ok(!(await res.text()).includes("servicenow_mcp_"));
    },
  );
  const lines = await captureStderr(() =>
    withHttp(
      { SN_METRICS: "1", SN_HTTP_TOKEN: undefined, SN_LOG_LEVEL: "warn" },
      async (url) => {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        assert.notEqual(res.status, 200);
        assert.ok(!(await res.text()).includes("servicenow_mcp_"));
      },
    ),
  );
  assert.ok(
    lines.some((l) => l.includes("GET /metrics stays disabled")),
    "a missing token is reported at startup",
  );
});
