// N-35 / ADR 0008 — conformance rows of the 2026-07-28 multi round-trip
// requests (MRTR) and the "no server→client requests" rule, pinned against
// the real server factory behind the SDK's modern handler (HTTP) and the
// built stdio entry point. The behaviour itself is in src/mcp/input.ts;
// mrtr-input.test.js covers the flows, this file the matrix rows.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { buildMcpServer } from "../build/server.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const MODERN = "2026-07-28";
const FORM = { elicitation: { form: {} } };
const SYS_ID = "b".repeat(32);
const DELETE = { table: "incident", sys_id: SYS_ID };
const CONFIRM = { confirm: true };
const TOOL = "servicenow_delete_record";

const envelope = (capabilities = FORM) => ({
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "mrtr-conf", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": capabilities,
});

/**
 * A modern client on one shared runtime. `requests` records every
 * server→client request any served instance tried to send.
 */
function modernClient(runtime) {
  const requests = [];
  const handler = createMcpHandler(
    () => {
      const server = buildMcpServer(runtime);
      const send = server.server.request.bind(server.server);
      server.server.request = (req, ...rest) => {
        requests.push(req.method);
        return send(req, ...rest);
      };
      return server;
    },
    { legacy: "reject", onerror: () => {} },
  );
  let id = 0;
  /** POST a raw body; returns every JSON-RPC message of the response. */
  async function post(body, { method, name, authInfo } = {}) {
    const res = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MODERN,
          ...(method ? { "mcp-method": method } : {}),
          ...(name ? { "mcp-name": name } : {}),
        },
        body,
      }),
      authInfo ? { authInfo } : undefined,
    );
    const text = await res.text();
    if (!res.headers.get("content-type")?.includes("text/event-stream")) {
      return [JSON.parse(text)];
    }
    return text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)));
  }
  const frames = [];
  async function rpc(method, params, options = {}) {
    id += 1;
    const messages = await post(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: { ...params, _meta: envelope(options.capabilities) },
      }),
      { method, name: params.name, authInfo: options.authInfo },
    );
    frames.push(...messages);
    return messages.find((m) => m.id === id);
  }
  const callTool = (name, args, { retry, ...options } = {}) =>
    rpc("tools/call", { name, arguments: args, ...retry }, options);
  return {
    rpc,
    post,
    callTool,
    frames,
    requests,
    close: () => handler.close(),
  };
}

const out = (msg) => {
  assert.ok(msg.result, `expected a result, got ${JSON.stringify(msg)}`);
  return JSON.parse(msg.result.content[0].text);
};

const pending = (msg) => {
  assert.equal(
    msg.result?.resultType,
    "input_required",
    `expected input_required, got ${JSON.stringify(msg).slice(0, 400)}`,
  );
  return msg.result;
};

const stateBody = (state) =>
  JSON.parse(Buffer.from(state.split(".")[1], "base64url").toString("utf8"));

const deletes = (calls) =>
  calls.filter((c) => (c.init?.method ?? "GET") === "DELETE").length;

async function scenario(fn) {
  const docs = mkdtempSync(path.join(os.tmpdir(), "mrtr-conf-"));
  const client = modernClient(freshRuntime());
  try {
    return await withEnv(
      { SN_DOCS_DIR: docs, SN_DESTRUCTIVE_CONFIRM: "elicit" },
      () =>
        withFetch(
          (_url, init) =>
            (init?.method ?? "GET") === "DELETE"
              ? new Response(null, { status: 204 })
              : jsonResponse(200, {
                  result: { sys_id: SYS_ID, sys_mod_count: "1" },
                }),
          (calls) => fn(client, calls),
        ),
    );
  } finally {
    await client.close();
    rmSync(docs, { recursive: true, force: true });
  }
}

/** Plan the delete; the apply arguments carry its plan_token. */
async function plannedApply(client) {
  const plan = out(await client.callTool(TOOL, DELETE));
  return {
    ...DELETE,
    ...plan.apply_with,
    plan_token: plan.plan_token,
    apply: true,
  };
}

