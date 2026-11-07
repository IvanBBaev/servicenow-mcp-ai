import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, userInfo } from "node:os";
import path from "node:path";
import {
  getDocsDir,
  getJournalKey,
  getJournalMaxBytes,
  getMaxDeletesPerSession,
  getMaxWritesPerSession,
  journalRequired,
} from "./settings.js";
import { activeProfile } from "./config.js";
import {
  currentCall,
  currentClient,
  currentSession,
  currentTool,
} from "./request-context.js";
import { redactValue, redactionRules } from "./redaction.js";
import { peekSecretColumns } from "./secret-index.js";
import { ServiceNowError } from "./errors.js";
import { logger } from "./logging.js";
import { currentRuntime, defineRuntimePart, type Runtime } from "./runtime.js";

/**
 * DF-2 — local, append-only audit trail for every applied write.
 *
 * The official MCP Server Console has AI Control Tower for audit and metering;
 * this client-side server has no such backstop, so every mutation it actually
 * executes is journalled locally under the docs directory, per profile. The
 * journal is written best-effort: a file-system failure is logged but never
 * blocks or fails the write that already happened on the instance.
 *
 * H-5 (journal v2) — every line carries `schema_version: 2`, a ULID `id`, the
 * outcome (`result`), the pre-write state (`before`) where the tool could read
 * it, the MCP session (`client`, HTTP mode) and `prev`, the sha256 of the
 * previous line: the chain head lives in `write-journal.head`, so an edited or
 * truncated journal is detectable. The JSONL file rotates at
 * SN_JOURNAL_MAX_BYTES with the chain continued across files; the Markdown
 * mirror is re-rendered from the latest entries rather than appended. Values in
 * `fields`, `before` and `error` go through the same redaction as tool results.
 * v1 lines (no `schema_version`) stay valid and are read with defaults.
 *
 * S-2 (journal-based revert) adds four optional fields, still schema 2: the
 * `tool` that wrote the line (stamped from the request context), the record's
 * `after_mod_count` right after a create/update (the drift baseline), and on a
 * revert's own line `reverts` (the reverted entry id) and `force`.
 *
 * N-109 (GV-I2), still schema 2: SN_JOURNAL_REQUIRED makes the journal fail
 * closed (an instance write is refused with JOURNAL_UNAVAILABLE when the
 * journal cannot be written); SN_JOURNAL_KEY adds an HMAC over the chain
 * (`prev_mac` per line, `write-journal.head.mac` for the head), so editing a
 * line and re-chaining the plain sha256 links no longer goes unnoticed. Files
 * are created 0600 in a 0700 directory; a stdio line also records the OS user,
 * the host and the MCP client (`os_user`, `host`, `client_name`), and every
 * appended line is mirrored as an `audit` log event.
 */

export const JOURNAL_SCHEMA_VERSION = 2;

/**
 * Instance mutations (`create`…`execute`), plus two local kinds (L2-04):
 * `local_write` for files written under the docs directory and `config` for
 * env-file changes by the admin tools. Local kinds are never revertible
 * against the instance.
 */
export type WriteAction =
  | "create"
  | "update"
  | "delete"
  | "execute"
  | "local_write"
  | "config";

/** `refused` = a 403 (local policy guard or instance ACL); `failed` = any other error. */
export type WriteResult = "applied" | "failed" | "refused";

