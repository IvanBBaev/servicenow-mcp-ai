// E-3 — the runtime container: isolation between runtimes, dispose()
// semantics, call binding and the removal of the old `_reset*` hooks.
import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createRuntime,
  currentRuntime,
  defineRuntimePart,
  installRuntime,
  runWithRuntime,
} from "../build/core/runtime.js";
import { cached, getSchemaCacheStats } from "../build/core/cache.js";
import {
  getQueueStats,
  getTelemetry,
  telemetryFor,
  withSlot,
} from "../build/core/http-util.js";
import {
  _dispatcherCacheSize,
  _setUndiciLoader,
  getDispatcher,
} from "../build/core/dispatcher.js";
import { dispose, registerDisposer } from "../build/core/lifecycle.js";
import { registerAllTools } from "../build/mcp/registry.js";
import { baselineEnv, freshRuntime, withEnv } from "./helpers.js";

baselineEnv();
const HOST = "dev00000.service-now.com";

function fakeUndici() {
  const created = [];
  class Agent {
    constructor(opts) {
      this.opts = opts;
      this.closed = false;
      created.push(this);
    }
    close() {
      this.closed = true;
      return Promise.resolve();
    }
  }
  return { created, module: { Agent, ProxyAgent: Agent } };
}

/** Put some state into every part of the current runtime. */
async function populate(tag) {
  await cached(`key-${tag}`, async () => tag);
  telemetryFor(`${tag}.example.com`).requests += 1;
}

test("two runtimes are isolated from each other", async () => {
  await withEnv({}, async () => {
    const a = createRuntime();
    const b = createRuntime();
    await runWithRuntime(a, () => populate("a"));
    await runWithRuntime(b, () => populate("b"));

    const hostsA = runWithRuntime(a, () => Object.keys(getTelemetry().perHost));
    const hostsB = runWithRuntime(b, () => Object.keys(getTelemetry().perHost));
    assert.deepEqual(hostsA, ["a.example.com"]);
    assert.deepEqual(hostsB, ["b.example.com"]);
    assert.equal(
      runWithRuntime(a, () => getSchemaCacheStats().size),
      1,
    );

    // Disposing one runtime leaves the other untouched.
    await a.dispose();
    assert.equal(
      runWithRuntime(a, () => getSchemaCacheStats().size),
      0,
    );
    assert.equal(
      runWithRuntime(b, () => getSchemaCacheStats().size),
      1,
    );
    assert.equal(
      runWithRuntime(b, () => getTelemetry().requests),
      1,
    );
    await b.dispose();
  });
});

test("dispose() clears every part, runs disposers and is idempotent", async () => {
  const fake = fakeUndici();
  _setUndiciLoader(async () => fake.module);
  try {
    await withEnv({ SN_TLS_CA: "CA-PEM", SN_MAX_CONCURRENT: "1" }, async () => {
      const rt = createRuntime();
      let ran = 0;
      rt.onDispose(() => {
        ran += 1;
      });
      let release;
      const holder = runWithRuntime(rt, () =>
        withSlot(
          HOST,
          () =>
            new Promise((r) => {
              release = r;
            }),
        ),
      );
      const waiter = runWithRuntime(rt, () =>
        withSlot(HOST, async () => "never"),
      );
      await runWithRuntime(rt, async () => {
        await populate("x");
        await getDispatcher(HOST);
        assert.equal(_dispatcherCacheSize(), 1);
        assert.deepEqual(getQueueStats()[HOST], { active: 1, queued: 1 });
      });

      await Promise.all([rt.dispose(), rt.dispose()]);
      await assert.rejects(waiter, /was drained/);
      assert.equal(fake.created[0].closed, true);
      assert.equal(ran, 1, "concurrent dispose calls share one run");
      runWithRuntime(rt, () => {
        assert.equal(getSchemaCacheStats().size, 0);
        assert.equal(getSchemaCacheStats().misses, 0);
        assert.equal(getTelemetry().requests, 0);
        assert.equal(_dispatcherCacheSize(), 0);
        assert.deepEqual(getQueueStats(), {});
      });

      await rt.dispose();
      assert.equal(ran, 2, "a later dispose runs again, still safe");
      release();
      await holder;
    });
  } finally {
    _setUndiciLoader(null);
  }
});

test("dispose() on an untouched runtime is a no-op", async () => {
  await createRuntime().dispose();
});

test("a failing dispose step is logged and does not stop the others", async () => {
  const rt = createRuntime();
  const broken = defineRuntimePart(
    "test-broken",
    () => ({}),
    () => {
      throw new Error("boom");
    },
  );
  rt.get(broken);
  let ran = false;
  const off = rt.onDispose(() => {
    ran = true;
  });
  await rt.dispose();
  assert.equal(ran, true);
  off();
  ran = false;
  await rt.dispose();
  assert.equal(ran, false, "unregistered disposers no longer run");
});

test("currentRuntime(): the bound runtime wins over the installed one", async () => {
  const installed = freshRuntime();
  assert.equal(currentRuntime(), installed);
  const other = createRuntime();
  await runWithRuntime(other, async () => {
    await Promise.resolve();
    assert.equal(currentRuntime(), other, "binding survives awaits");
  });
  assert.equal(currentRuntime(), installed);
  // The lifecycle delegates act on the current runtime.
  let ran = false;
  const off = registerDisposer(() => {
    ran = true;
  });
  await dispose();
  off();
  assert.equal(ran, true);
});

test("installRuntime() returns the previous runtime", () => {
  const a = createRuntime();
  const b = createRuntime();
  installRuntime(a);
  assert.equal(installRuntime(b), a);
  assert.equal(currentRuntime(), b);
});

test("registerAllTools binds every tool call to the given runtime", async () => {
  await withEnv({}, async () => {
    const installed = freshRuntime();
    const rt = createRuntime();
    const server = new McpServer({ name: "t", version: "0" });
    registerAllTools(server, rt);
    const client = new Client({ name: "c", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      runWithRuntime(rt, () => {
        telemetryFor("bound.example.com").requests = 7;
      });
      const res = await client.callTool({
        name: "servicenow_get_status",
        arguments: {},
      });
      assert.notEqual(res.isError, true, JSON.stringify(res.content));
      const text = res.content.map((c) => c.text ?? "").join("\n");
      assert.match(text, /bound\.example\.com/);
      assert.equal(
        runWithRuntime(installed, () => getTelemetry().requests),
        0,
        "the installed runtime was not touched",
      );
    } finally {
      await client.close();
      await rt.dispose();
    }
  });
});

test("no `_reset*` hook remains on the core modules", async () => {
  for (const mod of [
    "core/http-util.js",
    "core/http.js",
    "core/dispatcher.js",
    "core/mtls.js",
    "core/cache.js",
    "core/auth.js",
    "core/config.js",
    "core/lifecycle.js",
    "api/plugin.js",
  ]) {
    const exports = Object.keys(await import(`../build/${mod}`));
    const resets = exports.filter((name) => name.startsWith("_reset"));
    assert.deepEqual(resets, [], `${mod} still exports ${resets.join(", ")}`);
  }
});
