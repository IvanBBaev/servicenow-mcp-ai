// H-3 — plan-token binding + elicitation on destructive apply. Under
// SN_DESTRUCTIVE_CONFIRM=token|elicit (plan mode) a destructive apply:true must
// carry the single-use plan_token of a matching plan preview; `elicit` also
// asks a client that supports elicitation. `off` (the default) and
// SN_WRITE_MODE=apply keep the pre-H-3 behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { ALL_TOOLS } from "../build/mcp/registry.js";
import { runSpec, buildInputSchema } from "../build/mcp/define.js";
import { setServer } from "../build/mcp/context.js";
import {
  PLAN_TOKEN_MAX,
  consumePlanToken,
  issuePlanToken,
  planArgsHash,
} from "../build/mcp/plan-token.js";
import {
  getDestructiveConfirm,
  getPlanTokenTtlSec,
} from "../build/core/settings.js";
import { buildServerInstructions } from "../build/mcp/server-info.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const spec = (name) => ALL_TOOLS.find((s) => s.name === name);
const out = (res) => JSON.parse(res.content[0].text);
const call = (name, args, extra) => runSpec(spec(name), args, extra);

const SYS_ID = "a".repeat(32);
const OTHER_ID = "b".repeat(32);
const RECORD = { sys_id: SYS_ID, number: "INC0010001", sys_mod_count: "3" };

/** GET → the record; DELETE → 204. Counts the mutating calls. */
function instance() {
  return (url, init) => {
    const method = init?.method ?? "GET";
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method === "POST") {
      return jsonResponse(200, { result: { sys_id: "c".repeat(32) } });
    }
    return jsonResponse(200, { result: RECORD });
  };
}

const mutations = (calls) =>
  calls.filter((c) => (c.init?.method ?? "GET") !== "GET");

