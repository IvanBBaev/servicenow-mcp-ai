// D-8 — the plugin's PreToolUse hook blocks a destructive apply:true without
// a plan_token. Its tool list is pinned to the manifest (every tool whose
// input schema carries plan_token), so a new destructive tool fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DESTRUCTIVE_TOOLS,
  LEGACY_TOOL_NAMES,
  bareToolName,
  denyReason,
  hookDecision,
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
  // PH-9: the matcher names exactly the gated tools (v3 and v2 names) — under
  // an anchored and an unanchored reading of the pattern alike.
  const gated = new Set([
    ...Object.keys(DESTRUCTIVE_TOOLS),
    ...Object.keys(LEGACY_TOOL_NAMES),
  ]);
  const names = new Set([
    ...manifest.tools.map((t) => t.name),
    ...manifest.toolRenames.map((r) => r.from),
  ]);
  for (const matcher of [
    new RegExp(`^(?:${entry.matcher})$`),
    new RegExp(entry.matcher),
  ]) {
    for (const name of names)
      assert.equal(
        matcher.test(`${PREFIX}${name}`),
        gated.has(name),
        `${name}: matcher and hook disagree`,
      );
    assert.ok(matcher.test("mcp__servicenow__servicenow_batch"));
    assert.ok(!matcher.test("servicenow_delete_record"));
    assert.ok(!matcher.test(`${PREFIX}servicenow_delete_record_x`));
    assert.ok(!matcher.test("Bash"));
  }
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

// --- SF-9: the hook against each write policy -------------------------------

const DELETE = {
  tool_name: `${PREFIX}servicenow_delete_record`,
  tool_input: { table: "incident", sys_id: "a".repeat(32), apply: true },
};
const withInput = (extra) => ({
  ...DELETE,
  tool_input: { ...DELETE.tool_input, ...extra },
});

test("hookDecision: apply mode asks, with or without apply:true or a token", () => {
  for (const event of [
    DELETE,
    withInput({ apply: undefined }),
    withInput({ plan_token: "ptabc" }),
  ]) {
    const result = hookDecision(event, { SN_WRITE_MODE: "apply" });
    assert.equal(result?.decision, "ask");
    assert.match(result.reason, /apply mode/);
    assert.match(result.reason, /executes the change immediately/);
    // An ask is not a deny.
    assert.equal(denyReason(event, { SN_WRITE_MODE: "apply" }), undefined);
  }
  // The env file provides the mode just as well; the environment wins.
  assert.equal(
    hookDecision(DELETE, {}, { SN_WRITE_MODE: "apply" })?.decision,
    "ask",
  );
  assert.equal(
    hookDecision(DELETE, { SN_WRITE_MODE: "plan" }, { SN_WRITE_MODE: "apply" })
      ?.decision,
    "deny",
  );
  // A non-destructive call stays silent in apply mode too.
  assert.equal(
    hookDecision(
      { ...DELETE, tool_name: `${PREFIX}servicenow_update_record` },
      { SN_WRITE_MODE: "apply" },
    ),
    undefined,
  );
});

test("hookDecision: prod denies a token-less apply, and ignores SN_DESTRUCTIVE_CONFIRM=off", () => {
  for (const confirm of [undefined, "off", "token"]) {
    const result = hookDecision(DELETE, {
      SN_ENV: "prod",
      SN_DESTRUCTIVE_CONFIRM: confirm,
    });
    assert.equal(result?.decision, "deny", `confirm=${confirm}`);
    assert.match(result.reason, /marked prod/);
  }
  // A token passes; the server checks it.
  assert.equal(
    hookDecision(withInput({ plan_token: "ptabc" }), { SN_ENV: "prod" }),
    undefined,
  );
  // apply on prod without the acknowledgement is held to plan mode: deny.
  assert.equal(
    hookDecision(DELETE, { SN_ENV: "prod", SN_WRITE_MODE: "apply" })?.decision,
    "deny",
  );
  // With the acknowledgement it runs in apply mode: ask, naming the prompt.
  const acked = hookDecision(DELETE, {
    SN_ENV: "prod",
    SN_WRITE_MODE: "apply",
    SN_PROD_WRITES: "I_UNDERSTAND",
    SN_DESTRUCTIVE_CONFIRM: "off",
  });
  assert.equal(acked?.decision, "ask");
  assert.match(acked.reason, /marked prod/);
});

test("hookDecision: SN_DESTRUCTIVE_CONFIRM=off, read-only and unknown profiles are silent", () => {
  for (const confirm of ["off", " OFF "]) {
    assert.equal(
      hookDecision(DELETE, { SN_DESTRUCTIVE_CONFIRM: confirm }),
      undefined,
    );
    assert.equal(
      hookDecision(DELETE, {
        SN_DESTRUCTIVE_CONFIRM: confirm,
        SN_WRITE_MODE: "apply",
      }),
      undefined,
    );
  }
  assert.equal(hookDecision(DELETE, { SN_READONLY: "true" }), undefined);
  assert.equal(
    hookDecision(DELETE, { SN_READONLY: "true", SN_WRITE_MODE: "apply" }),
    undefined,
  );
  // An `instance` the local config does not define, or one the server would
  // refuse: the hook cannot tell the policy, so the server decides.
  assert.equal(hookDecision(withInput({ instance: "nowhere" }), {}), undefined);
  assert.equal(
    hookDecision(withInput({ instance: "bad name!" }), {}),
    undefined,
  );
});

