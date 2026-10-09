/**
 * M-2 (error contract v2, B3): every failed tool result carries a stable,
 * machine-readable `code` and a `source` next to the message (see
 * mcp/result.ts). The codes below are the closed set; the one open family is
 * `INSTANCE_HTTP_<status>` — the instance answered a call with that non-2xx
 * status and no more specific code applies. Each code's comment is its
 * documentation; ERROR_CODES (below) is the runtime table the manifest and the
 * tests read.
 */
export type ServiceNowErrorCode =
  /** The per-call deadline (SN_DEADLINE_MS) elapsed across attempts. */
  | "DEADLINE_EXCEEDED" /** The per-host request queue is full or the wait timed out (SN_MAX_QUEUE / SN_QUEUE_TIMEOUT_MS). */
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
   * `write_doc` on a generator-owned file, or a generator on a hand-written
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
  /**
   * N-20 EL-2: a write to a table that needs an elevated role (security_admin
   * on the ACL tables) was refused with 403. A REST session cannot elevate;
   * the hint names the role and the way around it.
   */
  | "ELEVATION_REQUIRED"
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
  | "SDK_MANAGED_SCOPE"
  /**
   * P-23: servicenow_upsert_artifact refuses the artefact type (a flow,
   * playbook or workflow graph, or a baseQuery-filtered view of a table).
   */
  | "NOT_WRITABLE_TYPE"
  /** P-23: the child table is not a writable child of the artefact type. */
  | "CHILD_NOT_WRITABLE"
  /**
   * P-24: a nested child names no parent, a parent that is not an earlier
   * child, or one whose table is not the descriptor's parent table.
   */
  | "CHILD_PARENT_INVALID"
  /**
   * P-24: an instance-wide unique field (sp_widget.id, sp_page.id,
   * sp_portal.url_suffix, …) already exists elsewhere or twice in the plan.
   */
  | "DUPLICATE_UNIQUE_FIELD"
  /** P-24: an SDK pre-flight rule refuses a value (catalog variable name). */
  | "PREFLIGHT_INVALID"
  /**
   * P-25: a flow accepts only {active} on an existing flow — unverified until
   * O-5 confirms master_snapshot stays unchanged.
   */
  | "FLOW_ACTIVE_ONLY"
  /** P-23: a field outside the type's write allow-list (the registry). */
  | "FIELD_NOT_ALLOWED"
  /** P-23: two children of one call share a key. */
  | "DUPLICATE_CHILD_KEY"
  /** P-23: more children on one table than the diff reads. */
  | "TOO_MANY_CHILDREN"
  /**
   * P-23: the plan writes a JSON field the registry marks `writable:false`
   * (§5(c)) — the plan is returned, the apply refused; nothing was sent.
   */
  | "PLAN_ONLY_FIELD"
  /**
   * M-2: H-3's plan_token named a plan preview whose TTL (SN_PLAN_TOKEN_TTL_SEC)
   * elapsed — preview again and apply with the fresh token; nothing was sent.
   */
  | "PLAN_EXPIRED"
  /** M-2: a local file the server needs (key, certificate, secret file) cannot be read. */
  | "UNREADABLE"
  /**
   * M-2: a profile change would leave credentials that cannot authenticate
   * (a missing field for its auth method) — nothing was saved.
   */
  | "CREDENTIALS_INCOMPLETE"
  /** M-2: a credential change was not confirmed by the user (elicitation declined, failed or unavailable). */
  | "CREDENTIALS_UNCONFIRMED"
  /** M-2: the arguments are invalid (schema, shape or value) — nothing was sent. */
  | "INVALID_INPUT"
  /** M-2: the named record, file, journal entry or object does not exist. */
  | "NOT_FOUND"
  /** M-2: the call conflicts with the current state (already exists, wrong state). */
  | "CONFLICT"
  /** M-2: one request attempt timed out (SN_TIMEOUT_MS) and retries were exhausted. */
  | "TIMEOUT"
  /** M-2: the instance could not be reached (DNS, TLS, connection refused). */
  | "UNREACHABLE"
  /** M-2: the instance answered 2xx but the body was not the expected API shape. */
  | "UNEXPECTED_RESPONSE"
  /** M-2: the `profile` argument names no configured connection profile. */
  | "UNKNOWN_PROFILE"
  /**
   * M-7 (B13): a profile name collides with a reserved resource URI segment
   * (docs, schema, status, capabilities, reference, profiles, policy).
   */
  | "RESERVED_PROFILE_NAME"
  /** M-5: the package name is not a known tool package. */
  | "UNKNOWN_PACKAGE"
  /** M-5: the package is denied by SN_PACKAGES_DENY. */
  | "PACKAGE_DENIED"
  /** M-5: the package is always on and cannot be disabled. */
  | "PACKAGE_ALWAYS_ON"
  /** M-5: the client session cannot change its package set (no per-session state). */
  | "NO_PACKAGE_SESSION"
  /** M-9: the task feature is not available (SN_EXPERIMENTAL_TASKS off, or the call cannot run as a task). */
  | "TASKS_UNAVAILABLE"
  /** N-10: a record watch would exceed the per-session or per-process cap. */
  | "WATCH_LIMIT"
  /** M-2: a request was refused for a reason no other code names (the status is kept). */
  | "REQUEST_FAILED"
  /** M-2: an unexpected server-side failure (a bug) — the message says what broke. */
  | "INTERNAL_ERROR";