export interface JournalEntry {
  /** 2 on every line this version writes; absent (read as 1) on v1 lines. */
  schema_version?: number;
  /** ULID — sortable, unique per line. */
  id?: string;
  ts: string;
  profile: string;
  action: WriteAction;
  table: string;
  sys_id?: string;
  /** The field values sent (create/update); omitted for delete. */
  fields?: Record<string, unknown>;
  /** Record state before an update/delete (plan read or apply-time pre-read). */
  before?: unknown;
  /** Outcome; v1 lines only recorded applied writes, so they read as `applied`. */
  result?: WriteResult;
  /** The error message of a failed/refused write. */
  error?: string;
  /** H-3: the plan token the apply consumed (SN_DESTRUCTIVE_CONFIRM=token|elicit). */
  plan_token?: string;
  /** S-6: sys_id of the update set an applied write was bound to (`update_set` / SN_UPDATE_SET). */
  update_set?: string;
  /** MCP session id of the calling client (HTTP transport only). */
  client?: string;
  /** N-17: the OAuth subject the call was authorized as (HTTP + SN_HTTP_OAUTH_ISSUER only). */
  subject?: string;
  /** Links the per-sub-request lines of one batch to its envelope line (L2-03). */
  batch_id?: string;
  /**
   * P-23: links the per-record lines of one `servicenow_upsert_artifact` apply
   * (parent first, then the children in order). Unlike `batch_id`, each line
   * stays revertible on its own.
   */
  artifact_write?: string;
  /** HTTP method of a batch sub-request. */
  method?: string;
  /** sha256 of a batch sub-request body as sent. */
  body_sha256?: string;
  /** Local target: the file of a `local_write` (`docs/<relPath>`), or the env profile of a `config` entry (`env:<profile>`). */
  target?: string;
  bytes?: number;
  /** sha256 of the local file content written. */
  sha256?: string;
  /** Env key names changed by a `config` entry — names only, never values. */
  keys?: string[];
  /** The tool that made the write (S-2; absent on lines written before it). */
  tool?: string;
  /**
   * `sys_mod_count` of the record right after an applied create/update, when
   * the API returned it — the baseline S-2's revert compares for drift.
   */
  after_mod_count?: number;
  /** On a revert's own line: the id of the entry it reverts (S-2). */
  reverts?: string;
  /** On a revert's own line: the drift check was overridden with `force:true`. */
  force?: boolean;
  /** H-11: the call was refused by a session write cap (WRITE_CAP). */
  cap_hit?: boolean;
  /** N-109: the OS user that ran the server (stdio only). */
  os_user?: string;
  /** N-109: the host the server ran on (stdio only). */
  host?: string;
  /** N-109: the MCP client, `name/version` from its initialize request. */
  client_name?: string;
  /** sha256 of the previous journal line (absent on the first line / v1 lines). */
  prev?: string;
  /** N-109: HMAC-SHA256 of `prev` (or "" on the first line) under SN_JOURNAL_KEY. */
  prev_mac?: string;
}

/** What a caller supplies; the journal stamps the rest. */
export type JournalInput = Omit<
  JournalEntry,
  "schema_version" | "id" | "ts" | "profile" | "prev" | "prev_mac"
>;

const JSONL = "write-journal.jsonl";
const HEAD = "write-journal.head";
const HEAD_MAC = "write-journal.head.mac";
/** N-109: the journal is private to the user that runs the server. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MARKDOWN = "write-journal.md";
const ROTATED = /^write-journal\.(.+?)(?:-(\d+))?\.jsonl$/;

/**
 * Order rotated files oldest first: by stamp, then by the collision counter a
 * same-millisecond rotation appends (`<stamp>` before `<stamp>-1`), which a
 * plain string sort would get backwards ('-' sorts before '.').
 */
function byRotation(a: string, b: string): number {
  const [, sa = "", na = "0"] = ROTATED.exec(a) ?? [];
  const [, sb = "", nb = "0"] = ROTATED.exec(b) ?? [];
  return sa === sb ? Number(na) - Number(nb) : sa < sb ? -1 : 1;
}

/** Entries the Markdown mirror shows (the JSONL file stays complete). */
const MARKDOWN_ENTRIES = 200;
/** Bytes read from the end of the JSONL file to render the mirror. */
const MARKDOWN_TAIL_BYTES = 1024 * 1024;

