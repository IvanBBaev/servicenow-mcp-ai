import { queryTable, type SnRecord } from "./table.js";
import { aggregate } from "./aggregate.js";
import { describeTable, type ColumnInfo } from "./meta.js";
import { snString, assertNoCaret } from "./shared.js";
import { unreadableReason } from "./security.js";
import { ServiceNowError } from "../core/errors.js";

/**
 * S-10b — the opt-in `ops` package: bounded, read-only views of the platform
 * tables an admin opens when "the instance is slow" — the system log
 * (`syslog`), the scheduler queue (`sys_trigger`), the outbound email queue
 * (`sys_email`) and semaphores — plus `data_health`, the data-side twin of
 * `servicenow_code_health` (duplicates, orphaned and stale references).
 *
 * Every section reads its own table and degrades on its own to
 * `available:false` with the reason (ACL, policy, missing table): an
 * unreadable table never fails the call and never reads as "all clear".
 * Counts come from the Aggregate API; row reads are capped and time-windowed.
 */

export const OPS_KINDS = [
  "overview",
  "syslog",
  "jobs",
  "email_queue",
  "semaphores",
] as const;
export type OpsKind = (typeof OPS_KINDS)[number];

/** Minimum syslog severity, most severe first. */
export const SYSLOG_LEVELS = ["error", "warning", "info", "debug"] as const;
export type SyslogLevel = (typeof SYSLOG_LEVELS)[number];

export const JOB_FILTERS = ["overdue", "running", "queued"] as const;
export type JobFilter = (typeof JOB_FILTERS)[number];

export const OPS_LIMIT = { default: 25, max: 200 };
export const WINDOW_MINUTES = { default: 60, max: 1440 };
export const OVERDUE_MINUTES = { default: 5, max: 1440 };

/** The table behind each kind (O-5: `sys_semaphore` is unverified). */
export const OPS_TABLES = {
  syslog: "syslog",
  jobs: "sys_trigger",
  email_queue: "sys_email",
  semaphores: "sys_semaphore",
} as const;

/** syslog.level stored values (O-5: verify on a live instance). */
const LEVEL_VALUE: Record<SyslogLevel, string> = {
  error: "2",
  warning: "1",
  info: "0",
  debug: "-1",
};
const LEVEL_NAME = new Map(
  Object.entries(LEVEL_VALUE).map(([name, value]) => [value, name]),
);

/** sys_trigger.state stored values (O-5: verify on a live instance). */
const JOB_STATE: Record<string, string> = {
  "0": "ready",
  "1": "running",
  "2": "queued",
};

/** Sources listed in a syslog summary. */
const TOP_SOURCES = 10;
/** Cap on one text value (a log message, an email error). */
const TEXT_MAX = 500;

const OPS_CAVEATS = [
  "Time windows are evaluated by the instance (javascript:gs.minutesAgoStart); counts come from the Aggregate API, rows are capped by `limit`.",
  "syslog rows are read without a total count (sysparm_no_count) to keep the query cheap on a large log table.",
];

const s = (r: SnRecord | undefined, f: string): string => snString(r?.[f]);
const clip = (text: string, max = TEXT_MAX): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;
const since = (minutes: number): string =>
  `javascript:gs.minutesAgoStart(${minutes})`;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

export type Section =
  | ({ available: true } & Record<string, unknown>)
  | { available: false; table: string; unavailableReason: string };

/** Run one section's reads; any failure becomes `available:false` with the reason. */
async function section(
  table: string,
  read: () => Promise<Record<string, unknown>>,
): Promise<Section> {
  try {
    return { available: true, ...(await read()) };
  } catch (error) {
    return {
      available: false,
      table,
      unavailableReason: unreadableReason(table, error),
    };
  }
}

interface Group {
  key: Record<string, string>;
  count: number;
}