/** M-2: the open code family for a non-2xx instance answer. */
export type InstanceHttpCode = `INSTANCE_HTTP_${number}`;

/** M-2: every code a failed tool result can carry. */
export type ToolErrorCode = ServiceNowErrorCode | InstanceHttpCode;

/**
 * M-2: where a failure came from, so a client can decide who must act:
 * `servicenow` — the instance answered with an error (or not with the API);
 * `policy` — this server's own policy or a confirmation step refused the call;
 * `server` — anything else this server detected (validation, transport,
 * configuration, bugs).
 */
export type ErrorSource = "servicenow" | "server" | "policy";

/** M-2: one row of the error-code table. */
export interface ErrorCodeInfo {
  source: ErrorSource;
  description: string;
}

/**
 * M-2: the runtime table of every static code — its source and one sentence.
 * The tool manifest (scripts/gen-manifest.mjs) publishes it as `errorCodes`;
 * test/error-contract.test.js keeps it in step with ServiceNowErrorCode.
 */
export const ERROR_CODES: Readonly<Record<ServiceNowErrorCode, ErrorCodeInfo>> =
  {
    DEADLINE_EXCEEDED: {
      source: "server",
      description:
        "The per-call deadline (SN_DEADLINE_MS) elapsed across attempts.",
    },
    BUSY: {
      source: "server",
      description:
        "The per-host request queue is full or the wait timed out (SN_MAX_QUEUE / SN_QUEUE_TIMEOUT_MS).",
    },
    UPSTREAM_HTML: {
      source: "servicenow",
      description:
        "The error body was an HTML page (proxy, WAF, SSO) rather than an API body.",
    },
    INSTANCE_HTML_RESPONSE: {
      source: "servicenow",
      description:
        "The instance answered with an HTML page (hibernating PDI, login page) instead of JSON.",
    },
    CIRCUIT_OPEN: {
      source: "server",
      description:
        "The per-host circuit breaker is open after consecutive failures.",
    },
    REDIRECT_BLOCKED: {
      source: "servicenow",
      description:
        "The instance answered with a 3xx redirect; redirects are never followed.",
    },
    RESPONSE_TOO_LARGE: {
      source: "server",
      description: "A response body exceeded SN_MAX_BODY_BYTES.",
    },
    PAYLOAD_TOO_LARGE: {
      source: "server",
      description: "A local payload (upload, document) exceeded its size cap.",
    },
    MIME_NOT_ALLOWED: {
      source: "policy",
      description:
        "An upload content type is not listed in SN_UPLOAD_MIME_ALLOW.",
    },
    RECIPIENT_NOT_ALLOWED: {
      source: "policy",
      description:
        "An email recipient is outside SN_EMAIL_ALLOWED_DOMAINS or the instance's own directory.",
    },
    NOT_REVERTIBLE: {
      source: "server",
      description: "A write-journal entry cannot be reverted.",
    },
    STALE_RECORD: {
      source: "server",
      description:
        "The record changed after the journaled write or the plan; force:true overrides.",
    },
    AMBIGUOUS_KEY: {
      source: "server",
      description:
        "An upsert key matches more than one record, or one the user cannot read.",
    },
    DOC_GENERATED: {
      source: "server",
      description:
        "A docs-store write would cross the generated / hand-written line.",
    },
    CANCELLED: {
      source: "server",
      description:
        "The client cancelled the tool call; nothing further was sent.",
    },
    AUTH_EXPIRED: {
      source: "servicenow",
      description:
        "The bearer token (SN_AUTH=token) was rejected with 401 — rotate it.",
    },
    ELEVATION_REQUIRED: {
      source: "servicenow",
      description:
        "A write to a table that needs an elevated role (security_admin) was refused with 403 — elevate in the UI or deliver it in an update set.",
    },
    UPDATE_SET_NOT_FOUND: {
      source: "server",
      description: "The named update set does not exist or is not readable.",
    },
    UPDATE_SET_NOT_IN_PROGRESS: {
      source: "server",
      description:
        "A write was bound to an update set that is not in progress.",
    },
    PROPERTY_NOT_FOUND: {
      source: "server",
      description:
        "The named system property does not exist or is not readable.",
    },
    NOT_CONFIGURED: {
      source: "server",
      description:
        "The profile lacks what its auth method needs; the hint names the missing fields.",
    },
    PLAN_REQUIRED: {
      source: "policy",
      description:
        "A destructive apply needs the plan_token of a matching plan preview; nothing was sent.",
    },
    PLAN_EXPIRED: {
      source: "policy",
      description:
        "The plan_token's preview expired; preview again and apply with the new token.",
    },
    CONFIRM_DECLINED: {
      source: "policy",
      description:
        "The user declined (or could not answer) the destructive-apply confirmation.",
    },
    POLICY_DENIED: {
      source: "policy",
      description:
        "The table, package or read-only policy refused the call; the hint names the setting.",
    },
    WRITE_CAP: {
      source: "policy",
      description:
        "A session or batch write cap would be exceeded; nothing was sent.",
    },
    CONFIRM_REQUIRED: {
      source: "policy",
      description:
        "A destructive apply on a prod profile from a client that cannot confirm it.",
    },
    SDK_MANAGED_SCOPE: {
      source: "policy",
      description:
        "SN_SDK_MANAGED_WRITES=deny and the record belongs to an SDK-managed scope.",
    },
    NOT_WRITABLE_TYPE: {
      source: "server",
      description: "servicenow_upsert_artifact refuses this artefact type.",
    },
    CHILD_NOT_WRITABLE: {
      source: "server",
      description:
        "The child table is not a writable child of the artefact type.",
    },
    CHILD_PARENT_INVALID: {
      source: "server",
      description: "A nested child names no valid earlier parent.",
    },
    DUPLICATE_UNIQUE_FIELD: {
      source: "server",
      description:
        "An instance-wide unique field value already exists or repeats in the plan.",
    },
    PREFLIGHT_INVALID: {
      source: "server",
      description: "An SDK pre-flight rule refuses a value.",
    },
    FLOW_ACTIVE_ONLY: {
      source: "server",
      description: "An existing flow accepts only {active}.",
    },
    FIELD_NOT_ALLOWED: {
      source: "policy",
      description: "A field outside the artefact type's write allow-list.",
    },
    DUPLICATE_CHILD_KEY: {
      source: "server",
      description: "Two children of one call share a key.",
    },
    TOO_MANY_CHILDREN: {
      source: "server",
      description: "More children on one table than the diff reads.",
    },
    PLAN_ONLY_FIELD: {
      source: "policy",
      description:
        "The plan writes a field the registry marks writable:false; the apply is refused.",
    },
    UNREADABLE: {
      source: "server",
      description:
        "A local file the server needs (key, certificate, secret file) cannot be read.",
    },
    CREDENTIALS_INCOMPLETE: {
      source: "policy",
      description:
        "The credential change would leave a profile that cannot authenticate; nothing was saved.",
    },
    CREDENTIALS_UNCONFIRMED: {
      source: "policy",
      description:
        "The user did not confirm the credential change; nothing was saved.",
    },
    INVALID_INPUT: {
      source: "server",
      description: "The arguments are invalid; nothing was sent.",
    },
    NOT_FOUND: {
      source: "server",
      description: "The named record, file or object does not exist.",
    },
    CONFLICT: {
      source: "server",
      description: "The call conflicts with the current state.",
    },
    TIMEOUT: {
      source: "server",
      description:
        "A request attempt timed out (SN_TIMEOUT_MS) and retries were exhausted.",
    },
    UNREACHABLE: {
      source: "server",
      description:
        "The instance could not be reached (DNS, TLS, connection refused).",
    },
    UNEXPECTED_RESPONSE: {
      source: "servicenow",
      description:
        "The instance answered 2xx with a body that is not the expected API shape.",
    },
    UNKNOWN_PROFILE: {
      source: "server",
      description:
        "The profile argument names no configured connection profile.",
    },
    RESERVED_PROFILE_NAME: {
      source: "server",
      description:
        "The profile name is reserved (a servicenow:// resource segment); rename the profile.",
    },
    UNKNOWN_PACKAGE: {
      source: "server",
      description: "The name is not a known tool package.",
    },
    PACKAGE_DENIED: {
      source: "policy",
      description: "The package is denied by SN_PACKAGES_DENY.",
    },
    PACKAGE_ALWAYS_ON: {
      source: "server",
      description: "The package is always on and cannot be disabled.",
    },
    NO_PACKAGE_SESSION: {
      source: "server",
      description: "The client session cannot change its package set.",
    },
    TASKS_UNAVAILABLE: {
      source: "server",
      description:
        "MCP tasks are unavailable for this call (SN_EXPERIMENTAL_TASKS).",
    },
    WATCH_LIMIT: {
      source: "server",
      description:
        "A record-watch subscription would exceed SN_RECORD_WATCH_MAX_PER_SESSION or SN_RECORD_WATCH_MAX.",
    },
    REQUEST_FAILED: {
      source: "server",
      description: "A request was refused for a reason no other code names.",
    },
    INTERNAL_ERROR: {
      source: "server",
      description: "An unexpected server-side failure.",
    },
  };

