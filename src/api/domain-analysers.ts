/**
 * P-19 — domain analysers (project/SDK-PARITY.md §4 P-19): rules over the
 * Flow Designer, Service Portal, UI Builder and legacy-workflow metadata,
 * folded into `check_code_health` behind its opt-in `domains` switch.
 *
 * Flows (sys_hub_flow and its step tables, read the way explain_flow reads
 * them — P-10 / P-11):
 *   - `flow-run-as-system-protected` — an active flow running as System whose
 *     trigger or a step input names an H-11 protected table;
 *   - `flow-draft-differs` — the flow's latest snapshot is not its published
 *     (master) snapshot, from the pointers on the sys_hub_flow row;
 *   - `flow-unused-subflow` / `flow-unused-action` — a custom subflow or
 *     action no flow step calls;
 *   - `flow-integration-no-error-handling` — an integration action step
 *     (REST / SOAP / HTTP steps, integration-hub spokes) outside a Try block;
 *   - `flow-long-wait` — a wait-for-duration longer than `LONG_WAIT_SECONDS`.
 *
 * Portal:
 *   - `portal-public-data-widget` — a widget that is public, or placed on a
 *     public page, whose server script reads data with GlideRecord /
 *     GlideAggregate / GlideQuery / $sp.getRecord;
 *   - `portal-orphan-widget` / `portal-orphan-page` — not placed / not linked;
 *   - `portal-route-map-loop` — active route maps whose effective redirects
 *     form a cycle within one portal.
 *
 * UI Builder (the tables explain_ui_experience reads — P-14):
 *   - `uib-route-no-screen` — a custom route whose screen type has no screen
 *     (variant), so the route renders nothing;
 *   - `uib-screen-no-applicability` — a custom screen with no audience: it
 *     matches every user, and shadows any later variant of its screen type
 *     (`warn` when it does, `info` otherwise);
 *   - `uib-data-broker-no-acl` — a custom transform / scriptlet data broker
 *     with no `ux_data_broker` ACL (sys_security_acl `name` = broker sys_id);
 *   - N-29 (./uib-broker-lint.ts, also over the REST / GraphQL broker tables
 *     when readable): `uib-broker-mutates-no-acl` (error — a broker that
 *     declares `mutates_server_data` with no ACL; reported instead of
 *     `uib-data-broker-no-acl`), `uib-transform-gliderecord-no-acl-check`
 *     (a transform querying with GlideRecord and never checking access) and
 *     `uib-broker-no-input-schema` (empty `properties`).
 *
 * Legacy: `workflow-migration-candidate` — a wf_workflow still referenced by
 * a catalog item or an SLA definition.
 *
 * Bounds: the newest `limit` candidates per rule (the `limit` of check_code_health
 * `extended`), child reads capped at `DOMAIN_CHILD_MAX` rows per table and
 * chunked IN lists; a capped read marks the rule `truncated`. An unused /
 * orphan rule never reports a candidate whose callers were not fully read.
 * Every table here is `verified:false` (gate O-5): an unreadable one
 * (policy denial, ACL, missing plugin) makes the rules that need it
 * `available:false` with the reason — never a failure.
 *
 * Layout (E-7): this file runs the rule groups and sorts the findings; the
 * rules live in `domain-rules-flow.ts`, `-portal.ts`, `-uib.ts` and
 * `-workflow.ts`, over the reads and collector in `domain-rules-shared.ts`.
 */
import {
  Collector,
  type Ctx,
  DOMAIN_FINDINGS_TOP,
  DOMAIN_LIMIT,
  type DomainAnalysis,
  type DomainSeverity,
} from "./domain-rules-shared.js";
import { analyseFlows } from "./domain-rules-flow.js";
import { analysePortal } from "./domain-rules-portal.js";
import { analyseUib } from "./domain-rules-uib.js";
import { analyseWorkflows } from "./domain-rules-workflow.js";

export {
  type DomainSeverity,
  type DomainRuleId,
  type DomainName,
  DOMAIN_RULES,
  DOMAIN_LIMIT,
  DOMAIN_CHILD_MAX,
  DOMAIN_FINDINGS_TOP,
  LONG_WAIT_SECONDS,
  type DomainRef,
  type DomainFinding,
  type DomainRuleCheck,
  type DomainAnalysis,
} from "./domain-rules-shared.js";
export { durationSeconds } from "./domain-rules-flow.js";
export { routeLoops } from "./domain-rules-portal.js";

// --- entry point --------------------------------------------------------------------

const SEVERITY_ORDER: Record<DomainSeverity, number> = {
  error: 0,
  warn: 1,
  info: 2,
};

/**
 * Run the flow, portal, UI Builder and legacy-workflow rules. Never throws for an
 * unreadable table; an unexpected error propagates to the caller
 * (check_code_health turns it into a warning).
 */
export async function analyseDomains(
  opts: { limit?: number } = {},
): Promise<DomainAnalysis> {
  const limit = Math.min(
    Math.max(1, Math.trunc(opts.limit ?? DOMAIN_LIMIT.default)),
    DOMAIN_LIMIT.max,
  );
  const ctx: Ctx = {
    limit,
    caveats: new Set(),
    warnings: [],
    unreadable: new Map(),
  };
  const out = new Collector();
  await analyseFlows(ctx, out);
  await analysePortal(ctx, out);
  await analyseUib(ctx, out);
  await analyseWorkflows(ctx, out);
  ctx.caveats.add(
    "Flow Designer, Service Portal, UI Builder and workflow tables are verified:false: their field names come from the SDK inventory and have not been confirmed on a live instance (gate O-5).",
  );
  for (const [, why] of ctx.unreadable) ctx.warnings.push(why);

  const bySeverity: Record<DomainSeverity, number> = {
    error: 0,
    warn: 0,
    info: 0,
  };
  for (const f of out.findings) bySeverity[f.severity]++;
  const sorted = [...out.findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.rule.localeCompare(b.rule),
  );
  return {
    limit,
    findingCount: out.findings.length,
    bySeverity,
    rules: out.rules,
    findings: sorted.slice(0, DOMAIN_FINDINGS_TOP),
    ...(sorted.length > DOMAIN_FINDINGS_TOP
      ? { findingsOmitted: sorted.length - DOMAIN_FINDINGS_TOP }
      : {}),
    caveats: [...ctx.caveats],
    warnings: ctx.warnings,
  };
}
