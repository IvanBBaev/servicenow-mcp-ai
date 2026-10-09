// P-11 — decision tables through the P-6 machinery (`servicenow_explain_artifact`,
// artifactType `decision_table`): the inputs and rows are explained in order
// with their condition and answer, default and inactive rows are marked, a
// capped or unreadable child table is noted, and the whole explanation stays
// verified:false (the sys_decision* fields are unconfirmed, gate O-5).
import test from "node:test";
import assert from "node:assert/strict";

import { getArtifactType } from "../build/core/artifacts/registry.js";
import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

baselineEnv();

const SDK_OFF = { SN_SDK_MANAGED_SCOPES: undefined, SN_SDK_PROJECT_DIRS: "" };
const id = (c) => c.repeat(32 / c.length);
const TABLE = id("d7");

const tool = (name) => ALL_TOOLS.find((s) => s.name === name);

/** Applies the `field=value` / `ORDERBYfield` clauses the artefact reader sends. */
function filterRows(rows, query) {
  let out = [...rows];
  for (const clause of (query ?? "").split("^").filter(Boolean)) {
    if (clause.startsWith("ORDERBY")) continue;
    const m = clause.match(/^(\w+)=(.*)$/);
    assert.ok(m, `unsupported clause ${clause}`);
    out = out.filter((r) => String(r[m[1]] ?? "") === m[2]);
  }
  return out;
}

function tableMock(tables) {
  return (url) => {
    const u = new URL(url);
    const m = u.pathname.match(/\/api\/now\/table\/([^/]+)(?:\/([^/]+))?$/);
    assert.ok(m, `unexpected request ${url}`);
    const value = tables[m[1]];
    if (typeof value === "function") return value(u.searchParams, m[2]);
    if (m[2]) {
      if (!value || Array.isArray(value)) {
        return jsonResponse(404, { error: { message: "No Record found" } });
      }
      return jsonResponse(200, { result: value });
    }
    if (Array.isArray(value)) {
      const query = u.searchParams.get("sysparm_query");
      return jsonResponse(200, { result: filterRows(value, query) });
    }
    return jsonResponse(200, { result: value ? [value] : [] });
  };
}

async function explain(tables) {
  freshRuntime();
  return withEnv(SDK_OFF, () =>
    withFetch(tableMock(tables), async () => {
      const res = await runSpec(tool("servicenow_explain_artifact"), {
        artifactType: "decision_table",
        sys_id: TABLE,
      });
      if (res.isError) return { error: res.content[0].text };
      return res.structuredContent;
    }),
  );
}

const DECISION = {
  sys_decision: {
    sys_id: TABLE,
    name: "Assignment by priority",
    answer_table: "sys_user_group",
  },
  sys_decision_input: [
    {
      sys_id: id("e2"),
      model: TABLE,
      element: "u_category",
      label: "Category",
      order: "200",
      internal_type: "string",
    },
    {
      sys_id: id("e1"),
      model: TABLE,
      element: "u_priority",
      label: "Priority",
      order: "100",
    },
    // Another table's input: never part of this one.
    { sys_id: id("e9"), model: id("ff"), element: "x", label: "X", order: "1" },
  ],
  sys_decision_question: [
    {
      sys_id: id("f3"),
      decision_table: TABLE,
      order: "300",
      label: "Fallback",
      answer: id("a3"),
      default_answer: "true",
    },
    {
      sys_id: id("f1"),
      decision_table: TABLE,
      order: "100",
      label: "P1",
      condition: "u_priority=1^EQ",
      answer: id("a1"),
    },
    {
      sys_id: id("f2"),
      decision_table: TABLE,
      order: "200",
      condition: "u_category=network^EQ",
      active: "false",
    },
  ],
};

test("P-11: decision_table is explained (R + X) and stays verified:false", () => {
  const t = getArtifactType("decision_table");
  assert.deepEqual(t.tiers, ["R", "X"]);
  assert.equal(t.verified, false);
});

test("P-11: a decision table explains its inputs and rows in order", async () => {
  const ex = await explain(DECISION);
  assert.equal(ex.error, undefined, ex.error);
  const x = ex.explanation;
  assert.equal(x.kind, "decision-table");
  assert.equal(x.answerTable, "sys_user_group");
  assert.equal(x.verified, false);
  assert.deepEqual(
    x.inputs.map((i) => [i.order, i.element, i.label, i.type]),
    [
      ["100", "u_priority", "Priority", undefined],
      ["200", "u_category", "Category", "string"],
    ],
  );
  assert.deepEqual(x.rows, [
    {
      sys_id: id("f1"),
      order: "100",
      label: "P1",
      condition: "u_priority=1^EQ",
      answer: id("a1"),
    },
    {
      sys_id: id("f2"),
      order: "200",
      condition: "u_category=network^EQ",
      inactive: true,
    },
    {
      sys_id: id("f3"),
      order: "300",
      label: "Fallback",
      answer: id("a3"),
      default: true,
    },
  ]);
  assert.equal(
    x.lines[0],
    "Decision table 'Assignment by priority' answering from sys_user_group: 2 input(s), 3 row(s).",
  );
  assert.equal(
    x.lines[1],
    "Inputs: Priority (u_priority), Category (u_category) [string].",
  );
  assert.equal(x.lines[2], `1. P1: when u_priority=1^EQ -> ${id("a1")}`);
  assert.equal(
    x.lines[3],
    "2. (unlabelled): when u_category=network^EQ -> (no answer) [inactive]",
  );
  assert.equal(
    x.lines[4],
    `3. Fallback: when (always) -> ${id("a3")} [default]`,
  );
  assert.match(x.lines.at(-1), /verified:false.*gate O-5/);
});

test("P-11: an empty decision table, a rejected input read and a capped row read", async () => {
  const empty = await explain({
    sys_decision: { sys_id: TABLE, name: "Empty" },
  });
  assert.equal(empty.error, undefined, empty.error);
  assert.equal(empty.explanation.answerTable, undefined);
  assert.deepEqual(empty.explanation.inputs, []);
  assert.deepEqual(empty.explanation.rows, []);
  assert.equal(
    empty.explanation.lines[0],
    "Decision table 'Empty': 0 input(s), 0 row(s).",
  );
  assert.equal(empty.explanation.lines.length, 2);

  const many = Array.from({ length: 201 }, (_, i) => ({
    sys_id: `${String(i).padStart(3, "0")}${"0".repeat(29)}`,
    decision_table: TABLE,
    order: String(i),
    answer: "x",
  }));
  // The 200-row cap is under test, not the M-6 size budget (48,000 by default).
  const degraded = await withEnv({ SN_MAX_RESULT_CHARS: "100000" }, () =>
    explain({
      ...DECISION,
      sys_decision_input: () =>
        jsonResponse(403, { error: { message: "ACL denied" } }),
      sys_decision_question: many,
    }),
  );
  assert.equal(degraded.error, undefined, degraded.error);
  const x = degraded.explanation;
  assert.deepEqual(x.inputs, []);
  assert.equal(x.rows.length, 200);
  assert.ok(
    x.lines.includes(
      "sys_decision_question was capped; some rows are not shown.",
    ),
    x.lines.join("\n"),
  );
  assert.ok(
    x.lines.some((l) =>
      /^sys_decision_input was not read: rejected by the instance \(403\)\.$/.test(
        l,
      ),
    ),
    x.lines.join("\n"),
  );
});
