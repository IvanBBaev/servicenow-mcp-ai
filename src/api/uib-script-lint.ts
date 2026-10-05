import {
  dataResources,
  stateProperties,
} from "../core/artifacts/uib-composition.js";
import {
  calleeOf,
  dottedPath,
  parseScript,
  propertyName,
  walk,
  type AstNode,
} from "./script-ast.js";

/**
 * N-32 (UX-15) — UIB-aware lint for UI Builder client scripts
 * (`sys_ux_client_script`, the handlers a macroponent dispatches to) and
 * client script includes (`sys_ux_client_script_include`). Pure: no
 * network, no I/O. The source is parsed with acorn (./script-ast.ts), so a
 * rule matches code, never the inside of a comment or a string. Every
 * finding carries a rule id, severity, 1-based line and column, a message
 * and a fix hint.
 *
 * The declared-contract rules (`uib-undeclared-state`, `uib-undeclared-event`,
 * `uib-undeclared-data-resource`) need the owning macroponent's
 * `state_properties`, `dispatched_events` and `data`; without them they stay
 * silent. `uibLintContextFromMacroponent` builds that context from a raw
 * `sys_ux_macroponent` row.
 *
 * ASSUMPTION (unverified until O-5, PDI): the UIB client-script runtime API
 * modelled here is the documented Next Experience shape — a handler
 * `function handler({api, event, helpers, imports}) {…}`, `api.state`
 * (read-only), `api.setState(name, valueOrUpdater)`, `api.emit(eventName,
 * payload)`, `api.data.<resourceId>`, `helpers.timing.setTimeout`,
 * `helpers.snHttp`, `helpers.modal`, and client script includes reached as
 * `imports["<scope>.<name>"]()`. The shape of `dispatched_events` (names,
 * ids or `{name|eventName|id}` objects) is also unverified.
 */

export type UibSeverity = "error" | "warn" | "info";

export interface UibFinding {
  rule: string;
  severity: UibSeverity;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  snippet: string;
  message: string;
  hint: string;
}

/** The macroponent contract a client script is checked against. */
export interface UibLintContext {
  /** Declared client state property names (`state_properties`). */
  state?: readonly string[];
  /** Declared dispatched event names (`dispatched_events`). */
  events?: readonly string[];
  /** Declared data resource element ids (`data`). */
  dataResources?: readonly string[];
}

export interface UibScriptLint {
  /** False when the source did not parse; `findings` then holds only `uib-parse-error`. */
  parsed: boolean;
  findings: UibFinding[];
}

export interface UibRule {
  id: string;
  severity: UibSeverity;
  hint: string;
}

