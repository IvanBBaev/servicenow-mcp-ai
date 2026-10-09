/**
 * P-5 — generic artefact read tools (project/SDK-PARITY.md §5(d)).
 *
 * `listArtifacts` and `getArtifact` read any type in the artefact registry
 * (`src/core/artifacts/registry.ts`) through the Table API: the primary table,
 * then every child table in descriptor order (nested children such as
 * `sp_page → sp_container → sp_row` hang off the rows read before them).
 * Every table read goes through the table policy; a child table the policy
 * denies is reported as `redacted` instead of failing the whole read.
 *
 * Types O-5 has not confirmed on a live instance (`verified:false`) are served
 * too, but their output says so and an instance that rejects the table or its
 * fields (400 / 403 / 404) degrades to an empty, explained result instead of an
 * error. A degraded result (and a not-found unverified read) probes
 * `sys_db_object` for the table and says `available:false` when the instance
 * has no such table (the plugin or SDK feature is not installed there); for a
 * licensed family (`licensed`, P-8) it also names the plugin as `requires`.
 */
import { ServiceNowError } from "../core/errors.js";
import { assertTableAllowed } from "../core/policy.js";
import { REDACTED } from "../core/redaction.js";
import {
  ARTIFACT_TYPES,
  getArtifactType,
  type ArtifactChild,
  type ArtifactType,
} from "../core/artifacts/registry.js";
import { detectSdkManaged } from "../core/artifacts/sdk-managed.js";
import {
  getRecord,
  keyQuery,
  queryTable,
  type KeyValue,
  type SnRecord,
} from "./table.js";
import { snString, degradeStatus } from "./shared.js";
import { scopeClause } from "./scripts.js";
import { DOMAIN_FIELDS, keepDomainFields } from "./domain-separation.js";

/** Rows returned per child table before the entry is marked `truncated`. */
export const CHILD_LIMIT = 200;

/** Default and maximum page size of `listArtifacts`. */
export const LIST_LIMIT = { default: 50, max: 1000 } as const;

const AUDIT_FIELDS = ["sys_updated_on", "sys_updated_by"];

const UNVERIFIED_CAVEAT =
  "This type is verified:false: its table and field names come from the SDK inventory and have not been confirmed on a live instance (gate O-5).";

/** Resolve a registry type id, or throw a 400 naming the valid ones. */
export function resolveArtifactType(type: string): ArtifactType {
  const descriptor = getArtifactType(type.trim());
  if (!descriptor) {
    throw new ServiceNowError(
      `Unknown artifact type '${type}'. Valid types: ${ARTIFACT_TYPES.map((t) => t.type).join(", ")}.`,
      400,
      undefined,
      {
        hint: "Read the servicenow://artifact-types resource for every type with its table and key fields.",
      },
    );
  }
  return descriptor;
}

/**
 * Whether the instance has `table`: a one-row `sys_db_object` probe. `undefined`
 * when the probe itself cannot answer (policy denial, ACL, network), so callers
 * only claim `available:false` on a positive "no such table".
 */
export async function tableAvailable(
  table: string,
): Promise<boolean | undefined> {
  try {
    const { records } = await queryTable({
      table: "sys_db_object",
      query: keyQuery({ name: table }),
      fields: ["name"],
      displayValue: "false",
      limit: 1,
    });
    return records.length > 0;
  } catch {
    return undefined;
  }
}

/**
 * `{available}` when the probe answered, else nothing; an absent licensed
 * table also says which plugin / store app would provide it.
 */
async function availability(
  t: ArtifactType,
): Promise<{ available?: boolean; requires?: string }> {
  const available = await tableAvailable(t.table);
  if (available === undefined) return {};
  return !available && t.licensed
    ? { available, requires: t.licensed }
    : { available };
}

/** Descriptor fields none of the returned rows carried (a naming hint for O-5). */
function missingFields(fields: string[], rows: SnRecord[]): string[] {
  if (!rows.length) return [];
  return fields.filter((f) => rows.every((r) => !(f in r)));
}

