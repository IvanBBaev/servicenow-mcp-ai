import { ServiceNowError } from "../core/errors.js";
import { unreadableReason } from "./security.js";
import { snString } from "./shared.js";
import { queryTable } from "./table.js";

/**
 * N-22 (NX-31, NX-33) — access review: who holds a privileged role and how.
 *
 * Privileged roles are `admin`, `security_admin`, every role flagged
 * `elevated_privilege`, and every role that contains one of those
 * (transitively, through sys_user_role_contains). For each holder the
 * review lists the grant path (direct, a group, or a contained role), the
 * account's `active` flag and `last_login_time` with a dormant flag, and the
 * row's creator and date as "who granted it and when". Revokes come from
 * sys_audit_delete rows of sys_user_has_role, when that table is readable.
 *
 * Not wired to a tool yet: it reads account data (sys_user_has_role and the
 * dot-walked sys_user fields), so it cannot join the metadata-only security
 * document. It ships as the `document_instance` kind `access_review` once
 * O-10 clears the tools/list change.
 *
 * Read-only and bounded; never throws except on a cancel. Each read that
 * fails degrades to `available:false` (roles, holders) or
 * `revokes.available:false` (audit). Table and field names
 * (sys_user_has_role.granted_by / included_in_role, sys_audit_delete
 * tablename / documentkey) are unverified until O-5 (PDI).
 */

/** Roles that are privileged whatever their elevated_privilege flag says. */
export const BASE_PRIVILEGED_ROLES = ["admin", "security_admin"] as const;
/** An active account without a login for this many days is dormant. */
export const DORMANT_DAYS = 90;
/** Holder rows read per review. */
export const ACCESS_REVIEW_LIMIT = 2_000;
/** Revoke rows read per review (newest first). */
export const REVOKE_LIMIT = 200;
/** Revokes looked back on. */
export const REVOKE_DAYS = 90;

export type GrantPath = "direct" | "group" | "contained_role";

export interface PrivilegedGrant {
  role: string;
  path: GrantPath;
  /** The group (path `group`) or containing role (path `contained_role`). */
  via?: string;
  grantedBy?: string;
  grantedOn?: string;
}

export interface PrivilegedAccount {
  sys_id: string;
  userName: string;
  name?: string;
  active: boolean;
  lastLogin?: string;
  /** Active and no login within the dormant threshold (or never). */
  dormant: boolean;
  grants: PrivilegedGrant[];
}

export interface RoleRevoke {
  /** The deleted sys_user_has_role row. */
  sys_id: string;
  revokedBy: string;
  revokedOn: string;
}

export interface AccessReview {
  available: boolean;
  unavailableReason?: string;
  /** Privileged role names, sorted. */
  roles: string[];
  /** Roles privileged only because they contain one (name → contained privileged roles). */
  containers: Record<string, string[]>;
  accounts: PrivilegedAccount[];
  dormantDays: number;
  /** True when the holder read hit ACCESS_REVIEW_LIMIT. */
  truncated: boolean;
  revokes: {
    available: boolean;
    unavailableReason?: string;
    rows: RoleRevoke[];
  };
}

const isCancel = (e: unknown): boolean =>
  e instanceof ServiceNowError && e.code === "CANCELLED";

/** Platform date-time ("YYYY-MM-DD HH:MM:SS", UTC) to epoch ms; NaN when unparseable. */
function snTime(value: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(value);
  return m ? Date.parse(`${m[1]}T${m[2]}Z`) : NaN;
}

/**
 * Whether an account is dormant: active, and its last login is missing or
 * older than `days` before `now`. An unparseable date is not dormant.
 */
export function isDormant(
  active: boolean,
  lastLogin: string | undefined,
  now: number,
  days = DORMANT_DAYS,
): boolean {
  if (!active) return false;
  if (!lastLogin) return true;
  const t = snTime(lastLogin);
  return Number.isFinite(t) && now - t > days * 86_400_000;
}

/**
 * Close a privileged role set over containment: every role that contains a
 * privileged role (directly or through other roles) becomes privileged.
 * `contains` is [container, contained] name pairs. Returns the container
 * roles with the privileged roles each one reaches.
 */
