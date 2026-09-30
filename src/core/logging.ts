/**
 * Minimal structured logger for an MCP stdio server.
 *
 * A stdio server must never write to stdout (that channel carries the MCP
 * protocol), so every log line is emitted as a single JSON object on stderr.
 * The level is read from SN_LOG_LEVEL (falling back to LOG_LEVEL), defaulting
 * to "info".
 *
 * Inside a tool call every line also carries the call's correlation fields
 * (M-3): `profile`, `requestId`, `sessionId` (HTTP only) and `tool` — see
 * logContext() in request-context.ts. Explicit `fields` win on a clash.
 *
 * Never pass secrets (passwords, tokens) or raw encoded queries (which may
 * contain personal data) in the `fields` object.
 *
 * E-5 (L7-01): `SN_LOG_FORMAT=text` switches the stderr line to
 * `HH:MM:SS level message key=value …` (JSON stays the default);
 * `SN_LOG_FILE` adds a size-rotated JSON Lines file sink. Every sink receives
 * the same redacted fields — credential-named keys are masked and the
 * `SN_REDACT_FIELDS` / `SN_REDACT_PII` rules apply (see log-file.ts).
 */
import { logContext } from "./request-context.js";
import { formatLogLine, redactLogFields, writeLogFile } from "./log-file.js";
import { readEnum } from "./settings-manifest.js";

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function configuredLevel(): LogLevel {
  // E-4: SN_LOG_LEVEL, then the legacy LOG_LEVEL alias, through the manifest.
  return readEnum<LogLevel>("SN_LOG_LEVEL") ?? "info";
}

/** Optional secondary sink (e.g. the MCP logging capability). */
export type LogSink = (
  level: LogLevel,
  message: string,
  fields?: Record<string, unknown>,
) => void;

let sink: LogSink | null = null;

/** Attach/detach a secondary sink; it must never throw into the logger. */
export function setLogSink(next: LogSink | null): void {
  sink = next;
}

function emit(
  level: LogLevel,
  message: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVELS[level] > LEVELS[configuredLevel()]) return;
  const context = logContext();
  const merged = redactLogFields(
    context ? { ...context, ...(fields ?? {}) } : fields,
  );
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(merged ?? {}),
  };
  // stderr only — stdout is reserved for the MCP protocol.
  console.error(formatLogLine(entry));
  writeLogFile(entry);
  try {
    sink?.(level, message, merged);
  } catch {
    // A failing sink must never break (or recurse into) logging.
  }
}

export const logger = {
  error: (message: string, fields?: Record<string, unknown>) =>
    emit("error", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) =>
    emit("warn", message, fields),
  info: (message: string, fields?: Record<string, unknown>) =>
    emit("info", message, fields),
  debug: (message: string, fields?: Record<string, unknown>) =>
    emit("debug", message, fields),
};
