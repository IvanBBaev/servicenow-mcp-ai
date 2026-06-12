import { getSchemaCacheTtlMs } from "./settings.js";

/**
 * Tiny TTL cache for near-static reads (table lists, schemas, CMDB class
 * meta). Deliberately applied only in api/meta.ts and api/cmdb.ts — do not
 * generalise to volatile reads.
 */

interface Entry {
  value: unknown;
  expiresAt: number;
}

const store = new Map<string, Entry>();

/** Run `fn` through the cache under `key`; a TTL of 0 disables caching. */
export async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const ttlMs = getSchemaCacheTtlMs();
  if (ttlMs <= 0) return fn();
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await fn();
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/** Drop everything — used by tests and after credential changes. */
export function clearSchemaCache(): void {
  store.clear();
}
