import { ServiceNowError } from "../core/errors.js";
import { assertTableAllowed } from "../core/policy.js";
import { assertNoCaret, snString } from "./shared.js";
import { queryTable, type SnRecord } from "./table.js";

/**
 * S-10 — record history over `sys_audit` (field changes) and
 * `sys_journal_field` (journal entries: `comments`, `work_notes`, ...).
 *
 * Closes C-5: journal fields read back empty through the Table API because
 * their entries live in `sys_journal_field`, not on the record. Each source is
 * read independently: a source the local policy denies, or one the instance
 * will not let the user read (ACL 403, missing table 404, bad query 400), is
 * reported under `sources` instead of failing the whole read. The subject
 * table itself still goes through the table policy and errors when denied.
 */

export const AUDIT_TABLE = "sys_audit";
export const JOURNAL_TABLE = "sys_journal_field";

const AUDIT_FIELDS = [
  "sys_id",
  "fieldname",
  "oldvalue",
  "newvalue",
  "user",
  "sys_created_on",
  "reason",
  "record_checkpoint",
];
const JOURNAL_FIELDS = [
  "sys_id",
  "element",
  "value",
  "sys_created_by",
  "sys_created_on",
];

const DEGRADE_STATUSES = new Set([400, 403, 404]);

/** `YYYY-MM-DD` with an optional ` HH:MM:SS`. */
const SINCE_RE = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?$/;

export type HistorySource = "all" | "audit" | "journal";

export interface HistoryOptions {
  table: string;
  sysId: string;
  source?: HistorySource;
  /** Only these fields / journal elements. */
  fields?: string[];
  /** Only entries created at or after this instant (`YYYY-MM-DD[ HH:MM:SS]`). */
  since?: string;
  /** Maximum merged entries (default 100, max 1000). */
  limit?: number;
  /** Truncate each value to this many characters (default 2000). */
  valueMaxChars?: number;
}

export interface HistoryEntry {
  source: "audit" | "journal";
  sys_id: string;
  field: string;
  created_on: string;
  user: string;
  /** Audit: the value before the change. */
  old_value?: string;
  /** Audit: the value after; journal: the entry text. */
  new_value: string;
  reason?: string;
  truncated?: boolean;
}

interface SourceReport {
  read: boolean;
  count?: number;
  total?: number;
  status?: number;
  reason?: string;
  policy?: "denied";
  /** Audit rows skipped because the journal read returned the same field. */
  journal_duplicates_skipped?: number;
}

function sinceClause(since: string | undefined): string | undefined {
  if (!since) return undefined;
  const m = SINCE_RE.exec(since.trim());
  if (!m) {
    throw new ServiceNowError(
      `Invalid "since" value "${since}": use YYYY-MM-DD or YYYY-MM-DD HH:MM:SS.`,
      400,
    );
  }
  return `sys_created_on>=javascript:gs.dateGenerate('${m[1]}','${m[2] ?? "00:00:00"}')`;
}

function cap(value: string, max: number): { text: string; truncated: boolean } {
  return value.length > max
    ? { text: value.slice(0, max), truncated: true }
    : { text: value, truncated: false };
}

/** Read one source; a policy denial or an instance 400/403/404 is reported, not thrown. */
async function readSource(
  table: string,
  query: string,
  fields: string[],
  limit: number,
): Promise<{ records: SnRecord[]; report: SourceReport }> {
  try {
    assertTableAllowed(table);
  } catch (error) {
    return {
      records: [],
      report: {
        read: false,
        policy: "denied",
        reason: (error as Error).message,
      },
    };
  }
  try {
    const { records, total } = await queryTable({
      table,
      query,
      fields,
      displayValue: "false",
      limit,
    });
    return {
      records,
      report: {
        read: true,
        count: records.length,
        ...(total === undefined ? {} : { total }),
      },
    };
  } catch (error) {
    const status = error instanceof ServiceNowError ? error.status : undefined;
    if (status === undefined || !DEGRADE_STATUSES.has(status)) throw error;
    return {
      records: [],
      report: { read: false, status, reason: (error as Error).message },
    };
  }
}