/** M-2: the documentation row of the `INSTANCE_HTTP_<status>` family. */
export const INSTANCE_HTTP_CODE_INFO: ErrorCodeInfo = {
  source: "servicenow",
  description:
    "INSTANCE_HTTP_<status>: the instance answered with that non-2xx status and no more specific code applies; `detail` carries its error body.",
};

/**
 * M-2: the published error-code table (the tool manifest's `errorCodes`):
 * every fixed code plus the `INSTANCE_HTTP_<status>` family, sorted by code.
 */
export function errorCodeTable(): Record<string, ErrorCodeInfo> {
  const rows: [string, ErrorCodeInfo][] = [
    ...Object.entries(ERROR_CODES),
    ["INSTANCE_HTTP_<status>", INSTANCE_HTTP_CODE_INFO],
  ];
  return Object.fromEntries(rows.sort(([a], [b]) => a.localeCompare(b)));
}

/** M-2: the code of a non-2xx instance answer. */
export function instanceHttpCode(status: number): InstanceHttpCode {
  return `INSTANCE_HTTP_${status}`;
}

/** M-2: the source a code implies (unknown codes count as server-side). */
export function sourceOfCode(code: string): ErrorSource {
  if (code.startsWith("INSTANCE_HTTP_")) return "servicenow";
  return (
    (ERROR_CODES as Record<string, ErrorCodeInfo | undefined>)[code]?.source ??
    "server"
  );
}

