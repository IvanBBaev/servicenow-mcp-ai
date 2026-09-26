/**
 * Numeric runtime settings, all overridable through environment variables.
 * Kept in one place so the HTTP client, auth provider and tool layer read the
 * same values without duplicating parsing/validation logic.
 */

import path from "node:path";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_MAX_RECORDS = 10_000;
export const DEFAULT_MAX_RESULT_CHARS = 100_000;

/** ServiceNow caps a single Table API page at 1000 rows. */
export const MAX_PAGE_SIZE = 1000;

/** Read a positive integer env var, falling back to `fallback` when unset/invalid. */
function positiveInt(envVar: string, fallback: number): number {
  const raw = Number(process.env[envVar]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/**
 * Per-request timeout in milliseconds (SN_TIMEOUT_MS). Like the retry and
 * concurrency knobs below, it governs every REST client in this server —
 * ServiceNow and Jira alike; the SN_ prefix is historical.
 */
export function getTimeoutMs(): number {
  return positiveInt("SN_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

/** Retries for transient failures (SN_MAX_RETRIES, all REST clients). Zero is allowed. */
export function getMaxRetries(): number {
  const raw = Number(process.env.SN_MAX_RETRIES);
  return Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : DEFAULT_MAX_RETRIES;
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
  return process.env.SN_INCLUDE_REF_LINKS?.trim().toLowerCase() === "true";
}

/**
 * Results are compact JSON by default (pretty-printing roughly doubles the
 * tokens of a large payload). Set SN_RESULT_PRETTY=true for readable output.
 */
export function resultPretty(): boolean {
  return process.env.SN_RESULT_PRETTY?.trim().toLowerCase() === "true";
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
  const raw = Number(process.env.SN_SCHEMA_CACHE_TTL_SEC);
  const sec =
    Number.isFinite(raw) && raw >= 0
      ? Math.floor(raw)
      : DEFAULT_SCHEMA_CACHE_TTL_SEC;
  return sec * 1000;
}

/**
 * Opt-in to the Code Search API (`sn_codesearch`) for servicenow_search_code
 * (FT-7). When enabled and the plugin is active, search_code uses the indexed
 * Code Search instead of the LIKE iteration; it falls back to LIKE on any
 * failure. Off by default — the LIKE path is the proven behaviour.
 */
export function useCodeSearch(): boolean {
  return process.env.SN_CODESEARCH?.trim().toLowerCase() === "true";
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
  const names = parseNameList(process.env.SN_TOOL_PACKAGES);
  return names.length > 0 ? names : [DEFAULT_TOOL_PACKAGES];
}

/**
 * Packages excluded outright via SN_PACKAGES_DENY, regardless of what
 * SN_TOOL_PACKAGES enables. Unlike SN_TABLES_DENY (which only guards Table
 * API paths), this removes a whole tool group — including plugin APIs the
 * table policy cannot see (catalog, change, knowledge…).
 */
export function getDeniedPackages(): string[] {
  return parseNameList(process.env.SN_PACKAGES_DENY);
}

/**
 * Packages whose write tools are not registered (SN_PACKAGES_READONLY): the
 * read tools stay, everything without readOnlyHint disappears from the tool
 * list. Complements the global SN_READONLY, per package.
 */
export function getReadOnlyPackages(): string[] {
  return parseNameList(process.env.SN_PACKAGES_READONLY);
}

/**
 * Absolute directory where the self-documentation tools read and write Markdown
 * files (SN_DOCS_DIR). Defaults to `docs/instance` under the current working
 * directory. Relative SN_DOCS_DIR values are resolved against the cwd.
 */
export function getDocsDir(): string {
  const raw = process.env.SN_DOCS_DIR?.trim();
  return raw ? path.resolve(raw) : path.resolve(process.cwd(), "docs/instance");
}

/**
 * Plan-and-apply write mode (DF-2). In "plan" (the default) a write tool returns
 * a structured before/after preview **without** mutating the instance; "apply"
 * executes the change. A tool's own `apply: true` argument forces execution for
 * that one call regardless of the mode. Safe-by-default: an unconfigured server
 * never mutates on the first call.
 */
export function getWriteMode(): "plan" | "apply" {
  return process.env.SN_WRITE_MODE?.trim().toLowerCase() === "apply"
    ? "apply"
    : "plan";
}

/**
 * H-3 — how a destructive apply (`apply:true` on delete_record,
 * delete_attachment, a writing batch, send_email, order_catalog_item,
 * revert_write) is confirmed in plan mode (`SN_DESTRUCTIVE_CONFIRM`):
 * - `off` (default until 3.0): no extra check — today's behaviour;
 * - `token`: the call must carry the `plan_token` of a matching, unexpired,
 *   unused plan preview (`PLAN_REQUIRED` otherwise);
 * - `elicit`: `token`, and a client that supports elicitation is also asked
 *   to confirm (a decline or a failed prompt refuses the write).
 * `SN_WRITE_MODE=apply` (a trusted operator) bypasses all of it.
 */
export function getDestructiveConfirm(): "off" | "token" | "elicit" {
  const v = process.env.SN_DESTRUCTIVE_CONFIRM?.trim().toLowerCase();
  return v === "token" || v === "elicit" ? v : "off";
}

/** H-3 — lifetime of a plan token (`SN_PLAN_TOKEN_TTL_SEC`, default 600, 30–86400). */
export function getPlanTokenTtlSec(): number {
  const n = Number(process.env.SN_PLAN_TOKEN_TTL_SEC);
  return Number.isInteger(n) && n >= 30 && n <= 86_400 ? n : 600;
}

/**
 * S-6 — the update set applied Table-API writes are bound to by default
 * (SN_UPDATE_SET: a sys_update_set sys_id or name; per profile
 * SN_PROFILE_<NAME>_UPDATE_SET). Unset = no binding, the pre-S-6 behaviour.
 */
export function getUpdateSetSetting(profile = "default"): string | undefined {
  const scoped =
    profile !== "default"
      ? process.env[`SN_PROFILE_${profile.toUpperCase()}_UPDATE_SET`]
      : undefined;
  const raw = (scoped?.trim() || process.env.SN_UPDATE_SET)?.trim();
  return raw || undefined;
}

/**
 * DF-5 — field names whose values are masked before any record is serialised for
 * the model (`SN_REDACT_FIELDS`, comma/space-separated). Opt-in: empty = off.
 */
export function getRedactFields(): string[] {
  return (process.env.SN_REDACT_FIELDS ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * DF-5 — when `SN_REDACT_PII` is truthy, also mask values that look like an
 * email, a phone number or a long national-ID digit run, anywhere in a record.
 */
export function redactPII(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.SN_REDACT_PII?.trim() ?? "");
}

/**
 * H-2 — operator opt-out for the credential-change confirmation. By default
 * `servicenow_set_credentials` fails closed whenever the client cannot confirm
 * the change through elicitation (no live server, no `elicitation` capability,
 * or a transport error). A truthy `SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE`
 * lets such a change proceed; an explicit decline is refused regardless.
 */
export function allowUnconfirmedCredentialChange(): boolean {
  return /^(1|true|yes|on)$/i.test(
    process.env.SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE?.trim() ?? "",
  );
}

/**
 * DF-6 — transport selection. Default `stdio` (one local client); `http` listens
 * over Streamable HTTP so the official ServiceNow MCP *Client* app and remote
 * clients can consume it. Securing the endpoint is the operator's job.
 */
export function getTransport(): "stdio" | "http" {
  return process.env.SN_TRANSPORT?.trim().toLowerCase() === "http"
    ? "http"
    : "stdio";
}

/** DF-6 — TCP port for the HTTP transport (`SN_PORT`, default 3000). */
export function getHttpPort(): number {
  const n = Number(process.env.SN_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3000;
}

/**
 * Bind address for the HTTP transport (`SN_HTTP_HOST`). Defaults to loopback
 * (`127.0.0.1`) so the endpoint is not exposed to the network unless the
 * operator opts in (e.g. `0.0.0.0`).
 */
export function getHttpHost(): string {
  return process.env.SN_HTTP_HOST?.trim() || "127.0.0.1";
}

/**
 * Optional bearer token for the HTTP transport (`SN_HTTP_TOKEN`). When set, every
 * HTTP request must carry `Authorization: Bearer <token>`; unset = no auth (only
 * safe behind loopback or an external gateway).
 */
export function getHttpToken(): string | undefined {
  return process.env.SN_HTTP_TOKEN?.trim() || undefined;
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
  return process.env.SN_USER_AGENT_SUFFIX?.trim() || undefined;
}

export const DEFAULT_BREAKER_THRESHOLD = 0;

/**
 * Consecutive failed requests (transport errors, deadlines, 5xx) to one host
 * before its circuit breaker opens (`SN_BREAKER_THRESHOLD`). Opt-in: the
 * default `0` keeps the breaker disabled.
 */
export function getBreakerThreshold(): number {
  const raw = Number(process.env.SN_BREAKER_THRESHOLD);
  return Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : DEFAULT_BREAKER_THRESHOLD;
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
  return !/^(0|false|no|off)$/i.test(
    process.env.SN_CSV_FORMULA_GUARD?.trim() ?? "",
  );
}

/** `SN_CSV_BOM` (default on): prepend a UTF-8 BOM to CSV exports. */
export function csvBom(): boolean {
  return !/^(0|false|no|off)$/i.test(process.env.SN_CSV_BOM?.trim() ?? "");
}

/**
 * S-11 — `SN_OVERSIZE_TO_FILE` (default off): a snapshot, compare or diagram
 * result over SN_MAX_RESULT_CHARS is written to the docs store and returned as
 * `{ path, bytes, preview }` instead of inline. Off, such a result is still
 * returned in full with a `note` naming the overflow and `format:"file"`.
 */
export function oversizeToFile(): boolean {
  return /^(1|true|yes|on)$/i.test(
    process.env.SN_OVERSIZE_TO_FILE?.trim() ?? "",
  );
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
  return parseNameList(process.env.SN_UPLOAD_MIME_ALLOW);
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
 * `servicenow_docs_list` (`SN_DOCS_STALE_DAYS`, default 30 days).
 */
export function getDocsStaleDays(): number {
  return positiveInt("SN_DOCS_STALE_DAYS", DEFAULT_DOCS_STALE_DAYS);
}

export const DEFAULT_DOCS_SEARCH_MAX = 200;

/**
 * Most matches one `servicenow_docs_search` returns (`SN_DOCS_SEARCH_MAX`,
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
  const raw = process.env.SN_LOG_NOTIFY_RATE?.trim();
  if (raw === "0") return 0;
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
  return parseNameList(process.env.SN_EMAIL_ALLOWED_DOMAINS).map((d) =>
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
export function getSdkManagedScopes(): string[] {
  return parseNameList(process.env.SN_SDK_MANAGED_SCOPES);
}

/**
 * P-3 — local directories scanned (bounded, read-only) for ServiceNow SDK
 * projects: each `now.config.json` found declares one scope
 * (`SN_SDK_PROJECT_DIRS`, separated by commas or the platform path delimiter).
 * Relative entries resolve against the working directory; empty = no scan.
 */
export function getSdkProjectDirs(): string[] {
  const raw = process.env.SN_SDK_PROJECT_DIRS?.trim();
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
  return process.env.SN_LOG_FORMAT?.trim().toLowerCase() === "text"
    ? "text"
    : "json";
}

/**
 * Optional log file (`SN_LOG_FILE`): every emitted line is also appended
 * there as JSON Lines, through the same redaction as stderr. Relative paths
 * resolve against the working directory; unset = no file sink.
 */
export function getLogFile(): string | undefined {
  const raw = process.env.SN_LOG_FILE?.trim();
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
  return /^(1|true|yes|on)$/i.test(process.env.SN_METRICS?.trim() ?? "");
}
