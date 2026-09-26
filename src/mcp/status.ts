import { accessSync, constants, existsSync } from "node:fs";
import {
  getCredentials,
  hasCredentials,
  activeProfile,
  listProfiles,
  credentialStatus,
  getEnvPath,
} from "../core/config.js";
import {
  getAuthMode,
  credentialWarnings,
  refreshTokenState,
} from "../core/auth.js";
import {
  getWriteMode,
  getProfileEnv,
  writeModeHold,
  getDestructiveConfirm,
  getTransport,
  getHttpHost,
  getHttpPort,
  getHttpToken,
  getDocsDir,
  getRedactFields,
  redactPII,
  getMaxRecords,
  getMaxResultChars,
  getMaxBodyBytes,
  getMaxUploadBytes,
  getMaxConcurrent,
  getMaxQueue,
  getQueueTimeoutMs,
  getMaxRetries,
  getTimeoutMs,
  getDeadlineMs,
  getRetryAfterMaxMs,
} from "../core/settings.js";
import { currentRequestProfile } from "../core/request-context.js";
import { getWriteCaps, getWriteCounters } from "../core/write-journal.js";
import {
  isReadOnly,
  getAllowedTables,
  getDeniedTables,
} from "../core/policy.js";
import { effectivePackages } from "./registry.js";
import { currentPackageSession } from "./packages.js";
import { pluginAvailability } from "../api/plugin.js";
import { getTelemetry } from "../core/http.js";
import { getSchemaCacheStats } from "../core/cache.js";
import { getQueueStats } from "../core/http-util.js";
import {
  describeDispatcher,
  TLS_VERIFY_OFF_WARNING,
} from "../core/dispatcher.js";
import { userAgent, SERVER_VERSION } from "../core/identity.js";
import { resolveHost } from "../core/host.js";
import { sdkManagedStatus } from "../core/artifacts/sdk-managed.js";
import { observabilityPayload } from "./observability.js";

/**
 * The outbound HTTP policy as the operator should see it (H-10): the exact
 * User-Agent, which proxy carries the traffic (source variable and host, never
 * credentials), the TLS posture and the per-host queue occupancy.
 */
export function httpStatusPayload(instance: string) {
  let host = "";
  try {
    host = instance ? resolveHost(instance) : "";
  } catch {
    host = "";
  }
  const policy = describeDispatcher(host);
  // H-6 / SEC-16: a weakened transport is surfaced, not only logged once.
  const warnings: string[] = [];
  if (policy.tls.verify === "off") warnings.push(TLS_VERIFY_OFF_WARNING);
  return {
    userAgent: userAgent(),
    proxy: policy.proxy,
    tls: policy.tls,
    queue: getQueueStats(),
    warnings,
  };
}

/** The MCP server name, shared by the implementation info and get_status. */
export const SERVER_NAME = "servicenow-mcp-ai";

/**
 * M-1 / L4-04 — the process itself: version, pid, uptime, Node and the
 * transport. For HTTP the bind address is shown and only *whether* a bearer
 * token guards it — never the token.
 */
export function serverStatusPayload() {
  const uptimeSec = Math.round(process.uptime());
  const transport = getTransport();
  return {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    pid: process.pid,
    uptimeSec,
    startedAt: new Date(Date.now() - uptimeSec * 1000).toISOString(),
    node: process.versions.node,
    transport,
    ...(transport === "http"
      ? {
          http: {
            host: getHttpHost(),
            port: getHttpPort(),
            tokenSet: Boolean(getHttpToken()),
          },
        }
      : {}),
  };
}

/**
 * M-1 — the effective write posture as one line the model can act on:
 * read-only wins, else plan (preview only) or apply.
 */
export function policySummary(): string {
  if (isReadOnly()) return "read-only: every write tool is refused";
  return getWriteMode() === "apply"
    ? "apply: write tools execute (journalled)"
    : "plan: write tools preview only; pass apply:true or set SN_WRITE_MODE=apply";
}

