import { decodeField } from "../core/artifacts/decoders.js";
import { flattenComposition } from "../core/artifacts/uib-composition-diff.js";
import type { UibRule, UibSeverity } from "./uib-script-lint.js";

/**
 * N-31 (UX-22) — page performance hints for a UI Builder macroponent: the
 * `uib-page-weight` rule. Where ./uib-script-lint.ts reads client-script
 * source, this reads the page's own JSON (`composition`, `data`) and
 * reports:
 *
 * - `elements`: more elements than UIB_PAGE_WEIGHT_THRESHOLDS.elements;
 * - `depth`: slot nesting deeper than the threshold;
 * - `on-load-brokers`: more data resources fired on page load than the
 *   threshold (each one is a server round trip before the page settles);
 * - `unconditional-broker`: data resources fired on load with no `when`
 *   condition (they run even when the page never shows their output).
 *
 * Pure: no network, no I/O. Findings carry the rule id, severity, metric,
 * measured value, threshold, a message and the rule hint.
 *
 * ASSUMPTION (unverified until O-5, PDI): a data resource that runs on load
 * is one whose `evaluationMode` (or `invocation` / `trigger`) is absent or
 * reads EAGER / ON_LOAD / PAGE_LOAD; JUST_IN_TIME, LAZY, MANUAL, INVOKED and
 * ON_DEMAND mean "only when an event invokes it". A `when` condition is a
 * non-empty `when`, `condition` or `whenCondition` on the data resource.
 */

/** The page-level rule catalogue (same shape as UIB_SCRIPT_RULES). */
export const UIB_PAGE_RULES: readonly UibRule[] = [
  {
    id: "uib-page-weight",
    severity: "info",
    hint: "Split a heavy page into viewports or sub-pages, flatten deep slot nesting, and make data resources invoke on demand or behind a `when` condition so the page loads only what it shows.",
  },
];

/** Default thresholds of `uib-page-weight` (a page above one gets a hint). */
export const UIB_PAGE_WEIGHT_THRESHOLDS = {
  /** Elements in the composition. */
  elements: 150,
  /** Slot nesting depth (root elements are depth 1). */
  depth: 8,
  /** Data resources fired on page load. */
  onLoadBrokers: 5,
} as const;

export type UibPageWeightThresholds = {
  -readonly [K in keyof typeof UIB_PAGE_WEIGHT_THRESHOLDS]: number;
};

export type UibPageMetric =
  | "elements"
  | "depth"
  | "on-load-brokers"
  | "unconditional-broker";

export interface UibPageFinding {
  rule: string;
  severity: UibSeverity;
  metric: UibPageMetric;
  /** The measured value. */
  value: number;
  /** The threshold it exceeded (absent for `unconditional-broker`). */
  threshold?: number;
  message: string;
  hint: string;
  /** `unconditional-broker`: the data resource element ids. */
  elementIds?: string[];
}

export interface UibPageMetrics {
  /** Elements in the composition (bounded by the flatten cap). */
  elements: number;
  /** Deepest slot nesting. */
  maxDepth: number;
  /** Data resources declared in `data`. */
  dataBrokers: number;
  /** Data resources fired on page load. */
  onLoadBrokers: number;
  /** On-load data resources without a `when` condition. */
  unconditionalOnLoad: string[];
  /** The composition or data hit a cap or has an unknown shape. */
  partial?: true;
}

export interface UibPageWeight {
  metrics: UibPageMetrics;
  findings: UibPageFinding[];
}

const RULE = UIB_PAGE_RULES[0]!;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  !!v && typeof v === "object" && !Array.isArray(v);

const ON_DEMAND = /JUST_IN_TIME|LAZY|MANUAL|INVOKE|ON_DEMAND|EXPLICIT/i;

/** A raw JSON column (string) or an already decoded value. */
function decoded(
  decoder: "uib-composition" | "json",
  value: unknown,
): { value: unknown; ok: boolean } {
  if (typeof value !== "string") return { value, ok: true };
  if (!value.trim()) return { value: [], ok: true };
  const d = decodeField(decoder, value);
  return d.decoded ? { value: d.value, ok: true } : { value: [], ok: false };
}

