import { rethrowIfCancelled } from "../core/errors.js";
import { throwIfCancelled } from "../core/progress.js";
import { scriptTables } from "./references.js";
import { SCRIPT_TYPES, scopeClause, scriptArtifact } from "./scripts.js";
import { snString } from "./shared.js";
import { queryTable } from "./table.js";

/**
 * N-14 (NX-18) — cross-scope access report for one scoped application.
 *
 * Outbound: the app's scripts are scanned (statically) for calls into other
 * scopes — scope-qualified script includes (`new x_other.Util()`,
 * `x_other.Util.run()`, `new GlideAjax('x_other.Util')`) and tables opened by
 * literal name whose sys_db_object row belongs to another scope. Each call is
 * joined to the app's sys_scope_privilege rows: `allowed` / `requested` /
 * `denied`, or `missing` when no row exists. Inbound: the privilege rows other
 * scopes hold on this app. Restricted caller access rows naming the app as
 * source or target are listed as read.
 *
 * Table names, field names and target_type values of sys_scope_privilege and
 * sys_restricted_caller_access are unverified until O-5 (PDI).
 */

export const CROSS_SCOPE_LIMITS = {
  /** Scripts scanned per script type. */
  scriptsPerType: 50,
  /** Callers kept per outbound call. */
  callersPerCall: 5,
  /** Rows read from each privilege / restricted-caller query. */
  rows: 500,
} as const;

export type CrossScopeStatus = "allowed" | "requested" | "denied" | "missing";

export interface CrossScopeCall {
  targetScope: string;
  targetType: "script_include" | "table";
  target: string;
  status: CrossScopeStatus;
  /** Operations of the matching privilege rows. */
  operations: string[];
  callers: { type: string; name: string }[];
  callerCount: number;
}

export interface CrossScopeInbound {
  sourceScope: string;
  targetType: string;
  target: string;
  operation: string;
  status: string;
}

export interface CrossScopeRestricted {
  sourceScope: string;
  targetScope: string;
  sourceTable: string;
  targetTable: string;
  target: string;
  status: string;
}

export interface CrossScopeReport {
  scope: string;
  scanned: number;
  outbound: CrossScopeCall[];
  inbound: CrossScopeInbound[];
  restricted: CrossScopeRestricted[];
  counts: Record<CrossScopeStatus, number>;
  caveats: string[];
}

/** A scope namespace: `global`, `x_<vendor>_<app>` or `sn_<app>`. */
const SCOPE = String.raw`global|x_[a-z0-9_]+|sn_[a-z0-9_]+`;
const QUALIFIED_NEW = new RegExp(
  String.raw`\bnew\s+(${SCOPE})\.([A-Za-z_$][\w$]*)\s*\(`,
  "g",
);
const QUALIFIED_STATIC = new RegExp(
  String.raw`(?<![\w$.])(${SCOPE})\.([A-Z][\w$]*)\.[A-Za-z_$][\w$]*\s*\(`,
  "g",
);
const QUALIFIED_AJAX = new RegExp(
  String.raw`\bnew\s+GlideAjax\s*\(\s*(["'])(${SCOPE})\.([A-Za-z_$][\w$]*)\1\s*\)`,
  "g",
);

/** Scope-qualified script include calls of one script (pure). */
export function qualifiedScriptCalls(
  text: string,
): { scope: string; name: string }[] {
  const seen = new Map<string, { scope: string; name: string }>();
  const add = (scope: string, name: string) =>
    seen.set(`${scope}.${name}`, { scope, name });
  for (const m of text.matchAll(QUALIFIED_NEW)) add(m[1]!, m[2]!);
  for (const m of text.matchAll(QUALIFIED_STATIC)) add(m[1]!, m[2]!);
  for (const m of text.matchAll(QUALIFIED_AJAX)) add(m[2]!, m[3]!);
  return [...seen.values()];
}

/** One privilege row as read (pure input of {@link joinPrivileges}). */
export interface PrivilegeRow {
  targetScope: string;
  targetType: string;
  target: string;
  operation: string;
  status: string;
}

const SCRIPT_TARGET_TYPES = new Set(["sys_script_include", "scriptable"]);

