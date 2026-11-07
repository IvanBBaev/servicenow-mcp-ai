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
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname, userInfo } from "node:os";
import path from "node:path";
import {
  getDocsDir,
  getJournalKeep,
  getJournalKey,
  getJournalMaxBytes,
  getMaxDeletesPerSession,
  getMaxWritesPerSession,
  journalRequired,
} from "./settings.js";
import { activeProfile } from "./config.js";
import { engagedKillSwitch } from "./kill-switch.js";
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
 *
 * N-109 (AR-I3): an append holds `write-journal.lock` (an O_EXCL lock file
 * naming its PID; a dead PID or an old file is taken over) from reading the
 * head to writing it, so two server processes on one profile cannot fork the
 * chain. The Markdown mirror is rendered at most once per second (a pending
 * render runs on a timer and at exit), a revert looks its entry up newest
 * first and stops there, and SN_JOURNAL_KEEP bounds the rotated files: the
 * removed files' last hash is kept in `write-journal.anchor` (HMAC-ed under
 * SN_JOURNAL_KEY) so the oldest kept line still verifies.
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
const LOCK = "write-journal.lock";
const ANCHOR = "write-journal.anchor";
/** How long an append waits for another process's lock before it gives up. */
const LOCK_WAIT_MS = 5000;
/** A lock file older than this is taken over even when its PID looks alive. */
const LOCK_STALE_MS = 30_000;
/** The Markdown mirror is rendered at most once per this interval. */
const MIRROR_INTERVAL_MS = 1000;
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
      f !== ANCHOR &&
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
export type AuditAction =
  | "journal"
  | "policy_change"
  | "apply_denied"
  | "journal_retention";

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

/** Block the thread for `ms` (the append path is synchronous). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A lock whose PID is gone, or that is older than LOCK_STALE_MS. */
function lockIsStale(file: string): boolean {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) return true;
    return Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS;
  } catch {
    // swallowed: the lock vanished between the open and the read — retry
    return false;
  }
}

/**
 * N-109: run `fn` holding the profile's journal lock — an advisory O_EXCL
 * file other server processes on the same docs directory respect. Throws
 * when the lock stays held for LOCK_WAIT_MS.
 */
function withJournalLock<T>(dir: string, fn: () => T): T {
  const file = path.join(dir, LOCK);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(file, "wx", FILE_MODE);
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (lockIsStale(file)) {
        rmSync(file, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new ServiceNowError(
          `${LOCK} is held by another process`,
          503,
          undefined,
          {
            code: "JOURNAL_UNAVAILABLE",
            hint: "Another server process kept the journal lock; a lock it left behind is taken over once its process exits.",
          },
        );
      }
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * The non-empty lines of a file, newest first, read backwards in 64 KiB
 * chunks so a lookup near the end never loads the whole file.
 */
function* linesNewestFirst(file: string): Generator<string> {
  const fd = openSync(file, "r");
  try {
    let pos = fstatSync(fd).size;
    let rest = Buffer.alloc(0);
    while (pos > 0) {
      const size = Math.min(65_536, pos);
      pos -= size;
      const chunk = Buffer.alloc(size);
      readSync(fd, chunk, 0, size, pos);
      let buf = Buffer.concat([chunk, rest]);
      let nl = buf.lastIndexOf(0x0a);
      while (nl !== -1) {
        const line = buf.subarray(nl + 1).toString("utf8");
        if (line) yield line;
        buf = buf.subarray(0, nl);
        nl = buf.lastIndexOf(0x0a);
      }
      rest = buf;
    }
    const first = rest.toString("utf8");
    if (first) yield first;
  } finally {
    closeSync(fd);
  }
}

/** The last non-empty line of a file, read from its tail. */
function lastLine(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  for (const line of linesNewestFirst(file)) return line;
  return undefined;
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

/** The rotated files, oldest first. */
function rotatedFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => ROTATED.test(f))
    .sort(byRotation);
}

/** `write-journal.anchor`: the hash the oldest kept line links back to. */
interface JournalAnchor {
  prev: string;
  /** HMAC of `anchor:<prev>` under SN_JOURNAL_KEY. */
  mac?: string;
  removed: string[];
  ts: string;
}

const anchorMac = (key: string, prev: string): string =>
  hmacHex(key, `anchor:${prev}`);

function readAnchor(dir: string): JournalAnchor | undefined {
  const file = path.join(dir, ANCHOR);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as JournalAnchor;
    return typeof parsed.prev === "string" ? parsed : { ...parsed, prev: "" };
  } catch {
    // swallowed: an unreadable anchor links to nothing, so the chain breaks at line 1
    return { prev: "", removed: [], ts: "" };
  }
}

/**
 * N-109: SN_JOURNAL_KEEP — remove the oldest rotated files beyond the limit
 * (0 keeps all). The hash of the last removed line goes to the anchor first,
 * so the chain still verifies from the oldest kept line; the removal is an
 * audit event.
 */
