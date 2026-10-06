import { queryTable, type QueryResult, type SnRecord } from "./table.js";
import { snString } from "./shared.js";
import type { HardeningReport } from "./hardening.js";
import { ServiceNowError } from "../core/errors.js";
import type { Severity } from "./codecheck.js";
import { scriptCalls, type CallFact } from "./script-ast.js";
import {
  BROKER_KIND_BY_TABLE,
  UIB_BROKER_RULES,
  brokerMutates,
} from "./uib-broker-lint.js";

/**
 * DF-1 / S-3 — security scan over the access-control layer, part of the
 * `codecheck` package (folded into `servicenow_check_code_health`).
 *
 * The ACL read pages through every active `sys_security_acl` row (fetchAll,
 * bounded by SN_MAX_RECORDS and a hard ceiling) and says so when it stops
 * early. Roles are joined from `sys_security_acl_role` and resolved through
 * `sys_user_role_contains`. Every further check reads its own table and
 * degrades on its own to `available:false` with the reason — an unreadable
 * table never fails the scan, and never reads as a silent "all clear".
 */

/** What a finding points at (absent on the original ACL-script findings = `acl`). */
export type SecurityFindingKind =
  | "acl"
  | "rest_resource"
  | "ui_page"
  | "table"
  | "role"
  | "ux_data_broker";

export interface SecurityFinding {
  sys_id: string;
  name: string;
  operation: string;
  rule: string;
  severity: Severity;
  hint: string;
  kind?: SecurityFindingKind;
  /** Table an ACL or a table finding is about (`*` for a wildcard ACL). */
  table?: string;
  /** Roles the ACL requires (from sys_security_acl_role). */
  roles?: string[];
  /** Roles that inherit a required role through sys_user_role_contains. */
  grantedBy?: string[];
}

/** One secondary check of the scan and whether it could run. */
export interface SecurityCheck {
  available: boolean;
  unavailableReason?: string;
  /** Rows the check read from its primary table. */
  scanned: number;
  findings: number;
  /** The check's read stopped early; its result may be incomplete. */
  truncated?: boolean;
  note?: string;
}

export type SecurityCheckName =
  | "acl_roles"
  | "role_inheritance"
  | "public_rest_resources"
  | "public_ui_pages"
  | "tables_without_acl"
  | "admin_overlap_roles"
  | "elevated_privilege_acls"
  | "ux_data_brokers";

export interface SecurityScan {
  /** False when sys_security_acl is unreadable for the connected user (DF-0). */
  available: boolean;
  unavailableReason?: string;
  aclCount: number;
  findings: SecurityFinding[];
  bySeverity: Record<Severity, number>;
  /** True when the ACL read stopped before the last active ACL (S-3). */
  truncated?: boolean;
  /** `cap` = SN_MAX_RECORDS, `scan_limit` = fetchAll scan budget, `ceiling` = the scan's own limit. */
  truncatedReason?: "cap" | "scan_limit" | "ceiling";
  /** ACL rows the instance counted but withheld from this user. */
  filtered?: number;
  /** Per-check availability and counts (S-3). */
  checks?: Record<SecurityCheckName, SecurityCheck>;
  /** N-13: hardening compliance, added by the security document (not by the scan). */
  hardening?: HardeningReport;
}

/** Hard ceiling on rows one security-scan read keeps, whatever SN_MAX_RECORDS says. */
export const SECURITY_SCAN_MAX_ROWS = 50_000;

/** Role names that open an ACL to everyone (the `*` wildcard and `public`). */
const EVERYONE_ROLES = new Set(["*", "public"]);

/** Fallback when sys_user_role.elevated_privilege cannot be read. */
const DEFAULT_ELEVATED_ROLES = ["security_admin"];

const ACL_WRITE_METHODS = new Set([
  "update",
  "insertWithReferences",
  "deleteRecord",
]);

