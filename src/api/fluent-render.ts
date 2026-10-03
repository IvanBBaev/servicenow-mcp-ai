/**
 * P-26 — a tiny, deterministic TypeScript source renderer for the Fluent
 * emitter (`src/api/fluent.ts`). It knows exactly the shapes the emitter
 * produces — object literals, arrays, string / number / boolean literals,
 * constructor calls (`Duration({…})`, `StringColumn({…})`) and pre-rendered
 * code (`Now.include(…)`, `Now.ref(…)`) — and renders them with a
 * fixed layout (4-space indent, single quotes, trailing commas), so the same
 * input always gives byte-identical output.
 */

/** A value the emitter writes into a Fluent call. */
export type Expr =
  | { k: "lit"; v: string | number | boolean }
  | { k: "code"; code: string }
  | { k: "call"; fn: string; args: Expr[] }
  | { k: "arr"; items: Expr[] }
  | { k: "obj"; props: Prop[] };

/** One property of an object literal, with an optional line comment above it. */
export interface Prop {
  key: string;
  value: Expr;
  comment?: string;
}

export const lit = (v: string | number | boolean): Expr => ({ k: "lit", v });
export const code = (c: string): Expr => ({ k: "code", code: c });
/** `fn(arg, …)`, its arguments indented at the depth the call is rendered at. */
export const call = (fn: string, ...args: Expr[]): Expr => ({
  k: "call",
  fn,
  args,
});
export const arr = (items: Expr[]): Expr => ({ k: "arr", items });
export const obj = (props: Prop[]): Expr => ({ k: "obj", props });

const ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  "'": "\\'",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/** A single-quoted TypeScript string literal that is safe for any input. */
export function tsString(s: string): string {
  const body = s.replace(
    // eslint-disable-next-line no-control-regex
    /[\\'\u0000-\u001f\u007f\u2028\u2029]/g,
    (c) => ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `'${body}'`;
}

/** An object-literal key: bare when it is an identifier, quoted otherwise. */
export function tsKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : tsString(key);
}

/** A comment on one line: no line breaks can end it early. */
export function oneLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
}

const PAD = "    ";

/** Render an expression at the given indent depth (the opening line is not padded). */
export function render(e: Expr, depth = 0): string {
  const pad = PAD.repeat(depth);
  switch (e.k) {
    case "lit":
      if (typeof e.v === "string") return tsString(e.v);
      if (typeof e.v === "number") {
        return Number.isFinite(e.v) ? String(e.v) : tsString(String(e.v));
      }
      return e.v ? "true" : "false";
    case "code":
      return e.code;
    case "call":
      return `${e.fn}(${e.args.map((a) => render(a, depth)).join(", ")})`;
    case "arr": {
      if (!e.items.length) return "[]";
      const flat = e.items.every((i) => i.k === "lit" || i.k === "code");
      const parts = e.items.map((i) => render(i, depth + 1));
      const inline = `[${parts.join(", ")}]`;
      if (flat && inline.length <= 80) return inline;
      return `[\n${parts.map((p) => `${pad}${PAD}${p},`).join("\n")}\n${pad}]`;
    }
    case "obj": {
      if (!e.props.length) return "{}";
      const lines: string[] = [];
      for (const p of e.props) {
        if (p.comment) lines.push(`${pad}${PAD}// ${oneLine(p.comment)}`);
        lines.push(
          `${pad}${PAD}${tsKey(p.key)}: ${render(p.value, depth + 1)},`,
        );
      }
      return `{\n${lines.join("\n")}\n${pad}}`;
    }
  }
}
