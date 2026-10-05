import { ServiceNowError } from "../core/errors.js";
import { getRecordHistory, type HistoryEntry } from "./history.js";
import { unreadableReason } from "./security.js";
import { mdEscape, mdTable, snString } from "./shared.js";
import { queryTable, type SnRecord } from "./table.js";

/**
 * N-5 (NX-05) — task context: what one task record is waiting for.
 *
 * For one `task` descendant (incident, change_request, sc_req_item, ...)
 * the context lists:
 *
 * - the task itself and its assignment (assignment_group, assigned_to,
 *   state);
 * - its approvals: sysapproval_approver rows whose `sysapproval` is the task
 *   (approver, approval group, state, created, due);
 * - its task SLAs: task_sla rows (SLA definition, stage, has_breached,
 *   planned_end_time, business elapsed percentage and business time left);
 * - optionally a bounded history: the newest sys_journal_field entries
 *   (comments, work notes) through the S-10 reader, without sys_audit.
 *
 * `pendingApprovals` is the "pending for an approver" view: the requested
 * approvals of one user (sys_id or user_name), oldest due date first.
 *
 * Not wired to a tool yet: `servicenow_get_task_context` (opt-in `history`
 * package) grows tools/list (O-10).
 *
 * Read-only and bounded; never throws except on a cancel. The task read is
 * required: when it fails or finds nothing the context is
 * `available:false`. Each other section that fails degrades on its own to
 * `available:false` with a reason. Table, field and choice names
 * (sysapproval_approver sysapproval / group / due_date, task_sla stage /
 * business_percentage / business_time_left) are unverified until O-5 (PDI).
 */

/** Approval rows read per task. */
export const APPROVAL_LIMIT = 100;
/** Task SLA rows read per task. */
export const SLA_LIMIT = 50;
/** Journal entries read when `history` is asked for. */
export const HISTORY_LIMIT = 20;
/** Default and maximum rows of the pending-approvals view. */
export const PENDING_DEFAULT_LIMIT = 50;
export const PENDING_MAX_LIMIT = 200;
/** Journal entry text is cut to this many characters. */
const HISTORY_VALUE_CHARS = 500;

const SYS_ID_RE = /^[0-9a-f]{32}$/;
/** A task number or user name: no encoded-query separators or spaces. */
const TOKEN_RE = /^[\w.@-]{1,100}$/;
/** A table name. */
const TABLE_RE = /^[a-z][a-z0-9_]{0,79}$/;

export interface Unavailable {
  available: false;
  unavailableReason: string;
}

export interface TaskRef {
  sys_id: string;
  number: string;
  table: string;
  shortDescription: string;
  state: string;
  priority: string;
  assignmentGroup: string;
  assignedTo: string;
  approval: string;
}

export interface ApprovalRow {
  sys_id: string;
  approver: string;
  /** The approval group (sysapproval_group) the row belongs to, if any. */
  group: string;
  state: string;
  created: string;
  due: string;
}

export interface SlaRow {
  sys_id: string;
  definition: string;
  stage: string;
  breached: boolean;
  active: boolean;
  plannedEnd: string;
  /** Business elapsed percentage, as the instance gives it. */
  businessPercentage: string;
  businessTimeLeft: string;
}

export type Section<T> =
  | { available: true; rows: T[]; truncated: boolean }
  | Unavailable;

export interface TaskContext {
  available: true;
  task: TaskRef;
  approvals: Section<ApprovalRow> & { byState?: Record<string, number> };
  slas: Section<SlaRow> & { breached?: number };
  history?: Section<HistoryEntry>;
}

export interface PendingApproval {
  sys_id: string;
  task: string;
  taskTable: string;
  shortDescription: string;
  group: string;
  created: string;
  due: string;
}

export interface PendingApprovals {
  available: true;
  approver: string;
  rows: PendingApproval[];
  truncated: boolean;
}

export interface TaskContextOptions {
  /** The task table (default `task`, which finds every descendant). */
  table?: string;
  sysId?: string;
  number?: string;
  /** Add the newest journal entries. */
  history?: boolean;
}

