import {
  CANCELLED_HINT,
  ServiceNowError,
  type ServiceNowErrorOptions,
} from "./errors.js";
import { userAgent } from "./identity.js";
import { logger } from "./logging.js";
import { publishRequestEvent, recordRateLimit } from "./metrics.js";
import { redactValue } from "./redaction.js";
import { logContext } from "./request-context.js";
import { currentRuntime, defineRuntimePart } from "./runtime.js";
import {
  getBreakerResetMs,
  getBreakerThreshold,
  getDeadlineMs,
  getMaxBodyBytes,
  getMaxConcurrent,
  getMaxQueue,
  getMaxRetries,
  getQueueTimeoutMs,
  getRetryAfterMaxMs,
  getTimeoutMs,
} from "./settings.js";

/**
 * Transport primitives shared by every REST client in this server (the
 * ServiceNow client in http.ts, the Jira client in jira/http.ts and the OAuth
 * token exchange in auth.ts): the retry matrix, exponential backoff, the
 * bounded per-host concurrency semaphore, the request deadline, the error-body
 * shaping and the in-process telemetry — all behind ONE request primitive,
 * rawRequest(). Keeping them here means there is still effectively "one HTTP
 * client": the callers differ only in host resolution, auth and error-body
 * vocabulary, not in how they time out, retry, rate-limit or identify.
 */

// --- telemetry ------------------------------------------------------------

/**
 * In-process telemetry: enough to answer "why is it slow / what is failing"
 * from the client itself (exposed via get_status and servicenow://status).
 * Counted per host so a multi-instance (or multi-system) breakdown comes for
 * free; getTelemetry() also returns the aggregate.
 */
export interface Telemetry {
  requests: number;
  retries: number;
  errors: Record<string, number>;
  totalMs: number;
}

export interface TelemetrySnapshot extends Telemetry {
  perHost: Record<string, Telemetry>;
}

// E-3: counters live in the runtime container; dispose() clears them.
const telemetryPart = defineRuntimePart(
  "telemetry",
  () => new Map<string, Telemetry>(),
  (perHost) => perHost.clear(),
  { scope: "process" },
);

export function telemetryFor(host: string): Telemetry {
  const perHostTelemetry = currentRuntime().get(telemetryPart);
  let t = perHostTelemetry.get(host);
  if (!t) {
    t = { requests: 0, retries: 0, errors: {}, totalMs: 0 };
    perHostTelemetry.set(host, t);
  }
  return t;
}

export function getTelemetry(): TelemetrySnapshot {
  const aggregate: TelemetrySnapshot = {
    requests: 0,
    retries: 0,
    errors: {},
    totalMs: 0,
    perHost: {},
  };
  for (const [host, t] of currentRuntime().get(telemetryPart)) {
    aggregate.requests += t.requests;
    aggregate.retries += t.retries;
    aggregate.totalMs += t.totalMs;
    for (const [k, n] of Object.entries(t.errors)) {
      aggregate.errors[k] = (aggregate.errors[k] ?? 0) + n;
    }
    aggregate.perHost[host] = { ...t, errors: { ...t.errors } };
  }
  return aggregate;
}

export function countError(
  t: Telemetry,
  key: string | number | undefined,
): void {
  const k = String(key ?? "transport");
  t.errors[k] = (t.errors[k] ?? 0) + 1;
}

// --- bounded per-host semaphore -------------------------------------------

// Counting semaphore around fetch, per host: protects each instance from
// request salvos (tableLogic fires 5 in parallel, fetchAll can chain dozens)
// without one host starving another. The wait line is bounded (SN_MAX_QUEUE)
// and timed (SN_QUEUE_TIMEOUT_MS): a stalled instance fails fast with BUSY
// instead of accumulating an unbounded backlog of doomed callers (L1-04).
interface Waiter {
  grant: () => void;
  cancel: (err: Error) => void;
}

interface Slot {
  active: number;
  waiters: Waiter[];
}

// E-3: the slot table lives in the runtime container; dispose() drains it.
const slotsPart = defineRuntimePart(
  "queue",
  () => new Map<string, Slot>(),
  (slots) => {
    drainSlots(slots);
  },
  { scope: "process" },
);

/** Thrown by withSlot when the caller cannot get a slot in time. */
export class SlotBusyError extends Error {
  constructor(
    public readonly reason: "full" | "timeout" | "drained",
    public readonly host: string,
    public readonly queued: number,
    public readonly limitMs: number,
  ) {
    super(
      reason === "full"
        ? `Request queue for ${host} is full (${queued} waiting).`
        : reason === "drained"
          ? `Request queue for ${host} was drained (the server is shutting down or resetting).`
          : `Timed out after ${limitMs}ms waiting for a request slot on ${host} (${queued} waiting).`,
    );
    this.name = "SlotBusyError";
  }
}