/** Whether a data resource runs on page load (see the module ASSUMPTION). */
export function firesOnLoad(resource: Obj): boolean {
  const mode = [
    resource.evaluationMode,
    resource.invocation,
    resource.trigger,
  ].find((v) => typeof v === "string" && v);
  return typeof mode !== "string" || !ON_DEMAND.test(mode);
}

/** Whether a data resource has a non-empty `when` condition. */
export function hasWhenCondition(resource: Obj): boolean {
  return [resource.when, resource.condition, resource.whenCondition].some(
    (v) =>
      (typeof v === "string" && v.trim() !== "") ||
      (isObj(v) && Object.keys(v).length > 0) ||
      (Array.isArray(v) && v.length > 0),
  );
}

/** Page metrics of a raw or decoded `sys_ux_macroponent` row. */
export function uibPageMetrics(row: {
  composition?: unknown;
  data?: unknown;
}): UibPageMetrics {
  const comp = decoded("uib-composition", row.composition ?? []);
  const flat = flattenComposition(comp.value);
  const data = decoded("json", row.data ?? []);
  const resources = Array.isArray(data.value)
    ? data.value.filter(
        (r): r is Obj => isObj(r) && typeof r.elementId === "string",
      )
    : [];
  const onLoad = resources.filter(firesOnLoad);
  const partial =
    !comp.ok ||
    !data.ok ||
    !Array.isArray(data.value) ||
    flat.omitted > 0 ||
    (comp.value !== null && !Array.isArray(comp.value));
  return {
    elements: flat.elements.size,
    maxDepth: flat.maxDepth,
    dataBrokers: resources.length,
    onLoadBrokers: onLoad.length,
    unconditionalOnLoad: onLoad
      .filter((r) => !hasWhenCondition(r))
      .map((r) => r.elementId as string),
    ...(partial ? { partial: true as const } : {}),
  };
}

/**
 * The `uib-page-weight` rule over one macroponent row (`composition` and
 * `data`, JSON strings or decoded values). Never throws.
 */
export function lintUibPageWeight(
  row: { composition?: unknown; data?: unknown },
  thresholds: Partial<UibPageWeightThresholds> = {},
): UibPageWeight {
  const t: UibPageWeightThresholds = {
    ...UIB_PAGE_WEIGHT_THRESHOLDS,
    ...thresholds,
  };
  const metrics = uibPageMetrics(row);
  const findings: UibPageFinding[] = [];
  const add = (f: Omit<UibPageFinding, "rule" | "severity" | "hint">): void => {
    findings.push({
      rule: RULE.id,
      severity: RULE.severity,
      ...f,
      hint: RULE.hint,
    });
  };
  if (metrics.elements > t.elements) {
    add({
      metric: "elements",
      value: metrics.elements,
      threshold: t.elements,
      message: `The page has ${metrics.elements} elements (threshold ${t.elements}).`,
    });
  }
  if (metrics.maxDepth > t.depth) {
    add({
      metric: "depth",
      value: metrics.maxDepth,
      threshold: t.depth,
      message: `Slots nest ${metrics.maxDepth} levels deep (threshold ${t.depth}).`,
    });
  }
  if (metrics.onLoadBrokers > t.onLoadBrokers) {
    add({
      metric: "on-load-brokers",
      value: metrics.onLoadBrokers,
      threshold: t.onLoadBrokers,
      message: `${metrics.onLoadBrokers} data resources fire on page load (threshold ${t.onLoadBrokers}).`,
    });
  }
  if (metrics.unconditionalOnLoad.length > 0) {
    add({
      metric: "unconditional-broker",
      value: metrics.unconditionalOnLoad.length,
      message: `${metrics.unconditionalOnLoad.length} data resource(s) fire on page load without a \`when\` condition.`,
      elementIds: metrics.unconditionalOnLoad.slice(0, 50),
    });
  }
  return { metrics, findings };
}
