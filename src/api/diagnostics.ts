import { snRequest } from "../core/http.js";
import { getCredentials } from "../core/config.js";
import { ServiceNowError } from "../core/errors.js";

/** Result of a connectivity probe — failures are data, not exceptions. */
export interface ConnectionProbe {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  user?: string;
  message?: string;
  /** M-1: the error code (e.g. NOT_CONFIGURED) when the error carries one. */
  code?: string;
  /** M-1: the error's one-line fix, when it carries one. */
  hint?: string;
}

/**
 * Verify that the configured credentials actually work by reading a single
 * sys_user record. Uses snRequest directly on purpose: this is a diagnostic
 * on the admin surface, so a table allow/deny list must not mask it.
 */
export async function testConnection(): Promise<ConnectionProbe> {
  const started = Date.now();
  try {
    const params = new URLSearchParams({
      sysparm_limit: "1",
      sysparm_fields: "sys_id",
    });
    const { status } = await snRequest<unknown>({
      method: "GET",
      path: "/api/now/table/sys_user",
      params,
      // A diagnostic must answer while the per-host queue is stalled — that
      // is exactly when someone runs it.
      bypassQueue: true,
    });
    return {
      ok: true,
      status,
      latencyMs: Date.now() - started,
      user: getCredentials().user,
    };
  } catch (error) {
    if (error instanceof ServiceNowError) {
      // Structured, so the model can read and react (401 → fix credentials,
      // 403 → roles, timeout → connectivity).
      return {
        ok: false,
        status: error.status ?? null,
        latencyMs: Date.now() - started,
        message: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.hint ? { hint: error.hint } : {}),
      };
    }
    throw error;
  }
}
