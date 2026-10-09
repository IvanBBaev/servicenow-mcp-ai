import { describeTableIndexes, unknownFields } from "../api/meta.js";
import { explainQuery } from "../api/query-explain.js";
import { scopeQueryToDomain } from "../api/domain-separation.js";
import { sdkGuard, type SdkGuardTarget } from "../mcp/sdk-guard.js";
import { z } from "zod";
import { updateSetInput } from "../mcp/params.js";
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
import {
  ok,
  okQueryResult,
  queryCompleteness,
  type QueryCompleteness,
  type ToolResult,
} from "../mcp/result.js";
import { redactRecords } from "../mcp/redact.js";
import { renderCsv } from "../mcp/csv.js";
import {
  csvBom,
  csvFormulaGuard,
  getMaxResultChars,
  oversizeToFile,
} from "../core/settings.js";
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
import {
  compactRecords,
  EMPTY_OMITTED_NOTE,
  omitEmpty,
  summaryFields,
  toTableForm,
} from "../api/compact-read.js";

/** N-62: `displayValue` with the opt-in compact `display` mode. */
const displayValueInput = z
  .enum(["true", "false", "all", "display"])
  .optional();

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
    "Values are display values the instance resolves (sysparm_input_display_value); default false: raw.",
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
 * N-61 (O-21 (b)) — the automatic file result: a JSON read over
 * SN_MAX_RESULT_CHARS, with SN_OVERSIZE_TO_FILE on (the default), is written
 * to `exports/<table>-<timestamp>.jsonl` from the rows already read (no
 * second request) and returns the `format:"file"` shape with a note.
 */