/** Rules over an ACL's evaluation script — where a weak check becomes a hole. */
const ACL_SCRIPT_RULES: {
  id: string;
  severity: Severity;
  /** Fallback when the script does not parse. */
  re: RegExp;
  /** S-12: the AST match over the script's calls. */
  call: (c: CallFact) => boolean;
  hint: string;
}[] = [
  {
    id: "eval-in-acl",
    severity: "error",
    re: /\beval\s*\(/,
    call: (c) => c.kind === "call" && c.name === "eval",
    hint: "eval() in an ACL evaluation script is a security risk — an attacker-influenced value could flip the access decision.",
  },
  {
    id: "gr-write-in-acl",
    severity: "warn",
    re: /\.(update|insertWithReferences|deleteRecord)\s*\(/,
    call: (c) =>
      c.kind === "call" &&
      c.objectText !== undefined &&
      ACL_WRITE_METHODS.has(c.name ?? ""),
    hint: "An ACL script that writes records has side effects during an access check — ACLs must be read-only decisions.",
  },
  {
    id: "getuser-in-acl",
    severity: "info",
    re: /gs\.getUser(ID|Name)?\s*\(/,
    call: (c) =>
      c.kind === "call" &&
      c.object === "gs" &&
      /^getUser(ID|Name)?$/.test(c.name ?? ""),
    hint: "gs.getUser* inside an ACL script — verify the identity logic genuinely belongs in the access check.",
  },
];

/** One ACL-script rule hit. */
export interface AclScriptHint {
  rule: string;
  severity: Severity;
  hint: string;
}

/**
 * The ACL-script rules that match a script. S-12: calls are matched in the
 * parsed script, so a commented-out eval() or a string naming gs.getUser() is
 * not a hit; the regex fallback runs when the script does not parse.
 */
export function aclScriptHints(script: string): AclScriptHint[] {
  if (!script.trim()) return [];
  const calls = scriptCalls(script);
  return ACL_SCRIPT_RULES.filter((rule) =>
    calls ? calls.some(rule.call) : rule.re.test(script),
  ).map(({ id, severity, hint }) => ({ rule: id, severity, hint }));
}

/** Operations that change data — an open ACL on these is worse than on `read`. */
const WRITE_OPERATIONS = new Set(["write", "create", "delete"]);

type Read =
  | { ok: true; res: QueryResult; truncated: boolean }
  | { ok: false; reason: string };

/**
 * Read a whole table for the scan and never throw: an HTTP 401/403/404 or a
 * policy denial (SN_TABLES_ALLOW/DENY, also a 403) and any other failure
 * become a reason string the caller turns into `available:false`.
 */
async function readAll(
  table: string,
  query: string,
  fields: string[],
  ceiling: number,
): Promise<Read> {
  try {
    const res = await queryTable({ table, query, fields, fetchAll: true });
    return { ok: true, ...clip(res, ceiling) };
  } catch (error) {
    return { ok: false, reason: unreadableReason(table, error) };
  }
}

/** Apply the scan's own ceiling on top of fetchAll's SN_MAX_RECORDS cap. */
function clip(
  res: QueryResult,
  ceiling: number,
): { res: QueryResult; truncated: boolean } {
  if (res.records.length > ceiling) {
    return {
      res: {
        ...res,
        records: res.records.slice(0, ceiling),
        truncated: true,
        truncatedReason: undefined,
      },
      truncated: true,
    };
  }
  return { res, truncated: res.truncated === true };
}

/** Why a read of `table` failed, phrased for an `available:false` entry (also used by api/ops.ts). */
export function unreadableReason(table: string, error: unknown): string {
  if (error instanceof ServiceNowError) {
    if (error.status === 401 || error.status === 403) {
      return `${table} is not readable for this user (HTTP ${error.status}): ${error.message}`;
    }
    if (error.status === 404) {
      return `${table} does not exist on this instance or is not exposed (HTTP 404).`;
    }
  }
  return `${table} could not be read: ${error instanceof Error ? error.message : String(error)}`;
}

/** Same rule as the UIB domain (uib-broker-lint.ts), so both name it alike. */
const MUTATES_NO_ACL_HINT =
  UIB_BROKER_RULES.find((r) => r.id === "uib-broker-mutates-no-acl")?.hint ??
  "";

function unavailable(reason: string): SecurityCheck {
  return {
    available: false,
    unavailableReason: reason,
    scanned: 0,
    findings: 0,
  };
}

interface Acl {
  sys_id: string;
  name: string;
  operation: string;
  script: string;
  condition: string;
  /** Table part of the name (`*` for a wildcard ACL). */
  table: string;
  /** True for a record ACL (the only type that guards a table). */
  record: boolean;
  /** ACL type name (`record`, `ux_data_broker`, …); empty when unknown. */
  type: string;
}

function toAcl(r: SnRecord): Acl {
  const name = snString(r.name);
  const typeName = snString(r["type.name"]) || snString(r.type);
  // A bare sys_id (reference without its dot-walk) says nothing — assume record.
  const record =
    !typeName || typeName === "record" || /^[0-9a-f]{32}$/.test(typeName);
  return {
    sys_id: snString(r.sys_id),
    name,
    operation: snString(r.operation),
    script: snString(r.script),
    condition: snString(r.condition),
    table: name.split(".")[0]?.trim().toLowerCase() ?? "",
    record,
    type: /^[0-9a-f]{32}$/.test(typeName) ? "" : typeName,
  };
}

/** Role inheritance graph from sys_user_role_contains (role → contained roles). */
class RoleGraph {
  private readonly contains = new Map<string, Set<string>>();
  private readonly containedBy = new Map<string, Set<string>>();

  add(role: string, contained: string): void {
    if (!role || !contained || role === contained) return;
    link(this.contains, role, contained);
    link(this.containedBy, contained, role);
  }

  /** Every role `role` grants, transitively (excluding itself). */
  descendants(role: string): Set<string> {
    return walk(this.contains, role);
  }

  /** Every role that grants `role`, transitively (excluding itself). */
  holders(role: string): Set<string> {
    return walk(this.containedBy, role);
  }

  roles(): string[] {
    return [...this.contains.keys()];
  }
}

function link(map: Map<string, Set<string>>, from: string, to: string): void {
  let set = map.get(from);
  if (!set) map.set(from, (set = new Set()));
  set.add(to);
}

function walk(map: Map<string, Set<string>>, start: string): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const next = map.get(queue.shift()!);
    if (!next) continue;
    for (const r of next) {
      if (r === start || seen.has(r)) continue;
      seen.add(r);
      queue.push(r);
    }
  }
  return seen;
}

/**
 * DF-1 + S-3 — scan the active ACLs and the surrounding access surface.
 * `limit` is the hard ceiling on rows kept per read (default
 * SECURITY_SCAN_MAX_ROWS; SN_MAX_RECORDS applies first); a read that stops
 * early is reported as `truncated`, never presented as the whole picture.
 */
export async function securityScan(
  limit = SECURITY_SCAN_MAX_ROWS,
): Promise<SecurityScan> {
  const ceiling = Math.max(1, Math.floor(limit));
  const findings: SecurityFinding[] = [];
  const bySeverity: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
  const add = (f: SecurityFinding): void => {
    findings.push(f);
    bySeverity[f.severity]++;
  };

  // --- Primary read: every active ACL -------------------------------------
  let acls: Acl[] = [];
  let aclRead: Extract<Read, { ok: true }> | undefined;
  let aclUnavailable: string | undefined;
  try {
    const res = await queryTable({
      table: "sys_security_acl",
      query: "active=true^ORDERBYname",
      fields: [
        "sys_id",
        "name",
        "operation",
        "script",
        "condition",
        "type",
        "type.name",
      ],
      fetchAll: true,
    });
    aclRead = { ok: true, ...clip(res, ceiling) };
    acls = aclRead.res.records.map(toAcl);
  } catch (error) {
    if (
      error instanceof ServiceNowError &&
      [401, 403, 404].includes(error.status ?? 0)
    ) {
      aclUnavailable =
        "sys_security_acl is not readable for this user (needs the security_admin or admin role). Run servicenow_check_capabilities.";
    } else {
      throw error;
    }
  }
  const aclTruncated = aclRead?.truncated === true;

  // --- ACL → role join and role inheritance --------------------------------
  const aclRoles = new Map<string, string[]>();
  let rolesCheck: SecurityCheck;
  if (aclUnavailable) {
    rolesCheck = unavailable("Needs sys_security_acl, which is unreadable.");
  } else {
    const read = await readAll(
      "sys_security_acl_role",
      "sys_security_acl.active=true",
      ["sys_security_acl", "sys_user_role.name"],
      ceiling,
    );
    if (read.ok) {
      for (const r of read.res.records) {
        const acl = snString(r.sys_security_acl);
        const role = snString(r["sys_user_role.name"]);
        if (!acl || !role) continue;
        const list = aclRoles.get(acl) ?? [];
        if (!list.includes(role)) list.push(role);
        aclRoles.set(acl, list);
      }
      rolesCheck = {
        available: true,
        scanned: read.res.records.length,
        findings: 0,
        ...(read.truncated ? { truncated: true } : {}),
      };
    } else {
      rolesCheck = unavailable(read.reason);
    }
  }

  const graph = new RoleGraph();
  const inheritRead = await readAll(
    "sys_user_role_contains",
    "",
    ["role.name", "contains.name"],
    ceiling,
  );
  let inheritCheck: SecurityCheck;
  if (inheritRead.ok) {
    for (const r of inheritRead.res.records) {
      graph.add(snString(r["role.name"]), snString(r["contains.name"]));
    }
    inheritCheck = {
      available: true,
      scanned: inheritRead.res.records.length,
      findings: 0,
      ...(inheritRead.truncated ? { truncated: true } : {}),
    };
  } else {
    inheritCheck = unavailable(inheritRead.reason);
  }

  // Elevated roles: flagged on sys_user_role; security_admin when unreadable.
  const elevatedRead = await readAll(
    "sys_user_role",
    "elevated_privilege=true",
    ["name"],
    ceiling,
  );
  const elevatedRoles = new Set(
    elevatedRead.ok
      ? elevatedRead.res.records.map((r) => snString(r.name)).filter(Boolean)
      : DEFAULT_ELEVATED_ROLES,
  );
  const elevatedNote = elevatedRead.ok
    ? undefined
    : `Elevated roles assumed to be ${DEFAULT_ELEVATED_ROLES.join(", ")} — ${elevatedRead.reason}`;

  // --- Per-ACL rules --------------------------------------------------------
  let elevatedCount = 0;
  for (const acl of acls) {
    const base = {
      sys_id: acl.sys_id,
      name: acl.name,
      operation: acl.operation,
    };
    for (const hit of aclScriptHints(acl.script)) add({ ...base, ...hit });

    const roles = rolesCheck.available ? (aclRoles.get(acl.sys_id) ?? []) : [];
    const open = !acl.script.trim() && !acl.condition.trim();

    // An active ACL with neither a condition nor a script grants on its roles
    // alone — and an ACL with an empty role list is open to everyone.
    if (open) {
      add({
        ...base,
        rule: "acl-roles-only",
        severity: "info",
        hint: "Active ACL with no condition and no script — access depends entirely on its assigned roles; confirm a role is set (an empty role list grants everyone).",
        ...(rolesCheck.available ? { roles } : {}),
      });
    }
    if (!rolesCheck.available) continue;

    const writes = WRITE_OPERATIONS.has(acl.operation);
    if (open && roles.length === 0) {
      add({
        ...base,
        kind: "acl",
        table: acl.table,
        roles,
        rule: "acl-open",
        severity: writes ? "warn" : "info",
        hint: "Active ACL with no role, no condition and no script — it grants this operation to every authenticated user.",
      });
    }
    const everyone = roles.filter((r) => EVERYONE_ROLES.has(r));
    if (everyone.length > 0) {
      add({
        ...base,
        kind: "acl",
        table: acl.table,
        roles,
        rule: "acl-public-role",
        severity: writes ? "warn" : "info",
        hint: `ACL grants the '${everyone.join("', '")}' role — anyone, including unauthenticated users, satisfies the role check; confirm the condition/script narrows it.`,
      });
    }

    // Elevated-privilege ACLs: gated on a role that needs explicit elevation.
    const elevated = roles.filter((r) => elevatedRoles.has(r));
    if (elevated.length > 0) {
      elevatedCount++;
      const grantedBy = inheritCheck.available
        ? [...new Set(elevated.flatMap((r) => [...graph.holders(r)]))].sort()
        : undefined;
      add({
        ...base,
        kind: "acl",
        table: acl.table,
        roles,
        ...(grantedBy ? { grantedBy } : {}),
        rule: "acl-elevated-privilege",
        severity: grantedBy && grantedBy.length > 0 ? "warn" : "info",
        hint:
          grantedBy && grantedBy.length > 0
            ? `ACL requires the elevated role '${elevated.join("', '")}', which is also inherited by: ${grantedBy.join(", ")} — confirm those roles are meant to reach it.`
            : `ACL requires the elevated role '${elevated.join("', '")}' — only users who elevate their session pass it; confirm the operation needs it.`,
      });
    }
  }

  const elevatedCheck: SecurityCheck = !rolesCheck.available
    ? unavailable(rolesCheck.unavailableReason ?? "ACL roles are not readable.")
    : {
        available: true,
        scanned: acls.length,
        findings: elevatedCount,
        ...(aclTruncated || rolesCheck.truncated ? { truncated: true } : {}),
        ...(elevatedNote ? { note: elevatedNote } : {}),
      };

  // --- Admin-overlap roles --------------------------------------------------
  let overlapCheck: SecurityCheck;
  if (inheritCheck.available) {
    let count = 0;
    for (const role of graph.roles().sort()) {
      if (role === "admin") continue;
      const granted = graph.descendants(role);
      const hitsAdmin = granted.has("admin");
      const hitsElevated = [...granted]
        .filter((r) => elevatedRoles.has(r) && !elevatedRoles.has(role))
        .sort();
      if (!hitsAdmin && hitsElevated.length === 0) continue;
      count++;
      add({
        sys_id: "",
        name: role,
        operation: "",
        kind: "role",
        rule: "admin-overlap-role",
        severity: hitsAdmin ? "error" : "warn",
        grantedBy: hitsAdmin ? ["admin", ...hitsElevated] : hitsElevated,
        hint: hitsAdmin
          ? `Role '${role}' contains admin (directly or through inheritance) — every holder is a full administrator; grant admin explicitly instead.`
          : `Role '${role}' contains the elevated role(s) ${hitsElevated.join(", ")} — its holders reach privileges normally gated behind elevation.`,
      });
    }
    overlapCheck = {
      available: true,
      scanned: inheritCheck.scanned,
      findings: count,
      ...(inheritCheck.truncated ? { truncated: true } : {}),
      ...(elevatedNote ? { note: elevatedNote } : {}),
    };
  } else {
    overlapCheck = unavailable(
      inheritCheck.unavailableReason ??
        "sys_user_role_contains is not readable.",
    );
  }

  // --- Public Scripted REST resources ---------------------------------------
  let restCheck: SecurityCheck;
  const restRead = await readAll(
    "sys_ws_operation",
    "active=true^requires_authentication=false^ORDERBYname",
    [
      "sys_id",
      "name",
      "http_method",
      "operation_uri",
      "web_service_definition.name",
    ],
    ceiling,
  );
  if (restRead.ok) {
    for (const r of restRead.res.records) {
      const method = snString(r.http_method).toUpperCase();
      const api = snString(r["web_service_definition.name"]);
      const name = snString(r.operation_uri) || snString(r.name);
      add({
        sys_id: snString(r.sys_id),
        name: api ? `${api}: ${name}` : name,
        operation: method,
        kind: "rest_resource",
        rule: "public-rest-resource",
        severity: method && method !== "GET" ? "error" : "warn",
        hint: "Scripted REST resource with requires_authentication=false — callable without logging in; confirm it is meant to be public and validates its input.",
      });
    }
    restCheck = {
      available: true,
      scanned: restRead.res.records.length,
      findings: restRead.res.records.length,
      ...(restRead.truncated ? { truncated: true } : {}),
    };
  } else {
    restCheck = unavailable(restRead.reason);
  }

  // --- Public pages (sys_public), classified against sys_ui_page -----------
  let pageCheck: SecurityCheck;
  const publicRead = await readAll(
    "sys_public",
    "active=true^ORDERBYpage",
    ["sys_id", "page"],
    ceiling,
  );
  if (publicRead.ok) {
    const pages = publicRead.res.records
      .map((r) => ({ sys_id: snString(r.sys_id), page: snString(r.page) }))
      .filter((p) => p.page);
    const candidates = [
      ...new Set(pages.map((p) => p.page.replace(/\.do$/i, ""))),
    ].filter((n) => n && !/[,^=]/.test(n));
    const uiPages = new Set<string>();
    let note: string | undefined;
    if (candidates.length > 0) {
      const uiRead = await readAll(
        "sys_ui_page",
        `nameIN${candidates.join(",")}`,
        ["name"],
        ceiling,
      );
      if (uiRead.ok) {
        for (const r of uiRead.res.records) uiPages.add(snString(r.name));
      } else {
        note = `Pages not classified as UI pages — ${uiRead.reason}`;
      }
    }
    for (const p of pages) {
      const isUiPage = uiPages.has(p.page.replace(/\.do$/i, ""));
      add({
        sys_id: p.sys_id,
        name: p.page,
        operation: "",
        kind: "ui_page",
        rule: isUiPage ? "public-ui-page" : "public-page",
        severity: isUiPage ? "warn" : "info",
        hint: isUiPage
          ? "UI page listed in sys_public — rendered without login; confirm it exposes no data and its processing script checks the caller."
          : "Page listed in sys_public — reachable without login; confirm it is meant to be public.",
      });
    }
    pageCheck = {
      available: true,
      scanned: publicRead.res.records.length,
      findings: pages.length,
      ...(publicRead.truncated ? { truncated: true } : {}),
      ...(note ? { note } : {}),
    };
  } else {
    pageCheck = unavailable(publicRead.reason);
  }

  // --- Custom tables with no ACL of their own or on an ancestor ------------
  let tableCheck: SecurityCheck;
  if (aclUnavailable) {
    tableCheck = unavailable("Needs sys_security_acl, which is unreadable.");
  } else if (aclTruncated) {
    tableCheck = unavailable(
      "The ACL read was partial (truncated), so a missing ACL cannot be proven — raise SN_MAX_RECORDS.",
    );
  } else {
    const tableRead = await readAll(
      "sys_db_object",
      "nameSTARTSWITHu_^ORnameSTARTSWITHx_^ORDERBYname",
      ["sys_id", "name", "super_class.name"],
      ceiling,
    );
    if (tableRead.ok) {
      const covered = new Set(
        acls.filter((a) => a.record && a.table).map((a) => a.table),
      );
      const wildcard = covered.has("*");
      const parents = new Map<string, string>();
      for (const r of tableRead.res.records) {
        const name = snString(r.name).toLowerCase();
        if (name)
          parents.set(name, snString(r["super_class.name"]).toLowerCase());
      }
      let count = 0;
      for (const r of tableRead.res.records) {
        const name = snString(r.name).toLowerCase();
        if (!name || isCovered(name, parents, covered)) continue;
        count++;
        add({
          sys_id: snString(r.sys_id),
          name,
          operation: "",
          kind: "table",
          table: name,
          rule: "table-no-acl",
          severity: "warn",
          hint: wildcard
            ? "Custom table with no record ACL of its own or on a parent table — only the '*' wildcard ACLs guard it; add table ACLs."
            : "Custom table with no record ACL of its own or on a parent table — add table ACLs.",
        });
      }
      tableCheck = {
        available: true,
        scanned: tableRead.res.records.length,
        findings: count,
        ...(tableRead.truncated ? { truncated: true } : {}),
      };
    } else {
      tableCheck = unavailable(tableRead.reason);
    }
  }

  // --- N-29 (UX-12): UI Builder data brokers and their ux_data_broker ACLs --
  // A broker ACL's name is the broker's sys_id. Table and field names
  // (mutates_server_data, the REST / GraphQL broker tables) are unverified
  // until O-5.
  let brokerCheck: SecurityCheck;
  if (aclUnavailable) {
    brokerCheck = unavailable("Needs sys_security_acl, which is unreadable.");
  } else if (!rolesCheck.available) {
    brokerCheck = unavailable(
      rolesCheck.unavailableReason ?? "ACL roles are not readable.",
    );
  } else {
    const brokerAcls = new Map<string, Acl[]>();
    for (const acl of acls) {
      if (acl.type !== "ux_data_broker") continue;
      const key = acl.name.trim();
      brokerAcls.set(key, [...(brokerAcls.get(key) ?? []), acl]);
    }
    let scanned = 0;
    let count = 0;
    let truncated = aclTruncated || rolesCheck.truncated === true;
    const unread: string[] = [];
    const known = new Set<string>();
    for (const table of Object.keys(BROKER_KIND_BY_TABLE)) {
      const read = await readAll(
        table,
        "ORDERBYname",
        ["sys_id", "name", "mutates_server_data"],
        ceiling,
      );
      if (!read.ok) {
        unread.push(read.reason);
        continue;
      }
      if (read.truncated) truncated = true;
      for (const r of read.res.records) {
        scanned++;
        const id = snString(r.sys_id);
        known.add(id);
        const name = snString(r.name) || id;
        const mutates = brokerMutates(r.mutates_server_data) === true;
        const guards = brokerAcls.get(id) ?? [];
        if (mutates && guards.length === 0 && !aclTruncated) {
          count++;
          add({
            sys_id: id,
            name,
            operation: "execute",
            kind: "ux_data_broker",
            rule: "uib-broker-mutates-no-acl",
            severity: "error",
            hint: MUTATES_NO_ACL_HINT,
          });
        }
        for (const acl of guards) {
          const roles = aclRoles.get(acl.sys_id) ?? [];
          const open = !acl.script.trim() && !acl.condition.trim();
          const everyone = roles.filter((role) => EVERYONE_ROLES.has(role));
          if (!(open && roles.length === 0) && everyone.length === 0) continue;
          count++;
          add({
            sys_id: acl.sys_id,
            name,
            operation: acl.operation,
            kind: "ux_data_broker",
            roles,
            rule: "ux-broker-acl-open",
            severity: mutates ? "error" : "warn",
            hint:
              everyone.length > 0
                ? `The broker's ux_data_broker ACL grants the '${everyone.join("', '")}' role — anyone satisfies it; restrict it to the roles that may run the broker.`
                : "The broker's ux_data_broker ACL has no role, no condition and no script — it lets every authenticated user run the broker.",
          });
        }
      }
    }
    if (unread.length === Object.keys(BROKER_KIND_BY_TABLE).length) {
      brokerCheck = unavailable(unread.join(" "));
    } else {
      const orphans = [...brokerAcls.keys()].filter((k) => !known.has(k));
      const notes = [
        ...(unread.length
          ? [`Broker tables not read: ${unread.join(" ")}`]
          : []),
        ...(orphans.length
          ? [
              `${orphans.length} ux_data_broker ACL(s) name no broker that was read.`,
            ]
          : []),
        ...(aclTruncated
          ? [
              "The ACL read was partial, so a broker without an ACL cannot be proven.",
            ]
          : []),
      ];
      brokerCheck = {
        available: true,
        scanned,
        findings: count,
        ...(truncated ? { truncated: true } : {}),
        ...(notes.length ? { note: notes.join(" ") } : {}),
      };
    }
  }

  const checks: Record<SecurityCheckName, SecurityCheck> = {
    acl_roles: rolesCheck,
    role_inheritance: inheritCheck,
    public_rest_resources: restCheck,
    public_ui_pages: pageCheck,
    tables_without_acl: tableCheck,
    admin_overlap_roles: overlapCheck,
    elevated_privilege_acls: elevatedCheck,
    ux_data_brokers: brokerCheck,
  };

  if (aclUnavailable) {
    return {
      available: false,
      unavailableReason: aclUnavailable,
      aclCount: 0,
      findings,
      bySeverity,
      checks,
    };
  }
  const res = aclRead!.res;
  return {
    available: true,
    aclCount: acls.length,
    findings,
    bySeverity,
    ...(aclTruncated
      ? { truncated: true, truncatedReason: res.truncatedReason ?? "ceiling" }
      : {}),
    ...(res.filtered ? { filtered: res.filtered } : {}),
    checks,
  };
}

/** A table is covered by an ACL on itself or on any ancestor we can see. */
function isCovered(
  table: string,
  parents: Map<string, string>,
  covered: Set<string>,
): boolean {
  const seen = new Set<string>();
  let current: string | undefined = table;
  while (current && !seen.has(current)) {
    if (covered.has(current)) return true;
    seen.add(current);
    current = parents.get(current);
  }
  return false;
}
