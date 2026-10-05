// N-55 (TK-31) — tool-call diagnostics channels, W3C Trace Context from
// params._meta, outbound propagation (SN_OTEL_PROPAGATE) and the opt-in
// OpenTelemetry subscriber (SN_OTEL) with a fake @opentelemetry/api.
import test from "node:test";
import assert from "node:assert/strict";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { z } from "zod";

import { defineTool, runSpec } from "../build/mcp/define.js";
import { ok } from "../build/mcp/result.js";
import { queryTable } from "../build/api/table.js";
import { DIAGNOSTICS_CHANNELS } from "../build/core/metrics.js";
import {
  TOOL_CALL_CHANNELS,
  outboundTraceHeaders,
  parseTraceparent,
  resultBytes,
  resultErrorCode,
  toolCallObserved,
  traceContextFromMeta,
} from "../build/core/tracing.js";
import {
  OTEL_API_MODULE,
  formatTraceparent,
  resetOtelWarning,
  startOtelSubscriber,
  subscribeSpans,
} from "../build/core/otel.js";
import { otelEnabled, otelPropagate } from "../build/core/settings.js";
import { logger } from "../build/core/logging.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_ID}-01`;

/** A tool spec with a scriptable handler (never registered). */
function spec(handler, extra = {}) {
  return defineTool({
    name: "servicenow_query_table",
    title: "Test",
    description: "Test tool",
    package: "core",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: { secret_arg: z.string().optional() },
    handler,
    ...extra,
  });
}

/** Collect every tool-call and HTTP channel event while subscribed. */
function listen() {
  const events = [];
  const handlers = [];
  const names = {
    ...Object.fromEntries(
      Object.entries(TOOL_CALL_CHANNELS).map(([k, v]) => [`tool.${k}`, v]),
    ),
    ...DIAGNOSTICS_CHANNELS,
  };
  for (const [key, name] of Object.entries(names)) {
    const fn = (message) => events.push({ key, message: { ...message } });
    handlers.push([name, fn]);
    subscribe(name, fn);
  }
  return {
    events,
    stop: () => handlers.forEach(([name, fn]) => unsubscribe(name, fn)),
  };
}

// --- traceparent parsing ---------------------------------------------------------

test("parseTraceparent accepts a valid W3C traceparent", () => {
  assert.deepEqual(parseTraceparent(TRACEPARENT), {
    traceparent: TRACEPARENT,
    traceId: TRACE_ID,
    parentId: PARENT_ID,
    flags: 1,
  });
  assert.equal(parseTraceparent(` ${TRACEPARENT} `)?.traceparent, TRACEPARENT);
  // A future version may append fields.
  assert.equal(
    parseTraceparent(`01-${TRACE_ID}-${PARENT_ID}-00-extra`)?.flags,
    0,
  );
});

test("parseTraceparent rejects invalid values", () => {
  for (const bad of [
    undefined,
    42,
    "",
    "garbage",
    TRACEPARENT.toUpperCase(),
    `ff-${TRACE_ID}-${PARENT_ID}-01`,
    `00-${TRACE_ID}-${PARENT_ID}-01-extra`,
    `00-${"0".repeat(32)}-${PARENT_ID}-01`,
    `00-${TRACE_ID}-${"0".repeat(16)}-01`,
    `00-${TRACE_ID.slice(1)}-${PARENT_ID}-01`,
    `00-${TRACE_ID}-${PARENT_ID}-1`,
    "x".repeat(600),
  ]) {
    assert.equal(parseTraceparent(bad), undefined, String(bad).slice(0, 60));
  }
});

test("traceContextFromMeta keeps a well-formed tracestate only", () => {
  assert.equal(traceContextFromMeta(undefined), undefined);
  assert.equal(traceContextFromMeta("x"), undefined);
  assert.equal(traceContextFromMeta({ tracestate: "a=b" }), undefined);
  assert.equal(
    traceContextFromMeta({ traceparent: TRACEPARENT, tracestate: "rojo=1" })
      .tracestate,
    "rojo=1",
  );
  for (const state of ["", "   ", "a=é", "a=b\n", "x".repeat(513), 7]) {
    const ctx = traceContextFromMeta({
      traceparent: TRACEPARENT,
      tracestate: state,
    });
    assert.equal(ctx.traceparent, TRACEPARENT);
    assert.equal("tracestate" in ctx, false);
  }
});