function pruneRotated(dir: string, profile: string, key?: string): void {
  const keep = getJournalKeep();
  if (keep <= 0) return;
  const rotated = rotatedFiles(dir);
  const drop = rotated.slice(0, Math.max(0, rotated.length - keep));
  const newestDropped = drop.at(-1);
  if (newestDropped === undefined) return;
  const last = lastLine(path.join(dir, newestDropped));
  const prev =
    last === undefined ? (readAnchor(dir)?.prev ?? "") : sha256Hex(last);
  const anchor: JournalAnchor = {
    prev,
    ...(key ? { mac: anchorMac(key, prev) } : {}),
    removed: drop,
    ts: new Date().toISOString(),
  };
  writeFileSync(path.join(dir, ANCHOR), JSON.stringify(anchor) + "\n", {
    mode: FILE_MODE,
  });
  for (const f of drop) rmSync(path.join(dir, f), { force: true });
  emitAudit("journal_retention", { profile, removed: drop, kept: keep });
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
    `Rendered from \`${JSONL}\` (the last ${entries.length} entries, newest last). The JSONL file is the record; this file is regenerated after writes.\n`,
    "\n",
    "| Time | Action | Target | Fields | Result |\n",
    "| --- | --- | --- | --- | --- |\n",
    ...entries.map(formatMarkdownRow),
  ].join("");
  writeFileSync(path.join(dir, MARKDOWN), md, { mode: FILE_MODE });
}

/** N-109: per profile directory, when the mirror was last rendered and any pending render. */
interface MirrorState {
  profile: string;
  last: number;
  timer?: NodeJS.Timeout;
}

function flushMirrors(states: Map<string, MirrorState>): void {
  for (const [dir, state] of states) {
    if (!state.timer) continue;
    clearTimeout(state.timer);
    state.timer = undefined;
    renderMirror(dir, state);
  }
}

const mirrorPart = defineRuntimePart(
  "write-journal-mirror",
  () => {
    const states = new Map<string, MirrorState>();
    const onExit = (): void => flushMirrors(states);
    process.once("exit", onExit);
    return { states, onExit };
  },
  ({ states, onExit }) => {
    process.off("exit", onExit);
    flushMirrors(states);
    states.clear();
  },
  { scope: "process" },
);

