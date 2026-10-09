import { snRequest } from "../core/http.js";
import {
  assertTableAllowed,
  assertTableWriteAllowed,
  assertWriteAllowed,
} from "../core/policy.js";
import { getCredentials, activeProfile } from "../core/config.js";
import { cached } from "../core/cache.js";
import { ServiceNowError } from "../core/errors.js";
import {
  assertNoCaret,
  expectResult,
  snParams,
  snString,
  degradeStatus,
} from "./shared.js";
import { queryTable, type SnRecord } from "./table.js";
import { isSysIdAnyCase } from "../core/sys-id.js";

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
  const params = snParams({
    sysparm_query: opts.query,
    sysparm_limit: opts.limit,
    sysparm_offset: opts.offset,
  });
  const { data } = await snRequest<{ result: unknown }>({
    method: "GET",
    path: `${INSTANCE}/${encodeURIComponent(className)}`,
    params,
  });
  return expectResult(data, "CMDB API");
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
  return expectResult(data, "CMDB API");
}

export interface CmdbWrite {
  className: string;
  attributes: Record<string, unknown>;
  /** Discovery source recorded by IRE (e.g. "ServiceNow"). */
  source?: string;
}

export async function createCmdbInstance(args: CmdbWrite): Promise<unknown> {
  assertTableWriteAllowed(args.className);
  assertWriteAllowed("create CI");
  const body: Record<string, unknown> = { attributes: args.attributes };
  if (args.source) body.source = args.source;
  const { data } = await snRequest<{ result: unknown }>({
    method: "POST",
    path: `${INSTANCE}/${encodeURIComponent(args.className)}`,
    body,
  });
  return expectResult(data, "CMDB API");
}

export async function updateCmdbInstance(
  sysId: string,
  args: CmdbWrite,
): Promise<unknown> {
  assertTableWriteAllowed(args.className);
  assertWriteAllowed("update CI");
  const body: Record<string, unknown> = { attributes: args.attributes };
  if (args.source) body.source = args.source;
  const { data } = await snRequest<{ result: unknown }>({
    method: "PATCH",
    path: `${INSTANCE}/${encodeURIComponent(args.className)}/${encodeURIComponent(sysId)}`,
    body,
  });
  return expectResult(data, "CMDB API");
}

export async function getCmdbMeta(className: string): Promise<unknown> {
  assertTableAllowed(className);
  return cached(
    `${getCredentials().instance}#${activeProfile()}|cmdbMeta|${className}`,
    async () => {
      const { data } = await snRequest<{ result: unknown }>({
        method: "GET",
        path: `${META}/${encodeURIComponent(className)}`,
      });
      return expectResult(data, "CMDB API");
    },
  );
}

// --- relationships (cmdb_rel_ci) and IRE (S-10) ------------------------------

const REL_TABLE = "cmdb_rel_ci";
const REL_FIELDS = [
  "sys_id",
  "parent",
  "child",
  "type",
  "type.name",
  "parent.name",
  "parent.sys_class_name",
  "child.name",
  "child.sys_class_name",
];

export type RelationDirection = "both" | "outbound" | "inbound";

export interface CiRelationQuery {
  /** sys_id of the CI whose relationships to list. */
  ci: string;
  /** `outbound` = the CI is the parent, `inbound` = the child (default both). */
  direction?: RelationDirection;
  /** Relationship type name (e.g. 'Depends on::Used by') or its sys_id. */
  type?: string;
  limit?: number;
}

/**
 * S-10 — list the relationships of one CI from `cmdb_rel_ci`, each oriented
 * from that CI: `outbound` (it is the parent) or `inbound` (it is the child),
 * with the related CI's name and class. A table the instance will not let the
 * user read (403/404) degrades to an empty, explained result; the local table
 * policy still errors.
 */
