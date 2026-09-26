import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { redactValue } from "./redaction.js";
import {
  getLogFile,
  getLogFileMaxBytes,
  getLogFormat,
  LOG_FILE_KEEP,
} from "./settings.js";

/**
 * E-5 / L7-01 — the logger's output shaping: the stderr line format
 * (`SN_LOG_FORMAT`), the redaction every sink shares and the optional
 * size-rotated file sink (`SN_LOG_FILE`).
 *
 * The file sink is deliberately stateless: each line is appended with a
 * synchronous open-append-close, and the size check reads the file's current
 * length, so there is no descriptor to own, leak or dispose and a line is on
 * disk before the (possibly crashing) caller continues. Log volume is low
 * (one line per tool call, a few per failing request), so the extra syscalls
 * do not matter. A write failure disables the sink for the rest of the
 * process and says so once on stderr — logging must never throw.
 */

export interface LogEntry {
  ts: string;
  level: string;
  message: string;
  [key: string]: unknown;
}

/**
 * Keys whose value is a credential by name. The logger's contract is that
 * callers never pass secrets; this is the backstop, applied to every sink.
 */
const SECRET_KEY_RE =
  /^(password|passwd|secret|client_secret|token|access_token|refresh_token|id_token|authorization|api_?key|x-sn-apikey|cookie)$/i;

const MASK = "***";

/**
 * Redact a log entry's fields: credential-named keys (at any depth) are
 * masked, and the result-boundary rules (`SN_REDACT_FIELDS`, `SN_REDACT_PII`)
 * apply on top. Returns the input unchanged when nothing matched.
 */
export function redactLogFields(
  fields: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!fields) return fields;
  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || typeof v !== "object" || depth > 8) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(v)) {
      out[k] =
        SECRET_KEY_RE.test(k) && inner != null && inner !== ""
          ? MASK
          : walk(inner, depth + 1);
    }
    return out;
  };
  const masked = walk(fields, 0) as Record<string, unknown>;
  return redactValue(masked).value;
}

/** Local wall-clock `HH:MM:SS` of an ISO timestamp (text format prefix). */
function clock(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** One `key=value` pair; strings with spaces/quotes and objects are JSON. */
function pair(key: string, value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") {
    return /^[^\s"=]+$/.test(value)
      ? `${key}=${value}`
      : `${key}=${JSON.stringify(value)}`;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return `${key}=${value}`;
  }
  return `${key}=${JSON.stringify(value) ?? "null"}`;
}

/** Render an entry for stderr in the configured `SN_LOG_FORMAT`. */
export function formatLogLine(entry: LogEntry): string {
  if (getLogFormat() !== "text") return JSON.stringify(entry);
  const { ts, level, message, ...fields } = entry;
  const rest = Object.entries(fields)
    .map(([k, v]) => pair(k, v))
    .filter(Boolean)
    .join(" ");
  return `${clock(ts)} ${level.padEnd(5)} ${message}${rest ? ` ${rest}` : ""}`;
}

/** Set after a write failure: the file sink stays off for this process. */
let fileSinkFailed: string | null = null;

/** Size of `file` in bytes, 0 when it does not exist yet. */
function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Shift `<file>.N` → `<file>.N+1` (dropping the oldest past LOG_FILE_KEEP)
 * and move the live file to `<file>.1`.
 */
export function rotateLogFile(file: string): void {
  rmSync(`${file}.${LOG_FILE_KEEP}`, { force: true });
  for (let n = LOG_FILE_KEEP - 1; n >= 1; n--) {
    try {
      renameSync(`${file}.${n}`, `${file}.${n + 1}`);
    } catch {
      // That generation does not exist (yet).
    }
  }
  renameSync(file, `${file}.1`);
}

/**
 * Append one entry to `SN_LOG_FILE` as a JSON line, rotating first when the
 * line would push the file past `SN_LOG_FILE_MAX_BYTES`. No-op when the sink
 * is not configured (or has failed). Never throws.
 */
export function writeLogFile(entry: LogEntry): void {
  const file = getLogFile();
  if (!file || fileSinkFailed === file) return;
  const line = `${JSON.stringify(entry)}\n`;
  try {
    const size = sizeOf(file);
    if (size > 0 && size + Buffer.byteLength(line) > getLogFileMaxBytes()) {
      rotateLogFile(file);
    } else if (size === 0) {
      mkdirSync(path.dirname(file), { recursive: true });
    }
    appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    fileSinkFailed = file;
    // stderr only — stdout is reserved for the MCP protocol.
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        message: "SN_LOG_FILE sink disabled after a write failure",
        file,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