/** The `{sys_id, scope}` pair of a row (the scope namespace when dot-walked). */
function rowScope(
  t: ArtifactType,
  row: SnRecord,
): { sys_id: string | null; scope: string | null } {
  const id = snString(row[t.scopeField]);
  const ns = snString(row[`${t.scopeField}.scope`]);
  return { sys_id: id || null, scope: ns || null };
}

export interface ListArtifactsOptions {
  artifactType: string;
  /** Application scope: its namespace (`global`, `x_acme_app`) or sys_id. */
  scope?: string;
  /** Extra encoded query, ANDed with the type's base query. */
  query?: string;
  active?: boolean;
  limit?: number;
}

export interface ArtifactSummary {
  sys_id: string;
  name: string;
  /** The natural key (`keyFields`) values; `sys_id` when the type has none. */
  key: Record<string, string>;
  scope: { sys_id: string | null; scope: string | null };
  active?: boolean;
  sdkManaged: "yes" | "no" | "unknown";
  [field: string]: unknown;
}

/**
 * List the records of one artefact type as compact summaries: sys_id, name,
 * natural key, scope, active flag, SDK-managed verdict, applied table and the
 * type's metadata fields. No script bodies.
 */
export async function listArtifacts(
  opts: ListArtifactsOptions,
): Promise<Record<string, unknown>> {
  const t = resolveArtifactType(opts.artifactType);
  // Policy first and outside the degrade path: a denied table always errors.
  assertTableAllowed(t.table);

  const clauses: string[] = [];
  // The base query may carry `^OR`, so it goes first (see listScripts).
  if (t.baseQuery) clauses.push(t.baseQuery);
  if (opts.scope?.trim()) clauses.push(scopeClause(t.scopeField, opts.scope));
  if (opts.active !== undefined) {
    if (!t.activeField) {
      throw new ServiceNowError(
        `Artifact type '${t.type}' has no active flag; drop the 'active' filter.`,
        400,
      );
    }
    clauses.push(`${t.activeField}=${opts.active}`);
  }
  if (opts.query?.trim()) clauses.push(opts.query.trim());
  clauses.push(`ORDERBY${t.nameField}`);

  const described = [
    t.nameField,
    ...t.keyFields,
    t.scopeField,
    ...(t.activeField ? [t.activeField] : []),
    ...(t.appliesToField ? [t.appliesToField] : []),
    ...(t.metaFields ?? []),
  ];
  const fields = [
    ...new Set([
      "sys_id",
      ...described,
      `${t.scopeField}.scope`,
      ...AUDIT_FIELDS,
      // N-12: absent on an instance without domain separation.
      ...DOMAIN_FIELDS,
    ]),
  ];
  const limit = Math.min(opts.limit ?? LIST_LIMIT.default, LIST_LIMIT.max);
  const head = {
    artifactType: t.type,
    table: t.table,
    verified: t.verified,
    ...(t.verified ? {} : { caveat: UNVERIFIED_CAVEAT }),
  };

  let records: SnRecord[];
  let total: number | undefined;
  try {
    ({ records, total } = await queryTable({
      table: t.table,
      query: clauses.join("^"),
      fields,
      displayValue: "false",
      limit,
    }));
  } catch (error) {
    const status = degradeStatus(error);
    if (t.verified || status === undefined) throw error;
    return {
      ...head,
      count: 0,
      artifacts: [],
      degraded: { status, reason: (error as Error).message },
      ...(await availability(t)),
    };
  }

  // One verdict per scope: every row of a scope shares it.
  const verdicts = new Map<string, "yes" | "no" | "unknown">();
  const artifacts: ArtifactSummary[] = [];
  for (const r of records) {
    const scope = rowScope(t, r);
    const cacheKey = `${scope.sys_id ?? ""}|${scope.scope ?? ""}`;
    let managed = verdicts.get(cacheKey);
    if (managed === undefined) {
      managed = (await detectSdkManaged(scope)).managed;
      verdicts.set(cacheKey, managed);
    }
    const summary: ArtifactSummary = {
      sys_id: snString(r.sys_id),
      name: snString(r[t.nameField]),
      key: Object.fromEntries(t.keyFields.map((f) => [f, snString(r[f])])),
      scope,
      sdkManaged: managed,
    };
    if (t.activeField && t.activeField in r) {
      summary.active = snString(r[t.activeField]) === "true";
    }
    for (const f of [
      ...(t.appliesToField ? [t.appliesToField] : []),
      ...(t.metaFields ?? []),
      ...AUDIT_FIELDS,
    ]) {
      if (f in r && !(f in summary)) summary[f] = r[f];
    }
    keepDomainFields(r, summary);
    artifacts.push(summary);
  }

  const missing = missingFields(described, records);
  return {
    ...head,
    count: artifacts.length,
    ...(total !== undefined ? { total } : {}),
    artifacts,
    ...(missing.length ? { missingFields: missing } : {}),
  };
}