test("outboundTraceHeaders prefers a subscriber's span context", () => {
  const call = traceContextFromMeta({
    traceparent: TRACEPARENT,
    tracestate: "a=1",
  });
  assert.equal(outboundTraceHeaders(undefined, undefined), undefined);
  assert.deepEqual(outboundTraceHeaders(undefined, call), {
    traceparent: TRACEPARENT,
    tracestate: "a=1",
  });
  const span = `00-${TRACE_ID}-${"1".repeat(16)}-01`;
  assert.deepEqual(outboundTraceHeaders({ outboundTraceparent: span }, call), {
    traceparent: span,
  });
  assert.deepEqual(
    outboundTraceHeaders({ outboundTraceparent: "bogus" }, call),
    { traceparent: TRACEPARENT, tracestate: "a=1" },
    "an invalid subscriber value falls back to the call's context",
  );
});

test("resultBytes / resultErrorCode read result metadata", () => {
  assert.equal(
    resultBytes({ content: [{ type: "text", text: "é" }, { type: "image" }] }),
    2,
  );
  assert.equal(resultBytes({}), 0);
  assert.equal(
    resultErrorCode({ content: [{ type: "text", text: '{"code":"X"}' }] }),
    "X",
  );
  assert.equal(
    resultErrorCode({ content: [{ type: "text", text: "{" }] }),
    undefined,
  );
  assert.equal(
    resultErrorCode({ content: [{ type: "text", text: "{}" }] }),
    undefined,
  );
  assert.equal(resultErrorCode({ content: [] }), undefined);
});

// --- tool-call channels -------------------------------------------------------------

test("a successful call publishes start / end with metadata only", async () => {
  freshRuntime();
  const sub = listen();
  let res;
  try {
    res = await runSpec(
      spec(async () => ok({ rows: ["confidential-row"] })),
      { secret_arg: "hunter2" },
      {
        requestId: 7,
        sessionId: "sess-1",
        _meta: { traceparent: TRACEPARENT, tracestate: "rojo=1" },
      },
    );
  } finally {
    sub.stop();
  }
  assert.equal(res.isError, undefined);
  const tool = sub.events.filter((e) => e.key.startsWith("tool."));
  assert.deepEqual(
    tool.map((e) => e.key),
    ["tool.start", "tool.end"],
  );
  const [start, end] = tool.map((e) => e.message);
  assert.equal(typeof start.id, "number");
  assert.equal(end.id, start.id);
  assert.equal(start.tool, "servicenow_query_table");
  assert.equal(start.package, "core");
  assert.equal(start.requestId, "7");
  assert.equal(start.sessionId, "sess-1");
  assert.equal(start.traceparent, TRACEPARENT);
  assert.equal(start.tracestate, "rojo=1");
  assert.equal("profile" in start, false);
  assert.equal(end.profile, "default");
  assert.equal(end.outcome, "ok");
  assert.equal(typeof end.ms, "number");
  assert.ok(end.resultBytes > 0);
  const serialized = JSON.stringify(tool);
  assert.doesNotMatch(serialized, /hunter2|confidential-row|s3cret|alice/);
});

test("an error result publishes start / error with the stable code", async () => {
  freshRuntime();
  const sub = listen();
  try {
    await runSpec(
      spec(async () => {
        throw new Error("boom s3cret");
      }),
      {},
      { _meta: { traceparent: "invalid" } },
    );
    await runSpec(
      spec(async () => ok({})),
      { instance: "nope" },
    );
  } finally {
    sub.stop();
  }
  const tool = sub.events.filter((e) => e.key.startsWith("tool."));
  assert.deepEqual(
    tool.map((e) => e.key),
    ["tool.start", "tool.error", "tool.start", "tool.error"],
  );
  const failed = tool[1].message;
  assert.equal(failed.outcome, "error");
  assert.equal(failed.code, "INTERNAL_ERROR");
  assert.equal(
    "traceparent" in failed,
    false,
    "an invalid traceparent is dropped",
  );
  assert.match(failed.requestId, /^local-/);
  assert.equal(tool[3].message.code, "UNKNOWN_PROFILE");
  assert.doesNotMatch(JSON.stringify(tool), /boom|s3cret/);
});

