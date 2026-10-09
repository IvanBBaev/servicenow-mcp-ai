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
import {
  calleeOf,
  ecmaModeForScope,
  lineOf,
  parseScript,
  walk,
  type AstNode,
  type EcmaMode,
} from "./script-ast.js";
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

/**
 * Local code analysis (Phase 8, package `codecheck`). Pulls script source
 * through the existing api/scripts.ts layer and runs deterministic rules in
 * pure TypeScript — zero network beyond fetching the code. S-12: the rules
 * run over an acorn AST (./script-ast.ts), so comments and string contents
 * no longer match; a source that does not parse falls back to the line-regex
 * rules. Each finding carries a rule id, severity, line, snippet and a fix
 * hint.
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
  // P-18: Service Portal client rules (widget client controllers, link
  // functions, angular providers).
  {
    id: "sce-trust-as-html",
    severity: "warn",
    re: /\$sce\.trustAs(?:Html)?\s*\(/,
    hint: "$sce.trustAsHtml marks the value as safe HTML and skips sanitising — never pass user or record data; bind it with ng-bind-html and let $sanitize clean it.",
    scope: "client",
  },
  {
    id: "sanitize-bypass",
    severity: "error",
    re: /\$sceProvider\.enabled\s*\(\s*false\s*\)/,
    hint: "$sceProvider.enabled(false) turns off Strict Contextual Escaping for the whole app — remove it.",
    scope: "client",
  },
];

/**
 * P-18: server-side values taken from the page URL (`$sp.getParameter`) are
 * attacker-controlled. Assigned names are tracked through the script; using
 * one (or the call itself) as an encoded query, a table name or evaluated
 * code is flagged. `addQuery(field, value)` and `get(sys_id)` escape the
 * value and are not.
 */
const spParamHint = (sink: string): string =>
  `A URL parameter ($sp.getParameter) reaches ${sink.replace(/\s+/g, " ")} unvalidated — check it against an allow-list or use addQuery(field, value).`;
const QUERY_IN_LOOP_HINT =
  "A GlideRecord query inside a loop is an N+1 pattern — query once outside the loop or use GlideAggregate.";
const UNBOUNDED_QUERY_HINT =
  "GlideRecord.query() with no addQuery/addEncodedQuery/setLimit reads the whole table — add a filter.";

const SP_PARAM_ASSIGN =
  /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*\$sp\.getParameter\s*\(/g;
const SP_PARAM_SINKS =
  /(addEncodedQuery|new\s+GlideRecord(?:Secure)?|new\s+GlideAggregate|gs\.eval|GlideEvaluator\.evaluateString)\s*\(([^)]*)\)/g;

function spParamFindings(lines: string[]): Finding[] {
  const tainted = new Set<string>();
  for (const line of lines) {
    for (const [, name] of line.matchAll(SP_PARAM_ASSIGN)) {
      if (name) tainted.add(name);
    }
  }
  const findings: Finding[] = [];
  lines.forEach((line, i) => {
    for (const [, sink = "", arg = ""] of line.matchAll(SP_PARAM_SINKS)) {
      const fromParam =
        /\$sp\.getParameter/.test(arg) ||
        [...tainted].some((n) =>
          new RegExp(`(^|[^\\w$.])${n.replace(/\$/g, "\\$")}([^\\w$]|$)`).test(
            arg,
          ),
        );
      if (!fromParam) continue;
      findings.push({
        rule: "sp-param-unvalidated",
        severity: "warn",
        line: i + 1,
        snippet: line.trim().slice(0, 200),
        hint: spParamHint(sink),
      });
    }
  });
  return findings;
}