export function privilegedContainers(
  base: ReadonlySet<string>,
  contains: readonly (readonly [string, string])[],
): Record<string, string[]> {
  const children = new Map<string, string[]>();
  for (const [parent, child] of contains) {
    if (!parent || !child || parent === child) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const out: Record<string, string[]> = {};
  for (const parent of children.keys()) {
    if (base.has(parent)) continue;
    const reached = new Set<string>();
    const seen = new Set<string>([parent]);
    const stack = [...(children.get(parent) ?? [])];
    while (stack.length) {
      const r = stack.pop()!;
      if (seen.has(r)) continue;
      seen.add(r);
      if (base.has(r)) reached.add(r);
      stack.push(...(children.get(r) ?? []));
    }
    if (reached.size) out[parent] = [...reached].sort();
  }
  return out;
}

function grantOf(r: Record<string, unknown>): PrivilegedGrant {
  const group = snString(r["granted_by.name"]);
  const container = snString(r["included_in_role.name"]);
  const inherited = snString(r.inherited) === "true";
  const by = snString(r.sys_created_by);
  const on = snString(r.sys_created_on);
  const path: GrantPath = group
    ? "group"
    : container || inherited
      ? "contained_role"
      : "direct";
  const via = group || container;
  return {
    role: snString(r["role.name"]),
    path,
    ...(via ? { via } : {}),
    ...(by ? { grantedBy: by } : {}),
    ...(on ? { grantedOn: on } : {}),
  };
}

/** Group holder rows per user; accounts sorted dormant first, then by user name. */
export function groupAccounts(
  rows: readonly Record<string, unknown>[],
  now: number,
  days = DORMANT_DAYS,
): PrivilegedAccount[] {
  const by = new Map<string, PrivilegedAccount>();
  for (const r of rows) {
    const id = snString(r.user);
    if (!id) continue;
    let account = by.get(id);
    if (!account) {
      const active = snString(r["user.active"]) !== "false";
      const lastLogin = snString(r["user.last_login_time"]) || undefined;
      const name = snString(r["user.name"]);
      account = {
        sys_id: id,
        userName: snString(r["user.user_name"]) || id,
        ...(name ? { name } : {}),
        active,
        ...(lastLogin ? { lastLogin } : {}),
        dormant: isDormant(active, lastLogin, now, days),
        grants: [],
      };
      by.set(id, account);
    }
    const g = grantOf(r);
    if (
      !account.grants.some(
        (x) => x.role === g.role && x.path === g.path && x.via === g.via,
      )
    ) {
      account.grants.push(g);
    }
  }
  for (const a of by.values()) {
    a.grants.sort((x, y) => x.role.localeCompare(y.role));
  }
  return [...by.values()].sort(
    (a, b) =>
      Number(b.dormant) - Number(a.dormant) ||
      a.userName.localeCompare(b.userName),
  );
}

function unavailable(reason: string): AccessReview {
  return {
    available: false,
    unavailableReason: reason,
    roles: [],
    containers: {},
    accounts: [],
    dormantDays: DORMANT_DAYS,
    truncated: false,
    revokes: { available: false, rows: [] },
  };
}

async function readRevokes(now: number): Promise<AccessReview["revokes"]> {
  const since = new Date(now - REVOKE_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  try {
    const { records } = await queryTable({
      table: "sys_audit_delete",
      query: `tablename=sys_user_has_role^sys_created_on>=${since}^ORDERBYDESCsys_created_on`,
      fields: ["documentkey", "sys_created_by", "sys_created_on"],
      displayValue: "false",
      limit: REVOKE_LIMIT,
    });
    return {
      available: true,
      rows: records.map((r) => ({
        sys_id: snString(r.documentkey),
        revokedBy: snString(r.sys_created_by),
        revokedOn: snString(r.sys_created_on),
      })),
    };
  } catch (e) {
    if (isCancel(e)) throw e;
    return {
      available: false,
      unavailableReason: unreadableReason("sys_audit_delete", e),
      rows: [],
    };
  }
}

/** Read the privileged roles, their holders and recent revokes. */
export async function readAccessReview({
  now = Date.now(),
  dormantDays = DORMANT_DAYS,
}: { now?: number; dormantDays?: number } = {}): Promise<AccessReview> {
  const base = new Set<string>(BASE_PRIVILEGED_ROLES);
  try {
    const { records } = await queryTable({
      table: "sys_user_role",
      query: `elevated_privilege=true^ORnameIN${BASE_PRIVILEGED_ROLES.join(",")}`,
      fields: ["name"],
      displayValue: "false",
      fetchAll: true,
    });
    for (const r of records) {
      const name = snString(r.name);
      if (name) base.add(name);
    }
  } catch (e) {
    if (isCancel(e)) throw e;
    return unavailable(unreadableReason("sys_user_role", e));
  }

  let containers: Record<string, string[]> = {};
  try {
    const { records } = await queryTable({
      table: "sys_user_role_contains",
      fields: ["role.name", "contains.name"],
      displayValue: "false",
      fetchAll: true,
    });
    containers = privilegedContainers(
      base,
      records.map(
        (r) =>
          [snString(r["role.name"]), snString(r["contains.name"])] as const,
      ),
    );
  } catch (e) {
    // Containment is an addition: without it the direct holders still list.
    if (isCancel(e)) throw e;
  }

  const roles = [...new Set([...base, ...Object.keys(containers)])].sort();
  let holders: Record<string, unknown>[];
  let truncated: boolean;
  try {
    const res = await queryTable({
      table: "sys_user_has_role",
      query: `role.nameIN${roles.join(",")}^state=active^ORstateISEMPTY`,
      fields: [
        "user",
        "user.user_name",
        "user.name",
        "user.active",
        "user.last_login_time",
        "role.name",
        "inherited",
        "granted_by.name",
        "included_in_role.name",
        "sys_created_by",
        "sys_created_on",
      ],
      displayValue: "false",
      limit: ACCESS_REVIEW_LIMIT,
    });
    holders = res.records;
    truncated = res.records.length >= ACCESS_REVIEW_LIMIT;
  } catch (e) {
    if (isCancel(e)) throw e;
    return {
      ...unavailable(unreadableReason("sys_user_has_role", e)),
      roles,
      containers,
    };
  }

  return {
    available: true,
    roles,
    containers,
    accounts: groupAccounts(holders, now, dormantDays),
    dormantDays,
    truncated,
    revokes: await readRevokes(now),
  };
}

/** Markdown for the privileged-accounts report (the future `access_review` kind). */
export function renderAccessReview(review: AccessReview): string[] {
  if (!review.available) {
    return [
      `Unavailable: ${review.unavailableReason ?? "the role tables could not be read."}`,
      "",
    ];
  }
  const esc = (s: string): string => s.replaceAll("|", "\\|");
  const dormant = review.accounts.filter((a) => a.dormant).length;
  const inactive = review.accounts.filter((a) => !a.active).length;
  const lines = [
    `${review.accounts.length} account(s) hold a privileged role (${review.roles.length} role(s)); ${dormant} dormant (active, no login for ${review.dormantDays} days), ${inactive} inactive${review.truncated ? `; the holder read stopped at ${ACCESS_REVIEW_LIMIT} rows, so the list is partial` : ""}.`,
    "",
    `- **Privileged roles:** ${review.roles.map((r) => `\`${r}\``).join(", ") || "none"}`,
  ];
  const containers = Object.entries(review.containers);
  if (containers.length) {
    lines.push(
      `- **Privileged by containment:** ${containers.map(([r, c]) => `\`${r}\` (contains ${c.join(", ")})`).join("; ")}`,
    );
  }
  lines.push("");
  if (review.accounts.length) {
    lines.push(
      "| User | Name | Active | Last login | Dormant | Role | Path | Via | Granted by | Granted on |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const a of review.accounts) {
      for (const g of a.grants) {
        lines.push(
          `| ${esc(a.userName)} | ${esc(a.name ?? "")} | ${a.active ? "yes" : "no"} | ${a.lastLogin ?? "never"} | ${a.dormant ? "**yes**" : ""} | ${esc(g.role)} | ${g.path} | ${esc(g.via ?? "")} | ${esc(g.grantedBy ?? "")} | ${g.grantedOn ?? ""} |`,
        );
      }
    }
    lines.push("");
  }
  lines.push(`### Role revokes (last ${REVOKE_DAYS} days)`, "");
  if (!review.revokes.available) {
    lines.push(
      `Unavailable: ${review.revokes.unavailableReason ?? "sys_audit_delete could not be read."}`,
      "",
    );
  } else if (!review.revokes.rows.length) {
    lines.push("_None._", "");
  } else {
    lines.push(
      "| Role grant (sys_user_has_role) | Revoked by | Revoked on |",
      "| --- | --- | --- |",
      ...review.revokes.rows.map(
        (r) => `| ${r.sys_id} | ${esc(r.revokedBy)} | ${r.revokedOn} |`,
      ),
      "",
    );
  }
  lines.push(
    "Granted by / on are the role row's creator and creation date. Field names (granted_by, included_in_role, last_login_time) and the revoke source (sys_audit_delete) are unverified until O-5 (PDI).",
    "",
  );
  return lines;
}

/** Role rows read per user history (newest first). */
export const ROLE_HISTORY_LIMIT = 500;

/** One grant or revoke in a user's role history. */
export interface RoleHistoryEvent {
  action: "granted" | "revoked";
  /** Role name; a deleted row whose payload has no display value gives the role sys_id. */
  role: string;
  /** The sys_user_has_role row. */
  rowId: string;
  /** Grant path (granted only). */
  path?: GrantPath;
  via?: string;
  /** A grant row's state when it is not active (e.g. `pending`, `requested`). */
  state?: string;
  by: string;
  on: string;
}

export interface RoleHistory {
  available: boolean;
  unavailableReason?: string;
  user: string;
  /** Grants and revokes, newest first. */
  events: RoleHistoryEvent[];
  /** True when the grant read hit ROLE_HISTORY_LIMIT. */
  truncated: boolean;
  /** Days of revokes looked back on. */
  revokeDays: number;
  revokes: { available: boolean; unavailableReason?: string };
}

const SYS_ID = /^[0-9a-f]{32}$/;

const xmlText = (s: string): string =>
  s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

/** One element of a deleted record's XML payload: its value and display value. */
function payloadField(
  payload: string,
  name: string,
): { value: string; display?: string } | undefined {
  const m = new RegExp(`<${name}(\\s[^>]*)?>([^<]*)</${name}>`).exec(payload);
  if (!m) return undefined;
  const display = /\bdisplay_value="([^"]*)"/.exec(m[1] ?? "")?.[1];
  return {
    value: xmlText(m[2]!.trim()),
    ...(display ? { display: xmlText(display) } : {}),
  };
}

