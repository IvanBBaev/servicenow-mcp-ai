import { z } from "zod";

/**
 * N-59 (TK-41): the single source of the parameters many tools share. Their
 * text goes on the wire once per tool, so it stays short — tools/list is
 * budgeted (N-0 / O-10). This module imports only zod, so `define.ts` and
 * `write-mode.ts` can re-export from it without an import cycle.
 */

/** The automatic `instance` (connection profile) parameter (MI-3). */
export const instanceParam = z
  .string()
  .max(128)
  .optional()
  .describe("Profile (default active)");

/** H-3: the automatic `plan_token` parameter of a destructive-apply tool. */
export const planTokenParam = z
  .string()
  .max(64)
  .optional()
  .describe("Plan preview token (apply:true)");

/** The shared plan-and-apply gate input every Table-style write tool exposes (DF-2). */
export const applyInput = z
  .boolean()
  .optional()
  .describe(
    "true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default).",
  );

/** S-6: the update set an applied customization write is recorded in. */
export const updateSetInput = z
  .string()
  .max(100)
  .min(1)
  .optional()
  .describe(
    "Update set (sys_id or exact name, in progress) to record the write in; switched for it, then restored. Default SN_UPDATE_SET, else unchanged. Data-row tables are not captured.",
  );

/** The update set an update-set read is about (required, unlike `updateSetInput`). */
export const updateSetRef = z
  .string()
  .max(100)
  .min(1)
  .describe(
    "Update set sys_id or exact name (a shared name resolves to the one in progress).",
  );
