import {
  CANCELLED_HINT,
  IntegrationError,
  ServiceNowError,
  instanceHttpCode,
} from "./errors.js";
import { userAgent } from "./identity.js";
import { logger } from "./logging.js";
import { publishRequestEvent, recordRateLimit } from "./metrics.js";
import { redactValue } from "./redaction.js";
import { currentCall, logContext } from "./request-context.js";
import { outboundTraceHeaders } from "./tracing.js";
import {
  getDeadlineMs,
  getMaxBodyBytes,
  getMaxRetries,
  getTimeoutMs,
  otelPropagate,
} from "./settings.js";
import { type ErrorFactory, shapeErrorBody } from "./http-error-body.js";
import {
  anySignal,
  backoffMs,
  delay,
  isAbortError,
  isIdempotent,
  retryAfterMs,
  shouldRetryStatusFor,
} from "./http-retry.js";
import { countError, telemetryFor } from "./http-telemetry.js";
import {
  breakerCheck,
  breakerFailure,
  breakerSuccess,
  CircuitOpen,
  SlotBusyError,
  withSlot,
} from "./http-limits.js";
import {
  declaredLength,
  discardBody,
  isRedirectStatus,
  MAX_ERROR_BODY_BYTES,
  readTextPrefix,
  redirectTarget,
  TOO_LARGE_HINT,
} from "./http-body.js";

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

export {
  type Telemetry,
  type TelemetrySnapshot,
  telemetryFor,
  getTelemetry,
  countError,
} from "./http-telemetry.js";
export {
  SlotBusyError,
  type SlotOptions,
  withSlot,
  getQueueStats,
  drainQueue,
  getBreakerStats,
  resetBreakers,
} from "./http-limits.js";
export {
  isIdempotent,
  shouldRetryStatus,
  shouldRetryStatusFor,
  backoffMs,
  retryAfterMs,
  delay,
  anySignal,
} from "./http-retry.js";
export {
  MAX_TEXT_DETAIL_CHARS,
  MAX_JSON_DETAIL_CHARS,
  HIBERNATING_HINT,
  INSTANCE_HTML_HINT,
  looksLikeHtml,
  isHibernationPage,
  htmlToText,
  type ErrorBody,
  shapeErrorBody,
  type ErrorFactory,
} from "./http-error-body.js";
export {
  isRedirectStatus,
  MAX_ERROR_BODY_BYTES,
  type BodyReadContext,
  readBodyBytes,
  readBodyText,
  readJsonBody,
} from "./http-body.js";

// --- the request primitive ------------------------------------------------

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

const TIMEOUT_HINT =
  "The instance did not answer in time — retry, narrow the request, or raise SN_TIMEOUT_MS.";

const UNREACHABLE_HINT =
  "Check the instance setting (SN_INSTANCE or the profile's instance), DNS and network access; a PDI may need waking at developer.servicenow.com.";

/**
 * M-2: the fix for the upstream statuses a reader can act on; the others
 * carry no hint (the instance's own `detail` explains them).
 */
const STATUS_HINTS: Readonly<Record<number, string>> = {
  401: "The instance rejected the credentials — check the profile's user/password (or its auth method's secrets) with servicenow_doctor.",
  403: "The instance's ACLs refused the call — the user needs a role that grants it, and REST API access policies may require snc_platform_rest_api_access.",
  429: "The instance is rate-limiting this user — wait and retry, or lower the request rate (servicenow_get_status shows the rate-limit headers).",
};

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
  // N-55: the tool call's id and W3C Trace Context ride along, so a
  // subscriber parents the request on the call's span.
  const call = currentCall();
  const base = (): Record<string, unknown> => ({
    id: obs.id,
    system: opts.system,
    method: opts.method,
    host: opts.host,
    telemetryKey: opts.telemetryKey ?? opts.host,
    url: opts.safeUrl,
    ...(logContext() ?? {}),
    ...(call?.callId !== undefined ? { callId: call.callId } : {}),
    ...(call?.trace
      ? {
          traceparent: call.trace.traceparent,
          ...(call.trace.tracestate
            ? { tracestate: call.trace.tracestate }
            : {}),
        }
      : {}),
  });
  const startMessage = publishRequestEvent("start", base);
  // N-55: trace headers go to the ServiceNow REST API only (never the OAuth
  // token endpoint or Jira), and only under SN_OTEL_PROPAGATE.
  if (opts.system === "ServiceNow" && otelPropagate()) {
    obs.traceHeaders = outboundTraceHeaders(startMessage, call?.trace);
  }
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
  /** N-55: `traceparent` / `tracestate` for every attempt (SN_OTEL_PROPAGATE). */
  traceHeaders?: Record<string, string> | undefined;
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

  const deadlineError = (attempts: number, last: string): IntegrationError => {
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

  const cancelledError = (): IntegrationError => {
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

  const deadlineFailure = (
    attempts: number,
    last: string,
  ): IntegrationError => {
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
      ...obs.traceHeaders,
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
        throw makeError(
          `Request to ${system} timed out after ${timeoutMs}ms.`,
          undefined,
          undefined,
          { code: "TIMEOUT", hint: TIMEOUT_HINT },
        );
      }
      throw makeError(
        `Could not reach ${system} at ${safeUrl}: ${err.message}`,
        undefined,
        undefined,
        { code: "UNREACHABLE", hint: UNREACHABLE_HINT },
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
        { code: "REDIRECT_BLOCKED", hint: REDIRECT_HINT, source: "servicenow" },
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
        {
          // M-2: an upstream answer always carries a code — the shaped one
          // (HTML pages) or INSTANCE_HTTP_<status>.
          code: shaped.code ?? instanceHttpCode(res.status),
          hint: shaped.hint ?? STATUS_HINTS[res.status],
          source: "servicenow",
        },
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
