// N-35 / MRTR — confirmation prompts on the 2026-07-28 wire. A server→client
// elicitation is not allowed mid-call there: the first round answers
// `input_required` with a signed, single-use requestState, the retry carries
// the user's answer. Driven end to end through the real server factory
// (buildMcpServer) behind the SDK's modern HTTP handler, with raw JSON-RPC
// requests so every byte of the envelope, the state and the answer is the
// test's choice. The legacy (2025) wire is covered by plan-token.test.js and
// admin-credentials.test.js, which must keep passing unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv as parseEnvFile } from "node:util";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { buildMcpServer } from "../build/server.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import { runSpec } from "../build/mcp/define.js";
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
const SYS_ID = "a".repeat(32);
const DELETE = { table: "incident", sys_id: SYS_ID };
const PASSWORD = "pw-Very-Secret-42";

/** GET → the record; DELETE → 204. */
function instance() {
  return (_url, init) => {
    if ((init?.method ?? "GET") === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return jsonResponse(200, {
      result: { sys_id: SYS_ID, number: "INC0010001", sys_mod_count: "3" },
    });
  };
}

const deletes = (calls) =>
  calls.filter((c) => (c.init?.method ?? "GET") === "DELETE").length;

/**
 * A modern-wire client against buildMcpServer: every request builds a fresh
 * McpServer on one shared runtime, as stdio serves the 2026-07-28 era.
 */
function modernClient(runtime) {
  const errors = [];
  const handler = createMcpHandler(() => buildMcpServer(runtime), {
    legacy: "reject",
    onerror: (error) => errors.push(error.message),
  });
  let id = 0;
  async function rpc(method, params, { capabilities = FORM } = {}) {
    id += 1;
    const res = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MODERN,
          "mcp-method": method,
          ...(params.name ? { "mcp-name": params.name } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": MODERN,
              "io.modelcontextprotocol/clientInfo": {
                name: "mrtr-test",
                version: "0",
              },
              "io.modelcontextprotocol/clientCapabilities": capabilities,
            },
          },
        }),
      }),
    );
    return res.json();
  }
  /** tools/call; `retry` carries the previous round's state and an answer. */
  const callTool = (name, args, { retry, ...options } = {}) =>
    rpc(
      "tools/call",
      {
        name,
        arguments: args,
        ...(retry
          ? {
              requestState: retry.requestState,
              inputResponses: retry.inputResponses,
            }
          : {}),
      },
      options,
    );
  return { callTool, errors, close: () => handler.close() };
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

const answer = (round, key, action, content) => ({
  requestState: round.requestState,
  inputResponses: { [key]: { action, ...(content ? { content } : {}) } },
});

/** The readable body of a requestState (`v1.<payload>.<mac>`). */
const stateBody = (state) =>
  Buffer.from(state.split(".")[1], "base64url").toString("utf8");

async function destructiveScenario(fn) {
  const docs = mkdtempSync(path.join(os.tmpdir(), "mrtr-"));
  const runtime = freshRuntime();
  const client = modernClient(runtime);
  try {
    return await withEnv(
      { SN_DOCS_DIR: docs, SN_DESTRUCTIVE_CONFIRM: "elicit" },
      () => withFetch(instance(), (calls) => fn(client, calls)),
    );
  } finally {
    await client.close();
    rmSync(docs, { recursive: true, force: true });
  }
}

/** Plan the delete and return the apply arguments with its plan_token. */
async function plannedApply(client) {
  const plan = out(await client.callTool("servicenow_delete_record", DELETE));
  assert.ok(plan.plan_token, "the preview issues a plan_token");
  return {
    ...DELETE,
    ...plan.apply_with,
    plan_token: plan.plan_token,
    apply: true,
  };
}

const CONFIRM = { confirm: true };

test("MRTR: destructive apply → input_required → accepted retry applies exactly once; a replay is refused", async () => {
  await destructiveScenario(async (client, calls) => {
    const apply = await plannedApply(client);
    const round = pending(
      await client.callTool("servicenow_delete_record", apply),
    );
    assert.deepEqual(Object.keys(round.inputRequests), ["confirm"]);
    assert.equal(round.inputRequests.confirm.method, "elicitation/create");
    assert.match(
      round.inputRequests.confirm.params.message,
      /delete on incident\//,
    );
    assert.equal(deletes(calls), 0, "asking writes nothing");

    const retry = answer(round, "confirm", "accept", CONFIRM);
    const done = await client.callTool("servicenow_delete_record", apply, {
      retry,
    });
    assert.equal(done.result.isError, undefined, JSON.stringify(done));
    assert.equal(deletes(calls), 1);

    // The same retry again: the token is spent, the nonce is gone.
    const replay = out(
      await client.callTool("servicenow_delete_record", apply, { retry }),
    );
    assert.equal(replay.code, "PLAN_REQUIRED");
    assert.equal(deletes(calls), 1, "applied exactly once");
  });
});

