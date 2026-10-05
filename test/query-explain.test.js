// N-15 — static explain of an encoded query against a table's indexes.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { explainQuery } from "../build/api/query-explain.js";

const INDEXES = [
  { name: "ix_number", table: "task", fields: ["number"], unique: true },
  {
    name: "ix_state_opened",
    table: "task",
    fields: ["state", "opened_at"],
    unique: false,
  },
];

test("an equality on a leading index column is indexed", () => {
  const r = explainQuery("number=INC0010001^active=true", INDEXES);
  assert.equal(r.indexFriendly, true);
  assert.deepEqual(
    r.conditions.map((c) => [c.field, c.operator, c.indexed, c.index]),
    [
      ["number", "=", true, "ix_number"],
      ["active", "=", false, undefined],
    ],
  );
  assert.deepEqual(r.notes, []);
});

test("LIKE, a non-leading composite column and no index all scan", () => {
  const r = explainQuery(
    "short_descriptionLIKEdisk^opened_at>2026-01-01",
    INDEXES,
  );
  assert.equal(r.indexFriendly, false);
  const [like, opened] = r.conditions;
  assert.equal(like.indexed, false);
  assert.match(like.note, /LIKE cannot use an index/);
  assert.equal(opened.note, "only a non-leading column of a composite index");
  assert.match(r.notes[0], /scans the table/);
  assert.ok(r.notes.some((n) => /LIKE \/ CONTAINS/.test(n)));
});

test("STARTSWITH on an indexed field is a range scan; ORDERBY is checked", () => {
  const r = explainQuery(
    "numberSTARTSWITHINC001^ORDERBYDESCsys_created_on^ORDERBYnumber",
    INDEXES,
  );
  assert.equal(r.indexFriendly, true);
  assert.equal(r.conditions[0].note, "index range scan (prefix match)");
  assert.deepEqual(r.orderBy, [
    { field: "sys_created_on", desc: true, indexed: false },
    { field: "number", desc: false, indexed: true },
  ]);
  assert.ok(r.notes.some((n) => /ORDERBY sys_created_on has no index/.test(n)));
});

test("an ^OR with an unindexed side and an unindexed ^NQ block are flagged", () => {
  const or = explainQuery("number=INC1^ORcategory=disk", INDEXES);
  assert.equal(or.indexFriendly, false);
  assert.equal(or.conditions[1].or, true);
  assert.ok(or.notes.some((n) => /\^OR with an unindexed side/.test(n)));

  const nq = explainQuery("number=INC1^NQcategory=disk", INDEXES);
  assert.equal(nq.indexFriendly, false);
  assert.match(nq.notes[0], /block\(s\) 1/);
});

test("dot-walks, sys_id and unparseable terms", () => {
  const r = explainQuery(
    "caller_id.name=Bob^sys_id=abc^javascript:gs.getUserID()",
    [],
  );
  assert.equal(r.conditions[0].indexed, false);
  assert.match(r.conditions[0].note, /dot-walked/);
  assert.equal(r.conditions[1].index, "sys_id");
  assert.ok(r.notes.some((n) => /Not explained.*javascript/.test(n)));
  assert.equal(explainQuery("", INDEXES).indexFriendly, true);
});

test("property: a condition is indexed iff its field leads an index and the operator is sargable", () => {
  const field = fc.constantFrom("number", "state", "opened_at", "category");
  const op = fc.constantFrom("=", "!=", "IN", "LIKE", "STARTSWITH", ">=");
  const leading = new Set(["number", "state"]);
  const sargable = new Set(["=", "IN", "STARTSWITH", ">="]);
  fc.assert(
    fc.property(
      fc.array(fc.tuple(field, op, fc.stringMatching(/^[A-Za-z0-9]{1,6}$/)), {
        minLength: 1,
        maxLength: 6,
      }),
      (terms) => {
        const q = terms.map(([f, o, v]) => `${f}${o}${v}`).join("^");
        const r = explainQuery(q, INDEXES);
        assert.equal(r.conditions.length, terms.length);
        r.conditions.forEach((c, i) => {
          const [f, o] = terms[i];
          assert.equal(c.field, f);
          assert.equal(c.operator, o);
          assert.equal(c.indexed, leading.has(f) && sargable.has(o));
        });
        assert.equal(
          r.indexFriendly,
          r.conditions.some((c) => c.indexed),
        );
      },
    ),
  );
});
