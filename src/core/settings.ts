/**
 * Runtime settings, all overridable through environment variables.
 * Kept in one place so the HTTP client, auth provider and tool layer read the
 * same values without duplicating parsing/validation logic. Since E-4 every
 * getter reads through the declarative manifest (settings-manifest.ts): the
 * manifest owns the parsing, the profile scoping and the "invalid value"
 * warning; these getters keep their names, defaults and return types.
 */

import path from "node:path";
import { activeProfile } from "./profile.js";
import {
  readBool,
  readEnum,
  readInt,
  readString,
  rawSetting,
  settingSource,
} from "./settings-manifest.js";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_MAX_RECORDS = 10_000;
export const DEFAULT_MAX_RESULT_CHARS = 100_000;

/** ServiceNow caps a single Table API page at 1000 rows. */
export const MAX_PAGE_SIZE = 1000;

/** Read a numeric setting, falling back to `fallback` when unset/invalid. */
function positiveInt(key: string, fallback: number): number {
  return readInt(key) ?? fallback;
}

/**
 * Per-request timeout in milliseconds (SN_TIMEOUT_MS). Like the retry and
 * concurrency knobs below, it governs every REST client in this server —
 * ServiceNow and the OAuth token exchange alike.
 */
export function getTimeoutMs(): number {
  return positiveInt("SN_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

/** Retries for transient failures (SN_MAX_RETRIES, all REST clients). Zero is allowed. */
export function getMaxRetries(): number {
  return positiveInt("SN_MAX_RETRIES", DEFAULT_MAX_RETRIES);
}

/** Hard cap on records returned by a fetchAll query (SN_MAX_RECORDS). */
export function getMaxRecords(): number {
  return positiveInt("SN_MAX_RECORDS", DEFAULT_MAX_RECORDS);
}

/** Maximum characters in a serialised result before it is truncated (SN_MAX_RESULT_CHARS). */
export function getMaxResultChars(): number {
  return positiveInt("SN_MAX_RESULT_CHARS", DEFAULT_MAX_RESULT_CHARS);
}

/**
 * Reference fields normally come back as `{ value, link }`; the link URLs are
 * token ballast for an LLM, so they are excluded by default. Set
 * SN_INCLUDE_REF_LINKS=true to opt back in.
 */
export function includeReferenceLinks(): boolean {
  return readBool("SN_INCLUDE_REF_LINKS");
}

/**
 * Results are compact JSON by default (pretty-printing roughly doubles the
 * tokens of a large payload). Set SN_RESULT_PRETTY=true for readable output.
 */
export function resultPretty(): boolean {
  return readBool("SN_RESULT_PRETTY");
}

export const DEFAULT_MAX_CONCURRENT = 4;

/** Maximum parallel requests per host (SN_MAX_CONCURRENT, all REST clients). */
export function getMaxConcurrent(): number {
  return positiveInt("SN_MAX_CONCURRENT", DEFAULT_MAX_CONCURRENT);
}

export const DEFAULT_SCHEMA_CACHE_TTL_SEC = 300;

/**
 * TTL for the near-static schema reads cache (SN_SCHEMA_CACHE_TTL_SEC, in
 * seconds; 0 disables caching). Invalid values fall back to the default.
 */
export function getSchemaCacheTtlMs(): number {
  return (
    positiveInt("SN_SCHEMA_CACHE_TTL_SEC", DEFAULT_SCHEMA_CACHE_TTL_SEC) * 1000
  );
}

/**
 * Opt-in to the Code Search API (`sn_codesearch`) for servicenow_search_code
 * (FT-7). When enabled and the plugin is active, search_code uses the indexed
 * Code Search instead of the LIKE iteration; it falls back to LIKE on any
 * failure. Off by default — the LIKE path is the proven behaviour.
 */
export function useCodeSearch(): boolean {
  return readBool("SN_CODESEARCH");
}

/** Default tool package profile when SN_TOOL_PACKAGES is unset. */
export const DEFAULT_TOOL_PACKAGES = "core";

/** Parse a comma/space separated, case-insensitive name list from an env var. */
function parseNameList(raw: string | undefined): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [];
  return trimmed
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Tool packages/profiles requested via SN_TOOL_PACKAGES (comma or space
 * separated, case-insensitive). Defaults to "core". The registry resolves
 * these names — including the "core" and "all" profiles — into concrete
 * packages and ignores unknown entries.
 */
export function getRequestedPackages(): string[] {
  const names = parseNameList(rawSetting("SN_TOOL_PACKAGES"));
  return names.length > 0 ? names : [DEFAULT_TOOL_PACKAGES];
}

/**
 * Packages excluded outright via SN_PACKAGES_DENY, regardless of what
 * SN_TOOL_PACKAGES enables. Unlike SN_TABLES_DENY (which only guards Table
 * API paths), this removes a whole tool group — including plugin APIs the
 * table policy cannot see (catalog, change, knowledge…).
 */
export function getDeniedPackages(): string[] {
  return parseNameList(rawSetting("SN_PACKAGES_DENY"));
}

/**
 * Packages whose write tools are not registered (SN_PACKAGES_READONLY): the
 * read tools stay, everything without readOnlyHint disappears from the tool
 * list. Complements the global SN_READONLY, per package.
 */
export function getReadOnlyPackages(): string[] {
  return parseNameList(rawSetting("SN_PACKAGES_READONLY"));
}

/**
 * Absolute directory where the self-documentation tools read and write Markdown
 * files (SN_DOCS_DIR). Defaults to `docs/instance` under the current working
 * directory. Relative SN_DOCS_DIR values are resolved against the cwd.
 */
export function getDocsDir(): string {
  const raw = readString("SN_DOCS_DIR");
  return raw ? path.resolve(raw) : path.resolve(process.cwd(), "docs/instance");
}

/**
 * H-11 (L3-03) — the environment a profile is marked as
 * (`SN_PROFILE_<NAME>_ENV`, or `SN_ENV` for the default profile). Unset = not
 * marked (every pre-H-11 profile). A `prod` profile gets: plan mode unless
 * acknowledged (see getWriteMode), mandatory confirmation of destructive
 * applies (getDestructiveConfirm), `_meta.environment` on results and a
 * warning when it becomes active.
 */
export type ProfileEnv = "prod" | "test" | "dev";

export function getProfileEnv(
  profile: string = activeProfile(),
): ProfileEnv | undefined {
  return readEnum<ProfileEnv>("SN_ENV", { profile });
}

/** The acknowledgement a prod profile needs before apply mode takes effect. */
export const PROD_WRITES_ACK = "I_UNDERSTAND";

/**
 * The configured write mode of a profile: `SN_PROFILE_<NAME>_WRITE_MODE`
 * (H-11), falling back to `SN_WRITE_MODE`.
 */
function configuredWriteMode(profile: string): "plan" | "apply" {
  return readEnum<"plan" | "apply">("SN_WRITE_MODE", { profile }) ?? "plan";
}

/**
 * H-11: why a profile configured for apply runs in plan mode (a prod profile
 * without `SN_PROFILE_<NAME>_PROD_WRITES=I_UNDERSTAND`), or undefined.
 */
export function writeModeHold(
  profile: string = activeProfile(),
): string | undefined {
  if (configuredWriteMode(profile) !== "apply") return undefined;
  if (getProfileEnv(profile) !== "prod") return undefined;
  const ack = readEnum("SN_PROD_WRITES", { profile });
  if (ack === PROD_WRITES_ACK) return undefined;
  const key = settingSource("SN_PROD_WRITES", { profile });
  return `Profile "${profile}" is marked prod, so it stays in plan mode although apply is configured; set ${key}=${PROD_WRITES_ACK} to allow apply mode.`;
}

/**
 * Plan-and-apply write mode (DF-2). In "plan" (the default) a write tool returns
 * a structured before/after preview **without** mutating the instance; "apply"
 * executes the change. A tool's own `apply: true` argument forces execution for
 * that one call regardless of the mode. Safe-by-default: an unconfigured server
 * never mutates on the first call. H-11: per profile
 * (`SN_PROFILE_<NAME>_WRITE_MODE`), and a prod profile stays in plan mode
 * until acknowledged (writeModeHold).
 */
export function getWriteMode(
  profile: string = activeProfile(),
): "plan" | "apply" {
  if (writeModeHold(profile)) return "plan";
  return configuredWriteMode(profile);
}

/**
 * H-3 — how a destructive apply (`apply:true` on delete_record,
 * delete_attachment, a writing batch, send_email, order_catalog_item,
 * revert_write, upsert_artifact, check_change_conflicts with calculate) is
 * confirmed (`SN_DESTRUCTIVE_CONFIRM`):
 * - `token` (the 3.0 default, B4): in plan mode the call must carry the
 *   `plan_token` of a matching, unexpired, unused plan preview
 *   (`PLAN_REQUIRED` otherwise);
 * - `off`: no extra check — the explicit opt-out (the pre-3.0 behaviour);
 * - `elicit`: `token`, and a client that supports elicitation is also asked
 *   to confirm (a decline or a failed prompt refuses the write).
 * Apply mode (a trusted operator) bypasses it — except on a prod profile
 * (H-11), which is always at least `elicit` and is confirmed in apply mode
 * too (confirm.ts).
 */
export function getDestructiveConfirm(
  profile: string = activeProfile(),
): "off" | "token" | "elicit" {
  if (getProfileEnv(profile) === "prod") return "elicit";
  return (
    readEnum<"off" | "token" | "elicit">("SN_DESTRUCTIVE_CONFIRM") ?? "token"
  );
}

/** H-3 — lifetime of a plan token (`SN_PLAN_TOKEN_TTL_SEC`, default 600, 30–86400). */
export function getPlanTokenTtlSec(): number {
  return positiveInt("SN_PLAN_TOKEN_TTL_SEC", 600);
}

/**
 * H-4 — what a Batch API sub-request whose path maps to no tool package gets
 * (`SN_BATCH_UNMAPPED`): `deny` (the 3.0 default, B8) refuses it, so a new
 * plugin API cannot slip past SN_PACKAGES_DENY / SN_PACKAGES_READONLY inside
 * a batch; `allow` (the opt-out) checks it against the table and read-only
 * axes only.
 */
export function getBatchUnmapped(): "allow" | "deny" {
  return readEnum<"allow" | "deny">("SN_BATCH_UNMAPPED") ?? "deny";
}

/** H-4 — most sub-requests one batch may carry (`SN_BATCH_MAX_REQUESTS`, 1–1000, default 50 since 3.0). */
export function getBatchMaxRequests(): number {
  return positiveInt("SN_BATCH_MAX_REQUESTS", DEFAULT_BATCH_MAX_REQUESTS);
}

/**
 * H-11 (L3-02) — per-session write caps. A session is the runtime container
 * (the process on stdio, one MCP session over HTTP). An explicit `0` means
 * no cap; unset takes the 3.0 default (GAP L3-02, O-4): 500 writes per HTTP
 * session (none on stdio), 100 deletes per session, 50 write sub-requests
 * per batch.
 */
export const DEFAULT_MAX_WRITES_PER_HTTP_SESSION = 500;
export const DEFAULT_MAX_DELETES_PER_SESSION = 100;
export const DEFAULT_MAX_BATCH_WRITES = 50;
export const DEFAULT_BATCH_MAX_REQUESTS = 50;

/**
 * Applied instance writes per session (`SN_MAX_WRITES_PER_SESSION`; a batch
 * counts its write sub-requests). `httpSession` picks the unset default: 500
 * for an HTTP session, no cap for the stdio process.
 */
export function getMaxWritesPerSession(httpSession = false): number {
  return positiveInt(
    "SN_MAX_WRITES_PER_SESSION",
    httpSession ? DEFAULT_MAX_WRITES_PER_HTTP_SESSION : 0,
  );
}

/** Applied deletes per session (`SN_MAX_DELETES_PER_SESSION`, default 100; `0` = no cap). */
export function getMaxDeletesPerSession(): number {
  return positiveInt(
    "SN_MAX_DELETES_PER_SESSION",
    DEFAULT_MAX_DELETES_PER_SESSION,
  );
}

/** Write (non-GET) sub-requests in one batch (`SN_MAX_BATCH_WRITES`, default 50; `0` = no cap). */
export function getMaxBatchWrites(): number {
  return positiveInt("SN_MAX_BATCH_WRITES", DEFAULT_MAX_BATCH_WRITES);
}

/**
 * S-6 — the update set applied Table-API writes are bound to by default
 * (SN_UPDATE_SET: a sys_update_set sys_id or name; per profile
 * SN_PROFILE_<NAME>_UPDATE_SET). Unset = no binding, the pre-S-6 behaviour.
 */
export function getUpdateSetSetting(profile = "default"): string | undefined {
  return readString("SN_UPDATE_SET", { profile });
}

/**
 * DF-5 — field names whose values are masked before any record is serialised for
 * the model (`SN_REDACT_FIELDS`, comma/space-separated). Opt-in: empty = off.
 */
export function getRedactFields(): string[] {
  return (rawSetting("SN_REDACT_FIELDS") ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * DF-5 — when `SN_REDACT_PII` is truthy, also mask values that look like an
 * email, a phone number or a long national-ID digit run, anywhere in a record.
 */
export function redactPII(): boolean {
  return readBool("SN_REDACT_PII");
}

/**
 * H-2 — operator opt-out for the credential-change confirmation. By default
 * `servicenow_set_credentials` fails closed whenever the client cannot confirm
 * the change through elicitation (no live server, no `elicitation` capability,
 * or a transport error). A truthy `SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE`
 * lets such a change proceed; an explicit decline is refused regardless.
 */
export function allowUnconfirmedCredentialChange(): boolean {
  return readBool("SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE");
}

/**
 * DF-6 — transport selection. Default `stdio` (one local client); `http` listens
 * over Streamable HTTP so the official ServiceNow MCP *Client* app and remote
 * clients can consume it. Securing the endpoint is the operator's job.
 */
export function getTransport(): "stdio" | "http" {
  return readEnum<"stdio" | "http">("SN_TRANSPORT") ?? "stdio";
}

/** DF-6 — TCP port for the HTTP transport (`SN_PORT`, default 3000). */
export function getHttpPort(): number {
  return positiveInt("SN_PORT", 3000);
}

/**
 * Bind address for the HTTP transport (`SN_HTTP_HOST`). Defaults to loopback
 * (`127.0.0.1`) so the endpoint is not exposed to the network unless the
 * operator opts in (e.g. `0.0.0.0`).
 */
export function getHttpHost(): string {
  return readString("SN_HTTP_HOST") ?? "127.0.0.1";
}

/**
 * Optional bearer token for the HTTP transport (`SN_HTTP_TOKEN`). When set, every
 * HTTP request must carry `Authorization: Bearer <token>`; unset = no auth (only
 * safe behind loopback or an external gateway).
 */
export function getHttpToken(): string | undefined {
  return readString("SN_HTTP_TOKEN");
}

// ---------------------------------------------------------------------------
// H-7 — HTTP transport v2 (sessions, DNS-rebinding protection, keep-alive)
// ---------------------------------------------------------------------------

export const DEFAULT_HTTP_SESSION_TTL_SEC = 1800;
export const DEFAULT_HTTP_KEEPALIVE_MS = 25_000;
export const DEFAULT_HTTP_MAX_SESSIONS = 64;

/** A non-negative integer env var (0 is meaningful), else `fallback`. */
function nonNegativeInt(envVar: string, fallback: number): number {
  const raw = process.env[envVar]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Idle TTL of an HTTP session in seconds (`SN_HTTP_SESSION_TTL_SEC`, default
 * 1800). A session with no request for that long is closed and its runtime
 * disposed; `0` keeps sessions until the client sends DELETE.
 */
export function getHttpSessionTtlSec(): number {
  return nonNegativeInt(
    "SN_HTTP_SESSION_TTL_SEC",
    DEFAULT_HTTP_SESSION_TTL_SEC,
  );
}

/**
 * Interval of the SSE keep-alive comment on an open stream
 * (`SN_HTTP_KEEPALIVE_MS`, default 25000) — below the usual 30–60 s idle
 * timeout of proxies and load balancers. `0` disables it.
 */
export function getHttpKeepAliveMs(): number {
  return nonNegativeInt("SN_HTTP_KEEPALIVE_MS", DEFAULT_HTTP_KEEPALIVE_MS);
}

/** Cap on concurrent HTTP sessions (`SN_HTTP_MAX_SESSIONS`, default 64). */
export function getHttpMaxSessions(): number {
  return positiveInt("SN_HTTP_MAX_SESSIONS", DEFAULT_HTTP_MAX_SESSIONS);
}

/**
 * The `Host` header values the HTTP transport accepts (`SN_HTTP_ALLOWED_HOSTS`,
 * comma/space separated, case-insensitive; an entry without a port matches
 * any port). Empty = the transport's default (loopback names on a loopback
 * bind, no check otherwise).
 */
export function getHttpAllowedHosts(): string[] {
  return parseNameList(process.env.SN_HTTP_ALLOWED_HOSTS);
}

/**
 * The browser `Origin` values the HTTP transport accepts
 * (`SN_HTTP_ALLOWED_ORIGINS`, e.g. `https://app.example.com`; `*` = any).
 * Empty = loopback origins only. A request without an Origin header (a
 * non-browser client) is never refused by this check.
 */
export function getHttpAllowedOrigins(): string[] {
  return parseNameList(process.env.SN_HTTP_ALLOWED_ORIGINS);
}

/**
 * Refuse to start the HTTP transport on a non-loopback bind without
 * `SN_HTTP_TOKEN` (`SN_HTTP_REQUIRE_TOKEN=1`). Off by default in 2.x — the
 * server only warns; planned to become the default in 3.0 (O-4, B6).
 */
export function httpRequireToken(): boolean {
  return /^(1|true|yes|on)$/i.test(
    process.env.SN_HTTP_REQUIRE_TOKEN?.trim() ?? "",
  );
}

// ---------------------------------------------------------------------------
// E-9 — bounded schema cache
// ---------------------------------------------------------------------------

export const DEFAULT_SCHEMA_CACHE_MAX = 256;

/**
 * Maximum number of entries in the schema reads cache (SN_SCHEMA_CACHE_MAX).
 * Once full, the least-recently-used entry is evicted on insert. Invalid or
 * non-positive values fall back to the default.
 */
export function getSchemaCacheMax(): number {
  return positiveInt("SN_SCHEMA_CACHE_MAX", DEFAULT_SCHEMA_CACHE_MAX);
}

// --- H-10: HTTP client resilience + identity ------------------------------

export const DEFAULT_RETRY_AFTER_MAX_MS = 60_000;

/**
 * Cap for a server-supplied Retry-After (`SN_RETRY_AFTER_MAX_MS`, default 60 s).
 * A hostile or buggy header asking for an hour must not hang a tool call.
 */
export function getRetryAfterMaxMs(): number {
  return positiveInt("SN_RETRY_AFTER_MAX_MS", DEFAULT_RETRY_AFTER_MAX_MS);
}

export const DEFAULT_DEADLINE_FLOOR_MS = 120_000;

/**
 * Total budget for one logical request across every attempt, backoff and
 * re-auth (`SN_DEADLINE_MS`). Defaults to max(120000, 2 × SN_TIMEOUT_MS) so the
 * worst case stays within what an MCP client's tool timeout tolerates.
 */
export function getDeadlineMs(): number {
  return positiveInt(
    "SN_DEADLINE_MS",
    Math.max(DEFAULT_DEADLINE_FLOOR_MS, 2 * getTimeoutMs()),
  );
}

export const DEFAULT_MAX_QUEUE = 64;

/**
 * Maximum callers waiting for a per-host concurrency slot (`SN_MAX_QUEUE`). A
 * caller that would exceed it fails immediately with code BUSY instead of
 * piling up behind a stalled instance.
 */
export function getMaxQueue(): number {
  return positiveInt("SN_MAX_QUEUE", DEFAULT_MAX_QUEUE);
}

/**
 * How long a caller waits for a per-host slot before giving up with BUSY
 * (`SN_QUEUE_TIMEOUT_MS`, default = SN_TIMEOUT_MS).
 */
export function getQueueTimeoutMs(): number {
  return positiveInt("SN_QUEUE_TIMEOUT_MS", getTimeoutMs());
}

/** Free-form suffix appended to the User-Agent header (`SN_USER_AGENT_SUFFIX`). */
export function getUserAgentSuffix(): string | undefined {
  return readString("SN_USER_AGENT_SUFFIX");
}

export const DEFAULT_BREAKER_THRESHOLD = 0;

/**
 * Consecutive failed requests (transport errors, deadlines, 5xx) to one host
 * before its circuit breaker opens (`SN_BREAKER_THRESHOLD`). Opt-in: the
 * default `0` keeps the breaker disabled.
 */
export function getBreakerThreshold(): number {
  return positiveInt("SN_BREAKER_THRESHOLD", DEFAULT_BREAKER_THRESHOLD);
}

export const DEFAULT_BREAKER_RESET_MS = 30_000;

/**
 * How long an open breaker rejects requests with CIRCUIT_OPEN before letting a
 * trial request through (`SN_BREAKER_RESET_MS`, default 30 s).
 */
export function getBreakerResetMs(): number {
  return positiveInt("SN_BREAKER_RESET_MS", DEFAULT_BREAKER_RESET_MS);
}

// --- H-5: write journal v2 ------------------------------------------------

export const DEFAULT_JOURNAL_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Size at which the write journal rotates (`SN_JOURNAL_MAX_BYTES`, default
 * 20 MiB): the current `write-journal.jsonl` is renamed to
 * `write-journal.<ISO-time>.jsonl` and a fresh file continues the hash chain.
 */
export function getJournalMaxBytes(): number {
  return positiveInt("SN_JOURNAL_MAX_BYTES", DEFAULT_JOURNAL_MAX_BYTES);
}

// --- H-5: CSV export safety (L2-01) -----------------------------------------

/**
 * `SN_CSV_FORMULA_GUARD` (default on): prefix formula-like CSV text cells with
 * `'` so a spreadsheet never evaluates them. `0`/`false`/`no`/`off` opts out.
 */
export function csvFormulaGuard(): boolean {
  return readBool("SN_CSV_FORMULA_GUARD");
}

/** `SN_CSV_BOM` (default on): prepend a UTF-8 BOM to CSV exports. */
export function csvBom(): boolean {
  return readBool("SN_CSV_BOM");
}

/**
 * S-11 — `SN_OVERSIZE_TO_FILE` (default off): a snapshot, compare or diagram
 * result over SN_MAX_RESULT_CHARS is written to the docs store and returned as
 * `{ path, bytes, preview }` instead of inline. Off, such a result is still
 * returned in full with a `note` naming the overflow and `format:"file"`.
 */
export function oversizeToFile(): boolean {
  return readBool("SN_OVERSIZE_TO_FILE");
}

// --- H-6: outbound hardening ------------------------------------------------

export const DEFAULT_MAX_BODY_BYTES = 50 * 1024 * 1024;

/**
 * Largest response body any REST client buffers (`SN_MAX_BODY_BYTES`, default
 * 50 MiB). Checked against `Content-Length` before reading and enforced while
 * streaming, so an oversized or endless body is refused before it is held in
 * memory — SN_MAX_RESULT_CHARS only applies after buffering.
 */
export function getMaxBodyBytes(): number {
  return positiveInt("SN_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES);
}

export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Largest attachment upload (`SN_MAX_UPLOAD_BYTES`, default 10 MiB of decoded
 * content). Checked on the base64 length before anything is decoded.
 */
export function getMaxUploadBytes(): number {
  return positiveInt("SN_MAX_UPLOAD_BYTES", DEFAULT_MAX_UPLOAD_BYTES);
}

/**
 * Optional allow-list of upload content types (`SN_UPLOAD_MIME_ALLOW`, comma
 * or space separated, case-insensitive). An entry is an exact type
 * (`text/plain`) or a type wildcard (`image/*`). Empty = any type.
 */
export function getUploadMimeAllow(): string[] {
  return parseNameList(rawSetting("SN_UPLOAD_MIME_ALLOW"));
}

export const DEFAULT_DOCS_MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Size cap for one document in the local docs store (`SN_DOCS_MAX_FILE_BYTES`,
 * default 5 MiB): a larger write is refused, a larger file is read truncated
 * and skipped by search.
 */
export function getDocsMaxFileBytes(): number {
  return positiveInt("SN_DOCS_MAX_FILE_BYTES", DEFAULT_DOCS_MAX_FILE_BYTES);
}

export const DEFAULT_DOCS_STALE_DAYS = 30;

/**
 * Age after which a generated document is reported `stale` by
 * `servicenow_list_docs` (`SN_DOCS_STALE_DAYS`, default 30 days).
 */
export function getDocsStaleDays(): number {
  return positiveInt("SN_DOCS_STALE_DAYS", DEFAULT_DOCS_STALE_DAYS);
}

export const DEFAULT_DOCS_SEARCH_MAX = 200;

/**
 * Most matches one `servicenow_search_docs` returns (`SN_DOCS_SEARCH_MAX`,
 * default 200); a capped result says `truncated: true`.
 */
export function getDocsSearchMax(): number {
  return positiveInt("SN_DOCS_SEARCH_MAX", DEFAULT_DOCS_SEARCH_MAX);
}

export const DEFAULT_DIAGRAM_MAX_NODES = 200;

/**
 * Node cap for one generated Mermaid diagram (`SN_DIAGRAM_MAX_NODES`, default
 * 200). Nodes past the cap fold into a single "+N more" node, so a huge table
 * still renders.
 */
export function getDiagramMaxNodes(): number {
  return positiveInt("SN_DIAGRAM_MAX_NODES", DEFAULT_DIAGRAM_MAX_NODES);
}

export const DEFAULT_LOG_NOTIFY_RATE = 20;

/**
 * M-8 (GAP L5-05): log notifications per second one client session receives
 * over the MCP logging capability (`SN_LOG_NOTIFY_RATE`, default 20; burst
 * the larger of 50 and the rate). Lines over it are counted and reported in
 * one "suppressed" warning per minute; stderr is never throttled. `0` turns
 * the limit off.
 */
export function getLogNotifyRate(): number {
  return positiveInt("SN_LOG_NOTIFY_RATE", DEFAULT_LOG_NOTIFY_RATE);
}

/**
 * Recipient domains `servicenow_send_email` may address
 * (`SN_EMAIL_ALLOWED_DOMAINS`, comma or space separated, case-insensitive). An
 * entry matches the domain exactly or as a parent (`example.com` allows
 * `mail.example.com`); `*` allows any recipient. Empty = only addresses that
 * belong to a user in the instance's own directory (`sys_user.email`).
 */
export function getEmailAllowedDomains(): string[] {
  return parseNameList(rawSetting("SN_EMAIL_ALLOWED_DOMAINS")).map((d) =>
    d.replace(/^@|^\*\.|^\./, ""),
  );
}

// --- S-13: capability preflight v2 ------------------------------------------

export const DEFAULT_CAPABILITY_TTL_MS = 10 * 60_000;

/**
 * How long a *positive* capability probe result is reused
 * (`SN_CAPABILITY_TTL_MS`, default 10 min): a group probed as available, and a
 * plugin API seen answering, are not re-probed before it expires.
 */
export function getCapabilityTtlMs(): number {
  return positiveInt("SN_CAPABILITY_TTL_MS", DEFAULT_CAPABILITY_TTL_MS);
}

export const DEFAULT_PLUGIN_NEGATIVE_TTL_MS = 60_000;

/**
 * How long a *negative* result is cached (`SN_PLUGIN_NEGATIVE_TTL_MS`, default
 * 60 s): a plugin namespace 404, or a capability probe answered with an HTTP
 * error (401/403/404/5xx). Short on purpose — a transient 503 must not poison
 * the session. Transport errors (no HTTP status) are never cached.
 */
export function getPluginNegativeTtlMs(): number {
  return positiveInt(
    "SN_PLUGIN_NEGATIVE_TTL_MS",
    DEFAULT_PLUGIN_NEGATIVE_TTL_MS,
  );
}

/**
 * P-3 — the owner's declaration of SDK-managed application scopes
 * (`SN_SDK_MANAGED_SCOPES`, comma or space separated, case-insensitive). An
 * entry is a scope namespace (`x_acme_app`) or a `sys_scope` sys_id. It is the
 * highest source of authority for `detectSdkManaged` (pending gate O-6).
 */
/**
 * P-22 — what a write into an SDK-managed scope (P-3 detection) gets
 * (`SN_SDK_MANAGED_WRITES`): `warn` (default in 3.x) previews and applies with
 * an `sdkManaged` warning; `deny` refuses the apply with SDK_MANAGED_SCOPE
 * (the proposed 4.0 default); `allow` skips the check.
 */
export function getSdkManagedWrites(): "allow" | "warn" | "deny" {
  return readEnum<"allow" | "warn" | "deny">("SN_SDK_MANAGED_WRITES") ?? "warn";
}

export function getSdkManagedScopes(): string[] {
  return parseNameList(rawSetting("SN_SDK_MANAGED_SCOPES"));
}

/**
 * P-3 — local directories scanned (bounded, read-only) for ServiceNow SDK
 * projects: each `now.config.json` found declares one scope
 * (`SN_SDK_PROJECT_DIRS`, separated by commas or the platform path delimiter).
 * Relative entries resolve against the working directory; empty = no scan.
 */
export function getSdkProjectDirs(): string[] {
  const raw = readString("SN_SDK_PROJECT_DIRS");
  if (!raw) return [];
  const dirs = raw
    .split(new RegExp(`[,${path.delimiter === ";" ? ";" : ":"}]`))
    .map((s) => s.trim())
    .filter(Boolean)
    .map((d) => path.resolve(d));
  return [...new Set(dirs)];
}

// --- E-5: observability -----------------------------------------------------

/**
 * Line format of the stderr log (`SN_LOG_FORMAT`): `json` (the default, one
 * JSON object per line — unchanged behaviour) or `text`
 * (`HH:MM:SS level message key=value …`, easier to read in a client's log
 * panel). Anything else falls back to `json`.
 */
export function getLogFormat(): "json" | "text" {
  return readEnum<"json" | "text">("SN_LOG_FORMAT") ?? "json";
}

/**
 * Optional log file (`SN_LOG_FILE`): every emitted line is also appended
 * there as JSON Lines, through the same redaction as stderr. Relative paths
 * resolve against the working directory; unset = no file sink.
 */
export function getLogFile(): string | undefined {
  const raw = readString("SN_LOG_FILE");
  return raw ? path.resolve(raw) : undefined;
}

export const DEFAULT_LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Rotated log files kept next to `SN_LOG_FILE` (`<file>.1` … `<file>.5`). */
export const LOG_FILE_KEEP = 5;

/**
 * Size at which `SN_LOG_FILE` rotates (`SN_LOG_FILE_MAX_BYTES`, default
 * 10 MiB): the file becomes `<file>.1`, older generations shift up and the
 * oldest past `LOG_FILE_KEEP` is deleted.
 */
export function getLogFileMaxBytes(): number {
  return positiveInt("SN_LOG_FILE_MAX_BYTES", DEFAULT_LOG_FILE_MAX_BYTES);
}

/**
 * Opt-in Prometheus endpoint (`SN_METRICS`, truthy = on): `GET /metrics` on
 * the HTTP transport. It is served only when `SN_HTTP_TOKEN` is also set —
 * the scrape must carry the same bearer token as every other request.
 */
export function metricsEnabled(): boolean {
  return readBool("SN_METRICS");
}

/**
 * N-55 — opt-in OpenTelemetry subscriber (`SN_OTEL`, truthy = on): the
 * diagnostics_channel events become spans through the optional peer
 * dependency `@opentelemetry/api` (core/otel.ts).
 */
export function otelEnabled(): boolean {
  return readBool("SN_OTEL");
}

/**
 * N-55 — opt-in W3C `traceparent` / `tracestate` headers on outbound
 * ServiceNow REST requests (`SN_OTEL_PROPAGATE`, truthy = on). Off by
 * default: the client's trace ids are not sent to the instance.
 */
export function otelPropagate(): boolean {
  return readBool("SN_OTEL_PROPAGATE");
}

/** N-10: record-watch poll interval (SN_RECORD_WATCH_INTERVAL_MS, floor 30 s). */
export const RECORD_WATCH_FLOOR_MS = 30_000;
export function getRecordWatchIntervalMs(): number {
  return Math.max(
    RECORD_WATCH_FLOOR_MS,
    positiveInt("SN_RECORD_WATCH_INTERVAL_MS", RECORD_WATCH_FLOOR_MS),
  );
}

/** N-10: record watches one session may hold (SN_RECORD_WATCH_MAX_PER_SESSION). */
export function getRecordWatchMaxPerSession(): number {
  return positiveInt("SN_RECORD_WATCH_MAX_PER_SESSION", 10);
}

/** N-10: record watches across the process (SN_RECORD_WATCH_MAX). */
export function getRecordWatchMax(): number {
  return positiveInt("SN_RECORD_WATCH_MAX", 50);
}
