import { z } from "zod";
import {
  insertImportSetRow,
  getImportSetRow,
  describeImportRun,
} from "../api/importset.js";
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
      "Insert one row into a staging table and run its transform map. Returns the transform result, the run (sys_import_set_run: state, counts) and the table's transform maps, used ones marked.",
    package: "importset",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    legacyParams: { staging_table: "table", fields: "values" },
    input: {
      table: tableName().describe(
        "Import staging table, e.g. 'u_imp_incident'.",
      ),
      values: importFieldsSchema.describe(
        "Staging row column name/value pairs.",
      ),
      apply: applyInput,
    },
    output: WRITE_OUTPUT,
    logFields: (args) => ({ table: args.table }),
    handler: async ({ table, values, apply }) => {
      if (!shouldApply(apply)) {
        return planPreview({
          action: "create",
          table,
          after: values,
        });
      }
      const result = await journaledWrite(
        {
          action: "create",
          table,
          fields: values,
        },
        () => insertImportSetRow(table, values),
        (r) => ({ sys_id: resultSysId(r) }),
      );
      // S-10: the run status and transform maps, best-effort (warnings).
      const run = await describeImportRun(table, result);
      return ok({ message: "Import set row inserted", result, ...run });
    },
  }),

  defineTool({
    name: "servicenow_get_import_set_row",
    title: "Get ServiceNow import set row result",
    description: "Read the transform outcome of a staging row.",
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
