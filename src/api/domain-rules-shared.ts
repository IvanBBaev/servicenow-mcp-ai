import { ServiceNowError } from "../core/errors.js";
import { snString, IN_CHUNK } from "./shared.js";
import { queryTable, type SnRecord } from "./table.js";

/**
 * Shared pieces of the P-19 domain analysers: the rule table and result
 * shapes, the bounded reads and the findings collector.
 */

export type DomainSeverity = "error" | "warn" | "info";

export type DomainRuleId =
  | "flow-run-as-system-protected"
  | "flow-draft-differs"
  | "flow-unused-subflow"
  | "flow-unused-action"
  | "flow-integration-no-error-handling"
  | "flow-long-wait"
  | "portal-public-data-widget"
  | "portal-orphan-widget"
  | "portal-orphan-page"
  | "portal-route-map-loop"
  | "uib-route-no-screen"
  | "uib-screen-no-applicability"
  | "uib-data-broker-no-acl"
  | "uib-broker-mutates-no-acl"
  | "uib-transform-gliderecord-no-acl-check"
  | "uib-broker-no-input-schema"
  | "workflow-migration-candidate";

export type DomainName = "flow" | "portal" | "uib" | "workflow";

export const DOMAIN_RULES: Record<
  DomainRuleId,
  { domain: DomainName; severity: DomainSeverity }
> = {
  "flow-run-as-system-protected": { domain: "flow", severity: "warn" },
  "flow-draft-differs": { domain: "flow", severity: "info" },
  "flow-unused-subflow": { domain: "flow", severity: "info" },
  "flow-unused-action": { domain: "flow", severity: "info" },
  "flow-integration-no-error-handling": { domain: "flow", severity: "warn" },
  "flow-long-wait": { domain: "flow", severity: "info" },
  "portal-public-data-widget": { domain: "portal", severity: "warn" },
  "portal-orphan-widget": { domain: "portal", severity: "info" },
  "portal-orphan-page": { domain: "portal", severity: "info" },
  "portal-route-map-loop": { domain: "portal", severity: "warn" },
  "uib-route-no-screen": { domain: "uib", severity: "warn" },
  "uib-screen-no-applicability": { domain: "uib", severity: "info" },
  "uib-data-broker-no-acl": { domain: "uib", severity: "warn" },
  "uib-broker-mutates-no-acl": { domain: "uib", severity: "error" },
  "uib-transform-gliderecord-no-acl-check": { domain: "uib", severity: "warn" },
  "uib-broker-no-input-schema": { domain: "uib", severity: "info" },
  "workflow-migration-candidate": { domain: "workflow", severity: "info" },
};

/** Candidates per rule (default / max) — the check_code_health `limit`. */
export const DOMAIN_LIMIT = { default: 50, max: 200 } as const;

/** Rows read per child table (summed over IN chunks). */
export const DOMAIN_CHILD_MAX = 500;

/** Findings returned (the counts cover all of them). */
export const DOMAIN_FINDINGS_TOP = 100;

/** A wait-for-duration above this many seconds is a long wait (1 day). */
export const LONG_WAIT_SECONDS = 86_400;

/** A record id safe to splice into an encoded query. */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Custom candidates only: OOB spokes and store apps live in `sn_*` scopes. */
export const NOT_OOB = "sys_scope.scopeNOT LIKEsn_";

export const NEWEST = "ORDERBYDESCsys_updated_on";

export interface DomainRef {
  /** Registry artefact type (servicenow_explain_artifact takes it). */
  artifactType: string;
  table: string;
  sys_id: string;
  name?: string;
}

export interface DomainFinding {
  rule: DomainRuleId;
  severity: DomainSeverity;
  domain: DomainName;
  ref: DomainRef;
  message: string;
  details?: Record<string, unknown>;
}

export interface DomainRuleCheck {
  available: boolean;
  unavailableReason?: string;
  /** Candidates the rule examined. */
  scanned: number;
  findings: number;
  /** A read stopped at its cap; the rule may have missed findings. */
  truncated?: boolean;
}

export interface DomainAnalysis {
  limit: number;
  findingCount: number;
  bySeverity: Record<DomainSeverity, number>;
  rules: Record<DomainRuleId, DomainRuleCheck>;
  /** Errors first, at most DOMAIN_FINDINGS_TOP. */
  findings: DomainFinding[];
  findingsOmitted?: number;
  caveats: string[];
  warnings: string[];
}

export class Unavailable extends Error {}

export interface Ctx {
  limit: number;
  caveats: Set<string>;
  warnings: string[];
  /** Table → why it could not be read. */
  unreadable: Map<string, string>;
}

export interface Rows {
  rows: SnRecord[];
  capped: boolean;
}

export const str = (row: SnRecord, field: string): string =>
  snString(row[field]);