/** The rule catalogue (stable ids; the severities are the defaults). */
export const UIB_SCRIPT_RULES: readonly UibRule[] = [
  {
    id: "uib-server-api",
    severity: "error",
    hint: "Server and classic-client APIs (GlideRecord, GlideAjax, gs, g_form…) do not exist in a UIB page. Read data through a data broker (api.data.<resource>) or helpers.snHttp.",
  },
  {
    id: "uib-sync-wait",
    severity: "error",
    hint: "Never block the browser thread: no synchronous XMLHttpRequest, getXMLWait or Date busy-wait loops. Use an async data broker, helpers.snHttp or helpers.timing.setTimeout.",
  },
  {
    id: "uib-eval",
    severity: "error",
    hint: "eval, new Function and string timers execute arbitrary code and break CSP. Call a function directly.",
  },
  {
    id: "uib-state-mutation",
    severity: "error",
    hint: "api.state is read-only; a direct write is lost and never re-renders. Use api.setState(name, value) or an updater function.",
  },
  {
    id: "uib-loop-on-state",
    severity: "error",
    hint: "api.state does not change while a handler runs, so a while/do-while loop on it never ends. React to a state change event or a data broker instead.",
  },
  {
    id: "uib-undeclared-state",
    severity: "warn",
    hint: "Add the property to the macroponent's state_properties (client state) or fix the name.",
  },
  {
    id: "uib-undeclared-event",
    severity: "warn",
    hint: "Declare the event in the macroponent's dispatched_events or fix the name; an undeclared event cannot be mapped in UI Builder.",
  },
  {
    id: "uib-undeclared-data-resource",
    severity: "warn",
    hint: "Add the data resource to the page or fix the element id.",
  },
  {
    id: "uib-unused-import",
    severity: "warn",
    hint: "Remove the unused client script include import (or use it).",
  },
  {
    id: "uib-dom-access",
    severity: "warn",
    hint: "UIB components render in shadow DOM; global DOM access is fragile and breaks on upgrade. Drive the page through component properties, client state and events.",
  },
  {
    id: "uib-blocking-dialog",
    severity: "warn",
    hint: "alert/confirm/prompt block the page. Open a modal through helpers.modal or an event mapped to a modal.",
  },
  {
    id: "uib-update-in-loop",
    severity: "warn",
    hint: "Each api.setState / api.emit in a loop triggers its own update. Build the value first, then set or emit it once.",
  },
  {
    id: "uib-hardcoded-sys-id",
    severity: "warn",
    hint: "Pass the sys_id through a property, client state or a system property instead of hard-coding it.",
  },
  {
    id: "uib-hardcoded-instance-url",
    severity: "warn",
    hint: "Use a relative URL; a hard-coded instance host breaks on clone and promotion.",
  },
  {
    id: "uib-raw-timer",
    severity: "info",
    hint: "Prefer helpers.timing.setTimeout / setInterval, which the framework cancels with the page.",
  },
  {
    id: "uib-raw-http",
    severity: "info",
    hint: "Prefer a data broker or helpers.snHttp to fetch / XMLHttpRequest: they carry the session token and error handling.",
  },
  {
    id: "uib-dynamic-state-key",
    severity: "info",
    hint: "A computed state or event name cannot be checked against the macroponent contract; use a string literal.",
  },
  {
    id: "uib-console",
    severity: "info",
    hint: "Remove the console call before release.",
  },
  {
    id: "uib-parse-error",
    severity: "info",
    hint: "The script did not parse, so the UIB rules did not run. Fix the syntax error.",
  },
];

const RULES = new Map(UIB_SCRIPT_RULES.map((r) => [r.id, r]));

const SERVER_CTORS = new Set([
  "GlideRecord",
  "GlideRecordSecure",
  "GlideAggregate",
  "GlideAjax",
  "GlideDateTime",
  "GlideSysAttachment",
  "GlideElement",
  "GlideQuery",
]);
const SERVER_GLOBALS = new Set([
  "gs",
  "g_form",
  "g_user",
  "g_list",
  "g_scratchpad",
  "g_navigation",
  "$sp",
]);
const DOM_GLOBALS = new Set(["document", "window", "jQuery", "$", "$j"]);
const DOM_METHODS = new Set([
  "getElementById",
  "getElementsByClassName",
  "getElementsByTagName",
  "querySelector",
  "querySelectorAll",
]);
const DIALOGS = new Set(["alert", "confirm", "prompt"]);
const TIMERS = new Set(["setTimeout", "setInterval"]);
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
const MUTATING_METHODS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
  "set",
  "delete",
  "clear",
  "add",
]);
const SYS_ID = /^[0-9a-f]{32}$/;
const INSTANCE_URL = /https?:\/\/[a-z0-9-]+\.service-now\.com/i;
const SNIPPET_MAX = 160;

/** Whether `node` sits in the body of a loop of its own function. */
function inLoop(ancestors: readonly AstNode[]): boolean {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i]!;
    if (FUNCTIONS.has(a.type)) return false;
    if (LOOPS.has(a.type)) return true;
  }
  return false;
}

/** Whether an expression reads `api.state` anywhere inside it. */
function readsState(node: AstNode | undefined): boolean {
  if (!node) return false;
  let hit = false;
  walk(node, (n) => {
    if (n.type === "MemberExpression" && dottedPath(n)?.startsWith("api.state"))
      hit = true;
  });
  return hit;
}

/** Static string of a literal / quasi-free template, else undefined. */
function staticString(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "string")
    return node.value;
  if (node.type === "TemplateLiteral") {
    const quasis = node.quasis as AstNode[];
    const exprs = node.expressions as AstNode[];
    if (exprs.length === 0 && quasis.length === 1) {
      return (quasis[0]!.value as { cooked?: string }).cooked;
    }
  }
  return undefined;
}

