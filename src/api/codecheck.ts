import { getScript, tableLogic, SCRIPT_TYPES } from "./scripts.js";
import { queryTable } from "./table.js";
import { aggregate } from "./aggregate.js";
import { docsWriteRaw } from "./docs.js";
import { snString } from "./shared.js";
import { activeProfile } from "../core/config.js";
import { ServiceNowError } from "../core/errors.js";

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

/** Server vs client scope for a script type. */
function scopeForType(type: string): Scope {
  return type === "client_script" || type === "ui_policy" ? "client" : "server";
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
  const scope = scopeForType(type);
  const name = snString(record[descriptor.nameField]);
  const results: ScriptLint[] = [];
  for (const field of descriptor.scriptFields) {
    const src = snString(record[field]);
    if (!src) continue;
    results.push({
      type,
      sys_id: sysId,
      name,
      field,
      findings: lintSource(src, scope),
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
  const entry = Array.isArray(result) ? result[0] : result;
  if (typeof entry !== "object" || entry === null) return 0;
  const stats = (entry as Record<string, unknown>).stats;
  if (typeof stats !== "object" || stats === null) return 0;
  const n = Number(snString((stats as Record<string, unknown>).count));
  return Number.isFinite(n) ? n : 0;
}

// --- DF-1: security scan over the access-control layer (sys_security_acl) -----

export interface SecurityFinding {
  sys_id: string;
  name: string;
  operation: string;
  rule: string;
  severity: Severity;
  hint: string;
}

export interface SecurityScan {
  /** False when sys_security_acl is unreadable for the connected user (DF-0). */
  available: boolean;
  unavailableReason?: string;
  aclCount: number;
  findings: SecurityFinding[];
  bySeverity: Record<Severity, number>;
}

/** Rules over an ACL's evaluation script — where a weak check becomes a hole. */
const ACL_SCRIPT_RULES: {
  id: string;
  severity: Severity;
  re: RegExp;
  hint: string;
}[] = [
  {
    id: "eval-in-acl",
    severity: "error",
    re: /\beval\s*\(/,
    hint: "eval() in an ACL evaluation script is a security risk — an attacker-influenced value could flip the access decision.",
  },
  {
    id: "gr-write-in-acl",
    severity: "warn",
    re: /\.(update|insertWithReferences|deleteRecord)\s*\(/,
    hint: "An ACL script that writes records has side effects during an access check — ACLs must be read-only decisions.",
  },
  {
    id: "getuser-in-acl",
    severity: "info",
    re: /gs\.getUser(ID|Name)?\s*\(/,
    hint: "gs.getUser* inside an ACL script — verify the identity logic genuinely belongs in the access check.",
  },
];

/**
 * DF-1 — scan the active ACLs for weak access controls. Reads `sys_security_acl`
 * (admin-restricted, so the read is gated: a 401/403 degrades to
 * `available:false` with the role needed, never a silently empty "all clear").
 * Flags eval/side-effects in ACL scripts and ACLs that gate on roles alone.
 */
export async function securityScan(limit = 500): Promise<SecurityScan> {
  const findings: SecurityFinding[] = [];
  const bySeverity: Record<Severity, number> = { error: 0, warn: 0, info: 0 };

  let records;
  try {
    const res = await queryTable({
      table: "sys_security_acl",
      query: "active=true^ORDERBYname",
      fields: ["sys_id", "name", "operation", "script", "condition"],
      limit,
    });
    records = res.records;
  } catch (error) {
    if (
      error instanceof ServiceNowError &&
      (error.status === 403 || error.status === 401)
    ) {
      return {
        available: false,
        unavailableReason:
          "sys_security_acl is not readable for this user (needs the security_admin or admin role). Run servicenow_check_capabilities.",
        aclCount: 0,
        findings: [],
        bySeverity,
      };
    }
    throw error;
  }

  for (const r of records) {
    const sys_id = snString(r.sys_id);
    const name = snString(r.name);
    const operation = snString(r.operation);
    const script = snString(r.script);
    const condition = snString(r.condition);

    for (const rule of ACL_SCRIPT_RULES) {
      if (script && rule.re.test(script)) {
        findings.push({
          sys_id,
          name,
          operation,
          rule: rule.id,
          severity: rule.severity,
          hint: rule.hint,
        });
        bySeverity[rule.severity]++;
      }
    }

    // An active ACL with neither a condition nor a script grants on its roles
    // alone — and an ACL with an empty role list is open to everyone.
    if (!script.trim() && !condition.trim()) {
      findings.push({
        sys_id,
        name,
        operation,
        rule: "acl-roles-only",
        severity: "info",
        hint: "Active ACL with no condition and no script — access depends entirely on its assigned roles; confirm a role is set (an empty role list grants everyone).",
      });
      bySeverity.info++;
    }
  }

  return { available: true, aclCount: records.length, findings, bySeverity };
}

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
      const stats = await aggregate({ table: descriptor.table, count: true });
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
      const topAcl = security.findings
        .filter((f) => f.severity !== "info")
        .slice(0, 20);
      if (topAcl.length > 0) {
        md.push(
          "| ACL | Operation | Rule | Severity |",
          "| --- | --- | --- | --- |",
        );
        for (const f of topAcl) {
          md.push(
            `| ${f.name.replaceAll("|", "\\|")} | ${f.operation} | ${f.rule} | ${f.severity} |`,
          );
        }
        md.push("");
      }
    }
  }

  let reportFile: string | undefined;
  try {
    reportFile = `${profile}/code-health.md`;
    await docsWriteRaw(reportFile, md.join("\n"), [".md", ".json"]);
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
