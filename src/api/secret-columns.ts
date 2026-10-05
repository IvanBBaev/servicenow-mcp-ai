import { snRequest } from "../core/http.js";
import { assertTableAllowed } from "../core/policy.js";
import { cached } from "../core/cache.js";
import { IntegrationError } from "../core/errors.js";
import { MAX_PAGE_SIZE } from "../core/settings.js";
import { logger } from "../core/logging.js";
import {
  SECRET_INTERNAL_TYPES,
  isFallbackSecretKey,
  leafName,
  noteSecretFields,
  noteSecretValues,
  secretRegistry,
} from "../core/secret-columns.js";
import {
  secretChainKey,
  secretIndexKey,
  type SecretColumnIndex,
} from "../core/secret-index.js";
import { snString } from "./shared.js";

/**
 * N-21 — the lazy, cached resolver behind type-based masking. The Table API
 * readers (api/table.ts, api/batch.ts) hand every record set they receive to
 * `noteSecretRecords`; it decides which keys are secret columns and records
 * them (and their values) in the call's registry, which the result boundary
 * and the write journal mask.
 *
 * Resolution, cheapest first:
 * 1. One sys_dictionary read per profile (schema-cached like describe_table,
 *    `SN_SCHEMA_CACHE_TTL_SEC`): every column whose `internal_type` is secret.
 *    Most reads return no key of that name and cost nothing more.
 * 2. Only when a key matches a secret column name somewhere, the table's
 *    inheritance chain (one dot-walked sys_db_object read, also cached) tells
 *    whether the column is this table's (or an ancestor's).
 * 3. A schema miss — the dictionary unreadable (ACL, table policy, error) or
 *    empty — never blocks the read: the OOTB names (FALLBACK_SECRET_FIELDS)
 *    apply, as they always do as a floor. A dot-walked key is matched on its
 *    leaf name (the referenced table is not resolved), which over-masks rather
 *    than leaks.
 *
 * The lookups call snRequest directly, so they never re-enter this hook.
 * Unverified until PDI (O-5): the `internal_typeIN…` query on sys_dictionary
 * and the deep `super_class.…name` dot-walk on sys_db_object.
 */

/** Tables whose rows describe columns; their own reads never trigger a lookup. */
const META_TABLES = new Set(["sys_dictionary", "sys_db_object"]);

/** At most this many index pages are read (a safety cap, not a real limit). */
const MAX_INDEX_PAGES = 20;

/** Ancestors read per sys_db_object request (dot-walk depth). */
const CHAIN_LEVELS = 8;
const MAX_CHAIN_DEPTH = 20;

/** An answer the dictionary will keep giving — cached as unresolved. */
function isStableDenial(e: unknown): boolean {
  if (!(e instanceof IntegrationError)) return false;
  return (
    e.status === 401 ||
    e.status === 403 ||
    e.code === "POLICY_DENIED" ||
    e.code === "NOT_CONFIGURED"
  );
}

/**
 * Resolve, then cache: a stable denial (ACL, table policy) is cached as
 * unresolved; a transient error is not cached, and both fall back to the
 * OOTB names for this read.
 */
