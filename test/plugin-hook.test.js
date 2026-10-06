// D-8 — the plugin's PreToolUse hook blocks a destructive apply:true without
// a plan_token. Its tool list is pinned to the manifest (every tool whose
// input schema carries plan_token), so a new destructive tool fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DESTRUCTIVE_TOOLS,
  LEGACY_TOOL_NAMES,
  bareToolName,
  denyReason,
} from "../hooks/require-plan-token.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "hooks/require-plan-token.mjs");
const manifest = JSON.parse(
  readFileSync(join(root, "test/fixtures/tools-manifest.json"), "utf8"),
);
const PREFIX = "mcp__plugin_servicenow-mcp-ai_servicenow__";
const on = { SN_DESTRUCTIVE_CONFIRM: undefined };

/** A spawned hook sees no SN_* from the developer's shell and no env file. */
function runHook(event, env = {}) {
  const childEnv = {};
  for (const [k, v] of Object.entries(process.env))
    if (!k.startsWith("SN_")) childEnv[k] = v;
  Object.assign(
    childEnv,
    { SN_ENV_FILE: join(root, "test", "fixtures", "no-such-hook.env") },
    env,
  );
  return spawnSync(process.execPath, [script], {
    input: typeof event === "string" ? event : JSON.stringify(event),
    env: childEnv,
    encoding: "utf8",
  });
}

test("the hook's tool list is exactly the manifest's plan_token tools", () => {
  const withToken = manifest.tools
    .filter((t) => "plan_token" in (t.inputSchema?.properties ?? {}))
    .map((t) => t.name)
    .sort();
  assert.ok(withToken.length > 0);
  assert.deepEqual(Object.keys(DESTRUCTIVE_TOOLS).sort(), withToken);
});

test("the hook's legacy names are exactly the manifest's renames of destructive tools (M-7)", () => {
  const expected = Object.fromEntries(
    manifest.toolRenames
      .filter((r) => Object.hasOwn(DESTRUCTIVE_TOOLS, r.to))
      .map((r) => [r.from, r.to]),
  );
  assert.deepEqual(LEGACY_TOOL_NAMES, expected);
  // A v2 name is gated exactly like its v3 name.
  for (const [from, to] of Object.entries(LEGACY_TOOL_NAMES)) {
    const input = { sys_id: "x", calculate: true, apply: true };
    const reason = denyReason(
      { tool_name: `${PREFIX}${from}`, tool_input: input },
      on,
    );
    assert.match(reason, new RegExp(to));
    assert.equal(
      denyReason(
        {
          tool_name: `${PREFIX}${from}`,
          tool_input: { ...input, plan_token: "t" },
        },
        on,
      ),
      undefined,
    );
  }
});

test("hooks.json registers the script as a PreToolUse hook on the server's tools", () => {
  const cfg = JSON.parse(readFileSync(join(root, "hooks/hooks.json"), "utf8"));
  const [entry] = cfg.hooks.PreToolUse;
  const matcher = new RegExp(`^(?:${entry.matcher})$`);
  assert.ok(matcher.test(`${PREFIX}servicenow_delete_record`));
  assert.ok(matcher.test("mcp__servicenow__servicenow_batch"));
  assert.ok(!matcher.test("Bash"));
  assert.match(
    entry.hooks[0].command,
    /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/require-plan-token\.mjs/,
  );
});

test("bareToolName strips the client's mcp__<server>__ prefix", () => {
  assert.equal(
    bareToolName(`${PREFIX}servicenow_send_email`),
    "servicenow_send_email",
  );
  assert.equal(bareToolName("servicenow_batch"), "servicenow_batch");
  assert.equal(bareToolName(undefined), "");
});

test("denyReason: a token-less destructive apply is refused; plans, tokens and reads pass", () => {
  const ev = (name, tool_input) => ({
    tool_name: PREFIX + name,
    tool_input,
  });
  const del = { table: "incident", sys_id: "a".repeat(32) };
  assert.match(
    denyReason(ev("servicenow_delete_record", { ...del, apply: true }), on),
    /plan_token/,
  );
  for (const input of [
    del,
    { ...del, apply: false },
    { ...del, apply: true, plan_token: "ptabc" },
  ]) {
    assert.equal(
      denyReason(ev("servicenow_delete_record", input), on),
      undefined,
    );
  }
  // Not a destructive tool.
  assert.equal(
    denyReason(ev("servicenow_update_record", { ...del, apply: true }), on),
    undefined,
  );
  // A GET-only batch and a read of the conflicts are not gated.
  const get = { method: "GET", url: "/api/now/table/incident" };
  const patch = { method: "PATCH", url: "/api/now/table/incident/x" };
  assert.equal(
    denyReason(ev("servicenow_batch", { requests: [get], apply: true }), on),
    undefined,
  );
  assert.match(
    denyReason(
      ev("servicenow_batch", { requests: [get, patch], apply: true }),
      on,
    ),
    /servicenow_batch/,
  );
  assert.equal(
    denyReason(
      ev("servicenow_check_change_conflicts", { sys_id: "x", apply: true }),
      on,
    ),
    undefined,
  );
  assert.match(
    denyReason(
      ev("servicenow_check_change_conflicts", {
        sys_id: "x",
        calculate: true,
        apply: true,
      }),
      on,
    ),
    /plan_token/,
  );
  // The server's opt-out disables the hook too.
  assert.equal(
    denyReason(ev("servicenow_delete_record", { ...del, apply: true }), {
      SN_DESTRUCTIVE_CONFIRM: " OFF ",
    }),
    undefined,
  );
  // Malformed events pass through (the server still decides).
  assert.equal(denyReason(undefined, on), undefined);
  assert.equal(denyReason({ tool_name: 7, tool_input: null }, on), undefined);
});

test("spawned: the hook prints a PreToolUse deny decision, or nothing", () => {
  const event = {
    hook_event_name: "PreToolUse",
    tool_name: `${PREFIX}servicenow_delete_record`,
    tool_input: { table: "incident", sys_id: "a".repeat(32), apply: true },
  };
  const denied = runHook(event);
  assert.equal(denied.status, 0, denied.stderr);
  const decision = JSON.parse(denied.stdout).hookSpecificOutput;
  assert.equal(decision.hookEventName, "PreToolUse");
  assert.equal(decision.permissionDecision, "deny");
  assert.match(decision.permissionDecisionReason, /plan_token/);

  const withToken = runHook({
    ...event,
    tool_input: { ...event.tool_input, plan_token: "ptabc" },
  });
  assert.equal(withToken.status, 0);
  assert.equal(withToken.stdout, "");

  const optedOut = runHook(event, { SN_DESTRUCTIVE_CONFIRM: "off" });
  assert.equal(optedOut.status, 0);
  assert.equal(optedOut.stdout, "");

  const garbage = runHook("not json");
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, "");
});
