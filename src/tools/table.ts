import { z } from "zod";
import {
  queryTable,
  getRecord,
  createRecord,
  updateRecord,
  deleteRecord,
} from "../api/table.js";
import { ok, okQueryResult } from "../mcp/result.js";
import { defineTool, type AnyToolSpec } from "../mcp/define.js";
import { shouldApply, planPreview } from "../mcp/write-mode.js";
import { appendWriteJournal } from "../core/write-journal.js";

/**
 * A ServiceNow field value. The Table API accepts flat scalar values only;
 * nested objects/arrays are rejected, so they are disallowed here.
 */
const fieldsSchema = z.record(
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

/** DF-2: the plan-and-apply gate every Table write tool exposes. */
const applyInput = z
  .boolean()
  .optional()
  .describe(
    "Execute the change. In the default plan mode, omitting this returns a non-mutating before/after preview; set true to apply. SN_WRITE_MODE=apply makes execution the default.",
  );

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_query_table",
    title: "Query ServiceNow table",
    description:
      "Read records from any ServiceNow table through the Table API. Supports encoded queries, field selection and pagination.",
    package: "table",
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {
      table: z
        .string()
        .describe("Table name, e.g. 'incident', 'sys_user', 'change_request'."),
      query: z
        .string()
        .optional()
        .describe(
          "Encoded query (sysparm_query), e.g. 'active=true^priority=1^ORDERBYDESCsys_created_on'.",
        ),
      fields: z
        .array(z.string())
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
          "When true, page through all matching records (up to the server's SN_MAX_RECORDS cap) instead of a single page.",
        ),
    },
    logFields: (args) => ({ table: args.table }),
    handler: async (args) => {
      const { records, total, truncated } = await queryTable(args);
      return okQueryResult(records, total, truncated);
    },
  }),

  defineTool({
    name: "servicenow_get_record",
    title: "Get ServiceNow record",
    description: "Read a single record from a table by its sys_id.",
    package: "table",
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: {
      table: z.string().describe("Table name, e.g. 'incident'."),
      sys_id: z.string().describe("The sys_id of the record to read."),
      fields: z
        .array(z.string())
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
    input: {
      table: z.string().describe("Table name, e.g. 'incident'."),
      fields: fieldsSchema.describe(
        'Field name/value pairs for the new record, e.g. { "short_description": "Printer down", "urgency": "2" }.',
      ),
      apply: applyInput,
    },
    logFields: (args) => ({ table: args.table }),
    handler: async ({ table, fields, apply }) => {
      if (!shouldApply(apply)) {
        return planPreview({ action: "create", table, after: fields });
      }
      const record = await createRecord(table, fields);
      appendWriteJournal({
        action: "create",
        table,
        sys_id: typeof record.sys_id === "string" ? record.sys_id : undefined,
        fields,
      });
      return ok({ message: "Record created", record });
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
    input: {
      table: z.string().describe("Table name, e.g. 'incident'."),
      sys_id: z.string().describe("The sys_id of the record to update."),
      fields: fieldsSchema.describe(
        "Field name/value pairs to change on the record.",
      ),
      apply: applyInput,
    },
    logFields: (args) => ({ table: args.table }),
    handler: async ({ table, sys_id, fields, apply }) => {
      if (!shouldApply(apply)) {
        const before = await getRecord(table, sys_id, Object.keys(fields));
        return planPreview({
          action: "update",
          table,
          sys_id,
          before,
          after: fields,
        });
      }
      const record = await updateRecord(table, sys_id, fields);
      appendWriteJournal({ action: "update", table, sys_id, fields });
      return ok({ message: "Record updated", record });
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
    input: {
      table: z.string().describe("Table name, e.g. 'incident'."),
      sys_id: z.string().describe("The sys_id of the record to delete."),
      apply: applyInput,
    },
    logFields: (args) => ({ table: args.table }),
    handler: async ({ table, sys_id, apply }) => {
      if (!shouldApply(apply)) {
        const before = await getRecord(table, sys_id);
        return planPreview({ action: "delete", table, sys_id, before });
      }
      const result = await deleteRecord(table, sys_id);
      appendWriteJournal({ action: "delete", table, sys_id });
      return ok({ message: "Record deleted", ...result });
    },
  }),
];
