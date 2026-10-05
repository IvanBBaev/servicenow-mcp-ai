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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const PROFILE_RE = /^[a-z0-9_]+$/;
const ENVIRONMENTS = new Set(["prod", "test", "dev"]);
const PROD_WRITES_ACK = "I_UNDERSTAND";

/** The env file the server reads (SN_ENV_FILE, else the XDG path). */
export function envFilePath(env = process.env) {
  const explicit = env.SN_ENV_FILE?.trim();
  if (explicit) return explicit;
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "servicenow-mcp-ai", ".env");
}

/** The parsed env file, or `{}` when it is missing or unreadable. */
export function readEnvFile(path) {
  try {
    if (!path || !existsSync(path)) return {};
    return parseEnv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function clean(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * A setting as the server resolves it for `profile`. `override`: a non-default
 * profile's SN_PROFILE_<NAME>_<X> wins, else SN_<X>. `isolated`: the default
 * profile reads only SN_<X>, any other profile only SN_PROFILE_<NAME>_<X>.
 */
function setting(config, suffix, profile, scope) {
  const scoped =
    profile === "default"
      ? undefined
      : clean(config[`SN_PROFILE_${profile.toUpperCase()}_${suffix}`]);
  if (scope === "isolated") {
    return profile === "default" ? clean(config[`SN_${suffix}`]) : scoped;
  }
  return scoped ?? clean(config[`SN_${suffix}`]);
}

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

/** The profile names the config defines (`default` when SN_INSTANCE is set). */
export function profileNames(config) {
  const names = new Set();
  if (clean(config.SN_INSTANCE)) names.add("default");
  for (const key of Object.keys(config)) {
    const m = /^SN_PROFILE_([A-Z0-9_]+)_INSTANCE$/.exec(key);
    if (m && clean(config[key])) names.add(m[1].toLowerCase());
  }
  return [...names].sort();
}

/**
 * The context line for the session, or `undefined` when there is no
 * ServiceNow config at all. `env` wins over `fileEnv`, as in the server.
 * Only allowlisted, non-secret keys are read.
 */
export function sessionContext(env = {}, fileEnv = {}) {
  const config = { ...fileEnv, ...env };
  if (!Object.keys(config).some((k) => k.startsWith("SN_"))) return undefined;

  const requested = clean(config.SN_ACTIVE_PROFILE)?.toLowerCase();
  const profile =
    requested && PROFILE_RE.test(requested) ? requested : "default";
  const host = instanceHost(setting(config, "INSTANCE", profile, "isolated"));
  const environment = setting(
    config,
    "ENV",
    profile,
    "isolated",
  )?.toLowerCase();
  const marked = ENVIRONMENTS.has(environment) ? environment : undefined;
  const configured =
    setting(config, "WRITE_MODE", profile, "override")?.toLowerCase() ===
    "apply"
      ? "apply"
      : "plan";
  const held =
    configured === "apply" &&
    marked === "prod" &&
    setting(config, "PROD_WRITES", profile, "isolated") !== PROD_WRITES_ACK;
  const readonly = TRUTHY.has(
    setting(config, "READONLY", profile, "override")?.toLowerCase() ?? "",
  );

  const parts = [
    `active profile \`${profile}\`` +
      (host ? ` → ${host}` : " (no instance configured)") +
      (marked ? ` [${marked}]` : ""),
  ];
  if (readonly) {
    parts.push("read-only (SN_READONLY): every write is refused");
  } else if (held) {
    parts.push(
      "write mode plan — apply is configured but held, the profile is prod without SN_PROD_WRITES=I_UNDERSTAND",
    );
  } else if (configured === "apply") {
    parts.push(
      "write mode apply — writes execute; destructive ones still need the plan_token of a preview",
    );
  } else {
    parts.push(
      "write mode plan — writes return a preview and a plan_token; nothing changes until a call repeats with apply:true",
    );
  }
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
