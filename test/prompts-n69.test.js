// N-69 (F5-12): the incident RCA, release notes and clone-down checklist
// prompts — gated by their packages, naming the tools of every step, with the
// audience normalised, the record located by number or sys_id and the diff
// step following the optional source profile.
import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerPrompts } from "../build/mcp/prompts.js";
import { baselineEnv, freshRuntime } from "./helpers.js";

baselineEnv();
test.beforeEach(() => freshRuntime());

const RCA = "servicenow_incident_rca";
const NOTES = "servicenow_release_notes";
const CLONE = "servicenow_clone_down_checklist";
const SYS_ID = "0123456789abcdef0123456789abcdef";

async function withPrompts(enabled, fn) {
  const server = new McpServer({ name: "t", version: "0.0.0" });
  registerPrompts(server, enabled);
  const client = new Client({ name: "c", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const text = async (client, name, args) =>
  (await client.getPrompt({ name, arguments: args })).messages[0].content.text;

const names = async (client) =>
  (await client.listPrompts()).prompts.map((p) => p.name);

// --- registration -----------------------------------------------------------------

test("N-69 prompts follow their packages: history, updatesets, instance", async () => {
  const cases = [
    [["history"], [RCA]],
    [["updatesets"], [NOTES]],
    [["instance"], [CLONE]],
    [["ops", "table"], []],
  ];
  for (const [enabled, expected] of cases) {
    await withPrompts(enabled, async (client) => {
      const listed = (await names(client)).filter((n) =>
        [RCA, NOTES, CLONE].includes(n),
      );
      assert.deepEqual(listed, expected, enabled.join(","));
    });
  }
});

test("N-69 prompts declare their arguments", async () => {
  await withPrompts(undefined, async (client) => {
    const { prompts } = await client.listPrompts();
    const args = (name) => {
      const p = prompts.find((x) => x.name === name);
      assert.ok(p?.title, name);
      return Object.fromEntries(
        p.arguments.map((a) => [a.name, a.required === true]),
      );
    };
    assert.deepEqual(args(RCA), { record: true, table: false, since: false });
    assert.deepEqual(args(NOTES), { update_set: true, audience: false });
    assert.deepEqual(args(CLONE), { target: true, source: false });
    const { completion } = await client.complete({
      ref: { type: "ref/prompt", name: NOTES },
      argument: { name: "audience", value: "b" },
    });
    assert.deepEqual(completion.values, ["business"]);
  });
});

// --- incident RCA -----------------------------------------------------------------

test("incident_rca: a number is looked up, the window starts at creation, every step names its tool", async () => {
  await withPrompts(undefined, async (client) => {
    const t = await text(client, RCA, { record: "INC0010001" });
    assert.match(
      t,
      /servicenow_query_table on `incident` with query number=`INC0010001`/,
    );
    assert.match(t, /from the record's sys_created_on/);
    assert.match(t, /servicenow_get_record_history with table `incident`/);
    assert.match(t, /source 'all'/);
    assert.doesNotMatch(t, /\(since /);
    for (const tool of [
      "servicenow_get_status",
      "servicenow_describe_table_logic",
      "servicenow_trace_table_event",
      "servicenow_list_changes",
      "servicenow_read_ops",
      "servicenow_get_task_context",
    ])
      assert.ok(t.includes(tool), tool);
    assert.match(t, /kind 'syslog' and level 'error'/);
    assert.match(t, /kind 'events' for the events named `incident`\.\*/);
    assert.match(t, /'history', 'scripts', 'change' and 'ops' packages/);
    assert.match(t, /read-only/);
  });
});

test("incident_rca: a sys_id is read directly; table and since are honoured", async () => {
  await withPrompts(undefined, async (client) => {
    const t = await text(client, RCA, {
      record: SYS_ID.toUpperCase(),
      table: "change_request",
      since: "2026-10-01",
    });
    assert.match(
      t,
      new RegExp(
        `servicenow_get_record on \`change_request\` with sys_id \`${SYS_ID.toUpperCase()}\``,
      ),
    );
    assert.doesNotMatch(t, /servicenow_query_table/);
    assert.match(t, /window from `2026-10-01` to now/);
    assert.match(t, /\(since `2026-10-01`\)/);
    assert.match(t, /servicenow_describe_table_logic for `change_request`/);
  });
});

// --- release notes ----------------------------------------------------------------

test("release_notes: technical by default, business on request, unknown falls back", async () => {
  await withPrompts(undefined, async (client) => {
    const tech = await text(client, NOTES, { update_set: "Release 42" });
    assert.match(tech, /update set `Release 42` for a technical audience/);
    assert.match(tech, /6\. Technical audience:/);
    assert.doesNotMatch(tech, /Business audience:/);
    assert.match(tech, /'Risks and rollback' and a 'Test checklist'/);
    for (const tool of [
      "servicenow_get_update_set",
      "servicenow_list_update_sets",
      "servicenow_explain_artifact",
      "servicenow_write_doc",
    ])
      assert.ok(tech.includes(tool), tool);
    assert.match(tech, /release-notes\/<update set name>\.md/);
    assert.match(tech, /'Not reviewed' list/);
    assert.match(tech, /raise limit \(max 1000\) or read one type at a time/);

    const biz = await text(client, NOTES, {
      update_set: SYS_ID,
      audience: "Business",
    });
    assert.match(biz, /for a business audience/);
    assert.match(biz, /6\. Business audience:/);
    assert.doesNotMatch(biz, /Technical audience:/);
    assert.match(biz, /no sys_ids, no code/);

    const odd = await text(client, NOTES, {
      update_set: "x",
      audience: "marketing",
    });
    assert.match(odd, /for a technical audience/);
  });
});

// --- clone-down checklist ---------------------------------------------------------

test("clone_down_checklist: snapshot, mail properties, preservers and the post-clone diff", async () => {
  await withPrompts(undefined, async (client) => {
    const t = await text(client, CLONE, { target: "dev" });
    assert.match(t, /cloning an instance down onto `dev`/);
    for (const tool of [
      "servicenow_get_status",
      "servicenow_list_instances",
      "servicenow_test_connection",
      "servicenow_snapshot_instance",
      "servicenow_get_properties",
      "servicenow_query_table",
      "servicenow_compare_instances",
    ])
      assert.ok(t.includes(tool), tool);
    assert.match(t, /servicenow_snapshot_instance for profile `dev`/);
    assert.match(t, /prefix glide\.email\./);
    assert.match(
      t,
      /glide\.email\.smtp\.active and glide\.email\.read\.active/,
    );
    assert.match(
      t,
      /on clone_data_preserver with fields name, table, condition/,
    );
    assert.match(t, /with a <source profile> and b `dev`/);
    assert.match(t, /with a `dev`, b `dev` and from_snapshot/);
    assert.match(t, /marked production/);
    assert.match(t, /'instance' and 'properties' packages/);
    assert.doesNotMatch(t, /sections properties, roles, notifications, acls —/);
  });
});

test("clone_down_checklist: a source profile turns the diff into compare_instances a/b", async () => {
  await withPrompts(undefined, async (client) => {
    const t = await text(client, CLONE, { target: "dev", source: "prod" });
    assert.match(t, /cloning `prod` down onto `dev`/);
    assert.match(
      t,
      /servicenow_compare_instances with a `prod` and b `dev` and sections properties, roles, notifications, acls/,
    );
    assert.doesNotMatch(t, /<source profile>/);
  });
});
