import test from "node:test";
import assert from "node:assert/strict";

import {
  MermaidDoc,
  edge,
  erEntity,
  erRelation,
  ident,
  label,
  node,
  subgraph,
} from "../build/api/mermaid.js";
import { withEnv } from "./helpers.js";
import { lintMermaid } from "./mermaid-lint.js";

test("ident keeps word characters only", () => {
  assert.equal(ident("u_my.table^x y"), "u_my_table_x_y");
});

test("label folds newlines, neutralises delimiters and entity-codes syntax", () => {
  assert.equal(label('a\r\nb "c" [d] {e} |f|'), "a b 'c' 'd' 'e' 'f'");
  assert.equal(label("x#y;z`w %% v"), "x#35;y#59;z#96;w #37;#37; v");
  // The cut happens before escaping, so an entity is never split.
  assert.equal(label("ab#cd", 3), "ab#35;");
  assert.equal(label("  padded  "), "padded");
});

test("node, edge and subgraph shapes", () => {
  assert.equal(node("a", "A"), 'a["A"]');
  assert.equal(node("a", "A", "input"), 'a[/"A"/]');
  assert.equal(node("a", "A", "db"), 'a[("A")]');
  assert.equal(node("a", "done", "terminal"), "a([done])");
  assert.equal(edge("a", "b"), "a --> b");
  assert.equal(edge("a", "b", "-.->"), "a -.-> b");
  assert.equal(subgraph("s", "T"), 'subgraph s["T"]');
});

test("erEntity and erRelation escape and mark keys", () => {
  assert.deepEqual(
    erEntity("x.t", [
      { type: "GUID", name: "sys_id", keys: ["PK"], comment: 'say "hi"' },
      { type: "string", name: "name" },
    ]),
    ["  x_t {", `    GUID sys_id PK "say 'hi'"`, "    string name", "  }"],
  );
  assert.equal(
    erRelation("a", "}o--||", "b.c", "ref#1"),
    '  a }o--|| b_c : "ref#35;1"',
  );
});

test("MermaidDoc nests, caps nodes and folds the rest into +N more", () => {
  const doc = new MermaidDoc("flowchart TD", 2);
  doc.node("start", "start", "terminal", { pinned: true });
  doc.open("S", "phase", "TB");
  assert.equal(doc.node("a", "A"), true);
  assert.equal(doc.node("b", "B"), true);
  assert.equal(doc.node("c", "C"), false);
  doc.close();
  doc.edge("start", "a").edge("a", "c").edge("c", "b");
  // Target admitted past the cap is dropped; pinned targets always render.
  doc.edgeTo("a", "d", "D");
  doc.edgeTo("a", "end1", "end", { shape: "terminal", pinned: true });
  // A dropped source: the pinned target stands alone, others are dropped.
  doc.edgeTo("c", "end2", "end", { shape: "terminal", pinned: true });
  doc.edgeTo("c", "e", "E", { arrow: "-.->" });
  doc.line("%% comment");
  assert.equal(doc.truncated, 3);
  const out = doc.render();
  assert.equal(
    out,
    [
      "flowchart TD",
      "  start([start])",
      '  subgraph S["phase"]',
      "    direction TB",
      '    a["A"]',
      '    b["B"]',
      "  end",
      "  start --> a",
      "  a --> end1([end])",
      "  end2([end])",
      "  %% comment",
      '  more_nodes["+3 more"]',
    ].join("\n"),
  );
  lintMermaid(out);
});

test("MermaidDoc without a cap hit renders no +N node", async () => {
  const doc = new MermaidDoc("flowchart LR", 5);
  doc.open("S", "t").close().close(); // an extra close does not underflow
  doc.edgeTo("x", "y", "Y", { shape: "db" });
  assert.equal(doc.truncated, 0);
  assert.doesNotMatch(doc.render(), /more_nodes/);

  // The default cap comes from SN_DIAGRAM_MAX_NODES.
  await withEnv({ SN_DIAGRAM_MAX_NODES: "1" }, () => {
    const capped = new MermaidDoc("flowchart TD");
    capped.node("a", "A");
    capped.node("b", "B");
    assert.equal(capped.truncated, 1);
  });
});