/**
 * The user and role of a deleted sys_user_has_role row, read from its
 * sys_audit_delete XML payload (`<user>…</user>`, `<role display_value="…">…</role>`).
 * The payload format is unverified until O-5 (PDI).
 */
export function deletedRoleRow(payload: string): {
  user?: string;
  role?: string;
} {
  const user = payloadField(payload, "user")?.value;
  const role = payloadField(payload, "role");
  const name = role?.display || role?.value;
  return { ...(user ? { user } : {}), ...(name ? { role: name } : {}) };
}

/**
 * Read one user's role history: every sys_user_has_role row of the user as a
 * grant (creator and date, path, a non-active state), and the user's deleted
 * rows from sys_audit_delete as revokes (the last `days` days). Newest first.
 *
 * Not wired to a tool yet: it becomes `lookup_directory` kind `user`
 * `role_history` once O-10 clears the tools/list change (NX-33). Degrades like
 * the review: an unreadable sys_user_has_role is `available:false`, an
 * unreadable audit only `revokes.available:false`. The revoke filter matches
 * the user sys_id in the payload text, then checks the parsed `user` element.
 */
export async function readRoleHistory({
  user,
  now = Date.now(),
  days = REVOKE_DAYS,
}: {
  user: string;
  now?: number;
  days?: number;
}): Promise<RoleHistory> {
  if (!SYS_ID.test(user)) {
    throw new ServiceNowError("Give the user's sys_id.", 400);
  }
  const base = {
    user,
    revokeDays: days,
    events: [] as RoleHistoryEvent[],
    truncated: false,
  };
  let grants: Record<string, unknown>[];
  try {
    const res = await queryTable({
      table: "sys_user_has_role",
      query: `user=${user}^ORDERBYDESCsys_created_on`,
      fields: [
        "sys_id",
        "role.name",
        "inherited",
        "granted_by.name",
        "included_in_role.name",
        "state",
        "sys_created_by",
        "sys_created_on",
      ],
      displayValue: "false",
      limit: ROLE_HISTORY_LIMIT,
    });
    grants = res.records;
  } catch (e) {
    if (isCancel(e)) throw e;
    return {
      ...base,
      available: false,
      unavailableReason: unreadableReason("sys_user_has_role", e),
      revokes: { available: false },
    };
  }

  const events: RoleHistoryEvent[] = grants.map((r) => {
    const g = grantOf(r);
    const state = snString(r.state);
    return {
      action: "granted",
      role: g.role,
      rowId: snString(r.sys_id),
      path: g.path,
      ...(g.via ? { via: g.via } : {}),
      ...(state && state !== "active" ? { state } : {}),
      by: g.grantedBy ?? "",
      on: g.grantedOn ?? "",
    };
  });

  const since = new Date(now - days * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  let revokes: RoleHistory["revokes"];
  try {
    const { records } = await queryTable({
      table: "sys_audit_delete",
      query: `tablename=sys_user_has_role^payloadLIKE${user}^sys_created_on>=${since}^ORDERBYDESCsys_created_on`,
      fields: ["documentkey", "payload", "sys_created_by", "sys_created_on"],
      displayValue: "false",
      limit: REVOKE_LIMIT,
    });
    for (const r of records) {
      const row = deletedRoleRow(snString(r.payload));
      if (row.user !== user) continue;
      events.push({
        action: "revoked",
        role: row.role ?? "",
        rowId: snString(r.documentkey),
        by: snString(r.sys_created_by),
        on: snString(r.sys_created_on),
      });
    }
    revokes = { available: true };
  } catch (e) {
    if (isCancel(e)) throw e;
    revokes = {
      available: false,
      unavailableReason: unreadableReason("sys_audit_delete", e),
    };
  }

  // Platform date-times sort as text; a revoke sorts before a grant at the same second.
  events.sort(
    (a, b) =>
      b.on.localeCompare(a.on) ||
      Number(b.action === "revoked") - Number(a.action === "revoked"),
  );
  return {
    ...base,
    available: true,
    events,
    truncated: grants.length >= ROLE_HISTORY_LIMIT,
    revokes,
  };
}

/** Markdown for one user's role history (the future `role_history` section). */
export function renderRoleHistory(history: RoleHistory): string[] {
  if (!history.available) {
    return [
      `Unavailable: ${history.unavailableReason ?? "sys_user_has_role could not be read."}`,
      "",
    ];
  }
  const esc = (s: string): string => s.replaceAll("|", "\\|");
  const granted = history.events.filter((e) => e.action === "granted").length;
  const revoked = history.events.length - granted;
  const lines = [
    `${granted} role grant(s)${history.truncated ? ` (the read stopped at ${ROLE_HISTORY_LIMIT} rows)` : ""}; ${history.revokes.available ? `${revoked} revoke(s) in the last ${history.revokeDays} days` : `revokes unavailable: ${history.revokes.unavailableReason ?? "sys_audit_delete could not be read."}`}.`,
    "",
  ];
  if (history.events.length) {
    lines.push(
      "| On | Action | Role | Path | Via | State | By |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...history.events.map(
        (e) =>
          `| ${e.on} | ${e.action} | ${esc(e.role)} | ${e.path ?? ""} | ${esc(e.via ?? "")} | ${esc(e.state ?? "")} | ${esc(e.by)} |`,
      ),
      "",
    );
  }
  lines.push(
    "A grant's by / on are the role row's creator and creation date; a revoke is a deleted role row from sys_audit_delete. The payload format and field names are unverified until O-5 (PDI).",
    "",
  );
  return lines;
}
