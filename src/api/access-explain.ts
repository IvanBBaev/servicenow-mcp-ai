import { ServiceNowError, rethrowIfCancelled } from "../core/errors.js";
import {
  DOMAIN_CAVEAT,
  domainTraceFields,
  recordDomain,
} from "./domain-separation.js";
import { MermaidDoc, label } from "./mermaid.js";
import { getTableChain } from "./meta.js";
import {
  aclScriptHints,
  unreadableReason,
  type AclScriptHint,
} from "./security.js";
import { mdEscape, mdTable, snString } from "./shared.js";
import { queryTable } from "./table.js";
import { isSysId } from "../core/sys-id.js";

/**
 * N-2 (NX-02) — access explainer: why one user can or cannot perform one
 * operation on a table, a record or a field, by evaluating the record ACL
 * chain statically.
 *
 * The platform checks a row ACL (`table`, then each parent table, then `*`)
 * and, for a field, a field ACL (`table.field` up the chain, then
 * `table.*` up the chain, then `*.field`, then `*.*`). Each check stops at the
 * first name level that has an active ACL for the operation; the check passes
 * when any ACL at that level passes. An ACL passes when its role, condition
 * and script parts all pass. Here the role part is checked against the user's
 * roles, the condition part by querying the record with the condition (as the
 * connected user, not as the user explained), and a script part is always
 * `undetermined`.
 *
 * Not wired to a tool yet: reading another user's roles is an admin action,
 * and the placement (default `instance` package or a separate opt-in) waits
 * for O-13; the tool waits for O-10. Only role names leave this module (H-5).
 *
 * Read-only; never throws except on bad input or a cancel. An unreadable ACL,
 * role or user table degrades to `available:false`. Unverified until O-5
 * (PDI): inherited sys_user_has_role rows and their `state`, `admin_overrides`,
 * the field-ACL fallback order and the default when no ACL matches (deny, as
 * in high-security mode).
 *
 * N-12: on a domain-separated instance each ACL carries the domain it belongs
 * to; the evaluation and the rendered table group by it and the result adds
 * the domain caveat. Without domain separation the output is unchanged.
 */

export const ACCESS_OPERATIONS = ["read", "write", "create", "delete"] as const;
export type AccessOperation = (typeof ACCESS_OPERATIONS)[number];

export type AccessDecision = "granted" | "denied" | "undetermined";
/** One ACL part: `n/a` when the ACL does not use it. */
export type PartResult = "pass" | "fail" | "undetermined" | "n/a";

/** ACL rows read per check (one name level holds few ACLs). */
export const ACL_LIMIT = 200;
/** Role rows read for one user. */
export const USER_ROLE_LIMIT = 2_000;

/** Roles that must be elevated in the session before they apply. */
const ELEVATED_ROLES = new Set(["security_admin"]);
const NAME_RE = /^[a-z0-9_]+$/i;

export interface AclRule {
  sys_id: string;
  name: string;
  roles: string[];
  condition: string;
  script: string;
  /** The script part is only used when `advanced` is set. */
  advanced: boolean;
  /** An admin passes the ACL without evaluating it (platform default true). */
  adminOverrides: boolean;
  /** N-12: the ACL's domain when it is not global. */
  domain?: string;
  /** N-12: sys_id of the ACL this one overrides in its domain. */
  overrides?: string;
}

export interface AclEvaluation {
  sys_id: string;
  name: string;
  roles: string[];
  role: PartResult;
  condition: PartResult;
  script: PartResult;
  result: AccessDecision;
  notes: string[];
  /** N-12: the ACL's domain when it is not global. */
  domain?: string;
  /** S-12 lint hits of an undetermined script part. */
  scriptHints?: AclScriptHint[];
}

export interface AccessCheck {
  kind: "row" | "field";
  /** Names tried, most specific first. */
  candidates: string[];
  /** The first name with an active ACL; undefined when none matched. */
  matched?: string;
  acls: AclEvaluation[];
  decision: AccessDecision;
  /** The ACL that decided a `granted` check. */
  decidingAcl?: string;
}

