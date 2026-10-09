import {
  calleeOf,
  lineOf,
  parseScript,
  walk,
  type AstNode,
  type EcmaMode,
} from "./script-ast.js";
import { isSysId } from "../core/sys-id.js";

/**
 * The codecheck source rules: the line-regex rules and the S-12 AST rules
 * over one script source. Pure — no network.
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

export function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort(
    (a, b) => a.line - b.line || a.rule.localeCompare(b.rule),
  );
}

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
