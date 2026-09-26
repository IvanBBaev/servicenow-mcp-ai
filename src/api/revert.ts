import {
  getRecord,
  createRecord,
  updateRecord,
  deleteRecord,
  type SnRecord,
} from "./table.js";
import { ServiceNowError } from "../core/errors.js";
import { REDACTED } from "../core/redaction.js";
import { assertValidProfileName } from "../core/config.js";
import {
  assertPackageAllowed,
  assertPackageWriteAllowed,
} from "../core/policy.js";
import {
  journaledWrite,
  readWriteJournal,
  resultModCount,
  type JournalEntry,
  type WriteAction,
  type WriteResult,
} from "../core/write-journal.js";

/**
 * S-2 — journal-based revert. Builds the inverse of one applied write from its
 * journal line (update → write `before` back, create → delete, delete →
 * re-create from `before`), checks the record has not moved on since, and runs
 * the inverse through the Table API as a journaled write of its own
 * (`reverts: <entry id>`). The MCP tools in tools/revert.ts are thin specs over
 * this module.
 */

/** The tool name the revert's own journal lines are stamped with. */
export const REVERT_TOOL = "servicenow_revert_write";

/** Inverse writes run through the Table API, so its package axis applies too. */
const TABLE_PACKAGE = "table";

/** Tools whose journal lines can be inverted, and the package each belongs to. */
const REVERTIBLE_TOOLS: Record<string, string> = {
  servicenow_create_record: "table",
  servicenow_update_record: "table",
  servicenow_upsert_record: "table",
  servicenow_delete_record: "table",
  servicenow_create_change: "change",
  servicenow_update_change: "change",
  servicenow_update_ci: "cmdb",
  servicenow_set_property: "properties",
  [REVERT_TOOL]: "revert",
};

/** Why the journal lines of other write tools cannot be inverted. */
const NOT_REVERTIBLE_TOOLS: Record<string, string> = {
  servicenow_create_ci:
    "a CI create runs through Identification & Reconciliation, which may have matched an existing CI; deleting it could remove a CI this write did not create",
  servicenow_upload_attachment:
    "attachment content is not journaled and the line names the parent record, not the attachment",
  servicenow_delete_attachment:
    "attachment content is not journaled, so a deleted attachment cannot be re-created",
  servicenow_send_email: "a sent email cannot be unsent",
  servicenow_insert_import_set_row:
    "the transform map already ran; its target-table effects are not journaled",
  servicenow_order_catalog_item:
    "the order started fulfilment (request, items, approvals, flows); cancel it in the instance instead",
  servicenow_identify_reconcile:
    "IRE decided per item whether to insert or update; the per-CI effects are not journaled",
  servicenow_batch:
    "Batch API sub-requests are journaled for audit only; revert them one record at a time",
};

/** Tables whose un-stamped (pre-S-2) lines came from non-invertible tools. */
const LEGACY_UNSAFE_TABLES = new Set(["sys_attachment", "email"]);

/** System fields a re-create must not send back (the instance owns them). */
const SYSTEM_FIELDS = new Set([
  "sys_created_by",
  "sys_created_on",
  "sys_updated_by",
  "sys_updated_on",
  "sys_mod_count",
  "sys_tags",
]);

type Scalar = string | number | boolean | null;