export interface SlotOptions {
  /** Run immediately without taking or waiting for a slot (diagnostics). */
  bypass?: boolean;
  maxQueue?: number;
  queueTimeoutMs?: number;
  /** Leave the wait line when this aborts (M-3: a cancelled tool call). */
  signal?: AbortSignal;
}

function slotFor(host: string): Slot {
  const slots = currentRuntime().get(slotsPart);
  let slot = slots.get(host);
  if (!slot) {
    slot = { active: 0, waiters: [] };
    slots.set(host, slot);
  }
  return slot;
}

function release(s: Slot, limit: number): void {
  s.active -= 1;
  // Hand the freed slot straight to the next waiter (no re-check race).
  if (s.active < limit) {
    const next = s.waiters.shift();
    if (next) {
      s.active += 1;
      next.grant();
    }
  }
}

export async function withSlot<T>(
  host: string,
  fn: () => Promise<T>,
  opts: SlotOptions = {},
): Promise<T> {
  if (opts.bypass) return fn();
  const limit = getMaxConcurrent();
  const s = slotFor(host);
  if (s.active < limit) {
    s.active += 1;
  } else {
    const maxQueue = opts.maxQueue ?? getMaxQueue();
    if (s.waiters.length >= maxQueue) {
      throw new SlotBusyError("full", host, s.waiters.length, 0);
    }
    const queueTimeoutMs = opts.queueTimeoutMs ?? getQueueTimeoutMs();
    const { signal } = opts;
    if (signal?.aborted) throw abortReason(signal);
    await new Promise<void>((resolve, reject) => {
      const leave = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const idx = s.waiters.indexOf(waiter);
        if (idx >= 0) s.waiters.splice(idx, 1);
      };
      const onAbort = (): void => {
        leave();
        reject(abortReason(signal));
      };
      const waiter: Waiter = {
        grant: () => {
          leave();
          resolve();
        },
        cancel: (err) => {
          leave();
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        leave();
        reject(
          new SlotBusyError("timeout", host, s.waiters.length, queueTimeoutMs),
        );
      }, queueTimeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      s.waiters.push(waiter);
    });
  }
  try {
    return await fn();
  } finally {
    release(s, limit);
  }
}

/** The error an aborted wait rejects with (the signal's reason, when an Error). */
function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

/** Per-host queue occupancy, for get_status. */
export function getQueueStats(): Record<
  string,
  { active: number; queued: number }
> {
  const out: Record<string, { active: number; queued: number }> = {};
  for (const [host, s] of currentRuntime().get(slotsPart)) {
    if (s.active > 0 || s.waiters.length > 0) {
      out[host] = { active: s.active, queued: s.waiters.length };
    }
  }
  return out;
}

/**
 * Reject every caller still waiting for a slot (they fail with code BUSY) and
 * forget the per-host slot state. For process shutdown / lifecycle dispose();
 * requests already in flight are not interrupted. Returns how many waiters
 * were rejected.
 */
export function drainQueue(): number {
  return drainSlots(currentRuntime().get(slotsPart));
}

function drainSlots(slots: Map<string, Slot>): number {
  let rejected = 0;
  for (const [host, s] of slots) {
    for (const w of s.waiters.splice(0)) {
      w.cancel(new SlotBusyError("drained", host, 0, 0));
      rejected += 1;
    }
  }
  slots.clear();
  return rejected;
}

// --- per-host circuit breaker ---------------------------------------------

// After SN_BREAKER_THRESHOLD consecutive failed requests (transport error,
// deadline, 5xx) to one host, further requests fail fast with CIRCUIT_OPEN for
// SN_BREAKER_RESET_MS instead of each burning a full timeout against an
// instance that is down. When the window passes, requests flow again
// (half-open); the first failure re-opens the breaker at once, the first
// success closes it. Diagnostics (bypassQueue) are never rejected, so doctor
// and test_connection still report what is actually wrong.
interface Breaker {
  failures: number;
  openUntil: number;
}

// E-3: breaker state lives in the runtime container; dispose() closes them.
const breakersPart = defineRuntimePart(
  "breakers",
  () => new Map<string, Breaker>(),
  (state) => state.clear(),
  { scope: "process" },
);

const breakers = (): Map<string, Breaker> => currentRuntime().get(breakersPart);

/** Thrown internally when a host's breaker is open. */
class CircuitOpen extends Error {
  constructor(public readonly retryInMs: number) {
    super("circuit open");
    this.name = "CircuitOpen";
  }
}

