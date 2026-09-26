// Structural lint for the Mermaid the generators emit (S-14). Not a parser —
// it catches the mistakes that make GitHub / VS Code refuse to render a
// diagram: unbalanced subgraph/end or entity braces, edges to undeclared
// nodes, raw quotes inside a quoted label and '^' in identifiers.

import assert from "node:assert/strict";

/** Node declaration: `id["…"]`, `id(["…"])`, `id[/"…"/]`, `id[("…")]`, `id([…])`. */
const NODE_DECL = /^\s*([A-Za-z0-9_]+)(\[\/|\(\[|\[\(|\[|\(\()/;
const SUBGRAPH = /^\s*subgraph\s+([A-Za-z0-9_]+)/;
const EDGE = /^\s*([A-Za-z0-9_]+)\s+(-->|-\.->|==>)\s+([A-Za-z0-9_]+)/;
/** Every quoted label: `"…"` bounded by a shape opener and closer. */
const QUOTED = /(?:\[\/|\(\[|\[\(|\[|\(\()"(.*?)"(?:\/\]|\]\)|\)\]|\]|\)\))/g;

export function lintMermaid(text) {
  assert.equal(typeof text, "string");
  const lines = text.split("\n");
  const head = lines[0].trim();
  assert.match(head, /^(erDiagram|flowchart (TD|LR)|graph (TD|LR))$/, head);
  if (head === "erDiagram") return lintEr(lines);

  const declared = new Set();
  let depth = 0;
  const edges = [];
  for (const [i, line] of lines.slice(1).entries()) {
    const where = `line ${i + 2}: ${line}`;
    const sub = SUBGRAPH.exec(line);
    if (sub) {
      depth++;
      declared.add(sub[1]);
      assert.ok(!sub[1].includes("^"), where);
    } else if (/^\s*end\s*$/.test(line)) {
      depth--;
      assert.ok(depth >= 0, `unbalanced end — ${where}`);
    }
    const node = NODE_DECL.exec(line);
    if (node) declared.add(node[1]);
    const edge = EDGE.exec(line);
    if (edge) {
      edges.push([edge[1], edge[3], where]);
      // An edge may declare its target inline: `a --> b["…"]`.
      const rest = line.slice(line.indexOf(edge[3]));
      if (NODE_DECL.test(rest)) declared.add(edge[3]);
    }
    for (const m of line.matchAll(QUOTED)) {
      assert.ok(!m[1].includes('"'), `raw quote in a label — ${where}`);
    }
    assert.ok(!/(^|\s)[A-Za-z0-9_]*\^/.test(line.split('"')[0]), where);
  }
  assert.equal(depth, 0, "every subgraph needs an end");
  for (const [from, to, where] of edges) {
    assert.ok(declared.has(from), `undeclared edge source ${from} — ${where}`);
    assert.ok(declared.has(to), `undeclared edge target ${to} — ${where}`);
  }
}

function lintEr(lines) {
  let open = false;
  for (const [i, line] of lines.slice(1).entries()) {
    const where = `line ${i + 2}: ${line}`;
    if (/\{\s*$/.test(line)) {
      assert.ok(!open, `nested entity — ${where}`);
      open = true;
      assert.match(line, /^\s*[A-Za-z0-9_]+ \{$/, where);
    } else if (/^\s*\}\s*$/.test(line)) {
      assert.ok(open, `unbalanced } — ${where}`);
      open = false;
    } else if (open) {
      // type name [PK|FK[, …]] ["comment"]
      assert.match(
        line,
        /^\s*[A-Za-z0-9_]+ [A-Za-z0-9_]+( (PK|FK)(, (PK|FK))*)?( "[^"]*")?$/,
        where,
      );
    } else {
      assert.match(
        line,
        /^\s*[A-Za-z0-9_]+ (\}o--\|\||\|\|--\|\|) [A-Za-z0-9_]+ : "?[^"]*"?$/,
        where,
      );
    }
  }
  assert.ok(!open, "every entity needs a closing brace");
}
