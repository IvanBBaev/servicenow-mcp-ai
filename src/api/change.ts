import { snRequest } from "../core/http.js";
import { assertWriteAllowed } from "../core/policy.js";
import { ServiceNowError } from "../core/errors.js";
import { pluginCall } from "./plugin.js";

/**
 * ServiceNow Change Management API (`/api/sn_chg_rest/change`). Adds
 * change-process semantics on top of the change_request table: typed creation
 * (normal/standard/emergency) and conflict detection. Plugin-scoped.
 */

const BASE = "/api/sn_chg_rest/change";
const LABEL = "Change Management";

export type ChangeType = "normal" | "standard" | "emergency";

export interface ChangeQuery {
  query?: string;
  limit?: number;
  offset?: number;
  fields?: string[];
}

export async function listChanges(opts: ChangeQuery = {}): Promise<unknown> {
  const params = new URLSearchParams();
  if (opts.query) params.set("sysparm_query", opts.query);
  if (opts.limit !== undefined) params.set("sysparm_limit", String(opts.limit));
  if (opts.offset !== undefined)
    params.set("sysparm_offset", String(opts.offset));
  if (opts.fields?.length) params.set("sysparm_fields", opts.fields.join(","));
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: "GET",
      path: BASE,
      params,
    });
    return data.result;
  });
}

export async function getChange(sysId: string): Promise<unknown> {
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: "GET",
      path: `${BASE}/${encodeURIComponent(sysId)}`,
    });
    return data.result;
  });
}

export interface CreateChangeArgs {
  type: ChangeType;
  /** Required for standard changes: the standard change template sys_id. */
  templateId?: string;
  fields?: Record<string, unknown>;
}

export async function createChange(args: CreateChangeArgs): Promise<unknown> {
  assertWriteAllowed(`create ${args.type} change`);
  let path: string;
  if (args.type === "standard") {
    if (!args.templateId) {
      throw new ServiceNowError(
        "A standard change requires templateId (the standard change template sys_id).",
      );
    }
    path = `${BASE}/standard/${encodeURIComponent(args.templateId)}`;
  } else {
    path = `${BASE}/${args.type}`;
  }
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: "POST",
      path,
      body: args.fields ?? {},
    });
    return data.result;
  });
}

export async function updateChange(
  sysId: string,
  fields: Record<string, unknown>,
): Promise<unknown> {
  assertWriteAllowed("update change");
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: "PATCH",
      path: `${BASE}/${encodeURIComponent(sysId)}`,
      body: fields,
    });
    return data.result;
  });
}

/**
 * Read or (re)calculate schedule conflicts for a change. Calculation is a POST
 * that creates conflict records, so it is gated behind the write policy.
 */
export async function changeConflicts(
  sysId: string,
  calculate = false,
): Promise<unknown> {
  if (calculate) assertWriteAllowed("calculate change conflicts");
  return pluginCall(LABEL, async () => {
    const { data } = await snRequest<{ result: unknown }>({
      method: calculate ? "POST" : "GET",
      path: `${BASE}/${encodeURIComponent(sysId)}/conflict`,
    });
    return data.result;
  });
}