const isCancel = (e: unknown): boolean =>
  e instanceof ServiceNowError && e.code === "CANCELLED";

function unavailable(reason: string): Unavailable {
  return { available: false, unavailableReason: reason };
}

/** The display value of a `displayValue=all` field, else its raw value. */
export function display(value: unknown): string {
  if (typeof value === "object" && value !== null && "display_value" in value) {
    const d = (value as { display_value?: unknown }).display_value;
    if (typeof d === "string" || typeof d === "number") return String(d);
  }
  return snString(value);
}

function truthy(value: unknown): boolean {
  return snString(value) === "true";
}

function taskRef(r: SnRecord, fallbackTable: string): TaskRef {
  return {
    sys_id: snString(r.sys_id),
    number: display(r.number),
    table: snString(r.sys_class_name) || fallbackTable,
    shortDescription: display(r.short_description),
    state: display(r.state),
    priority: display(r.priority),
    assignmentGroup: display(r.assignment_group),
    assignedTo: display(r.assigned_to),
    approval: display(r.approval),
  };
}

async function readTask(
  table: string,
  key: { sysId?: string; number?: string },
): Promise<TaskRef | Unavailable> {
  const query = key.sysId
    ? `sys_id=${key.sysId}`
    : `number=${key.number}^ORDERBYDESCsys_created_on`;
  try {
    const { records } = await queryTable({
      table,
      query,
      fields: [
        "sys_id",
        "number",
        "sys_class_name",
        "short_description",
        "state",
        "priority",
        "assignment_group",
        "assigned_to",
        "approval",
      ],
      displayValue: "all",
      limit: 1,
    });
    const r = records[0];
    if (!r) {
      return unavailable(
        `No ${table} record with ${key.sysId ? `sys_id ${key.sysId}` : `number ${key.number}`}.`,
      );
    }
    return taskRef(r, table);
  } catch (e) {
    if (isCancel(e)) throw e;
    return unavailable(unreadableReason(table, e));
  }
}