function docsStatus() {
  const dir = getDocsDir();
  const exists = existsSync(dir);
  let writable: boolean | null = null;
  if (exists) {
    try {
      accessSync(dir, constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
  }
  return { dir, exists, writable };
}

/**
 * M-1 / L3-02 — where the active profile comes from: a per-call `instance`
 * argument, SN_ACTIVE_PROFILE (process env or the env file), or the default.
 * The env file is named by path and existence only, never read back.
 */
function profileSource() {
  const envFile = getEnvPath();
  const source = currentRequestProfile()
    ? "request"
    : process.env.SN_ACTIVE_PROFILE?.trim()
      ? "SN_ACTIVE_PROFILE"
      : "default";
  return {
    active: activeProfile(),
    source,
    envFile,
    envFileExists: existsSync(envFile),
  };
}

/** M-1 — the effective numeric limits (bytes, ms, counts). */
function limitsPayload() {
  return {
    maxRecords: getMaxRecords(),
    maxResultChars: getMaxResultChars(),
    maxBodyBytes: getMaxBodyBytes(),
    maxUploadBytes: getMaxUploadBytes(),
    maxConcurrent: getMaxConcurrent(),
    maxQueue: getMaxQueue(),
    queueTimeoutMs: getQueueTimeoutMs(),
    maxRetries: getMaxRetries(),
    timeoutMs: getTimeoutMs(),
    deadlineMs: getDeadlineMs(),
    retryAfterMaxMs: getRetryAfterMaxMs(),
  };
}

/**
 * The single source of the connection-status payload, shared by the
 * servicenow_get_status tool and the servicenow://status resource so the two
 * can never drift apart. The password is never included.
 */
export function buildStatusPayload() {
  const c = getCredentials();
  const session = currentPackageSession();
  // M-5: the live session set once a client toggled packages.
  const packages = {
    ...effectivePackages(),
    ...(session?.modified() ? { enabled: session.enabledPackages() } : {}),
  };
  return {
    configured: hasCredentials(),
    activeProfile: activeProfile(),
    profiles: listProfiles(),
    instance: c.instance || "(not set)",
    user: c.user || "(not set)",
    passwordSet: Boolean(c.password),
    authMode: getAuthMode(),
    // D-2: bearer-token expiry, an in-memory refresh token, env-file ACLs.
    authWarnings: credentialWarnings(),
    readOnly: isReadOnly(),
    allowedTables: getAllowedTables(),
    deniedTables: getDeniedTables(),
    enabledPackages: packages.enabled,
    deniedPackages: packages.denied,
    readOnlyPackages: packages.readOnly,
    // Plugin APIs observed this session: available / unavailable / unknown.
    pluginApis: pluginAvailability(),
    // In-process counters since startup: why is it slow / what is failing.
    telemetry: getTelemetry(),
    // E-9: bounded LRU schema cache — size vs. cap and hit/miss/eviction counters.
    schemaCache: getSchemaCacheStats(),
    // Outbound identity, proxy/TLS posture and queue occupancy.
    http: httpStatusPayload(c.instance),
    // P-3: scopes the local sources declare SDK-managed (no instance call).
    sdkManaged: sdkManagedStatus(),
    // E-5: per-tool latency, cache, retries, queue, breakers and rate limits.
    observability: observabilityPayload(),
    // M-1 (status v2, additive) — TLS / proxy / queue stay under `http`,
    // cache stats under `schemaCache`, rate limits under `observability`.
    server: serverStatusPayload(),
    writeMode: getWriteMode(),
    policy: {
      writeMode: getWriteMode(),
      // H-3: how a destructive apply is confirmed in plan mode.
      destructiveConfirm: getDestructiveConfirm(),
      readOnly: isReadOnly(),
      summary: policySummary(),
    },
    redaction: {
      enabled: getRedactFields().length > 0 || redactPII(),
      fields: getRedactFields().length,
      pii: redactPII(),
    },
    docs: docsStatus(),
    limits: limitsPayload(),
    writes: { ...getWriteCounters(), caps: getWriteCaps() },
    profileSource: profileSource(),
    // Per-profile auth mode / write mode / missing keys (`profiles` stays the
    // name list until the O-4 breaking window).
    profileDetails: profilesPayload().profiles,
  };
}

/**
 * The single source of the profile inventory, shared by the
 * servicenow_list_instances tool and the servicenow://instances resource
 * (MI-8). Passwords are never included.
 */
export function profilesPayload() {
  const active = activeProfile();
  const profiles = listProfiles().map((name) => {
    const c = getCredentials(name);
    const status = credentialStatus(name);
    const readOnly = isReadOnly(name);
    return {
      name,
      active: name === active,
      instance: c.instance || "(not set)",
      user: c.user || "(not set)",
      readOnly,
      hasCredentials: status.configured,
      // L8-01: how the profile authenticates — presence flags only, no secrets.
      auth: status.mode,
      ...(status.grant ? { grant: status.grant } : {}),
      refreshToken: refreshTokenState(name),
      writeMode: readOnly ? "read-only" : getWriteMode(name),
      // H-11 (L3-03): the environment marker and why apply mode is held.
      ...(getProfileEnv(name) ? { env: getProfileEnv(name) } : {}),
      ...(writeModeHold(name) ? { writeModeHold: writeModeHold(name) } : {}),
      ...(status.missing.length ? { missing: status.missing } : {}),
    };
  });
  return { count: profiles.length, activeProfile: active, profiles };
}
