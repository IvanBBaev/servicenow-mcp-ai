import { unknownFields } from "../api/meta.js";
import { sdkGuard, type SdkGuardTarget } from "../mcp/sdk-guard.js";
import { z } from "zod";
import {
  queryTable,
  getRecord,
  createRecord,
  updateRecord,
  deleteRecord,
  resolveUpsert,
  type UpsertDecision,
} from "../api/table.js";
import { ServiceNowError } from "../core/errors.js";
import { ok, okQueryResult, queryCompleteness } from "../mcp/result.js";
import { redactRecords } from "../mcp/redact.js";
import { renderCsv } from "../mcp/csv.js";
import { csvBom, csvFormulaGuard } from "../core/settings.js";
import { openExport } from "../mcp/file-result.js";
import type { SnRecord } from "../api/table.js";
import {
  defineTool,
  encodedQuery,
  fieldList,
  shortText,
  sysId,
  tableName,
  type AnyToolSpec,
} from "../mcp/define.js";
import {
  shouldApply,
  planPreview,
  applyInput,
  captureBefore,
} from "../mcp/write-mode.js";
import { journaledWrite, resultModCount } from "../core/write-journal.js";
import {
  applyInUpdateSet,
  bindingPlanDetail,
  planUpdateSetBinding,
} from "../api/updatesets.js";
import { fetchAllProgress } from "../core/progress.js";

/**
 * A ServiceNow field value. The Table API accepts flat scalar values only;
 * nested objects/arrays are rejected, so they are disallowed here.
 */
const fieldsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

/** `sysparm_input_display_value` for the Table-style write tools (S-8). */
const inputDisplayValueInput = z
  .boolean()
  .optional()
  .describe(
    "Treat field values as display values (e.g. a user's name for a reference field, a choice label) that the instance resolves (sysparm_input_display_value). Default false: raw stored values.",
  );

/** S-6: the update set an applied customization write is recorded in. */
export const updateSetInput = shortText(100)
  .min(1)
  .optional()
  .describe(
    "Record an applied change in this update set (sys_id or exact name; must be 'in progress'). The user's current update set is switched for the write and restored afterwards. Defaults to SN_UPDATE_SET; omit both to leave the current update set alone. Data-row tables are not captured by update sets and are written without switching.",
  );

/**
 * S-11 — `format:"file"`: stream the read into an export file. Each page is
 * redacted and encoded as it arrives (fetchAll `onPage`), so memory holds one
 * page; CSV uses the shared encoder with the L2-01 formula guard and the BOM
 * setting, the header written once. A failed or cancelled read leaves no file.
 */
async function queryToFile(
  args: Omit<Parameters<typeof queryTable>[0], "onPage" | "onProgress">,
  fileFormat: "csv" | "jsonl",
) {
  const sink = await openExport(args.table, fileFormat);
  const guard = csvFormulaGuard();
  const bom = fileFormat === "csv" && csvBom();
  let columns: string[] | undefined = args.fields?.length
    ? args.fields
    : undefined;
  let rows = 0;
  let redacted = 0;
  let escaped = 0;
  const writePage = async (page: SnRecord[]) => {
    if (page.length === 0) return;
    const safe = redactRecords(page);
    redacted += safe.redacted;
    if (fileFormat === "jsonl") {
      await sink.write(
        safe.records.map((r) => JSON.stringify(r) + "\n").join(""),
      );
    } else {
      const first = rows === 0;
      columns ??= [...new Set(safe.records.flatMap((r) => Object.keys(r)))];
      const out = renderCsv(safe.records, columns, {
        formulaGuard: guard,
        bom: first && bom,
        header: first,
      });
      escaped += out.escaped;
      await sink.write((first ? "" : "\n") + out.csv);
    }
    rows += page.length;
  };
  let result: Awaited<ReturnType<typeof queryTable>>;
  try {
    result = await queryTable({
      ...args,
      onPage: writePage,
      onProgress: fetchAllProgress(args.table),
    });
    // A single-page read (no fetchAll) returns its records instead.
    await writePage(result.records);
    if (rows === 0 && fileFormat === "csv" && columns) {
      const out = renderCsv([], columns, { formulaGuard: guard, bom });
      await sink.write(out.csv);
    }
  } catch (e) {
    await sink.abort();
    throw e;
  }
  const delivery = await sink.close();
  const { total, truncated, truncatedReason, filtered } = result;
  return ok({
    format: "file",
    file_format: fileFormat,
    rows,
    ...(total === undefined ? {} : { total }),
    ...queryCompleteness(rows, total, truncated, {
      truncatedReason,
      filtered,
    }),
    ...(redacted > 0 ? { redacted } : {}),
    ...(fileFormat === "csv"
      ? { columns: columns ?? [], _meta: { csv: { escaped, bom } } }
      : {}),
    ...delivery,
  });
}

