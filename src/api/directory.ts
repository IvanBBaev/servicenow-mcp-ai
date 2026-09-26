import { ServiceNowError } from "../core/errors.js";
import { assertTableAllowed } from "../core/policy.js";
import { assertNoCaret, snString } from "./shared.js";
import { queryTable, type SnRecord } from "./table.js";

/**
 * S-10 — read-only lookups of users, groups and roles, with the membership
 * and role facts an agent needs to reason about "who can do this":
 *
 *   user  → sys_user;       details: roles (sys_user_has_role), groups (sys_user_grmember)
 *   group → sys_user_group; details: members (sys_user_grmember), roles (sys_group_has_role)
 *   role  → sys_user_role;  details: contained roles (sys_user_role_contains), groups (sys_group_has_role)
 *
 * The main table goes through the table policy (a denial errors). Each detail
 * read degrades on its own: a policy-denied or instance-refused (400/403/404)
 * relation table is reported under `details_unavailable`.
 */

export type DirectoryKind = "user" | "group" | "role";

interface KindSpec {
  table: string;
  fields: string[];
  /** Encoded clauses for a search term (OR'ed; placed last in the query). */
  search: (term: string) => string;
  activeField?: string;
  order: string;
}

const KINDS: Record<DirectoryKind, KindSpec> = {
  user: {
    table: "sys_user",
    fields: [
      "sys_id",
      "user_name",
      "name",
      "email",
      "active",
      "title",
      "department",
      "manager",
      "locked_out",
    ],
    search: (t) =>
      `user_nameSTARTSWITH${t}^ORemailSTARTSWITH${t}^ORnameLIKE${t}`,
    activeField: "active",
    order: "ORDERBYuser_name",
  },
  group: {
    table: "sys_user_group",
    fields: [
      "sys_id",
      "name",
      "description",
      "active",
      "manager",
      "email",
      "type",
    ],
    search: (t) => `nameLIKE${t}`,
    activeField: "active",
    order: "ORDERBYname",
  },
  role: {
    table: "sys_user_role",
    fields: [
      "sys_id",
      "name",
      "description",
      "elevated_privilege",
      "sys_scope",
    ],
    search: (t) => `nameLIKE${t}`,
    order: "ORDERBYname",
  },
};

const DEGRADE_STATUSES = new Set([400, 403, 404]);

export interface DirectoryQuery {
  kind: DirectoryKind;
  /** Name / user_name / email search term. */
  term?: string;
  sysId?: string;
  /** Only active users / groups (ignored for roles). */
  active?: boolean;
  /** Add memberships and roles when the lookup resolves to one record. */
  includeDetails?: boolean;
  limit?: number;
}

interface DetailRead {
  key: string;
  table: string;
  query: string;
  fields: string[];
  map: (r: SnRecord) => Record<string, unknown>;
}

const DETAIL_LIMIT = 200;

function detailReads(kind: DirectoryKind, id: string): DetailRead[] {
  switch (kind) {
    case "user":
      return [
        {
          key: "roles",
          table: "sys_user_has_role",
          query: `user=${id}^ORDERBYrole.name`,
          fields: ["role", "role.name", "inherited", "state"],
          map: (r) => ({
            name: snString(r["role.name"]),
            sys_id: snString(r.role),
            inherited: snString(r.inherited) === "true",
            ...(snString(r.state) ? { state: snString(r.state) } : {}),
          }),
        },
        {
          key: "groups",
          table: "sys_user_grmember",
          query: `user=${id}^ORDERBYgroup.name`,
          fields: ["group", "group.name"],
          map: (r) => ({
            name: snString(r["group.name"]),
            sys_id: snString(r.group),
          }),
        },
      ];
    case "group":
      return [
        {
          key: "members",
          table: "sys_user_grmember",
          query: `group=${id}^ORDERBYuser.user_name`,
          fields: ["user", "user.user_name", "user.name", "user.active"],
          map: (r) => ({
            user_name: snString(r["user.user_name"]),
            name: snString(r["user.name"]),
            sys_id: snString(r.user),
            active: snString(r["user.active"]) === "true",
          }),
        },
        {
          key: "roles",
          table: "sys_group_has_role",
          query: `group=${id}^ORDERBYrole.name`,
          fields: ["role", "role.name", "inherits"],
          map: (r) => ({
            name: snString(r["role.name"]),
            sys_id: snString(r.role),
            ...(snString(r.inherits)
              ? { inherits: snString(r.inherits) === "true" }
              : {}),
          }),
        },
      ];
    case "role":
      return [
        {
          key: "contains",
          table: "sys_user_role_contains",
          query: `role=${id}^ORDERBYcontains.name`,
          fields: ["contains", "contains.name"],
          map: (r) => ({
            name: snString(r["contains.name"]),
            sys_id: snString(r.contains),
          }),
        },
        {
          key: "groups",
          table: "sys_group_has_role",
          query: `role=${id}^ORDERBYgroup.name`,
          fields: ["group", "group.name"],
          map: (r) => ({
            name: snString(r["group.name"]),
            sys_id: snString(r.group),
          }),
        },
      ];
  }
}

