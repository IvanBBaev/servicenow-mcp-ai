import { z } from "zod";
import { getRecordHistory } from "../api/history.js";
import { ok } from "../mcp/result.js";
import {
  defineTool,
  fieldList,
  shortText,
  sysId,
  tableName,
  type AnyToolSpec,
} from "../mcp/define.js";

/**
 * S-10 — opt-in `history` package: who changed what on one record, from
 * `sys_audit` and `sys_journal_field` (the comments / work notes the Table
 * API reads back empty, C-5).
 */
export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_get_record_history",
    title: "Get record history",
    description:
      "Read a record's history: sys_audit changes and journal entries (comments, work_notes), newest first — journal fields read back empty via the Table API. Each source degrades separately.",
    package: "history",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: {
      table: tableName().describe("Record table, e.g. 'incident'."),
      sys_id: sysId().describe("Record sys_id."),
      source: z
        .enum(["all", "audit", "journal"])
        .optional()
        .describe(
          "all (default), audit (field changes) or journal (comments / work notes).",
        ),
      fields: fieldList(50)
        .optional()
        .describe(
          "Only these fields / journal elements, e.g. ['state','work_notes'].",
        ),
      since: shortText(19)
        .optional()
        .describe("Only entries at or after 'YYYY-MM-DD[ HH:MM:SS]'."),
      limit: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe("Max entries after merging (default 100)."),
      value_max_chars: z
        .number()
        .int()
        .positive()
        .max(100_000)
        .optional()
        .describe("Chars per value (default 2000)."),
    },
    logFields: (args) => ({ table: args.table, source: args.source ?? "all" }),
    handler: async ({
      table,
      sys_id,
      source,
      fields,
      since,
      limit,
      value_max_chars,
    }) =>
      ok(
        await getRecordHistory({
          table,
          sysId: sys_id,
          source,
          fields,
          since,
          limit,
          valueMaxChars: value_max_chars,
        }),
      ),
  }),
];