export interface AccessExplanation {
  available: boolean;
  unavailableReason?: string;
  user: string;
  table: string;
  operation: AccessOperation;
  sysId?: string;
  field?: string;
  /** The user's active role names, sorted. */
  roles: string[];
  admin: boolean;
  decision: AccessDecision;
  checks: AccessCheck[];
  /** Conditions were evaluated as the connected user. */
  notes: string[];
}

export interface ExplainAccessInput {
  /** user_name or sys_id. */
  user: string;
  table: string;
  operation: AccessOperation;
  sysId?: string;
  field?: string;
}

/** Row ACL names for a table chain (child first): each table, then `*`. */
export function rowCandidates(chain: readonly string[]): string[] {
  return [...chain, "*"];
}

/** Field ACL names, most specific first. */
export function fieldCandidates(
  chain: readonly string[],
  field: string,
): string[] {
  return [
    ...chain.map((t) => `${t}.${field}`),
    ...chain.map((t) => `${t}.*`),
    `*.${field}`,
    "*.*",
  ];
}

/** The first candidate name that has at least one ACL, and its ACLs. */
export function matchLevel<T extends { name: string }>(
  candidates: readonly string[],
  acls: readonly T[],
): { matched?: string; acls: T[] } {
  for (const name of candidates) {
    const level = acls.filter((a) => a.name === name);
    if (level.length > 0) return { matched: name, acls: level };
  }
  return { acls: [] };
}

/** Combine ACL parts: any fail denies, else any undetermined is undetermined. */
function combine(parts: readonly PartResult[]): AccessDecision {
  if (parts.includes("fail")) return "denied";
  if (parts.includes("undetermined")) return "undetermined";
  return "granted";
}

/**
 * Evaluate one ACL for a user. `conditionMatch` is the record-level result of
 * the condition query: true / false, or undefined when it was not run (no
 * record, unreadable record).
 */
export function evaluateAcl(
  acl: AclRule,
  roles: ReadonlySet<string>,
  conditionMatch: boolean | undefined,
): AclEvaluation {
  const notes: string[] = [];
  const admin = roles.has("admin");
  const out = (
    role: PartResult,
    condition: PartResult,
    script: PartResult,
  ): AclEvaluation => ({
    sys_id: acl.sys_id,
    name: acl.name,
    roles: acl.roles,
    role,
    condition,
    script,
    result: combine([role, condition, script]),
    notes,
    ...(acl.domain ? { domain: acl.domain } : {}),
    ...(script === "undetermined" && hints.length
      ? { scriptHints: hints }
      : {}),
  });
  if (acl.overrides) notes.push(`overrides ${acl.overrides} in its domain`);
  // Declared before the admin short-circuit so `out` never reads it unset.
  let script: PartResult = "n/a";
  let hints: AclScriptHint[] = [];
  if (admin && acl.adminOverrides) {
    notes.push("admin overrides this ACL");
    return out("pass", "n/a", "n/a");
  }

  let role: PartResult = "n/a";
  if (acl.roles.length > 0) {
    const held = acl.roles.filter((r) => roles.has(r));
    role = held.length > 0 ? "pass" : "fail";
    if (role === "pass" && held.every((r) => ELEVATED_ROLES.has(r))) {
      notes.push(
        `passes only through ${held.join(", ")}, which must be elevated in the session`,
      );
    }
  }

  let condition: PartResult = "n/a";
  if (acl.condition.trim()) {
    if (conditionMatch === undefined) {
      condition = "undetermined";
      notes.push("condition not evaluated (no readable record)");
    } else {
      condition = conditionMatch ? "pass" : "fail";
    }
  }

  if (acl.advanced && acl.script.trim()) {
    script = "undetermined";
    notes.push("script part is not evaluated statically");
    hints = aclScriptHints(acl.script);
    for (const h of hints) notes.push(`script: ${h.rule} (${h.severity})`);
  }
  return out(role, condition, script);
}

/** A check passes when any ACL at the matched level passes. */
export function decideCheck(
  matched: string | undefined,
  acls: readonly AclEvaluation[],
): { decision: AccessDecision; decidingAcl?: string } {
  if (matched === undefined) return { decision: "denied" };
  const granted = acls.find((a) => a.result === "granted");
  if (granted) return { decision: "granted", decidingAcl: granted.sys_id };
  if (acls.some((a) => a.result === "undetermined")) {
    return { decision: "undetermined" };
  }
  return { decision: "denied" };
}