async function readDetail(
  d: DetailRead,
): Promise<
  | { ok: true; items: Record<string, unknown>[]; truncated: boolean }
  | { ok: false; reason: Record<string, unknown> }
> {
  try {
    assertTableAllowed(d.table);
  } catch (error) {
    return {
      ok: false,
      reason: {
        table: d.table,
        policy: "denied",
        reason: (error as Error).message,
      },
    };
  }
  try {
    const { records, total } = await queryTable({
      table: d.table,
      query: d.query,
      fields: d.fields,
      displayValue: "false",
      limit: DETAIL_LIMIT,
    });
    return {
      ok: true,
      items: records.map(d.map),
      truncated: total !== undefined && total > records.length,
    };
  } catch (error) {
    const status = error instanceof ServiceNowError ? error.status : undefined;
    if (status === undefined || !DEGRADE_STATUSES.has(status)) throw error;
    return {
      ok: false,
      reason: { table: d.table, status, reason: (error as Error).message },
    };
  }
}

/** S-10 — find users, groups or roles, optionally with their relations. */
export async function lookupDirectory(
  opts: DirectoryQuery,
): Promise<Record<string, unknown>> {
  const spec = KINDS[opts.kind];
  assertTableAllowed(spec.table);
  const clauses: string[] = [];
  if (opts.sysId) clauses.push(`sys_id=${opts.sysId}`);
  if (opts.active !== undefined && spec.activeField) {
    clauses.push(`${spec.activeField}=${opts.active}`);
  }
  const term = opts.term?.trim();
  if (term) {
    assertNoCaret(term, "term");
    // The OR group goes last: ^OR binds to the clause just before it.
    clauses.push(spec.search(term));
  }
  if (!opts.sysId && !term) {
    throw new ServiceNowError("Give a search term or a sys_id.", 400);
  }
  clauses.push(spec.order);
  const limit = Math.min(opts.limit ?? 20, 200);
  const { records, total } = await queryTable({
    table: spec.table,
    query: clauses.join("^"),
    fields: spec.fields,
    displayValue: "false",
    limit,
  });
  const result: Record<string, unknown> = {
    kind: opts.kind,
    count: records.length,
    ...(total === undefined ? {} : { total }),
    truncated: total !== undefined && total > records.length,
    records,
  };
  if (!opts.includeDetails) return result;
  if (records.length !== 1) {
    result.note =
      "Details (roles, groups, members) are added only when the lookup matches exactly one record; narrow it with sys_id or a more specific term.";
    return result;
  }
  const id = snString((records[0] as SnRecord).sys_id);
  const details: Record<string, unknown> = {};
  const unavailable: Record<string, unknown>[] = [];
  for (const d of detailReads(opts.kind, id)) {
    const read = await readDetail(d);
    if (read.ok) {
      details[d.key] = read.items;
      if (read.truncated) details[`${d.key}_truncated`] = true;
    } else {
      unavailable.push({ detail: d.key, ...read.reason });
    }
  }
  result.details = details;
  if (unavailable.length) result.details_unavailable = unavailable;
  return result;
}