/** S-10 — the merged, newest-first change and journal history of one record. */
export async function getRecordHistory(
  opts: HistoryOptions,
): Promise<Record<string, unknown>> {
  assertTableAllowed(opts.table);
  const source = opts.source ?? "all";
  const limit = Math.min(opts.limit ?? 100, 1000);
  const max = opts.valueMaxChars ?? 2000;
  const fields = (opts.fields ?? []).map((f) => f.trim()).filter(Boolean);
  for (const f of fields) assertNoCaret(f, "fields");
  const since = sinceClause(opts.since);
  const fieldIn = fields.length ? fields.join(",") : undefined;

  const sources: Record<string, SourceReport> = {};
  const entries: HistoryEntry[] = [];
  const journalElements = new Set<string>();

  if (source !== "audit") {
    const q = [`name=${opts.table}`, `element_id=${opts.sysId}`];
    if (fieldIn) q.push(`elementIN${fieldIn}`);
    if (since) q.push(since);
    q.push("ORDERBYDESCsys_created_on");
    const { records, report } = await readSource(
      JOURNAL_TABLE,
      q.join("^"),
      JOURNAL_FIELDS,
      limit,
    );
    sources.journal = report;
    for (const r of records) {
      const field = snString(r.element);
      journalElements.add(field);
      const v = cap(snString(r.value), max);
      entries.push({
        source: "journal",
        sys_id: snString(r.sys_id),
        field,
        created_on: snString(r.sys_created_on),
        user: snString(r.sys_created_by),
        new_value: v.text,
        ...(v.truncated ? { truncated: true } : {}),
      });
    }
  }

  if (source !== "journal") {
    const q = [`tablename=${opts.table}`, `documentkey=${opts.sysId}`];
    if (fieldIn) q.push(`fieldnameIN${fieldIn}`);
    if (since) q.push(since);
    q.push("ORDERBYDESCsys_created_on");
    const { records, report } = await readSource(
      AUDIT_TABLE,
      q.join("^"),
      AUDIT_FIELDS,
      limit,
    );
    let duplicates = 0;
    for (const r of records) {
      const field = snString(r.fieldname);
      // Journal fields are audited too; the journal row is the fuller copy.
      if (journalElements.has(field)) {
        duplicates++;
        continue;
      }
      const oldV = cap(snString(r.oldvalue), max);
      const newV = cap(snString(r.newvalue), max);
      const reason = snString(r.reason);
      entries.push({
        source: "audit",
        sys_id: snString(r.sys_id),
        field,
        created_on: snString(r.sys_created_on),
        user: snString(r.user),
        old_value: oldV.text,
        new_value: newV.text,
        ...(reason ? { reason } : {}),
        ...(oldV.truncated || newV.truncated ? { truncated: true } : {}),
      });
    }
    sources.audit = duplicates
      ? { ...report, journal_duplicates_skipped: duplicates }
      : report;
  }

  // ISO-like `YYYY-MM-DD HH:MM:SS` strings sort chronologically as text.
  entries.sort((a, b) =>
    a.created_on < b.created_on ? 1 : a.created_on > b.created_on ? -1 : 0,
  );
  const shown = entries.slice(0, limit);
  const unread = Object.values(sources).some((s) => !s.read);
  return {
    table: opts.table,
    sys_id: opts.sysId,
    count: shown.length,
    truncated: entries.length > shown.length,
    sources,
    entries: shown,
    ...(unread
      ? {
          note: "Some history sources could not be read (see sources); the history shown is partial.",
        }
      : {}),
    ...(shown.length === 0 && !unread
      ? {
          note: "No history found. Auditing may be off for this table (sys_dictionary 'audit'/'no_audit' attributes), and both tables are ACL-filtered.",
        }
      : {}),
  };
}