/** Row and field checks must both grant; one denial denies. */
export function combineChecks(checks: readonly AccessCheck[]): AccessDecision {
  if (checks.some((c) => c.decision === "denied")) return "denied";
  if (checks.some((c) => c.decision === "undetermined")) return "undetermined";
  return "granted";
}

/** The `true` flag of a platform boolean; `fallback` when empty. */
function flag(value: unknown, fallback: boolean): boolean {
  const s = snString(value);
  return s === "" ? fallback : s === "true";
}

function badInput(message: string): ServiceNowError {
  return new ServiceNowError(message, 400);
}

function validate(input: ExplainAccessInput): void {
  if (!input.user.trim() || /[\^,=]/.test(input.user)) {
    throw badInput("user must be a user_name or sys_id without ^ , =");
  }
  if (!NAME_RE.test(input.table)) throw badInput("table is not a table name");
  if (input.field !== undefined && !NAME_RE.test(input.field)) {
    throw badInput("field is not a field name");
  }
  if (input.sysId !== undefined && !isSysId(input.sysId)) {
    throw badInput("sys_id must be 32 hex characters");
  }
  if (!ACCESS_OPERATIONS.includes(input.operation)) {
    throw badInput(`operation must be one of ${ACCESS_OPERATIONS.join(", ")}`);
  }
}

type Step<T> = { ok: true; value: T } | { ok: false; reason: string };

async function step<T>(table: string, fn: () => Promise<T>): Promise<Step<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    rethrowIfCancelled(error);
    return { ok: false, reason: unreadableReason(table, error) };
  }
}

/** The user's sys_id and active role names (inherited rows included). */
export async function readUserRoles(
  user: string,
): Promise<{ sysId?: string; roles: string[] }> {
  const field = isSysId(user) ? "sys_id" : "user_name";
  const { records } = await queryTable({
    table: "sys_user",
    query: `${field}=${user}`,
    fields: ["sys_id"],
    displayValue: "false",
    limit: 1,
  });
  const sysId = snString(records[0]?.sys_id);
  if (!sysId) return { roles: [] };
  const rows = await queryTable({
    table: "sys_user_has_role",
    query: `user=${sysId}`,
    fields: ["role.name", "state"],
    displayValue: "false",
    limit: USER_ROLE_LIMIT,
  });
  const roles = new Set<string>();
  for (const r of rows.records) {
    const state = snString(r.state);
    const name = snString(r["role.name"]);
    if (name && (state === "" || state === "active")) roles.add(name);
  }
  return { sysId, roles: [...roles].sort() };
}

/** Active record ACLs for the operation with any of the candidate names. */
async function readAcls(
  names: readonly string[],
  operation: AccessOperation,
): Promise<AclRule[]> {
  const { records } = await queryTable({
    table: "sys_security_acl",
    query: `active=true^type.name=record^operation=${operation}^nameIN${names.join(",")}`,
    fields: [
      "sys_id",
      "name",
      "condition",
      "script",
      "advanced",
      "admin_overrides",
      ...domainTraceFields(),
    ],
    displayValue: "false",
    limit: ACL_LIMIT,
  });
  const acls: AclRule[] = records.map((r) => ({
    sys_id: snString(r.sys_id),
    name: snString(r.name),
    roles: [],
    condition: snString(r.condition),
    script: snString(r.script),
    advanced: flag(r.advanced, false),
    adminOverrides: flag(r.admin_overrides, true),
    ...recordDomain(r),
  }));
  if (acls.length === 0) return acls;
  const roleRows = await queryTable({
    table: "sys_security_acl_role",
    query: `sys_security_aclIN${acls.map((a) => a.sys_id).join(",")}`,
    fields: ["sys_security_acl", "sys_user_role.name"],
    displayValue: "false",
    limit: ACL_LIMIT * 10,
  });
  const byAcl = new Map(acls.map((a) => [a.sys_id, a]));
  for (const r of roleRows.records) {
    const acl = byAcl.get(snString(r.sys_security_acl));
    const role = snString(r["sys_user_role.name"]);
    if (acl && role && !acl.roles.includes(role)) acl.roles.push(role);
  }
  for (const a of acls) a.roles.sort();
  return acls;
}