/** The binding names a declarator pattern introduces. */
function patternNames(pattern: AstNode | undefined): AstNode[] {
  if (!pattern) return [];
  switch (pattern.type) {
    case "Identifier":
      return [pattern];
    case "ObjectPattern":
      return (pattern.properties as AstNode[]).flatMap((p) =>
        p.type === "RestElement"
          ? patternNames(p.argument as AstNode)
          : patternNames(p.value as AstNode),
      );
    case "ArrayPattern":
      return (pattern.elements as (AstNode | null)[]).flatMap((e) =>
        e ? patternNames(e) : [],
      );
    case "AssignmentPattern":
      return patternNames(pattern.left as AstNode);
    case "RestElement":
      return patternNames(pattern.argument as AstNode);
    default:
      return [];
  }
}

/** Whether a member expression is an access on the `imports` object. */
function isImportsAccess(node: AstNode): boolean {
  return (
    node.type === "MemberExpression" &&
    (node.object as AstNode).type === "Identifier" &&
    (node.object as AstNode).name === "imports"
  );
}

/** `imports["x"]` or `imports["x"]()` (the include call). */
function isImportExpression(node: AstNode | undefined): boolean {
  if (!node) return false;
  if (isImportsAccess(node)) return true;
  return (
    node.type === "CallExpression" && isImportsAccess(node.callee as AstNode)
  );
}

/**
 * Lint one UIB client script (or client script include). Never throws: a
 * source that does not parse yields a single `uib-parse-error` finding.
 */