test("a cancelled call reports outcome cancelled", async () => {
  freshRuntime();
  const ac = new AbortController();
  ac.abort();
  const sub = listen();
  try {
    await runSpec(
      spec(async () => {
        throw new Error("aborted");
      }),
      {},
      { signal: ac.signal },
    );
  } finally {
    sub.stop();
  }
  const error = sub.events.find((e) => e.key === "tool.error").message;
  assert.equal(error.outcome, "cancelled");
});

test("a call that throws past the handler still publishes error", async () => {
  freshRuntime();
  const sub = listen();
  try {
    await assert.rejects(
      runSpec(
        spec(async () => ok({}), {
          logFields: () => {
            throw new TypeError("bad fields");
          },
        }),
        {},
      ),
      /bad fields/,
    );
  } finally {
    sub.stop();
  }
  const error = sub.events.find((e) => e.key === "tool.error").message;
  assert.equal(error.errorName, "TypeError");
  assert.equal(error.outcome, "error");
});

test("no subscriber: nothing is built and behaviour is unchanged", async () => {
  freshRuntime();
  assert.equal(toolCallObserved(), false);
  const res = await runSpec(
    spec(async () => ok({ a: 1 })),
    {},
  );
  assert.equal(res.isError, undefined);
});

// --- HTTP propagation -----------------------------------------------------------------

test("the trace context reaches the HTTP channels; no header by default", async () => {
  freshRuntime();
  const sub = listen();
  let fetches;
  try {
    await withFetch(
      () => jsonResponse(200, { result: [] }),
      async (calls) => {
        fetches = calls;
        await runSpec(
          spec(async () => ok(await queryTable({ table: "incident" }))),
          {},
          { requestId: 1, _meta: { traceparent: TRACEPARENT } },
        );
      },
    );
  } finally {
    sub.stop();
  }
  const start = sub.events.find((e) => e.key === "tool.start").message;
  const http = sub.events.find((e) => e.key === "requestStart").message;
  assert.equal(http.callId, start.id);
  assert.equal(http.traceparent, TRACEPARENT);
  assert.equal(fetches[0].init.headers.traceparent, undefined);
  assert.equal(otelPropagate(), false);
});

test("SN_OTEL_PROPAGATE forwards traceparent / tracestate to ServiceNow", async () => {
  freshRuntime();
  const fetches = await withEnv({ SN_OTEL_PROPAGATE: "1" }, () =>
    withFetch(
      () => jsonResponse(200, { result: [] }),
      async (calls) => {
        await runSpec(
          spec(async () => ok(await queryTable({ table: "incident" }))),
          {},
          { _meta: { traceparent: TRACEPARENT, tracestate: "a=1" } },
        );
        // Outside a tool call: no context, no header.
        await queryTable({ table: "incident" });
        return calls;
      },
    ),
  );
  assert.equal(fetches[0].init.headers.traceparent, TRACEPARENT);
  assert.equal(fetches[0].init.headers.tracestate, "a=1");
  assert.equal(fetches[1].init.headers.traceparent, undefined);
});

// --- the SN_OTEL subscriber -------------------------------------------------------------