/** How `getArtifact` identifies the record: exactly one of the two. */
export interface ArtifactRef {
  sys_id?: string;
  /**
   * The natural key: a plain value when the type has one key field, or an
   * object carrying every key field.
   */
  key?: KeyValue | Record<string, KeyValue>;
}

export interface GetArtifactOptions extends ArtifactRef {
  artifactType: string;
}

/** One child table as returned by `getArtifact`. */
export interface ArtifactChildResult {
  table: string;
  parentField: string;
  parentTable?: string;
  verified: boolean;
  count: number;
  truncated?: boolean;
  records: SnRecord[];
  /** Set when the table policy denies the child table. */
  redacted?: boolean;
  reason?: string;
  /** Set when the instance rejected the child read (status 400 / 403 / 404). */
  error?: string;
  status?: number;
}

/**
 * Read one artefact: the full primary record, its children (per the registry,
 * in order), its application scope and the SDK-managed verdict. Descriptor
 * `secretFields` are always masked, on the record and on its children's rows.
 */
export async function getArtifact(
  opts: GetArtifactOptions,
): Promise<Record<string, unknown>> {
  return getArtifactFor(resolveArtifactType(opts.artifactType), opts);
}

/** Build the encoded key query for `ref.key` against the type's key fields. */
function artifactKeyQuery(t: ArtifactType, key: ArtifactRef["key"]): string {
  let fields: Record<string, KeyValue>;
  if (key !== null && typeof key === "object") {
    const missing = t.keyFields.filter((f) => !(f in key));
    if (missing.length) {
      throw new ServiceNowError(
        `The key for '${t.type}' must carry ${t.keyFields.join(", ")}; missing: ${missing.join(", ")}.`,
        400,
      );
    }
    fields = Object.fromEntries(t.keyFields.map((f) => [f, key[f]!]));
  } else {
    if (t.keyFields.length !== 1) {
      throw new ServiceNowError(
        `Artifact type '${t.type}' has a composite key (${t.keyFields.join(", ")}); pass 'key' as an object.`,
        400,
      );
    }
    fields = { [t.keyFields[0]!]: key as KeyValue };
  }
  const q = keyQuery(fields);
  return t.baseQuery ? `${t.baseQuery}^${q}` : q;
}

/** Mask the descriptor's secret fields on a row, in place. */
function maskSecrets(row: SnRecord, secretFields: readonly string[]): SnRecord {
  for (const f of secretFields) {
    if (f in row && row[f] !== "" && row[f] !== null) row[f] = REDACTED;
  }
  return row;
}

/**
 * How the primary record is read: a sys_id, or an encoded key query. Built
 * before any request so a malformed identifier is a 400, never a degrade.
 */
type PrimaryRead = { sysId: string } | { query: string };

function primaryRead(t: ArtifactType, ref: ArtifactRef): PrimaryRead {
  if (ref.sys_id !== undefined) {
    const id = ref.sys_id.trim();
    if (!/^[0-9a-f]{32}$/i.test(id)) {
      throw new ServiceNowError(`Invalid sys_id '${ref.sys_id}'.`, 400);
    }
    return { sysId: id };
  }
  return { query: artifactKeyQuery(t, ref.key) };
}