export function lintUibClientScript(
  source: string,
  context: UibLintContext = {},
): UibScriptLint {
  const text = typeof source === "string" ? source : "";
  const lines = text.split(/\r?\n/);
  const findings: UibFinding[] = [];
  const seen = new Set<string>();

  const add = (
    ruleId: string,
    node: AstNode | { line: number; column: number },
    message: string,
  ): void => {
    const rule = RULES.get(ruleId)!;
    const line =
      "type" in node
        ? (node.loc?.start.line ?? 0)
        : (node as { line: number }).line;
    const column =
      "type" in node
        ? (node.loc?.start.column ?? 0) + 1
        : (node as { column: number }).column;
    const key = `${ruleId}:${line}:${column}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      rule: ruleId,
      severity: rule.severity,
      line,
      column,
      snippet: (lines[line - 1] ?? "").trim().slice(0, SNIPPET_MAX),
      message,
      hint: rule.hint,
    });
  };

  const parsed = parseScript(text, "es2021");
  if (!parsed.ok) {
    add(
      "uib-parse-error",
      { line: parsed.line ?? 0, column: 1 },
      `Script does not parse: ${parsed.error}`,
    );
    return { parsed: false, findings };
  }

  const declaredState = context.state ? new Set(context.state) : undefined;
  const declaredEvents = context.events ? new Set(context.events) : undefined;
  const declaredData = context.dataResources
    ? new Set(context.dataResources)
    : undefined;

  // Unused-import bookkeeping: bindings introduced from `imports[...]`, and
  // every identifier reference. Name-based (not scope-aware): a shadowing
  // name counts as a use, which only ever hides a finding.
  const importBindings: AstNode[] = [];
  const references = new Map<string, number>();

  walk(parsed.ast, (node, ancestors) => {
    const parent = ancestors[ancestors.length - 1];

    switch (node.type) {
      case "VariableDeclarator": {
        if (isImportExpression(node.init as AstNode | undefined)) {
          for (const id of patternNames(node.id as AstNode)) {
            importBindings.push(id);
          }
        }
        return;
      }

      case "Identifier": {
        const name = node.name as string;
        // A non-computed property key or member property is not a reference
        // (for a shorthand `{a}` acorn gives the value its own node, which
        // is the reference).
        const isMemberProp =
          parent?.type === "MemberExpression" &&
          parent.property === node &&
          !parent.computed;
        const isKey =
          parent?.type === "Property" &&
          parent.key === node &&
          !parent.computed;
        if (!isMemberProp && !isKey) {
          references.set(name, (references.get(name) ?? 0) + 1);
        }
        if (isMemberProp || isKey) return;
        // Bare server / DOM globals used as values (`g_form`, `document`).
        const isCallee =
          (parent?.type === "CallExpression" ||
            parent?.type === "NewExpression") &&
          parent.callee === node;
        const isMemberObject =
          parent?.type === "MemberExpression" && parent.object === node;
        if (SERVER_GLOBALS.has(name) && isMemberObject) {
          add(
            "uib-server-api",
            node,
            `Server/classic-client API \`${name}\` used in a UIB client script.`,
          );
        } else if (DOM_GLOBALS.has(name) && (isMemberObject || isCallee)) {
          add("uib-dom-access", node, `Global DOM access through \`${name}\`.`);
        }
        return;
      }

      case "NewExpression": {
        const callee = node.callee as AstNode;
        const name =
          callee.type === "Identifier" ? (callee.name as string) : undefined;
        if (name && SERVER_CTORS.has(name)) {
          add(
            "uib-server-api",
            node,
            `\`new ${name}\` is a server/classic-client API, not available in UIB.`,
          );
        } else if (name === "Function") {
          add("uib-eval", node, "`new Function` evaluates a string as code.");
        } else if (name === "XMLHttpRequest") {
          add(
            "uib-raw-http",
            node,
            "Raw XMLHttpRequest in a UIB client script.",
          );
        }
        return;
      }

      case "CallExpression": {
        lintCall(node, ancestors);
        return;
      }

      case "AssignmentExpression":
      case "UpdateExpression": {
        const target = (
          node.type === "AssignmentExpression" ? node.left : node.argument
        ) as AstNode;
        if (target.type === "MemberExpression" && memberChainHasState(target)) {
          add("uib-state-mutation", node, "Direct write to api.state.");
        }
        return;
      }

      case "UnaryExpression": {
        const arg = node.argument as AstNode;
        if (
          node.operator === "delete" &&
          arg.type === "MemberExpression" &&
          memberChainHasState(arg)
        ) {
          add("uib-state-mutation", node, "`delete` on api.state.");
        }
        return;
      }

      case "WhileStatement":
      case "DoWhileStatement": {
        const test = node.test as AstNode;
        if (readsState(test)) {
          add(
            "uib-loop-on-state",
            node,
            "Loop condition reads api.state, which does not change inside a handler.",
          );
        } else if (isDateBusyWait(test)) {
          add(
            "uib-sync-wait",
            node,
            "Busy-wait loop on the clock blocks the browser.",
          );
        }
        return;
      }

      case "ForStatement": {
        const test = node.test as AstNode | undefined;
        if (test && isDateBusyWait(test)) {
          add(
            "uib-sync-wait",
            node,
            "Busy-wait loop on the clock blocks the browser.",
          );
        }
        return;
      }

      case "MemberExpression": {
        // api.data.<resource> against the declared data resources.
        const obj = node.object as AstNode;
        if (declaredData && dottedPath(obj) === "api.data") {
          const name = propertyName(node);
          if (name !== undefined && !declaredData.has(name)) {
            add(
              "uib-undeclared-data-resource",
              node,
              `Data resource \`${name}\` is not declared on the page.`,
            );
          }
        }
        return;
      }

      case "Literal": {
        if (typeof node.value !== "string") return;
        if (SYS_ID.test(node.value)) {
          add("uib-hardcoded-sys-id", node, "Hard-coded sys_id literal.");
        } else if (INSTANCE_URL.test(node.value)) {
          add("uib-hardcoded-instance-url", node, "Hard-coded instance URL.");
        }
        return;
      }

      case "TemplateElement": {
        const cooked = (node.value as { cooked?: string }).cooked ?? "";
        if (INSTANCE_URL.test(cooked)) {
          add("uib-hardcoded-instance-url", node, "Hard-coded instance URL.");
        }
        return;
      }

      default:
        return;
    }
  });

  function lintCall(node: AstNode, ancestors: readonly AstNode[]): void {
    const { object, name } = calleeOf(node, text);
    const args = (node.arguments as AstNode[] | undefined) ?? [];
    const callee = node.callee as AstNode;
    const bare = callee.type === "Identifier";
    const globalCall = bare || object === "window" || object === "globalThis";

    if (name === undefined) return;

    if (globalCall && name === "eval") {
      add("uib-eval", node, "`eval` evaluates a string as code.");
      return;
    }
    if (globalCall && TIMERS.has(name)) {
      if (args[0] && staticString(args[0]) !== undefined) {
        add(
          "uib-eval",
          node,
          `\`${name}\` with a string argument evaluates code.`,
        );
      } else if (bare) {
        add("uib-raw-timer", node, `Bare \`${name}\` in a UIB client script.`);
      }
      return;
    }
    if (globalCall && DIALOGS.has(name)) {
      add("uib-blocking-dialog", node, `Blocking \`${name}\` dialog.`);
      return;
    }
    if (bare && name === "fetch") {
      add("uib-raw-http", node, "Raw fetch in a UIB client script.");
      return;
    }
    if (object === "console") {
      add("uib-console", node, `\`console.${name}\` left in the script.`);
      return;
    }
    if (
      DOM_METHODS.has(name) &&
      object !== undefined &&
      object !== "document"
    ) {
      add("uib-dom-access", node, `DOM query \`${name}\`.`);
      return;
    }
    if (name === "getXMLWait" || name === "getReferenceWait") {
      add(
        "uib-sync-wait",
        node,
        `\`${name}\` is a synchronous server round trip.`,
      );
      return;
    }
    // xhr.open(method, url, false) — a synchronous request.
    if (
      name === "open" &&
      !object?.startsWith("helpers") &&
      !object?.startsWith("api") &&
      args.length >= 3 &&
      args[2]!.type === "Literal" &&
      args[2]!.value === false
    ) {
      add(
        "uib-sync-wait",
        node,
        "Synchronous XMLHttpRequest (`open(…, false)`).",
      );
      return;
    }

    if (object === "api" && (name === "setState" || name === "emit")) {
      const kind = name === "setState" ? "state" : "event";
      const key = staticString(args[0]);
      if (key === undefined) {
        if (args[0]) {
          add(
            "uib-dynamic-state-key",
            node,
            `Computed ${kind} name in \`api.${name}\`.`,
          );
        }
      } else if (kind === "state" && declaredState && !declaredState.has(key)) {
        add(
          "uib-undeclared-state",
          node,
          `\`api.setState('${key}')\` targets a state property the macroponent does not declare.`,
        );
      } else if (
        kind === "event" &&
        declaredEvents &&
        !declaredEvents.has(key)
      ) {
        add(
          "uib-undeclared-event",
          node,
          `\`api.emit('${key}')\` dispatches an event the macroponent does not declare.`,
        );
      }
      if (inLoop(ancestors)) {
        add("uib-update-in-loop", node, `\`api.${name}\` inside a loop.`);
      }
      return;
    }

    // api.state.list.push(x) — in-place mutation of client state.
    if (
      callee.type === "MemberExpression" &&
      MUTATING_METHODS.has(name) &&
      memberChainHasState(callee.object as AstNode)
    ) {
      add("uib-state-mutation", node, `In-place \`${name}\` on api.state.`);
    }
  }

  // An import binding referenced only by its own declaration is unused.
  for (const id of importBindings) {
    const name = id.name as string;
    if ((references.get(name) ?? 0) <= 1) {
      add("uib-unused-import", id, `Import binding \`${name}\` is never used.`);
    }
  }
  // An import whose value is discarded: `imports["x"];` as a statement.
  walk(parsed.ast, (node) => {
    if (
      node.type === "ExpressionStatement" &&
      isImportsAccess(node.expression as AstNode)
    ) {
      add("uib-unused-import", node, "Import accessed and discarded.");
    }
  });

  findings.sort((a, b) => a.line - b.line || a.column - b.column);
  return { parsed: true, findings };
}