/** A recording stand-in for @opentelemetry/api. */
function fakeApi() {
  const spans = [];
  let seq = 0;
  const api = {
    ROOT_CONTEXT: { root: true },
    SpanKind: { SERVER: 1, CLIENT: 2 },
    SpanStatusCode: { ERROR: 2 },
    context: { active: () => ({ active: true }) },
    createTraceState: (raw) => ({ serialize: () => raw }),
    trace: {
      getTracer: (name, version) => ({
        startSpan(spanName, options, parent) {
          const n = ++seq;
          const span = {
            tracer: { name, version },
            name: spanName,
            kind: options.kind,
            attributes: { ...options.attributes },
            parent,
            events: [],
            status: undefined,
            ended: false,
            setAttribute(k, v) {
              this.attributes[k] = v;
            },
            setAttributes(a) {
              Object.assign(this.attributes, a);
            },
            setStatus(s) {
              this.status = s;
            },
            addEvent(e, a) {
              this.events.push({ name: e, attributes: a });
            },
            spanContext: () => ({
              traceId: parent?.remote?.traceId ?? TRACE_ID,
              spanId: n.toString(16).padStart(16, "0"),
              traceFlags: 1,
            }),
            end() {
              this.ended = true;
            },
          };
          spans.push(span);
          return span;
        },
      }),
      setSpan: (ctx, span) => ({ ...ctx, span }),
      setSpanContext: (ctx, sc) => ({ ...ctx, remote: sc }),
    },
  };
  return { api, spans };
}

test("SN_OTEL off: the API module is never loaded", async () => {
  assert.equal(otelEnabled(), false);
  let loaded = false;
  const sub = await startOtelSubscriber({
    load: async () => {
      loaded = true;
      return fakeApi().api;
    },
  });
  assert.equal(sub, undefined);
  assert.equal(loaded, false);
});

test("SN_OTEL on without the peer dependency: one warning, no-op", async () => {
  resetOtelWarning();
  const warnings = [];
  const realWarn = logger.warn;
  logger.warn = (message) => warnings.push(message);
  try {
    await withEnv({ SN_OTEL: "1" }, async () => {
      // The real dynamic import: the package is not installed here.
      assert.equal(await startOtelSubscriber(), undefined);
      assert.equal(
        await startOtelSubscriber({ load: async () => ({ nothing: 1 }) }),
        undefined,
      );
    });
  } finally {
    logger.warn = realWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], new RegExp(OTEL_API_MODULE.replace("/", "\\/")));
  assert.equal(toolCallObserved(), false);
});

test("SN_OTEL on: tool and HTTP spans with semantic-convention attributes", async () => {
  freshRuntime();
  const { api, spans } = fakeApi();
  const sub = await withEnv({ SN_OTEL: "1", SN_OTEL_PROPAGATE: "1" }, () =>
    startOtelSubscriber({ load: async () => ({ default: api }) }),
  );
  assert.ok(sub);
  let fetches;
  try {
    fetches = await withEnv(
      { SN_OTEL_PROPAGATE: "1", SN_MAX_RETRIES: "1" },
      () =>
        withFetch(
          (_url, _init, callNo) =>
            callNo === 1
              ? jsonResponse(503, {}, { "retry-after": "0" })
              : jsonResponse(200, { result: [] }),
          async (calls) => {
            await runSpec(
              spec(async () => ok(await queryTable({ table: "incident" }))),
              {},
              {
                requestId: 9,
                sessionId: "s-9",
                _meta: { traceparent: TRACEPARENT, tracestate: "k=v" },
              },
            );
            return calls;
          },
        ),
    );
  } finally {
    sub.stop();
  }
  assert.equal(spans.length, 2);
  const [tool, http] = spans;
  assert.equal(tool.name, "tools/call servicenow_query_table");
  assert.equal(tool.kind, api.SpanKind.SERVER);
  assert.equal(tool.parent.remote.traceId, TRACE_ID);
  assert.equal(tool.parent.remote.spanId, PARENT_ID);
  assert.equal(tool.parent.remote.isRemote, true);
  assert.equal(tool.parent.remote.traceState.serialize(), "k=v");
  assert.deepEqual(
    {
      method: tool.attributes["mcp.method.name"],
      op: tool.attributes["gen_ai.operation.name"],
      name: tool.attributes["gen_ai.tool.name"],
      rpc: tool.attributes["jsonrpc.request.id"],
      session: tool.attributes["mcp.session.id"],
      transport: tool.attributes["network.transport"],
      pkg: tool.attributes["servicenow_mcp.package"],
      profile: tool.attributes["servicenow_mcp.profile"],
      outcome: tool.attributes["servicenow_mcp.outcome"],
    },
    {
      method: "tools/call",
      op: "execute_tool",
      name: "servicenow_query_table",
      rpc: "9",
      session: "s-9",
      transport: "pipe",
      pkg: "core",
      profile: "default",
      outcome: "ok",
    },
  );
  assert.equal(tool.status, undefined);
  assert.ok(tool.ended);

  assert.equal(http.name, "GET");
  assert.equal(http.kind, api.SpanKind.CLIENT);
  assert.equal(http.parent.span, tool, "the HTTP span is a child of the call");
  assert.equal(http.attributes["http.request.method"], "GET");
  assert.equal(http.attributes["server.address"], "dev00000.service-now.com");
  assert.doesNotMatch(http.attributes["url.full"], /\?/);
  assert.equal(http.attributes["http.response.status_code"], 200);
  assert.equal(http.attributes["http.request.resend_count"], 1);
  assert.equal(http.events[0].name, "retry");
  assert.ok(http.ended);
  // Propagation names the HTTP client span, not the client's span.
  const sent = fetches.map((f) => f.init.headers.traceparent);
  assert.deepEqual(sent, [
    formatTraceparent(http.spanContext()),
    formatTraceparent(http.spanContext()),
  ]);
  assert.notEqual(sent[0], TRACEPARENT);
  assert.equal(fetches[0].init.headers.tracestate, undefined);
});

