import { currentCall, type SecretRegistry } from "./request-context.js";

/**
 * N-21 — type-based field masking. A column whose dictionary `internal_type`
 * is secret is masked at the result boundary (core/redaction.ts) and in the
 * write journal for every tool, whatever `SN_REDACT_FIELDS` says, and the
 * masking cannot be turned off.
 *
 * This module (with core/secret-index.ts) holds the pieces below api/: the secret types, the OOTB field
 * names that act as a floor and as the fallback when the dictionary cannot be
 * read, and the per-call registry the api/ readers fill (api/secret-columns.ts)
 * and the redaction rules drain. The registry records two things:
 *
 * - **fields** — the column names (and dot-walked keys) resolved as secret, so
 *   a key with that name is masked at any depth of the call's result;
 * - **values** — the secret values themselves, so a tool that re-shapes a
 *   record (compare_instances' diffs, a document generator, an export) cannot
 *   carry one out under a different key.
 */

/**
 * The `internal_type` values that hold a secret:
 * - `password` — one-way hashed password (sys_user.user_password);
 * - `password2` — two-way encrypted password (credentials, data sources, …);
 * - `glide_encrypted` — column-level encrypted text.
 *
 * Not listed: `masked` is a catalog *variable* type (sc_item_option), not a
 * dictionary column type, so a Table API read never returns it as a column.
 * Unverified until PDI (O-5): the exact type names on a current release.
 */
export const SECRET_INTERNAL_TYPES = [
  "password",
  "password2",
  "glide_encrypted",
] as const;

/**
 * OOTB column names that hold a secret. They are masked always — as a floor
 * under the dictionary types, and as the whole rule when the dictionary cannot
 * be read (an ACL-restricted user, a denied sys_dictionary, an error). The
 * list is deliberately broad: masking a non-secret column is harmless, missing
 * a secret one is a leak. Unverified until PDI (O-5): `password`,
 * `user_password` (sys_user) and the credential/OAuth/data-source columns are
 * the documented ones; the rest are common names on credential tables.
 */
export const FALLBACK_SECRET_FIELDS: ReadonlySet<string> = new Set([
  "password",
  "user_password",
  "client_secret",
  "api_key",
  "private_key",
  "ssh_private_key",
  "passphrase",
  "ssh_passphrase",
  "key_store_password",
  "jdbc_password",
  "basic_auth_password",
  "token_received",
]);

/** Values shorter than this are masked by their key only (too generic). */
export const MIN_SECRET_VALUE_LENGTH = 4;

/** At most this many values per registry; older ones keep masking by key. */
const MAX_SECRET_VALUES = 5000;

export function createSecretRegistry(): SecretRegistry {
  return { fields: new Set(), values: new Set(), version: 0 };
}

/**
 * The registry of the current tool call. Outside a call (resources, prompts,
 * the CLI) there is none: nothing is recorded, and the redaction rules mask
 * by the OOTB names and SN_REDACT_FIELDS alone. This module imports nothing
 * stateful, because core/redaction.ts sits under the logger, which sits under
 * the runtime container.
 */
export function secretRegistry(): SecretRegistry | undefined {
  return currentCall()?.secrets;
}

/** The last segment of a dot-walked key (`caller_id.user_password`). */
export const leafName = (key: string): string =>
  key.slice(key.lastIndexOf(".") + 1);

/** True when `key` (or its dot-walked leaf) is an OOTB secret name. */
export const isFallbackSecretKey = (key: string): boolean =>
  FALLBACK_SECRET_FIELDS.has(key) || FALLBACK_SECRET_FIELDS.has(leafName(key));

/** Mark column names (or dot-walked keys) as secret for this call. */
export function noteSecretFields(names: Iterable<string>): void {
  const reg = secretRegistry();
  if (!reg) return;
  let changed = false;
  for (const name of names) {
    if (!name || reg.fields.has(name)) continue;
    reg.fields.add(name);
    changed = true;
  }
  if (changed) reg.version++;
}

/** Every non-empty string inside a field value (a `{ value, display_value }` pair included). */
function stringLeaves(value: unknown, out: string[], depth = 0): void {
  if (typeof value === "string") {
    if (value) out.push(value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return;
  }
  if (depth > 4 || value === null || typeof value !== "object") return;
  for (const inner of Object.values(value)) stringLeaves(inner, out, depth + 1);
}

/**
 * Record the values of the `secret` keys of each record, so they are masked
 * wherever they reappear in the call's result. Values shorter than
 * MIN_SECRET_VALUE_LENGTH are left to the key rule.
 */
export function noteSecretValues(
  records: Iterable<unknown>,
  secret: ReadonlySet<string>,
): void {
  if (!secret.size) return;
  const reg = secretRegistry();
  if (!reg) return;
  let changed = false;
  for (const record of records) {
    if (record === null || typeof record !== "object") continue;
    for (const [key, value] of Object.entries(record)) {
      if (!secret.has(key)) continue;
      const leaves: string[] = [];
      stringLeaves(value, leaves);
      for (const leaf of leaves) {
        if (leaf.length < MIN_SECRET_VALUE_LENGTH || reg.values.has(leaf)) {
          continue;
        }
        if (reg.values.size >= MAX_SECRET_VALUES) break;
        reg.values.add(leaf);
        changed = true;
      }
    }
  }
  if (changed) reg.version++;
}