/** Whether a member chain passes through `api.state` (`api.state.a[0].b`). */
function memberChainHasState(node: AstNode): boolean {
  let cur: AstNode = node;
  while (cur.type === "MemberExpression") {
    const obj = cur.object as AstNode;
    if (
      obj.type === "Identifier" &&
      obj.name === "api" &&
      propertyName(cur) === "state"
    ) {
      // `api.state` itself (cur === node) is a whole-object write.
      return true;
    }
    cur = obj;
  }
  return false;
}

/** `Date.now() < end`, `new Date() - start < ms`, `new Date().getTime() …`. */
function isDateBusyWait(test: AstNode): boolean {
  let hit = false;
  walk(test, (n) => {
    if (n.type === "CallExpression") {
      const callee = n.callee as AstNode;
      const path = dottedPath(callee);
      if (path === "Date.now" || path === "performance.now") hit = true;
      if (
        callee.type === "MemberExpression" &&
        (callee.object as AstNode).type === "NewExpression" &&
        dottedPath((callee.object as AstNode).callee as AstNode) === "Date"
      )
        hit = true;
    }
    if (
      n.type === "NewExpression" &&
      dottedPath(n.callee as AstNode) === "Date"
    )
      hit = true;
  });
  return hit;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.trim() === "") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * Declared event names of a decoded `dispatched_events`; undefined when
 * the shape is unknown (the rule then stays silent). ASSUMPTION (O-5): an
 * array of names / ids, or of `{name|eventName|id}` objects.
 */
