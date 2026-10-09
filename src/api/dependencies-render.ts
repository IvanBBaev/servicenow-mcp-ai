/**
 * P-17 — the Mermaid view of a dependency graph. Import from dependencies.ts.
 */

import { MermaidDoc, label, type Arrow, type Shape } from "./mermaid.js";
import {
  type DependencyNode,
  type DependencyEdge,
  type DependencyResult,
  LABEL_CHARS,
} from "./dependencies-model.js";

function shapeOf(node: DependencyNode): Shape {
  if (node.kind === "table") return "db";
  if (node.kind === "script") return "input";
  return "rect";
}

/** Solid arrows for references, dotted for edges read from code or JSON. */
function arrowOf(edge: DependencyEdge): Arrow {
  return edge.via === "reference" ? "-->" : "-.->";
}

/**
 * A `graph LR` Mermaid diagram of a dependency result (pure): one node per
 * graph node (capped by SN_DIAGRAM_MAX_NODES), an arrow from each dependent
 * to what it depends on, labelled with the field. Returns the nodes the cap
 * dropped as `truncated`.
 */
export function dependencyMermaid(result: DependencyResult): {
  mermaid: string;
  truncated: number;
} {
  const doc = new MermaidDoc("graph LR");
  const ids = new Map<string, string>();
  result.nodes.forEach((node, i) => {
    const id = `n${i}`;
    const kind = node.type ?? node.table ?? node.kind;
    const text = label(
      `${node.id === result.root ? "* " : ""}${kind}: ${node.name || node.sys_id || node.id}`,
      LABEL_CHARS,
    );
    if (doc.node(id, text, shapeOf(node))) ids.set(node.id, id);
  });
  for (const edge of result.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (!from || !to) continue;
    doc.line(`${from} ${arrowOf(edge)}|"${label(edge.field, 40)}"| ${to}`);
  }
  return { mermaid: doc.render(), truncated: doc.truncated };
}
