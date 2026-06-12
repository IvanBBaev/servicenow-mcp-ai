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

/** Default tool package profile when SN_TOOL_PACKAGES is unset. */
export const DEFAULT_TOOL_PACKAGES = "core";

/**
 * Tool packages/profiles requested via SN_TOOL_PACKAGES (comma or space
 * separated, case-insensitive). Defaults to "core". The registry resolves
 * these names — including the "core" and "all" profiles — into concrete
 * packages and ignores unknown entries.
 */
export function getRequestedPackages(): string[] {
  const raw = process.env.SN_TOOL_PACKAGES?.trim();
  if (!raw) return [DEFAULT_TOOL_PACKAGES];
  const names = raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return names.length > 0 ? names : [DEFAULT_TOOL_PACKAGES];
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