export function sha256Hex(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** N-109: the keyed link of the chain. */
function hmacHex(key: string, text: string): string {
  return createHmac("sha256", key).update(text).digest("hex");
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 48-bit millisecond time + 80 random bits, Crockford base32. */
export function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (const b of bytes) rand += CROCKFORD.charAt(b % 32);
  return time + rand;
}

function journalDir(profile: string): string {
  return path.join(getDocsDir(), profile);
}

/** N-109: profile directories whose existing journal files were tightened. */
const tightenedPart = defineRuntimePart(
  "write-journal-modes",
  () => new Set<string>(),
  undefined,
  {
    scope: "process",
  },
);

/**
 * Create the profile directory 0700 and, once per directory and process,
 * chmod journal files an earlier version created with the default umask to
 * 0600. The directory itself is left alone when it already exists — it also
 * holds generated documentation.
 */
function ensureJournalDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const done = currentRuntime().get(tightenedPart);
  if (done.has(dir)) return;
  done.add(dir);
  for (const f of readdirSync(dir)) {
    if (
      f !== HEAD &&
      f !== HEAD_MAC &&
      f !== MARKDOWN &&
      f !== JSONL &&
      !ROTATED.test(f)
    ) {
      continue;
    }
    try {
      chmodSync(path.join(dir, f), FILE_MODE);
    } catch {
      // swallowed: a file we cannot chmod (e.g. owned by another user) stays as it is
    }
  }
}

/**
 * N-109: with SN_JOURNAL_REQUIRED, refuse before anything is sent when the
 * journal directory or its files cannot be written.
 */
function assertJournalReady(): void {
  if (!journalRequired()) return;
  const dir = journalDir(activeProfile());
  try {
    ensureJournalDir(dir);
    accessSync(dir, fsConstants.W_OK);
    for (const f of [JSONL, HEAD, HEAD_MAC]) {
      const file = path.join(dir, f);
      if (existsSync(file)) accessSync(file, fsConstants.W_OK);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    emitAudit("apply_denied", { code: "JOURNAL_UNAVAILABLE" });
    throw new ServiceNowError(
      `The write journal cannot be written (${reason}); SN_JOURNAL_REQUIRED=true refuses instance writes until it can.`,
      503,
      undefined,
      {
        code: "JOURNAL_UNAVAILABLE",
        hint: `Nothing was sent. Make ${dir} writable for this user, or point SN_DOCS_DIR at a writable directory.`,
      },
    );
  }
}

/**
 * N-109 — one structured `audit` log line (stderr, SN_LOG_FILE and the MCP log
 * bridge), for a SIEM to collect: `journal` for every journal line,
 * `policy_change` for a package toggle and `apply_denied` for a refused apply.
 * The shape is pinned by `test/fixtures/audit-event.schema.json`.
 */
export type AuditAction = "journal" | "policy_change" | "apply_denied";

export function emitAudit(
  action: AuditAction,
  fields: Record<string, unknown> = {},
): void {
  const tool = currentTool();
  logger.info("audit", {
    event: { kind: "audit", action },
    profile: activeProfile(),
    ...(tool ? { tool } : {}),
    ...fields,
  });
}

/** N-109: how to read this session's MCP client (`name/version`). */
const clientNamePart = defineRuntimePart("journal-client", () => ({
  read: undefined as (() => string | undefined) | undefined,
}));

/** Register the reader of the session's MCP client name for the journal. */
export function setJournalClientName(
  read: () => string | undefined,
  runtime: Runtime = currentRuntime(),
): void {
  runtime.get(clientNamePart).read = read;
}

/** The session's MCP client, or undefined (none registered, or a failing read). */
function journalClientName(): string | undefined {
  try {
    return currentRuntime().get(clientNamePart).read?.();
  } catch {
    // swallowed: the client name is best-effort context
    return undefined;
  }
}

/** N-109: who ran a stdio write — the OS user and host (HTTP has `subject`). */
function processIdentity(): { os_user?: string; host?: string } {
  if (isHttpSession()) return {};
  let user: string | undefined;
  try {
    user = userInfo().username;
  } catch {
    // swallowed: no passwd entry for the uid (some containers)
    user = undefined;
  }
  return { ...(user ? { os_user: user } : {}), host: hostname() };
}

/** The last non-empty line of a file, read from its tail. */
function lastLine(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  return lines[lines.length - 1];
}

/**
 * The chain head: `write-journal.head`, or — for a journal written before v2,
 * which has no head file — the hash of the current file's last line.
 */
function readHead(dir: string): string | undefined {
  const headFile = path.join(dir, HEAD);
  if (existsSync(headFile)) {
    return readFileSync(headFile, "utf8").trim() || undefined;
  }
  const last = lastLine(path.join(dir, JSONL));
  return last === undefined ? undefined : sha256Hex(last);
}

/** Rename the current file aside when the next line would cross the cap. */
function rotateIfNeeded(dir: string, incoming: number): void {
  const file = path.join(dir, JSONL);
  if (!existsSync(file)) return;
  const size = statSync(file).size;
  if (size === 0 || size + incoming <= getJournalMaxBytes()) return;
  const stamp = new Date().toISOString().replace(/:/g, "-");
  let target = path.join(dir, `write-journal.${stamp}.jsonl`);
  for (let n = 1; existsSync(target); n++) {
    target = path.join(dir, `write-journal.${stamp}-${n}.jsonl`);
  }
  renameSync(file, target);
}

/** The last `max` complete lines of a file, read from at most its final MiB. */
function tailLines(file: string, max: number): string[] {
  if (!existsSync(file)) return [];
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - MARKDOWN_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    // A window that starts mid-file begins with a partial line.
    if (start > 0) lines.shift();
    return lines.slice(-max);
  } finally {
    closeSync(fd);
  }
}