/** A field as a string, or undefined when the row does not carry it. */
export const raw = (row: SnRecord, field: string): string | undefined =>
  row[field] === undefined ? undefined : snString(row[field]);

/**
 * One bounded read (`max` rows). An instance or policy error on a table is
 * remembered: that table then reads as `null` for every later rule.
 */
export async function read(
  ctx: Ctx,
  table: string,
  query: string,
  fields: string[],
  max: number,
): Promise<Rows | null> {
  if (ctx.unreadable.has(table)) return null;
  try {
    const { records } = await queryTable({
      table,
      query,
      fields,
      limit: max + 1,
      displayValue: "false",
    });
    return { rows: records.slice(0, max), capped: records.length > max };
  } catch (error) {
    if (!(error instanceof ServiceNowError)) throw error;
    ctx.unreadable.set(
      table,
      `${table} could not be read${error.status ? ` (${error.status})` : ""}: ${error.message}`,
    );
    return null;
  }
}

/** `field IN ids` over chunks, at most `DOMAIN_CHILD_MAX` rows in all. */
export async function readIn(
  ctx: Ctx,
  table: string,
  field: string,
  ids: Iterable<string>,
  fields: string[],
  suffix = "",
): Promise<Rows | null> {
  const list = [...new Set(ids)].filter((id) => SAFE_ID.test(id));
  const out: Rows = { rows: [], capped: false };
  for (let i = 0; i < list.length; i += IN_CHUNK) {
    const room = DOMAIN_CHILD_MAX - out.rows.length;
    if (room <= 0) {
      out.capped = true;
      break;
    }
    const chunk = list.slice(i, i + IN_CHUNK);
    const r = await read(
      ctx,
      table,
      `${field}IN${chunk.join(",")}${suffix}`,
      fields,
      room,
    );
    if (!r) return out.rows.length ? { ...out, capped: true } : null;
    out.rows.push(...r.rows);
    if (r.capped) {
      out.capped = true;
      break;
    }
  }
  return out;
}

/** Read a v1 / `_v2` table pair; null only when both are unreadable. */
export async function readPair(
  ctx: Ctx,
  tables: string[],
  field: string,
  ids: Iterable<string>,
  fields: string[],
): Promise<(Rows & { source: Map<SnRecord, string> }) | null> {
  const list = [...ids];
  const out = {
    rows: [] as SnRecord[],
    capped: false,
    source: new Map<SnRecord, string>(),
  };
  let any = false;
  for (const t of tables) {
    const r = await readIn(ctx, t, field, list, fields);
    if (!r) continue;
    any = true;
    for (const row of r.rows) out.source.set(row, t);
    out.rows.push(...r.rows);
    out.capped ||= r.capped;
  }
  return any ? out : null;
}

export function need<T>(ctx: Ctx, value: T | null, ...tables: string[]): T {
  if (value !== null) return value;
  const why = tables
    .map((t) => ctx.unreadable.get(t))
    .filter((w): w is string => !!w);
  throw new Unavailable(why.join(" ") || `${tables.join(" / ")} unreadable.`);
}

export class Collector {
  readonly findings: DomainFinding[] = [];
  readonly rules = {} as Record<DomainRuleId, DomainRuleCheck>;

  constructor() {
    for (const id of Object.keys(DOMAIN_RULES) as DomainRuleId[]) {
      this.rules[id] = { available: true, scanned: 0, findings: 0 };
    }
  }

  add(
    rule: DomainRuleId,
    ref: DomainRef,
    message: string,
    details?: Record<string, unknown>,
    severity = DOMAIN_RULES[rule].severity,
  ): void {
    this.findings.push({
      rule,
      severity,
      domain: DOMAIN_RULES[rule].domain,
      ref,
      message,
      ...(details ? { details } : {}),
    });
    this.rules[rule].findings++;
  }

  scanned(rule: DomainRuleId, n: number, truncated = false): void {
    this.rules[rule].scanned += n;
    if (truncated) this.rules[rule].truncated = true;
  }

  unavailable(rules: DomainRuleId[], reason: string): void {
    for (const r of rules) {
      this.rules[r] = {
        available: false,
        unavailableReason: reason,
        scanned: this.rules[r].scanned,
        findings: 0,
      };
    }
    this.findings.splice(
      0,
      this.findings.length,
      ...this.findings.filter((f) => !rules.includes(f.rule)),
    );
  }

  /** Run one rule group; an unreadable table disables that group only. */
  async run(rules: DomainRuleId[], fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      if (error instanceof Unavailable) {
        this.unavailable(rules, error.message);
        return;
      }
      throw error;
    }
  }
}

export const refOf = (
  artifactType: string,
  table: string,
  row: SnRecord,
  nameField = "name",
): DomainRef => {
  const name = str(row, nameField);
  return {
    artifactType,
    table,
    sys_id: str(row, "sys_id"),
    ...(name ? { name } : {}),
  };
};
