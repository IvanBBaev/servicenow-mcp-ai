import { getDiagramMaxNodes } from "../core/settings.js";

/**
 * Shared Mermaid primitives (S-14). Every generator — the ER diagram, the
 * table flow, the event trace and the where-used graph — builds its markup
 * from these, so escaping and structure rules live in one place:
 *
 * - `ident` makes a string safe as a Mermaid identifier (word characters only,
 *   so a stray `^` or space can never reach the parser).
 * - `label` makes a string safe inside a quoted label: newlines fold, the
 *   characters that end a label (`"[]{}|`) become `'`, and the ones Mermaid
 *   reads as syntax inside a label (`#`, `;`, backtick, `%%`) become entity
 *   codes.
 * - `MermaidDoc` is a flowchart builder with a node cap
 *   (`SN_DIAGRAM_MAX_NODES`): nodes past it fold into one "+N more" node and
 *   edges touching a dropped node are skipped, so a huge table still renders.
 */

/** Mermaid identifiers allow word characters; sanitise anything else. */
export function ident(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Entity code for a character Mermaid reads as syntax inside a label. */
function entity(match: string): string {
  return match === "%%" ? "#37;#37;" : `#${match.charCodeAt(0)};`;
}

/**
 * Escape a Mermaid label. `max` cuts the text before escaping, so an entity
 * code is never split. Escaping runs in one pass — an emitted `#35;` is never
 * re-escaped.
 */
export function label(text: string, max?: number): string {
  let out = text.replace(/[\r\n]+/g, " ").replace(/["[\]{}|]/g, "'");
  if (max !== undefined) out = out.slice(0, max);
  return out.trim().replace(/%%|[#;`]/g, entity);
}

/**
 * Node shapes used by the generators: `rect` `id["…"]`, `input` `id[/"…"/]`,
 * `db` `id[("…")]`, and `terminal` `id([…])` (unquoted — for fixed words).
 */
export type Shape = "rect" | "input" | "db" | "terminal";

/** A node declaration. `text` must already be escaped with `label`. */
export function node(id: string, text: string, shape: Shape = "rect"): string {
  switch (shape) {
    case "input":
      return `${id}[/"${text}"/]`;
    case "db":
      return `${id}[("${text}")]`;
    case "terminal":
      return `${id}([${text}])`;
    default:
      return `${id}["${text}"]`;
  }
}

/** Edge arrows: solid `-->` and dotted `-.->`. */
export type Arrow = "-->" | "-.->";

export function edge(from: string, to: string, arrow: Arrow = "-->"): string {
  return `${from} ${arrow} ${to}`;
}

/** Opening line of a titled subgraph; `title` must already be escaped. */
export function subgraph(id: string, title: string): string {
  return `subgraph ${id}["${title}"]`;
}

/** One `erDiagram` attribute. */
export interface ErAttribute {
  type: string;
  name: string;
  keys?: ("PK" | "FK")[];
  /** Free text; escaped here. */
  comment?: string;
}

/** An `erDiagram` entity block, indented for the top level. */
export function erEntity(name: string, attributes: ErAttribute[]): string[] {
  const lines = [`  ${ident(name)} {`];
  for (const a of attributes) {
    let line = `    ${ident(a.type)} ${ident(a.name)}`;
    if (a.keys?.length) line += ` ${a.keys.join(", ")}`;
    if (a.comment) line += ` "${label(a.comment)}"`;
    lines.push(line);
  }
  lines.push("  }");
  return lines;
}

/** Cardinalities the ER generator draws. */
export type ErCardinality = "}o--||" | "||--||";

/** An `erDiagram` relationship line, indented for the top level. */
export function erRelation(
  from: string,
  cardinality: ErCardinality,
  to: string,
  text: string,
): string {
  return `  ${ident(from)} ${cardinality} ${ident(to)} : "${label(text)}"`;
}

/**
 * Flowchart builder with nesting-aware indentation and a node cap. Lines come
 * out in insertion order; each nesting level indents two more spaces.
 */
export class MermaidDoc {
  private readonly lines: string[];
  private depth = 0;
  private counted = 0;
  private droppedCount = 0;
  private readonly dropped = new Set<string>();
  private readonly maxNodes: number;

  constructor(header: string, maxNodes: number = getDiagramMaxNodes()) {
    this.lines = [header];
    this.maxNodes = maxNodes;
  }

  private push(text: string): void {
    this.lines.push(`${"  ".repeat(this.depth + 1)}${text}`);
  }

  /** A raw line at the current nesting level. */
  line(text: string): this {
    this.push(text);
    return this;
  }

  /**
   * Declare a node. Counted nodes past the cap are dropped (and remembered,
   * so edges touching them are skipped); `pinned` nodes — start / end
   * markers — always render. Returns whether the node was emitted.
   */
  node(
    id: string,
    text: string,
    shape: Shape = "rect",
    opts: { pinned?: boolean } = {},
  ): boolean {
    if (!this.admit(id, opts.pinned)) return false;
    this.push(node(id, text, shape));
    return true;
  }

  private admit(id: string, pinned?: boolean): boolean {
    if (pinned) return true;
    if (this.counted >= this.maxNodes) {
      this.dropped.add(id);
      this.droppedCount++;
      return false;
    }
    this.counted++;
    return true;
  }

  /** An edge; skipped when either end was dropped by the cap. */
  edge(from: string, to: string, arrow: Arrow = "-->"): this {
    if (this.dropped.has(from) || this.dropped.has(to)) return this;
    this.push(edge(from, to, arrow));
    return this;
  }

  /**
   * An edge that declares its target inline: `a --> b["…"]`. The target is
   * counted against the cap unless `pinned`.
   */
  edgeTo(
    from: string,
    id: string,
    text: string,
    opts: { arrow?: Arrow; shape?: Shape; pinned?: boolean } = {},
  ): this {
    if (this.dropped.has(from)) {
      // The source was dropped, so the cap is already reached: a pinned
      // target still stands alone, any other target is dropped too.
      if (opts.pinned) this.push(node(id, text, opts.shape));
      else this.admit(id, false);
      return this;
    }
    if (!this.admit(id, opts.pinned)) return this;
    this.push(edge(from, node(id, text, opts.shape), opts.arrow));
    return this;
  }

  /** Open a titled subgraph (`direction` omitted for none). */
  open(id: string, title: string, direction?: "TB" | "LR"): this {
    this.push(subgraph(id, title));
    this.depth++;
    if (direction) this.push(`direction ${direction}`);
    return this;
  }

  close(): this {
    if (this.depth > 0) this.depth--;
    this.push("end");
    return this;
  }

  /** Nodes dropped by the cap so far. */
  get truncated(): number {
    return this.droppedCount;
  }

  /** The markup; a capped diagram ends with one "+N more" node. */
  render(): string {
    const out = [...this.lines];
    if (this.droppedCount > 0) {
      out.push(`  ${node("more_nodes", `+${this.droppedCount} more`)}`);
    }
    return out.join("\n");
  }
}