/** Count rows per state label, in first-seen order. */
export function countByState(
  rows: readonly { state: string }[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = r.state || "(empty)";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

async function readApprovals(task: string): Promise<TaskContext["approvals"]> {
  try {
    const { records } = await queryTable({
      table: "sysapproval_approver",
      query: `sysapproval=${task}^ORDERBYsys_created_on`,
      fields: [
        "sys_id",
        "approver",
        "group",
        "state",
        "sys_created_on",
        "due_date",
      ],
      displayValue: "all",
      limit: APPROVAL_LIMIT,
    });
    const rows = records.map(
      (r): ApprovalRow => ({
        sys_id: snString(r.sys_id),
        approver: display(r.approver),
        group: display(r.group),
        state: display(r.state),
        created: snString(r.sys_created_on),
        due: snString(r.due_date),
      }),
    );
    return {
      available: true,
      rows,
      truncated: records.length >= APPROVAL_LIMIT,
      byState: countByState(rows),
    };
  } catch (e) {
    if (isCancel(e)) throw e;
    return unavailable(unreadableReason("sysapproval_approver", e));
  }
}

async function readSlas(task: string): Promise<TaskContext["slas"]> {
  try {
    const { records } = await queryTable({
      table: "task_sla",
      query: `task=${task}^ORDERBYstart_time`,
      fields: [
        "sys_id",
        "sla",
        "stage",
        "has_breached",
        "active",
        "planned_end_time",
        "business_percentage",
        "business_time_left",
      ],
      displayValue: "all",
      limit: SLA_LIMIT,
    });
    const rows = records.map(
      (r): SlaRow => ({
        sys_id: snString(r.sys_id),
        definition: display(r.sla),
        stage: display(r.stage),
        breached: truthy(r.has_breached),
        active: truthy(r.active),
        plannedEnd: snString(r.planned_end_time),
        businessPercentage: snString(r.business_percentage),
        businessTimeLeft: display(r.business_time_left),
      }),
    );
    return {
      available: true,
      rows,
      truncated: records.length >= SLA_LIMIT,
      breached: rows.filter((s) => s.breached).length,
    };
  } catch (e) {
    if (isCancel(e)) throw e;
    return unavailable(unreadableReason("task_sla", e));
  }
}

async function readHistory(
  table: string,
  sysId: string,
): Promise<Section<HistoryEntry>> {
  try {
    const h = await getRecordHistory({
      table,
      sysId,
      source: "journal",
      limit: HISTORY_LIMIT,
      valueMaxChars: HISTORY_VALUE_CHARS,
    });
    const sources = h.sources as Record<
      string,
      { read: boolean; reason?: string }
    >;
    const journal = sources.journal;
    if (journal && !journal.read) {
      return unavailable(
        `sys_journal_field could not be read: ${journal.reason ?? "unknown reason"}`,
      );
    }
    const rows = h.entries as HistoryEntry[];
    return {
      available: true,
      rows,
      truncated: rows.length >= HISTORY_LIMIT,
    };
  } catch (e) {
    if (isCancel(e)) throw e;
    return unavailable(unreadableReason("sys_journal_field", e));
  }
}

/** Approvals, SLAs, assignment and (optionally) journal history of one task. */
export async function taskContext(
  opts: TaskContextOptions,
): Promise<TaskContext | Unavailable> {
  const table = opts.table?.trim() || "task";
  if (!TABLE_RE.test(table)) {
    return unavailable(`"${table}" is not a table name.`);
  }
  const sysId = opts.sysId?.trim();
  const number = opts.number?.trim();
  if (sysId) {
    if (!SYS_ID_RE.test(sysId)) {
      return unavailable(`"${sysId}" is not a sys_id.`);
    }
  } else if (number) {
    if (!TOKEN_RE.test(number)) {
      return unavailable(`"${number}" is not a task number.`);
    }
  } else {
    return unavailable("Give the task's sys_id or number.");
  }

  const task = await readTask(table, sysId ? { sysId } : { number });
  if (!("sys_id" in task)) return task;

  const [approvals, slas, history] = await Promise.all([
    readApprovals(task.sys_id),
    readSlas(task.sys_id),
    opts.history ? readHistory(task.table, task.sys_id) : undefined,
  ]);
  return {
    available: true,
    task,
    approvals,
    slas,
    ...(history ? { history } : {}),
  };
}

/** The requested approvals waiting on one approver (sys_id or user_name). */
export async function pendingApprovals({
  approver,
  limit = PENDING_DEFAULT_LIMIT,
}: {
  approver: string;
  limit?: number;
}): Promise<PendingApprovals | Unavailable> {
  const who = approver.trim();
  if (!TOKEN_RE.test(who)) {
    return unavailable(`"${approver}" is not a user sys_id or user_name.`);
  }
  const cap = Math.max(1, Math.min(Math.floor(limit) || 1, PENDING_MAX_LIMIT));
  const match = SYS_ID_RE.test(who)
    ? `approver=${who}`
    : `approver.user_name=${who}`;
  try {
    const { records } = await queryTable({
      table: "sysapproval_approver",
      query: `${match}^state=requested^ORDERBYdue_date`,
      fields: [
        "sys_id",
        "sysapproval",
        "sysapproval.sys_class_name",
        "sysapproval.short_description",
        "group",
        "sys_created_on",
        "due_date",
      ],
      displayValue: "all",
      limit: cap,
    });
    return {
      available: true,
      approver: who,
      rows: records.map((r) => ({
        sys_id: snString(r.sys_id),
        task: display(r.sysapproval),
        taskTable: snString(r["sysapproval.sys_class_name"]),
        shortDescription: display(r["sysapproval.short_description"]),
        group: display(r.group),
        created: snString(r.sys_created_on),
        due: snString(r.due_date),
      })),
      truncated: records.length >= cap,
    };
  } catch (e) {
    if (isCancel(e)) throw e;
    return unavailable(unreadableReason("sysapproval_approver", e));
  }
}

const UNVERIFIED =
  "_Table, field and choice names (sysapproval_approver, task_sla) are unverified until O-5 (PDI)._";

function sectionHead<T>(
  title: string,
  s: Section<T>,
  noun: string,
  limit: number,
): string[] {
  const out = [`### ${title}`, ""];
  if (!s.available) return [...out, `Unavailable: ${s.unavailableReason}`, ""];
  if (s.rows.length === 0) return [...out, `_No ${noun}._`, ""];
  return out.concat(
    s.truncated ? [`_Only the first ${limit} ${noun} are shown._`, ""] : [],
  );
}

/** Markdown for one task context (the future `servicenow_get_task_context`). */
export function taskContextMarkdown(ctx: TaskContext | Unavailable): string[] {
  if (!ctx.available) return [`Unavailable: ${ctx.unavailableReason}`];
  const t = ctx.task;
  const out = [
    `## ${mdEscape(t.number || t.sys_id)} (${mdEscape(t.table)})${t.shortDescription ? ` — ${mdEscape(t.shortDescription)}` : ""}`,
    "",
    `- **State:** ${mdEscape(t.state) || "—"}${t.approval ? ` · **Approval:** ${mdEscape(t.approval)}` : ""}${t.priority ? ` · **Priority:** ${mdEscape(t.priority)}` : ""}`,
    `- **Assignment group:** ${mdEscape(t.assignmentGroup) || "—"} · **Assigned to:** ${mdEscape(t.assignedTo) || "—"}`,
    "",
  ];

  const a = ctx.approvals;
  out.push(...sectionHead("Approvals", a, "approvals", APPROVAL_LIMIT));
  if (a.available && a.rows.length) {
    const counts = Object.entries(a.byState ?? countByState(a.rows))
      .map(([k, n]) => `${n} ${k}`)
      .join(", ");
    out.push(
      `${a.rows.length} approval(s): ${mdEscape(counts)}.`,
      "",
      mdTable(
        ["Approver", "Group", "State", "Created", "Due"],
        a.rows.map((r) => [r.approver, r.group, r.state, r.created, r.due]),
      ),
      "",
    );
  }

  const s = ctx.slas;
  out.push(...sectionHead("Task SLAs", s, "task SLAs", SLA_LIMIT));
  if (s.available && s.rows.length) {
    const breached = s.breached ?? s.rows.filter((r) => r.breached).length;
    out.push(
      `${s.rows.length} task SLA(s), ${breached} breached.`,
      "",
      mdTable(
        [
          "SLA",
          "Stage",
          "Breached",
          "Planned end",
          "Business elapsed %",
          "Business time left",
        ],
        s.rows.map((r) => [
          r.definition,
          r.stage,
          r.breached ? "**yes**" : "no",
          r.plannedEnd,
          r.businessPercentage,
          r.businessTimeLeft,
        ]),
      ),
      "",
    );
  }

  const h = ctx.history;
  if (h) {
    out.push(...sectionHead("Journal", h, "journal entries", HISTORY_LIMIT));
    if (h.available && h.rows.length) {
      out.push(
        mdTable(
          ["Created", "By", "Field", "Entry"],
          h.rows.map((e) => [
            e.created_on,
            e.user,
            e.field,
            `${e.new_value.replace(/\s+/g, " ")}${e.truncated ? " …" : ""}`,
          ]),
        ),
        "",
      );
    }
  }
  return [...out, UNVERIFIED];
}

/** Markdown for the pending-approvals view. */
export function pendingApprovalsMarkdown(
  p: PendingApprovals | Unavailable,
): string[] {
  if (!p.available) return [`Unavailable: ${p.unavailableReason}`];
  if (p.rows.length === 0) {
    return [
      `_No requested approvals for ${mdEscape(p.approver)}._`,
      "",
      UNVERIFIED,
    ];
  }
  return [
    `${p.rows.length} requested approval(s) for ${mdEscape(p.approver)}${p.truncated ? " (first rows only — truncated)" : ""}, oldest due first.`,
    "",
    mdTable(
      ["Task", "Table", "Short description", "Group", "Created", "Due"],
      p.rows.map((r) => [
        r.task,
        r.taskTable,
        r.shortDescription,
        r.group,
        r.created,
        r.due,
      ]),
    ),
    "",
    UNVERIFIED,
  ];
}