test("mrtr-17: a retry without the answer is asked again with a fresh state, not refused", async () => {
  await scenario(async (client, calls) => {
    const apply = await plannedApply(client);
    const first = pending(await client.callTool(TOOL, apply));
    const again = pending(
      await client.callTool(TOOL, apply, {
        retry: { requestState: first.requestState, inputResponses: {} },
      }),
    );
    assert.deepEqual(Object.keys(again.inputRequests), ["confirm"]);
    assert.notEqual(again.requestState, first.requestState);
    assert.notEqual(
      stateBody(again.requestState).p.nonce,
      stateBody(first.requestState).p.nonce,
    );
    assert.equal(deletes(calls), 0);

    // The first state is spent; the fresh one carries the answer.
    const replay = out(
      await client.callTool(TOOL, apply, {
        retry: {
          requestState: first.requestState,
          inputResponses: { confirm: { action: "accept", content: CONFIRM } },
        },
      }),
    );
    assert.equal(replay.code, "CONFIRM_DECLINED");
    // A refused replay burns the plan token: plan again and answer.
    const fresh = await plannedApply(client);
    const round = pending(await client.callTool(TOOL, fresh));
    const empty = pending(
      await client.callTool(TOOL, fresh, {
        retry: { requestState: round.requestState },
      }),
    );
    const done = await client.callTool(TOOL, fresh, {
      retry: {
        requestState: empty.requestState,
        inputResponses: { confirm: { action: "accept", content: CONFIRM } },
      },
    });
    assert.equal(done.result.isError, undefined, JSON.stringify(done));
    assert.equal(deletes(calls), 1);
  });
});

test("mrtr-14: an unparseable answer never counts as one; it is asked again", async () => {
  await scenario(async (client, calls) => {
    const apply = await plannedApply(client);
    let round = pending(await client.callTool(TOOL, apply));
    for (const inputResponses of [
      "not-an-object",
      [{ action: "accept" }],
      { confirm: "accept" },
      { confirm: { action: "approve", content: CONFIRM } },
      // A wrapped {method, result} envelope is not a bare ElicitResult.
      {
        confirm: {
          method: "elicitation/create",
          result: { action: "accept", content: CONFIRM },
        },
      },
    ]) {
      round = pending(
        await client.callTool(TOOL, apply, {
          retry: { requestState: round.requestState, inputResponses },
        }),
      );
    }
    assert.equal(deletes(calls), 0, "nothing applied on a malformed answer");
  });
});

test("mrtr-16: unknown inputResponses keys and fields are ignored", async () => {
  await scenario(async (client, calls) => {
    const apply = await plannedApply(client);
    const round = pending(await client.callTool(TOOL, apply));
    const done = await client.callTool(TOOL, apply, {
      retry: {
        requestState: round.requestState,
        inputResponses: {
          confirm: {
            action: "accept",
            content: CONFIRM,
            vendorExtra: { anything: 1 },
          },
          unrelated: { action: "decline" },
          "x-vendor": { roots: [] },
        },
      },
    });
    assert.equal(done.result.isError, undefined, JSON.stringify(done));
    assert.equal(deletes(calls), 1);
  });
});

test("mrtr-15: a malformed request or requestState is a JSON-RPC error", async () => {
  await scenario(async (client, calls) => {
    const apply = await plannedApply(client);
    const [parse] = await client.post("{not json", {
      method: "tools/call",
      name: TOOL,
    });
    assert.equal(parse.error?.code, -32700, JSON.stringify(parse));
    for (const requestState of ["v1.garbage.mac", "", 42]) {
      const res = await client.callTool(TOOL, apply, {
        retry: {
          requestState,
          inputResponses: { confirm: { action: "accept", content: CONFIRM } },
        },
      });
      assert.equal(res.error?.code, -32602, JSON.stringify(res));
      assert.equal(res.result, undefined);
    }
    assert.equal(deletes(calls), 0);
  });
});