test("MRTR: a tampered requestState is refused before the handler runs", async () => {
  await destructiveScenario(async (client, calls) => {
    const apply = await plannedApply(client);
    const round = pending(
      await client.callTool("servicenow_delete_record", apply),
    );
    const [v, body, mac] = round.requestState.split(".");
    const forged = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    forged.p.tool = "servicenow_other";
    for (const state of [
      `${v}.${body}.${mac.slice(0, -2)}${mac.endsWith("AA") ? "BB" : "AA"}`,
      `${v}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${mac}`,
      "not-a-state",
    ]) {
      const res = await client.callTool("servicenow_delete_record", apply, {
        retry: {
          requestState: state,
          inputResponses: { confirm: { action: "accept", content: CONFIRM } },
        },
      });
      assert.equal(res.error?.code, -32602, JSON.stringify(res));
    }
    assert.equal(deletes(calls), 0);
  });
});

test("MRTR: an expired requestState is refused", async (t) => {
  await destructiveScenario(async (client, calls) => {
    const apply = await plannedApply(client);
    const round = pending(
      await client.callTool("servicenow_delete_record", apply),
    );
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    try {
      t.mock.timers.tick(601_000); // past the default SN_PLAN_TOKEN_TTL_SEC
      const res = await client.callTool("servicenow_delete_record", apply, {
        retry: answer(round, "confirm", "accept", CONFIRM),
      });
      assert.equal(res.error?.code, -32602, JSON.stringify(res));
      assert.match(res.error.message, /expired/i, JSON.stringify(res));
    } finally {
      t.mock.timers.reset();
    }
    assert.equal(deletes(calls), 0);
  });
});

test("MRTR: a decline refuses, journals nothing applied and burns the plan token", async () => {
  await destructiveScenario(async (client, calls) => {
    const apply = await plannedApply(client);
    const round = pending(
      await client.callTool("servicenow_delete_record", apply),
    );
    const declined = out(
      await client.callTool("servicenow_delete_record", apply, {
        retry: answer(round, "confirm", "decline"),
      }),
    );
    assert.equal(declined.code, "CONFIRM_DECLINED");
    assert.match(declined.error, /did not confirm/);
    // The token is spent: asking again needs a fresh plan.
    const again = out(await client.callTool("servicenow_delete_record", apply));
    assert.equal(again.code, "PLAN_REQUIRED");
    assert.equal(deletes(calls), 0);
  });
});

test("MRTR: a state minted for another tool's prompt is refused and burns the token", async () => {
  await withScratchStore(async () => {
    await destructiveScenario(async (client, calls) => {
      const foreign = pending(
        await client.callTool("servicenow_set_credentials", {
          user: "bob",
          password: PASSWORD,
        }),
      );
      const apply = await plannedApply(client);
      const res = out(
        await client.callTool("servicenow_delete_record", apply, {
          retry: answer(foreign, "confirm", "accept", CONFIRM),
        }),
      );
      assert.equal(res.code, "CONFIRM_DECLINED");
      assert.match(res.error, /issued for another prompt/);
      const again = out(
        await client.callTool("servicenow_delete_record", apply),
      );
      assert.equal(again.code, "PLAN_REQUIRED");
      assert.equal(deletes(calls), 0);
    });
  });
});

test("MRTR: a retry without a requestState is refused and writes nothing", async () => {
  await destructiveScenario(async (client, calls) => {
    const apply = await plannedApply(client);
    const res = out(
      await client.callTool("servicenow_delete_record", apply, {
        retry: {
          inputResponses: { confirm: { action: "accept", content: CONFIRM } },
        },
      }),
    );
    assert.equal(res.code, "CONFIRM_DECLINED");
    assert.equal(deletes(calls), 0);
  });
});

test("MRTR: a request that does not declare form elicitation is never asked", async () => {
  await destructiveScenario(async (client, calls) => {
    const apply = await plannedApply(client);
    // Like a legacy client without elicitation: the plan token alone passes.
    const res = await client.callTool("servicenow_delete_record", apply, {
      capabilities: { elicitation: { url: {} } },
    });
    assert.notEqual(
      res.result?.resultType,
      "input_required",
      JSON.stringify(res),
    );
    assert.equal(res.result.isError, undefined, JSON.stringify(res));
    assert.equal(deletes(calls), 1);
  });
});

