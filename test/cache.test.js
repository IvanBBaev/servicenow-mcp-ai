// E-9 / L2-08 — the schema cache is an LRU bounded by SN_SCHEMA_CACHE_MAX,
// with hit/miss/eviction counters surfaced through get_status.
import test from "node:test";
import assert from "node:assert/strict";

import {
  cached,
  clearSchemaCache,
  getSchemaCacheStats,
  resetSchemaCacheStats,
} from "../build/core/cache.js";
import {
  getSchemaCacheMax,
  DEFAULT_SCHEMA_CACHE_MAX,
} from "../build/core/settings.js";
import { buildStatusPayload } from "../build/mcp/status.js";
import { baselineEnv, withEnv } from "./helpers.js";

baselineEnv();

const fresh = () => {
  clearSchemaCache();
  resetSchemaCacheStats();
};
const load = (value) => async () => value;

/** True when `key` is served from the cache (the loader is not invoked). */
async function isCached(key) {
  let loaded = false;
  await cached(key, async () => {
    loaded = true;
    return "reloaded";
  });
  return !loaded;
}

const DEFAULTS = {
  SN_SCHEMA_CACHE_MAX: undefined,
  SN_SCHEMA_CACHE_TTL_SEC: undefined,
};

test("getSchemaCacheMax: default 256, positive integers parse, garbage falls back", async () => {
  assert.equal(DEFAULT_SCHEMA_CACHE_MAX, 256);
  await withEnv({ SN_SCHEMA_CACHE_MAX: undefined }, () =>
    assert.equal(getSchemaCacheMax(), 256),
  );
  await withEnv({ SN_SCHEMA_CACHE_MAX: "10" }, () =>
    assert.equal(getSchemaCacheMax(), 10),
  );
  await withEnv({ SN_SCHEMA_CACHE_MAX: "7.9" }, () =>
    assert.equal(getSchemaCacheMax(), 7),
  );
  for (const bad of ["abc", "0", "-5", ""]) {
    await withEnv({ SN_SCHEMA_CACHE_MAX: bad }, () =>
      assert.equal(getSchemaCacheMax(), 256, `value: ${JSON.stringify(bad)}`),
    );
  }
});

test("the 257th insert evicts the least-recently-used entry (default cap)", async () => {
  fresh();
  await withEnv(DEFAULTS, async () => {
    for (let i = 0; i < 257; i++) await cached(`k${i}`, load(i));
    let stats = getSchemaCacheStats();
    assert.equal(stats.size, 256);
    assert.equal(stats.max, 256);
    assert.equal(stats.evictions, 1);
    assert.equal(stats.misses, 257);
    assert.equal(stats.hits, 0);

    assert.equal(await isCached("k1"), true, "k1 survives (and becomes MRU)");
    assert.equal(await isCached("k0"), false, "k0 was the LRU → evicted");
    // Reloading k0 evicted the next LRU, which is k2 (k1 was refreshed above).
    assert.equal(await isCached("k2"), false);
    assert.equal(await isCached("k256"), true);

    stats = getSchemaCacheStats();
    assert.equal(stats.size, 256);
    assert.equal(stats.hits, 2);
    assert.equal(stats.misses, 259);
    assert.equal(stats.evictions, 3);
  });
});

test("a hit refreshes recency: the refreshed key survives the next eviction", async () => {
  fresh();
  await withEnv({ ...DEFAULTS, SN_SCHEMA_CACHE_MAX: "3" }, async () => {
    await cached("a", load(1));
    await cached("b", load(2));
    await cached("c", load(3));
    assert.equal(await isCached("a"), true); // a → most recent; b is now LRU
    await cached("d", load(4)); // evicts b
    assert.equal(await isCached("b"), false);
    assert.equal(await isCached("a"), true);
    assert.equal(await isCached("d"), true);
    assert.equal(getSchemaCacheStats().size, 3);
  });
});

test("SN_SCHEMA_CACHE_MAX=2 keeps exactly two entries", async () => {
  fresh();
  await withEnv({ ...DEFAULTS, SN_SCHEMA_CACHE_MAX: "2" }, async () => {
    await cached("x", load(1));
    await cached("y", load(2));
    await cached("z", load(3));
    const stats = getSchemaCacheStats();
    assert.equal(stats.size, 2);
    assert.equal(stats.max, 2);
    assert.equal(stats.evictions, 1);
    assert.equal(await isCached("x"), false);
    assert.equal(await isCached("z"), true);
  });
});

test("a cap lowered at runtime shrinks the store on the next insert", async () => {
  fresh();
  await withEnv({ ...DEFAULTS, SN_SCHEMA_CACHE_MAX: "5" }, async () => {
    for (const k of ["p", "q", "r", "s", "t"]) await cached(k, load(k));
    assert.equal(getSchemaCacheStats().size, 5);
  });
  await withEnv({ ...DEFAULTS, SN_SCHEMA_CACHE_MAX: "2" }, async () => {
    await cached("u", load("u"));
    const stats = getSchemaCacheStats();
    assert.equal(stats.size, 2);
    assert.equal(stats.evictions, 4);
    assert.equal(await isCached("t"), true);
    assert.equal(await isCached("u"), true);
  });
});

test("expired entries are swept on insert and counted as expired, not evicted", async () => {
  fresh();
  const realNow = Date.now;
  try {
    await withEnv({ ...DEFAULTS, SN_SCHEMA_CACHE_TTL_SEC: "1" }, async () => {
      await cached("old1", load(1));
      await cached("old2", load(2));
      Date.now = () => realNow() + 5_000; // both are now past their TTL
      // An expired hit reloads (expired: 1); the insert sweeps old2 (expired: 2).
      assert.equal(await isCached("old1"), false);
      const stats = getSchemaCacheStats();
      assert.equal(stats.expired, 2);
      assert.equal(stats.evictions, 0);
      assert.equal(stats.size, 1);
      assert.equal(stats.misses, 3);
      assert.equal(stats.hits, 0);
    });
  } finally {
    Date.now = realNow;
  }
});

test("TTL 0 bypasses the cache entirely — no entries, no counters", async () => {
  fresh();
  await withEnv({ ...DEFAULTS, SN_SCHEMA_CACHE_TTL_SEC: "0" }, async () => {
    let loads = 0;
    await cached("bypass", async () => ++loads);
    await cached("bypass", async () => ++loads);
    assert.equal(loads, 2);
    assert.deepEqual(getSchemaCacheStats(), {
      size: 0,
      max: 256,
      hits: 0,
      misses: 0,
      evictions: 0,
      expired: 0,
    });
  });
});

test("clearSchemaCache keeps the cumulative counters; resetSchemaCacheStats zeroes them", async () => {
  fresh();
  await withEnv(DEFAULTS, async () => {
    await cached("c1", load(1));
    await cached("c1", load(1));
    clearSchemaCache();
    let s = getSchemaCacheStats();
    assert.equal(s.size, 0);
    assert.equal(s.hits, 1);
    assert.equal(s.misses, 1);
    resetSchemaCacheStats();
    s = getSchemaCacheStats();
    assert.deepEqual([s.hits, s.misses, s.evictions, s.expired], [0, 0, 0, 0]);
  });
});

test("get_status exposes the cache stats under schemaCache", async () => {
  fresh();
  await withEnv(DEFAULTS, async () => {
    await cached("status-key", load("v"));
    await cached("status-key", load("v"));
    const { schemaCache } = buildStatusPayload();
    assert.deepEqual(schemaCache, {
      size: 1,
      max: 256,
      hits: 1,
      misses: 1,
      evictions: 0,
      expired: 0,
    });
  });
});
