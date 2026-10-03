import { parse } from "acorn";

/**
 * S-12 — the parser layer of the script rules. ServiceNow server scripts are
 * parsed with `acorn` (the only parser dependency: small, zero-dependency)
 * so a rule matches code, never the inside of a comment or a string. Global
 * scope runs ES5, scoped apps can run ES2021; client fields run in the
 * browser. Nothing here throws: a source that does not parse (a Jelly or
 * `${}` fragment, newer syntax, a real error) comes back as `ok: false` and
 * the caller falls back to its regex rules.
 */

/** ECMAScript level a script is parsed at. */
export type EcmaMode = "es5" | "es2021";

/**
 * A loosely typed ESTree node: the rules only read `type`, positions and a
 * handful of well-known child keys, so the full ESTree union is not needed.
 */
export interface AstNode {
  type: string;
  start: number;
  end: number;
  loc?: { start: { line: number; column: number } };
  [key: string]: unknown;
}

export type ParseOutcome =
  | { ok: true; ast: AstNode; mode: EcmaMode }
  | { ok: false; mode: EcmaMode; error: string; line?: number };

/** Sources longer than this are not parsed (regex fallback). */
export const AST_MAX_SOURCE_CHARS = 512_000;

/**
 * Parse one script body. `allowReturnOutsideFunction` because business rules,
 * ACL scripts and conditions often `return` at the top level; `script` source
 * type (no modules); locations on for line numbers.
 */
export function parseScript(source: string, mode: EcmaMode): ParseOutcome {
  if (typeof source !== "string") {
    return { ok: false, mode, error: "source is not a string" };
  }
  if (source.length > AST_MAX_SOURCE_CHARS) {
    return {
      ok: false,
      mode,
      error: `source longer than ${AST_MAX_SOURCE_CHARS} characters`,
    };
  }
  try {
    const ast = parse(source, {
      ecmaVersion: mode === "es5" ? 5 : 2021,
      sourceType: "script",
      allowReturnOutsideFunction: true,
      allowHashBang: true,
      locations: true,
    }) as unknown as AstNode;
    return { ok: true, ast, mode };
  } catch (e) {
    const loc = (e as { loc?: { line?: unknown } } | null)?.loc;
    const line = typeof loc?.line === "number" ? loc.line : undefined;
    return {
      ok: false,
      mode,
      error: e instanceof Error ? e.message : String(e),
      ...(line !== undefined ? { line } : {}),
    };
  }
}

export function isNode(v: unknown): v is AstNode {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { type?: unknown }).type === "string" &&
    typeof (v as { start?: unknown }).start === "number"
  );
}

/**
 * Visit every node depth-first with its ancestor chain (root first). An
 * explicit stack keeps deeply nested input from overflowing the call stack.
 */
export function walk(
  root: AstNode,
  visit: (node: AstNode, ancestors: readonly AstNode[]) => void,
): void {
  const stack: { node: AstNode; ancestors: AstNode[] }[] = [
    { node: root, ancestors: [] },
  ];
  while (stack.length > 0) {
    const { node, ancestors } = stack.pop()!;
    visit(node, ancestors);
    const chain = [...ancestors, node];
    const children: AstNode[] = [];
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc") continue;
      if (Array.isArray(value)) {
        for (const v of value) if (isNode(v)) children.push(v);
      } else if (isNode(value)) {
        children.push(value);
      }
    }
    // Reverse so children are visited in source order.
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i]!, ancestors: chain });
    }
  }
}

/** 1-based line of a node (0 when locations are missing). */
export function lineOf(node: AstNode): number {
  return node.loc?.start.line ?? 0;
}

/** Static property name of a member expression (`a.b`, `a['b']`). */
export function propertyName(member: AstNode): string | undefined {
  const prop = member.property as AstNode | undefined;
  if (!prop) return undefined;
  if (!member.computed && prop.type === "Identifier") {
    return prop.name as string;
  }
  if (member.computed && prop.type === "Literal") {
    return typeof prop.value === "string" ? prop.value : undefined;
  }
  return undefined;
}

/**
 * Dotted path of an identifier / member chain (`gs`, `$sp`, `this.gr`,
 * `GlideEvaluator`), or undefined for anything dynamic.
 */
export function dottedPath(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name as string;
  if (node.type === "ThisExpression") return "this";
  if (node.type === "MemberExpression") {
    const base = dottedPath(node.object as AstNode);
    const prop = propertyName(node);
    return base !== undefined && prop !== undefined
      ? `${base}.${prop}`
      : undefined;
  }
  return undefined;
}

/** What a call or `new` expression calls, split into receiver and name. */
export interface Callee {
  /** Dotted receiver path (`gs`, `current`, `this.gr`); undefined for a bare call. */
  object?: string;
  /** Source text of the receiver expression, for matching calls on one object. */
  objectText?: string;
  /** Called function or method name. */
  name?: string;
}

export function calleeOf(call: AstNode, source: string): Callee {
  const callee = call.callee as AstNode | undefined;
  if (!callee) return {};
  if (callee.type === "Identifier") return { name: callee.name as string };
  if (callee.type === "MemberExpression") {
    const obj = callee.object as AstNode;
    return {
      object: dottedPath(obj),
      objectText: source.slice(obj.start, obj.end).replace(/\s+/g, ""),
      name: propertyName(callee),
    };
  }
  return {};
}

/** A call or `new` expression of a parsed script (S-12 facts). */
export interface CallFact extends Callee {
  kind: "call" | "new";
  line: number;
  args: AstNode[];
  node: AstNode;
}

/**
 * Every call and `new` expression of a parsed script — the shared input of
 * the AST variants of the ACL-script and portal-widget rules.
 */
export function callFacts(ast: AstNode, source: string): CallFact[] {
  const out: CallFact[] = [];
  walk(ast, (node) => {
    if (node.type !== "CallExpression" && node.type !== "NewExpression") {
      return;
    }
    out.push({
      kind: node.type === "NewExpression" ? "new" : "call",
      line: lineOf(node),
      args: (node.arguments as AstNode[] | undefined) ?? [],
      node,
      ...calleeOf(node, source),
    });
  });
  return out;
}

/**
 * Parse a script and list its calls, never throwing: undefined when it does
 * not parse (the caller keeps its regex rule). The default ES2021 level
 * accepts every ES5 script, so an unknown scope never turns into an error.
 */
export function scriptCalls(
  source: string,
  mode: EcmaMode = "es2021",
): CallFact[] | undefined {
  try {
    const parsed = parseScript(source, mode);
    return parsed.ok ? callFacts(parsed.ast, source) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * ES level for a script from its application scope value: `global` runs
 * ES5, any other scope can run ES2021; unknown (empty) parses leniently.
 */
export function ecmaModeForScope(scopeValue: string | undefined): EcmaMode {
  return scopeValue?.trim() === "global" ? "es5" : "es2021";
}
