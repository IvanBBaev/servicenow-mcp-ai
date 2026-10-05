import { ServiceNowError } from "../core/errors.js";
import {
  HARDENING_RULES,
  HARDENING_RULES_VERSION,
  type HardeningExpect,
  type HardeningRule,
  type HardeningSeverity,
} from "./hardening-rules.js";
import { PROPERTIES_TABLE } from "./properties.js";
import { snString } from "./shared.js";
import { queryTable } from "./table.js";

/**
 * N-13 (NX-17) — hardening compliance: the rule table in hardening-rules.ts
 * evaluated against the instance's sys_properties rows. One read for every
 * rule; the evaluation itself is pure (`evaluateHardening`).
 *
 * Per rule: `pass` / `fail` on a row's value; `not_set` when no row is
 * readable (the platform default applies, and `defaultPasses` says whether
 * that default meets the rule); `unreadable` when sys_properties itself
 * cannot be read. A rule with `since` / `until` outside the instance's
 * release family is skipped.
 */

export type HardeningStatus = "pass" | "fail" | "not_set" | "unreadable";

export interface HardeningResult {
  property: string;
  status: HardeningStatus;
  severity: HardeningSeverity;
  expected: string;
  /** The row's value (pass / fail). */
  value?: string;
  /** The platform default (not_set), when known. */
  default?: string;
  /** not_set: whether the default meets the rule; absent when the default is unknown. */
  defaultPasses?: boolean;
  rationale: string;
  source: string;
}

export interface HardeningReport {
  rulesVersion: string;
  available: boolean;
  unavailableReason?: string;
  results: HardeningResult[];
  counts: Record<HardeningStatus, number>;
  /** Failed rules by severity. */
  failed: Record<HardeningSeverity, number>;
}

/** Release families in order, for `since` / `until` (lower-case). */
const FAMILIES = [
  "tokyo",
  "utah",
  "vancouver",
  "washingtondc",
  "xanadu",
  "yokohama",
  "zurich",
  "australia",
];

export function describeExpect(expect: HardeningExpect): string {
  if ("equals" in expect) return expect.equals;
  if ("max" in expect) return `≤ ${expect.max}`;
  return `≥ ${expect.min}`;
}

export function meetsExpect(expect: HardeningExpect, value: string): boolean {
  const v = value.trim();
  if ("equals" in expect) return v.toLowerCase() === expect.equals;
  const n = Number(v);
  if (v === "" || !Number.isFinite(n)) return false;
  return "max" in expect ? n <= expect.max : n >= expect.min;
}

function applies(rule: HardeningRule, family: string | undefined): boolean {
  if (!family || (!rule.since && !rule.until)) return true;
  const at = FAMILIES.indexOf(family);
  if (at < 0) return true;
  if (rule.since && at < FAMILIES.indexOf(rule.since)) return false;
  if (rule.until && at > FAMILIES.indexOf(rule.until)) return false;
  return true;
}

/**
 * Evaluate `rules` against `values` (property name → value of a readable row),
 * or mark every rule `unreadable` when `values` is undefined.
 */
export function evaluateHardening(
  values: ReadonlyMap<string, string> | undefined,
  {
    rules = HARDENING_RULES,
    family,
    unavailableReason,
  }: {
    rules?: readonly HardeningRule[];
    family?: string;
    unavailableReason?: string;
  } = {},
): HardeningReport {
  const counts: Record<HardeningStatus, number> = {
    pass: 0,
    fail: 0,
    not_set: 0,
    unreadable: 0,
  };
  const failed: Record<HardeningSeverity, number> = {
    high: 0,
    medium: 0,
    low: 0,
  };
  const results: HardeningResult[] = [];
  for (const rule of rules) {
    if (!applies(rule, family)) continue;
    const base = {
      property: rule.property,
      severity: rule.severity,
      expected: describeExpect(rule.expect),
      rationale: rule.rationale,
      source: rule.source,
    };
    let result: HardeningResult;
    if (!values) {
      result = { ...base, status: "unreadable" };
    } else if (values.has(rule.property)) {
      const value = values.get(rule.property)!;
      result = {
        ...base,
        status: meetsExpect(rule.expect, value) ? "pass" : "fail",
        value,
      };
    } else {
      result = {
        ...base,
        status: "not_set",
        ...(rule.default === undefined
          ? {}
          : {
              default: rule.default,
              defaultPasses: meetsExpect(rule.expect, rule.default),
            }),
      };
    }
    counts[result.status]++;
    if (result.status === "fail") failed[rule.severity]++;
    results.push(result);
  }
  return {
    rulesVersion: HARDENING_RULES_VERSION,
    available: values !== undefined,
    ...(values === undefined && unavailableReason ? { unavailableReason } : {}),
    results,
    counts,
    failed,
  };
}

/**
 * Read every rule's property in one sys_properties query and evaluate the
 * table. Never throws except on a cancel: an unreadable sys_properties turns
 * every rule `unreadable`.
 */
export async function checkHardening(
  family?: string,
): Promise<HardeningReport> {
  const names = HARDENING_RULES.map((r) => r.property);
  try {
    const { records } = await queryTable({
      table: PROPERTIES_TABLE,
      query: `nameIN${names.join(",")}`,
      fields: ["name", "value"],
      displayValue: "false",
      limit: names.length * 2,
    });
    const values = new Map<string, string>();
    for (const r of records) {
      const name = snString(r.name);
      if (name) values.set(name, snString(r.value));
    }
    return evaluateHardening(values, { family });
  } catch (e) {
    if (e instanceof ServiceNowError && e.code === "CANCELLED") throw e;
    return evaluateHardening(undefined, {
      family,
      unavailableReason: `sys_properties could not be read: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

/** Markdown for the hardening section of the security document and code health. */
export function renderHardening(report: HardeningReport): string[] {
  const lines = [
    `Rule table v${report.rulesVersion}: ${report.counts.pass} pass, ${report.counts.fail} fail (high ${report.failed.high}, medium ${report.failed.medium}, low ${report.failed.low}), ${report.counts.not_set} not set, ${report.counts.unreadable} unreadable.`,
    "",
  ];
  if (!report.available) {
    lines.push(
      `Unavailable: ${report.unavailableReason ?? "sys_properties could not be read."}`,
      "",
    );
    return lines;
  }
  const esc = (s: string): string => s.replaceAll("|", "\\|");
  lines.push(
    "| Property | Status | Severity | Expected | Value | Rationale |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  const order: Record<HardeningStatus, number> = {
    fail: 0,
    not_set: 1,
    unreadable: 2,
    pass: 3,
  };
  const sorted = [...report.results].sort(
    (a, b) => order[a.status] - order[b.status],
  );
  for (const r of sorted) {
    const value =
      r.status === "not_set"
        ? r.default === undefined
          ? "(no row; default unknown)"
          : `(no row; default ${r.default}${r.defaultPasses ? "" : " — does not meet the rule"})`
        : (r.value ?? "");
    lines.push(
      `| \`${r.property}\` | ${r.status} | ${r.severity} | ${esc(r.expected)} | ${esc(value)} | ${esc(r.rationale)} |`,
    );
  }
  lines.push(
    "",
    "Property names, expected values and defaults are unverified until O-5 (PDI); a property row hidden by its read roles counts as not set.",
    "",
  );
  return lines;
}