/** Parse an Aggregate API result (plain or grouped) into count groups. */
function parseGroups(result: unknown): Group[] {
  const rows = Array.isArray(result) ? result : [result];
  const groups: Group[] = [];
  for (const row of rows) {
    if (!isObj(row) || !isObj(row.stats)) continue;
    const count = Number(snString(row.stats.count));
    if (!Number.isFinite(count)) continue;
    const key: Record<string, string> = {};
    const fields = Array.isArray(row.groupby_fields) ? row.groupby_fields : [];
    for (const g of fields) {
      if (isObj(g)) key[snString(g.field)] = snString(g.value);
    }
    groups.push({ key, count });
  }
  return groups.sort((a, b) => b.count - a.count);
}

async function count(table: string, query: string): Promise<number> {
  const groups = parseGroups(await aggregate({ table, query, count: true }));
  return groups[0]?.count ?? 0;
}

async function countBy(
  table: string,
  query: string,
  field: string,
): Promise<Group[]> {
  return parseGroups(
    await aggregate({ table, query, count: true, groupBy: [field] }),
  );
}

/** `{ value → count }` from a one-field grouping, values renamed by `label`. */
function tally(
  groups: Group[],
  field: string,
  label: (v: string) => string = (v) => v,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of groups) {
    const name = label(g.key[field] ?? "") || "(empty)";
    out[name] = (out[name] ?? 0) + g.count;
  }
  return out;
}

// --- ops_read -----------------------------------------------------------------

export interface OpsReadArgs {
  kind: OpsKind;
  minutes?: number;
  level?: SyslogLevel;
  source?: string;
  filter?: JobFilter;
  overdue_minutes?: number;
  limit?: number;
}

interface Resolved {
  minutes: number;
  level: SyslogLevel;
  source?: string;
  filter: JobFilter;
  overdue: number;
  limit: number;
}

function syslogQuery(o: Resolved, withLevel: boolean): string {
  const parts = [`sys_created_on>${since(o.minutes)}`];
  if (withLevel && o.level !== "debug") {
    const levels = SYSLOG_LEVELS.slice(0, SYSLOG_LEVELS.indexOf(o.level) + 1);
    parts.push(`levelIN${levels.map((l) => LEVEL_VALUE[l]).join(",")}`);
  }
  if (o.source) parts.push(`sourceLIKE${o.source}`);
  return parts.join("^");
}

async function readSyslog(
  o: Resolved,
  rows: boolean,
): Promise<Record<string, unknown>> {
  const table = OPS_TABLES.syslog;
  const byLevel = await countBy(table, syslogQuery(o, false), "level");
  const bySource = await countBy(table, syslogQuery(o, true), "source");
  const out: Record<string, unknown> = {
    level: o.level,
    ...(o.source ? { source: o.source } : {}),
    by_level: tally(byLevel, "level", (v) => LEVEL_NAME.get(v) ?? v),
    top_sources: bySource
      .slice(0, TOP_SOURCES)
      .map((g) => ({ source: g.key.source ?? "", count: g.count })),
  };
  if (!rows) return out;
  const res = await queryTable({
    table,
    query: `${syslogQuery(o, true)}^ORDERBYDESCsys_created_on`,
    fields: ["sys_created_on", "level", "source", "message", "sys_created_by"],
    displayValue: "false",
    limit: o.limit,
    noCount: true,
  });
  return {
    ...out,
    count: res.records.length,
    truncated: res.records.length >= o.limit,
    rows: res.records.map((r) => ({
      created_on: s(r, "sys_created_on"),
      level: LEVEL_NAME.get(s(r, "level")) ?? s(r, "level"),
      source: s(r, "source"),
      created_by: s(r, "sys_created_by"),
      message: clip(s(r, "message")),
    })),
  };
}

const JOB_QUERY: Record<JobFilter, (o: Resolved) => string> = {
  overdue: (o) => `state=0^next_action<${since(o.overdue)}^ORDERBYnext_action`,
  running: () => "state=1^ORDERBYsys_updated_on",
  queued: () => "state=2^ORDERBYnext_action",
};

