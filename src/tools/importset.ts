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
import { journaledWrite } from "../core/write-journal.js";

const importFieldsSchema = z.record(
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_insert_import_set_row",
    title: "Insert ServiceNow import set row",
    description:
      "Insert one row into a staging table and run its transform map. Returns the transform result, the transform run (sys_import_set_run: state, completion code, insert/update/error counts) and the table's transform maps, used ones marked.",
    package: "importset",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    input: {
      staging_table: tableName().describe(
        "Import staging table, e.g. 'u_imp_incident'.",
      ),
      fields: importFieldsSchema.describe(
        "Column name/value pairs for the staging row.",
      ),
      apply: applyInput,
    },
    logFields: (args) => ({ staging_table: args.staging_table }),
    handler: async ({ staging_table, fields, apply }) => {
      if (!shouldApply(apply)) {
        return planPreview({
          action: "create",
          table: staging_table,
          after: fields,
        });
      }
      const result = await journaledWrite(
        {
          action: "create",
          table: staging_table,
          fields,
        },
        () => insertImportSetRow(staging_table, fields),
        (r) => ({ sys_id: resultSysId(r) }),
      );
      // S-10: the run status and transform maps, best-effort (warnings).
      const run = await describeImportRun(staging_table, result);
      return ok({ message: "Import set row inserted", result, ...run });
    },
  }),

  defineTool({
    name: "servicenow_get_import_set_row",
    title: "Get ServiceNow import set row result",
    description:
      "Read the transform outcome for a previously inserted staging row by its sys_id.",
    package: "importset",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      staging_table: tableName().describe("Import staging table name."),
      sys_id: sysId().describe("sys_id of the staging row."),
    },
    logFields: (args) => ({ staging_table: args.staging_table }),
    handler: async ({ staging_table, sys_id }) =>
      ok({ result: await getImportSetRow(staging_table, sys_id) }),
  }),
];