export async function listCiRelations(
  opts: CiRelationQuery,
): Promise<Record<string, unknown>> {
  assertTableAllowed(REL_TABLE);
  const direction = opts.direction ?? "both";
  const clauses = [
    direction === "outbound"
      ? `parent=${opts.ci}`
      : direction === "inbound"
        ? `child=${opts.ci}`
        : `parent=${opts.ci}^ORchild=${opts.ci}`,
  ];
  const type = opts.type?.trim();
  if (type) {
    assertNoCaret(type, "type");
    clauses.push(isSysIdAnyCase(type) ? `type=${type}` : `type.name=${type}`);
  }
  clauses.push("ORDERBYtype.name");
  const limit = Math.min(opts.limit ?? 100, 1000);
  let records: SnRecord[];
  let total: number | undefined;
  try {
    ({ records, total } = await queryTable({
      table: REL_TABLE,
      query: clauses.join("^"),
      fields: REL_FIELDS,
      displayValue: "false",
      limit,
    }));
  } catch (error) {
    const status = degradeStatus(error);
    if (status === undefined) throw error;
    return {
      ci: opts.ci,
      direction,
      count: 0,
      relations: [],
      degraded: { status, reason: (error as Error).message },
    };
  }
  const relations = records.map((r) => {
    const outbound = snString(r.parent) === opts.ci;
    const side = outbound ? "child" : "parent";
    return {
      sys_id: snString(r.sys_id),
      direction: outbound ? "outbound" : "inbound",
      type: snString(r["type.name"]),
      type_sys_id: snString(r.type),
      ci: {
        sys_id: snString(r[side]),
        name: snString(r[`${side}.name`]),
        class: snString(r[`${side}.sys_class_name`]),
      },
    };
  });
  return {
    ci: opts.ci,
    direction,
    count: relations.length,
    ...(total === undefined ? {} : { total }),
    truncated: total !== undefined && total > relations.length,
    relations,
  };
}

export interface IreItem {
  className: string;
  values: Record<string, unknown>;
}

export interface IreRelation {
  /** Index of the parent item in `items`. */
  parent: number;
  /** Index of the child item in `items`. */
  child: number;
  /** Relationship type name, e.g. 'Runs on::Runs'. */
  type: string;
}

export interface IrePayload {
  items: IreItem[];
  relations?: IreRelation[];
  /** Discovery source (sysparm_data_source), e.g. 'ServiceNow'. */
  dataSource: string;
}

const IRE = "/api/now/identifyreconcile";

/** Policy for an IRE payload: every item class, and cmdb_rel_ci for relations. */
function assertIreAllowed(payload: IrePayload, write = false): void {
  // H-11: a reconcile writes the classes, so the protected list applies too.
  const check = write ? assertTableWriteAllowed : assertTableAllowed;
  for (const item of payload.items) check(item.className);
  if (payload.relations?.length) check(REL_TABLE);
  for (const rel of payload.relations ?? []) {
    for (const index of [rel.parent, rel.child]) {
      if (index < 0 || index >= payload.items.length) {
        throw new ServiceNowError(
          `IRE relation index ${index} is out of range (items has ${payload.items.length}).`,
          400,
        );
      }
    }
  }
}

async function ire(payload: IrePayload, path: string): Promise<unknown> {
  const { data } = await snRequest<{ result?: unknown }>({
    method: "POST",
    path,
    params: new URLSearchParams({ sysparm_data_source: payload.dataSource }),
    body: {
      items: payload.items,
      ...(payload.relations?.length ? { relations: payload.relations } : {}),
    },
  });
  // The IRE API answers with the report either at the top level or in `result`.
  return data?.result ?? data;
}

/**
 * S-10 — identification only (`/api/now/identifyreconcile/query`): what the
 * IRE would do with the payload (insert / update / no-op per item, matched
 * sys_ids, identification errors) without committing anything. An instance
 * that rejects the call (400/403/404) degrades to `{ degraded }`.
 */
export async function identifyCis(payload: IrePayload): Promise<unknown> {
  assertIreAllowed(payload);
  try {
    return await ire(payload, `${IRE}/query`);
  } catch (error) {
    // The policy already passed: a 400/403/404 here is the instance (no IRE
    // query endpoint, ACL) — degrade so the plan preview still renders.
    const status = degradeStatus(error);
    if (status === undefined) throw error;
    return { degraded: { status, reason: (error as Error).message } };
  }
}

/**
 * S-10 — identify and reconcile (`/api/now/identifyreconcile`): the IRE
 * inserts or updates the CIs and relationships of the payload. A write.
 */
export async function identifyReconcile(payload: IrePayload): Promise<unknown> {
  assertIreAllowed(payload, true);
  assertWriteAllowed("identify and reconcile CIs");
  return ire(payload, IRE);
}
