import {
  getScript,
  tableLogic,
  scriptArtifact,
  scopeClause,
  SCRIPT_TYPES,
  OPT_IN_SCRIPT_TYPES,
} from "./scripts.js";
import { queryTable } from "./table.js";
import { aggregate } from "./aggregate.js";
import { docsWriteRaw } from "./docs.js";
import { analyseDomains, type DomainAnalysis } from "./domain-analysers.js";
import { snString } from "./shared.js";
import { activeProfile } from "../core/config.js";
import { ServiceNowError } from "../core/errors.js";
import { securityScan, type SecurityScan } from "./security.js";
import {
  readInstanceScan,
  renderInstanceScan,
  type InstanceScanReport,
} from "./instance-scan.js";
import {
  checkHardening,
  renderHardening,
  type HardeningReport,
  type HardeningResult,
} from "./hardening.js";
import { ecmaModeForScope, type EcmaMode } from "./script-ast.js";
import {
  lintUibClientScript,
  uibFindingsAsGeneric,
  uibLintContextFromMacroponent,
  UIB_CLIENT_SCRIPT_TYPES,
  type UibLintContext,
} from "./uib-script-lint.js";
import {
  applyBaseline,
  deltaMarkdown,
  domainFacts,
  lintFingerprints,
  securityFacts,
  type BaselineSection,
  type CodeHealthDelta,
  type SectionFacts,
} from "./code-health-baseline.js";
import { isSysId } from "../core/sys-id.js";
import {
  type Finding,
  type LintEngine,
  lintSourceDetailed,
  type Scope,
  type Severity,
  sortFindings,
} from "./codecheck-rules.js";

/**
 * Local code analysis (Phase 8, package `codecheck`). Pulls script source
 * through the existing api/scripts.ts layer and runs deterministic rules in
 * pure TypeScript — zero network beyond fetching the code. S-12: the rules
 * run over an acorn AST (./script-ast.ts), so comments and string contents
 * no longer match; a source that does not parse falls back to the line-regex
 * rules. Each finding carries a rule id, severity, line, snippet and a fix
 * hint. The rules themselves live in ./codecheck-rules.ts (E-7).
 */

export {
  type Severity,
  type Scope,
  type Finding,
  lintSourceRegex,
  type LintEngine,
  type LintOptions,
  type SourceLint,
  lintSourceDetailed,
  lintSource,
} from "./codecheck-rules.js";

/**
 * Server vs client scope for one source field of a script type, from the
 * registry (S-4): a field listed in `clientFields` runs in the browser. For
 * client_script and ui_policy every script field is a client field, for the
 * other seven original types none is — the pre-S-4 per-type split.
 */
function scopeForField(clientFields: string[] | undefined, field: string) {
  return clientFields?.includes(field) ? ("client" as Scope) : "server";
}

export interface ScriptLint {
  type: string;
  sys_id: string;
  name: string;
  field: string;
  findings: Finding[];
  /** S-12: `ast` when the source parsed, `regex` for the fallback. */
  engine?: LintEngine;
  /** S-12: the ES level the source was parsed at. */
  ecma?: EcmaMode;
  /** S-12: why the parser fell back to the regex rules. */
  parseError?: string;
}

/**
 * S-12: one script field linted with the record's ES level. N-32: a UI
 * Builder client script (`uib`) also gets the UIB rules (./uib-script-lint.ts),
 * checked against its macroponent's contract when one is given.
 */
function lintField(
  src: string,
  scope: Scope,
  ecma: EcmaMode,
  uib?: UibLintContext,
): Pick<ScriptLint, "findings" | "engine" | "ecma" | "parseError"> {
  const r = lintSourceDetailed(src, scope, { ecma });
  const findings = uib
    ? sortFindings([
        ...r.findings,
        ...uibFindingsAsGeneric(
          lintUibClientScript(src, uib).findings,
          r.findings,
        ),
      ])
    : r.findings;
  return {
    findings,
    engine: r.engine,
    ...(r.ecma ? { ecma: r.ecma } : {}),
    ...(r.parseError ? { parseError: r.parseError } : {}),
  };
}

/**
 * N-32: the UIB lint context of a client script — its macroponent's declared
 * state, events and data resources. Empty (the contract rules stay silent)
 * when the script has no macroponent or the row cannot be read.
 */