function breakerCheck(key: string): void {
  const b = breakers().get(key);
  if (!b || getBreakerThreshold() === 0) return;
  const left = b.openUntil - Date.now();
  if (left > 0) throw new CircuitOpen(left);
}

function breakerSuccess(key: string): void {
  breakers().delete(key);
}

function breakerFailure(key: string): void {
  const threshold = getBreakerThreshold();
  if (threshold === 0) return;
  const b = breakers().get(key) ?? { failures: 0, openUntil: 0 };
  b.failures += 1;
  if (b.failures >= threshold) {
    b.openUntil = Date.now() + getBreakerResetMs();
    logger.warn("Circuit breaker opened", { host: key, failures: b.failures });
  }
  breakers().set(key, b);
}

/** Per-host breaker state (only hosts with recorded failures), for status. */
export function getBreakerStats(): Record<
  string,
  { failures: number; open: boolean }
> {
  const out: Record<string, { failures: number; open: boolean }> = {};
  const now = Date.now();
  for (const [host, b] of breakers()) {
    out[host] = { failures: b.failures, open: b.openUntil > now };
  }
  return out;
}

/** Close every breaker and forget failure counts (profile switch, dispose()). */
export function resetBreakers(): void {
  breakers().clear();
}

// --- retry matrix ---------------------------------------------------------

// 429 means the request was rejected by the rate limiter *before* it was
// processed, so the write never landed — safe (and recommended) to replay on
// any method. 502/503/504 are gateway/unavailable responses where a write may
// already have landed, so they are only retried for idempotent (GET) requests;
// replaying them could duplicate a create/transition.
const RETRYABLE_ANY_METHOD = new Set([429]);
const RETRYABLE_IDEMPOTENT = new Set([502, 503, 504]);

export function isIdempotent(method: string): boolean {
  return method === "GET";
}

export function shouldRetryStatus(status: number, method: string): boolean {
  if (RETRYABLE_ANY_METHOD.has(status)) return true;
  return isIdempotent(method) && RETRYABLE_IDEMPOTENT.has(status);
}

/** Same matrix with an explicit idempotency verdict (the token POST is replayable). */
export function shouldRetryStatusFor(
  status: number,
  idempotent: boolean,
): boolean {
  if (RETRYABLE_ANY_METHOD.has(status)) return true;
  return idempotent && RETRYABLE_IDEMPOTENT.has(status);
}

export function backoffMs(attempt: number): number {
  const base = Math.min(500 * 2 ** (attempt - 1), 8000);
  return base + Math.floor(Math.random() * 250);
}

/**
 * A server-supplied Retry-After is honoured but capped (SN_RETRY_AFTER_MAX_MS,
 * default 60 s): an absurd value (a hostile or buggy header asking for an hour)
 * must not hang a tool call. Past the cap the request retries early and either
 * succeeds or exhausts its attempts and surfaces the error, rather than
 * blocking silently.
 */
export function retryAfterMs(
  res: Response,
  maxMs: number = getRetryAfterMaxMs(),
): number | undefined {
  const header = res.headers.get("retry-after");
  if (!header) return undefined;
  const clamp = (ms: number): number => Math.min(maxMs, Math.max(0, ms));
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return clamp(seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : clamp(date - Date.now());
}

/** Sleep, ending early (still resolving) when `signal` aborts. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

// --- signals --------------------------------------------------------------

/**
 * One signal that aborts when any input aborts — AbortSignal.any where the
 * runtime has it (Node ≥ 20.3), a manual composite otherwise.
 */
export function anySignal(
  signals: (AbortSignal | undefined)[],
): AbortSignal | undefined {
  const list = signals.filter((s): s is AbortSignal => Boolean(s));
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  const native = (
    AbortSignal as unknown as {
      any?: (signals: AbortSignal[]) => AbortSignal;
    }
  ).any;
  if (typeof native === "function") return native.call(AbortSignal, list);
  const controller = new AbortController();
  for (const s of list) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), {
      once: true,
    });
  }
  return controller.signal;
}

function isAbortError(err: Error): boolean {
  return err.name === "TimeoutError" || err.name === "AbortError";
}

// --- error bodies ---------------------------------------------------------

/** Longest non-JSON (HTML/plain) error excerpt carried into an error message. */
export const MAX_TEXT_DETAIL_CHARS = 512;
/** Longest JSON error body (serialised) kept as structured detail. */
export const MAX_JSON_DETAIL_CHARS = 2048;

const UPSTREAM_HTML_HINT =
  "The response was an HTML page (proxy, WAF or login page) instead of an API body — check the host and the proxy settings.";