async function readJobs(
  o: Resolved,
  rows: boolean,
): Promise<Record<string, unknown>> {
  const table = OPS_TABLES.jobs;
  const byState = await countBy(table, "", "state");
  const overdue = await count(table, `state=0^next_action<${since(o.overdue)}`);
  const out: Record<string, unknown> = {
    by_state: tally(byState, "state", (v) => JOB_STATE[v] ?? v),
    overdue,
    overdue_minutes: o.overdue,
  };
  if (!rows) return out;
  const res = await queryTable({
    table,
    query: JOB_QUERY[o.filter](o),
    fields: [
      "sys_id",
      "name",
      "state",
      "next_action",
      "claimed_by",
      "system_id",
      "trigger_type",
      "priority",
      "sys_updated_on",
    ],
    displayValue: "false",
    limit: o.limit,
  });
  return {
    ...out,
    filter: o.filter,
    count: res.records.length,
    ...(res.total !== undefined ? { total: res.total } : {}),
    truncated: (res.total ?? 0) > res.records.length,
    rows: res.records.map((r) => ({
      sys_id: s(r, "sys_id"),
      name: s(r, "name"),
      state: JOB_STATE[s(r, "state")] ?? s(r, "state"),
      next_action: s(r, "next_action"),
      claimed_by: s(r, "claimed_by"),
      system_id: s(r, "system_id"),
      trigger_type: s(r, "trigger_type"),
      priority: s(r, "priority"),
      updated_on: s(r, "sys_updated_on"),
    })),
  };
}

async function readEmailQueue(
  o: Resolved,
  rows: boolean,
): Promise<Record<string, unknown>> {
  const table = OPS_TABLES.email_queue;
  const ready = await count(table, "type=send-ready");
  const oldest = ready
    ? await queryTable({
        table,
        query: "type=send-ready^ORDERBYsys_created_on",
        fields: ["sys_created_on"],
        displayValue: "false",
        limit: 1,
        noCount: true,
      })
    : undefined;
  const byType = await countBy(
    table,
    `sys_created_on>${since(o.minutes)}`,
    "type",
  );
  const out: Record<string, unknown> = {
    ready,
    ...(oldest?.records[0]
      ? { oldest_ready: s(oldest.records[0], "sys_created_on") }
      : {}),
    by_type_in_window: tally(byType, "type"),
  };
  if (!rows) return out;
  const res = await queryTable({
    table,
    query: `type=send-failed^sys_created_on>${since(o.minutes)}^ORDERBYDESCsys_created_on`,
    fields: ["sys_id", "sys_created_on", "subject", "error_string"],
    displayValue: "false",
    limit: o.limit,
  });
  return {
    ...out,
    failures: res.records.map((r) => ({
      sys_id: s(r, "sys_id"),
      created_on: s(r, "sys_created_on"),
      subject: clip(s(r, "subject"), 200),
      error: clip(s(r, "error_string")),
    })),
    ...(res.total !== undefined ? { failures_total: res.total } : {}),
    truncated: (res.total ?? 0) > res.records.length,
  };
}

/** Semaphore rows vary by release, so each is returned as its non-empty fields. */
async function readSemaphores(
  o: Resolved,
  rows: boolean,
): Promise<Record<string, unknown>> {
  const table = OPS_TABLES.semaphores;
  if (!rows) return { count: await count(table, "") };
  const res = await queryTable({
    table,
    query: "ORDERBYDESCsys_updated_on",
    displayValue: "false",
    limit: o.limit,
  });
  return {
    count: res.records.length,
    ...(res.total !== undefined ? { total: res.total } : {}),
    truncated: (res.total ?? 0) > res.records.length,
    rows: res.records.map((r) => {
      const row: Record<string, string> = {};
      for (const [k, v] of Object.entries(r).slice(0, 20)) {
        const text = snString(v);
        if (text) row[k] = clip(text, 200);
      }
      return row;
    }),
  };
}

const READERS: Record<
  Exclude<OpsKind, "overview">,
  (o: Resolved, rows: boolean) => Promise<Record<string, unknown>>