function renderMirror(dir: string, state: MirrorState): void {
  state.last = Date.now();
  try {
    renderMarkdown(dir, state.profile);
  } catch (error) {
    // the mirror is a convenience view; the JSONL file is the record
    logger.warn("write-journal mirror render failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Render the Markdown mirror now when it has not been rendered for
 * MIRROR_INTERVAL_MS, else once when the interval ends — a burst of writes
 * re-renders it once instead of once per line.
 */
function scheduleMirror(dir: string, profile: string): void {
  const { states } = currentRuntime().get(mirrorPart);
  let state = states.get(dir);
  if (!state) {
    state = { profile, last: 0 };
    states.set(dir, state);
  }
  state.profile = profile;
  if (state.timer) return;
  const wait = state.last + MIRROR_INTERVAL_MS - Date.now();
  if (wait <= 0) {
    renderMirror(dir, state);
    return;
  }
  const pending = state;
  pending.timer = setTimeout(() => {
    pending.timer = undefined;
    renderMirror(dir, pending);
  }, wait);
  pending.timer.unref();
}

/** Render every pending Markdown mirror now (shutdown, tests). */
export function flushJournalMirror(runtime = currentRuntime()): void {
  flushMirrors(runtime.get(mirrorPart).states);
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
 * schedule a re-render of `write-journal.md`. Returns the full entry (with id, timestamp,
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
    const key = getJournalKey();
    full = withJournalLock(dir, () => {
      const prev = readHead(dir);
      const linked: JournalEntry = {
        ...base,
        ...(prev ? { prev } : {}),
        ...(key ? { prev_mac: hmacHex(key, prev ?? "") } : {}),
      };
      const line = JSON.stringify(linked);
      const head = sha256Hex(line);
      rotateIfNeeded(dir, Buffer.byteLength(line) + 1);
      appendFileSync(path.join(dir, JSONL), line + "\n", { mode: FILE_MODE });
      writeFileSync(path.join(dir, HEAD), head, { mode: FILE_MODE });
      if (key) {
        writeFileSync(path.join(dir, HEAD_MAC), hmacHex(key, head), {
          mode: FILE_MODE,
        });
      }
      pruneRotated(dir, base.profile, key);
      return linked;
    });
    scheduleMirror(dir, base.profile);
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

/**
 * N-108: refuse an instance write while the managed kill-switch property is
 * `true` on the instance — journaled as `refused`, nothing sent.
 */
async function assertKillSwitchOff(
  entry: JournalInput,
  weight?: WriteWeight,
): Promise<void> {
  const w = weightOf(entry, weight);
  if (w.writes === 0 && w.deletes === 0) return;
  const engaged = await engagedKillSwitch();
  if (engaged.length === 0) return;
  const message = `Writes are switched off on this instance: the system property ${engaged.join(", ")} is true (managed kill switch).`;
  emitAudit("apply_denied", { code: "POLICY_KILL_SWITCH" });
  appendWriteJournal({ ...entry, result: "refused", error: message });
  throw new ServiceNowError(message, 403, undefined, {
    code: "POLICY_KILL_SWITCH",
    hint: "Nothing was sent. The instance owner turns writes back on by setting the property to false; reads still work.",
  });
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
  await assertKillSwitchOff(entry, weight);
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

/** The journal files of a profile directory, oldest first. */
function journalFiles(dir: string): string[] {
  const files = existsSync(dir) ? rotatedFiles(dir) : [];
  if (existsSync(path.join(dir, JSONL))) files.push(JSONL);
  return files;
}

/**
 * The anchor check for the oldest line: with the key and a keyed first line,
 * the anchor must carry its HMAC — else a user without the key could drop
 * the oldest files and write a matching plain anchor.
 */
function anchorVerifies(
  anchor: JournalAnchor | undefined,
  first: JournalEntry,
  key: string | undefined,
): boolean {
  if (!anchor || !key || first.prev_mac === undefined) return true;
  return anchor.mac === anchorMac(key, anchor.prev);
}

/** A newest-first lookup of one journal entry (see `findWriteJournalEntry`). */
export interface JournalLookup {
  /** The entry, or undefined when no line has that id. */
  entry?: JournalEntry;
  /** The entries written after it, oldest first. */
  later: JournalEntry[];
  /** `ok`, or `broken@<n>` from a full `readWriteJournal` verification. */
  integrity: string;
}

/**
 * N-109: find one entry by id reading newest first, and stop there. The lines
 * from the head back to the entry are verified on the way (each line hashes
 * to its successor's `prev`, the head file and, under the key, `prev_mac` and
 * the head HMAC) — that is what ties the entry to the current head. A line
 * that does not verify falls back to the full `readWriteJournal` check, so the
 * reported `broken@<n>` is the same.
 */
export function findWriteJournalEntry(
  id: string,
  options: { profile?: string } = {},
): JournalLookup {
  const dir = journalDir(options.profile ?? activeProfile());
  const key = getJournalKey();
  const headFile = path.join(dir, HEAD);
  let expected = existsSync(headFile)
    ? readFileSync(headFile, "utf8").trim()
    : undefined;
  const later: JournalEntry[] = [];
  let newest = true;
  let sawUnkeyed = false;
  let mustBeFirst = false;
  const full = (): JournalLookup => {
    const read = readWriteJournal(options);
    const at = read.entries.findIndex((e) => e.id === id);
    return at === -1
      ? { later: [], integrity: read.integrity }
      : {
          entry: read.entries[at],
          later: read.entries.slice(at + 1),
          integrity: read.integrity,
        };
  };
  for (const file of journalFiles(dir).reverse()) {
    for (const line of linesNewestFirst(path.join(dir, file))) {
      if (mustBeFirst) return full();
      if (expected !== undefined && sha256Hex(line) !== expected) {
        return full();
      }
      let parsed: JournalEntry;
      try {
        parsed = JSON.parse(line) as JournalEntry;
      } catch {
        // swallowed: the full read reports where the chain breaks
        return full();
      }
      if (key && parsed.prev_mac !== undefined) {
        if (sawUnkeyed || parsed.prev_mac !== hmacHex(key, parsed.prev ?? "")) {
          return full();
        }
        if (newest) {
          const macFile = path.join(dir, HEAD_MAC);
          const mac = existsSync(macFile)
            ? readFileSync(macFile, "utf8").trim()
            : undefined;
          if (mac !== hmacHex(key, sha256Hex(line))) return full();
        }
      } else {
        sawUnkeyed = true;
      }
      newest = false;
      const v2 = (parsed.schema_version ?? 1) >= 2;
      expected = v2 ? parsed.prev : undefined;
      mustBeFirst = v2 && parsed.prev === undefined;
      const entry = normalise(parsed);
      if (entry.id === id)
        return { entry, later: later.reverse(), integrity: "ok" };
      later.push(entry);
    }
  }
  return full();
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
  const files = journalFiles(dir);

  const entries: JournalEntry[] = [];
  let integrity = "ok";
  let previous: string | undefined;
  let n = 0;
  // N-109: with the key, every line from the first keyed one on must verify.
  const key = getJournalKey();
  let keyed = false;
  // N-109: after SN_JOURNAL_KEEP removed files, the first line links to the anchor.
  const anchor = readAnchor(dir);
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
          previous === undefined ? anchor?.prev : sha256Hex(previous);
        if (
          !parsed ||
          ((parsed.schema_version ?? 1) >= 2 && parsed.prev !== expected) ||
          (previous === undefined && !anchorVerifies(anchor, parsed, key))
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
