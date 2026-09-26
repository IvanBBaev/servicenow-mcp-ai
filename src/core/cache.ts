import { getSchemaCacheTtlMs, getSchemaCacheMax } from "./settings.js";
import { currentRuntime, defineRuntimePart } from "./runtime.js";

/**
 * Tiny TTL + LRU cache for near-static reads (table lists, schemas, CMDB class
 * meta). Deliberately applied only in api/meta.ts and api/cmdb.ts — do not
 * generalise to volatile reads.
 *
 * Bounded (E-9 / L2-08): at most `SN_SCHEMA_CACHE_MAX` entries (default 256).
 * The Map's insertion order doubles as the recency list — a hit re-inserts
 * the key at the end, so the first key is always the least recently used and
 * is the one evicted when an insert finds the cache full. Expired entries are
 * swept on every insert so they never count against the cap.
 */

interface Entry {
  value: unknown;
  expiresAt: number;
}

interface SchemaCache {
  store: Map<string, Entry>;
  /** Counters since startup (or the last `resetSchemaCacheStats()`). */
  counters: {
    hits: number;
    misses: number;
    evictions: number;
    expired: number;
  };
}

// E-3: the cache lives in the runtime container; dispose() drops the entries
// and zeroes the counters.
const schemaCachePart = defineRuntimePart(
  "schemaCache",
  (): SchemaCache => ({
    store: new Map(),
    counters: { hits: 0, misses: 0, evictions: 0, expired: 0 },
  }),
  (cache) => {
    cache.store.clear();
    zero(cache.counters);
  },
);

const state = (): SchemaCache => currentRuntime().get(schemaCachePart);

function zero(counters: SchemaCache["counters"]): void {
  counters.hits = 0;
  counters.misses = 0;
  counters.evictions = 0;
  counters.expired = 0;
}

export interface SchemaCacheStats {
  /** Entries currently held (expired ones linger until the next insert). */
  size: number;
  /** The configured cap (`SN_SCHEMA_CACHE_MAX`). */
  max: number;
  /** Lookups served from the cache. */
  hits: number;
  /** Lookups that ran the loader (absent or expired key). */
  misses: number;
  /** Entries dropped to make room for a new one (LRU pressure, not TTL). */
  evictions: number;
  /** Entries dropped because their TTL ran out. */
  expired: number;
}

/** Run `fn` through the cache under `key`; a TTL of 0 disables caching. */
export async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const ttlMs = getSchemaCacheTtlMs();
  if (ttlMs <= 0) return fn();
  const { store, counters } = state();
  const hit = store.get(key);
  if (hit) {
    if (hit.expiresAt > Date.now()) {
      counters.hits += 1;
      // Refresh recency: re-inserting moves the key to the most-recent end.
      store.delete(key);
      store.set(key, hit);
      return hit.value as T;
    }
    store.delete(key);
    counters.expired += 1;
  }
  counters.misses += 1;
  const value = await fn();
  insert(state(), key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function insert(
  { store, counters }: SchemaCache,
  key: string,
  entry: Entry,
): void {
  const now = Date.now();
  for (const [k, e] of store) {
    if (e.expiresAt <= now) {
      store.delete(k);
      counters.expired += 1;
    }
  }
  // A concurrent miss may have stored the key meanwhile — drop it so the
  // re-insert lands at the most-recent end and the size check stays exact.
  store.delete(key);
  const max = getSchemaCacheMax();
  while (store.size >= max) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
    counters.evictions += 1;
  }
  store.set(key, entry);
}

/**
 * M-4: the unexpired entries whose key starts with `prefix`, read without
 * touching recency or the counters — completions and resource lists peek at
 * what earlier reads cached, they never load.
 */
export function peekSchemaCache(prefix: string): [string, unknown][] {
  const now = Date.now();
  const out: [string, unknown][] = [];
  for (const [key, entry] of state().store) {
    if (entry.expiresAt > now && key.startsWith(prefix)) {
      out.push([key, entry.value]);
    }
  }
  return out;
}

/** Snapshot of the cache size and its counters — surfaced by `get_status`. */
export function getSchemaCacheStats(): SchemaCacheStats {
  const { store, counters } = state();
  return { size: store.size, max: getSchemaCacheMax(), ...counters };
}

/**
 * Drop every entry — used by tests and after credential changes. The
 * counters are cumulative "since startup" figures (like the HTTP telemetry)
 * and survive a clear; `resetSchemaCacheStats()` zeroes them.
 */
export function clearSchemaCache(): void {
  state().store.clear();
}

/** Zero the hit/miss/eviction counters (session teardown and tests). */
export function resetSchemaCacheStats(): void {
  zero(state().counters);
}
