import { snRequest } from "../core/http.js";
import {
  assertTableAllowed,
  assertTableWriteAllowed,
  assertWriteAllowed,
} from "../core/policy.js";
import {
  getMaxRecords,
  includeReferenceLinks,
  MAX_PAGE_SIZE,
} from "../core/settings.js";
import { logger } from "../core/logging.js";
import { ServiceNowError } from "../core/errors.js";
import {
  assertNoCaret,
  expectResult,
  expectResultArray,
  snString,
} from "./shared.js";
import { noteSecretRecords } from "./secret-columns.js";

// Re-exported so existing imports and host/SSRF unit tests keep working.
export { ServiceNowError } from "../core/errors.js";
export { _buildBaseUrl } from "../core/host.js";

export interface QueryOptions {
  table: string;
  query?: string;
  fields?: string[];
  limit?: number;
  offset?: number;
  displayValue?: "true" | "false" | "all";
  /** Page through all matching records (up to SN_MAX_RECORDS) instead of one page. */
  fetchAll?: boolean;
  /**
   * M-3: cancellation for this read (defaults to the tool call's signal in
   * snRequest, so callers rarely pass it).
   */
  signal?: AbortSignal;
  /**
   * M-3: called after every `fetchAll` page with the records fetched so far
   * and the expected total (X-Total-Count bounded by SN_MAX_RECORDS) when
   * known. Not called for a single-page read.
   */
  onProgress?: (fetched: number, total?: number) => void;
  /**
   * S-11: stream a `fetchAll` read page by page. When set, every page (already
   * bounded by SN_MAX_RECORDS, with any cursor-only sys_id stripped) is handed
   * to this callback — awaited before the next request — and NOT accumulated:
   * the result's `records` is empty, so only one page is held in memory. The
   * total, truncation and `filtered` accounting is unchanged. Ignored for a
   * single-page read.
   */
  onPage?: (records: SnRecord[]) => void | Promise<void>;
  /** `sysparm_view` — return the fields of this UI view (e.g. "mobile"). */
  view?: string;
  /** `sysparm_query_category` — the query category (read replica) to run against. */
  queryCategory?: string;
  /** `sysparm_no_count` — skip the COUNT(*) behind X-Total-Count (faster on big tables). */
  noCount?: boolean;
  /** `sysparm_query_no_domain` — query across all domains the user may access. */
  queryNoDomain?: boolean;
  /** `sysparm_suppress_pagination_header` — omit the Link paging header. */
  suppressPaginationHeader?: boolean;
}

/** Options for Table API writes (create / update). */
export interface WriteOptions {
  /**
   * `sysparm_input_display_value` — field values are display values (e.g. a
   * user's name for a reference field, a choice label) that the instance
   * resolves, instead of raw stored values.
   */
  inputDisplayValue?: boolean;
}

export type SnRecord = Record<string, unknown>;

export interface QueryResult {
  records: SnRecord[];
  total?: number;
  /**
   * True when a `fetchAll` read stopped at the SN_MAX_RECORDS cap while the
   * instance still had more matching rows — i.e. the returned set is partial.
   * Consumers that imply completeness (snapshot, compare) must surface this so
   * they never present a truncated read as the whole picture.
   */
  truncated?: boolean;
  /**
   * Why a `fetchAll` read is partial: `"cap"` — it stopped at SN_MAX_RECORDS;
   * `"scan_limit"` — it gave up after scanning FETCH_ALL_SCAN_FACTOR × the cap
   * of row positions because the instance withheld most of them (ACLs).
   */
  truncatedReason?: "cap" | "scan_limit";
  /**
   * Rows the instance counted (X-Total-Count / page window) but did not return
   * — row-level ACLs and security data filters drop rows after paging, so a
   * page can be short while more rows follow (H-8 C-1). Undefined when zero.
   */
  filtered?: number;
}

