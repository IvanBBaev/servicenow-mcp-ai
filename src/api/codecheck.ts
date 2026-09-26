import {
  getScript,
  tableLogic,
  scriptArtifact,
  SCRIPT_TYPES,
} from "./scripts.js";
import { aggregate } from "./aggregate.js";
import { docsWriteRaw } from "./docs.js";
import { snString } from "./shared.js";
import { activeProfile } from "../core/config.js";
import { ServiceNowError } from "../core/errors.js";
import { securityScan, type SecurityScan } from "./security.js";

/**
 * Local code analysis (Phase 8, package `codecheck`). Pulls script source
 * through the existing api/scripts.ts layer and runs deterministic rules in
 * pure TypeScript — zero network beyond fetching the code, no new dependency.
 * Each finding carries a rule id, severity, line, snippet and a fix hint.
 */

export type Severity = "error" | "warn" | "info";
export type Scope = "server" | "client";

export interface Finding {
  rule: string;
  severity: Severity;
  line: number;
  snippet: string;
  hint: string;
}

interface LineRule {
  id: string;
  severity: Severity;
  re: RegExp;
  hint: string;
  /** Only flag in this scope; omitted = any. */
  scope?: Scope;
}

/** Per-line regex rules (the bulk of the rule set). */
const LINE_RULES: LineRule[] = [
  {
    id: "hardcoded-sys-id",
    severity: "warn",
    re: /['"][0-9a-f]{32}['"]/,
    hint: "Hard-coded sys_id — look it up by a stable key or read it from a system property.",
  },
  {
    id: "hardcoded-instance-url",
    severity: "warn",
    re: /https?:\/\/[a-z0-9-]+\.service-now\.com/i,
    hint: "Hard-coded instance URL — use gs.getProperty('glide.servlet.uri') or a property.",
  },
  {
    id: "eval-usage",
    severity: "error",
    re: /\beval\s*\(/,
    hint: "Avoid eval() — it is a security and performance risk; parse JSON with JSON.parse.",
  },
  {
    id: "gs-sleep",
    severity: "warn",
    re: /\bgs\.sleep\s*\(/,
    hint: "gs.sleep blocks the worker thread — avoid it in business logic.",
  },
  {
    id: "gs-log-deprecated",
    severity: "info",
    re: /\bgs\.log\s*\(/,
    hint: "gs.log is legacy — prefer gs.info / gs.warn / gs.error (scoped-app friendly).",
  },
  {
    id: "set-workflow-false",
    severity: "warn",
    re: /setWorkflow\s*\(\s*false\s*\)/,
    hint: "setWorkflow(false) skips business rules and engines — confirm that is intended.",
  },
  {
    id: "current-update-in-br",
    severity: "warn",
    re: /\bcurrent\.update\s*\(/,
    hint: "current.update() in a business rule is usually wrong — set fields in 'before' (no update needed) or guard against recursion.",
    scope: "server",
  },
  {
    id: "gr-on-client",
    severity: "error",
    re: /new\s+GlideRecord\s*\(/,
    hint: "Synchronous GlideRecord on the client blocks the browser — use GlideAjax or a REST call.",
    scope: "client",
  },
  {
    id: "sync-get-reference",
    severity: "warn",
    re: /\.getReference\s*\(\s*[^,)]+\)/,
    hint: "getReference without a callback is a synchronous server round-trip — pass a callback.",
    scope: "client",
  },
];

const GLIDE_QUERY = /new\s+GlideRecord|\.query\s*\(/;
const QUERY_BOUND =
  /addQuery|addEncodedQuery|addActiveQuery|setLimit|\.get\s*\(/;

/** Run the deterministic rule set over a single script source. */
export function lintSource(source: string, scope: Scope = "server"): Finding[] {
  if (typeof source !== "string" || source.trim() === "") return [];
  const findings: Finding[] = [];
  const lines = source.split("\n");

  // Brace-tracked loop detection for query-in-loop.
  let depth = 0;
  const loopBodyDepths = new Set<number>();
  let pendingLoop = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const snippet = line.trim().slice(0, 200);

    for (const rule of LINE_RULES) {
      if (rule.scope && rule.scope !== scope) continue;
      if (rule.re.test(line)) {
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          line: lineNo,
          snippet,
          hint: rule.hint,
        });
      }
    }

    // query-in-loop: a GlideRecord query while inside a for/while body.
    if (loopBodyDepths.size > 0 && GLIDE_QUERY.test(line)) {
      findings.push({
        rule: "query-in-loop",
        severity: "warn",
        line: lineNo,
        snippet,
        hint: "A GlideRecord query inside a loop is an N+1 pattern — query once outside the loop or use GlideAggregate.",
      });
    }

    // gr-unbounded-query: a .query() with no narrowing in the prior 12 lines.
    if (/\.query\s*\(\s*\)/.test(line)) {
      const before = lines.slice(Math.max(0, i - 12), i + 1).join("\n");
      if (!QUERY_BOUND.test(before)) {
        findings.push({
          rule: "gr-unbounded-query",
          severity: "warn",
          line: lineNo,
          snippet,
          hint: "GlideRecord.query() with no addQuery/addEncodedQuery/setLimit reads the whole table — add a filter.",
        });
      }
    }

    // Maintain brace depth + loop-body tracking.
    if (/\b(for|while)\s*\(/.test(line)) pendingLoop = true;
    for (const ch of line) {
      if (ch === "{") {
        depth++;
        if (pendingLoop) {
          loopBodyDepths.add(depth);
          pendingLoop = false;
        }
      } else if (ch === "}") {
        loopBodyDepths.delete(depth);
        if (depth > 0) depth--;
      }
    }
  }

  // Cheap syntax probe for server-side ES5 (SN globals are undefined here, so
  // only true parse errors surface).
  if (scope === "server") {
    try {
      // A syntax-only probe of fetched script source — parsed, never executed.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function(source);
    } catch (e) {
      findings.push({
        rule: "syntax-error",
        severity: "error",
        line: 0,
        snippet: e instanceof Error ? e.message.slice(0, 160) : "parse error",
        hint: "The script does not parse as a function body — check for a syntax error.",
      });
    }
  }

  return findings.sort(
    (a, b) => a.line - b.line || a.rule.localeCompare(b.rule),
  );
}

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
}

/** FT-5 — lint one script artefact (all its source fields). */
export async function lintScript(
  type: string,
  sysId: string,
): Promise<{ type: string; sys_id: string; results: ScriptLint[] }> {
  const descriptor = SCRIPT_TYPES[type];
  if (!descriptor) {
    throw new ServiceNowError(
      `Unknown script type '${type}'. Valid: ${Object.keys(SCRIPT_TYPES).join(", ")}.`,
      400,
    );
  }
  const { record } = await getScript(type, sysId);
  const { clientFields, markupFields } = scriptArtifact(type);
  const name = snString(record[descriptor.nameField]);
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
      findings: lintSource(src, scopeForField(clientFields, field)),
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

export {
  securityScan,
  SECURITY_SCAN_MAX_ROWS,
  type SecurityScan,
  type SecurityFinding,
  type SecurityCheck,
  type SecurityCheckName,
  type SecurityFindingKind,
} from "./security.js";

export interface CodeHealth {
  scope: string;
  profile: string;
  generatedAt: string;
  reportFile?: string;
  scriptCounts: Record<string, number>;
  lint?: TableLint;
  security?: SecurityScan;
  warnings: string[];
}

/**
 * FT-6 — an aggregate code-health picture. For a table it runs lintTable and
 * summarises; instance-wide it counts scripts by type. Writes a Markdown report
 * into the profile's docs folder (alongside the MI-6 snapshot).
 */
export async function codeHealth(scope?: string): Promise<CodeHealth> {
  const profile = activeProfile();
  const generatedAt = new Date().toISOString();
  const warnings: string[] = [];
  const scriptCounts: Record<string, number> = {};

  for (const [type, descriptor] of Object.entries(SCRIPT_TYPES)) {
    try {
      const { baseQuery } = scriptArtifact(type);
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
    ...Object.entries(SCRIPT_TYPES).map(
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

  let reportFile: string | undefined;
  try {
    reportFile = `${profile}/code-health.md`;
    await docsWriteRaw(reportFile, md.join("\n"), [".md", ".json"], {
      generator: "servicenow_code_health",
      kind: "code-health",
      profile,
      generatedAt,
      // The timestamp is left out, so an unchanged instance is `unchanged`.
      source: {
        scope: scope?.trim() ?? "",
        scriptCounts,
        lint,
        security,
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
    security,
    warnings,
  };
}