/** Read the primary record by sys_id or natural key. */
async function readPrimary(
  t: ArtifactType,
  read: PrimaryRead,
): Promise<SnRecord> {
  if ("sysId" in read) return getRecord(t.table, read.sysId);
  const { records, total } = await queryTable({
    table: t.table,
    query: read.query,
    displayValue: "false",
    limit: 2,
  });
  const matches = Math.max(records.length, total ?? 0);
  if (matches > 1) {
    throw new ServiceNowError(
      `The key matches ${matches} ${t.table} records; it must identify one.`,
      409,
      { matches: records.map((r) => snString(r.sys_id)) },
      {
        code: "AMBIGUOUS_KEY",
        hint: "Add key fields until the key is unique, or read the record by sys_id.",
      },
    );
  }
  const found = records[0];
  if (!found) {
    throw new ServiceNowError(
      matches > 0
        ? `A ${t.table} record matches the key but is not readable by this user.`
        : `No ${t.type} (${t.table}) record matches the key.`,
      404,
    );
  }
  return found;
}

/** Characters that would break out of an encoded-query value. */
const UNSAFE_VALUE = /[\^\r\n]/;

/**
 * Read one child table for the given parent rows: `parentField` matches each
 * row's `parentKey` (sys_id by default), plus the `alsoMatch` pairs taken
 * from the primary record.
 */
async function readChild(
  t: ArtifactType,
  c: ArtifactChild,
  parents: SnRecord[] | undefined,
  primary: SnRecord,
): Promise<ArtifactChildResult> {
  const entry: ArtifactChildResult = {
    table: c.table,
    parentField: c.parentField,
    ...(c.parentTable ? { parentTable: c.parentTable } : {}),
    verified: c.verified ?? t.verified,
    count: 0,
    records: [],
  };
  try {
    assertTableAllowed(c.table);
  } catch (error) {
    return { ...entry, redacted: true, reason: (error as Error).message };
  }
  if (parents === undefined) {
    return {
      ...entry,
      reason: `Parent table ${c.parentTable ?? t.table} was not read.`,
    };
  }
  // Values taken from instance data: never let one widen the query.
  const values = [
    ...new Set(parents.map((r) => snString(r[c.parentKey ?? "sys_id"]))),
  ].filter(
    (v) =>
      v && !UNSAFE_VALUE.test(v) && (parents.length === 1 || !v.includes(",")),
  );
  if (!values.length) return entry;

  const clauses = [
    values.length === 1
      ? `${c.parentField}=${values[0]}`
      : `${c.parentField}IN${values.join(",")}`,
  ];
  for (const m of c.alsoMatch ?? []) {
    const v = snString(primary[m.parentKey]);
    if (UNSAFE_VALUE.test(v)) return entry;
    clauses.push(v ? `${m.field}=${v}` : `${m.field}ISEMPTY`);
  }
  if (c.orderField) clauses.push(`ORDERBY${c.orderField}`);
  try {
    const { records } = await queryTable({
      table: c.table,
      query: clauses.join("^"),
      displayValue: "false",
      limit: CHILD_LIMIT + 1,
    });
    const rows = records.slice(0, CHILD_LIMIT);
    for (const r of rows) maskSecrets(r, t.secretFields);
    return {
      ...entry,
      count: rows.length,
      ...(records.length > CHILD_LIMIT ? { truncated: true } : {}),
      records: rows,
    };
  } catch (error) {
    const status = degradeStatus(error);
    if (status === undefined) throw error;
    return { ...entry, error: (error as Error).message, status };
  }
}

/**
 * `getArtifact` against an explicit descriptor (tests pass descriptors the
 * registry does not hold, e.g. one with `secretFields`).
 */