const cell = (s: string): string => s.replaceAll("|", "\\|");

function formatMarkdownRow(e: JournalEntry): string {
  const target =
    e.target ?? (e.sys_id ? `${e.table}/${e.sys_id}` : (e.table ?? "—"));
  const fields = e.keys?.length
    ? e.keys.join(", ")
    : e.fields
      ? Object.keys(e.fields).join(", ")
      : e.bytes !== undefined
        ? `${e.bytes} bytes`
        : "—";
  return `| ${e.ts} | ${e.action} | ${cell(target)} | ${cell(fields)} | ${e.result ?? "applied"} |\n`;
}

/** Re-render the Markdown mirror from the newest JSONL entries. */
function renderMarkdown(dir: string, profile: string): void {
  const entries: JournalEntry[] = [];
  for (const line of tailLines(path.join(dir, JSONL), MARKDOWN_ENTRIES)) {
    try {
      entries.push(JSON.parse(line) as JournalEntry);
    } catch {
      // swallowed: a damaged line is the integrity check's concern, not the mirror's
    }
  }
  const md = [
    `# Write journal — ${profile}\n`,
    "\n",
    `Rendered from \`${JSONL}\` (the last ${entries.length} entries, newest last). The JSONL file is the record; this file is regenerated on every write.\n`,
    "\n",
    "| Time | Action | Target | Fields | Result |\n",
    "| --- | --- | --- | --- | --- |\n",
    ...entries.map(formatMarkdownRow),
  ].join("");
  writeFileSync(path.join(dir, MARKDOWN), md, { mode: FILE_MODE });
}

/**
 * Mask the value-carrying fields with the tool-result redaction rules. N-21:
 * plus the secret columns of the entry's table the schema cache already holds
 * (password / password2 / glide_encrypted, else the OOTB names), so a before
 * or after image never stores a secret even when the line is written outside
 * the call that read it. The journal never reads the instance to find out.
 */
function redactEntry(entry: JournalInput): JournalInput {
  const out = { ...entry };
  const rules = redactionRules(peekSecretColumns(entry.table));
  if (out.fields !== undefined)
    out.fields = redactValue(out.fields, rules).value;
  if (out.before !== undefined)
    out.before = redactValue(out.before, rules).value;
  if (out.error !== undefined) out.error = redactValue(out.error, rules).value;
  return out;
}