/**
 * A `fetchAll` read scans at most this many × SN_MAX_RECORDS row positions.
 * Paging advances by the requested window (not by the rows returned), so on a
 * table where ACLs hide almost everything the loop is still bounded.
 */
export const FETCH_ALL_SCAN_FACTOR = 10;

function tablePath(table: string): string {
  return `/api/now/table/${encodeURIComponent(table)}`;
}

function recordPath(table: string, sysId: string): string {
  return `/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}`;
}

/** Fetch a single page of records (and the X-Total-Count when present). */
async function queryPage(
  opts: QueryOptions,
  limit: number,
  offset: number,
): Promise<QueryResult> {
  const params = new URLSearchParams();
  if (opts.query) params.set("sysparm_query", opts.query);
  if (opts.fields?.length) params.set("sysparm_fields", opts.fields.join(","));
  params.set("sysparm_limit", String(limit));
  if (offset) params.set("sysparm_offset", String(offset));
  params.set("sysparm_display_value", opts.displayValue ?? "false");
  if (!includeReferenceLinks()) {
    params.set("sysparm_exclude_reference_link", "true");
  }
  if (opts.view) params.set("sysparm_view", opts.view);
  if (opts.queryCategory) {
    params.set("sysparm_query_category", opts.queryCategory);
  }
  if (opts.noCount) params.set("sysparm_no_count", "true");
  if (opts.queryNoDomain) params.set("sysparm_query_no_domain", "true");
  if (opts.suppressPaginationHeader) {
    params.set("sysparm_suppress_pagination_header", "true");
  }

  const { data, total } = await snRequest<{ result: SnRecord[] }>({
    method: "GET",
    path: tablePath(opts.table),
    params,
    signal: opts.signal,
  });
  const records = expectResultArray(data, "Table API");
  // N-21: every page (fetchAll and onPage streaming included) registers its
  // secret columns before a caller can see it.
  await noteSecretRecords(opts.table, records);
  return { records, total };
}

/**
 * Read records from a table. By default returns a single page of up to `limit`
 * records (default 10). When `fetchAll` is set, pages through every matching
 * record in batches, up to the SN_MAX_RECORDS safety cap. `total` reflects the
 * server's X-Total-Count (all matching rows), when provided.
 *
 * S-8 (C-2): without a caller ORDERBY the read is ordered by sys_id and pages
 * by keyset — each page after the first asks for `sys_id>` the last row seen —
 * so rows inserted or deleted mid-read no longer shift the window and get
 * skipped or repeated. A caller ORDERBY (or a `^NQ` query, which a cursor
 * clause cannot be ANDed onto) keeps offset paging, and so do rows without a
 * sys_id.
 */
