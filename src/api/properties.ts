import { ServiceNowError } from "../core/errors.js";
import { assertTableAllowed, assertWriteAllowed } from "../core/policy.js";
import { REDACTED } from "../core/redaction.js";
import { snString } from "./shared.js";
import { queryTable, updateRecord, type SnRecord } from "./table.js";

/**
 * S-10 — system properties (`sys_properties`): a masked, bounded read and a
 * single-property value write. The write is a plain Table API update of the
 * property row, so it goes through the table policy and SN_READONLY like any
 * other update; the tool layer adds plan/apply and the write journal.
 */

export const PROPERTIES_TABLE = "sys_properties";

const PROPERTY_FIELDS = [
  "sys_id",
  "name",
  "value",
  "type",
  "description",
  "is_private",
  "read_roles",
  "write_roles",
  "sys_scope",
  "sys_mod_count",
  "sys_updated_on",
  "sys_updated_by",
];

/** Property names: dotted identifiers (glide.ui.session_timeout, x_acme.flag). */
export const PROPERTY_NAME_RE = /^[A-Za-z0-9_.-]{1,255}$/;

/** Names that look like they hold a secret, masked like `password` types. */
const SECRET_NAME =
  /password|secret|token|credential|private[_.]?key|api[_.]?key/i;
const SECRET_TYPES = new Set(["password", "password2"]);

const DEGRADE_STATUSES = new Set([400, 403, 404]);

export function assertPropertyName(name: string, field = "name"): void {
  if (!PROPERTY_NAME_RE.test(name)) {
    throw new ServiceNowError(
      `Invalid property ${field} "${name}": use letters, digits, '.', '_' and '-'.`,
      400,
    );
  }
}

/** Whether a property's value must not be shown or journaled in clear. */
export function isSecretProperty(record: SnRecord): boolean {
  return (
    SECRET_TYPES.has(snString(record.type).toLowerCase()) ||
    SECRET_NAME.test(snString(record.name))
  );
}

function present(record: SnRecord, maxChars: number): SnRecord {
  const out: SnRecord = { ...record };
  if (isSecretProperty(record)) {
    out.value = REDACTED;
    out.masked = true;
    return out;
  }
  const value = snString(record.value);
  if (value.length > maxChars) {
    out.value = value.slice(0, maxChars);
    out.value_truncated = true;
    out.value_length = value.length;
  }
  return out;
}

export interface PropertyQuery {
  /** Exact property name. */
  name?: string;
  /** Name prefix, e.g. 'glide.ui.'. */
  prefix?: string;
  limit?: number;
  valueMaxChars?: number;
}

/**
 * S-10 — read system properties by exact name or name prefix. Values of
 * password-type or secret-looking properties are masked; long values are
 * truncated. An instance that refuses the read (ACL) degrades.
 */
export async function getProperties(
  opts: PropertyQuery,
): Promise<Record<string, unknown>> {
  assertTableAllowed(PROPERTIES_TABLE);
  const clauses: string[] = [];
  if (opts.name) {
    assertPropertyName(opts.name);
    clauses.push(`name=${opts.name}`);
  }
  if (opts.prefix) {
    assertPropertyName(opts.prefix, "prefix");
    clauses.push(`nameSTARTSWITH${opts.prefix}`);
  }
  if (!clauses.length) {
    throw new ServiceNowError("Give a property name or a name prefix.", 400);
  }
  clauses.push("ORDERBYname");
  const limit = Math.min(opts.limit ?? 50, 500);
  const maxChars = opts.valueMaxChars ?? 4000;
  try {
    const { records, total } = await queryTable({
      table: PROPERTIES_TABLE,
      query: clauses.join("^"),
      fields: PROPERTY_FIELDS,
      displayValue: "false",
      limit,
    });
    const properties = records.map((r) => present(r, maxChars));
    return {
      count: properties.length,
      ...(total === undefined ? {} : { total }),
      truncated: total !== undefined && total > properties.length,
      properties,
      ...(opts.name && !properties.length
        ? {
            note: `No readable property named "${opts.name}". sys_properties rows are ACL-filtered, and a property with no row falls back to its code default.`,
          }
        : {}),
    };
  } catch (error) {
    const status = error instanceof ServiceNowError ? error.status : undefined;
    if (status === undefined || !DEGRADE_STATUSES.has(status)) throw error;
    return {
      count: 0,
      properties: [],
      degraded: { status, reason: (error as Error).message },
    };
  }
}

/** The one property row a write targets; NOT_FOUND when there is none. */
export async function resolveProperty(name: string): Promise<SnRecord> {
  assertPropertyName(name);
  const { records } = await queryTable({
    table: PROPERTIES_TABLE,
    query: `name=${name}`,
    fields: PROPERTY_FIELDS,
    displayValue: "false",
    limit: 2,
  });
  if (!records.length) {
    throw new ServiceNowError(
      `System property "${name}" not found (or not readable).`,
      404,
      undefined,
      {
        code: "PROPERTY_NOT_FOUND",
        hint: "Setting a property only updates an existing sys_properties row; create new properties in the instance.",
      },
    );
  }
  if (records.length > 1) {
    throw new ServiceNowError(
      `More than one sys_properties row is named "${name}"; refusing an ambiguous write.`,
      409,
      undefined,
      { code: "AMBIGUOUS_KEY" },
    );
  }
  return records[0] as SnRecord;
}

/** S-10 — set one existing property's value (a Table API update of its row). */
export async function setPropertyValue(
  sysId: string,
  value: string,
): Promise<SnRecord> {
  assertWriteAllowed("set system property");
  return updateRecord(PROPERTIES_TABLE, sysId, { value });
}

/** A property row as it may be shown or journaled (secret values masked). */
export function maskedProperty(record: SnRecord): SnRecord {
  return isSecretProperty(record) ? { ...record, value: REDACTED } : record;
}
