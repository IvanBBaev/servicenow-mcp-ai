#!/usr/bin/env node
// N-48 — Claude Code plugin SessionStart hook: tell the assistant, before its
// first ServiceNow call, which profile is active, which instance host it
// points at, and whether writes preview (plan) or execute (apply).
//
// Local config only: the process environment plus the server's env file
// (SN_ENV_FILE, else $XDG_CONFIG_HOME/servicenow-mcp-ai/.env), parsed with
// Node's own parser — no network call, no dependency, no server start. It
// reads a fixed allowlist of non-secret keys and prints nothing else: no user
// name, password, token or client secret ever reaches the output. The server
// the client launches may run with a different environment, so the context
// says that `servicenow_get_status` is authoritative. Any error — a missing or
// unreadable file, a malformed value — prints nothing and exits 0.
import { pathToFileURL } from "node:url";

import {
  activeProfile,
  clean,
  envFilePath,
  profileNames,
  readEnvFile,
  setting,
  writePolicy,
} from "./sn-config.mjs";

export { envFilePath, profileNames, readEnvFile };

/** The bare host of an instance value (`dev1`, a host, or a URL); no userinfo. */
export function instanceHost(raw) {
  const value = clean(raw);
  if (!value) return undefined;
  let host;
  try {
    host = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
      ? new URL(value).hostname
      : new URL("https://" + value).hostname;
  } catch {
    return undefined;
  }
  host = host.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) return undefined;
  return host.includes(".") ? host : `${host}.service-now.com`;
}

/** Comma-separated package names, reduced to safe characters. */
function packageList(raw) {
  const value = clean(raw);
  if (!value) return undefined;
  const names = value
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter((n) => /^[a-z0-9_*-]+$/.test(n));
  return names.length > 0 ? names.join(", ") : undefined;
}

/**
 * What a write does under the profile's write policy, mirroring the server's
 * gate (src/mcp/confirm.ts): in apply mode nothing is previewed and no
 * plan_token is involved — a prod profile confirms a destructive write in a
 * client prompt instead; in plan mode a destructive apply also needs the
 * preview's plan_token unless SN_DESTRUCTIVE_CONFIRM=off (ignored on prod).
 */
function writeModeSentence({ readonly, held, configured, confirm, marked }) {
  if (readonly) return "read-only (SN_READONLY): every write is refused";
  if (configured === "apply" && !held) {
    return marked === "prod"
      ? "write mode apply on a prod profile — writes execute immediately, without a preview or plan_token, but a destructive one is confirmed in a client prompt and refused on a client that cannot prompt"
      : "write mode apply — every write executes immediately, destructive ones included, without a preview or plan_token";
  }
  const mode = held
    ? "write mode plan — apply is configured but held, the profile is prod without SN_PROD_WRITES=I_UNDERSTAND"
    : "write mode plan";
  const destructive =
    confirm === "off"
      ? "a destructive one needs no plan_token (SN_DESTRUCTIVE_CONFIRM=off)"
      : confirm === "elicit"
        ? "a destructive one also needs the preview's plan_token and is confirmed in a client prompt when the client can prompt"
        : "a destructive one also needs the preview's plan_token";
  return `${mode} — writes return a preview, nothing changes until a call repeats with apply:true, ${destructive}`;
}

/**
 * The context line for the session, or `undefined` when there is no
 * ServiceNow config at all. `env` wins over `fileEnv`, as in the server.
 * Only allowlisted, non-secret keys are read.
 */
export function sessionContext(env = {}, fileEnv = {}) {
  const config = { ...fileEnv, ...env };
  if (!Object.keys(config).some((k) => k.startsWith("SN_"))) return undefined;

  const profile = activeProfile(config);
  const host = instanceHost(setting(config, "INSTANCE", profile, "isolated"));
  const {
    environment: marked,
    configured,
    held,
    readonly,
    confirm,
  } = writePolicy(config, profile);

  const parts = [
    `active profile \`${profile}\`` +
      (host ? ` → ${host}` : " (no instance configured)") +
      (marked ? ` [${marked}]` : ""),
  ];
  parts.push(
    writeModeSentence({ readonly, held, configured, confirm, marked }),
  );
  parts.push(
    `tool packages: ${packageList(config.SN_TOOL_PACKAGES) ?? "core"}`,
  );
  const denied = packageList(config.SN_PACKAGES_DENY);
  if (denied) parts.push(`denied packages: ${denied}`);
  const others = profileNames(config).filter((n) => n !== profile);
  if (others.length > 0) {
    parts.push(
      `other profiles: ${others.join(", ")} (switch with servicenow_use_instance)`,
    );
  }

  return (
    `ServiceNow MCP (local config): ${parts.join("; ")}. ` +
    "The server the client launches may see a different environment — servicenow_get_status is authoritative."
  );
}

async function main() {
  // The event on stdin (source, cwd) does not change the answer; drain it so
  // the client never sees a broken pipe.
  try {
    for await (const chunk of process.stdin) void chunk;
  } catch {
    // ignore
  }
  const text = sessionContext(process.env, readEnvFile(envFilePath()));
  if (!text) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: text,
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
    // fail silently: a SessionStart hook must never break a session
  }
}