test("SN_OTEL spans mark errors and survive malformed messages", async () => {
  freshRuntime();
  const { api, spans } = fakeApi();
  const sub = subscribeSpans(api);
  try {
    await withFetch(
      () => jsonResponse(403, { error: { message: "denied" } }),
      () =>
        runSpec(
          spec(async () => ok(await queryTable({ table: "incident" }))),
          {},
        ),
    );
    // Malformed / unknown messages are ignored, never thrown.
    const { channel } = await import("node:diagnostics_channel");
    channel(TOOL_CALL_CHANNELS.start).publish(null);
    channel(TOOL_CALL_CHANNELS.start).publish({ tool: "x" });
    channel(TOOL_CALL_CHANNELS.end).publish({ id: -5 });
    channel(TOOL_CALL_CHANNELS.end).publish({});
    channel(DIAGNOSTICS_CHANNELS.requestStart).publish({});
    channel(DIAGNOSTICS_CHANNELS.requestRetry).publish({ id: -5 });
    channel(DIAGNOSTICS_CHANNELS.requestEnd).publish({ id: -5 });
    channel(DIAGNOSTICS_CHANNELS.requestEnd).publish({});
  } finally {
    sub.stop();
  }
  const [tool, http] = spans;
  assert.equal(tool.parent.active, true, "no traceparent → the active context");
  assert.equal(tool.attributes["jsonrpc.request.id"], undefined);
  assert.equal(tool.attributes["error.type"], "INSTANCE_HTTP_403");
  assert.equal(tool.status.code, api.SpanStatusCode.ERROR);
  assert.equal(http.attributes["http.response.status_code"], 403);
  assert.equal(http.attributes["error.type"], "INSTANCE_HTTP_403");
  assert.equal(http.status.code, api.SpanStatusCode.ERROR);
  assert.ok(spans.every((s) => s.ended));
});

test("a throwing tracer is contained by the subscriber", async () => {
  freshRuntime();
  const { api } = fakeApi();
  api.trace.getTracer = () => ({
    startSpan() {
      throw new Error("exporter down");
    },
  });
  const sub = subscribeSpans(api);
  try {
    const res = await runSpec(
      spec(async () => ok({ a: 1 })),
      {},
    );
    assert.equal(res.isError, undefined);
  } finally {
    sub.stop();
  }
});

test("formatTraceparent renders a W3C traceparent", () => {
  assert.equal(
    formatTraceparent({ traceId: TRACE_ID, spanId: PARENT_ID, traceFlags: 0 }),
    `00-${TRACE_ID}-${PARENT_ID}-00`,
  );
});