const GLIDE_QUERY = /new\s+GlideRecord|\.query\s*\(/;
const QUERY_BOUND =
  /addQuery|addEncodedQuery|addActiveQuery|setLimit|\.get\s*\(/;

/**
 * The pre-S-12 line-regex rule set — the fallback when a source does not
 * parse (Jelly or `${}` fragments, newer syntax, a real syntax error).
 */
export function lintSourceRegex(
  source: string,
  scope: Scope = "server",
): Finding[] {
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
        hint: QUERY_IN_LOOP_HINT,
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
          hint: UNBOUNDED_QUERY_HINT,
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

  if (scope === "server") findings.push(...spParamFindings(lines));

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

  return sortFindings(findings);
}

function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort(
    (a, b) => a.line - b.line || a.rule.localeCompare(b.rule),
  );
}

// --- S-12: AST rules ---------------------------------------------------------

/** Which engine produced a lint result. */
export type LintEngine = "ast" | "regex";

export interface LintOptions {
  /**
   * ES level to parse at: `es5` for global-scope server scripts, `es2021` for
   * scoped apps and client fields. Omitted: `es2021` (accepts every ES5
   * script, so an unknown scope never turns into a finding).
   */
  ecma?: EcmaMode;
}

export interface SourceLint {
  engine: LintEngine;
  /** ES level the source was parsed at (`ast` only). */
  ecma?: EcmaMode;
  /** Why the parser gave up and the regex rules ran instead (`regex` only). */
  parseError?: string;
  findings: Finding[];
}

const RULE_BY_ID = new Map(LINE_RULES.map((r) => [r.id, r]));

const ES5_SYNTAX_HINT =
  "ES2021 syntax (let/const, arrow functions, template literals, classes…) in a global-scope server script, which runs as ES5 — rewrite it in ES5 or move the script into a scoped app with ES2021 enabled.";

const INSTANCE_URL = /https?:\/\/[a-z0-9-]+\.service-now\.com/i;
const GLIDE_RECORD_CTORS = new Set(["GlideRecord", "GlideRecordSecure"]);
const QUERY_BOUND_METHODS = new Set([
  "addQuery",
  "addEncodedQuery",
  "addActiveQuery",
  "addInactiveQuery",
  "addNullQuery",
  "addNotNullQuery",
  "addJoinQuery",
  "setLimit",
  "get",
]);
const SP_SINK_CTORS = new Set([
  "GlideRecord",
  "GlideRecordSecure",
  "GlideAggregate",
]);
const LOOPS = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
]);
const FUNCTIONS = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** True when `node` sits inside the body (not the header) of a loop. */
function inLoopBody(node: AstNode, ancestors: readonly AstNode[]): boolean {
  for (let i = 0; i < ancestors.length; i++) {
    const a = ancestors[i]!;
    if (!LOOPS.has(a.type)) continue;
    const child = ancestors[i + 1] ?? node;
    if (child === a.body) return true;
  }
  return false;
}

/** Nearest enclosing function (or the program) of a node. */
function enclosingFunction(ancestors: readonly AstNode[]): AstNode | undefined {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (FUNCTIONS.has(ancestors[i]!.type)) return ancestors[i];
  }
  return ancestors[0];
}

const isSpGetParameter = (node: AstNode, source: string): boolean => {
  if (node.type !== "CallExpression") return false;
  const c = calleeOf(node, source);
  return c.object === "$sp" && c.name === "getParameter";
};

/**
 * True when an expression reads a tainted name or calls $sp.getParameter.
 * Non-computed property names (`x.p`) and object keys are not reads.
 */
function readsTaint(
  expr: AstNode,
  tainted: Set<string>,
  source: string,
): boolean {
  let hit = false;
  walk(expr, (node, ancestors) => {
    if (hit) return;
    if (isSpGetParameter(node, source)) {
      hit = true;
      return;
    }
    if (node.type !== "Identifier" || !tainted.has(node.name as string)) {
      return;
    }
    const parent = ancestors[ancestors.length - 1];
    if (
      parent?.type === "MemberExpression" &&
      parent.property === node &&
      !parent.computed
    ) {
      return;
    }
    if (
      parent?.type === "Property" &&
      parent.key === node &&
      !parent.computed
    ) {
      return;
    }
    hit = true;
  });
  return hit;
}