/** Run `fn` with a scratch docs dir (the journal) and the given env. */
async function scenario(env, fn) {
  const docs = mkdtempSync(path.join(tmpdir(), "h3-"));
  freshRuntime();
  try {
    return await withEnv({ SN_DOCS_DIR: docs, ...env }, () =>
      withFetch(instance(), (calls) => fn(calls, docs)),
    );
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
}

function journal(docs) {
  const file = path.join(docs, "default", "write-journal.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const deleteArgs = { table: "incident", sys_id: SYS_ID };

test("settings: SN_DESTRUCTIVE_CONFIRM and SN_PLAN_TOKEN_TTL_SEC parse with safe defaults", async () => {
  await withEnv(
    { SN_DESTRUCTIVE_CONFIRM: undefined, SN_PLAN_TOKEN_TTL_SEC: undefined },
    () => {
      assert.equal(getDestructiveConfirm(), "off");
      assert.equal(getPlanTokenTtlSec(), 600);
    },
  );
  for (const [raw, want] of [
    ["token", "token"],
    [" ELICIT ", "elicit"],
    ["off", "off"],
    ["yes", "off"],
    ["", "off"],
  ]) {
    await withEnv({ SN_DESTRUCTIVE_CONFIRM: raw }, () =>
      assert.equal(getDestructiveConfirm(), want, raw),
    );
  }
  for (const [raw, want] of [
    ["120", 120],
    ["29", 600],
    ["86401", 600],
    ["1.5", 600],
    ["abc", 600],
  ]) {
    await withEnv({ SN_PLAN_TOKEN_TTL_SEC: raw }, () =>
      assert.equal(getPlanTokenTtlSec(), want, raw),
    );
  }
});

test("off (default): the preview carries no plan_token and apply:true runs without one", async () => {
  await scenario({ SN_DESTRUCTIVE_CONFIRM: undefined }, async (calls) => {
    const plan = out(await call("servicenow_delete_record", deleteArgs));
    assert.equal(plan.mode, "plan");
    assert.equal(plan.plan_token, undefined);
    assert.match(plan.note, /apply:true/);
    const res = await call("servicenow_delete_record", {
      ...deleteArgs,
      apply: true,
    });
    assert.equal(res.isError, undefined, res.content[0].text);
    assert.equal(mutations(calls).length, 1);
  });
});

test("token: plan → apply with the token deletes once; the token is journaled and single-use", async () => {
  await scenario({ SN_DESTRUCTIVE_CONFIRM: "token" }, async (calls, docs) => {
    const plan = out(await call("servicenow_delete_record", deleteArgs));
    assert.match(plan.plan_token, /^pt[a-z]{28}$/);
    assert.ok(Date.parse(plan.plan_token_expires_at) > Date.now());
    assert.match(plan.note, /plan_token/);
    assert.equal(mutations(calls).length, 0, "the plan mutates nothing");

    const applied = await call("servicenow_delete_record", {
      ...deleteArgs,
      apply: true,
      plan_token: plan.plan_token,
    });
    assert.equal(applied.isError, undefined, applied.content[0].text);
    assert.equal(mutations(calls).length, 1);
    const lines = journal(docs);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].result, "applied");
    assert.equal(lines[0].plan_token, plan.plan_token);

    // Replay: the same token is used up.
    const replay = out(
      await call("servicenow_delete_record", {
        ...deleteArgs,
        apply: true,
        plan_token: plan.plan_token,
      }),
    );
    assert.equal(replay.error.code, "PLAN_REQUIRED");
    assert.equal(replay.error.status, 428);
    assert.match(replay.error.message, /unknown or already used/);
    assert.equal(mutations(calls).length, 1, "no second DELETE");
  });
});

test("token: an apply without a plan cannot reach the instance (acceptance)", async () => {
  await scenario({ SN_DESTRUCTIVE_CONFIRM: "token" }, async (calls, docs) => {
    const cases = [
      ["servicenow_delete_record", { ...deleteArgs, apply: true }],
      [
        "servicenow_delete_attachment",
        { attachment_sys_id: SYS_ID, apply: true },
      ],
      [
        "servicenow_batch",
        {
          requests: [
            { method: "DELETE", url: `/api/now/table/incident/${SYS_ID}` },
          ],
          apply: true,
        },
      ],
      [
        "servicenow_send_email",
        { to: ["a@example.com"], subject: "s", body: "b", apply: true },
      ],
      ["servicenow_order_catalog_item", { item_sys_id: SYS_ID, apply: true }],
      [
        "servicenow_revert_write",
        { entry_id: "01J0000000000000000000000", apply: true },
      ],
      [
        "servicenow_delete_record",
        {
          ...deleteArgs,
          apply: true,
          plan_token: "ptforgedforgedforgedforgedforg",
        },
      ],
    ];
    for (const [name, args] of cases) {
      const res = await call(name, args);
      assert.equal(res.isError, true, name);
      const body = out(res);
      assert.equal(body.error.code, "PLAN_REQUIRED", name);
      assert.match(body.error.hint, /without apply/);
    }
    assert.equal(calls.length, 0, "not even a read reached the instance");
    assert.deepEqual(journal(docs), [], "a refused token is not journaled");
  });
});

test("token: changed arguments, another tool or an expired token are refused; a mismatch keeps the token", async () => {
  await scenario({ SN_DESTRUCTIVE_CONFIRM: "token" }, async (calls) => {
    const { plan_token } = out(
      await call("servicenow_delete_record", deleteArgs),
    );

    const moved = out(
      await call("servicenow_delete_record", {
        table: "incident",
        sys_id: OTHER_ID,
        apply: true,
        plan_token,
      }),
    );
    assert.equal(moved.error.code, "PLAN_REQUIRED");
    assert.match(moved.error.message, /arguments differ/);

    const otherTool = out(
      await call("servicenow_delete_attachment", {
        attachment_sys_id: SYS_ID,
        apply: true,
        plan_token,
      }),
    );
    assert.match(otherTool.error.message, /another tool/);
    assert.equal(mutations(calls).length, 0);

    // Still valid for the planned call after the mismatches.
    const ok = await call("servicenow_delete_record", {
      ...deleteArgs,
      apply: true,
      plan_token,
    });
    assert.equal(ok.isError, undefined, ok.content[0].text);

    // Expiry.
    const second = out(await call("servicenow_delete_record", deleteArgs));
    const realNow = Date.now;
    Date.now = () => realNow() + 601_000;
    try {
      const late = out(
        await call("servicenow_delete_record", {
          ...deleteArgs,
          apply: true,
          plan_token: second.plan_token,
        }),
      );
      assert.match(late.error.message, /expired/);
    } finally {
      Date.now = realNow;
    }
    assert.equal(mutations(calls).length, 1);
  });
});

test("token: the instance argument is not part of the binding, but the profile is", () => {
  freshRuntime();
  const argsHash = planArgsHash({ table: "incident", sys_id: SYS_ID });
  assert.equal(
    planArgsHash({
      sys_id: SYS_ID,
      table: "incident",
      apply: true,
      instance: "x",
      plan_token: "pt",
    }),
    argsHash,
    "apply / plan_token / instance and key order do not change the hash",
  );
  assert.equal(
    planArgsHash({ table: "incident", sys_id: SYS_ID, update_set: undefined }),
    argsHash,
    "an explicit undefined equals an omitted optional",
  );
  assert.notEqual(
    planArgsHash({ table: "incident", sys_id: SYS_ID, update_set: "x" }),
    argsHash,
  );
  const tool = "servicenow_delete_record";
  const { token } = issuePlanToken({ profile: "dev", tool, argsHash });
  assert.deepEqual(
    consumePlanToken(token, { profile: "prod", tool, argsHash }),
    { ok: false, reason: "wrong_profile" },
  );
  assert.deepEqual(
    consumePlanToken(token, { profile: "dev", tool, argsHash }),
    {
      ok: true,
    },
  );
  assert.deepEqual(
    consumePlanToken(undefined, { profile: "dev", tool, argsHash }),
    {
      ok: false,
      reason: "missing",
    },
  );
});

test("token: the store is bounded (oldest plan dropped) and cleared by a fresh runtime", () => {
  freshRuntime();
  const plan = { profile: "default", tool: "t", argsHash: "h" };
  const first = issuePlanToken(plan).token;
  for (let i = 1; i < PLAN_TOKEN_MAX; i++) issuePlanToken(plan);
  const last = issuePlanToken(plan).token;
  assert.equal(consumePlanToken(first, plan).reason, "unknown");
  assert.deepEqual(consumePlanToken(last, plan), { ok: true });
  const kept = issuePlanToken(plan).token;
  freshRuntime();
  assert.equal(consumePlanToken(kept, plan).reason, "unknown");
});

test("token: SN_WRITE_MODE=apply bypasses the check (trusted operator)", async () => {
  await scenario(
    { SN_DESTRUCTIVE_CONFIRM: "token", SN_WRITE_MODE: "apply" },
    async (calls) => {
      const res = await call("servicenow_delete_record", deleteArgs);
      assert.equal(res.isError, undefined, res.content[0].text);
      assert.equal(mutations(calls).length, 1);
    },
  );
});

test("token: a GET-only batch needs no plan; a writing batch does", async () => {
  await scenario({ SN_DESTRUCTIVE_CONFIRM: "token" }, async () => {
    await withFetch(
      () =>
        jsonResponse(200, {
          batch_request_id: "1",
          serviced_requests: [
            { id: "0", status_code: 200, body: btoa("{}"), headers: [] },
          ],
          unserviced_requests: [],
        }),
      async (calls) => {
        const read = await call("servicenow_batch", {
          requests: [{ method: "GET", url: "/api/now/table/incident" }],
          apply: true,
        });
        assert.equal(read.isError, undefined, read.content[0].text);
        assert.equal(calls.length, 1);

        const write = {
          requests: [
            {
              method: "PATCH",
              url: `/api/now/table/incident/${SYS_ID}`,
              body: { state: "2" },
            },
          ],
        };
        const plan = out(await call("servicenow_batch", write));
        assert.match(plan.plan_token, /^pt[a-z]{28}$/);
        const refused = out(
          await call("servicenow_batch", { ...write, apply: true }),
        );
        assert.equal(refused.error.code, "PLAN_REQUIRED");
        assert.equal(calls.length, 1);
        const applied = await call("servicenow_batch", {
          ...write,
          apply: true,
          plan_token: plan.plan_token,
        });
        assert.equal(applied.isError, undefined, applied.content[0].text);
        assert.equal(calls.length, 2);
      },
    );
  });
});

test("token: SN_REDACT_PII cannot mangle the token (letters only)", async () => {
  await scenario(
    { SN_DESTRUCTIVE_CONFIRM: "token", SN_REDACT_PII: "1" },
    async (calls) => {
      for (let i = 0; i < 20; i++) {
        const { plan_token } = out(
          await call("servicenow_delete_record", deleteArgs),
        );
        assert.match(plan_token, /^pt[a-z]{28}$/);
        const res = await call("servicenow_delete_record", {
          ...deleteArgs,
          apply: true,
          plan_token,
        });
        assert.equal(res.isError, undefined, res.content[0].text);
      }
      assert.equal(mutations(calls).length, 20);
    },
  );
});

test("schema: exactly the eight plan-token tools gain plan_token", () => {
  const withToken = ALL_TOOLS.filter(
    (s) => "plan_token" in buildInputSchema(s).shape,
  ).map((s) => s.name);
  assert.deepEqual(withToken.sort(), [
    "servicenow_batch",
    "servicenow_change_conflicts",
    "servicenow_delete_attachment",
    "servicenow_delete_record",
    "servicenow_order_catalog_item",
    "servicenow_revert_write",
    "servicenow_send_email",
    // P-23: one token covers the whole artefact plan (parent and children).
    "servicenow_upsert_artifact",
  ]);
  for (const name of withToken) {
    assert.ok("apply" in spec(name).input, `${name} has apply`);
  }
});

test("instructions: the plan_token line appears only when the check is on", async () => {
  await withEnv({ SN_DESTRUCTIVE_CONFIRM: undefined }, () =>
    assert.doesNotMatch(buildServerInstructions("0.0.0"), /plan_token/),
  );
  await withEnv({ SN_DESTRUCTIVE_CONFIRM: "elicit" }, () =>
    assert.match(buildServerInstructions("0.0.0"), /plan_token/),
  );
  await withEnv(
    { SN_DESTRUCTIVE_CONFIRM: "token", SN_WRITE_MODE: "apply" },
    () => assert.doesNotMatch(buildServerInstructions("0.0.0"), /plan_token/),
  );
});

// --- elicit ----------------------------------------------------------------

async function connectedServer(capabilities, onElicit) {
  const server = new McpServer({ name: "h3-test", version: "0.0.0" });
  setServer(server);
  const client = new Client(
    { name: "h3-client", version: "0.0.0" },
    { capabilities },
  );
  const prompts = [];
  if (capabilities.elicitation && onElicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      return onElicit(req);
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return {
    prompts,
    close: async () => {
      setServer(null);
      await client.close();
      await server.close();
    },
  };
}

async function planThenApply() {
  const { plan_token } = out(
    await call("servicenow_delete_record", deleteArgs),
  );
  return call("servicenow_delete_record", {
    ...deleteArgs,
    apply: true,
    plan_token,
  });
}

test("elicit: a declined prompt refuses the delete and journals `refused`", async () => {
  await scenario({ SN_DESTRUCTIVE_CONFIRM: "elicit" }, async (calls, docs) => {
    const s = await connectedServer({ elicitation: {} }, () => ({
      action: "decline",
    }));
    try {
      const res = out(await planThenApply());
      assert.equal(res.error.code, "CONFIRM_DECLINED");
      assert.equal(res.error.status, 403);
      assert.equal(mutations(calls).length, 0);
      assert.equal(s.prompts.length, 1);
      assert.match(s.prompts[0], /delete on incident\/a{32}/);
      const lines = journal(docs);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].result, "refused");
      assert.equal(lines[0].action, "delete");
      assert.equal(lines[0].table, "incident");
      assert.equal(lines[0].sys_id, SYS_ID);
      assert.match(lines[0].plan_token, /^pt[a-z]{28}$/);
    } finally {
      await s.close();
    }
  });
});

