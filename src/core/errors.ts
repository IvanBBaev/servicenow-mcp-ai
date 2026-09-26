/**
 * Machine-readable error codes for failures the model (or an operator) should
 * react to differently from a generic transport/API error. They ride on the
 * error result next to `status` and `snDetail` (see mcp/result.ts).
 */
export type ServiceNowErrorCode =
  /** The per-call deadline (SN_DEADLINE_MS) elapsed across attempts. */
  | "DEADLINE_EXCEEDED"
  /** The per-host request queue is full or the wait timed out (SN_MAX_QUEUE / SN_QUEUE_TIMEOUT_MS). */
  | "BUSY"
  /** The error body was an HTML page (proxy, WAF, SSO redirect) rather than an API body. */
  | "UPSTREAM_HTML"
  /**
   * The instance answered an API call with an HTML page — typically a
   * hibernating developer instance (PDI) or a login page reached through a
   * redirect — instead of a JSON body (H-8 C-3).
   */
  | "INSTANCE_HTML_RESPONSE"
  /** The per-host circuit breaker is open after consecutive failures. */
  | "CIRCUIT_OPEN"
  /**
   * The server answered with a 3xx redirect. Redirects are never followed
   * (H-6): a redirect could forward the body and custom auth headers to
   * another origin. The message names the target host.
   */
  | "REDIRECT_BLOCKED"
  /** A response body exceeded SN_MAX_BODY_BYTES (declared or streamed). */
  | "RESPONSE_TOO_LARGE"
  /** A local payload (upload, document) exceeded its size cap. */
  | "PAYLOAD_TOO_LARGE"
  /** An upload content type is not listed in SN_UPLOAD_MIME_ALLOW. */
  | "MIME_NOT_ALLOWED"
  /**
   * An email recipient is outside SN_EMAIL_ALLOWED_DOMAINS or, without that
   * variable, not a user in the instance's own directory (H-6 / SEC-14).
   */
  | "RECIPIENT_NOT_ALLOWED"
  /**
   * S-2: a journal entry cannot be reverted — unknown id, not an applied
   * instance write, no (or a redacted) `before` state, or an origin whose
   * inverse cannot be built. The message carries the reason.
   */
  | "NOT_REVERTIBLE"
  /**
   * S-2 (and H-3's optimistic concurrency): the record changed after the
   * journaled write (`sys_mod_count` or the written values moved on), so the
   * revert would overwrite someone else's change; `force:true` overrides.
   */
  | "STALE_RECORD"
  /**
   * S-8: an upsert key matches more than one record, or a record the user
   * cannot read — the create-or-update decision cannot be made safely.
   */
  | "AMBIGUOUS_KEY"
  /**
   * A docs-store write would cross the generated / hand-written line (S-14):
   * `docs_write` on a generator-owned file, or a generator on a hand-written
   * one, without `overwrite: true`.
   */
  | "DOC_GENERATED"
  /**
   * M-3: the client cancelled the tool call (notifications/cancelled). The
   * in-flight request was aborted and nothing further was sent or retried.
   */
  | "CANCELLED"
  /**
   * L6-02: the bearer token (SN_AUTH=token) was rejected with 401 and no
   * fresher token was available from SN_TOKEN_FILE — rotate it.
   */
  | "AUTH_EXPIRED"
  /** S-6: the named update set (sys_id or name) does not exist or is not readable. */
  | "UPDATE_SET_NOT_FOUND"
  /** S-6: an applied write was bound to an update set that is not "in progress". */
  | "UPDATE_SET_NOT_IN_PROGRESS"
  /** S-10: servicenow_set_property names no readable sys_properties row. */
  | "PROPERTY_NOT_FOUND"
  /**
   * M-1: the profile lacks what its auth method needs (no instance, no
   * user/password, no API key, …) — nothing was sent. The hint names the
   * missing fields and the fix (servicenow_set_credentials or the env file).
   */
  | "NOT_CONFIGURED"
  /**
   * H-3: a destructive `apply:true` under SN_DESTRUCTIVE_CONFIRM=token|elicit
   * without the `plan_token` of a matching, unexpired, unused plan preview —
   * nothing was sent. The message says why the token did not match.
   */
  | "PLAN_REQUIRED"
  /**
   * H-3: SN_DESTRUCTIVE_CONFIRM=elicit asked the client to confirm a
   * destructive apply and the user declined (or the prompt failed) — nothing
   * was sent; the refusal is journaled.
   */
  | "CONFIRM_DECLINED"
  /**
   * H-11: the table policy refused the call (SN_TABLES_ALLOW / SN_TABLES_DENY,
   * a protected table under SN_PROTECTED_TABLES_WRITE=deny, or
   * SN_IMPORT_SET_TABLES). servicenow_explain_policy names the rule.
   */
  | "POLICY_DENIED"
  /**
   * H-11 (L3-02): a session or batch write cap (SN_MAX_WRITES_PER_SESSION,
   * SN_MAX_DELETES_PER_SESSION, SN_MAX_BATCH_WRITES) would be exceeded —
   * nothing was sent.
   */
  | "WRITE_CAP"
  /**
   * H-11 (L3-03 / L5-04): a destructive apply on a prod profile in apply mode
   * from a client that cannot confirm it (no elicitation) — nothing was sent.
   */
  | "CONFIRM_REQUIRED"
  /**
   * P-22: SN_SDK_MANAGED_WRITES=deny and the record belongs to a scope whose
   * source of truth is a ServiceNow SDK project (P-3) — nothing was sent.
   */
  | "SDK_MANAGED_SCOPE";

