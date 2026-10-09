import { z } from "zod";
import {
  listTables,
  describeTable,
  describeTableDetails,
  describeTableIndexes,
} from "../api/meta.js";
import { ok } from "../mcp/result.js";
import {
  defineTool,
  shortText,
  tableName,
  type AnyToolSpec,
} from "../mcp/define.js";

/** N-61: tables an unfiltered `servicenow_list_tables` call returns. */
export const LIST_TABLES_DEFAULT_LIMIT = 200;

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_list_tables",
    title: "List ServiceNow tables",
    description:
      "List tables from sys_db_object, optionally filtered by a name or label fragment.",
    package: "schema",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: { count: z.number(), tables: z.array(z.unknown()) },
    input: {
      filter: shortText()
        .optional()
        .describe("Case-insensitive name or label fragment."),
    },
    handler: async ({ filter }) => {
      const tables = await listTables(filter);
      // N-61 (O-21 (b), ruled a fix): an unfiltered call lists the first
      // LIST_TABLES_DEFAULT_LIMIT tables (thousands otherwise) with a hint.
      if (!filter?.trim() && tables.length > LIST_TABLES_DEFAULT_LIMIT) {
        return ok({
          count: LIST_TABLES_DEFAULT_LIMIT,
          total: tables.length,
          truncated: true,
          note: `Showing the first ${LIST_TABLES_DEFAULT_LIMIT} of ${tables.length} tables (by name). Pass filter (a name or label fragment) to narrow the list.`,
          tables: tables.slice(0, LIST_TABLES_DEFAULT_LIMIT),
        });
      }
      return ok({ count: tables.length, tables });
    },
  }),

  defineTool({
    name: "servicenow_describe_table",
    title: "Describe ServiceNow table",
    description:
      "List a table's columns from sys_dictionary (name, label, type, mandatory, reference, default, flags). details:true adds choice lists and dictionary overrides.",
    package: "schema",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    output: {
      table: z.string(),
      count: z.number(),
      columns: z.array(z.unknown()),
      warnings: z.array(z.unknown()).optional(),
    },
    input: {
      table: tableName().describe("Table, e.g. 'incident'."),
      details: z
        .boolean()
        .optional()
        .describe(
          "Add choice lists and dictionary overrides (two extra reads).",
        ),
    },
    logFields: (args) => ({ table: args.table, details: args.details }),
    handler: async ({ table, details }) => {
      if (!details) {
        const columns = await describeTable(table);
        return ok({ table, count: columns.length, columns });
      }
      const [{ columns, warnings }, size] = await Promise.all([
        describeTableDetails(table),
        describeTableIndexes(table),
      ]);
      // N-15: indexes and the row estimate ride the details read; the output
      // schema is loose, so they cost no tools/list bytes.
      return ok({
        table,
        count: columns.length,
        columns,
        indexes: size.indexes,
        ...(size.rowEstimate !== undefined
          ? { rowEstimate: size.rowEstimate }
          : {}),
        warnings: [...warnings, ...size.warnings],
      });
    },
  }),
];