test("elicit: accepting with confirm:false is still a refusal; confirm:true deletes", async () => {
  await scenario({ SN_DESTRUCTIVE_CONFIRM: "elicit" }, async (calls) => {
    let answer = { action: "accept", content: { confirm: false } };
    const s = await connectedServer({ elicitation: {} }, () => answer);
    try {
      assert.equal(out(await planThenApply()).error.code, "CONFIRM_DECLINED");
      answer = { action: "accept", content: { confirm: true } };
      const res = await planThenApply();
      assert.equal(res.isError, undefined, res.content[0].text);
      assert.equal(mutations(calls).length, 1);
    } finally {
      await s.close();
    }
  });
});

test("elicit: a failing prompt fails closed; a client without elicitation relies on the token", async () => {
  await scenario({ SN_DESTRUCTIVE_CONFIRM: "elicit" }, async (calls) => {
    const broken = await connectedServer({ elicitation: {} }, () => {
      throw new Error("prompt exploded");
    });
    try {
      const res = out(await planThenApply());
      assert.equal(res.error.code, "CONFIRM_DECLINED");
      assert.match(res.error.message, /prompt failed/);
    } finally {
      await broken.close();
    }
    assert.equal(mutations(calls).length, 0);

    const plain = await connectedServer({});
    try {
      const noToken = out(
        await call("servicenow_delete_record", { ...deleteArgs, apply: true }),
      );
      assert.equal(noToken.error.code, "PLAN_REQUIRED");
      const res = await planThenApply();
      assert.equal(res.isError, undefined, res.content[0].text);
      assert.equal(mutations(calls).length, 1);
    } finally {
      await plain.close();
    }
  });
});