test("hookDecision: the call's `instance` picks that profile's policy", () => {
  const env = {
    SN_PROFILE_SANDBOX_INSTANCE: "sandbox.example.com",
    SN_PROFILE_SANDBOX_WRITE_MODE: "apply",
    SN_PROFILE_LIVE_INSTANCE: "live.example.com",
    SN_PROFILE_LIVE_ENV: "prod",
  };
  assert.equal(
    hookDecision(withInput({ instance: "Sandbox" }), env)?.decision,
    "ask",
  );
  const live = hookDecision(withInput({ instance: "live" }), {
    ...env,
    SN_DESTRUCTIVE_CONFIRM: "off",
  });
  assert.equal(live?.decision, "deny");
  assert.match(live.reason, /Profile "live" is marked prod/);
  // Without `instance`, the active profile decides.
  assert.equal(
    hookDecision(DELETE, { ...env, SN_ACTIVE_PROFILE: "sandbox" })?.decision,
    "ask",
  );
  assert.equal(hookDecision(DELETE, env)?.decision, "deny");
});

test("spawned: the hook reads the env file, asks in apply mode and fails open", () => {
  const dir = mkdtempSync(join(tmpdir(), "sn-hook-"));
  try {
    const file = join(dir, ".env");
    writeFileSync(file, "SN_INSTANCE=dev1\nSN_WRITE_MODE=apply\n");
    const asked = runHook(DELETE, { SN_ENV_FILE: file });
    assert.equal(asked.status, 0, asked.stderr);
    const out = JSON.parse(asked.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "ask");
    assert.match(out.permissionDecisionReason, /apply mode/);

    // The environment wins over the file.
    const denied = runHook(DELETE, {
      SN_ENV_FILE: file,
      SN_WRITE_MODE: "plan",
    });
    assert.equal(
      JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision,
      "deny",
    );

    // An unreadable env file (a directory) reads as no file: plan defaults.
    const unreadable = runHook(DELETE, { SN_ENV_FILE: dir });
    assert.equal(unreadable.status, 0, unreadable.stderr);
    assert.equal(
      JSON.parse(unreadable.stdout).hookSpecificOutput.permissionDecision,
      "deny",
    );

    // PH-10: an error inside the hook (here: writing its decision) prints
    // nothing and exits 0, so the server decides the call.
    const childEnv = {};
    for (const [k, v] of Object.entries(process.env))
      if (!k.startsWith("SN_")) childEnv[k] = v;
    childEnv.SN_ENV_FILE = file;
    const boom =
      "data:text/javascript,JSON.stringify=()=>{throw new Error('boom')}";
    const broken = spawnSync(process.execPath, ["--import", boom, script], {
      input: JSON.stringify(DELETE),
      env: childEnv,
      encoding: "utf8",
    });
    assert.equal(broken.status, 0, broken.stderr);
    assert.equal(broken.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * SF-9: tools whose input schema has `apply` but no `plan_token`. Their
 * writes have no H-3 confirm spec (not destructive), so the PreToolUse hook
 * leaves them to the server's plan/apply gate. Reviewed list: a new tool with
 * `apply` must either carry `plan_token` (and so be gated by the hook) or be
 * added here with a reason.
 */
const NOT_DESTRUCTIVE = "a write without an H-3 confirm spec";
const UNGATED_APPLY_TOOLS = {
  servicenow_create_change: `${NOT_DESTRUCTIVE}: creates a change request`,
  servicenow_create_ci: `${NOT_DESTRUCTIVE}: creates a CMDB CI`,
  servicenow_create_record: `${NOT_DESTRUCTIVE}: creates a record`,
  servicenow_identify_reconcile: `${NOT_DESTRUCTIVE}: IRE create-or-update`,
  servicenow_insert_import_set_row: `${NOT_DESTRUCTIVE}: stages an import row`,
  servicenow_run_atf_suite: `${NOT_DESTRUCTIVE}: runs an ATF suite`,
  servicenow_run_atf_test: `${NOT_DESTRUCTIVE}: runs an ATF test`,
  servicenow_set_property: `${NOT_DESTRUCTIVE}: sets a system property`,
  servicenow_update_change: `${NOT_DESTRUCTIVE}: updates a change request`,
  servicenow_update_ci: `${NOT_DESTRUCTIVE}: updates a CMDB CI`,
  servicenow_update_record: `${NOT_DESTRUCTIVE}: updates a record`,
  servicenow_upload_attachment: `${NOT_DESTRUCTIVE}: adds an attachment`,
  servicenow_upsert_record: `${NOT_DESTRUCTIVE}: creates or updates a record`,
};

test("every tool with `apply` is hook-gated or in the reviewed ungated list", () => {
  const props = (t) => t.inputSchema?.properties ?? {};
  const withApply = manifest.tools.filter((t) => "apply" in props(t));
  assert.ok(withApply.length > 0);
  const ungated = [];
  for (const tool of withApply) {
    if ("plan_token" in props(tool)) {
      assert.ok(
        Object.hasOwn(DESTRUCTIVE_TOOLS, tool.name),
        `${tool.name} carries plan_token but the hook does not gate it`,
      );
      assert.ok(
        !Object.hasOwn(UNGATED_APPLY_TOOLS, tool.name),
        `${tool.name} is gated; drop it from UNGATED_APPLY_TOOLS`,
      );
    } else {
      ungated.push(tool.name);
    }
  }
  assert.deepEqual(
    ungated.sort(),
    Object.keys(UNGATED_APPLY_TOOLS).sort(),
    "a tool with `apply` and no `plan_token` must be reviewed into UNGATED_APPLY_TOOLS",
  );
  // Every gated tool takes `apply`.
  for (const name of Object.keys(DESTRUCTIVE_TOOLS))
    assert.ok(
      withApply.some((t) => t.name === name),
      `${name} has no apply`,
    );
});