/**
 * H-3 (L2-05): optimistic concurrency for update / delete. The plan hands
 * back `apply_with.expected_mod_count` (the record's sys_mod_count when it
 * was previewed); an apply that passes it is refused with STALE_RECORD if
 * the record changed since. Omitting it applies without the check.
 */
const expectedModCountInput = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(
    "sys_mod_count from the plan's apply_with; with apply, a changed record is refused (STALE_RECORD).",
  );

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_query_table",
    title: "Query ServiceNow table",
    description:
      "Read records from any table (Table API): encoded query, fields, paging, fetchAll. '^' cannot be escaped inside a value; very long queries can hit HTTP 414 — split them. See the servicenow://reference/encoded-query resource.",
    package: "table",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: {
      count: z.number().optional(),
      total: z.number().optional(),
      truncated: z.boolean().optional(),
      note: z.string().optional(),
      records: z.array(z.unknown()).optional(),
      format: z.string().optional(),
      rows: z.number().optional(),
    },
    input: {
      table: tableName().describe(
        "Table name, e.g. 'incident', 'sys_user', 'change_request'.",
      ),
      query: encodedQuery()
        .optional()
        .describe(
          "Encoded query (sysparm_query), e.g. 'active=true^priority=1^ORDERBYDESCsys_created_on'.",
        ),
      fields: fieldList()
        .optional()
        .describe("Columns to return. Omit to return all columns."),
      limit: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe("Maximum number of records to return (default 10)."),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Number of records to skip, for pagination."),
      displayValue: z
        .enum(["true", "false", "all"])
        .optional()
        .describe(
          "Return display values ('true'), raw values ('false', default) or both ('all').",
        ),
      fetchAll: z
        .boolean()
        .optional()
        .describe(
          "When true, page through all matching records (up to the server's SN_MAX_RECORDS cap) instead of a single page. Without an ORDERBY it pages by sys_id cursor (stable while rows change); with one, by offset.",
        ),
      view: shortText()
        .optional()
        .describe(
          "UI view whose fields to return (sysparm_view), e.g. 'mobile'. 'fields' takes precedence.",
        ),
      queryCategory: shortText()
        .optional()
        .describe(
          "Query category (sysparm_query_category), e.g. to route the read to a read replica.",
        ),
      noCount: z
        .boolean()
        .optional()
        .describe(
          "Skip the row count (sysparm_no_count) — faster on very large tables, but 'total' is then unknown.",
        ),
      queryNoDomain: z
        .boolean()
        .optional()
        .describe(
          "On domain-separated instances, query across all domains the user can access (sysparm_query_no_domain).",
        ),
      suppressPaginationHeader: z
        .boolean()
        .optional()
        .describe(
          "Omit the Link paging header from the response (sysparm_suppress_pagination_header).",
        ),
      format: z
        .enum(["json", "csv", "file"])
        .optional()
        .describe(
          "Output format: 'json' (default), 'csv' for a spreadsheet-friendly export, or 'file' to write the full (redacted) result to <SN_DOCS_DIR>/<profile>/exports/ and return { path, bytes, preview } — use it when the result would exceed SN_MAX_RESULT_CHARS; with fetchAll only one page is held in memory at a time.",
        ),
      fileFormat: z
        .enum(["csv", "jsonl"])
        .optional()
        .describe(
          "With format 'file': 'csv' (default; columns are 'fields', or the first page's keys) or 'jsonl' (one JSON record per line, every key kept).",
        ),
    },
    logFields: (args) => ({ table: args.table }),
    handler: async ({ format, fileFormat, ...args }) => {
      if (format === "file") return queryToFile(args, fileFormat ?? "csv");
      const { records, total, truncated, truncatedReason, filtered } =
        await queryTable({ ...args, onProgress: fetchAllProgress(args.table) });
      const info = { truncatedReason, filtered };
      if (format === "csv") {
        const { records: safe } = redactRecords(records);
        const { csv, escaped, bom } = renderCsv(safe, args.fields, {
          formulaGuard: csvFormulaGuard(),
          bom: csvBom(),
        });
        return ok({
          format: "csv",
          rows: safe.length,
          ...(total === undefined ? {} : { total }),
          ...queryCompleteness(safe.length, total, truncated, info),
          content: csv,
          _meta: { csv: { escaped, bom } },
        });
      }
      return okQueryResult(records, total, truncated, info);
    },
  }),

  defineTool({
    name: "servicenow_get_record",
    title: "Get ServiceNow record",
    description: "Read a single record from a table by its sys_id.",
    package: "table",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: {},
    input: {
      table: tableName().describe("Table name, e.g. 'incident'."),
      sys_id: sysId().describe("The sys_id of the record to read."),
      fields: fieldList()
        .optional()
        .describe("Columns to return. Omit to return all columns."),
    },
    logFields: (args) => ({ table: args.table }),
    handler: async ({ table, sys_id, fields }) =>
      ok(await getRecord(table, sys_id, fields)),
  }),

  defineTool({
    name: "servicenow_create_record",
    title: "Create ServiceNow record",
    description: "Create a new record in a table with the given field values.",
    package: "table",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    legacyParams: { fields: "values" },
    input: {
      table: tableName().describe("Table name, e.g. 'incident'."),
      values: fieldsSchema.describe(
        'Field name/value pairs for the new record, e.g. { "short_description": "Printer down", "urgency": "2" }.',
      ),
      inputDisplayValue: inputDisplayValueInput,
      update_set: updateSetInput,
      apply: applyInput,
    },
    logFields: (args) => ({ table: args.table }),
    handler: async ({
      table,
      values: fields,
      inputDisplayValue,
      update_set,
      apply,
    }) => {
      const binding = await planUpdateSetBinding(table, update_set);
      if (!shouldApply(apply)) {
        return planPreview(
          { action: "create", table, after: fields },
          {
            ...unknownFieldsDetail(table, fields),
            ...bindingPlanDetail(binding),
            ...(await sdkGuard({ table, fields }, "plan")),
          },
        );
      }
      const sdk = await sdkGuard({ table, fields }, "apply");
      const { result: record, report } = await applyInUpdateSet(
        binding,
        (extra) =>
          journaledWrite(
            { action: "create", table, fields, ...extra },
            () => createRecord(table, fields, { inputDisplayValue }),
            (r) => ({
              sys_id: typeof r.sys_id === "string" ? r.sys_id : undefined,
              after_mod_count: resultModCount(r),
            }),
          ),
      );
      return ok({ message: "Record created", record, ...report, ...sdk });
    },
  }),

  defineTool({
    name: "servicenow_update_record",
    title: "Update ServiceNow record",
    description:
      "Update fields on an existing record identified by its sys_id.",
    package: "table",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    legacyParams: { fields: "values" },
    input: {
      table: tableName().describe("Table name, e.g. 'incident'."),
      sys_id: sysId().describe("The sys_id of the record to update."),
      values: fieldsSchema.describe(
        "Field name/value pairs to change on the record.",
      ),
      inputDisplayValue: inputDisplayValueInput,
      update_set: updateSetInput,
      expected_mod_count: expectedModCountInput,
      apply: applyInput,
    },
    logFields: (args) => ({ table: args.table }),
    handler: async ({
      table,
      sys_id,
      values: fields,
      inputDisplayValue,
      update_set,
      expected_mod_count,
      apply,
    }) => {
      const binding = await planUpdateSetBinding(table, update_set);
      if (!shouldApply(apply)) {
        const read = await getRecord(table, sys_id, withModCount(fields));
        const { before, applyWith } = splitModCount(read, fields);
        return planPreview(
          { action: "update", table, sys_id, before, after: fields },
          {
            ...applyWith,
            ...unknownFieldsDetail(table, fields),
            ...bindingPlanDetail(binding),
            ...(await sdkGuard({ table, sys_id, fields }, "plan")),
          },
        );
      }
      const sdk = await sdkGuard({ table, sys_id, fields }, "apply");
      const read = await captureBefore(() =>
        getRecord(table, sys_id, withModCount(fields)),
      );
      assertModCount(table, sys_id, read, expected_mod_count);
      const { before } = splitModCount(read, fields);
      const { result: record, report } = await applyInUpdateSet(
        binding,
        (extra) =>
          journaledWrite(
            { action: "update", table, sys_id, fields, before, ...extra },
            () => updateRecord(table, sys_id, fields, { inputDisplayValue }),
            (r) => ({ after_mod_count: resultModCount(r) }),
          ),
      );
      return ok({ message: "Record updated", record, ...report, ...sdk });
    },
  }),

  defineTool({
    name: "servicenow_upsert_record",
    title: "Upsert ServiceNow record",
    description:
      "Create or update one record matched by an exact key of field/value pairs: no match creates, one updates, several are refused (AMBIGUOUS_KEY). Pass the plan's expected_action / expected_sys_id with apply:true; a changed decision gives STALE_RECORD.",
    package: "table",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    legacyParams: { fields: "values" },
    input: {
      table: tableName().describe("Table name, e.g. 'cmdb_ci_server'."),
      key: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .refine((k) => Object.keys(k).length > 0, {
          message: "key needs at least one field",
        })
        .describe(
          "Field/value pairs that identify the record, matched on raw stored values (an empty string matches an empty field). Values cannot contain '^'.",
        ),
      values: fieldsSchema.describe(
        "Field name/value pairs to write. On create the key fields are written too.",
      ),
      expected_action: z
        .enum(["create", "update"])
        .optional()
        .describe(
          "The action the plan decided; with apply, the call is refused (STALE_RECORD) if the key now resolves differently.",
        ),
      expected_sys_id: sysId()
        .optional()
        .describe(
          "The sys_id the plan decided to update; with apply, the call is refused (STALE_RECORD) if the key now matches another record or none.",
        ),
      inputDisplayValue: inputDisplayValueInput,
      update_set: updateSetInput,
      apply: applyInput,
    },
    logFields: (args) => ({ table: args.table }),
    handler: async ({
      table,
      key,
      values: fields,
      expected_action,
      expected_sys_id,
      inputDisplayValue,
      update_set,
      apply,
    }) => {
      for (const [field, value] of Object.entries(key)) {
        if (field in fields && String(fields[field]) !== String(value)) {
          throw new ServiceNowError(
            `values.${field} conflicts with key.${field}; a created record would not match its own key.`,
            400,
          );
        }
      }
      const fieldNames = Object.keys(fields);
      const decision = await resolveUpsert(table, key, fieldNames);
      const binding = await planUpdateSetBinding(table, update_set);
      const payload =
        decision.action === "create" ? { ...key, ...fields } : fields;
      if (!shouldApply(apply)) {
        return planPreview(
          {
            action: decision.action,
            table,
            ...(decision.action === "update"
              ? { sys_id: decision.sys_id, before: decision.before }
              : {}),
            after: payload,
          },
          {
            key,
            ...unknownFieldsDetail(table, payload),
            apply_with: {
              expected_action: decision.action,
              ...(decision.action === "update"
                ? { expected_sys_id: decision.sys_id }
                : {}),
            },
            ...bindingPlanDetail(binding),
            ...(await sdkGuard(upsertTarget(table, decision, payload), "plan")),
          },
        );
      }
      assertUpsertUnchanged(decision, expected_action, expected_sys_id);
      const sdk = await sdkGuard(
        upsertTarget(table, decision, payload),
        "apply",
      );
      if (decision.action === "create") {
        const { result: record, report } = await applyInUpdateSet(
          binding,
          (extra) =>
            journaledWrite(
              { action: "create", table, fields: payload, ...extra },
              () => createRecord(table, payload, { inputDisplayValue }),
              (r) => ({
                sys_id: typeof r.sys_id === "string" ? r.sys_id : undefined,
                after_mod_count: resultModCount(r),
              }),
            ),
        );
        return ok({
          message: "Record created",
          action: "create",
          record,
          ...report,
          ...sdk,
        });
      }
      const { sys_id, before } = decision;
      const { result: record, report } = await applyInUpdateSet(
        binding,
        (extra) =>
          journaledWrite(
            { action: "update", table, sys_id, fields, before, ...extra },
            () => updateRecord(table, sys_id, fields, { inputDisplayValue }),
            (r) => ({ after_mod_count: resultModCount(r) }),
          ),
      );
      return ok({
        message: "Record updated",
        action: "update",
        record,
        ...report,
        ...sdk,
      });
    },
  }),

  defineTool({
    name: "servicenow_delete_record",
    title: "Delete ServiceNow record",
    description: "Delete a record from a table by its sys_id.",
    package: "table",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    confirm: {
      target: (args) => ({
        action: "delete",
        table: String(args.table),
        sys_id: String(args.sys_id),
      }),
    },
    input: {
      table: tableName().describe("Table name, e.g. 'incident'."),
      sys_id: sysId().describe("The sys_id of the record to delete."),
      update_set: updateSetInput,
      expected_mod_count: expectedModCountInput,
      apply: applyInput,
    },
    logFields: (args) => ({ table: args.table }),
    handler: async ({
      table,
      sys_id,
      update_set,
      expected_mod_count,
      apply,
    }) => {
      const binding = await planUpdateSetBinding(table, update_set);
      if (!shouldApply(apply)) {
        const before = await getRecord(table, sys_id);
        return planPreview(
          { action: "delete", table, sys_id, before },
          {
            ...modCountApplyWith(before),
            ...bindingPlanDetail(binding),
            ...(await sdkGuard({ table, sys_id, record: before }, "plan")),
          },
        );
      }
      const sdk = await sdkGuard({ table, sys_id }, "apply");
      const before = await captureBefore(() => getRecord(table, sys_id));
      assertModCount(table, sys_id, before, expected_mod_count);
      const { result, report } = await applyInUpdateSet(binding, (extra) =>
        journaledWrite(
          { action: "delete", table, sys_id, before, ...extra },
          () => deleteRecord(table, sys_id),
        ),
      );
      return ok({ message: "Record deleted", ...result, ...report, ...sdk });
    },
  }),
];