/** The AST rule set over one parsed source; mirrors the regex rule ids. */
function lintAst(
  ast: AstNode,
  source: string,
  scope: Scope,
  lines: string[],
): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const snippetAt = (line: number) =>
    (lines[line - 1] ?? "").trim().slice(0, 200);
  const add = (
    rule: string,
    line: number,
    severity?: Severity,
    hint?: string,
  ) => {
    const def = RULE_BY_ID.get(rule);
    if (def?.scope && def.scope !== scope) return;
    const h = hint ?? def?.hint ?? "";
    const key = `${rule}\u0000${line}\u0000${h}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      rule,
      severity: severity ?? def?.severity ?? "warn",
      line,
      snippet: snippetAt(line),
      hint: h,
    });
  };

  // Member calls by receiver, for the unbounded-query rule.
  const memberCalls: {
    objectText: string;
    name: string;
    start: number;
    fn: AstNode | undefined;
  }[] = [];
  const emptyQueries: {
    node: AstNode;
    objectText: string;
    fn: AstNode | undefined;
  }[] = [];
  // Taint sources and flows for sp-param-unvalidated.
  const assigns: { name: string; value: AstNode }[] = [];
  const sinks: { label: string; args: AstNode[]; line: number }[] = [];

  walk(ast, (node, ancestors) => {
    switch (node.type) {
      case "Literal": {
        if (typeof node.value !== "string") break;
        if (isSysId(node.value)) {
          add("hardcoded-sys-id", lineOf(node));
        }
        if (INSTANCE_URL.test(node.value)) {
          add("hardcoded-instance-url", lineOf(node));
        }
        break;
      }
      case "TemplateLiteral": {
        const quasis = (node.quasis as AstNode[] | undefined) ?? [];
        const exprs = (node.expressions as AstNode[] | undefined) ?? [];
        const text = quasis.map((q) => {
          const v = q.value as { cooked?: string; raw?: string } | undefined;
          return v?.cooked ?? v?.raw ?? "";
        });
        if (exprs.length === 0 && isSysId(text[0] ?? "")) {
          add("hardcoded-sys-id", lineOf(node));
        }
        if (text.some((t) => INSTANCE_URL.test(t))) {
          add("hardcoded-instance-url", lineOf(node));
        }
        break;
      }
      case "VariableDeclarator": {
        const id = node.id as AstNode | undefined;
        const init = node.init as AstNode | undefined;
        if (id?.type === "Identifier" && init) {
          assigns.push({ name: id.name as string, value: init });
        }
        break;
      }
      case "AssignmentExpression": {
        const left = node.left as AstNode | undefined;
        if (left?.type === "Identifier") {
          assigns.push({
            name: left.name as string,
            value: node.right as AstNode,
          });
        }
        break;
      }
      case "NewExpression": {
        const { name, object } = calleeOf(node, source);
        const line = lineOf(node);
        const args = (node.arguments as AstNode[] | undefined) ?? [];
        if (!object && name && GLIDE_RECORD_CTORS.has(name)) {
          add("gr-on-client", line);
          if (inLoopBody(node, ancestors)) {
            add("query-in-loop", line, "warn", QUERY_IN_LOOP_HINT);
          }
        }
        if (!object && name && SP_SINK_CTORS.has(name)) {
          sinks.push({ label: `new ${name}`, args, line });
        }
        break;
      }
      case "CallExpression": {
        const c = calleeOf(node, source);
        const line = lineOf(node);
        const args = (node.arguments as AstNode[] | undefined) ?? [];
        const first = args[0];
        const isFalse = first?.type === "Literal" && first.value === false;
        if (c.name === "eval") add("eval-usage", line);
        if (c.object === "gs" && c.name === "sleep") add("gs-sleep", line);
        if (c.object === "gs" && c.name === "log") {
          add("gs-log-deprecated", line);
        }
        if (c.name === "setWorkflow" && isFalse) {
          add("set-workflow-false", line);
        }
        if (c.object === "current" && c.name === "update") {
          add("current-update-in-br", line);
        }
        if (c.name === "getReference" && args.length === 1 && c.objectText) {
          add("sync-get-reference", line);
        }
        if (
          c.object === "$sce" &&
          (c.name === "trustAs" || c.name === "trustAsHtml")
        ) {
          add("sce-trust-as-html", line);
        }
        if (c.object === "$sceProvider" && c.name === "enabled" && isFalse) {
          add("sanitize-bypass", line);
        }
        if (c.objectText && c.name) {
          const fn = enclosingFunction(ancestors);
          memberCalls.push({
            objectText: c.objectText,
            name: c.name,
            start: node.start,
            fn,
          });
          if (c.name === "query") {
            if (inLoopBody(node, ancestors)) {
              add("query-in-loop", line, "warn", QUERY_IN_LOOP_HINT);
            }
            if (args.length === 0) {
              emptyQueries.push({ node, objectText: c.objectText, fn });
            }
          }
        }
        if (c.objectText && c.name === "addEncodedQuery") {
          sinks.push({ label: "addEncodedQuery", args, line });
        }
        if (c.object === "gs" && c.name === "eval") {
          sinks.push({ label: "gs.eval", args, line });
        }
        if (c.object === "GlideEvaluator" && c.name === "evaluateString") {
          sinks.push({ label: "GlideEvaluator.evaluateString", args, line });
        }
        break;
      }
    }
  });

  // gr-unbounded-query: an empty .query() on a receiver that saw no filter,
  // limit or get() earlier in the same function.
  for (const q of emptyQueries) {
    const bounded = memberCalls.some(
      (m) =>
        m.objectText === q.objectText &&
        m.fn === q.fn &&
        m.start < q.node.start &&
        QUERY_BOUND_METHODS.has(m.name),
    );
    if (!bounded) {
      add("gr-unbounded-query", lineOf(q.node), "warn", UNBOUNDED_QUERY_HINT);
    }
  }

  // sp-param-unvalidated: names assigned from $sp.getParameter, or from an
  // expression that reads one, reaching an encoded query / table / eval sink.
  if (scope === "server") {
    const tainted = new Set<string>();
    for (let changed = true, guard = 0; changed && guard < 20; guard++) {
      changed = false;
      for (const a of assigns) {
        if (tainted.has(a.name)) continue;
        if (readsTaint(a.value, tainted, source)) {
          tainted.add(a.name);
          changed = true;
        }
      }
    }
    for (const s of sinks) {
      if (s.args.some((arg) => readsTaint(arg, tainted, source))) {
        add("sp-param-unvalidated", s.line, "warn", spParamHint(s.label));
      }
    }
  }

  return findings;
}

/**
 * S-12 — lint one script source, reporting the engine used. The source is
 * parsed with acorn and the AST rules run, so comments and string contents
 * no longer match code rules. A global-scope server script (`ecma: "es5"`)
 * that only parses as ES2021 gets an `es2021-syntax-in-es5` finding and is
 * then linted from the ES2021 tree. A source that does not parse at all falls
 * back to the line-regex rules (`engine: "regex"`, `parseError`). Never throws.
 */
export function lintSourceDetailed(
  source: string,
  scope: Scope = "server",
  opts: LintOptions = {},
): SourceLint {
  if (typeof source !== "string" || source.trim() === "") {
    return { engine: "ast", findings: [] };
  }
  const mode: EcmaMode =
    scope === "client" ? "es2021" : (opts.ecma ?? "es2021");
  const fallback = (parseError: string): SourceLint => ({
    engine: "regex",
    parseError: parseError.slice(0, 200),
    findings: lintSourceRegex(source, scope),
  });
  try {
    let parsed = parseScript(source, mode);
    const extra: Finding[] = [];
    if (!parsed.ok && mode === "es5") {
      const modern = parseScript(source, "es2021");
      if (modern.ok) {
        const line = parsed.line ?? 0;
        extra.push({
          rule: "es2021-syntax-in-es5",
          severity: "warn",
          line,
          snippet: line
            ? (source.split("\n")[line - 1] ?? "").trim().slice(0, 200)
            : parsed.error.slice(0, 160),
          hint: ES5_SYNTAX_HINT,
        });
        parsed = modern;
      }
    }
    if (!parsed.ok) return fallback(parsed.error);
    const findings = lintAst(parsed.ast, source, scope, source.split("\n"));
    return {
      engine: "ast",
      ecma: parsed.mode,
      findings: sortFindings([...extra, ...findings]),
    };
  } catch (e) {
    return fallback(e instanceof Error ? e.message : String(e));
  }
}

/** Run the deterministic rule set over a single script source. */
export function lintSource(
  source: string,
  scope: Scope = "server",
  opts: LintOptions = {},
): Finding[] {
  return lintSourceDetailed(source, scope, opts).findings;
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