export async function getArtifactFor(
  t: ArtifactType,
  ref: ArtifactRef,
): Promise<Record<string, unknown>> {
  const hasId = ref.sys_id !== undefined && ref.sys_id !== "";
  const hasKey = ref.key !== undefined && ref.key !== "";
  if (hasId === hasKey) {
    throw new ServiceNowError(
      "Pass exactly one of 'sys_id' or 'key' to identify the artifact.",
      400,
    );
  }
  const read = primaryRead(t, hasId ? { sys_id: ref.sys_id } : ref);
  assertTableAllowed(t.table);
  const head = {
    artifactType: t.type,
    table: t.table,
    verified: t.verified,
    ...(t.verified ? {} : { caveat: UNVERIFIED_CAVEAT }),
  };

  let record: SnRecord;
  try {
    record = await readPrimary(t, read);
  } catch (error) {
    const status = degradeStatus(error);
    if (t.verified || status === undefined) throw error;
    const probe = await availability(t);
    // A 404 is a genuine "not found", unless the table itself is absent.
    if (status === 404 && probe.available !== false) throw error;
    return {
      ...head,
      record: null,
      children: [],
      degraded: { status, reason: (error as Error).message },
      ...probe,
    };
  }
  maskSecrets(record, t.secretFields);

  const sysId = snString(record.sys_id);
  const scopeValue = snString(record[t.scopeField]);
  const verdict = scopeValue
    ? await detectSdkManaged(scopeValue, { lookup: true })
    : null;

  // Parent rows per table: the primary record, then each child as it is read.
  // Two children of the same table (a catalog item's own variables and its
  // variable sets' variables) accumulate, so a nested child covers both.
  const rows = new Map<string, SnRecord[]>([[t.table, [record]]]);
  const children: ArtifactChildResult[] = [];
  for (const c of t.children) {
    const entry = await readChild(
      t,
      c,
      rows.get(c.parentTable ?? t.table),
      record,
    );
    if (!entry.redacted && entry.error === undefined && !entry.reason) {
      rows.set(
        c.table,
        c.table === t.table
          ? entry.records
          : [...(rows.get(c.table) ?? []), ...entry.records],
      );
    }
    children.push(entry);
  }

  const missing = missingFields(
    [
      t.nameField,
      ...t.keyFields,
      t.scopeField,
      ...(t.activeField ? [t.activeField] : []),
      ...t.scriptFields,
    ],
    [record],
  );
  return {
    ...head,
    sys_id: sysId,
    name: snString(record[t.nameField]),
    key: Object.fromEntries(t.keyFields.map((f) => [f, snString(record[f])])),
    scope: {
      sys_id: verdict?.sysId ?? (scopeValue || null),
      scope: verdict?.scope ?? null,
    },
    sdkManaged: verdict
      ? {
          managed: verdict.managed,
          unverified: verdict.unverified,
          evidence: verdict.evidence,
          ...(verdict.warnings.length ? { warnings: verdict.warnings } : {}),
        }
      : { managed: "unknown", unverified: false, evidence: [] },
    record,
    children,
    ...(missing.length ? { missingFields: missing } : {}),
  };
}

/** The static catalogue behind the `servicenow://artifact-types` resource. */
export function artifactTypeCatalog(): Record<string, unknown> {
  return {
    count: ARTIFACT_TYPES.length,
    note: "Types with verified:false have not been confirmed on a live instance (gate O-5); servicenow_list_artifacts / servicenow_get_artifact / servicenow_explain_artifact serve them with a caveat.",
    types: ARTIFACT_TYPES.map((t) => ({
      type: t.type,
      group: t.group,
      table: t.table,
      nameField: t.nameField,
      keyFields: t.keyFields,
      scopeField: t.scopeField,
      ...(t.activeField ? { activeField: t.activeField } : {}),
      ...(t.baseQuery ? { baseQuery: t.baseQuery } : {}),
      children: t.children.map((c) => ({
        table: c.table,
        parentField: c.parentField,
        ...(c.parentTable ? { parentTable: c.parentTable } : {}),
        ...(c.parentKey ? { parentKey: c.parentKey } : {}),
        ...(c.alsoMatch?.length ? { alsoMatch: c.alsoMatch } : {}),
      })),
      sdkApi: t.sdkApi,
      tiers: t.tiers,
      verified: t.verified,
      ...(t.licensed ? { licensed: t.licensed } : {}),
    })),
  };
}