/** The status of a call from its matching privilege rows (pure). */
export function joinPrivileges(
  call: Pick<CrossScopeCall, "targetScope" | "targetType" | "target">,
  rows: readonly PrivilegeRow[],
): { status: CrossScopeStatus; operations: string[] } {
  const matching = rows.filter((r) => {
    if (r.targetScope && r.targetScope !== call.targetScope) return false;
    const name = r.target.includes(".") ? r.target.split(".").pop()! : r.target;
    if (name !== call.target) return false;
    return call.targetType === "table"
      ? r.targetType === "sys_db_object"
      : SCRIPT_TARGET_TYPES.has(r.targetType);
  });
  const statuses = new Set(matching.map((r) => r.status.toLowerCase()));
  const status: CrossScopeStatus = statuses.has("denied")
    ? "denied"
    : statuses.has("requested")
      ? "requested"
      : statuses.has("allowed")
        ? "allowed"
        : "missing";
  const operations = [
    ...new Set(matching.map((r) => r.operation).filter(Boolean)),
  ].sort();
  return { status, operations };
}

interface Caller {
  type: string;
  name: string;
}

/** Read the app's scripts and collect raw outbound references. */
async function scanScripts(
  scopeRef: string,
  caveats: string[],
): Promise<{
  scanned: number;
  scripts: Map<string, { scope: string; name: string; callers: Caller[] }>;
  tables: Map<string, Caller[]>;
}> {
  const L = CROSS_SCOPE_LIMITS;
  const scripts = new Map<
    string,
    { scope: string; name: string; callers: Caller[] }
  >();
  const tables = new Map<string, Caller[]>();
  let scanned = 0;
  for (const [type, descriptor] of Object.entries(SCRIPT_TYPES)) {
    throwIfCancelled();
    const artifact = scriptArtifact(type);
    const fields = descriptor.scriptFields.filter(
      (f) => !artifact.markupFields?.includes(f),
    );
    if (!fields.length) continue;
    let records: Record<string, unknown>[];
    try {
      const res = await queryTable({
        table: descriptor.table,
        query: [
          ...(artifact.baseQuery ? [artifact.baseQuery] : []),
          scopeClause(artifact.scopeField, scopeRef),
          "ORDERBYDESCsys_updated_on",
        ].join("^"),
        fields: ["sys_id", descriptor.nameField, ...fields],
        displayValue: "false",
        limit: L.scriptsPerType + 1,
      });
      records = res.records;
    } catch (e) {
      rethrowIfCancelled(e);
      caveats.push(
        `Cross-scope: ${type} (${descriptor.table}) could not be read: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    if (records.length > L.scriptsPerType) {
      caveats.push(
        `Cross-scope: the ${L.scriptsPerType} most recently updated ${type} scripts are scanned.`,
      );
      records = records.slice(0, L.scriptsPerType);
    }
    for (const record of records) {
      scanned++;
      const caller = {
        type,
        name: snString(record[descriptor.nameField]) || snString(record.sys_id),
      };
      for (const field of fields) {
        const src = snString(record[field]);
        if (!src) continue;
        for (const c of qualifiedScriptCalls(src)) {
          const key = `${c.scope}.${c.name}`;
          const entry = scripts.get(key) ?? { ...c, callers: [] };
          addCaller(entry.callers, caller);
          scripts.set(key, entry);
        }
        for (const t of scriptTables(src)) {
          const list = tables.get(t) ?? [];
          addCaller(list, caller);
          tables.set(t, list);
        }
      }
    }
  }
  return { scanned, scripts, tables };
}

function addCaller(list: Caller[], c: Caller): void {
  if (!list.some((x) => x.type === c.type && x.name === c.name)) list.push(c);
}

/** Scope namespace of each table (sys_db_object), or undefined when unreadable. */
async function tableScopes(
  names: string[],
  caveats: string[],
): Promise<Map<string, string> | undefined> {
  if (!names.length) return new Map();
  try {
    const { records } = await queryTable({
      table: "sys_db_object",
      query: `nameIN${names.join(",")}`,
      fields: ["name", "sys_scope.scope"],
      displayValue: "false",
      limit: names.length * 2,
    });
    return new Map(
      records.map((r) => [snString(r.name), snString(r["sys_scope.scope"])]),
    );
  } catch (e) {
    rethrowIfCancelled(e);
    caveats.push(
      `Cross-scope: table scopes could not be read (sys_db_object): ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
}

async function readRows(
  table: string,
  query: string,
  fields: string[],
  caveats: string[],
): Promise<Record<string, unknown>[] | undefined> {
  try {
    const { records } = await queryTable({
      table,
      query,
      fields,
      displayValue: "false",
      limit: CROSS_SCOPE_LIMITS.rows,
    });
    if (records.length >= CROSS_SCOPE_LIMITS.rows) {
      caveats.push(
        `Cross-scope: ${table} stopped at ${CROSS_SCOPE_LIMITS.rows} rows.`,
      );
    }
    return records;
  } catch (e) {
    rethrowIfCancelled(e);
    caveats.push(
      `Cross-scope: ${table} could not be read: ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
}

/**
 * Build the report for the app `appSysId` with namespace `scope`. Never
 * throws except on a cancel: an unreadable source becomes a caveat.
 */
export async function crossScopeReport(
  appSysId: string,
  scope: string,
): Promise<CrossScopeReport> {
  const caveats: string[] = [];
  const { scanned, scripts, tables } = await scanScripts(appSysId, caveats);

  const tableScope = await tableScopes([...tables.keys()], caveats);
  const calls: Omit<CrossScopeCall, "status" | "operations">[] = [];
  for (const s of scripts.values()) {
    if (s.scope === scope) continue;
    calls.push({
      targetScope: s.scope,
      targetType: "script_include",
      target: s.name,
      callers: s.callers.slice(0, CROSS_SCOPE_LIMITS.callersPerCall),
      callerCount: s.callers.length,
    });
  }
  let unresolved = 0;
  for (const [name, callers] of tables) {
    const owner = tableScope?.get(name);
    if (!owner) {
      unresolved++;
      continue;
    }
    if (owner === scope) continue;
    calls.push({
      targetScope: owner,
      targetType: "table",
      target: name,
      callers: callers.slice(0, CROSS_SCOPE_LIMITS.callersPerCall),
      callerCount: callers.length,
    });
  }
  if (unresolved) {
    caveats.push(
      `Cross-scope: ${unresolved} table(s) opened by the scripts have no readable sys_db_object row and are left out.`,
    );
  }

  const outRows = await readRows(
    "sys_scope_privilege",
    `source_scope=${appSysId}`,
    ["target_name", "target_scope.scope", "target_type", "operation", "status"],
    caveats,
  );
  const privileges: PrivilegeRow[] = (outRows ?? []).map((r) => ({
    targetScope: snString(r["target_scope.scope"]),
    targetType: snString(r.target_type),
    target: snString(r.target_name),
    operation: snString(r.operation),
    status: snString(r.status),
  }));

  const counts: Record<CrossScopeStatus, number> = {
    allowed: 0,
    requested: 0,
    denied: 0,
    missing: 0,
  };
  const outbound: CrossScopeCall[] = calls
    .map((c) => {
      const j = outRows
        ? joinPrivileges(c, privileges)
        : { status: "missing" as const, operations: [] };
      counts[j.status]++;
      return { ...c, ...j };
    })
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        a.targetScope.localeCompare(b.targetScope) ||
        a.target.localeCompare(b.target),
    );
  if (!outRows && outbound.length) {
    caveats.push(
      "Cross-scope: without sys_scope_privilege every outbound call shows as missing.",
    );
  }

  const inRows = await readRows(
    "sys_scope_privilege",
    `target_scope=${appSysId}^source_scope!=${appSysId}`,
    ["source_scope.scope", "target_name", "target_type", "operation", "status"],
    caveats,
  );
  const inbound: CrossScopeInbound[] = (inRows ?? [])
    .map((r) => ({
      sourceScope: snString(r["source_scope.scope"]),
      targetType: snString(r.target_type),
      target: snString(r.target_name),
      operation: snString(r.operation),
      status: snString(r.status),
    }))
    .sort(
      (a, b) =>
        a.sourceScope.localeCompare(b.sourceScope) ||
        a.target.localeCompare(b.target),
    );

  const rcaRows = await readRows(
    "sys_restricted_caller_access",
    `source_scope=${appSysId}^NQtarget_scope=${appSysId}`,
    [
      "source_scope.scope",
      "target_scope.scope",
      "source_table",
      "target_table",
      "target",
      "status",
    ],
    caveats,
  );
  const restricted: CrossScopeRestricted[] = (rcaRows ?? []).map((r) => ({
    sourceScope: snString(r["source_scope.scope"]),
    targetScope: snString(r["target_scope.scope"]),
    sourceTable: snString(r.source_table),
    targetTable: snString(r.target_table),
    target: snString(r.target),
    status: snString(r.status),
  }));

  caveats.push(
    "Cross-scope calls are found statically: only scope-qualified script include names and tables opened by literal name are seen. Whether a missing privilege blocks a call depends on the target's runtime access settings. Table and field names are unverified until O-5 (PDI).",
  );
  return { scope, scanned, outbound, inbound, restricted, counts, caveats };
}

const STATUS_ORDER: Record<CrossScopeStatus, number> = {
  denied: 0,
  missing: 1,
  requested: 2,
  allowed: 3,
};
