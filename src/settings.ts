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

/** Per-request timeout in milliseconds (SN_TIMEOUT_MS). */
export function getTimeoutMs(): number {
  return positiveInt("SN_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

/** Retries for transient failures (SN_MAX_RETRIES). Zero is allowed. */
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
