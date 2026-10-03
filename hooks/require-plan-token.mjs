#!/usr/bin/env node
// D-8 — Claude Code plugin PreToolUse hook: refuse a destructive `apply:true`
// that carries no `plan_token` before the call reaches the server.
//
// The server enforces the same rule (H-3, SN_DESTRUCTIVE_CONFIRM=token is the
// 3.0 default, B4); the hook makes the assistant see the refusal at the
// client, with the next step, instead of after a round-trip. It only reads
// the tool input: a token is checked for presence, never for validity (the
// server does that). Anything it does not understand passes through, so a
// broken hook can never block a call the server would allow.
//
// Escape hatch: SN_DESTRUCTIVE_CONFIRM=off in the environment Claude Code
// runs in (the same opt-out the server honours) disables the hook.
import { pathToFileURL } from "node:url";

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
 * (always — the hook cannot see the server's environment, and gating a name
 * the server does not know costs nothing). `test/plugin-hook.test.js` pins
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
 * The reason to deny the call, or `undefined` to let it through.
 * `env` is the hook's environment (only SN_DESTRUCTIVE_CONFIRM is read).
 */
export function denyReason(event, env = process.env) {
  if ((env.SN_DESTRUCTIVE_CONFIRM ?? "").trim().toLowerCase() === "off") {
    return undefined;
  }
  const bare = bareToolName(event?.tool_name);
  const name = Object.hasOwn(LEGACY_TOOL_NAMES, bare)
    ? LEGACY_TOOL_NAMES[bare]
    : bare;
  const gated = Object.hasOwn(DESTRUCTIVE_TOOLS, name)
    ? DESTRUCTIVE_TOOLS[name]
    : undefined;
  const input = event?.tool_input;
  if (!gated || !input || typeof input !== "object") return undefined;
  if (input.apply !== true || !gated(input)) return undefined;
  if (typeof input.plan_token === "string" && input.plan_token.trim()) {
    return undefined;
  }
  return (
    `${name} with apply:true is destructive and needs the plan_token of its plan preview. ` +
    "Call it again without apply, show the user the preview, then repeat the same call " +
    "with apply:true and the plan_token from that preview. " +
    "(SN_DESTRUCTIVE_CONFIRM=off disables this check.)"
  );
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
  const reason = denyReason(event);
  if (!reason) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }) + "\n",
  );
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await main();
}