/**
 * M-1 / L4-04 — in-process write counters since startup (or the last runtime
 * dispose), by outcome: instance writes (`create`…`execute`) and local writes
 * (`local_write`, `config`) are counted apart. Counted per journalled line,
 * so a batch counts its sub-requests; a plan (preview) is not a write.
 */
export interface WriteCounters {
  applied: number;
  failed: number;
  refused: number;
  local: number;
  lastAt: string | null;
}

const writeCountersPart = defineRuntimePart(
  "write-counters",
  (): WriteCounters => ({
    applied: 0,
    failed: 0,
    refused: 0,
    local: 0,
    lastAt: null,
  }),
  (c) => {
    c.applied = c.failed = c.refused = c.local = 0;
    c.lastAt = null;
  },
);

/**
 * H-11 (L3-02): what the per-session caps count — applied instance writes (a
 * batch counts its write sub-requests, not its envelope) and deletes among
 * them. Kept apart from WriteCounters, which count journal lines.
 */
const capUsagePart = defineRuntimePart(
  "write-cap-usage",
  () => ({ writes: 0, deletes: 0 }),
  (u) => {
    u.writes = u.deletes = 0;
  },
);

/**
 * H-11: an HTTP session runs in a child runtime (H-7); the stdio process in
 * the root one. Picks the unset SN_MAX_WRITES_PER_SESSION default.
 */
function isHttpSession(): boolean {
  return currentRuntime().parent !== undefined;
}

/** The caps and their usage in this session, for `get_status`. */
export function getWriteCaps() {
  const u = currentRuntime().get(capUsagePart);
  return {
    writes: {
      used: u.writes,
      max: getMaxWritesPerSession(isHttpSession()) || null,
    },
    deletes: { used: u.deletes, max: getMaxDeletesPerSession() || null },
  };
}

const INSTANCE_ACTIONS = new Set<WriteAction>([
  "create",
  "update",
  "delete",
  "execute",
]);

/** How many writes / deletes an applied journaled write counts for. */
export interface WriteWeight {
  writes: number;
  deletes: number;
}

function weightOf(entry: JournalInput, weight?: WriteWeight): WriteWeight {
  if (weight) return weight;
  if (!INSTANCE_ACTIONS.has(entry.action)) return { writes: 0, deletes: 0 };
  return { writes: 1, deletes: entry.action === "delete" ? 1 : 0 };
}

/**
 * H-11: refuse a write that would pass a session cap — before any request —
 * with WRITE_CAP, journaled as `refused` with `cap_hit`.
 */
export function assertWriteCap(
  entry: JournalInput,
  weight?: WriteWeight,
): void {
  const w = weightOf(entry, weight);
  if (w.writes === 0 && w.deletes === 0) return;
  assertJournalReady();
  const u = currentRuntime().get(capUsagePart);
  const maxWrites = getMaxWritesPerSession(isHttpSession());
  const maxDeletes = getMaxDeletesPerSession();
  let message: string | undefined;
  if (maxDeletes && u.deletes + w.deletes > maxDeletes) {
    message = `Delete cap reached: ${u.deletes} of ${maxDeletes} deletes used in this session (SN_MAX_DELETES_PER_SESSION); this call needs ${w.deletes} more.`;
  } else if (maxWrites && u.writes + w.writes > maxWrites) {
    message = `Write cap reached: ${u.writes} of ${maxWrites} writes used in this session (SN_MAX_WRITES_PER_SESSION); this call needs ${w.writes} more.`;
  }
  if (!message) return;
  appendWriteJournal({
    ...entry,
    result: "refused",
    error: message,
    cap_hit: true,
  });
  throw new ServiceNowError(message, 429, undefined, {
    code: "WRITE_CAP",
    hint: "Nothing was sent. Start a new session (restart the server or reconnect) or raise the cap.",
  });
}

function countCap(entry: JournalInput, weight?: WriteWeight): void {
  const w = weightOf(entry, weight);
  const u = currentRuntime().get(capUsagePart);
  u.writes += w.writes;
  u.deletes += w.deletes;
}

