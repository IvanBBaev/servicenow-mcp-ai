import { z } from "zod";
import {
  REVERT_TOOL,
  planRevert,
  applyRevert,
  listWrites,
} from "../api/revert.js";
import { ok } from "../mcp/result.js";
import {
  defineTool,
  shortText,
  tableName,
  type AnyToolSpec,
} from "../mcp/define.js";
import { shouldApply, planPreview, applyInput } from "../mcp/write-mode.js";

export const specs: AnyToolSpec[] = [
  defineTool({
    name: "servicenow_list_writes",
    title: "List journaled writes",
    description:
      "List the local write journal (newest first): every create/update/delete/execute this server made, with its entry id, outcome and whether the line alone allows servicenow_revert_write. Filter by profile, table, since, result or action.",
    package: "revert",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: {
      profile: shortText(128)
        .optional()
        .describe("Profile whose journal to read. Defaults to the active one."),
      table: tableName().optional().describe("Only writes to this table."),
      since: shortText(64)
        .optional()
        .describe(
          "Only writes at or after this ISO 8601 date/time, e.g. '2026-09-01' or '2026-09-01T12:00:00Z'.",
        ),
      result: z
        .enum(["applied", "failed", "refused"])
        .optional()
        .describe("Only writes with this outcome."),
      action: z
        .enum([
          "create",
          "update",
          "delete",
          "execute",
          "local_write",
          "config",
        ])
        .optional()
        .describe("Only writes of this kind."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum entries to return (default 50, max 500)."),
      verbose: z
        .boolean()
        .optional()
        .describe(
          "Return the full journal lines (fields, before) instead of summaries.",
        ),
    },
    logFields: (args) => ({ table: args.table, result: args.result }),
    handler: (args) => ok(listWrites(args)),
  }),

  defineTool({
    name: REVERT_TOOL,
    title: "Revert a journaled write",
    description:
      "Undo one applied write from the local journal: an update restores its before values, a create is deleted, a delete is re-created. Refused if the record changed since (unless force:true) or the line is not invertible (NOT_REVERTIBLE). Journaled.",
    package: "revert",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    confirm: {
      target: (args) => ({
        action: "execute",
        table: "write_journal",
        reverts: String(args.entry_id),
      }),
    },
    input: {
      entry_id: shortText(128)
        .min(1)
        .describe(
          "Journal entry id (ULID) to revert, from servicenow_list_writes.",
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          "Revert even when the record changed after the journaled write (or the change cannot be verified). Overwrites those later changes.",
        ),
      apply: applyInput,
    },
    logFields: (args) => ({ entry_id: args.entry_id }),
    handler: async ({ entry_id, force, apply }) => {
      const plan = await planRevert(entry_id);
      if (!shouldApply(apply)) {
        return planPreview(
          {
            action: plan.inverse,
            table: plan.table,
            sys_id: plan.sys_id,
            before: plan.current,
            after: plan.inverse === "delete" ? undefined : plan.restore,
          },
          {
            reverts: entry_id,
            drift: plan.drift,
            would_refuse: plan.drift.status !== "clean" && force !== true,
          },
        );
      }
      const outcome = await applyRevert(plan, force === true);
      return ok({ message: "Write reverted", ...outcome });
    },
  }),
];