async function uibContextFor(
  record: Record<string, unknown>,
): Promise<UibLintContext> {
  const id = snString(record.macroponent);
  if (!isSysId(id)) return {};
  try {
    const res = await queryTable({
      table: "sys_ux_macroponent",
      query: `sys_id=${id}`,
      fields: ["sys_id", "state_properties", "dispatched_events", "data"],
      limit: 1,
      displayValue: "false",
    });
    const row = res.records[0];
    return row ? uibLintContextFromMacroponent(row) : {};
  } catch {
    return {};
  }
}

/** FT-5 — lint one script artefact (all its source fields). */
export async function lintScript(
  type: string,
  sysId: string,
): Promise<{ type: string; sys_id: string; results: ScriptLint[] }> {
  // P-18: the opt-in registry types (UI Builder, portal providers…) too.
  const descriptor = SCRIPT_TYPES[type] ?? OPT_IN_SCRIPT_TYPES[type];
  if (!descriptor) {
    throw new ServiceNowError(
      `Unknown script type '${type}'. Valid: ${[...Object.keys(SCRIPT_TYPES), ...Object.keys(OPT_IN_SCRIPT_TYPES)].join(", ")}.`,
      400,
    );
  }
  const { record } = await getScript(type, sysId);
  const { clientFields, markupFields, scopeField } = scriptArtifact(type, true);
  const name = snString(record[descriptor.nameField]);
  // S-12: a global-scope script runs as ES5, a scoped one as ES2021.
  const ecma = ecmaModeForScope(snString(record[scopeField]));
  // N-32: UIB client scripts get the UIB rules against their macroponent.
  const uib = UIB_CLIENT_SCRIPT_TYPES.has(type)
    ? await uibContextFor(record)
    : undefined;
  const results: ScriptLint[] = [];
  for (const field of descriptor.scriptFields) {
    // Markup (HTML, Jelly XML, CSS, REST endpoint templates) is searchable but
    // not JavaScript, so the linter would only report noise.
    if (markupFields?.includes(field)) continue;
    const src = snString(record[field]);
    if (!src) continue;
    results.push({
      type,
      sys_id: sysId,
      name,
      field,
      ...lintField(src, scopeForField(clientFields, field), ecma, uib),
    });
  }
  return { type, sys_id: sysId, results };
}

const LINTABLE: { key: string; type: string }[] = [
  { key: "businessRules", type: "business_rule" },
  { key: "clientScripts", type: "client_script" },
  { key: "uiPolicies", type: "ui_policy" },
];

export interface TableLint {
  table: string;
  scriptCount: number;
  findingCount: number;
  bySeverity: Record<Severity, number>;
  results: ScriptLint[];
  warnings: string[];
}

