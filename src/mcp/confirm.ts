import { activeProfile } from "../core/config.js";
import { ServiceNowError } from "../core/errors.js";
import type { CallContext } from "../core/request-context.js";
import { getDestructiveConfirm, getWriteMode } from "../core/settings.js";
import { appendWriteJournal } from "../core/write-journal.js";
import { getServer } from "./context.js";
import type { AnyToolSpec } from "./define.js";
import {
  consumePlanToken,
  planArgsHash,
  type PlanTokenCheck,
} from "./plan-token.js";
import { fail, type ToolResult } from "./result.js";

type Mismatch = Exclude<PlanTokenCheck, { ok: true }>["reason"];

const WHY: Record<Mismatch, string> = {
  missing: "no plan_token was passed",
  unknown:
    "the plan_token is unknown or already used (tokens are single-use and live only in this server process)",
  expired: "the plan_token expired (SN_PLAN_TOKEN_TTL_SEC)",
  wrong_tool: "the plan_token belongs to another tool's plan",
  wrong_profile: "the plan_token belongs to a plan for another profile",
  args_changed: "the arguments differ from the planned call",
};

const PLAN_HINT =
  "Call the tool again without apply, review the preview, then repeat the same call with apply:true and the preview's plan_token. SN_WRITE_MODE=apply (trusted automation) or SN_DESTRUCTIVE_CONFIRM=off disables this check.";

/**
 * H-3 — the gate in front of a destructive apply. Returns null to let the
 * handler run, or the refusal. It applies only to a tool that declares
 * `confirm`, to a call with `apply:true` that its `when` selects, in plan
 * mode, with SN_DESTRUCTIVE_CONFIRM=token|elicit:
 *
 * 1. the call must carry the plan_token of a matching plan preview — same
 *    tool, profile and arguments, unexpired, not used before (it is consumed
 *    here, so a replay is refused) → PLAN_REQUIRED, nothing journaled;
 * 2. with `elicit`, a client that advertises elicitation is asked to
 *    confirm; a decline or a failed prompt is refused (CONFIRM_DECLINED) and
 *    journaled as `refused`. A client without elicitation relies on step 1.
 */
export async function confirmDestructiveApply(
  spec: AnyToolSpec,
  args: Record<string, unknown>,
  call: CallContext,
): Promise<ToolResult | null> {
  const confirm = spec.confirm;
  if (!confirm || args.apply !== true) return null;
  if (getWriteMode() === "apply") return null;
  const mode = getDestructiveConfirm();
  if (mode === "off") return null;
  if (confirm.when && !confirm.when(args)) return null;

  const token = typeof args.plan_token === "string" ? args.plan_token : "";
  const check = consumePlanToken(token || undefined, {
    profile: call.profile ?? activeProfile(),
    tool: spec.name,
    argsHash: call.plan?.argsHash ?? planArgsHash(args),
  });
  if (!check.ok) {
    return fail(
      new ServiceNowError(
        `Destructive apply refused: ${WHY[check.reason]}. Nothing was changed.`,
        428,
        undefined,
        { code: "PLAN_REQUIRED", hint: PLAN_HINT },
      ),
    );
  }
  call.plan = { argsHash: call.plan?.argsHash ?? planArgsHash(args), token };

  if (mode !== "elicit") return null;
  const server = getServer();
  if (!server?.server.getClientCapabilities()?.elicitation) return null;

  const target = confirm.target(args);
  const what = `${target.action} on ${target.table}${target.sys_id ? `/${target.sys_id}` : ""}`;
  let declined: string | undefined;
  try {
    const res = await server.server.elicitInput({
      message: `${spec.title}: apply ${what} on profile "${call.profile ?? activeProfile()}"?`,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            description: "Confirm this change on the ServiceNow instance.",
          },
        },
        required: ["confirm"],
      },
    });
    const accepted =
      res.action === "accept" &&
      (res.content as { confirm?: boolean } | undefined)?.confirm === true;
    if (!accepted) declined = "the user did not confirm it";
  } catch (error) {
    // A failed prompt must never let the write through.
    declined = `the confirmation prompt failed (${error instanceof Error ? error.message : String(error)})`;
  }
  if (!declined) return null;

  const message = `Destructive apply refused: ${declined}. Nothing was changed.`;
  appendWriteJournal({ ...target, result: "refused", error: message });
  return fail(
    new ServiceNowError(message, 403, undefined, {
      code: "CONFIRM_DECLINED",
      hint: "Plan the call again if the change is still wanted.",
    }),
  );
}