/**
 * Wording ServiceNow's hibernation / wake-up pages use (the PDI landing page
 * on the instance host and the developer-portal page it redirects to). Pinned
 * from recorded page shapes, not a contract — kept deliberately loose.
 */
const HIBERNATION_RE =
  /hibernat|instance is (?:asleep|sleeping|waking)|wake (?:up )?(?:your|the) instance/i;

/** Hint for a page that identifies itself as a hibernating developer instance. */
export const HIBERNATING_HINT =
  "The developer instance (PDI) is hibernating — wake it at https://developer.servicenow.com (sign in, then 'Wake up instance'), wait until it is running, and retry.";

/** Hint for any other HTML page returned in place of an API body. */
export const INSTANCE_HTML_HINT =
  "The instance answered with a web page instead of JSON. A PDI may be hibernating — wake it at https://developer.servicenow.com. Otherwise a login/SSO page or a proxy answered: check SN_INSTANCE, the auth method and the proxy settings.";

/** True when a body (or its content type) is an HTML page. */
export function looksLikeHtml(
  text: string,
  contentType: string | null,
): boolean {
  if ((contentType ?? "").toLowerCase().includes("html")) return true;
  return /^\s*<(!doctype|html|head|body|div|p)\b/i.test(text);
}

/** True when an HTML page reads like ServiceNow's hibernation / wake-up page. */
export function isHibernationPage(html: string): boolean {
  return HIBERNATION_RE.test(htmlToText(html));
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Strip tags, scripts and styles from an HTML page and collapse whitespace. */
export function htmlToText(html: string): string {
  return collapse(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'"),
  );
}

export interface ErrorBody {
  /** Structured detail for the error object (JSON body, or {raw: excerpt}). */
  detail: unknown;
  /** Human-readable summary, already capped. */
  summary: string;
  code?: ServiceNowErrorOptions["code"];
  hint?: string;
}

/**
 * Shape a non-2xx body for the error the caller throws (L1-06). JSON bodies
 * keep their structure (capped at MAX_JSON_DETAIL_CHARS serialised); an HTML
 * page — a proxy, WAF or SSO login page that never reached the API — is
 * reduced to a short text excerpt and flagged UPSTREAM_HTML; anything else is
 * whitespace-collapsed and capped. The raw body is only ever logged at debug.
 */
export function shapeErrorBody(
  text: string,
  contentType: string | null,
  extractDetail: (json: unknown) => string | undefined,
): ErrorBody {
  const type = (contentType ?? "").toLowerCase();
  const trimmed = text.trim();
  const looksJson =
    type.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[");
  if (looksJson && trimmed) {
    try {
      const json: unknown = JSON.parse(trimmed);
      const summary = cap(
        collapse(extractDetail(json) ?? ""),
        MAX_JSON_DETAIL_CHARS,
      );
      const serialised = JSON.stringify(json) ?? "";
      const detail =
        serialised.length > MAX_JSON_DETAIL_CHARS
          ? { raw: cap(serialised, MAX_JSON_DETAIL_CHARS), truncated: true }
          : json;
      return { detail, summary };
    } catch {
      // Not JSON after all — fall through to the text handling.
    }
  }
  if (looksLikeHtml(trimmed, contentType) && trimmed) {
    const summary = cap(htmlToText(trimmed), MAX_TEXT_DETAIL_CHARS);
    // A hibernating PDI can answer with an error status too (H-8 C-3 / L1-08):
    // same shaping, but the specific code and the "wake it" hint.
    if (isHibernationPage(trimmed)) {
      return {
        detail: { raw: summary, html: true },
        summary,
        code: "INSTANCE_HTML_RESPONSE",
        hint: HIBERNATING_HINT,
      };
    }
    return {
      detail: { raw: summary, html: true },
      summary,
      code: "UPSTREAM_HTML",
      hint: UPSTREAM_HTML_HINT,
    };
  }
  const summary = cap(collapse(trimmed), MAX_TEXT_DETAIL_CHARS);
  return { detail: trimmed ? { raw: summary } : {}, summary };
}

// --- the request primitive ------------------------------------------------

export type ErrorFactory = (
  message: string,
  status?: number,
  detail?: unknown,
  options?: ServiceNowErrorOptions,
) => ServiceNowError;

export interface RawRequestOptions {
  /** Full URL (may carry a query string). */
  url: string;
  /** URL without the query string — the only form that reaches logs/messages. */
  safeUrl: string;
  method: string;
  /** Headers for each attempt (auth can change between tries). */
  headers: () => Promise<Record<string, string>> | Record<string, string>;
  body?: string | Uint8Array | FormData | undefined;
  /** Concurrency/breaker key — normally the instance host. */
  host: string;
  /** Telemetry bucket; defaults to `host` ("auth" for token requests). */
  telemetryKey?: string;
  /** Name used in messages and logs: "ServiceNow", "Jira", "OAuth token". */
  system: string;
  /** Prefix of the API-error message; default `${system} API error`. */
  errorPrefix?: string;
  /** Pull a human summary out of a parsed JSON error body. */
  extractDetail: (json: unknown) => string | undefined;
  /** Build the error class the caller's boundary expects. */
  makeError?: ErrorFactory;
  timeoutMs?: number;
  deadlineMs?: number;
  maxRetries?: number;
  /** Override the method-based idempotency verdict (token POSTs are replayable). */
  idempotent?: boolean;
  /** Caller cancellation (M-3): aborts the attempt, never retried. */
  signal?: AbortSignal;
  /** Skip the per-host queue (diagnostics must answer while the queue is stalled). */
  bypassQueue?: boolean;
  /** undici dispatcher (proxy / TLS), when configured. */
  dispatcher?: unknown;
  /**
   * Inspect a response before the retry matrix; return true to replay the
   * request immediately (used for the one-shot 401 re-auth). The body is
   * drained by the primitive.
   */
  onResponse?: (res: Response, attempt: number) => Promise<boolean> | boolean;
}

/** Internal marker: the deadline passed while the request waited for a slot. */
class DeadlineReached extends Error {
  constructor() {
    super("deadline reached");
    this.name = "DeadlineReached";
  }
}

const DEADLINE_HINT =
  "Raise SN_DEADLINE_MS (or SN_TIMEOUT_MS), lower SN_MAX_RETRIES, or narrow the request — the retry budget was cut short by the deadline.";
const CIRCUIT_HINT =
  "The instance failed repeatedly and requests are paused — check its availability (servicenow_test_connection / doctor still probe it), or wait for SN_BREAKER_RESET_MS to pass.";
const REDIRECT_HINT =
  "Redirects are never followed (a redirect could carry the request body and auth headers to another origin). Point the instance/site setting at the final host; a login/SSO redirect usually means the auth method is wrong, and a redirect to the developer portal means the PDI is hibernating.";
const TOO_LARGE_HINT =
  "Narrow the request (fewer fields, a smaller page, a tighter query) or raise SN_MAX_BODY_BYTES.";
const BUSY_HINT =
  "Too many requests are waiting for this host — reduce the number of parallel consumers (SN_MAX_CONCURRENT is the per-host limit, SN_MAX_QUEUE / SN_QUEUE_TIMEOUT_MS the wait line) or retry after the backlog drains.";

/**
 * Perform one logical HTTP request with every shared policy applied: identity
 * header, dispatcher, per-host queue, per-attempt timeout, total deadline,
 * retry matrix with capped Retry-After, telemetry and error shaping. Resolves
 * with the OK response (body unread); throws the caller's error class for
 * every failure, with `code` set for the client-side conditions.
 */
export async function rawRequest(opts: RawRequestOptions): Promise<Response> {
  // E-5: the diagnostics_channel envelope. `obs` is updated by the loop so the
  // end / error events can report the attempt count; the base metadata never
  // carries headers, bodies or the query string.
  const obs: RequestObservation = {
    id: ++requestSeq,
    started: Date.now(),
    attempts: 0,
  };
  const base = (): Record<string, unknown> => ({
    id: obs.id,
    system: opts.system,
    method: opts.method,
    host: opts.host,
    telemetryKey: opts.telemetryKey ?? opts.host,
    url: opts.safeUrl,
    ...(logContext() ?? {}),
  });
  publishRequestEvent("start", base);
  try {
    const res = await rawRequestInner(opts, obs);
    publishRequestEvent("end", () => ({
      ...base(),
      status: res.status,
      attempts: obs.attempts,
      ms: Date.now() - obs.started,
    }));
    return res;
  } catch (error) {
    publishRequestEvent("error", () => {
      const e = error instanceof Error ? error : new Error(String(error));
      const status = (e as { status?: unknown }).status;
      const code = (e as { code?: unknown }).code;
      return {
        ...base(),
        attempts: obs.attempts,
        ms: Date.now() - obs.started,
        ...(typeof status === "number" ? { status } : {}),
        ...(typeof code === "string" ? { code } : {}),
        errorName: e.name,
        errorMessage: redactValue(e.message).value,
      };
    });
    throw error;
  }
}

/** Per-process request id for correlating the diagnostics_channel events. */
let requestSeq = 0;

/** What the request loop reports back to the diagnostics envelope. */
interface RequestObservation {
  id: number;
  started: number;
  /** Attempts sent so far (a fetch that reached the network or failed). */
  attempts: number;
}

async function rawRequestInner(
  opts: RawRequestOptions,
  obs: RequestObservation,
): Promise<Response> {
  const {
    url,
    safeUrl,
    method,
    host,
    system,
    extractDetail,
    signal,
    onResponse,
  } = opts;
  const makeError: ErrorFactory =
    opts.makeError ??
    ((message, status, detail, options) =>
      new ServiceNowError(message, status, detail, options));
  const errorPrefix = opts.errorPrefix ?? `${system} API error`;
  const timeoutMs = opts.timeoutMs ?? getTimeoutMs();
  const deadlineMs = opts.deadlineMs ?? getDeadlineMs();
  const maxRetries = opts.maxRetries ?? getMaxRetries();
  const idempotent = opts.idempotent ?? isIdempotent(method);

  const started = Date.now();
  const deadlineAt = started + deadlineMs;
  const remaining = (): number => deadlineAt - Date.now();
  const telemetry = telemetryFor(opts.telemetryKey ?? host);
  telemetry.requests += 1;
  const finish = (): void => {
    telemetry.totalMs += Date.now() - started;
  };

  const deadlineError = (attempts: number, last: string): ServiceNowError => {
    finish();
    countError(telemetry, "deadline");
    logger.warn(`${system} request exceeded its deadline`, {
      method,
      url: safeUrl,
      attempts,
      deadlineMs,
      last,
    });
    return makeError(
      `${system} request exceeded its ${deadlineMs}ms deadline after ${attempts} attempt(s); last: ${last}.`,
      undefined,
      undefined,
      { code: "DEADLINE_EXCEEDED", hint: DEADLINE_HINT },
    );
  };

  const cancelledError = (): ServiceNowError => {
    finish();
    countError(telemetry, "cancelled");
    logger.debug(`${system} request cancelled`, { method, url: safeUrl });
    return makeError(
      `${system} request was cancelled by the caller.`,
      undefined,
      undefined,
      { code: "CANCELLED", hint: CANCELLED_HINT },
    );
  };

  if (signal?.aborted) throw cancelledError();

  if (!opts.bypassQueue) {
    try {
      breakerCheck(host);
    } catch (cause) {
      if (!(cause instanceof CircuitOpen)) throw cause;
      finish();
      countError(telemetry, "circuit_open");
      throw makeError(
        `${system} request not sent: the circuit breaker for ${host} is open after repeated failures (retry in ${Math.ceil(cause.retryInMs / 1000)}s).`,
        undefined,
        undefined,
        { code: "CIRCUIT_OPEN", hint: CIRCUIT_HINT },
      );
    }
  }

  const deadlineFailure = (attempts: number, last: string): ServiceNowError => {
    breakerFailure(host);
    return deadlineError(attempts, last);
  };

  const ua = userAgent();
  const retrying = (attempt: number, reason: string, waitMs?: number): void => {
    telemetry.retries += 1;
    publishRequestEvent("retry", () => ({
      id: obs.id,
      system,
      method,
      host,
      url: safeUrl,
      attempt: attempt + 1,
      reason,
      ...(waitMs !== undefined ? { waitMs } : {}),
    }));
  };

  for (let attempt = 0; ; attempt++) {
    // M-3: an abort during a backoff wait ends the wait early — never retry
    // after it (nor after a 401 re-auth replay).
    if (signal?.aborted) throw cancelledError();
    // Authorize per attempt (outside the slot: an OAuth refresh is itself a
    // request to the same host and must not wait on the slot it would need).
    const headers: Record<string, string> = {
      "User-Agent": ua,
      ...(await opts.headers()),
    };
    if (remaining() <= 0) throw deadlineError(attempt, "budget exhausted");

    let res: Response;
    let clipped = false;
    try {
      // Node's fetch accepts Uint8Array bodies and a `dispatcher` (undici) at
      // runtime; the loose record bridges gaps in the DOM RequestInit typing.
      // The timeout signal is created inside the slot, so time spent queued on
      // the per-host semaphore does not consume the request's timeout budget —
      // but it does count against the deadline.
      res = await withSlot(
        host,
        () => {
          const left = remaining();
          if (left <= 0) throw new DeadlineReached();
          clipped = left < timeoutMs;
          const init: Record<string, unknown> = {
            method,
            headers,
            body: opts.body,
            // H-6 / SEC-19: never follow a redirect — it could forward the
            // body and custom auth headers (x-sn-apikey) cross-origin.
            redirect: "manual",
            signal: anySignal([
              AbortSignal.timeout(Math.min(timeoutMs, left)),
              signal,
            ]),
          };
          if (opts.dispatcher) init.dispatcher = opts.dispatcher;
          obs.attempts = attempt + 1;
          return fetch(url, init);
        },
        { bypass: opts.bypassQueue, signal },
      );
    } catch (cause) {
      if (cause instanceof DeadlineReached) {
        throw deadlineError(attempt, "budget exhausted while queued");
      }
      if (cause instanceof SlotBusyError) {
        finish();
        countError(telemetry, "busy");
        logger.warn(`${system} request rejected — host busy`, {
          method,
          url: safeUrl,
          reason: cause.reason,
          queued: cause.queued,
        });
        throw makeError(
          `${system} request not sent: ${cause.message}`,
          undefined,
          undefined,
          {
            code: "BUSY",
            hint: BUSY_HINT,
          },
        );
      }
      const err = cause instanceof Error ? cause : new Error(String(cause));
      if (signal?.aborted) throw cancelledError();
      const timedOut = isAbortError(err);
      if (timedOut && clipped) {
        throw deadlineFailure(attempt + 1, "attempt cut by the deadline");
      }
      // Only retry transport errors for idempotent requests, to avoid
      // duplicating non-idempotent writes whose outcome is unknown.
      if (idempotent && attempt < maxRetries) {
        const wait = backoffMs(attempt + 1);
        if (wait >= remaining()) {
          throw deadlineFailure(
            attempt + 1,
            timedOut ? "timeout" : `transport error (${err.message})`,
          );
        }
        retrying(attempt, timedOut ? "timeout" : "transport", wait);
        await delay(wait, signal);
        continue;
      }
      logger.warn(`${system} request failed (transport)`, {
        method,
        url: safeUrl,
        timedOut,
        ms: Date.now() - started,
      });
      countError(telemetry, "transport");
      breakerFailure(host);
      finish();
      if (timedOut) {
        throw makeError(`Request to ${system} timed out after ${timeoutMs}ms.`);
      }
      throw makeError(
        `Could not reach ${system} at ${safeUrl}: ${err.message}`,
      );
    }

    // E-5 / L1-07: keep the instance's rate-limit headers for get_status.
    recordRateLimit(host, res.headers);

    if (isRedirectStatus(res.status)) {
      const target = redirectTarget(res, url);
      await discardBody(res);
      countError(telemetry, "redirect");
      breakerSuccess(host);
      finish();
      logger.warn(`${system} redirect refused`, {
        method,
        url: safeUrl,
        status: res.status,
        target,
      });
      throw makeError(
        `${system} answered HTTP ${res.status} with a redirect to ${target}; redirects are not followed.`,
        res.status,
        { redirectHost: target },
        { code: "REDIRECT_BLOCKED", hint: REDIRECT_HINT },
      );
    }

    if (onResponse && (await onResponse(res, attempt))) {
      retrying(attempt, "reauth");
      await discardBody(res); // release the socket
      continue;
    }

    if (
      !res.ok &&
      shouldRetryStatusFor(res.status, idempotent) &&
      attempt < maxRetries
    ) {
      const wait = retryAfterMs(res) ?? backoffMs(attempt + 1);
      await discardBody(res); // release the socket
      if (wait >= remaining()) {
        if (res.status >= 500) breakerFailure(host);
        throw deadlineError(attempt + 1, `HTTP ${res.status}`);
      }
      retrying(attempt, `HTTP ${res.status}`, wait);
      logger.debug(`Retrying ${system} request`, {
        method,
        url: safeUrl,
        status: res.status,
        attempt: attempt + 1,
        waitMs: wait,
      });
      await delay(wait, signal);
      continue;
    }

    if (!res.ok) {
      // Error bodies are only excerpted, so read a bounded prefix.
      const text = await readTextPrefix(res, MAX_ERROR_BODY_BYTES);
      const shaped = shapeErrorBody(
        text,
        res.headers.get("content-type"),
        extractDetail,
      );
      const summary = shaped.summary || res.statusText || "(no detail)";
      logger.warn(`${errorPrefix}`, {
        method,
        url: safeUrl,
        status: res.status,
        code: shaped.code,
        ms: Date.now() - started,
      });
      // The unshaped body can carry markup or secrets echoed by a proxy; it is
      // only useful when debugging and therefore only logged at that level.
      logger.debug(`${system} error body`, {
        url: safeUrl,
        status: res.status,
        body: text.slice(0, 4096),
      });
      countError(telemetry, res.status);
      // A 4xx is an answer from a live instance; only 5xx counts as a failure.
      if (res.status >= 500) breakerFailure(host);
      else breakerSuccess(host);
      finish();
      throw makeError(
        `${errorPrefix} (${res.status}): ${summary}`,
        res.status,
        shaped.detail,
        shaped.code ? { code: shaped.code, hint: shaped.hint } : undefined,
      );
    }

    breakerSuccess(host);
    const declared = declaredLength(res);
    const maxBody = getMaxBodyBytes();
    if (declared !== undefined && declared > maxBody) {
      await discardBody(res);
      countError(telemetry, "too_large");
      finish();
      throw makeError(
        `${system} response for ${safeUrl} declares ${declared} bytes, over the SN_MAX_BODY_BYTES limit of ${maxBody}.`,
        res.status,
        undefined,
        { code: "RESPONSE_TOO_LARGE", hint: TOO_LARGE_HINT },
      );
    }
    finish();
    logger.debug(`${system} request ok`, {
      method,
      url: safeUrl,
      status: res.status,
      ms: Date.now() - started,
    });
    return res;
  }
}

// --- redirects and bounded body reads (H-6 / SEC-19) ----------------------

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** True for the statuses fetch would follow under `redirect: "follow"`. */
export function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

/** Host (with port) a redirect points at, resolved against the request URL. */
function redirectTarget(res: Response, requestUrl: string): string {
  const location = res.headers.get("location");
  if (!location) return "(no Location header)";
  try {
    return new URL(location, requestUrl).host || "(unparseable Location)";
  } catch {
    return "(unparseable Location)";
  }
}

/** Longest error body read from the wire before it is shaped and capped. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** The Content-Length header as a number, when present and well-formed. */
function declaredLength(res: Response): number | undefined {
  const raw = res.headers.get("content-length");
  return raw && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined;
}

/** Drop a body we will not read so the connection is released. */
async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Already consumed or errored — nothing to release.
  }
}

