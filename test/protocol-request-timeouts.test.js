/**
 * N-35 — conformance rows cancel-04 / cancel-05 (2026-07-28 matrix).
 *
 * The only request this server ever sends is a legacy (2025-era)
 * `elicitation/create` (askLegacy in src/mcp/input.ts; the modern wire sends
 * none, see protocol-mrtr-modern.test.js). It carries a hard timeout that
 * progress never extends, so a client that never answers fails the prompt
 * closed instead of holding the call open.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { ALL_TOOLS } from "../build/mcp/registry.js";
import { runSpec } from "../build/mcp/define.js";
import { setServer } from "../build/mcp/context.js";
import { ELICIT_TIMEOUT_MS } from "../build/mcp/input.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const SYS_ID = "a".repeat(32);
const DELETE = { table: "incident", sys_id: SYS_ID };
const TOOL = ALL_TOOLS.find((s) => s.name === "servicenow_delete_record");
const out = (res) => JSON.parse(res.content[0].text);

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

/** A legacy client that declares elicitation and never answers it. */
async function silentClient() {
  const server = new McpServer({ name: "timeout-test", version: "0.0.0" });
  setServer(server);
  const options = [];
  const elicit = server.server.elicitInput.bind(server.server);
  server.server.elicitInput = (params, opts) => {
    options.push(opts);
    return elicit(params, opts);
  };
  const client = new Client(
    { name: "timeout-client", version: "0.0.0" },
    { capabilities: { elicitation: {} } },
  );
  const prompts = [];
  client.setRequestHandler(ElicitRequestSchema, (req) => {
    prompts.push(req.params.message);
    return new Promise(() => {});
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return {
    options,
    prompts,
    close: async () => {
      setServer(null);
      await client.close();
      await server.close();
    },
  };
}

async function scenario(fn) {
  const docs = mkdtempSync(path.join(tmpdir(), "timeouts-"));
  freshRuntime();
  try {
    return await withEnv(
      { SN_DOCS_DIR: docs, SN_DESTRUCTIVE_CONFIRM: "elicit" },
      () => withFetch(instance(), fn),
    );
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

test("cancel-04 / cancel-05: a sent request times out on a hard cap that progress never extends", async (t) => {
  await scenario(async (calls) => {
    const s = await silentClient();
    try {
      const plan = out(await runSpec(TOOL, DELETE));
      t.mock.timers.enable({ apis: ["setTimeout"] });
      let settled = false;
      const pending = runSpec(TOOL, {
        ...DELETE,
        ...plan.apply_with,
        plan_token: plan.plan_token,
        apply: true,
      }).finally(() => {
        settled = true;
      });
      for (let i = 0; i < 50 && !s.prompts.length; i++) await turn();
      assert.equal(s.prompts.length, 1, "the client was asked");

      assert.deepEqual(s.options, [
        {
          timeout: ELICIT_TIMEOUT_MS,
          maxTotalTimeout: ELICIT_TIMEOUT_MS,
          resetTimeoutOnProgress: false,
        },
      ]);

      t.mock.timers.tick(ELICIT_TIMEOUT_MS - 1);
      for (let i = 0; i < 10; i++) await turn();
      assert.equal(settled, false, "still waiting just under the cap");

      t.mock.timers.tick(1);
      const res = out(await pending);
      assert.equal(res.code, "CONFIRM_DECLINED");
      assert.match(res.error, /prompt failed/);
      assert.equal(deletes(calls), 0, "an unanswered prompt writes nothing");
    } finally {
      t.mock.timers.reset();
      await s.close();
    }
  });
});
