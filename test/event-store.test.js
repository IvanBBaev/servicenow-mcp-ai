// N-79 — the per-session SSE event ring behind Last-Event-ID resumption.
import test from "node:test";
import assert from "node:assert/strict";

import {
  EVENT_STORE_MAX_BYTES,
  EVENT_STORE_MAX_EVENTS,
  SessionEventStore,
} from "../build/mcp/event-store.js";

const msg = (id) => ({ jsonrpc: "2.0", id, result: {} });

async function replay(store, lastEventId) {
  const sent = [];
  const streamId = await store.replayEventsAfter(lastEventId, {
    send: async (eventId, message) => {
      sent.push([eventId, message.id]);
    },
  });
  return { streamId, sent };
}

test("the defaults bound a session's ring", () => {
  assert.equal(EVENT_STORE_MAX_EVENTS, 256);
  assert.equal(EVENT_STORE_MAX_BYTES, 256 * 1024);
  assert.equal(new SessionEventStore().size, 0);
});

test("replay sends the same stream's later messages and skips the priming event", async () => {
  const store = new SessionEventStore();
  const priming = await store.storeEvent("a", {});
  const other = await store.storeEvent("b", msg(9));
  const first = await store.storeEvent("a", msg(1));
  await store.storeEvent("a", {});
  const second = await store.storeEvent("a", msg(2));

  assert.equal(await store.getStreamIdForEventId(other), "b");
  assert.deepEqual(await replay(store, priming), {
    streamId: "a",
    sent: [
      [first, 1],
      [second, 2],
    ],
  });
  assert.deepEqual(await replay(store, first), {
    streamId: "a",
    sent: [[second, 2]],
  });
  assert.deepEqual(await replay(store, second), { streamId: "a", sent: [] });
});

test("an unknown id has no stream and replays nothing", async () => {
  const store = new SessionEventStore();
  await store.storeEvent("a", msg(1));
  assert.equal(await store.getStreamIdForEventId("nope"), undefined);
  assert.deepEqual(await replay(store, "nope"), { streamId: "", sent: [] });
});

test("past maxEvents the oldest events are dropped", async () => {
  const store = new SessionEventStore({ maxEvents: 3 });
  const ids = [];
  for (let i = 1; i <= 5; i += 1) ids.push(await store.storeEvent("a", msg(i)));
  assert.equal(store.size, 3);
  assert.equal(await store.getStreamIdForEventId(ids[1]), undefined);
  assert.deepEqual((await replay(store, ids[2])).sent, [
    [ids[3], 4],
    [ids[4], 5],
  ]);
});

test("past maxBytes the oldest events are dropped; the newest is always kept", async () => {
  const one = Buffer.byteLength(JSON.stringify(msg(1)));
  const store = new SessionEventStore({ maxBytes: one * 2 });
  const a = await store.storeEvent("a", msg(1));
  await store.storeEvent("a", msg(2));
  await store.storeEvent("a", msg(3));
  assert.equal(store.size, 2);
  assert.equal(await store.getStreamIdForEventId(a), undefined);

  const big = { jsonrpc: "2.0", id: 4, result: { text: "x".repeat(one * 4) } };
  const last = await store.storeEvent("a", big);
  assert.equal(store.size, 1);
  assert.equal(await store.getStreamIdForEventId(last), "a");
});
