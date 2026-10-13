import { activeProfile } from "../core/config.js";
import { ServiceNowError } from "../core/errors.js";
import type { CallContext } from "../core/request-context.js";
import {
  getDestructiveConfirm,
  getProfileEnv,
  getWriteMode,
} from "../core/settings.js";
import { appendWriteJournal } from "../core/write-journal.js";
import type { AnyToolSpec } from "./define.js";
import { askUser, onModernWire } from "./input.js";
import {
  checkPlanToken,
  consumePlanToken,
  planArgsHash,
  type PlanTokenCheck,
} from "./plan-token.js";
import { fail, type ToolResult } from "./result.js";
import type { InputRequiredResult } from "@modelcontextprotocol/server";

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
 *
 * On the 2026-07-28 wire (MRTR) step 2 takes two rounds: the first answers
 * `input_required` (returned as is) and only checks the token, the retry
 * carries the answer and consumes it — so the write runs at most once, and
 * a decline burns the token.
 */
export async function confirmDestructiveApply(
  spec: AnyToolSpec,
  args: Record<string, unknown>,
  call: CallContext,
): Promise<ToolResult | InputRequiredResult | null> {
  const confirm = spec.confirm;
  if (!confirm) return null;
  // The gate runs in the call's profile context (define.ts), so these read
  // that profile's write mode, confirmation mode and environment.
  const applyMode = getWriteMode() === "apply";
  if (!applyMode && args.apply !== true) return null; // a plan preview
  const prod = getProfileEnv() === "prod";
  // Apply mode is a trusted operator — except on a prod profile (H-11).
  if (applyMode && !prod) return null;
  const mode = getDestructiveConfirm();
  if (mode === "off") return null;
  if (confirm.when && !confirm.when(args)) return null;
  if (applyMode) return elicitOrRefuse(spec, confirm, args, call, undefined);

  const token = typeof args.plan_token === "string" ? args.plan_token : "";
  const expected = {
    profile: call.profile ?? activeProfile(),
    tool: spec.name,
    argsHash: call.plan?.argsHash ?? planArgsHash(args),
  };
  // A multi-round confirmation consumes the token on the answering round.
  const twoRounds = mode === "elicit" && onModernWire();
  const check = twoRounds
    ? checkPlanToken(token || undefined, expected)
    : consumePlanToken(token || undefined, expected);
  if (!check.ok) return planRefusal(check.reason);
  call.plan = {
    argsHash: expected.argsHash,
    token,
    ...(check.binding === undefined ? {} : { binding: check.binding }),
  };

  if (mode !== "elicit") return null;
  return elicitOrRefuse(
    spec,
    confirm,
    args,
    call,
    twoRounds ? { token, expected } : null,
  );
}

function planRefusal(reason: Mismatch): ToolResult {
  return fail(
    new ServiceNowError(
      `Destructive apply refused: ${WHY[reason]}. Nothing was changed.`,
      428,
      undefined,
      {
        code: reason === "expired" ? "PLAN_EXPIRED" : "PLAN_REQUIRED",
        hint: PLAN_HINT,
      },
    ),
  );
}

/** A plan token checked but not yet consumed (the MRTR path). */
interface PendingPlan {
  token: string;
  expected: Parameters<typeof consumePlanToken>[1];
}

/**
 * The elicitation step. A client without elicitation passes on the plan
 * token alone — except on a prod profile in apply mode (`plan` undefined),
 * where no plan token was involved, so nothing would confirm the write:
 * CONFIRM_REQUIRED. `plan` is the checked token to consume once the user
 * answers (MRTR), or null when step 1 consumed it already.
 */
async function elicitOrRefuse(
  spec: AnyToolSpec,
  confirm: NonNullable<AnyToolSpec["confirm"]>,
  args: Record<string, unknown>,
  call: CallContext,
  plan: PendingPlan | null | undefined,
): Promise<ToolResult | InputRequiredResult | null> {
  const prodApply = plan === undefined;
  const profile = call.profile ?? activeProfile();
  const target = confirm.target(args);
  const what = `${target.action} on ${target.table}${target.sys_id ? `/${target.sys_id}` : ""}`;
  const answer = await askUser({
    purpose: "destructive_apply",
    key: "confirm",
    message: `${spec.title}: apply ${what} on profile "${profile}"?`,
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
    binding: { tool: spec.name, profile, args },
  });
  if (answer.status === "pending") return answer.result;

  // Burn (or use) the checked token: any answer ends this plan.
  const consumed = plan ? consumePlanToken(plan.token, plan.expected) : null;

  if (answer.status === "unsupported") {
    if (consumed && !consumed.ok) return planRefusal(consumed.reason);
    if (!prodApply) return null;
    return fail(
      new ServiceNowError(
        `Destructive apply refused: profile "${profile}" is marked prod and this client cannot confirm the change (no elicitation support). Nothing was changed.`,
        428,
        undefined,
        {
          code: "CONFIRM_REQUIRED",
          hint: "Use a client with elicitation, or run the profile in plan mode (unset its WRITE_MODE) and apply with the preview's plan_token.",
        },
      ),
    );
  }

  let declined: string | undefined;
  if (answer.status === "failed") {
    // A failed prompt must never let the write through.
    declined = `the confirmation prompt failed (${answer.error})`;
  } else if (answer.status === "rejected") {
    declined = `the confirmation round was rejected (${answer.error})`;
  } else if (
    answer.action !== "accept" ||
    (answer.content as { confirm?: unknown } | undefined)?.confirm !== true
  ) {
    declined = "the user did not confirm it";
  }
  if (!declined) {
    if (consumed && !consumed.ok) return planRefusal(consumed.reason);
    return null;
  }

  const message = `Destructive apply refused: ${declined}. Nothing was changed.`;
  appendWriteJournal({ ...target, result: "refused", error: message });
  return fail(
    new ServiceNowError(message, 403, undefined, {
      code: "CONFIRM_DECLINED",
      hint: "Plan the call again if the change is still wanted.",
    }),
  );
}
