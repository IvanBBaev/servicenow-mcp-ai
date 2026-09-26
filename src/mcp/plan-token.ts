import { createHash, randomBytes } from "node:crypto";
import { defineRuntimePart, currentRuntime } from "../core/runtime.js";
import { getPlanTokenTtlSec } from "../core/settings.js";

/**
 * H-3 — plan tokens: a plan preview of a write tool carries a `plan_token`
 * that names exactly that plan (tool, profile and every argument), and a
 * destructive `apply:true` under SN_DESTRUCTIVE_CONFIRM=token|elicit must hand
 * it back. An injected `apply:true` that never went through a plan therefore
 * cannot mutate the instance.
 *
 * Design (deliberately not the self-describing HMAC token sketched in
 * ROADMAP-V3 §H-3): the token is an opaque random id and the plan it names is
 * held here, in the runtime container. Single use needs server state anyway
 * (a replayed send_email token would send the mail twice), an opaque id leaks
 * nothing about the plan, and a letters-only id cannot be mangled by the
 * SN_REDACT_PII digit-run masks that run over every tool result.
 */

/** Most plans held at once; the oldest is dropped when a new one would exceed it. */
export const PLAN_TOKEN_MAX = 500;

const PREFIX = "pt";
const TOKEN_LETTERS = 28; // ≈ 131 bits
const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

interface PlanRecord {
  profile: string;
  tool: string;
  argsHash: string;
  /** Epoch ms after which the token is refused. */
  expiresAt: number;
}

// E-3: the plans live in the runtime container, so an HTTP session's dispose
// (or a test's fresh runtime) invalidates every token it issued.
const plansPart = defineRuntimePart(
  "plan-tokens",
  () => new Map<string, PlanRecord>(),
  (state) => state.clear(),
);

const plans = (): Map<string, PlanRecord> => currentRuntime().get(plansPart);

/**
 * The arguments that do not change what a write does: the apply switch, the
 * token itself, the profile (bound separately) and the `expected_*`
 * assertions a plan hands back for the apply (upsert's decision, the
 * optimistic-concurrency mod count) — they only make the apply stricter.
 */
const UNBOUND_ARGS = new Set([
  "apply",
  "plan_token",
  "instance",
  "expected_action",
  "expected_sys_id",
  "expected_mod_count",
]);

/** JSON with sorted object keys, so equal arguments hash equally. */
function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/**
 * sha256 over the call's arguments minus `apply`, `plan_token` and `instance`
 * (the profile is bound separately), with `undefined` values dropped so an
 * omitted optional and an explicit `undefined` hash the same.
 */
export function planArgsHash(args: Record<string, unknown>): string {
  const bound: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!UNBOUND_ARGS.has(k)) bound[k] = v;
  }
  return createHash("sha256").update(canonical(bound)).digest("hex");
}

function randomLetters(n: number): string {
  let out = "";
  while (out.length < n) {
    for (const byte of randomBytes(n)) {
      // Rejection sampling keeps the 26 letters uniform (234 = 9 × 26).
      if (byte < 234 && out.length < n) out += ALPHABET[byte % 26];
    }
  }
  return out;
}

function prune(store: Map<string, PlanRecord>, now: number): void {
  for (const [token, plan] of store) {
    if (plan.expiresAt <= now) store.delete(token);
  }
  while (store.size >= PLAN_TOKEN_MAX) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Issue a token for one plan preview. */
export function issuePlanToken(plan: {
  profile: string;
  tool: string;
  argsHash: string;
}): { token: string; expiresAt: string } {
  const now = Date.now();
  const store = plans();
  prune(store, now);
  const token = PREFIX + randomLetters(TOKEN_LETTERS);
  const expiresAt = now + getPlanTokenTtlSec() * 1000;
  store.set(token, { ...plan, expiresAt });
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

export type PlanTokenCheck =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "missing"
        | "unknown"
        | "expired"
        | "wrong_tool"
        | "wrong_profile"
        | "args_changed";
    };

/**
 * Check and consume a token. Only a full match consumes it (single use); a
 * mismatch leaves it valid so the caller can retry with the planned arguments.
 */
export function consumePlanToken(
  token: string | undefined,
  expected: { profile: string; tool: string; argsHash: string },
): PlanTokenCheck {
  if (!token) return { ok: false, reason: "missing" };
  const store = plans();
  const plan = store.get(token);
  if (!plan) return { ok: false, reason: "unknown" };
  if (plan.expiresAt <= Date.now()) {
    store.delete(token);
    return { ok: false, reason: "expired" };
  }
  if (plan.tool !== expected.tool) return { ok: false, reason: "wrong_tool" };
  if (plan.profile !== expected.profile) {
    return { ok: false, reason: "wrong_profile" };
  }
  if (plan.argsHash !== expected.argsHash) {
    return { ok: false, reason: "args_changed" };
  }
  store.delete(token);
  return { ok: true };
}