> = {
  syslog: readSyslog,
  jobs: readJobs,
  email_queue: readEmailQueue,
  semaphores: readSemaphores,
};

/**
 * One ops view. `overview` runs every section in summary form (counts only);
 * the other kinds add the capped rows of their table.
 */
export async function opsRead(args: OpsReadArgs): Promise<unknown> {
  const source = args.source?.trim();
  if (source) assertNoCaret(source, "source");
  const o: Resolved = {
    minutes: args.minutes ?? WINDOW_MINUTES.default,
    level: args.level ?? "warning",
    ...(source ? { source } : {}),
    filter: args.filter ?? "overdue",
    overdue: args.overdue_minutes ?? OVERDUE_MINUTES.default,
    limit: args.limit ?? OPS_LIMIT.default,
  };
  if (args.kind === "overview") {
    const kinds = Object.keys(READERS) as (keyof typeof READERS)[];
    const sections = await Promise.all(
      kinds.map((k) => section(OPS_TABLES[k], () => READERS[k](o, false))),
    );
    return {
      kind: "overview",
      window_minutes: o.minutes,
      sections: Object.fromEntries(kinds.map((k, i) => [k, sections[i]])),
      caveats: OPS_CAVEATS,
    };
  }
  const kind = args.kind;
  const result = await section(OPS_TABLES[kind], () => READERS[kind](o, true));
  return {
    kind,
    window_minutes: o.minutes,
    ...result,
    table: OPS_TABLES[kind],
    caveats: OPS_CAVEATS,
  };
}

// --- data_health --------------------------------------------------------------

export const DATA_HEALTH_LIMIT = { default: 20, max: 100 };
export const MAX_KEY_FIELDS = 5;
export const MAX_REFERENCE_FIELDS = 20;
/** Reference fields checked when none are named. */
const DEFAULT_REFERENCE_FIELDS = 10;

export interface DataHealthArgs {
  table: string;
  key_fields?: string[];
  reference_fields?: string[];
  query?: string;
  stale?: boolean;
  limit?: number;
}

const DATA_HEALTH_CAVEATS = [
  "Orphans are rows whose reference is set but whose target row is not found through a dot-walked join (<field>.sys_created_onISEMPTY); a target row the connected user cannot read may also count as orphaned.",
  "Stale references point at a row that exists but has active=false; only targets with an `active` column are checked.",
  "Dot-walked counts are joins: narrow a large table with `query`.",
];

const and = (scope: string, cond: string): string =>
  scope ? `${cond}^${scope}` : cond;

async function duplicates(
  table: string,
  scope: string,
  keys: string[],
  columns: Map<string, ColumnInfo>,
  limit: number,
): Promise<Record<string, unknown>> {
  const unknown = keys.filter((k) => !columns.has(k));
  if (unknown.length) {
    return {
      available: false,
      unavailableReason: `Not a column of ${table}: ${unknown.join(", ")}.`,
    };
  }
  const notEmpty = keys.map((k) => `${k}ISNOTEMPTY`).join("^");
  try {
    const groups = parseGroups(
      await aggregate({
        table,
        query: and(scope, notEmpty),
        count: true,
        groupBy: keys,
        having: `count^${keys[0]}^>^1`,
      }),
    ).filter((g) => g.count > 1);
    return {
      available: true,
      key_fields: keys,
      group_count: groups.length,
      extra_rows: groups.reduce((n, g) => n + g.count - 1, 0),
      truncated: groups.length > limit,
      groups: groups.slice(0, limit),
    };
  } catch (error) {
    return {
      available: false,
      unavailableReason: unreadableReason(table, error),
    };
  }
}