// --- set_credentials (H-2, D-2) ---------------------------------------------

const parseEnv = (text) => ({ ...parseEnvFile(text) });

async function withScratchStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mrtr-cred-"));
  const envFile = path.join(dir, ".env");
  try {
    await withEnv(
      {
        SN_ENV_FILE: envFile,
        SN_DOCS_DIR: dir,
        SN_ACTIVE_PROFILE: undefined,
        SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE: undefined,
      },
      () => fn(envFile),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    baselineEnv();
  }
}

const saved = async (envFile) =>
  existsSync(envFile) ? parseEnv(await fs.readFile(envFile, "utf8")) : {};

test("MRTR H-2: a credential change goes through input_required; the state never carries the password", async () => {
  await withScratchStore(async (envFile) => {
    const client = modernClient(freshRuntime());
    try {
      const args = { user: "bob", password: PASSWORD };
      const round = pending(
        await client.callTool("servicenow_set_credentials", args),
      );
      assert.match(
        round.inputRequests.confirm.params.message,
        /Save ServiceNow credentials \(user → bob/,
      );
      const body = stateBody(round.requestState);
      assert.ok(!body.includes(PASSWORD), body);
      assert.ok(!JSON.stringify(round).includes(PASSWORD));
      assert.deepEqual(await saved(envFile), {}, "nothing saved while asking");

      const done = out(
        await client.callTool("servicenow_set_credentials", args, {
          retry: answer(round, "confirm", "accept", CONFIRM),
        }),
      );
      assert.equal(done.code, undefined, JSON.stringify(done));
      const file = await saved(envFile);
      assert.equal(file.SN_USER, "bob");
      assert.equal(file.SN_PASSWORD, PASSWORD);
    } finally {
      await client.close();
    }
  });
});

test("MRTR H-2: a declined credential change is refused and saves nothing", async () => {
  await withScratchStore(async (envFile) => {
    const client = modernClient(freshRuntime());
    try {
      const args = { user: "bob", password: PASSWORD };
      const round = pending(
        await client.callTool("servicenow_set_credentials", args),
      );
      const res = out(
        await client.callTool("servicenow_set_credentials", args, {
          retry: answer(round, "confirm", "decline"),
        }),
      );
      assert.equal(res.code, "CREDENTIALS_UNCONFIRMED");
      assert.match(res.error, /not confirmed by the user/);
      assert.deepEqual(await saved(envFile), {});
    } finally {
      await client.close();
    }
  });
});

test("MRTR H-2: an answer bound to other arguments is refused, even with the opt-out", async () => {
  await withScratchStore(async (envFile) => {
    process.env.SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE = "1";
    const client = modernClient(freshRuntime());
    try {
      const round = pending(
        await client.callTool("servicenow_set_credentials", {
          user: "bob",
          password: PASSWORD,
        }),
      );
      const res = out(
        await client.callTool(
          "servicenow_set_credentials",
          { user: "bob", password: "another-password" },
          { retry: answer(round, "confirm", "accept", CONFIRM) },
        ),
      );
      assert.equal(res.code, "CREDENTIALS_UNCONFIRMED");
      assert.match(res.error, /issued for other arguments/);
      assert.deepEqual(await saved(envFile), {});
    } finally {
      await client.close();
    }
  });
});

test("MRTR D-2: secrets are never requested through a form on the modern wire", async () => {
  await withScratchStore(async (envFile) => {
    const client = modernClient(freshRuntime());
    try {
      const msg = await client.callTool("servicenow_set_credentials", {
        auth: "apikey",
        request_secrets: ["api_key"],
      });
      assert.notEqual(msg.result?.resultType, "input_required");
      const res = out(msg);
      assert.equal(res.code, "CREDENTIALS_UNCONFIRMED");
      assert.match(res.error, /cannot be requested through a form prompt/);
      assert.match(res.hint, /SN_API_KEY .*env file or a secret file/);
      assert.deepEqual(await saved(envFile), {});
    } finally {
      await client.close();
    }
  });
});

test("legacy: a call outside the modern wire never yields input_required", async () => {
  await withScratchStore(async (envFile) => {
    freshRuntime();
    const spec = ALL_TOOLS.find((s) => s.name === "servicenow_set_credentials");
    const res = await runSpec(spec, { user: "bob", password: PASSWORD });
    assert.equal(res.resultType, undefined);
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.code, "CREDENTIALS_UNCONFIRMED");
    assert.match(body.error, /no elicitation support/);
    assert.deepEqual(await saved(envFile), {});
  });
});