/** The hint every CANCELLED error carries. */
export const CANCELLED_HINT =
  "The client cancelled the tool call; no further request was sent. Writes that completed before the cancellation stay applied (see the write journal) — re-run the call if the work is still wanted.";

/** The fix every NOT_CONFIGURED error carries (after the missing fields). */
export const NOT_CONFIGURED_HINT =
  "Call servicenow_set_credentials (instance + the auth fields), or set SN_INSTANCE / SN_USER / SN_PASSWORD in the env file and restart; servicenow_get_status shows what is missing.";

/** Optional structured fields an error can carry besides status and detail. */
export interface ServiceNowErrorOptions {
  code?: ServiceNowErrorCode;
  /** One actionable sentence for the reader ("reduce X", "check Y"). */
  hint?: string;
}

/**
 * Error thrown when a ServiceNow request fails — either before it leaves the
 * client (bad host, missing credentials, policy denial) or because the API
 * returned a non-2xx response. `status` is the HTTP status when known and
 * `detail` is the parsed ServiceNow error body, so callers can react
 * differently to 401 vs 403 vs 429. `code`/`hint` are set for the client-side
 * conditions listed in ServiceNowErrorCode.
 */
export class ServiceNowError extends Error {
  public readonly code?: ServiceNowErrorCode;
  public readonly hint?: string;

  constructor(
    message: string,
    public readonly status?: number,
    public readonly detail?: unknown,
    options?: ServiceNowErrorOptions,
  ) {
    super(message);
    this.name = "ServiceNowError";
    if (options?.code) this.code = options.code;
    if (options?.hint) this.hint = options.hint;
  }
}

/**
 * Error thrown when a Jira request fails. It extends ServiceNowError — the
 * server's established error type — so every existing boundary (result
 * mapping, policy guards, tests) handles it uniformly, while the distinct
 * class and name let a caller tell the two systems apart.
 */
export class JiraError extends ServiceNowError {
  constructor(
    message: string,
    status?: number,
    detail?: unknown,
    options?: ServiceNowErrorOptions,
  ) {
    super(message, status, detail, options);
    this.name = "JiraError";
  }
}

/**
 * M-1 — the recoverable "not configured" error: the message keeps its wording,
 * the code is NOT_CONFIGURED and the hint names what is missing (field roles,
 * never values) and how to fix it, so the model can configure the profile
 * without a human reading stderr.
 */
export function notConfiguredError(
  message: string,
  missing: readonly string[] = [],
  profile?: string,
): ServiceNowError {
  const what = missing.length
    ? `Missing${profile ? ` for profile "${profile}"` : ""}: ${missing.join(", ")}. `
    : "";
  return new ServiceNowError(message, undefined, undefined, {
    code: "NOT_CONFIGURED",
    hint: `${what}${NOT_CONFIGURED_HINT}`,
  });
}