async function referenceCheck(
  table: string,
  scope: string,
  column: ColumnInfo,
  stale: boolean,
): Promise<Record<string, unknown>> {
  const field = column.element;
  const target = column.reference ?? "";
  const orphanQuery = and(
    scope,
    `${field}ISNOTEMPTY^${field}.sys_created_onISEMPTY`,
  );
  const entry: Record<string, unknown> = { field, target };
  try {
    entry.orphans = await count(table, orphanQuery);
    entry.orphan_query = orphanQuery;
  } catch (error) {
    return {
      ...entry,
      available: false,
      unavailableReason: unreadableReason(table, error),
    };
  }
  if (stale) {
    try {
      const targetColumns = await describeTable(target);
      if (targetColumns.some((c) => c.element === "active")) {
        const staleQuery = and(scope, `${field}.active=false`);
        entry.stale = await count(table, staleQuery);
        entry.stale_query = staleQuery;
      } else {
        entry.stale_note = `${target} has no active column.`;
      }
    } catch (error) {
      entry.stale_note = unreadableReason(target, error);
    }
  }
  return { available: true, ...entry };
}

/**
 * Data-quality counts for one table: duplicate key groups (Aggregate API
 * grouping with a HAVING count > 1), and per reference field the orphaned and
 * stale references. Field names are checked against the dictionary first — an
 * unknown field in an encoded query is ignored by the instance, which would
 * turn a count into "every row".
 */
export async function dataHealth(args: DataHealthArgs): Promise<unknown> {
  const { table } = args;
  const scope = args.query?.trim() ?? "";
  if (/\^NQ|ORDERBY/.test(scope)) {
    throw new ServiceNowError(
      "The data_health query cannot contain ^NQ or ORDERBY (it is ANDed with each check).",
      400,
    );
  }
  const base = { table, ...(scope ? { query: scope } : {}) };
  let columns: ColumnInfo[];
  try {
    columns = await describeTable(table);
  } catch (error) {
    return {
      ...base,
      available: false,
      unavailableReason: unreadableReason("sys_dictionary", error),
      caveats: DATA_HEALTH_CAVEATS,
    };
  }
  if (columns.length === 0) {
    return {
      ...base,
      available: false,
      unavailableReason: `${table} has no dictionary entries readable by this user (unknown table?).`,
      caveats: DATA_HEALTH_CAVEATS,
    };
  }
  let rowsInScope: number;
  try {
    rowsInScope = await count(table, scope);
  } catch (error) {
    return {
      ...base,
      available: false,
      unavailableReason: unreadableReason(table, error),
      caveats: DATA_HEALTH_CAVEATS,
    };
  }

  const byName = new Map(columns.map((c) => [c.element, c]));
  const isRef = (c: ColumnInfo | undefined): c is ColumnInfo =>
    c?.type === "reference" && Boolean(c.reference);
  const notes: string[] = [];
  let refColumns: ColumnInfo[];
  const invalid: Record<string, unknown>[] = [];
  if (args.reference_fields?.length) {
    refColumns = [];
    for (const f of new Set(args.reference_fields)) {
      const c = byName.get(f);
      if (isRef(c)) refColumns.push(c);
      else
        invalid.push({
          field: f,
          available: false,
          unavailableReason: `${f} is not a reference column of ${table}.`,
        });
    }
  } else {
    const all = columns.filter(
      (c) => isRef(c) && !c.element.startsWith("sys_"),
    );
    refColumns = all.slice(0, DEFAULT_REFERENCE_FIELDS);
    if (all.length > refColumns.length) {
      notes.push(
        `Checked the first ${refColumns.length} of ${all.length} reference fields; name others with reference_fields.`,
      );
    }
  }

  const limit = args.limit ?? DATA_HEALTH_LIMIT.default;
  const [dup, references] = await Promise.all([
    args.key_fields?.length
      ? duplicates(table, scope, [...new Set(args.key_fields)], byName, limit)
      : Promise.resolve(undefined),
    Promise.all(
      refColumns.map((c) =>
        referenceCheck(table, scope, c, args.stale !== false),
      ),
    ),
  ]);

  return {
    ...base,
    available: true,
    rows_in_scope: rowsInScope,
    ...(dup ? { duplicates: dup } : {}),
    references: [...references, ...invalid],
    ...(notes.length ? { notes } : {}),
    caveats: DATA_HEALTH_CAVEATS,
  };
}
