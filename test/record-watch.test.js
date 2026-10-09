// N-10 — record watch resources: subscribable record URIs polled for changes.
import test from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import { registerAllTools, registerResources } from "../build/mcp/registry.js";
import { LIST_CHANGED_NOTIFICATIONS } from "../build/mcp/packages.js";
import {
  parseRecordUri,
  recordUri,
  recordWatchCounts,
} from "../build/mcp/record-watch.js";
import {
  baselineEnv,
  flushAsync,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const URI = recordUri("default", "incident", "abc");
const URI2 = recordUri("default", "incident", "def");
const URI3 = recordUri("default", "incident", "ghi");

/** The runtime of the current scenario (tools bind to it). */
let runtime;

/** A connected in-memory client + server (one MCP session). */
async function open() {
  const server = new McpServer(
    { name: "n10-test", version: "0.0.0" },
    {
      capabilities: { logging: {} },
      debouncedNotificationMethods: LIST_CHANGED_NOTIFICATIONS,
    },
  );
  registerAllTools(server, runtime);
  registerResources(server);
  const client = new Client({ name: "n10-client", version: "0.0.0" });
  const updated = [];
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
    updated.push(n.params.uri);
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return {
    server,
    client,
    updated,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** A Table API double: `state[sys_id]` is the record (undefined → 404). */
function instance(state) {
  return (url) => {
    const u = new URL(url);
    const id = u.pathname.split("/").pop();
    const rec = state[id];
    if (!rec)
      return jsonResponse(404, {
        error: { message: "No Record found", detail: "Record doesn't exist" },
      });
    return jsonResponse(200, { result: { sys_id: id, ...rec } });
  };
}

async function scenario(env, fn) {
  runtime = freshRuntime();
  await withEnv(
    {
      SN_TOOL_PACKAGES: "all",
      SN_PACKAGES_DENY: "",
      SN_PACKAGES_READONLY: "",
      ...env,
    },
    () => fn(),
  );
}

test("record URIs round-trip", () => {
  assert.equal(URI, "servicenow://profiles/default/records/incident/abc");
  assert.deepEqual(parseRecordUri(URI), {
    profile: "default",
    table: "incident",
    sysId: "abc",
  });
  assert.equal(parseRecordUri("servicenow://status"), undefined);
  assert.equal(
    parseRecordUri("servicenow://profiles/default/schema/incident"),
    undefined,
  );
});

test("reading the record resource masks secrets and checks policy", async (t) => {
  await scenario({}, async () => {
    const state = {
      abc: {
        short_description: "printer",
        password: "hunter22",
        sys_updated_on: "2026-10-05 10:00:00",
        sys_mod_count: "1",
      },
    };
    await withFetch(instance(state), async () => {
      const s = await open();
      t.after(s.close);
      const read = await s.client.readResource({ uri: URI });
      const body = JSON.parse(read.contents[0].text);
      assert.equal(body.table, "incident");
      assert.equal(body.record.short_description, "printer");
      assert.notEqual(body.record.password, "hunter22");

      await assert.rejects(
        s.client.readResource({
          uri: recordUri("nope", "incident", "abc"),
        }),
        { code: -32602, message: /Unknown connection profile/ },
      );
    });
  });

  await scenario({ SN_TABLES_DENY: "incident" }, async () => {
    await withFetch(instance({}), async (calls) => {
      const s = await open();
      t.after(s.close);
      await assert.rejects(s.client.readResource({ uri: URI }));
      await assert.rejects(s.client.subscribeResource({ uri: URI }));
      assert.equal(calls.length, 0);
      assert.equal(recordWatchCounts(s.server).session, 0);
    });
  });
});

test("a subscribed record notifies on change, then stops on unsubscribe", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  await scenario({}, async () => {
    const state = {
      abc: { sys_updated_on: "2026-10-05 10:00:00", sys_mod_count: "1" },
    };
    await withFetch(instance(state), async (calls) => {
      const s = await open();
      t.after(s.close);
      await s.client.subscribeResource({ uri: URI });
      assert.equal(calls.length, 1, "baseline read");
      assert.match(
        calls[0].url,
        /sysparm_fields=sys_updated_on%2Csys_mod_count/,
      );
      assert.deepEqual(recordWatchCounts(s.server), { session: 1, total: 1 });

      // Below the 30 s floor nothing polls.
      t.mock.timers.tick(29_999);
      await flushAsync();
      assert.equal(calls.length, 1);

      // Unchanged: a poll, no notification.
      t.mock.timers.tick(1);
      await flushAsync(6);
      assert.equal(calls.length, 2);
      assert.deepEqual(s.updated, []);

      // Changed: one notification.
      state.abc = { sys_updated_on: "2026-10-05 10:01:00", sys_mod_count: "2" };
      t.mock.timers.tick(30_000);
      await flushAsync(6);
      assert.deepEqual(s.updated, [URI]);

      await s.client.unsubscribeResource({ uri: URI });
      assert.deepEqual(recordWatchCounts(s.server), { session: 0, total: 0 });
      t.mock.timers.tick(120_000);
      await flushAsync(6);
      assert.equal(calls.length, 3);
    });
  });
});

test("a short interval is raised to the 30 s floor", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  await scenario({ SN_RECORD_WATCH_INTERVAL_MS: "1000" }, async () => {
    const state = { abc: { sys_updated_on: "a", sys_mod_count: "1" } };
    await withFetch(instance(state), async (calls) => {
      const s = await open();
      t.after(s.close);
      await s.client.subscribeResource({ uri: URI });
      t.mock.timers.tick(29_000);
      await flushAsync(6);
      assert.equal(calls.length, 1);
    });
  });
});

test("a deleted record notifies once and stops polling", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  await scenario({}, async () => {
    const state = { abc: { sys_updated_on: "a", sys_mod_count: "1" } };
    await withFetch(instance(state), async (calls) => {
      const s = await open();
      t.after(s.close);
      await s.client.subscribeResource({ uri: URI });
      delete state.abc;
      t.mock.timers.tick(30_000);
      await flushAsync(6);
      assert.deepEqual(s.updated, [URI]);
      assert.equal(recordWatchCounts(s.server).session, 0);
      t.mock.timers.tick(60_000);
      await flushAsync(6);
      assert.equal(calls.length, 2);
    });
  });
});