test("mrtr-08: the state is bound to the principal, the method, the tool, the profile and the arguments, with an expiry", async () => {
  await scenario(async (client, calls) => {
    const alice = { token: "a", clientId: "alice", scopes: [] };
    const bob = { token: "b", clientId: "bob", scopes: [] };
    const apply = await plannedApply(client);
    const round = pending(
      await client.callTool(TOOL, apply, { authInfo: alice }),
    );
    const body = stateBody(round.requestState);
    assert.equal(body.p.tool, TOOL);
    assert.equal(body.p.purpose, "destructive_apply");
    assert.equal(typeof body.p.profile, "string");
    assert.match(body.p.args, /^[A-Za-z0-9_-]{16,}$/, "a keyed digest");
    assert.ok(!JSON.stringify(body).includes(SYS_ID), "no plain arguments");
    assert.equal(typeof body.exp, "number", "an expiry");
    assert.ok(!JSON.stringify(body).includes("alice"), "the binding is keyed");

    const retry = {
      requestState: round.requestState,
      inputResponses: { confirm: { action: "accept", content: CONFIRM } },
    };
    const stolen = await client.callTool(TOOL, apply, {
      retry,
      authInfo: bob,
    });
    assert.equal(stolen.error?.code, -32602, JSON.stringify(stolen));
    const anonymous = await client.callTool(TOOL, apply, { retry });
    assert.equal(anonymous.error?.code, -32602, JSON.stringify(anonymous));
    assert.equal(deletes(calls), 0);

    const owner = await client.callTool(TOOL, apply, {
      retry,
      authInfo: alice,
    });
    assert.equal(owner.result.isError, undefined, JSON.stringify(owner));
    assert.equal(deletes(calls), 1);
  });
});

test("mrtr-02: input_required is answered to tools/call only", async () => {
  // Only askUser (input.ts) builds an InputRequiredResult, and only tool
  // handlers ask: the destructive-apply gate and set_credentials.
  const src = path.join(import.meta.dirname, "..", "src");
  const builders = [];
  const askers = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith(".ts")) {
        const text = readFileSync(file, "utf8");
        const rel = path.relative(src, file).split(path.sep).join("/");
        if (/\binputRequired\(/.test(text)) builders.push(rel);
        if (/\baskUser\(/.test(text)) askers.push(rel);
      }
    }
  };
  walk(src);
  assert.deepEqual(builders, ["mcp/input.ts"]);
  assert.deepEqual(askers.sort(), [
    "mcp/confirm.ts",
    "mcp/input.ts",
    "tools/admin.ts",
  ]);

  await scenario(async (client) => {
    for (const [method, params] of [
      ["tools/list", {}],
      ["prompts/list", {}],
      ["resources/list", {}],
      ["prompts/get", { name: "servicenow_instance_overview" }],
    ]) {
      const res = await client.rpc(method, params);
      assert.ok(res.result, `${method}: ${JSON.stringify(res)}`);
      assert.notEqual(res.result.resultType, "input_required", method);
    }
  });
});

test("base-44 / http-10: the modern HTTP leg never sends the client a request, even while asking", async () => {
  await scenario(async (client, calls) => {
    const apply = await plannedApply(client);
    const round = pending(await client.callTool(TOOL, apply));
    pending(
      await client.callTool(TOOL, apply, {
        retry: { requestState: round.requestState, inputResponses: {} },
      }),
    );
    assert.deepEqual(client.requests, [], "no server→client request");
    assert.ok(client.frames.length >= 3);
    for (const frame of client.frames) {
      assert.ok(
        !("method" in frame && "id" in frame),
        `a request frame: ${JSON.stringify(frame)}`,
      );
    }
    assert.equal(deletes(calls), 0);
  });
});

