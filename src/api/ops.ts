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
 * (`sys_email`) and semaphores — plus `check_data_health`, the data-side twin of
 * `servicenow_check_code_health` (duplicates, orphaned and stale references).
 * N-6 (ops v2) adds the views past the instance boundary: failed and slow
 * outbound calls (`sys_outbound_http_log`), slow transactions
 * (`syslog_transaction`) and MID-server health (`ecc_agent` + `ecc_queue`).
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
  "integrations",
  "transactions",
  "mid",
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

/**
 * The table behind each kind (O-5: `sys_semaphore`, `sys_outbound_http_log`,
 * `syslog_transaction` and `ecc_agent` are unverified — verify on a live
 * instance). `mid` also reads `ecc_queue` (OPS_ECC_QUEUE) as its own sub-section.
 */
export const OPS_TABLES = {
  syslog: "syslog",
  jobs: "sys_trigger",
  email_queue: "sys_email",
  semaphores: "sys_semaphore",
  integrations: "sys_outbound_http_log",
  transactions: "syslog_transaction",
  mid: "ecc_agent",
} as const;

/** N-6: the ECC queue behind the `mid` backlog (O-5: verify on a live instance). */
export const OPS_ECC_QUEUE = "ecc_queue";

/** N-6: response time (ms) above which an outbound call or a transaction counts as slow. */
export const SLOW_MS = 5000;

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

// --- read_ops -----------------------------------------------------------------

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

// --- N-6: integrations, transactions, MID ----------------------------------------

/** sys_outbound_http_log fields (O-5: verify on a live instance — the log may be off by default). */
const HTTP_LOG = {
  url: "url",
  method: "http_method",
  status: "response_status",
  ms: "response_time",
  message: "rest_message",
} as const;

/** syslog_transaction fields (O-5: verify on a live instance). */
const TXN = {
  url: "url",
  ms: "response_time",
  user: "sys_created_by",
} as const;

/** ecc_agent fields and ecc_queue fields / state values (O-5: verify on a live instance). */
const AGENT_FIELDS = [
  "sys_id",
  "name",
  "status",
  "version",
  "last_refreshed",
  "host_name",
];
const ECC = {
  agent: "agent",
  ready: "state=ready",
  error: "state=error",
  error_text: "error_string",
} as const;
/** ecc_queue.agent is `mid.server.<ecc_agent.name>`. */
const AGENT_PREFIX = "mid.server.";

/** Groups listed per section, and sample URLs kept per group. */
const TOP_GROUPS = 20;
const SAMPLE_URLS = 3;

/**
 * H-6 rules for a logged URL: no credentials, no query string, no fragment —
 * the same shape as the client's own `safeUrl` (origin + path).
 */
