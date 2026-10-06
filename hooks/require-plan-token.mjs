#!/usr/bin/env node
// D-8 — Claude Code plugin PreToolUse hook: stop a destructive ServiceNow
// write at the client, with an accurate next step, before it reaches the
// server.
//
// It mirrors the server's H-3 / H-11 gate (src/mcp/confirm.ts) for the
// profile the call runs in — `tool_input.instance`, else SN_ACTIVE_PROFILE —
// reading the local config the server reads: the process environment over
// the server's env file (hooks/sn-config.mjs).
// - plan mode (the default): an `apply:true` without a `plan_token` is
//   denied — the server would refuse it (PLAN_REQUIRED); the reason says to
//   preview first. A token is checked for presence, never for validity (the
//   server does that).
// - apply mode (SN_WRITE_MODE=apply, and on a prod profile also
//   SN_PROD_WRITES=I_UNDERSTAND): every destructive call executes as soon as
//   it runs, with or without `apply`, and no plan_token is involved, so the
//   hook asks the user (`permissionDecision: "ask"`) and says so.
// - SN_READONLY, a profile the local config does not define, or an
//   `instance` value the server would refuse: silent — the server decides.
// Anything it does not understand passes through, and any error prints
// nothing and exits 0 (fail open), so a broken hook can never block a call
// the server would allow. The server may run with a
// different environment than the client; it stays authoritative.
//
// Escape hatch: SN_DESTRUCTIVE_CONFIRM=off (the same opt-out the server
// honours) disables the hook — except on a profile marked prod (SN_ENV),
// where the server ignores the opt-out too.
import { pathToFileURL } from "node:url";

import {
  PROFILE_RE,
  activeProfile,
  envFilePath,
  profileNames,
  readEnvFile,
  writePolicy,
} from "./sn-config.mjs";

/**
 * The tools whose `apply:true` is destructive (the H-3 `confirm` specs; their
 * input schema carries `plan_token`). The value narrows a tool to the calls
 * the server gates; `test/plugin-hook.test.js` pins this list to the manifest.
 */
export const DESTRUCTIVE_TOOLS = {
  servicenow_batch: (input) =>
    Array.isArray(input.requests) &&
    input.requests.some((r) => r?.method !== "GET"),
  servicenow_check_change_conflicts: (input) => input.calculate === true,
  servicenow_delete_attachment: () => true,
  servicenow_delete_record: () => true,
  servicenow_order_catalog_item: () => true,
  servicenow_revert_write: () => true,
  servicenow_send_email: () => true,
  servicenow_upsert_artifact: () => true,
};

/**
 * M-7 (B2): the v2 names of destructive tools. Under SN_LEGACY_TOOL_NAMES=1
 * the server still answers to them, so the hook gates them as their v3 name
 * (always — gating a name the server does not know costs nothing). `test/plugin-hook.test.js` pins
 * this map to the server's rename table.
 */
export const LEGACY_TOOL_NAMES = {
  servicenow_change_conflicts: "servicenow_check_change_conflicts",
};

/** The MCP tool name without the client's `mcp__<server>__` prefix. */
export function bareToolName(toolName) {
  if (typeof toolName !== "string") return "";
  const i = toolName.lastIndexOf("__");
  return i === -1 ? toolName : toolName.slice(i + 2);
}

/**
 * The profile the call runs in: the call's own `instance` argument, else the
 * active profile. `undefined` when the hook cannot tell (an `instance` value
 * the server would refuse, or a profile the local config does not define).
 */
function callProfile(input, config) {
  let profile;
  if (typeof input.instance === "string") {
    profile = input.instance.trim().toLowerCase();
    if (!PROFILE_RE.test(profile)) return undefined;
  } else {
    profile = activeProfile(config);
  }
  if (profile !== "default" && !profileNames(config).includes(profile)) {
    return undefined;
  }
  return profile;
}

/**
 * The decision for a call — `{ decision: "deny" | "ask", reason }` — or
 * `undefined` to let it through. `env` is the hook's environment and
 * `fileEnv` the parsed env file; `env` wins, as in the server.
 */
export function hookDecision(event, env = process.env, fileEnv = {}) {
  const bare = bareToolName(event?.tool_name);
  const name = Object.hasOwn(LEGACY_TOOL_NAMES, bare)
    ? LEGACY_TOOL_NAMES[bare]
    : bare;
  const gated = Object.hasOwn(DESTRUCTIVE_TOOLS, name)
    ? DESTRUCTIVE_TOOLS[name]
    : undefined;
  const input = event?.tool_input;
  if (!gated || !input || typeof input !== "object") return undefined;
  if (!gated(input)) return undefined;

  const config = { ...fileEnv, ...env };
  const profile = callProfile(input, config);
  if (!profile) return undefined;
  const policy = writePolicy(config, profile);
  if (policy.readonly || policy.confirm === "off") return undefined;
  const prod = policy.environment === "prod";

  if (policy.mode === "apply") {
    return {
      decision: "ask",
      reason:
        `${name} is destructive and profile "${profile}" runs in apply mode (SN_WRITE_MODE=apply): ` +
        "allowing this call executes the change immediately — with or without apply:true, " +
        "and without a plan preview or plan_token. " +
        (prod
          ? "The profile is marked prod, so the server also asks for confirmation and refuses on a client that cannot prompt."
          : "Allow it only if the user asked for exactly this change."),
    };
  }

  if (input.apply !== true) return undefined; // a plan preview
  if (typeof input.plan_token === "string" && input.plan_token.trim()) {
    return undefined;
  }
  return {
    decision: "deny",
    reason:
      `${name} with apply:true is destructive and needs the plan_token of its plan preview. ` +
      "Call it again without apply, show the user the preview, then repeat the same call " +
      "with apply:true and the plan_token from that preview. " +
      (prod
        ? `(Profile "${profile}" is marked prod: a client that can prompt is also asked to confirm.)`
        : "(SN_DESTRUCTIVE_CONFIRM=off disables this check.)"),
  };
}

/** The reason to deny the call, or `undefined` (an `ask` is not a deny). */
export function denyReason(event, env = process.env, fileEnv = {}) {
  const result = hookDecision(event, env, fileEnv);
  return result?.decision === "deny" ? result.reason : undefined;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let event;
  try {
    event = JSON.parse(await readStdin());
  } catch {
    return; // not a hook event we understand: let the server decide
  }
  const result = hookDecision(
    event,
    process.env,
    readEnvFile(envFilePath(process.env)),
  );
  if (!result) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: result.decision,
        permissionDecisionReason: result.reason,
      },
    }) + "\n",
  );
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    await main();
  } catch {
    // fail open: print nothing and exit 0, so the server decides the call
  }
}