function notRevertible(entryId: string, reason: string): ServiceNowError {
  return new ServiceNowError(
    `Journal entry ${entryId} is not revertible: ${reason}.`,
    409,
    undefined,
    { code: "NOT_REVERTIBLE" },
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** A field value as sent to the Table API: `{ value, display_value }` / `{ link, value }` unwrapped. */
function unwrap(v: unknown): Scalar | undefined {
  const raw = isRecord(v) && "value" in v ? v.value : v;
  if (raw === null) return null;
  return typeof raw === "string" ||
    typeof raw === "number" ||
    typeof raw === "boolean"
    ? raw
    : undefined;
}

function isRedacted(v: unknown): boolean {
  return typeof v === "string" && v.includes(REDACTED);
}

/** Field lookup in a captured `before`: flat (Table / Change API) or CMDB `{ attributes }`. */
function beforeField(before: Record<string, unknown>, key: string): unknown {
  if (key in before) return before[key];
  const attrs = before.attributes;
  return isRecord(attrs) && key in attrs ? attrs[key] : undefined;
}

/** Loose equality of a written value and the value the instance returns. */
function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => {
    const u = unwrap(v);
    return u === null || u === undefined ? "" : String(u);
  };
  return norm(a) === norm(b);
}

/** The static half of a revert: what to write, computed from the journal alone. */
export interface RevertSpec {
  entry: JournalEntry;
  /** The inverse write: `update` for an update, `delete` for a create, `create` for a delete. */
  inverse: "create" | "update" | "delete";
  table: string;
  sys_id: string;
  /** Packages whose policy axes the inverse must satisfy. */
  packages: string[];
  /** Field values to write back (update) or the body to re-create (delete). */
  restore?: Record<string, Scalar>;
}

const INVERSE: Record<"create" | "update" | "delete", RevertSpec["inverse"]> = {
  create: "delete",
  update: "update",
  delete: "create",
};

/**
 * Decide from the journal alone whether an entry can be reverted and build its
 * inverse, or throw NOT_REVERTIBLE with the reason. `revertedIds` holds the
 * ids an applied revert already undid.
 */
export function buildRevertSpec(
  entry: JournalEntry,
  revertedIds: ReadonlySet<string>,
): RevertSpec {
  const id = entry.id ?? "(v1 line without id)";
  if (entry.result !== "applied") {
    throw notRevertible(id, `the write was ${entry.result}, nothing to undo`);
  }
  if (
    entry.action !== "create" &&
    entry.action !== "update" &&
    entry.action !== "delete"
  ) {
    throw notRevertible(
      id,
      `"${entry.action}" entries have no inverse (only create, update and delete do)`,
    );
  }
  if (entry.batch_id) {
    throw notRevertible(
      id,
      NOT_REVERTIBLE_TOOLS.servicenow_batch ?? "batch sub-request",
    );
  }
  if (revertedIds.has(id)) {
    throw notRevertible(
      id,
      "it was already reverted (revert the revert's own entry to redo it)",
    );
  }
  let originPackage = TABLE_PACKAGE;
  if (entry.tool) {
    const known = REVERTIBLE_TOOLS[entry.tool];
    if (!known) {
      throw notRevertible(
        id,
        NOT_REVERTIBLE_TOOLS[entry.tool] ??
          `writes by ${entry.tool} have no known inverse`,
      );
    }
    originPackage = known;
  } else if (entry.action === "create") {
    throw notRevertible(
      id,
      "the line predates tool stamping, and an un-stamped create may be an attachment upload, email, import set row or catalog order",
    );
  } else if (LEGACY_UNSAFE_TABLES.has(entry.table)) {
    throw notRevertible(
      id,
      `the line predates tool stamping and ${entry.table} writes cannot be inverted`,
    );
  }
  if (!entry.sys_id) {
    throw notRevertible(id, "the line has no sys_id");
  }
  const packages = [...new Set([originPackage, TABLE_PACKAGE])];
  const base = {
    entry,
    inverse: INVERSE[entry.action],
    table: entry.table,
    sys_id: entry.sys_id,
    packages,
  };
  if (entry.action === "create") return base;

  if (!isRecord(entry.before)) {
    throw notRevertible(
      id,
      "the line has no before state (the pre-write read failed or the entry predates H-5)",
    );
  }
  const before = entry.before;
  const restore: Record<string, Scalar> = {};
  const missing: string[] = [];
  const redacted: string[] = [];
  const keys =
    entry.action === "update"
      ? Object.keys(entry.fields ?? {})
      : Object.keys(before).filter((k) => !SYSTEM_FIELDS.has(k));
  for (const key of keys) {
    const raw = beforeField(before, key);
    const value = unwrap(raw);
    if (raw === undefined || value === undefined) {
      if (entry.action === "update") missing.push(key);
      continue;
    }
    if (isRedacted(value)) redacted.push(key);
    restore[key] = value;
  }
  if (redacted.length) {
    throw notRevertible(
      id,
      `the before state of ${redacted.join(", ")} was redacted in the journal and cannot be restored (restore it by hand; no partial revert is made)`,
    );
  }
  if (missing.length) {
    throw notRevertible(id, `the before state lacks ${missing.join(", ")}`);
  }
  if (entry.action === "update" && keys.length === 0) {
    throw notRevertible(id, "the update wrote no fields");
  }
  return { ...base, restore };
}

/** The ids of entries an applied revert already undid. */
function revertedIdsOf(entries: JournalEntry[]): Set<string> {
  return new Set(
    entries
      .filter((e) => e.result === "applied" && e.reverts)
      .map((e) => e.reverts as string),
  );
}

/** Result of comparing the record now with the state the journaled write left. */
export interface DriftCheck {
  /** `clean`, `drift` (the record moved on), or `unverified` (nothing to compare). */
  status: "clean" | "drift" | "unverified";
  basis: "sys_mod_count" | "fields" | "none";
  expected_mod_count?: number;
  actual_mod_count?: number;
  /** Fields whose current value differs from what the write left (basis `fields`). */
  changed_fields?: string[];
}

/** The drift baseline: `sys_mod_count` right after the write. */
function baselineModCount(entry: JournalEntry): number | undefined {
  if (entry.after_mod_count !== undefined) return entry.after_mod_count;
  if (entry.action === "update" && isRecord(entry.before)) {
    const attrs = entry.before.attributes;
    const prior =
      resultModCount(entry.before) ??
      (isRecord(attrs) ? resultModCount(attrs) : undefined);
    if (prior !== undefined) return prior + 1;
  }
  return undefined;
}

function checkDrift(entry: JournalEntry, current: SnRecord): DriftCheck {
  const expected = baselineModCount(entry);
  const actual = resultModCount(current);
  if (expected !== undefined && actual !== undefined) {
    return {
      status: expected === actual ? "clean" : "drift",
      basis: "sys_mod_count",
      expected_mod_count: expected,
      actual_mod_count: actual,
    };
  }
  const written = Object.entries(entry.fields ?? {}).filter(
    ([k, v]) => k in current && !isRedacted(v),
  );
  if (written.length === 0) return { status: "unverified", basis: "none" };
  const changed = written
    .filter(([k, v]) => !sameValue(v, current[k]))
    .map(([k]) => k);
  return changed.length
    ? { status: "drift", basis: "fields", changed_fields: changed }
    : { status: "clean", basis: "fields" };
}

function isNotFound(error: unknown): boolean {
  return error instanceof ServiceNowError && error.status === 404;
}

/** A revert ready to preview or apply. */
export interface RevertPlan extends RevertSpec {
  /** The record now (create/update origin); absent when it must be re-created. */
  current?: SnRecord;
  drift: DriftCheck;
}

/**
 * Plan the revert of one entry of the active profile's journal: find it,
 * build its inverse and read the record's current state for the drift check.
 * Nothing is written.
 */
export async function planRevert(entryId: string): Promise<RevertPlan> {
  const journal = readWriteJournal();
  const entry = journal.entries.find((e) => e.id === entryId);
  if (!entry) {
    throw notRevertible(
      entryId,
      "no entry with this id in the active profile's write journal",
    );
  }
  if (journal.integrity !== "ok") {
    throw notRevertible(
      entryId,
      `the journal hash chain is ${journal.integrity}; its lines cannot be trusted as a revert source`,
    );
  }
  const spec = buildRevertSpec(entry, revertedIdsOf(journal.entries));

  if (spec.inverse === "create") {
    try {
      await getRecord(spec.table, spec.sys_id, ["sys_id"]);
    } catch (error) {
      if (isNotFound(error)) {
        return { ...spec, drift: { status: "clean", basis: "none" } };
      }
      throw error;
    }
    throw notRevertible(
      entryId,
      `${spec.table}/${spec.sys_id} exists again, so the deleted record cannot be re-created`,
    );
  }

  let current: SnRecord;
  try {
    current = await getRecord(
      spec.table,
      spec.sys_id,
      spec.inverse === "update"
        ? [...Object.keys(spec.restore ?? {}), "sys_mod_count"]
        : undefined,
    );
  } catch (error) {
    if (isNotFound(error)) {
      throw notRevertible(
        entryId,
        `${spec.table}/${spec.sys_id} no longer exists`,
      );
    }
    throw error;
  }
  return { ...spec, current, drift: checkDrift(entry, current) };
}

/** Outcome of an applied revert. */
export interface RevertOutcome {
  reverted: string;
  inverse: RevertSpec["inverse"];
  table: string;
  sys_id: string;
  drift: DriftCheck;
  forced: boolean;
  /** For a re-created record: whether the instance kept the original sys_id. */
  sys_id_preserved?: boolean;
  result: unknown;
}

/**
 * Apply a planned revert as a journaled write (`reverts: <entry id>`). Refuses
 * with STALE_RECORD when the record drifted (or drift could not be verified)
 * unless `force`. Package axes are enforced for the origin package and the
 * Table API; SN_READONLY and the table allow/deny lists by the Table API calls.
 */
export async function applyRevert(
  plan: RevertPlan,
  force = false,
): Promise<RevertOutcome> {
  const entryId = plan.entry.id ?? "";
  for (const pkg of plan.packages) {
    assertPackageAllowed(pkg);
    assertPackageWriteAllowed(pkg, plan.inverse);
  }
  if (plan.drift.status !== "clean" && !force) {
    throw new ServiceNowError(
      plan.drift.status === "drift"
        ? `${plan.table}/${plan.sys_id} changed after journal entry ${entryId}; reverting would overwrite that change.`
        : `Cannot verify that ${plan.table}/${plan.sys_id} is unchanged since journal entry ${entryId} (no sys_mod_count baseline and no comparable field).`,
      409,
      { drift: plan.drift },
      {
        code: "STALE_RECORD",
        hint: "Review the record, then re-run with force:true to revert anyway.",
      },
    );
  }
  const common = {
    table: plan.table,
    reverts: entryId,
    tool: REVERT_TOOL,
    ...(force ? { force: true } : {}),
  };
  const outcome = {
    reverted: entryId,
    inverse: plan.inverse,
    table: plan.table,
    sys_id: plan.sys_id,
    drift: plan.drift,
    forced: force,
  };

  if (plan.inverse === "update") {
    const restore = plan.restore ?? {};
    const before = Object.fromEntries(
      Object.keys(restore).map((k) => [k, plan.current?.[k]]),
    );
    const result = await journaledWrite(
      {
        ...common,
        action: "update",
        sys_id: plan.sys_id,
        fields: restore,
        before,
      },
      () => updateRecord(plan.table, plan.sys_id, restore),
      (r) => ({ after_mod_count: resultModCount(r) }),
    );
    return { ...outcome, result };
  }
  if (plan.inverse === "delete") {
    const result = await journaledWrite(
      {
        ...common,
        action: "delete",
        sys_id: plan.sys_id,
        before: plan.current,
      },
      () => deleteRecord(plan.table, plan.sys_id),
    );
    return { ...outcome, result };
  }
  const body = { ...plan.restore, sys_id: plan.sys_id };
  const result = await journaledWrite(
    { ...common, action: "create", fields: body },
    () => createRecord(plan.table, body),
    (r) => ({
      sys_id: typeof r.sys_id === "string" ? r.sys_id : undefined,
      after_mod_count: resultModCount(r),
    }),
  );
  const sysId = typeof result.sys_id === "string" ? result.sys_id : undefined;
  return {
    ...outcome,
    sys_id: sysId ?? plan.sys_id,
    sys_id_preserved: sysId === plan.sys_id,
    result,
  };
}

/** Filters of `listWrites`. */
export interface ListWritesOptions {
  profile?: string;
  table?: string;
  /** ISO date/time; entries at or after it. */
  since?: string;
  result?: WriteResult;
  action?: WriteAction;
  limit?: number;
  /** Return the full journal lines instead of the summary. */
  verbose?: boolean;
}

/** One `listWrites` row: a journal line summary plus its static revertibility. */
export interface WriteSummary {
  id?: string;
  ts: string;
  action: WriteAction;
  table: string;
  sys_id?: string;
  result?: WriteResult;
  tool?: string;
  reverts?: string;
  batch_id?: string;
  fields?: string[];
  has_before: boolean;
  /**
   * Whether the journal line alone allows a revert; the record's current state
   * (drift, existence) is only checked by `servicenow_revert_write`.
   */
  revertible: boolean;
  reason?: string;
}

/**
 * Read a profile's write journal, newest first, filtered — the discovery side
 * of S-2 (entry ids to pass to the revert).
 */
export function listWrites(options: ListWritesOptions = {}): {
  profile?: string;
  integrity: string;
  files: string[];
  total: number;
  returned: number;
  entries: Array<WriteSummary | JournalEntry>;
} {
  if (options.profile) assertValidProfileName(options.profile);
  let since: number | undefined;
  if (options.since) {
    since = Date.parse(options.since);
    if (Number.isNaN(since)) {
      throw new ServiceNowError(
        `Invalid "since": ${options.since} (expected an ISO 8601 date or date-time).`,
        400,
      );
    }
  }
  const journal = readWriteJournal({
    profile: options.profile,
    action: options.action,
  });
  const reverted = revertedIdsOf(journal.entries);
  const table = options.table?.toLowerCase();
  const matches = journal.entries
    .filter(
      (e) =>
        (!table || e.table.toLowerCase() === table) &&
        (!options.result || e.result === options.result) &&
        (since === undefined || Date.parse(e.ts) >= since),
    )
    .reverse();
  const limit = options.limit ?? 50;
  const page = matches.slice(0, limit);
  return {
    ...(options.profile ? { profile: options.profile } : {}),
    integrity: journal.integrity,
    files: journal.files,
    total: matches.length,
    returned: page.length,
    entries: page.map((e) =>
      options.verbose ? e : summarise(e, reverted, journal.integrity),
    ),
  };
}

function summarise(
  e: JournalEntry,
  reverted: ReadonlySet<string>,
  integrity: string,
): WriteSummary {
  let reason: string | undefined;
  if (integrity !== "ok") {
    reason = `the journal hash chain is ${integrity}`;
  } else {
    try {
      buildRevertSpec(e, reverted);
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    ...(e.id ? { id: e.id } : {}),
    ts: e.ts,
    action: e.action,
    table: e.table,
    ...(e.sys_id ? { sys_id: e.sys_id } : {}),
    ...(e.result ? { result: e.result } : {}),
    ...(e.tool ? { tool: e.tool } : {}),
    ...(e.reverts ? { reverts: e.reverts } : {}),
    ...(e.batch_id ? { batch_id: e.batch_id } : {}),
    ...(e.fields ? { fields: Object.keys(e.fields) } : {}),
    has_before: e.before !== undefined,
    revertible: reason === undefined,
    ...(reason ? { reason } : {}),
  };
}
