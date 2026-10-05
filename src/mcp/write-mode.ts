import { z } from "zod";
import { getWriteMode, writeModeHold } from "../core/settings.js";
import { ok, type ToolResult } from "./result.js";
import type { WriteAction } from "../core/write-journal.js";
import { activeProfile } from "../core/config.js";
import { currentCall } from "../core/request-context.js";
import { issuePlanToken } from "./plan-token.js";

/** The shared plan-and-apply gate input every Table-style write tool exposes (DF-2). */
export const applyInput = z
  .boolean()
  .optional()
  .describe(
    "true executes; omitted: a non-mutating plan preview (SN_WRITE_MODE=apply executes by default).",
  );

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

/**
 * Best-effort sys_id from a write API result for the audit journal. Handles a
 * plain string and the `{ value, display_value }` shape some APIs return.
 */
export function resultSysId(result: unknown): string | undefined {
  if (result && typeof result === "object" && "sys_id" in result) {
    const v = (result as Record<string, unknown>).sys_id;
    if (typeof v === "string") return v;
    if (v && typeof v === "object" && "value" in v) {
      const val = (v as Record<string, unknown>).value;
      return typeof val === "string" ? val : undefined;
    }
  }
  return undefined;
}

/** H-11: why a prod profile configured for apply is previewing instead. */
function holdDetail(): { write_mode_hold?: string } {
  const hold = writeModeHold();
  return hold ? { write_mode_hold: hold } : {};
}

/**
 * A non-mutating before/after preview returned by a write tool in plan mode.
 * `details` carries tool-specific facts (S-2's revert adds the reverted entry
 * and its drift check).
 */
export function planPreview(
  plan: {
    action: WriteAction;
    table: string;
    sys_id?: string;
    before?: unknown;
    after?: unknown;
  },
  details: Record<string, unknown> = {},
): ToolResult {
  // H-3: a destructive-apply tool's call under SN_DESTRUCTIVE_CONFIRM carries
  // a plan binding (define.ts) — issue the token the apply must hand back.
  const call = currentCall();
  if (call?.plan) {
    const { token, expiresAt } = issuePlanToken({
      profile: call.profile ?? activeProfile(),
      tool: call.tool,
      argsHash: call.plan.argsHash,
    });
    return ok({
      mode: "plan",
      ...plan,
      ...details,
      plan_token: token,
      plan_token_expires_at: expiresAt,
      ...holdDetail(),
      note: "No change was made (plan mode). To execute, re-run the same call with the same arguments plus apply:true and this plan_token (single use).",
    });
  }
  return ok({
    mode: "plan",
    ...plan,
    ...details,
    ...holdDetail(),
    note: "No change was made (plan mode). Re-run the same call with apply:true to execute it, or set SN_WRITE_MODE=apply to execute by default.",
  });
}

/**
 * H-5 — best-effort pre-write state for the journal's `before` field, so an
 * update/delete line is enough to build its inverse (S-2). A failed read
 * (missing record, ACL, network) yields `undefined` and never blocks the write.
 */
export async function captureBefore(
  read: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}