export function dispatchedEventNames(value: unknown): string[] | undefined {
  const v = parseMaybeJson(value);
  if (v === undefined) return [];
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string" && item) out.push(item);
    else if (typeof item === "object" && item !== null) {
      const o = item as Record<string, unknown>;
      for (const k of ["name", "eventName", "id"]) {
        if (typeof o[k] === "string" && o[k]) out.push(o[k]);
      }
    }
  }
  return out;
}

/**
 * Lint context from a raw `sys_ux_macroponent` row (JSON strings or
 * decoded values). A field whose shape is unknown is left out, so its
 * rule stays silent rather than flagging every call.
 */
export function uibLintContextFromMacroponent(row: {
  state_properties?: unknown;
  dispatched_events?: unknown;
  data?: unknown;
}): UibLintContext {
  const ctx: UibLintContext = {};
  if (row.state_properties !== undefined) {
    const state = stateProperties(parseMaybeJson(row.state_properties));
    if (state) ctx.state = state.map((s) => s.name);
  }
  if (row.dispatched_events !== undefined) {
    const events = dispatchedEventNames(row.dispatched_events);
    if (events) ctx.events = events;
  }
  if (row.data !== undefined) {
    const data = dataResources(parseMaybeJson(row.data));
    if (data) ctx.dataResources = data.map((d) => d.elementId);
  }
  return ctx;
}

/** The registry types whose `script` field is a UIB client script. */
export const UIB_CLIENT_SCRIPT_TYPES: ReadonlySet<string> = new Set([
  "uib_client_script",
  "uib_client_script_include",
]);

/**
 * UIB rules that restate a generic codecheck client rule: the UIB finding
 * is dropped when the generic one already fired on the same line.
 */
const GENERIC_OVERLAP: Record<string, readonly string[]> = {
  "uib-hardcoded-sys-id": ["hardcoded-sys-id"],
  "uib-hardcoded-instance-url": ["hardcoded-instance-url"],
  "uib-eval": ["eval-usage"],
  "uib-server-api": ["gr-on-client"],
  "uib-sync-wait": ["sync-get-reference"],
};

/** The codecheck `Finding` shape (structural, to avoid an import cycle). */
export interface GenericFinding {
  rule: string;
  severity: UibSeverity;
  line: number;
  snippet: string;
  hint: string;
}

/**
 * UIB findings as codecheck findings, merged into the generic ones: the
 * message and column fold into the hint (the codecheck `Finding` has no
 * column / message field), restated generic rules are dropped, and a parse
 * error is left to the generic linter's own fallback.
 */
export function uibFindingsAsGeneric(
  uib: readonly UibFinding[],
  generic: readonly GenericFinding[],
): GenericFinding[] {
  const fired = new Set(generic.map((f) => `${f.rule}:${f.line}`));
  const out: GenericFinding[] = [];
  for (const f of uib) {
    if (f.rule === "uib-parse-error") continue;
    const overlap = GENERIC_OVERLAP[f.rule] ?? [];
    if (overlap.some((g) => fired.has(`${g}:${f.line}`))) continue;
    out.push({
      rule: f.rule,
      severity: f.severity,
      line: f.line,
      snippet: f.snippet,
      hint: `${f.message} (col ${f.column}) ${f.hint}`,
    });
  }
  return out;
}