test("base-44: a push request from a modern-served instance fails before any wire traffic", async () => {
  const runtime = freshRuntime();
  let attempt;
  const handler = createMcpHandler(
    () => {
      const server = buildMcpServer(runtime);
      server.registerTool("probe_push", { description: "probe" }, async () => {
        attempt = await server.server
          .elicitInput({
            mode: "form",
            message: "?",
            requestedSchema: { type: "object", properties: {} },
          })
          .then(
            () => "sent",
            (error) => error.message,
          );
        return { content: [{ type: "text", text: "ok" }] };
      });
      return server;
    },
    { legacy: "reject", onerror: () => {} },
  );
  try {
    await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MODERN,
          "mcp-method": "tools/call",
          "mcp-name": "probe_push",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "probe_push", arguments: {}, _meta: envelope() },
        }),
      }),
    );
    assert.match(attempt, /not available on protocol revision 2026-07-28/);
  } finally {
    await handler.close();
  }
});

test("mrtr-38: form prompts carry no clickable URL", async () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), "mrtr-url-"));
  const client = modernClient(freshRuntime());
  try {
    await withEnv(
      {
        SN_ENV_FILE: path.join(sandbox, ".env"),
        SN_DOCS_DIR: sandbox,
        SN_ACTIVE_PROFILE: undefined,
        SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE: undefined,
      },
      async () => {
        const round = pending(
          await client.callTool("servicenow_set_credentials", {
            instance: "https://dev99999.service-now.com/now/nav/ui",
            user: "bob",
            password: "pw-Very-Secret-42",
          }),
        );
        const text = JSON.stringify(round.inputRequests);
        assert.match(text, /instance → dev99999\.service-now\.com/);
        assert.doesNotMatch(text, /[a-z][a-z0-9+.-]*:\/\//i);
      },
    );
  } finally {
    await client.close();
    rmSync(sandbox, { recursive: true, force: true });
    baselineEnv();
  }
});

test("stdio-03: the stdio entry point writes no JSON-RPC request to stdout on the modern wire", async () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), "mrtr-stdio-"));
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("SN_") && value !== undefined) env[key] = value;
  }
  const child = spawn(
    process.execPath,
    [path.join(import.meta.dirname, "..", "build", "index.js")],
    {
      cwd: sandbox,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        ...env,
        HOME: sandbox,
        USERPROFILE: sandbox,
        XDG_CONFIG_HOME: path.join(sandbox, "config"),
        SN_ENV_FILE: path.join(sandbox, ".env"),
        SN_DOCS_DIR: path.join(sandbox, "docs"),
        SN_TRANSPORT: "stdio",
        SN_LOG_LEVEL: "warn",
      },
    },
  );
  const lines = [];
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    lines.push(line);
    const msg = JSON.parse(line);
    if ("id" in msg && !("method" in msg)) waiting.get(msg.id)?.(msg);
  });
  let id = 0;
  const call = (params) =>
    new Promise((resolve) => {
      id += 1;
      waiting.set(id, resolve);
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { ...params, _meta: envelope() },
        })}\n`,
      );
    });
  try {
    const args = { user: "bob", password: "pw-Very-Secret-42" };
    const name = "servicenow_set_credentials";
    const first = pending(await call({ name, arguments: args }));
    const again = pending(
      await call({
        name,
        arguments: args,
        requestState: first.requestState,
        inputResponses: {},
      }),
    );
    const declined = await call({
      name,
      arguments: args,
      requestState: again.requestState,
      inputResponses: { confirm: { action: "decline" } },
    });
    assert.equal(out(declined).code, "CREDENTIALS_UNCONFIRMED");
    assert.ok(lines.length >= 3);
    for (const line of lines) {
      const msg = JSON.parse(line);
      assert.ok(!("method" in msg && "id" in msg), `a request: ${line}`);
    }
  } finally {
    // Wait for the exit: on Windows the child's cwd keeps the sandbox busy.
    const exited = child.exitCode === null ? once(child, "exit") : null;
    child.kill();
    await exited;
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5 });
  }
});