async function oversizeQueryToFile(
  table: string,
  records: SnRecord[],
  total: number | undefined,
  truncated: boolean | undefined,
  info: QueryCompleteness,
  extra: Record<string, unknown> = {},
): Promise<ToolResult | undefined> {
  if (!oversizeToFile()) return undefined;
  const safe = redactRecords(records);
  const lines = safe.records.map((r) => JSON.stringify(r) + "\n").join("");
  const max = getMaxResultChars();
  if (lines.length <= max) return undefined;
  const sink = await openExport(table, "jsonl");
  try {
    await sink.write(lines);
  } catch (e) {
    await sink.abort();
    throw e;
  }
  const delivery = await sink.close();
  return ok({
    format: "file",
    file_format: "jsonl",
    rows: safe.records.length,
    ...(total === undefined ? {} : { total }),
    ...queryCompleteness(safe.records.length, total, truncated, info),
    ...(safe.redacted > 0 ? { redacted: safe.redacted } : {}),
    ...extra,
    ...delivery,
    note: `Result was over SN_MAX_RESULT_CHARS (${max}): written to a file (SN_OVERSIZE_TO_FILE).`,
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
      rows: z.union([z.number(), z.array(z.unknown())]).optional(),
      explain: z.unknown().optional(),
    },
    input: {
      table: tableName().describe("Table, e.g. 'incident'."),
      query: encodedQuery()
        .optional()
        .describe(
          "Encoded query (sysparm_query), e.g. 'active=true^ORDERBYDESCsys_created_on'.",
        ),
      fields: z
        .union([fieldList(), z.literal("summary")])
        .optional()
        .describe("Columns (default all); 'summary': the list view's."),
      limit: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe("Max records (default 10)."),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Records to skip (paging)."),
      displayValue: displayValueInput.describe(
        "'true' display, 'false' raw (default), 'all' both, 'display' compact ([sys_id, name] refs).",
      ),
      omitEmpty: z
        .boolean()
        .optional()
        .describe("Drop empty cells; columns are listed."),
      fetchAll: z
        .boolean()
        .optional()
        .describe(
          "All matches (≤ SN_MAX_RECORDS): sys_id cursor without an ORDERBY (stable), else offset.",
        ),
      view: shortText()
        .optional()
        .describe("UI view's fields (sysparm_view); 'fields' wins."),
      queryCategory: shortText()
        .optional()
        .describe("sysparm_query_category, e.g. a read replica."),
      noCount: z
        .boolean()
        .optional()
        .describe(
          "Skip the row count (sysparm_no_count): faster on huge tables; 'total' unknown.",
        ),
      queryNoDomain: z
        .boolean()
        .optional()
        .describe("Query all accessible domains (sysparm_query_no_domain)."),
      domain: sysId().optional().describe("Only this domain's rows (sys_id)."),
      suppressPaginationHeader: z
        .boolean()
        .optional()
        .describe("sysparm_suppress_pagination_header."),
      format: z
        .enum(["json", "csv", "table", "file"])
        .optional()
        .describe(
          "'json' (default), 'csv', 'table' (columns + rows) or 'file': the full (redacted) result to <profile>/exports/.",
        ),
      fileFormat: z
        .enum(["csv", "jsonl"])
        .optional()
        .describe(
          "With format 'file': 'csv' (default; columns from 'fields' or page 1) or 'jsonl' (all keys).",
        ),
      explain: z
        .boolean()
        .optional()
        .describe(
          "Read no records: which conditions can use an index, with cost notes (advice).",
        ),
    },
    logFields: (args) => ({ table: args.table }),
    handler: async ({
      format,
      fileFormat,
      explain,
      omitEmpty: omit,
      domain,
      ...scoped
    }) => {
      // N-12: a domain scope is one more AND'd condition; absent, the query
      // (and so every byte of the result) is unchanged.
      const input = domain
        ? { ...scoped, query: scopeQueryToDomain(scoped.query, domain) }
        : scoped;
      // N-15: a static explain against the chain's indexes; no records read.
      if (explain) {
        const { indexes, rowEstimate, warnings } = await describeTableIndexes(
          input.table,
        );
        return ok({
          explain: {
            ...explainQuery(input.query ?? "", indexes),
            indexes: indexes.length,
            ...(rowEstimate !== undefined ? { rowEstimate } : {}),
            ...(warnings.length ? { warnings } : {}),
          },
        });
      }
      // N-62 (O-21 (a)): the compact forms are opt-in; without them the
      // read below is the plain one.
      const summary =
        input.fields === "summary"
          ? await summaryFields(input.table)
          : undefined;
      const fields = summary?.fields ?? (input.fields as string[] | undefined);
      const compact = input.displayValue === "display";
      const tabular = format === "csv" || format === "file";
      const args = {
        ...input,
        fields,
        displayValue:
          input.displayValue === "display"
            ? tabular
              ? ("true" as const)
              : ("all" as const)
            : input.displayValue,
      };
      const extra: Record<string, unknown> = summary
        ? {
            field_set: "summary",
            fields: summary.fields,
            ...(summary.warnings ? { warnings: summary.warnings } : {}),
          }
        : {};
      if (format === "file") return queryToFile(args, fileFormat ?? "csv");
      const { records, total, truncated, truncatedReason, filtered } =
        await queryTable({ ...args, onProgress: fetchAllProgress(args.table) });
      const info = { truncatedReason, filtered };
      // N-40: a paged read names the offset of the next page while the
      // instance has more rows (`sysparm_offset` counts row positions, so a
      // page short of rows the instance withheld still advances by `limit`).
      // Without a count, a full page means there may be more.
      const paging = args.fetchAll ? undefined : { offset: args.offset ?? 0 };
      if (paging) {
        const next = paging.offset + (args.limit ?? 10);
        const more =
          total === undefined
            ? records.length >= (args.limit ?? 10)
            : next < total;
        if (more) extra.next_offset = next;
      }
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
          ...extra,
          content: csv,
          _meta: { csv: { escaped, bom } },
        });
      }
      let rows: SnRecord[] = records;
      if (compact && !tabular) {
        const c = await compactRecords(args.table, records, fields);
        rows = c.records;
        if (c.warning) {
          extra.warnings = [...((extra.warnings as string[]) ?? []), c.warning];
        }
      }
      if (format === "table") {
        const { records: safe, redacted } = redactRecords(rows);
        return ok({
          ...queryCompleteness(safe.length, total, truncated, info),
          ...toTableForm(safe, { columns: fields, total, truncated }),
          ...(redacted > 0 ? { redacted } : {}),
          ...extra,
        });
      }
      if (omit) {
        const columns = fields ?? [...new Set(rows.flatMap(Object.keys))];
        const trimmed = omitEmpty(rows);
        rows = trimmed.records;
        Object.assign(extra, {
          columns,
          empty_omitted: trimmed.emptyOmitted,
          empty_note: EMPTY_OMITTED_NOTE,
        });
      }
      return (
        (await oversizeQueryToFile(
          args.table,
          rows,
          total,
          truncated,
          info,
          extra,
        )) ?? okQueryResult(rows, total, truncated, info, extra, paging)
      );
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
      table: tableName().describe("Table, e.g. 'incident'."),
      sys_id: sysId().describe("Record sys_id."),
      fields: fieldList().optional().describe("Columns (default all)."),
      displayValue: displayValueInput.describe("As in query_table."),
    },
    logFields: (args) => ({ table: args.table }),
    handler: async ({ table, sys_id, fields, displayValue }) => {
      if (displayValue !== "display") {
        return ok(await getRecord(table, sys_id, fields, displayValue));
      }
      // N-62: the compact display form (opt-in, O-21 (a)).
      const record = await getRecord(table, sys_id, fields, "all");
      const c = await compactRecords(table, [record], fields);
      return ok(
        c.warning ? { ...c.records[0], _warnings: [c.warning] } : c.records[0],
      );
    },
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
      table: tableName().describe("Table, e.g. 'incident'."),
      values: fieldsSchema.describe(
        'Field name/value pairs, e.g. { "short_description": "x" }.',
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
      table: tableName().describe("Table, e.g. 'incident'."),
      sys_id: sysId().describe("Record sys_id."),
      values: fieldsSchema.describe("Field name/value pairs to change."),
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
          "Field/value pairs identifying the record, matched on raw values ('' matches an empty field); no '^' in values.",
        ),
      values: fieldsSchema.describe(
        "Fields to write (plus the key fields on create).",
      ),
      expected_action: z
        .enum(["create", "update"])
        .optional()
        .describe(
          "The plan's action; with apply, refused (STALE_RECORD) if the key now resolves differently.",
        ),
      expected_sys_id: sysId()
        .optional()
        .describe(
          "The plan's sys_id; with apply, refused (STALE_RECORD) if the key now matches another record or none.",
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
      table: tableName().describe("Table, e.g. 'incident'."),
      sys_id: sysId().describe("Record sys_id."),
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