/** A snapshot of the write counters, for `get_status`. */
export function getWriteCounters(): WriteCounters {
  return { ...currentRuntime().get(writeCountersPart) };
}

function countWrite(entry: JournalEntry): void {
  const c = currentRuntime().get(writeCountersPart);
  if (entry.action === "local_write" || entry.action === "config") c.local++;
  else c[entry.result ?? "applied"]++;
  c.lastAt = entry.ts;
}

/**
 * Append one mutation to `<SN_DOCS_DIR>/<profile>/write-journal.jsonl` and
 * re-render `write-journal.md`. Returns the full entry (with id, timestamp,
 * profile and chain link) so the tool can echo when it was journalled. Never
 * throws — journalling must not turn a successful write into a tool error.
 */
export function appendWriteJournal(entry: JournalInput): JournalEntry {
  const client = entry.client ?? currentClient();
  const subject = entry.subject ?? currentSession()?.subject;
  const tool = entry.tool ?? currentTool();
  const planToken = entry.plan_token ?? currentCall()?.plan?.token;
  const clientName = journalClientName();
  const base: JournalEntry = {
    schema_version: JOURNAL_SCHEMA_VERSION,
    id: ulid(),
    ts: new Date().toISOString(),
    profile: activeProfile(),
    ...redactEntry(entry),
    ...(tool ? { tool } : {}),
    ...(planToken ? { plan_token: planToken } : {}),
    result: entry.result ?? "applied",
    ...(client ? { client } : {}),
    ...(subject ? { subject } : {}),
    ...(clientName ? { client_name: clientName } : {}),
    ...processIdentity(),
  };
  countWrite(base);
  let full = base;
  try {
    const dir = journalDir(base.profile);
    ensureJournalDir(dir);
    const prev = readHead(dir);
    const key = getJournalKey();
    full = {
      ...base,
      ...(prev ? { prev } : {}),
      ...(key ? { prev_mac: hmacHex(key, prev ?? "") } : {}),
    };
    const line = JSON.stringify(full);
    const head = sha256Hex(line);
    rotateIfNeeded(dir, Buffer.byteLength(line) + 1);
    appendFileSync(path.join(dir, JSONL), line + "\n", { mode: FILE_MODE });
    writeFileSync(path.join(dir, HEAD), head, { mode: FILE_MODE });
    if (key) {
      writeFileSync(path.join(dir, HEAD_MAC), hmacHex(key, head), {
        mode: FILE_MODE,
      });
    }
    renderMarkdown(dir, base.profile);
  } catch (error) {
    // N-109: under SN_JOURNAL_REQUIRED a lost line is an error, not a warning.
    (journalRequired() ? logger.error : logger.warn)(
      "write-journal append failed",
      { error: error instanceof Error ? error.message : String(error) },
    );
  }
  emitAudit("journal", {
    id: full.id,
    action_kind: full.action,
    table: full.table,
    ...(full.sys_id ? { sys_id: full.sys_id } : {}),
    result: full.result,
    ...(full.tool ? { tool: full.tool } : {}),
  });
  return full;
}

/**
 * S-2 — the record's `sys_mod_count` from a write API result (a number, a
 * numeric string, or a `{ value }` pair), for the journal's drift baseline.
 */
export function resultModCount(result: unknown): number | undefined {
  if (!result || typeof result !== "object") return undefined;
  let v = (result as Record<string, unknown>).sys_mod_count;
  if (v && typeof v === "object" && "value" in v) {
    v = (v as Record<string, unknown>).value;
  }
  if (typeof v === "number") {
    return Number.isInteger(v) && v >= 0 ? v : undefined;
  }
  return typeof v === "string" && /^\d+$/.test(v.trim())
    ? Number(v)
    : undefined;
}

/** Map a write error to its journal outcome: a 403 is a refusal. */
export function writeOutcome(error: unknown): WriteResult {
  return error instanceof ServiceNowError && error.status === 403
    ? "refused"
    : "failed";
}

/**
 * Run an applied write and journal its outcome: `applied` (with anything
 * `derive` adds from the result, e.g. a created sys_id), or `failed`/`refused`
 * with the error message — then re-throw, so the tool still reports the error.
 */