export async function queryTable(opts: QueryOptions): Promise<QueryResult> {
  assertTableAllowed(opts.table);
  if (!opts.fetchAll) {
    return queryPage(opts, opts.limit ?? 10, opts.offset ?? 0);
  }

  // Offset paging without ORDERBY is unstable: ServiceNow gives no ordering
  // guarantee, so concurrent writes can skip/duplicate rows across pages.
  const baseQuery = opts.query;
  const ordered = baseQuery?.includes("ORDERBY") ?? false;
  const keyset = !ordered && !baseQuery?.includes("^NQ");
  let addedSysId = false;
  if (!ordered) {
    opts = {
      ...opts,
      query: baseQuery ? `${baseQuery}^ORDERBYsys_id` : "ORDERBYsys_id",
    };
  }
  if (keyset && opts.fields?.length && !opts.fields.includes("sys_id")) {
    // The cursor needs each row's sys_id; it is stripped again below.
    opts = { ...opts, fields: [...opts.fields, "sys_id"] };
    addedSysId = true;
  }

  const pageSize = Math.min(opts.limit ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  const cap = getMaxRecords();
  const scanBudget = cap * FETCH_ALL_SCAN_FACTOR;
  const records: SnRecord[] = [];
  // Rows kept so far — `records.length` unless `onPage` streams them away.
  let fetched = 0;
  const start = opts.offset ?? 0;
  let total: number | undefined;
  let offset = start;
  let scanned = 0;
  let hitCap = false;
  let hitScanLimit = false;
  let exhausted = false;
  let filtered = 0;
  // Total unknown: a short page may be the end or an ACL gap — count the gap
  // only once a later page proves more rows followed it.
  let pendingGap = 0;
  let prevHead = "";
  // Keyset state: the last sys_id read, and how many row positions past it
  // were already scanned without a readable row (fully ACL-hidden windows).
  let cursor: string | undefined;
  let skip = 0;
  const seen = new Set<string>();

  // ServiceNow applies row-level ACLs *after* paging: a page of `want` rows can
  // come back short (even empty) while later pages still hold readable rows.
  // So the window advances by the requested size (offset, or the skip past the
  // cursor), and the loop stops on X-Total-Count, or — without the header — on
  // the first empty page.
  for (;;) {
    const want = Math.min(pageSize, cap - fetched);
    if (want <= 0) {
      hitCap = true; // stopped on the cap, not on an exhausted result set
      break;
    }
    if (scanned >= scanBudget) {
      hitScanLimit = true;
      break;
    }
    const page =
      cursor === undefined
        ? await queryPage(opts, want, offset)
        : await queryPage(
            { ...opts, query: keysetQuery(baseQuery, cursor) },
            want,
            skip,
          );
    // Where this window starts within the rows the page's count covers.
    const pos = cursor === undefined ? offset : skip;
    if (cursor === undefined && total === undefined) total = page.total;
    scanned += want;
    // A server (or proxy) that ignores sysparm_offset repeats the first page;
    // with ORDERBY distinct windows never start on the same row — stop there.
    const head = page.records.length ? JSON.stringify(page.records[0]) : "";
    if (head && head === prevHead) {
      logger.debug("fetchAll: page repeated — offset ignored, stopping", {
        table: opts.table,
        offset,
      });
      break;
    }
    prevHead = head;
    const returned = page.records.length;
    const last = returned ? rowSysId(page.records[returned - 1]) : "";
    if (
      cursor !== undefined &&
      returned &&
      seen.has(rowSysId(page.records[0]))
    ) {
      // The cursor clause was ignored: the window went back over read rows.
      logger.debug("fetchAll: keyset cursor ignored, stopping", {
        table: opts.table,
      });
      break;
    }
    if (keyset) for (const r of page.records) seen.add(rowSysId(r));
    const kept =
      returned > cap - fetched
        ? page.records.slice(0, cap - fetched)
        : page.records;
    fetched += kept.length;
    if (opts.onPage) {
      if (addedSysId) for (const r of kept) delete r.sys_id;
      await opts.onPage(kept);
    } else {
      records.push(...kept);
    }
    opts.onProgress?.(
      fetched,
      total === undefined
        ? undefined
        : Math.max(0, Math.min(total - start, cap)),
    );
    if (page.total !== undefined) {
      const expected = Math.max(0, Math.min(want, page.total - pos));
      // Past the cursor, rows hidden before the last returned one cannot be
      // told from those after it (which the next window re-scans), so only a
      // fully hidden window counts; the exact figure is settled at the end.
      if (returned < expected && (cursor === undefined || returned === 0)) {
        filtered += expected - returned;
      }
      if (pos + want >= page.total) {
        exhausted = true;
        break;
      }
    } else {
      if (returned === 0) {
        exhausted = true;
        break; // no header: an empty page ends the read
      }
      filtered += pendingGap;
      pendingGap =
        returned < want && cursor === undefined ? want - returned : 0;
    }
    if (keyset && last) {
      // Switch to (or advance) the keyset cursor.
      if (cursor === undefined) pendingGap = 0;
      cursor = last;
      skip = 0;
    } else if (cursor === undefined) {
      offset += want;
    } else {
      skip += want;
    }
  }
  // Keyset read to the end with a known count: every matching row not
  // returned was withheld — the exact figure the per-page counts can't give.
  if (cursor !== undefined && exhausted && total !== undefined) {
    filtered = Math.max(0, total - start - fetched);
  }
  if (addedSysId && !opts.onPage) {
    for (const r of records) delete r.sys_id;
  }

  // Partial only when rows may remain: the cap was hit with more positions
  // left (always assumed without X-Total-Count), or the scan budget ran out.
  // Rows withheld by ACLs are NOT a truncation — they are reported as
  // `filtered` so the caller can name the real cause.
  const truncatedReason: QueryResult["truncatedReason"] = hitScanLimit
    ? "scan_limit"
    : hitCap && !exhausted
      ? "cap"
      : undefined;
  if (truncatedReason) {
    logger.warn("fetchAll stopped early (partial result)", {
      table: opts.table,
      reason: truncatedReason,
      returned: fetched,
      cap,
      total,
      filtered,
    });
  }
  if (filtered > 0) {
    logger.debug("fetchAll: rows withheld by the instance (ACL/data filter)", {
      table: opts.table,
      filtered,
    });
  }

  return {
    records,
    total,
    truncated: truncatedReason ? true : undefined,
    ...(truncatedReason ? { truncatedReason } : {}),
    ...(filtered > 0 ? { filtered } : {}),
  };
}

/** The keyset page query: the caller's filter, rows past `cursor`, by sys_id. */
function keysetQuery(query: string | undefined, cursor: string): string {
  return `${query ? `${query}^` : ""}sys_id>${cursor}^ORDERBYsys_id`;
}

/** A row's sys_id as a string ("" when absent), unwrapping `{value}` pairs. */
function rowSysId(record: SnRecord | undefined): string {
  return snString(record?.sys_id);
}

/** Read a single record by sys_id. */
export async function getRecord(
  table: string,
  sysId: string,
  fields?: string[],
  displayValue?: "true" | "false" | "all",
): Promise<SnRecord> {
  assertTableAllowed(table);
  const params = new URLSearchParams();
  if (fields?.length) params.set("sysparm_fields", fields.join(","));
  // N-62: sent only when asked, so a default read is unchanged.
  if (displayValue) params.set("sysparm_display_value", displayValue);
  if (!includeReferenceLinks()) {
    params.set("sysparm_exclude_reference_link", "true");
  }

  const { data } = await snRequest<{ result: SnRecord }>({
    method: "GET",
    path: recordPath(table, sysId),
    params,
  });
  const record = expectResult(data, "Table API");
  await noteSecretRecords(table, record); // N-21
  return record;
}

/** `sysparm_input_display_value` for a write, when requested. */
function writeParams(options: WriteOptions): URLSearchParams | undefined {
  if (!options.inputDisplayValue) return undefined;
  return new URLSearchParams({ sysparm_input_display_value: "true" });
}

/** Create a new record. */
export async function createRecord(
  table: string,
  fields: SnRecord,
  options: WriteOptions = {},
): Promise<SnRecord> {
  assertTableWriteAllowed(table); // H-11: read rules + protected tables
  assertWriteAllowed("create");
  // N-21: a secret value being written is masked in the result, an error
  // echo and the journal like one that was read.
  await noteSecretRecords(table, fields);
  const { data } = await snRequest<{ result: SnRecord }>({
    method: "POST",
    path: tablePath(table),
    params: writeParams(options),
    body: fields,
  });
  const record = expectResult(data, "Table API");
  await noteSecretRecords(table, record);
  return record;
}

/** Update an existing record by sys_id. */
export async function updateRecord(
  table: string,
  sysId: string,
  fields: SnRecord,
  options: WriteOptions = {},
): Promise<SnRecord> {
  assertTableWriteAllowed(table); // H-11: read rules + protected tables
  assertWriteAllowed("update");
  await noteSecretRecords(table, fields); // N-21, as in createRecord
  const { data } = await snRequest<{ result: SnRecord }>({
    method: "PATCH",
    path: recordPath(table, sysId),
    params: writeParams(options),
    body: fields,
  });
  const record = expectResult(data, "Table API");
  await noteSecretRecords(table, record);
  return record;
}

/** Delete a record by sys_id. */
export async function deleteRecord(
  table: string,
  sysId: string,
): Promise<{ deleted: true; table: string; sys_id: string }> {
  assertTableWriteAllowed(table); // H-11: read rules + protected tables
  assertWriteAllowed("delete");
  await snRequest<unknown>({
    method: "DELETE",
    path: recordPath(table, sysId),
  });
  return { deleted: true, table, sys_id: sysId };
}

/** A scalar key value an upsert matches on. */
export type KeyValue = string | number | boolean;

const KEY_FIELD = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;

/**
 * Build the encoded query that matches `key` exactly (`field=value^…`; an
 * empty string matches an empty field). Field names are restricted to
 * dictionary-style names and values may not contain `^` (it cannot be escaped
 * in an encoded query), so a key can never inject extra conditions.
 */
export function keyQuery(key: Record<string, KeyValue>): string {
  const entries = Object.entries(key);
  if (!entries.length) {
    throw new ServiceNowError("The upsert key needs at least one field.", 400);
  }
  return entries
    .map(([field, value]) => {
      if (!KEY_FIELD.test(field)) {
        throw new ServiceNowError(
          `Invalid key field name '${field}' (letters, digits, '_' and dot-walks only).`,
          400,
        );
      }
      const text = String(value);
      assertNoCaret(text, `key '${field}'`);
      if (/[\r\n]/.test(text)) {
        throw new ServiceNowError(
          `The key '${field}' value cannot contain a line break.`,
          400,
        );
      }
      return text === "" ? `${field}ISEMPTY` : `${field}=${text}`;
    })
    .join("^");
}

/** What an upsert will do: create a record, or update the one matching the key. */
export type UpsertDecision =
  | { action: "create" }
  | { action: "update"; sys_id: string; before: SnRecord };

/**
 * S-8 (L2-14) — resolve an upsert key to its action. No match plans a create;
 * exactly one readable match plans an update of it (`before` = the fields to
 * be written, as they are now). More than one match — or a match the user
 * cannot read, which X-Total-Count still reveals — is refused with
 * AMBIGUOUS_KEY rather than guessing or creating a duplicate.
 */
export async function resolveUpsert(
  table: string,
  key: Record<string, KeyValue>,
  fieldNames: string[],
): Promise<UpsertDecision> {
  const query = keyQuery(key);
  const { records, total } = await queryTable({
    table,
    query,
    fields: [...new Set(["sys_id", ...fieldNames])],
    limit: 2,
  });
  const matches = Math.max(records.length, total ?? 0);
  if (matches > 1) {
    throw new ServiceNowError(
      `The key matches ${matches} ${table} records; an upsert key must identify at most one.`,
      409,
      { matches: records.map(rowSysId) },
      {
        code: "AMBIGUOUS_KEY",
        hint: "Add fields to the key until it is unique, or update the intended record by sys_id.",
      },
    );
  }
  const found = records[0];
  if (!found) {
    if (matches > 0) {
      throw new ServiceNowError(
        `A ${table} record matches the key but is not readable by this user; creating another would duplicate it.`,
        409,
        undefined,
        {
          code: "AMBIGUOUS_KEY",
          hint: "Check the user's read access (ACLs / data filters) on the table.",
        },
      );
    }
    return { action: "create" };
  }
  const sysId = rowSysId(found);
  if (!sysId) {
    throw new ServiceNowError(
      `The ${table} record matching the key came back without a sys_id.`,
      502,
      undefined,
      { code: "UNEXPECTED_RESPONSE", source: "servicenow" },
    );
  }
  const before = Object.fromEntries(
    Object.entries(found).filter(
      ([k]) => k !== "sys_id" || fieldNames.includes("sys_id"),
    ),
  );
  return { action: "update", sys_id: sysId, before };
}