export function redactUrl(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  try {
    const u = new URL(text);
    return clip(`${u.protocol}//${u.host}${u.pathname}`, 300);
  } catch {
    const bare = text.split(/[?#]/)[0] ?? "";
    return clip(bare.replace(/\/\/[^/@]*@/, "//"), 300);
  }
}

const hostOf = (raw: string): string => {
  try {
    return new URL(raw.trim()).host || "(unknown)";
  } catch {
    return "(unknown)";
  }
};

const ms = (r: SnRecord, f: string): number => {
  const n = Number(s(r, f));
  return Number.isFinite(n) ? n : 0;
};

/**
 * O-5 guard: an unknown field in an encoded query is ignored by the instance,
 * which would turn "failed calls" into "every call". Filter fields not yet
 * verified on a live instance are checked against the dictionary first; a
 * missing one fails the section. Returns the fields left unchecked when the
 * dictionary itself is unreadable.
 */
async function requireFields(
  table: string,
  fields: string[],
): Promise<string[]> {
  let columns: ColumnInfo[];
  try {
    columns = await describeTable(table);
  } catch {
    return fields;
  }
  if (columns.length === 0) return fields;
  const known = new Set(columns.map((c) => c.element));
  const missing = fields.filter((f) => !known.has(f));
  if (missing.length) {
    throw new Error(
      `field ${missing.join(", ")} not found in the dictionary (O-5: the field names are unverified on this release).`,
    );
  }
  return [];
}

const unverified = (fields: string[]): Record<string, unknown> =>
  fields.length ? { unverified_fields: fields } : {};

async function readIntegrations(
  o: Resolved,
  rows: boolean,
): Promise<Record<string, unknown>> {
  const table = OPS_TABLES.integrations;
  const unchecked = await requireFields(table, [HTTP_LOG.status, HTTP_LOG.ms]);
  const win = `sys_created_on>${since(o.minutes)}`;
  const failedQ = `${HTTP_LOG.status}>=400`;
  const slowQ = `${HTTP_LOG.ms}>${SLOW_MS}`;
  const [calls, failed, slow] = await Promise.all([
    count(table, win),
    count(table, `${win}^${failedQ}`),
    count(table, `${win}^${slowQ}`),
  ]);
  const out: Record<string, unknown> = {
    calls,
    failed,
    slow,
    slow_ms: SLOW_MS,
    ...unverified(unchecked),
    ...(calls === 0
      ? {
          note: "No outbound calls logged in the window: outbound HTTP logging may be off or its retention short — this is not proof of health.",
        }
      : {}),
  };
  if (!rows) return out;
  const res = await queryTable({
    table,
    query: `${win}^${failedQ}^OR${slowQ}^ORDERBYDESCsys_created_on`,
    fields: ["sys_created_on", ...Object.values(HTTP_LOG)],
    displayValue: "false",
    limit: o.limit,
    noCount: true,
  });
  const groups = new Map<
    string,
    {
      host: string;
      rest_message: string;
      calls: number;
      failed: number;
      slow: number;
      max_ms: number;
      statuses: Record<string, number>;
      urls: Set<string>;
      last_seen: string;
    }
  >();
  for (const r of res.records) {
    const raw = s(r, HTTP_LOG.url);
    const host = hostOf(raw);
    const message = s(r, HTTP_LOG.message);
    const key = `${host}\u0000${message}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        host,
        rest_message: message,
        calls: 0,
        failed: 0,
        slow: 0,
        max_ms: 0,
        statuses: {},
        urls: new Set(),
        last_seen: s(r, "sys_created_on"),
      };
      groups.set(key, g);
    }
    const status = s(r, HTTP_LOG.status) || "(none)";
    const time = ms(r, HTTP_LOG.ms);
    g.calls += 1;
    if (Number(status) >= 400) g.failed += 1;
    if (time > SLOW_MS) g.slow += 1;
    g.max_ms = Math.max(g.max_ms, time);
    g.statuses[status] = (g.statuses[status] ?? 0) + 1;
    if (g.urls.size < SAMPLE_URLS && raw) g.urls.add(redactUrl(raw));
  }
  const sorted = [...groups.values()].sort((a, b) => b.calls - a.calls);
  return {
    ...out,
    rows_read: res.records.length,
    truncated: res.records.length >= o.limit,
    groups: sorted.slice(0, TOP_GROUPS).map(({ urls, ...g }) => ({
      ...g,
      urls: [...urls],
    })),
  };
}

async function readTransactions(
  o: Resolved,
  rows: boolean,
): Promise<Record<string, unknown>> {
  const table = OPS_TABLES.transactions;
  const unchecked = await requireFields(table, [TXN.ms]);
  const slowQ = `sys_created_on>${since(o.minutes)}^${TXN.ms}>${SLOW_MS}`;
  const out: Record<string, unknown> = {
    slow: await count(table, slowQ),
    slow_ms: SLOW_MS,
    ...unverified(unchecked),
  };
  if (!rows) return out;
  const res = await queryTable({
    table,
    query: `${slowQ}^ORDERBYDESC${TXN.ms}`,
    fields: ["sys_created_on", ...Object.values(TXN)],
    displayValue: "false",
    limit: o.limit,
    noCount: true,
  });
  const groups = new Map<
    string,
    { count: number; total: number; max_ms: number; users: Set<string> }
  >();
  for (const r of res.records) {
    // A transaction URL is a path (`/incident.do?sys_id=…`): drop the query.
    const url = clip(s(r, TXN.url).split(/[?#]/)[0] ?? "", 300) || "(empty)";
    const time = ms(r, TXN.ms);
    let g = groups.get(url);
    if (!g) {
      g = { count: 0, total: 0, max_ms: 0, users: new Set() };
      groups.set(url, g);
    }
    g.count += 1;
    g.total += time;
    g.max_ms = Math.max(g.max_ms, time);
    const user = s(r, TXN.user);
    if (user) g.users.add(user);
  }
  return {
    ...out,
    rows_read: res.records.length,
    truncated: res.records.length >= o.limit,
    by_url: [...groups.entries()]
      .map(([url, g]) => ({
        url,
        count: g.count,
        avg_ms: Math.round(g.total / g.count),
        max_ms: g.max_ms,
        users: g.users.size,
      }))
      .sort((a, b) => b.count - a.count || b.max_ms - a.max_ms)
      .slice(0, TOP_GROUPS),
  };
}

/** The `mid` ECC queue sub-section: ready backlog and errors, by agent. */
async function readEccQueue(
  o: Resolved,
  rows: boolean,
): Promise<Record<string, unknown>> {
  const table = OPS_ECC_QUEUE;
  const errorQ = `${ECC.error}^sys_created_on>${since(o.minutes)}`;
  const agentName = (v: string): string =>
    v.startsWith(AGENT_PREFIX) ? v.slice(AGENT_PREFIX.length) : v;
  const [ready, errors] = await Promise.all([
    countBy(table, ECC.ready, ECC.agent),
    countBy(table, errorQ, ECC.agent),
  ]);
  const total = (g: Group[]): number => g.reduce((n, x) => n + x.count, 0);
  const out: Record<string, unknown> = {
    ready: total(ready),
    errors_in_window: total(errors),
    ready_by_agent: tally(ready.slice(0, TOP_GROUPS), ECC.agent, agentName),
    errors_by_agent: tally(errors.slice(0, TOP_GROUPS), ECC.agent, agentName),
  };
  if (!rows) return out;
  const oldest = total(ready)
    ? await queryTable({
        table,
        query: `${ECC.ready}^ORDERBYsys_created_on`,
        fields: ["sys_created_on"],
        displayValue: "false",
        limit: 1,
        noCount: true,
      })
    : undefined;
  const res = await queryTable({
    table,
    query: `${errorQ}^ORDERBYDESCsys_created_on`,
    fields: [
      "sys_id",
      "sys_created_on",
      ECC.agent,
      "queue",
      "topic",
      "name",
      ECC.error_text,
    ],
    displayValue: "false",
    limit: o.limit,
    noCount: true,
  });
  return {
    ...out,
    ...(oldest?.records[0]
      ? { oldest_ready: s(oldest.records[0], "sys_created_on") }
      : {}),
    truncated: res.records.length >= o.limit,
    errors: res.records.map((r) => ({
      sys_id: s(r, "sys_id"),
      created_on: s(r, "sys_created_on"),
      agent: agentName(s(r, ECC.agent)),
      queue: s(r, "queue"),
      topic: s(r, "topic"),
      name: clip(s(r, "name"), 200),
      error: clip(s(r, ECC.error_text)),
    })),
  };
}

/** MID servers (`ecc_agent`) plus the ECC queue, each degrading on its own. */
async function readMid(
  o: Resolved,
  rows: boolean,
): Promise<Record<string, unknown>> {
  const table = OPS_TABLES.mid;
  const queue = section(OPS_ECC_QUEUE, () => readEccQueue(o, rows));
  const byStatus = tally(await countBy(table, "", "status"), "status");
  const out: Record<string, unknown> = { by_status: byStatus };
  if (rows) {
    const res = await queryTable({
      table,
      query: "ORDERBYname",
      fields: AGENT_FIELDS,
      displayValue: "false",
      limit: o.limit,
    });
    out.agents = res.records.map((r) => ({
      sys_id: s(r, "sys_id"),
      name: s(r, "name"),
      status: s(r, "status"),
      version: s(r, "version"),
      last_refreshed: s(r, "last_refreshed"),
      host_name: s(r, "host_name"),
    }));
    out.truncated = (res.total ?? 0) > res.records.length;
  }
  return { ...out, queue: await queue };
}

const READERS: Record<
  Exclude<OpsKind, "overview">,
  (o: Resolved, rows: boolean) => Promise<Record<string, unknown>>
> = {
  syslog: readSyslog,
  jobs: readJobs,
  email_queue: readEmailQueue,
  semaphores: readSemaphores,
  integrations: readIntegrations,
  transactions: readTransactions,
  mid: readMid,
};

const OVERVIEW_N6_CAVEAT = `integrations and transactions count calls and transactions over ${SLOW_MS} ms (and outbound status >= 400); mid counts MID servers by status and the ecc_queue backlog. Their field names are unverified (O-5).`;

/** Per-kind caveats added to the shared ones (N-6). */
const KIND_CAVEATS: Partial<Record<OpsKind, string>> = {
  integrations: `Outbound calls are read from sys_outbound_http_log (failed: status >= 400, slow: over ${SLOW_MS} ms); groups come from the newest \`limit\` matching rows; URLs keep only origin and path. Field names are unverified (O-5).`,
  transactions: `Slow transactions (over ${SLOW_MS} ms) are read from syslog_transaction, slowest first; groups come from those \`limit\` rows. Field names are unverified (O-5).`,
  mid: "MID status comes from ecc_agent; the backlog and errors from ecc_queue (state ready / error). Field and state names are unverified (O-5).",
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
      caveats: [...OPS_CAVEATS, OVERVIEW_N6_CAVEAT],
    };
  }
  const kind = args.kind;
  const result = await section(OPS_TABLES[kind], () => READERS[kind](o, true));
  const extra = KIND_CAVEATS[kind];
  return {
    kind,
    window_minutes: o.minutes,
    ...result,
    table: OPS_TABLES[kind],
    caveats: extra ? [...OPS_CAVEATS, extra] : OPS_CAVEATS,
  };
}

// --- check_data_health --------------------------------------------------------------

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
      "The check_data_health query cannot contain ^NQ or ORDERBY (it is ANDed with each check).",
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