test("a missing record cannot be subscribed", async (t) => {
  await scenario({}, async () => {
    await withFetch(instance({}), async () => {
      const s = await open();
      t.after(s.close);
      await assert.rejects(s.client.subscribeResource({ uri: URI }));
      assert.equal(recordWatchCounts(s.server).session, 0);
    });
  });
});

test("caps: per session, per process, and sessions are isolated", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  await scenario(
    { SN_RECORD_WATCH_MAX_PER_SESSION: "2", SN_RECORD_WATCH_MAX: "3" },
    async () => {
      const rec = { sys_updated_on: "a", sys_mod_count: "1" };
      const state = { abc: rec, def: rec, ghi: rec };
      await withFetch(instance(state), async () => {
        const a = await open();
        const b = await open();
        t.after(a.close);
        t.after(b.close);
        await a.client.subscribeResource({ uri: URI });
        await a.client.subscribeResource({ uri: URI }); // repeat: no-op
        await a.client.subscribeResource({ uri: URI2 });
        await assert.rejects(
          a.client.subscribeResource({ uri: URI3 }),
          (e) =>
            e.data?.code === "WATCH_LIMIT" && /PER_SESSION/.test(e.message),
        );
        await b.client.subscribeResource({ uri: URI });
        await assert.rejects(
          b.client.subscribeResource({ uri: URI2 }),
          (e) =>
            e.data?.code === "WATCH_LIMIT" &&
            /SN_RECORD_WATCH_MAX=3/.test(e.message),
        );
        assert.deepEqual(recordWatchCounts(a.server), { session: 2, total: 3 });
        assert.deepEqual(recordWatchCounts(b.server), { session: 1, total: 3 });

        // Only session A sees A's change; closing A frees its slots.
        state.def = { sys_updated_on: "b", sys_mod_count: "2" };
        t.mock.timers.tick(30_000);
        await flushAsync(8);
        assert.deepEqual(a.updated, [URI2]);
        assert.deepEqual(b.updated, []);

        await a.close();
        assert.deepEqual(recordWatchCounts(b.server), { session: 1, total: 1 });
        await b.client.subscribeResource({ uri: URI2 });
        assert.equal(recordWatchCounts(b.server).session, 2);
      });
    },
  );
});
