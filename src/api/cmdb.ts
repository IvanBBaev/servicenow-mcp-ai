import { snRequest } from "../http.js";
import { assertTableAllowed, assertWriteAllowed } from "../policy.js";

/**
 * ServiceNow CMDB Instance API (`/api/now/cmdb/instance/{class}`) and CMDB Meta
 * API (`/api/now/cmdb/meta/{class}`). These are class-aware: create/update go
 * through Identification & Reconciliation (IRE), which is the correct way to
 * ingest CIs instead of a bare insert into cmdb_ci. The class name is treated
 * as a table for allow/deny policy.
 */

const INSTANCE = "/api/now/cmdb/instance";
const META = "/api/now/cmdb/meta";

export interface CmdbQuery {
  query?: string;
  limit?: number;
  offset?: number;
}

export async function listCmdbInstances(
  className: string,
  opts: CmdbQuery = {},
): Promise<unknown> {
  assertTableAllowed(className);
  const params = new URLSearchParams();
  if (opts.query) params.set("sysparm_query", opts.query);
  if (opts.limit !== undefined) params.set("sysparm_limit", String(opts.limit));
  if (opts.offset !== undefined)
    params.set("sysparm_offset", String(opts.offset));
  const { data } = await snRequest<{ result: unknown }>({
    method: "GET",
    path: `${INSTANCE}/${encodeURIComponent(className)}`,
    params,
  });
  return data.result;
}

export async function getCmdbInstance(
  className: string,
  sysId: string,
): Promise<unknown> {
  assertTableAllowed(className);
  const { data } = await snRequest<{ result: unknown }>({
    method: "GET",
    path: `${INSTANCE}/${encodeURIComponent(className)}/${encodeURIComponent(sysId)}`,
  });
  return data.result;
}

export interface CmdbWrite {
  className: string;
  attributes: Record<string, unknown>;
  /** Discovery source recorded by IRE (e.g. "ServiceNow"). */
  source?: string;
}

export async function createCmdbInstance(args: CmdbWrite): Promise<unknown> {
  assertTableAllowed(args.className);
  assertWriteAllowed("create CI");
  const body: Record<string, unknown> = { attributes: args.attributes };
  if (args.source) body.source = args.source;
  const { data } = await snRequest<{ result: unknown }>({
    method: "POST",
    path: `${INSTANCE}/${encodeURIComponent(args.className)}`,
    body,
  });
  return data.result;
}

export async function updateCmdbInstance(
  sysId: string,
  args: CmdbWrite,
): Promise<unknown> {
  assertTableAllowed(args.className);
  assertWriteAllowed("update CI");
  const body: Record<string, unknown> = { attributes: args.attributes };
  if (args.source) body.source = args.source;
  const { data } = await snRequest<{ result: unknown }>({
    method: "PATCH",
    path: `${INSTANCE}/${encodeURIComponent(args.className)}/${encodeURIComponent(sysId)}`,
    body,
  });
  return data.result;
}

export async function getCmdbMeta(className: string): Promise<unknown> {
  assertTableAllowed(className);
  const { data } = await snRequest<{ result: unknown }>({
    method: "GET",
    path: `${META}/${encodeURIComponent(className)}`,
  });
  return data.result;
}