/** The fields to read for an update plan: the written ones plus sys_mod_count. */
function withModCount(fields: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(fields), "sys_mod_count"])];
}

/** `{apply_with: {expected_mod_count}}` from a record, when it has one. */
function modCountApplyWith(record: unknown): {
  apply_with?: { expected_mod_count: number };
} {
  const n = resultModCount(record);
  return n === undefined ? {} : { apply_with: { expected_mod_count: n } };
}

/**
 * Split an update read into the `before` shown and journaled (the written
 * fields only, as before H-3) and the plan's apply_with.
 */
function splitModCount(
  read: unknown,
  fields: Record<string, unknown>,
): { before: unknown; applyWith: ReturnType<typeof modCountApplyWith> } {
  if (!read || typeof read !== "object") return { before: read, applyWith: {} };
  const applyWith = modCountApplyWith(read);
  if ("sys_mod_count" in fields) return { before: read, applyWith };
  const { sys_mod_count: _drop, ...before } = read as Record<string, unknown>;
  void _drop;
  return { before, applyWith };
}

function assertModCount(
  table: string,
  sysId: string,
  current: unknown,
  expected: number | undefined,
): void {
  if (expected === undefined) return;
  const now = resultModCount(current);
  if (now === expected) return;
  throw new ServiceNowError(
    now === undefined
      ? `Cannot verify that ${table}/${sysId} is unchanged since the plan (its sys_mod_count could not be read).`
      : `${table}/${sysId} changed since the plan (sys_mod_count ${expected} → ${now}).`,
    409,
    { expected_mod_count: expected, sys_mod_count: now ?? null },
    {
      code: "STALE_RECORD",
      hint: "Re-run without apply to review the current record, then apply that plan (or omit expected_mod_count to skip the check).",
    },
  );
}