test("profiles: a plan for one profile cannot be applied on another; lines land in the target profile's journal", async () => {
  const prod = {
    SN_DESTRUCTIVE_CONFIRM: "elicit",
    SN_PROFILE_PROD_INSTANCE: "dev11111.service-now.com",
    SN_PROFILE_PROD_USER: "bob",
    SN_PROFILE_PROD_PASSWORD: "pw",
  };
  await scenario(prod, async (calls, docs) => {
    const onProd = { ...deleteArgs, instance: "prod" };
    const { plan_token } = out(await call("servicenow_delete_record", onProd));
    const elsewhere = out(
      await call("servicenow_delete_record", {
        ...deleteArgs,
        apply: true,
        plan_token,
      }),
    );
    assert.match(elsewhere.error.message, /another profile/);

    let answer = { action: "decline" };
    const s = await connectedServer({ elicitation: {} }, () => answer);
    try {
      const declined = out(
        await call("servicenow_delete_record", {
          ...onProd,
          apply: true,
          plan_token,
        }),
      );
      assert.equal(declined.error.code, "CONFIRM_DECLINED");
      assert.match(s.prompts[0], /profile "prod"/);

      answer = { action: "accept", content: { confirm: true } };
      const again = out(await call("servicenow_delete_record", onProd));
      const res = await call("servicenow_delete_record", {
        ...onProd,
        apply: true,
        plan_token: again.plan_token,
      });
      assert.equal(res.isError, undefined, res.content[0].text);
    } finally {
      await s.close();
    }
    assert.deepEqual(journal(docs), [], "nothing in the default journal");
    const prodLines = readFileSync(
      path.join(docs, "prod", "write-journal.jsonl"),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      prodLines.map((l) => [l.profile, l.result]),
      [
        ["prod", "refused"],
        ["prod", "applied"],
      ],
    );
    const deletes = mutations(calls);
    assert.equal(deletes.length, 1);
    assert.match(deletes[0].url, /dev11111\.service-now\.com/);
  });
});
