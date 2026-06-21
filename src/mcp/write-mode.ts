import { getWriteMode } from "../core/settings.js";
import { ok, type ToolResult } from "./result.js";
import type { WriteAction } from "../core/write-journal.js";

/**
 * DF-2 — decide whether a write tool should execute or only preview.
 *
 * A write runs when the server is in apply mode, or when the model passed
 * `apply: true` for this one call. Otherwise the tool returns a plan preview
 * and mutates nothing.
 */
export function shouldApply(apply?: boolean): boolean {
  return getWriteMode() === "apply" || apply === true;
}

/** A non-mutating before/after preview returned by a write tool in plan mode. */
export function planPreview(plan: {
  action: WriteAction;
  table: string;
  sys_id?: string;
  before?: unknown;
  after?: unknown;
}): ToolResult {
  return ok({
    mode: "plan",
    ...plan,
    note: "No change was made (plan mode). Re-run the same call with apply:true to execute it, or set SN_WRITE_MODE=apply to execute by default.",
  });
}
