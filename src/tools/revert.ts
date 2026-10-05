import { sdkGuard, type SdkGuardTarget } from "../mcp/sdk-guard.js";
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
      "List the local write journal (newest first): every write this server made, with entry id, outcome and whether servicenow_revert_write can invert it. Filter by profile, table, since, result or action.",
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
        .describe("Profile whose journal to read (default: active)."),
      table: tableName().optional().describe("Only writes to this table."),
      since: shortText(64)
        .optional()
        .describe("Only writes at or after this ISO 8601 time."),
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
        .describe("Max entries (default 50, max 500)."),
      verbose: z
        .boolean()
        .optional()
        .describe("Full journal lines (fields, before) instead of summaries."),
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
        .describe("Journal entry id (ULID) from servicenow_list_writes."),
      force: z
        .boolean()
        .optional()
        .describe(
          "Revert even if the record changed since (or that cannot be verified), overwriting the later changes.",
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
            ...(await sdkGuard(revertTarget(plan), "plan")),
          },
        );
      }
      const sdk = await sdkGuard(revertTarget(plan), "apply");
      const outcome = await applyRevert(plan, force === true);
      return ok({ message: "Write reverted", ...outcome, ...sdk });
    },
  }),
];

/** P-22: the record a revert writes (a re-create names its scope in `restore`). */
function revertTarget(plan: {
  table: string;
  sys_id?: string;
  inverse: string;
  current?: unknown;
  restore?: Record<string, unknown>;
}): SdkGuardTarget {
  return {
    table: plan.table,
    ...(plan.inverse !== "create" && plan.sys_id
      ? { sys_id: plan.sys_id }
      : {}),
    ...(plan.current ? { record: plan.current } : {}),
    ...(plan.restore ? { fields: plan.restore } : {}),
  };
}