/** The hint every CANCELLED error carries. */
export const CANCELLED_HINT =
  "The client cancelled the tool call; no further request was sent. Writes that completed before the cancellation stay applied (see the write journal) — re-run the call if the work is still wanted.";

/** The fix every NOT_CONFIGURED error carries (after the missing fields). */
export const NOT_CONFIGURED_HINT =
  "Call servicenow_set_credentials (instance + the auth fields), or set SN_INSTANCE / SN_USER / SN_PASSWORD in the env file and restart; servicenow_get_status shows what is missing.";

/** Optional structured fields an error can carry besides status and detail. */
export interface ServiceNowErrorOptions {
  code?: ToolErrorCode;
  /** One actionable sentence for the reader ("reduce X", "check Y"). */
  hint?: string;
  /**
   * M-2: who failed — set by the request primitive for an upstream answer;
   * otherwise derived from the code (sourceOfCode).
   */
  source?: ErrorSource;
}

/**
 * ARCH-11b: the neutral base of every error this server raises on purpose —
 * for any integrated system, not only ServiceNow. `status` is the HTTP status
 * when known (the upstream's, or a client-side refusal's), `detail` the parsed
 * upstream error body, `code`/`hint`/`source` the M-2 contract fields. The
 * result boundary (mcp/result.ts) narrows on this class.
 */