export async function journaledWrite<T>(
  entry: JournalInput,
  run: () => Promise<T>,
  derive?: (result: T) => Partial<JournalInput>,
  weight?: WriteWeight,
): Promise<T> {
  // H-11: the session caps are checked before anything is sent.
  assertWriteCap(entry, weight);
  let result: T;
  try {
    result = await run();
  } catch (error) {
    appendWriteJournal({
      ...entry,
      result: writeOutcome(error),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  appendWriteJournal({ ...entry, ...derive?.(result) });
  countCap(entry, weight);
  return result;
}

export interface JournalReadResult {
  /** Entries (oldest first), v1 lines normalised with v2 defaults. */
  entries: JournalEntry[];
  /**
   * `ok`, or `broken@<n>` — the first line (1-based, across the rotated files
   * and the current one in order) whose chain link does not verify, or that is
   * not valid JSON. A last line that no longer matches the head also breaks.
   */
  integrity: string;
  /** The files read, oldest first (names relative to the profile directory). */
  files: string[];
}

/** Read a v1 line with v2 defaults. */
function normalise(raw: JournalEntry): JournalEntry {
  return {
    ...raw,
    schema_version: raw.schema_version ?? 1,
    result: raw.result ?? "applied",
  };
}

/**
 * Read a profile's journal across its rotated files and verify the hash chain
 * (the reader S-2's `list_writes`/revert builds on). Only v2 lines carry a
 * link; v1 lines are accepted as they are. `action` filters the returned
 * entries after verification.
 */
export function readWriteJournal(
  options: { profile?: string; action?: WriteAction } = {},
): JournalReadResult {
  const dir = journalDir(options.profile ?? activeProfile());
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => ROTATED.test(f))
        .sort(byRotation)
    : [];
  if (existsSync(path.join(dir, JSONL))) files.push(JSONL);

  const entries: JournalEntry[] = [];
  let integrity = "ok";
  let previous: string | undefined;
  let n = 0;
  // N-109: with the key, every line from the first keyed one on must verify.
  const key = getJournalKey();
  let keyed = false;
  for (const file of files) {
    const lines = readFileSync(path.join(dir, file), "utf8")
      .split("\n")
      .filter(Boolean);
    for (const line of lines) {
      n++;
      let parsed: JournalEntry | undefined;
      try {
        parsed = JSON.parse(line) as JournalEntry;
      } catch {
        // swallowed: a damaged line is reported by the integrity check below
        parsed = undefined;
      }
      if (integrity === "ok") {
        const expected =
          previous === undefined ? undefined : sha256Hex(previous);
        if (
          !parsed ||
          ((parsed.schema_version ?? 1) >= 2 && parsed.prev !== expected)
        ) {
          integrity = `broken@${n}`;
        } else if (key && parsed.prev_mac !== undefined) {
          keyed = true;
          if (parsed.prev_mac !== hmacHex(key, parsed.prev ?? "")) {
            integrity = `broken@${n}`;
          }
        } else if (key && keyed) {
          integrity = `broken@${n}`;
        }
      }
      if (parsed) entries.push(normalise(parsed));
      previous = line;
    }
  }
  const headFile = path.join(dir, HEAD);
  if (integrity === "ok" && previous !== undefined && existsSync(headFile)) {
    if (readFileSync(headFile, "utf8").trim() !== sha256Hex(previous)) {
      integrity = `broken@${n}`;
    }
  }
  if (integrity === "ok" && key && keyed && previous !== undefined) {
    const macFile = path.join(dir, HEAD_MAC);
    const mac = existsSync(macFile)
      ? readFileSync(macFile, "utf8").trim()
      : undefined;
    if (mac !== hmacHex(key, sha256Hex(previous))) integrity = `broken@${n}`;
  }
  return {
    entries: options.action
      ? entries.filter((e) => e.action === options.action)
      : entries,
    integrity,
    files,
  };
}