/** Whether the record matches the ACL condition (as the connected user). */
async function conditionMatches(
  table: string,
  sysId: string,
  condition: string,
): Promise<boolean | undefined> {
  // `^NQ` starts a new OR query that the sys_id filter would not cover.
  if (condition.includes("^NQ")) return undefined;
  try {
    const { records } = await queryTable({
      table,
      query: `sys_id=${sysId}^${condition}`,
      fields: ["sys_id"],
      displayValue: "false",
      limit: 1,
    });
    return records.length > 0;
  } catch (error) {
    rethrowIfCancelled(error);
    return undefined;
  }
}

async function runCheck(
  kind: AccessCheck["kind"],
  candidates: string[],
  acls: readonly AclRule[],
  roles: ReadonlySet<string>,
  match: (condition: string) => Promise<boolean | undefined>,
): Promise<AccessCheck> {
  const level = matchLevel(candidates, acls);
  const evaluated: AclEvaluation[] = [];
  for (const acl of level.acls) {
    const cond = acl.condition.trim() ? await match(acl.condition) : undefined;
    evaluated.push(evaluateAcl(acl, roles, cond));
  }
  return {
    kind,
    candidates,
    matched: level.matched,
    acls: evaluated,
    ...decideCheck(level.matched, evaluated),
  };
}

/** Explain one user's access to a table, a record or a field. */
export async function explainAccess(
  input: ExplainAccessInput,
): Promise<AccessExplanation> {
  validate(input);
  const base: AccessExplanation = {
    available: false,
    user: input.user,
    table: input.table,
    operation: input.operation,
    sysId: input.sysId,
    field: input.field,
    roles: [],
    admin: false,
    decision: "undetermined",
    checks: [],
    notes: [],
  };

  const user = await step("sys_user_has_role", () => readUserRoles(input.user));
  if (!user.ok) return { ...base, unavailableReason: user.reason };
  if (!user.value.sysId) {
    return { ...base, unavailableReason: `No user "${input.user}".` };
  }
  const roles = new Set(user.value.roles);

  const chain = await step("sys_db_object", () => getTableChain(input.table));
  if (!chain.ok) return { ...base, unavailableReason: chain.reason };
  const rows = rowCandidates(chain.value);
  const fields = input.field ? fieldCandidates(chain.value, input.field) : [];

  const acls = await step("sys_security_acl", () =>
    readAcls([...rows, ...fields], input.operation),
  );
  if (!acls.ok) return { ...base, unavailableReason: acls.reason };

  const notes: string[] = [];
  const cache = new Map<string, boolean | undefined>();
  const match = async (condition: string): Promise<boolean | undefined> => {
    if (!input.sysId) return undefined;
    if (!cache.has(condition)) {
      cache.set(
        condition,
        await conditionMatches(input.table, input.sysId, condition),
      );
    }
    return cache.get(condition);
  };
  if (input.sysId) {
    notes.push(
      "Conditions were evaluated as the connected user, not as the user explained.",
    );
  }

  const checks = [await runCheck("row", rows, acls.value, roles, match)];
  if (input.field) {
    checks.push(await runCheck("field", fields, acls.value, roles, match));
  }
  if (checks.some((c) => c.acls.some((a) => a.domain))) {
    notes.push(DOMAIN_CAVEAT);
  }
  for (const c of checks) {
    if (c.matched === undefined) {
      notes.push(
        `No ${c.kind} ACL matches; the high-security default denies (unverified until O-5).`,
      );
    }
  }
  return {
    ...base,
    available: true,
    roles: user.value.roles,
    admin: roles.has("admin"),
    decision: combineChecks(checks),
    checks,
    notes,
  };
}