/**
 * Read at most `limit` bytes of a body. Stops reading (and cancels the rest of
 * the stream) as soon as the limit is crossed, so an endless or oversized body
 * never lands in memory. `overflow` tells whether more bytes were available.
 */
async function readUpTo(
  res: Response,
  limit: number,
): Promise<{ bytes: Buffer; overflow: boolean }> {
  const body = res.body;
  if (!body) {
    // A body-less Response (or a non-streaming stand-in): read what exists.
    const all = Buffer.from(await res.arrayBuffer());
    return all.length > limit
      ? { bytes: all.subarray(0, limit), overflow: true }
      : { bytes: all, overflow: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      total = limit;
      await reader.cancel().catch(() => undefined);
      return { bytes: Buffer.concat(chunks, total), overflow: true };
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { bytes: Buffer.concat(chunks, total), overflow: false };
}

/** The first `limit` bytes of a body as UTF-8 text (never throws). */
async function readTextPrefix(res: Response, limit: number): Promise<string> {
  try {
    return (await readUpTo(res, limit)).bytes.toString("utf8");
  } catch {
    return "";
  }
}

/** Where a capped body read came from, for the error it raises. */
export interface BodyReadContext {
  system: string;
  safeUrl: string;
  makeError?: ErrorFactory;
  /** Byte limit; defaults to SN_MAX_BODY_BYTES. */
  limit?: number;
}

/**
 * Read a whole OK body, refusing with RESPONSE_TOO_LARGE once it passes
 * SN_MAX_BODY_BYTES (a missing or lying Content-Length is caught while
 * streaming). Every REST client reads its success bodies through this.
 */
export async function readBodyBytes(
  res: Response,
  ctx: BodyReadContext,
): Promise<Buffer> {
  const limit = ctx.limit ?? getMaxBodyBytes();
  const { bytes, overflow } = await readUpTo(res, limit);
  if (overflow) {
    const makeError: ErrorFactory =
      ctx.makeError ??
      ((message, status, detail, options) =>
        new ServiceNowError(message, status, detail, options));
    throw makeError(
      `${ctx.system} response for ${ctx.safeUrl} exceeded the SN_MAX_BODY_BYTES limit of ${limit} bytes.`,
      res.status,
      undefined,
      { code: "RESPONSE_TOO_LARGE", hint: TOO_LARGE_HINT },
    );
  }
  return bytes;
}

/** readBodyBytes decoded as UTF-8. */
export async function readBodyText(
  res: Response,
  ctx: BodyReadContext,
): Promise<string> {
  return (await readBodyBytes(res, ctx)).toString("utf8");
}

/** Parse a response body as JSON, tolerating an empty or non-JSON body. */
export async function readJsonBody(
  res: Response,
  ctx: BodyReadContext = { system: "HTTP", safeUrl: "(response)" },
): Promise<unknown> {
  const text = await readBodyText(res, ctx);
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}