/** FT-5 — lint every business rule / client script / UI policy of a table. */
export async function lintTable(table: string): Promise<TableLint> {
  const logic = await tableLogic(table);
  const bySeverity: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
  const results: ScriptLint[] = [];
  const warnings: string[] = [];
  let scriptCount = 0;

  for (const { key, type } of LINTABLE) {
    const entries =
      (logic as unknown as Record<string, { sys_id: string }[]>)[key] ?? [];
    for (const entry of entries) {
      if (!entry.sys_id) continue;
      scriptCount++;
      try {
        const { results: r } = await lintScript(type, entry.sys_id);
        for (const res of r) {
          if (res.findings.length > 0) results.push(res);
          for (const f of res.findings) bySeverity[f.severity]++;
        }
      } catch (e) {
        warnings.push(
          `${type} ${entry.sys_id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  results.sort((a, b) => b.findings.length - a.findings.length);
  const findingCount = bySeverity.error + bySeverity.warn + bySeverity.info;
  return { table, scriptCount, findingCount, bySeverity, results, warnings };
}

/** One aggregate bucket (count) from the Stats API. */
function countFromStats(result: unknown): number {
  const entry: unknown = Array.isArray(result) ? result[0] : result;
  if (typeof entry !== "object" || entry === null) return 0;
  const stats = (entry as Record<string, unknown>).stats;
  if (typeof stats !== "object" || stats === null) return 0;
  const n = Number(snString((stats as Record<string, unknown>).count));
  return Number.isFinite(n) ? n : 0;
}

// --- DF-1 / S-3: security scan over the access-control layer ----------------
// Lives in ./security.ts; re-exported so existing imports keep working.

export { securityScan } from "./security.js";

/** P-18: per-type records read by the registry sweep (default / max). */
export const ARTIFACT_LINT_LIMIT = 50;

export const ARTIFACT_LINT_LIMIT_MAX = 200;

/** Most lint results the sweep returns (the counts cover all of them). */
const ARTIFACT_LINT_TOP = 50;

export interface ArtifactTypeLint {
  table: string;
  scanned: number;
  /** True when the type had more records than the per-type limit. */
  capped: boolean;
  findingCount: number;
  bySeverity: Record<Severity, number>;
}

export interface ArtifactLint {
  limitPerType: number;
  scanned: number;
  findingCount: number;
  bySeverity: Record<Severity, number>;
  types: Record<string, ArtifactTypeLint>;
  /** The scripts with the most findings, at most ARTIFACT_LINT_TOP. */
  results: ScriptLint[];
  warnings: string[];
}

/**
 * P-18 — lint every registry script type (the default and the opt-in ones:
 * business rules to portal widgets, UI Builder client scripts, data broker
 * scripts, angular providers, search sources…) instance-wide: the most
 * recently updated `limit` records of each type, every non-markup script
 * field, client fields with the client rules. A type whose table cannot be
 * read (unverified, missing plugin, ACL, policy) is a warning, not a failure.
 */
export async function lintArtifacts(
  opts: {
    limit?: number;
    scope?: string;
    /** S-12: every linted field (the result keeps only the top ones). */
    onLint?: (lint: ScriptLint) => void;
  } = {},
): Promise<ArtifactLint> {
  const limit = Math.min(
    Math.max(1, Math.trunc(opts.limit ?? ARTIFACT_LINT_LIMIT)),
    ARTIFACT_LINT_LIMIT_MAX,
  );
  const empty = (): Record<Severity, number> => ({
    error: 0,
    warn: 0,
    info: 0,
  });
  const total = empty();
  const types: Record<string, ArtifactTypeLint> = {};
  const results: ScriptLint[] = [];
  const warnings: string[] = [];
  let scanned = 0;

  const all = { ...SCRIPT_TYPES, ...OPT_IN_SCRIPT_TYPES };
  for (const [type, descriptor] of Object.entries(all)) {
    const artifact = scriptArtifact(type, true);
    const fields = descriptor.scriptFields.filter(
      (f) => !artifact.markupFields?.includes(f),
    );
    if (fields.length === 0) continue;
    const query = [
      ...(artifact.baseQuery ? [artifact.baseQuery] : []),
      ...(opts.scope ? [scopeClause(artifact.scopeField, opts.scope)] : []),
      "ORDERBYDESCsys_updated_on",
    ].join("^");
    let records: Record<string, unknown>[];
    let capped: boolean;
    try {
      const res = await queryTable({
        table: descriptor.table,
        query,
        fields: [
          "sys_id",
          descriptor.nameField,
          ...fields,
          // S-12: the scope decides the ES level the scripts parse at.
          ...(fields.includes(artifact.scopeField)
            ? []
            : [artifact.scopeField]),
        ],
        limit: limit + 1,
        displayValue: "false",
      });
      records = res.records;
      capped = records.length > limit;
      records = records.slice(0, limit);
    } catch (e) {
      warnings.push(
        `${type} (${descriptor.table}): ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    const bySeverity = empty();
    for (const record of records) {
      const sysId = snString(record.sys_id);
      const name = snString(record[descriptor.nameField]);
      const ecma = ecmaModeForScope(snString(record[artifact.scopeField]));
      for (const field of fields) {
        const src = snString(record[field]);
        if (!src) continue;
        const lint: ScriptLint = {
          type,
          sys_id: sysId,
          name,
          field,
          // N-32: the sweep runs the UIB rules without the macroponent
          // contract (no extra read per record), so the declared-state /
          // event / data rules stay silent here.
          ...lintField(
            src,
            scopeForField(artifact.clientFields, field),
            ecma,
            UIB_CLIENT_SCRIPT_TYPES.has(type) ? {} : undefined,
          ),
        };
        opts.onLint?.(lint);
        for (const f of lint.findings) {
          bySeverity[f.severity]++;
          total[f.severity]++;
        }
        if (lint.findings.length > 0) results.push(lint);
      }
    }
    scanned += records.length;
    types[type] = {
      table: descriptor.table,
      scanned: records.length,
      capped,
      findingCount: bySeverity.error + bySeverity.warn + bySeverity.info,
      bySeverity,
    };
  }
  results.sort((a, b) => b.findings.length - a.findings.length);
  return {
    limitPerType: limit,
    scanned,
    findingCount: total.error + total.warn + total.info,
    bySeverity: total,
    types,
    results: results.slice(0, ARTIFACT_LINT_TOP),
    warnings,
  };
}

export interface CodeHealth {
  scope: string;
  profile: string;
  generatedAt: string;
  reportFile?: string;
  scriptCounts: Record<string, number>;
  lint?: TableLint;
  /** P-18: the registry-wide sweep (`extended`). */
  artifacts?: ArtifactLint;
  /** P-19: flow / portal / UI Builder / legacy-workflow rules (`domains`). */
  domains?: DomainAnalysis;
  security?: SecurityScan;
  /** N-3: the platform's latest Instance Scan result, with the records our lint also flags. */
  instanceScan?: InstanceScanReport;
  /** N-13: hardening compliance — the counts plus the failing rules only (the report holds every rule). */
  hardening?: Omit<HardeningReport, "results"> & {
    failing: HardeningResult[];
  };
  /** S-12: new / fixed findings against `<profile>/code-health.baseline.json`. */
  delta?: CodeHealthDelta;
  warnings: string[];
}

/**
 * FT-6 — an aggregate code-health picture. For a table it runs lintTable and
 * summarises; instance-wide it counts scripts by type. Writes a Markdown report
 * into the profile's docs folder (alongside the MI-6 snapshot).
 */
export async function codeHealth(
  scope?: string,
  opts: {
    extended?: boolean;
    domains?: boolean;
    limit?: number;
    /** S-12: move the baseline to this run's findings. */
    updateBaseline?: boolean;
  } = {},
): Promise<CodeHealth> {
  const profile = activeProfile();
  const generatedAt = new Date().toISOString();
  const warnings: string[] = [];
  const scriptCounts: Record<string, number> = {};
  // P-18: `extended` also counts (and sweeps) the opt-in registry types.
  const inventory = opts.extended
    ? { ...SCRIPT_TYPES, ...OPT_IN_SCRIPT_TYPES }
    : SCRIPT_TYPES;

  for (const [type, descriptor] of Object.entries(inventory)) {
    try {
      const { baseQuery } = scriptArtifact(type, true);
      const stats = await aggregate({
        table: descriptor.table,
        ...(baseQuery ? { query: baseQuery } : {}),
        count: true,
      });
      scriptCounts[type] = countFromStats(stats);
    } catch (e) {
      warnings.push(
        `count ${type}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  let lint: TableLint | undefined;
  const isTable = Boolean(scope && scope.trim());
  if (isTable) {
    try {
      lint = await lintTable(scope!.trim());
    } catch (e) {
      warnings.push(
        `lint ${scope!}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // DF-1: the security dimension, folded into the same health report.
  let security: SecurityScan | undefined;
  try {
    security = await securityScan();
  } catch (e) {
    warnings.push(`security: ${e instanceof Error ? e.message : String(e)}`);
  }

  const md: string[] = [
    `# Code health — profile \`${profile}\`${isTable ? ` · table \`${scope!.trim()}\`` : ""}`,
    "",
    `Generated ${generatedAt}.`,
    "",
    "## Script inventory",
    "",
    "| Type | Table | Count |",
    "| --- | --- | --- |",
    ...Object.entries(inventory).map(
      ([type, d]) =>
        `| ${type} | ${d.table} | ${scriptCounts[type] ?? "n/a"} |`,
    ),
    "",
  ];
  if (lint) {
    md.push(
      `## Lint findings for \`${lint.table}\``,
      "",
      `${lint.scriptCount} scripts scanned · ${lint.findingCount} findings ` +
        `(error ${lint.bySeverity.error} · warn ${lint.bySeverity.warn} · info ${lint.bySeverity.info}).`,
      "",
    );
    const top = lint.results.slice(0, 20);
    if (top.length > 0) {
      md.push(
        "| Script | Field | Findings | Top rule |",
        "| --- | --- | --- | --- |",
      );
      for (const r of top) {
        md.push(
          `| ${r.name.replaceAll("|", "\\|")} | ${r.field} | ${r.findings.length} | ${r.findings[0]?.rule ?? ""} |`,
        );
      }
      md.push("");
    } else {
      md.push("No findings. 🎉", "");
    }
  }

  if (security) {
    md.push("## Security — ACL scan", "");
    if (!security.available) {
      md.push(`_Unavailable:_ ${security.unavailableReason}`, "");
    } else {
      md.push(
        `${security.aclCount} active ACLs scanned · ${security.findings.length} findings ` +
          `(error ${security.bySeverity.error} · warn ${security.bySeverity.warn} · info ${security.bySeverity.info}).`,
        "",
      );
      if (security.truncated) {
        md.push(
          `_Partial:_ the ACL read stopped early (${security.truncatedReason ?? "cap"}) — findings cover only the ACLs read.`,
          "",
        );
      }
    }
    if (security.checks) {
      md.push(
        "| Check | Status | Scanned | Findings |",
        "| --- | --- | --- | --- |",
      );
      for (const [name, c] of Object.entries(security.checks)) {
        const status = c.available
          ? c.truncated
            ? "partial"
            : "ok"
          : `unavailable — ${(c.unavailableReason ?? "").replaceAll("|", "\\|")}`;
        md.push(`| ${name} | ${status} | ${c.scanned} | ${c.findings} |`);
      }
      md.push("");
    }
    const top = security.findings
      .filter((f) => f.severity !== "info")
      .slice(0, 20);
    if (top.length > 0) {
      md.push(
        "| Item | Operation | Rule | Severity |",
        "| --- | --- | --- | --- |",
      );
      for (const f of top) {
        md.push(
          `| ${f.name.replaceAll("|", "\\|")} | ${f.operation} | ${f.rule} | ${f.severity} |`,
        );
      }
      md.push("");
    }
  }

  // N-13: hardening compliance from the rule table (one sys_properties read).
  const hardening = await checkHardening();
  md.push("## Security — hardening", "", ...renderHardening(hardening));

  let artifacts: ArtifactLint | undefined;
  const artifactPrints: string[] = [];
  if (opts.extended) {
    try {
      artifacts = await lintArtifacts({
        limit: opts.limit,
        onLint: (l) =>
          artifactPrints.push(
            ...lintFingerprints(l.type, `${l.sys_id}:${l.field}`, l.findings),
          ),
      });
    } catch (e) {
      warnings.push(
        `artifact lint: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (artifacts) {
    md.push(
      "## Artefact lint (registry sweep)",
      "",
      `${artifacts.scanned} artefacts scanned (the ${artifacts.limitPerType} most recently updated per type) · ` +
        `${artifacts.findingCount} findings (error ${artifacts.bySeverity.error} · warn ${artifacts.bySeverity.warn} · info ${artifacts.bySeverity.info}).`,
      "",
      "| Type | Table | Scanned | Findings |",
      "| --- | --- | --- | --- |",
      ...Object.entries(artifacts.types).map(
        ([type, t]) =>
          `| ${type} | ${t.table} | ${t.scanned}${t.capped ? "+" : ""} | ${t.findingCount} |`,
      ),
      "",
    );
    const top = artifacts.results.slice(0, 20);
    if (top.length > 0) {
      md.push(
        "| Type | Script | Field | Findings | Top rule |",
        "| --- | --- | --- | --- | --- |",
      );
      for (const r of top) {
        md.push(
          `| ${r.type} | ${r.name.replaceAll("|", "\\|")} | ${r.field} | ${r.findings.length} | ${r.findings[0]?.rule ?? ""} |`,
        );
      }
      md.push("");
    }
    for (const w of artifacts.warnings) warnings.push(`artifact lint: ${w}`);
  }

  let domains: DomainAnalysis | undefined;
  if (opts.domains) {
    try {
      domains = await analyseDomains({ limit: opts.limit });
    } catch (e) {
      warnings.push(
        `domain analysers: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (domains) {
    const cell = (v: string) => v.replaceAll("|", "\\|").replaceAll("\n", " ");
    md.push(
      "## Domain analysers (flows, portal, UI Builder, legacy workflows)",
      "",
      `${domains.findingCount} findings (error ${domains.bySeverity.error} · warn ${domains.bySeverity.warn} · info ${domains.bySeverity.info}); up to ${domains.limit} candidates per rule.`,
      "",
      "| Rule | Available | Scanned | Findings |",
      "| --- | --- | --- | --- |",
      ...Object.entries(domains.rules).map(
        ([rule, r]) =>
          `| ${rule} | ${r.available ? "yes" : `no — ${cell(r.unavailableReason ?? "")}`} | ${r.scanned}${r.truncated ? "+" : ""} | ${r.findings} |`,
      ),
      "",
    );
    const top = domains.findings.slice(0, 30);
    if (top.length > 0) {
      md.push(
        "| Severity | Rule | Artefact | Message |",
        "| --- | --- | --- | --- |",
      );
      for (const f of top) {
        md.push(
          `| ${f.severity} | ${f.rule} | ${f.ref.artifactType} ${cell(f.ref.name ?? f.ref.sys_id)} | ${cell(f.message)} |`,
        );
      }
      md.push("");
    }
    if (domains.caveats.length > 0) {
      md.push(...domains.caveats.map((c) => `- ${c}`), "");
    }
    for (const w of domains.warnings) warnings.push(`domain analysers: ${w}`);
  }

  // N-3: the platform's Instance Scan findings next to ours (read-only).
  const linted = new Set(
    [...(lint?.results ?? []), ...(artifacts?.results ?? [])]
      .filter((r) => r.findings.length > 0)
      .map((r) => r.sys_id),
  );
  const instanceScan = await readInstanceScan(linted);
  md.push("## Instance Scan", "", ...renderInstanceScan(instanceScan));

  // S-12: new / fixed findings since the stored baseline.
  const sections: Partial<Record<BaselineSection, SectionFacts>> = {};
  if (lint) {
    const unreadable = new Set<string>();
    for (const w of lint.warnings) {
      const m = /^(\S+) (\S+):/.exec(w);
      if (m) unreadable.add(`${m[1]}:${m[2]}`);
    }
    sections.lint = {
      fingerprints: lint.results.flatMap((r) =>
        lintFingerprints(`${r.type}:${r.sys_id}`, r.field, r.findings),
      ),
      partialUnits: unreadable,
    };
  }
  if (artifacts) {
    const swept = artifacts.types;
    const partialUnits = new Set(
      Object.keys({ ...SCRIPT_TYPES, ...OPT_IN_SCRIPT_TYPES }).filter(
        (t) => !swept[t] || swept[t].capped,
      ),
    );
    sections.artifacts = { fingerprints: artifactPrints, partialUnits };
  }
  if (security) sections.security = securityFacts(security);
  if (domains) sections.domains = domainFacts(domains);
  let delta: CodeHealthDelta | undefined;
  try {
    delta = await applyBaseline({
      profile,
      scopeKey: isTable ? `table:${scope!.trim()}` : "instance",
      takenAt: generatedAt,
      sections,
      update: opts.updateBaseline,
    });
    md.push(...deltaMarkdown(delta));
  } catch (e) {
    warnings.push(`baseline: ${e instanceof Error ? e.message : String(e)}`);
  }

  let reportFile: string | undefined;
  try {
    reportFile = `${profile}/code-health.md`;
    await docsWriteRaw(reportFile, md.join("\n"), [".md", ".json"], {
      generator: "servicenow_check_code_health",
      kind: "code-health",
      profile,
      generatedAt,
      // The timestamp is left out, so an unchanged instance is `unchanged`.
      source: {
        scope: scope?.trim() ?? "",
        scriptCounts,
        lint,
        security,
        hardening,
        instanceScan,
        ...(artifacts ? { artifacts } : {}),
        ...(domains ? { domains } : {}),
        // The report renders the delta, so a moved delta is a new report.
        ...(delta ? { delta: { ...delta, updated: undefined } } : {}),
        warnings,
      },
      legacy: /^# Code health — /,
    });
  } catch (e) {
    warnings.push(`report: ${e instanceof Error ? e.message : String(e)}`);
    reportFile = undefined;
  }

  return {
    scope: isTable ? scope!.trim() : "instance",
    profile,
    generatedAt,
    reportFile,
    scriptCounts,
    lint,
    ...(artifacts ? { artifacts } : {}),
    ...(domains ? { domains } : {}),
    security,
    hardening: {
      rulesVersion: hardening.rulesVersion,
      available: hardening.available,
      ...(hardening.unavailableReason
        ? { unavailableReason: hardening.unavailableReason }
        : {}),
      counts: hardening.counts,
      failed: hardening.failed,
      failing: hardening.results.filter(
        (r) =>
          r.status === "fail" ||
          (r.status === "not_set" && r.defaultPasses === false),
      ),
    },
    instanceScan,
    ...(delta ? { delta } : {}),
    warnings,
  };
}