async function resolveCached<T>(
  key: string,
  load: () => Promise<T | null>,
): Promise<T | null> {
  try {
    return await cached(key, async () => {
      try {
        return await load();
      } catch (e) {
        if (isStableDenial(e)) return null;
        throw e;
      }
    });
  } catch (e) {
    logger.debug("secret-column lookup failed — masking by name only", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** The secret-column index of the active profile, or null when unresolved. */
export function resolveSecretIndex(): Promise<SecretColumnIndex | null> {
  let key: string;
  try {
    key = secretIndexKey();
  } catch {
    return Promise.resolve(null);
  }
  return resolveCached(key, loadIndex);
}

async function loadIndex(): Promise<SecretColumnIndex | null> {
  assertTableAllowed("sys_dictionary");
  const byTable: Record<string, string[]> = {};
  const elements = new Set<string>();
  for (let page = 0; page < MAX_INDEX_PAGES; page++) {
    const params = new URLSearchParams({
      sysparm_query: `internal_typeIN${SECRET_INTERNAL_TYPES.join(",")}^elementISNOTEMPTY^ORDERBYsys_id`,
      sysparm_fields: "name,element,internal_type",
      sysparm_display_value: "false",
      sysparm_exclude_reference_link: "true",
      sysparm_limit: String(MAX_PAGE_SIZE),
      sysparm_no_count: "true",
    });
    if (page) params.set("sysparm_offset", String(page * MAX_PAGE_SIZE));
    const { data } = await snRequest<{ result?: unknown }>({
      method: "GET",
      path: "/api/now/table/sys_dictionary",
      params,
    });
    const rows = Array.isArray(data?.result) ? data.result : [];
    for (const row of rows as Record<string, unknown>[]) {
      const table = snString(row?.name);
      const element = snString(row?.element);
      if (!table || !element) continue;
      (byTable[table] ??= []).push(element);
      elements.add(element);
    }
    if (rows.length < MAX_PAGE_SIZE) break;
  }
  // Every instance has secret columns (sys_user.user_password): an empty
  // answer means the dictionary is hidden from this user — unresolved.
  if (!elements.size) return null;
  return { byTable, elements: [...elements].sort() };
}

/** The inheritance chain of `table` (itself first), or null when unresolved. */
function resolveChain(table: string): Promise<string[] | null> {
  return resolveCached(secretChainKey(table), () => loadChain(table));
}

async function loadChain(table: string): Promise<string[] | null> {
  assertTableAllowed("sys_db_object");
  const chain = [table];
  const walk = (n: number): string => `${"super_class.".repeat(n)}name`;
  let current = table;
  while (chain.length < MAX_CHAIN_DEPTH) {
    const fields = Array.from({ length: CHAIN_LEVELS }, (_, i) => walk(i + 1));
    const { data } = await snRequest<{ result?: unknown }>({
      method: "GET",
      path: "/api/now/table/sys_db_object",
      params: new URLSearchParams({
        sysparm_query: `name=${current}`,
        sysparm_fields: fields.join(","),
        sysparm_display_value: "false",
        sysparm_exclude_reference_link: "true",
        sysparm_limit: "1",
      }),
    });
    const row = (Array.isArray(data?.result) ? data.result[0] : undefined) as
      | Record<string, unknown>
      | undefined;
    if (!row) break;
    let last = "";
    for (const f of fields) {
      const parent = snString(row[f]);
      if (!parent || chain.includes(parent)) {
        last = "";
        break;
      }
      chain.push(parent);
      last = parent;
    }
    if (!last) break;
    current = last;
  }
  return chain;
}

/**
 * The keys of `keys` that are secret columns of `table`. Reads at most the
 * index and, when a key matches a secret column name, the table's chain.
 */
export async function secretKeysFor(
  table: string,
  keys: Iterable<string>,
): Promise<Set<string>> {
  const all = [...new Set(keys)];
  const secret = new Set(all.filter(isFallbackSecretKey));
  if (META_TABLES.has(table)) return secret;
  const index = await resolveSecretIndex();
  if (!index) return secret;
  const elements = new Set(index.elements);
  const own: string[] = [];
  for (const key of all) {
    if (secret.has(key)) continue;
    if (key.includes(".")) {
      if (elements.has(leafName(key))) secret.add(key);
    } else if (elements.has(key)) {
      own.push(key);
    }
  }
  if (!own.length) return secret;
  const chain = await resolveChain(table);
  if (!chain) {
    for (const key of own) secret.add(key); // unresolved chain: over-mask
    return secret;
  }
  const columns = new Set(chain.flatMap((t) => index.byTable[t] ?? []));
  for (const key of own) if (columns.has(key)) secret.add(key);
  return secret;
}

/**
 * Row-level secrets: a system property whose `type` is password / password2
 * keeps its secret in the plain `value` column, which no dictionary type
 * marks. Its value is recorded (not the `value` key, which every property
 * has), so it is masked wherever it reappears. The property tools already
 * mask these (api/properties.ts, api/collectors.ts); this covers a raw
 * query_table / get_record / batch read of sys_properties.
 */
function noteSecretPropertyValues(table: string, records: unknown[]): void {
  if (table !== "sys_properties") return;
  const values = records
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .filter((r) => {
      const type = r.type;
      const raw =
        type && typeof type === "object"
          ? (type as { value?: unknown }).value
          : type;
      return (
        typeof raw === "string" &&
        (SECRET_INTERNAL_TYPES as readonly string[]).includes(raw)
      );
    })
    .map((r) => ({ value: r.value }));
  noteSecretValues(values, new Set(["value"]));
}

/** Top-level keys of a record set. */
function keysOf(records: readonly unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const r of records) {
    if (r && typeof r === "object" && !Array.isArray(r)) {
      for (const k of Object.keys(r)) keys.add(k);
    }
  }
  return keys;
}

/**
 * Record the secret columns of `records` (read from, or sent to, `table`) and
 * their values in the call's registry. Never throws: a failure masks by the
 * OOTB names, which the redaction rules always apply.
 */
export async function noteSecretRecords(
  table: string,
  records: unknown,
): Promise<void> {
  const list = Array.isArray(records) ? records : [records];
  // Outside a tool call there is no registry to fill: skip the lookups.
  if (!list.length || !secretRegistry()) return;
  noteSecretPropertyValues(table, list);
  try {
    const secret = await secretKeysFor(table, keysOf(list));
    if (!secret.size) return;
    noteSecretFields(secret);
    noteSecretValues(list, secret);
  } catch (e) {
    logger.debug("secret-column noting failed — masking by name only", {
      table,
      error: e instanceof Error ? e.message : String(e),
    });
    const fallback = new Set([...keysOf(list)].filter(isFallbackSecretKey));
    noteSecretFields(fallback);
    noteSecretValues(list, fallback);
  }
}
