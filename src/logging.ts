/**
 * Minimal structured logger for an MCP stdio server.
 *
 * A stdio server must never write to stdout (that channel carries the MCP
 * protocol), so every log line is emitted as a single JSON object on stderr.
 * The level is read from SN_LOG_LEVEL (falling back to LOG_LEVEL), defaulting
 * to "info".
 *
 * Never pass secrets (passwords, tokens) or raw encoded queries (which may
 * contain personal data) in the `fields` object.
 */
export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function configuredLevel(): LogLevel {
  const raw = (process.env.SN_LOG_LEVEL ?? process.env.LOG_LEVEL ?? "info")
    .trim()
    .toLowerCase();
  return raw in LEVELS ? (raw as LogLevel) : "info";
}

function emit(
  level: LogLevel,
  message: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVELS[level] > LEVELS[configuredLevel()]) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(fields ?? {}),
  };
  // stderr only — stdout is reserved for the MCP protocol.
  console.error(JSON.stringify(entry));
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