export class IntegrationError extends Error {
  public readonly code?: ToolErrorCode;
  public readonly hint?: string;
  public readonly source?: ErrorSource;

  constructor(
    message: string,
    public readonly status?: number,
    public readonly detail?: unknown,
    options?: ServiceNowErrorOptions,
  ) {
    super(message);
    this.name = "IntegrationError";
    if (options?.code) this.code = options.code;
    if (options?.hint) this.hint = options.hint;
    if (options?.source) this.source = options.source;
  }
}

/**
 * Error thrown when a ServiceNow request fails — either before it leaves the
 * client (bad host, missing credentials, policy denial) or because the API
 * returned a non-2xx response. `status` is the HTTP status when known and
 * `detail` is the parsed ServiceNow error body, so callers can react
 * differently to 401 vs 403 vs 429.
 */
export class ServiceNowError extends IntegrationError {
  constructor(
    message: string,
    status?: number,
    detail?: unknown,
    options?: ServiceNowErrorOptions,
  ) {
    super(message, status, detail, options);
    this.name = "ServiceNowError";
  }
}

/** M-2: the code a status implies for an error that names none. */
function codeOfStatus(status: number | undefined): ServiceNowErrorCode {
  switch (status) {
    case 400:
    case 422:
      return "INVALID_INPUT";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 413:
      return "PAYLOAD_TOO_LARGE";
    default:
      return "REQUEST_FAILED";
  }
}

function isZodError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "ZodError" &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

/**
 * M-2: the code a failure carries — its own, `INSTANCE_HTTP_<status>` for an
 * upstream answer without one, a status-derived code for a client-side
 * refusal, INVALID_INPUT for a schema error and INTERNAL_ERROR for anything
 * else. Never undefined: every failed tool result has a code.
 */
export function errorCodeOf(error: unknown): ToolErrorCode {
  if (error instanceof IntegrationError) {
    if (error.code) return error.code;
    if (error.source === "servicenow" && error.status !== undefined) {
      return instanceHttpCode(error.status);
    }
    return codeOfStatus(error.status);
  }
  if (isZodError(error)) return "INVALID_INPUT";
  return "INTERNAL_ERROR";
}

/** M-2: the source of a failure — its own, else the one its code implies. */
export function errorSourceOf(error: unknown): ErrorSource {
  if (error instanceof IntegrationError && error.source) return error.source;
  return sourceOfCode(errorCodeOf(error));
}

/** M-3: true for the CANCELLED error a client cancellation raises. */
export function isCancelledError(error: unknown): boolean {
  return error instanceof ServiceNowError && error.code === "CANCELLED";
}

/**
 * M-3: rethrow a cancellation, so a read that degrades on failure stops
 * instead of turning the cancel into an "unavailable" warning.
 */
export function rethrowIfCancelled(error: unknown): void {
  if (isCancelledError(error)) throw error;
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
