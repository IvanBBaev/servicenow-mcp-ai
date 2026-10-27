import { z } from "zod";
import {
  IMPORT_MAX_ROWS,
  columnsOf,
  describeImportRun,
  getImportSetRow,
  importRows,
  insertImportSetRow,
  loadImportRows,
  type ImportRow,
  type ImportSource,
} from "../api/importset.js";
import { ServiceNowError } from "../core/errors.js";
import { ok } from "../mcp/result.js";
import {
  defineTool,
  sysId,
  tableName,
  type AnyToolSpec,
} from "../mcp/define.js";
import {
  shouldApply,
  planPreview,
  applyInput,
  resultSysId,
} from "../mcp/write-mode.js";
import { RESULT_OUTPUT, WRITE_OUTPUT } from "../mcp/output-shapes.js";
import { journaledWrite } from "../core/write-journal.js";

const importFieldsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_insert_import_set_row",
    title: "Insert ServiceNow import set row",
    description:
      "Insert one row (values), several (rows) or a CSV/JSONL file under SN_DOCS_DIR (file_path) into a staging table and run its transform map. Returns the transform result, the run (sys_import_set_run) and the transform maps, used ones marked.",
    package: "importset",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    legacyParams: { staging_table: "table", fields: "values" },
    input: {
      table: tableName().describe("Staging table, e.g. 'u_imp_incident'."),
      values: importFieldsSchema
        .optional()
        .describe("One row: column/value pairs."),
      rows: z
        .array(importFieldsSchema)
        .min(1)
        .max(IMPORT_MAX_ROWS)
        .optional()
        .describe("Several rows, each column/value pairs."),
      file_path: z
        .string()
        .max(1024)
        .optional()
        .describe("CSV (header row) or JSONL file under SN_DOCS_DIR."),
      apply: applyInput,
    },
    output: WRITE_OUTPUT,
    logFields: (args) => ({ table: args.table }),
    handler: async ({ table, values, rows, file_path, apply }) => {
      const given = [values, rows, file_path].filter((v) => v !== undefined);
      if (given.length !== 1) {
        throw new ServiceNowError(
          "Give exactly one of values, rows and file_path.",
          undefined,
          undefined,
          { code: "INVALID_INPUT" },
        );
      }
      if (values) {
        if (!shouldApply(apply)) {
          return planPreview({ action: "create", table, after: values });
        }
        const result = await journaledWrite(
          { action: "create", table, fields: values },
          () => insertImportSetRow(table, values),
          (r) => ({ sys_id: resultSysId(r) }),
        );
        // S-10: the run status and transform maps, best-effort (warnings).
        const run = await describeImportRun(table, result);
        return ok({ message: "Import set row inserted", result, ...run });
      }
      // N-68: several rows, inline or read from a file under SN_DOCS_DIR.
      let batch: ImportRow[];
      let source: ImportSource | undefined;
      if (file_path !== undefined) {
        const loaded = await loadImportRows(file_path);
        batch = loaded.rows;
        source = { file_path: loaded.rel, format: loaded.format };
      } else {
        batch = rows as ImportRow[];
      }
      if (!shouldApply(apply)) {
        return planPreview(
          {
            action: "create",
            table,
            after: {
              row_count: batch.length,
              columns: columnsOf(batch),
              first: batch[0],
            },
          },
          source ? { source } : {},
        );
      }
      const outcome = await importRows(table, batch, source);
      const run = await describeImportRun(table, outcome.results.at(-1) ?? {});
      const message = outcome.failed
        ? `Import stopped at row ${outcome.failed.index}: ${outcome.sent} of ${outcome.rows} rows inserted`
        : `${outcome.sent} import set rows inserted`;
      return ok({ message, ...outcome, ...run });
    },
  }),

  defineTool({
    name: "servicenow_get_import_set_row",
    title: "Get ServiceNow import set row result",
    description: "Read a staging row's transform outcome.",
    package: "importset",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    legacyParams: { staging_table: "table" },
    input: {
      table: tableName().describe("Import staging table."),
      sys_id: sysId().describe("Staging row sys_id."),
    },
    output: RESULT_OUTPUT,
    logFields: (args) => ({ table: args.table }),
    handler: async ({ table, sys_id }) =>
      ok({ result: await getImportSetRow(table, sys_id) }),
  }),
];
