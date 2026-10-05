import { peekSchemaCache, schemaCacheScope } from "./cache.js";
import { FALLBACK_SECRET_FIELDS } from "./secret-columns.js";

/**
 * N-21 — where the resolved secret-column index lives in the schema cache,
 * and the synchronous peek the write journal uses. Apart from
 * core/secret-columns.ts because the cache needs the credential store, which
 * the redaction primitives (under the logger) must not import.
 */

/** The resolved secret-column index of a profile (see api/secret-columns.ts). */
export interface SecretColumnIndex {
  /** Secret column names per defining table. */
  byTable: Record<string, string[]>;
  /** Every secret column name on the instance. */
  elements: string[];
}

/** Schema-cache key of the secret-column index (`null` = unresolved). */
export const secretIndexKey = (profile?: string): string =>
  `${schemaCacheScope(profile)}|secretColumns`;

/** Schema-cache key of a table's inheritance chain read for masking. */
export const secretChainKey = (table: string, profile?: string): string =>
  `${schemaCacheScope(profile)}|secretChain|${table}`;

function peekKey(key: string): unknown {
  return peekSchemaCache(key).find(([k]) => k === key)?.[1];
}

/**
 * The column names to mask in a journal line for `table`, from the cache only
 * (the journal is synchronous and never reads): the table's secret columns
 * when the index and its chain are cached, every secret column name when only
 * the index is, and always the OOTB names.
 */
export function peekSecretColumns(table: string): Set<string> {
  const out = new Set(FALLBACK_SECRET_FIELDS);
  let index: SecretColumnIndex | null | undefined;
  let chain: string[] | undefined;
  try {
    index = peekKey(secretIndexKey()) as SecretColumnIndex | null | undefined;
    chain = peekKey(secretChainKey(table)) as string[] | undefined;
  } catch {
    return out; // no credentials resolvable — the floor still applies
  }
  if (!index) return out;
  for (const t of chain ?? Object.keys(index.byTable)) {
    for (const element of index.byTable[t] ?? []) out.add(element);
  }
  return out;
}