/** Markdown for an explanation. */
export function renderAccessExplanation(e: AccessExplanation): string[] {
  const target = `${e.table}${e.field ? `.${e.field}` : ""}${e.sysId ? ` (${e.sysId})` : ""}`;
  const out = [`## Access: ${e.operation} on ${mdEscape(target)}`, ""];
  if (!e.available) {
    out.push(`Not available: ${e.unavailableReason ?? "unknown reason"}`);
    return out;
  }
  out.push(
    `**Decision: ${e.decision}** for ${mdEscape(e.user)}${e.admin ? " (admin)" : ""}.`,
    "",
    `Roles: ${e.roles.length ? e.roles.map(mdEscape).join(", ") : "none"}`,
  );
  for (const c of e.checks) {
    out.push(
      "",
      `### ${c.kind === "row" ? "Row" : "Field"} check: ${c.decision}`,
      "",
      `Matched: ${c.matched ? `\`${c.matched}\`` : "no ACL"} (tried ${c.candidates.map((n) => `\`${n}\``).join(" → ")})`,
    );
    if (c.acls.length) {
      // N-12: a Domain column, rows grouped by domain (global first), only
      // when an ACL is domain-specific.
      const domains = c.acls.some((a) => a.domain);
      const acls = domains
        ? [...c.acls].sort((a, b) =>
            (a.domain ?? "").localeCompare(b.domain ?? ""),
          )
        : c.acls;
      out.push(
        "",
        ...mdTable(
          [
            "ACL",
            ...(domains ? ["Domain"] : []),
            "Roles",
            "Role",
            "Condition",
            "Script",
            "Result",
            "Notes",
          ],
          acls.map((a) => [
            a.sys_id === c.decidingAcl ? `**${a.sys_id}**` : a.sys_id,
            ...(domains ? [a.domain ?? "global"] : []),
            a.roles.join(", ") || "—",
            a.role,
            a.condition,
            a.script,
            a.result,
            a.notes.join("; "),
          ]),
        ).split("\n"),
      );
    }
  }
  if (e.notes.length) out.push("", ...e.notes.map((n) => `- ${n}`));
  return out;
}

/** Short label of a check's decision. */
const CHECK_TITLE = { row: "Row", field: "Field" } as const;

/**
 * A Mermaid flowchart of the decision: per check, the names tried down to the
 * matched level, each ACL at that level with its result, the check decision,
 * and the overall decision. Empty when the explanation is not available.
 */
export function renderAccessMermaid(e: AccessExplanation): string {
  if (!e.available) return "";
  const doc = new MermaidDoc("flowchart TD");
  const target = `${e.table}${e.field ? `.${e.field}` : ""}`;
  doc.node("start", label(`${e.user}: ${e.operation} ${target}`, 120), "rect", {
    pinned: true,
  });
  const ends: string[] = [];
  for (const c of e.checks) {
    const k = c.kind;
    const tried = c.matched
      ? c.candidates.slice(0, c.candidates.indexOf(c.matched) + 1)
      : c.candidates;
    doc.open(`${k}_check`, label(`${CHECK_TITLE[k]} check`));
    let prev = "start";
    tried.forEach((name, i) => {
      const id = `${k}_n${i}`;
      const text =
        name === c.matched
          ? `${name}: ${c.acls.length} ACL${c.acls.length === 1 ? "" : "s"}`
          : `${name}: no ACL`;
      doc.edgeTo(prev, id, label(text, 120), {
        arrow: name === c.matched ? "-->" : "-.->",
      });
      prev = id;
    });
    const decision = `${k}_decision`;
    doc.node(decision, label(`${CHECK_TITLE[k]}: ${c.decision}`), "rect", {
      pinned: true,
    });
    if (c.matched) {
      c.acls.forEach((a, i) => {
        const id = `${k}_acl${i}`;
        const deciding = a.sys_id === c.decidingAcl ? " (deciding)" : "";
        doc.edgeTo(prev, id, label(`${a.sys_id}: ${a.result}${deciding}`, 120));
        doc.edge(id, decision);
      });
    } else {
      doc.edge(prev, decision, "-.->");
    }
    doc.close();
    ends.push(decision);
  }
  doc.node("decision", e.decision, "terminal", { pinned: true });
  for (const id of ends) doc.edge(id, "decision");
  return doc.render();
}