/** H-3 (L2-06): `{unknown_fields}` when the cached schema flags any. */
function unknownFieldsDetail(
  table: string,
  fields: Record<string, unknown>,
): { unknown_fields?: string[] } {
  const unknown = unknownFields(table, fields);
  return unknown?.length ? { unknown_fields: unknown } : {};
}

/** P-22: what an upsert writes, for the SDK-managed guard. */
function upsertTarget(
  table: string,
  decision: UpsertDecision,
  payload: Record<string, unknown>,
): SdkGuardTarget {
  return decision.action === "update"
    ? { table, sys_id: decision.sys_id, fields: payload }
    : { table, fields: payload };
}

/**
 * S-8 (L2-14): refuse an upsert apply whose create-or-update decision moved
 * since the plan the caller reviewed (a record appeared, vanished or the key
 * now names another one) — the same STALE_RECORD contract as revert's drift.
 */
export function assertUpsertUnchanged(
  decision: UpsertDecision,
  expectedAction?: "create" | "update",
  expectedSysId?: string,
): void {
  const sysId = decision.action === "update" ? decision.sys_id : undefined;
  const actionMoved =
    expectedAction !== undefined && expectedAction !== decision.action;
  const recordMoved = expectedSysId !== undefined && expectedSysId !== sysId;
  if (!actionMoved && !recordMoved) return;
  throw new ServiceNowError(
    `The upsert key now resolves to ${
      sysId ? `an update of ${sysId}` : "a create"
    }, not the planned ${expectedAction ?? "update"}${
      expectedSysId ? ` of ${expectedSysId}` : ""
    }.`,
    409,
    {
      planned: { action: expectedAction, sys_id: expectedSysId },
      current: { action: decision.action, sys_id: sysId },
    },
    {
      code: "STALE_RECORD",
      hint: "Re-run without apply to review the new plan, then apply that.",
    },
  );
}
