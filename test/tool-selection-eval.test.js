// N-18: the tool-selection eval harness (evals/tool-selection/). Offline only:
// the case loader, the surface builder, scoring, the lexical and recorded
// backends, and the Anthropic backend against a stubbed fetch. Eval accuracy
// is the runner's job, but description drift fails here: every tool the
// cases expect must still have the description hash recorded in
// evals/tool-selection/description-hashes.json (TOKEN-OPTIMIZATION-PLAN N-57
// gate). After a fresh eval, `npm run eval:tools -- --write-hashes` updates it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PACKAGE_RESCUE,
  PROFILE_ENV,
  buildSurface,
  caseToolNames,
  compareToBaseline,
  createAnthropicBackend,
  createLexicalBackend,
  createRecordedBackend,
  descriptionDrift,
  descriptionDriftMessage,
  descriptionHashFixture,
  descriptionHashes,
  effectiveExpected,
  evaluate,
  loadCases,
  scoreCase,
  summarize,
  validateArgs,
  validateCases,
} from "../evals/tool-selection/lib.mjs";
import { describeAllTools } from "../build/mcp/registry.js";
import { listPublishedTools } from "./surface.js";

const CASES = new URL("../evals/tool-selection/cases.json", import.meta.url);
const HASHES = new URL(
  "../evals/tool-selection/description-hashes.json",
  import.meta.url,
);
const KNOWN = new Set(describeAllTools().map((t) => t.name));

const tool = (name, extra = {}) => ({
  name,
  title: name,
  description: `${name.replace(/_/g, " ")} tool`,
  inputSchema: { type: "object", properties: {} },
  ...extra,
});

const WRITE_SCHEMA = {
  type: "object",
  properties: {
    table: { type: "string" },
    values: { type: "object" },
    apply: { type: "boolean" },
  },
  required: ["table", "values"],
  additionalProperties: false,
};

const fixture = () => {
  const core = [
    tool("servicenow_query_table"),
    tool("servicenow_create_record", { inputSchema: WRITE_SCHEMA }),
    tool("servicenow_enable_package"),
    tool("servicenow_list_packages"),
  ];
  const all = [
    ...core,
    tool("servicenow_search_code"),
    tool("servicenow_list_cis"),
  ];
  return { core, all };
};

test("the shipped case set is valid and names only real tools", () => {
  const { cases, sha256 } = loadCases(CASES, KNOWN);
  assert.ok(cases.length >= 100);
  assert.match(sha256, /^[0-9a-f]{64}$/);
  for (const kind of ["positive", "cluster", "write", "negative"]) {
    assert.ok(
      cases.some((c) => c.kind === kind),
      `no ${kind} case`,
    );
  }
});

test("validateCases reports structural problems", () => {
  const errors = validateCases(
    {
      cases: [
        { id: "ok", kind: "positive", prompt: "list cis", expected: ["x"] },
        { id: "ok", kind: "negative", prompt: "hello", expected: ["x"] },
        { id: "Bad Id", kind: "weird", prompt: "", expected: [] },
        { id: "cl", kind: "cluster", prompt: "abc", expected: ["x"] },
      ],
    },
    new Set(["y"]),
  );
  const text = errors.join("\n");
  assert.match(text, /duplicate id/);
  assert.match(text, /negative case expects no tool/);
  assert.match(text, /kebab-case/);
  assert.match(text, /kind must be/);
  assert.match(text, /only negative cases/);
  assert.match(text, /cluster label/);
  assert.match(text, /unknown tool x/);
  assert.deepEqual(validateCases({}), [
    "case file must be an object with a `cases` array",
  ]);
});

test("buildSurface: core, all, and the simulated discovery stubs", () => {
  const pub = fixture();
  assert.equal(buildSurface("core", pub).tools.length, 4);
  assert.equal(buildSurface("all", pub).tools.length, 6);
  const disc = buildSurface("discovery", pub);
  assert.equal(disc.tools.length, 6);
  const stub = disc.tools.find((t) => t.name === "servicenow_search_code");
  assert.equal(stub.stub, true);
  assert.deepEqual(stub.inputSchema, { type: "object" });
  assert.ok(!disc.tools.find((t) => t.name === "servicenow_query_table").stub);
  assert.throws(() => buildSurface("nope", pub), /unknown profile/);
});

test("effectiveExpected falls back to package tools when nothing is loaded", () => {
  const names = new Set(["servicenow_query_table", ...PACKAGE_RESCUE]);
  const c = (expected) => ({
    id: "c",
    kind: "positive",
    prompt: "p",
    expected,
  });
  assert.deepEqual(effectiveExpected(c(["servicenow_query_table"]), names), [
    "servicenow_query_table",
  ]);
  assert.deepEqual(
    effectiveExpected(
      c(["servicenow_list_cis", "servicenow_query_table"]),
      names,
    ),
    ["servicenow_query_table"],
  );
  assert.deepEqual(
    effectiveExpected(c(["servicenow_list_cis"]), names),
    PACKAGE_RESCUE,
  );
  assert.deepEqual(effectiveExpected(c([]), names), []);
});

test("validateArgs checks required, unknown and typed properties", () => {
  assert.deepEqual(
    validateArgs(WRITE_SCHEMA, { table: "incident", values: {} }),
    [],
  );
  assert.deepEqual(validateArgs(WRITE_SCHEMA, { table: 5, extra: 1 }), [
    "missing values",
    "table has the wrong type",
    "unknown extra",
  ]);
  assert.deepEqual(validateArgs(WRITE_SCHEMA, null), [
    "input is not an object",
  ]);
});

test("scoreCase: correctness, abstention, plan-first and expected args", () => {
  const surface = buildSurface("core", fixture());
  const write = {
    id: "w",
    kind: "write",
    prompt: "create",
    expected: ["servicenow_create_record"],
    args: { table: "incident" },
  };
  const planned = scoreCase(
    write,
    {
      tool: "servicenow_create_record",
      input: { table: "incident", values: { short_description: "x" } },
    },
    surface,
  );
  assert.equal(planned.correct, true);
  assert.equal(planned.planFirst, true);
  assert.deepEqual(planned.argProblems, []);

  const applied = scoreCase(
    write,
    {
      tool: "servicenow_create_record",
      input: { table: "problem", values: {}, apply: true },
    },
    surface,
  );
  assert.equal(applied.planFirst, false);
  assert.deepEqual(applied.argProblems, ["table != incident"]);

  const neg = { id: "n", kind: "negative", prompt: "hi", expected: [] };
  assert.equal(scoreCase(neg, { tool: null }, surface).correct, true);
  assert.equal(
    scoreCase(neg, { tool: "servicenow_query_table" }, surface).correct,
    false,
  );

  const ghost = scoreCase(write, { tool: "servicenow_nope" }, surface);
  assert.equal(ghost.unknownTool, true);
  assert.equal(ghost.argProblems, undefined, "no input, no argument metric");
});

test("summarize: accuracy groups and confusion pairs", () => {
  const r = (id, kind, pkg, correct, pick, expected = ["servicenow_a"]) => ({
    id,
    kind,
    package: pkg,
    cluster: kind === "cluster" ? "k" : null,
    expected,
    pick,
    correct,
  });
  const s = summarize([
    r("1", "positive", "table", true, "servicenow_a"),
    r("2", "positive", "table", false, "servicenow_b"),
    r("3", "cluster", "scripts", false, "servicenow_b"),
    r("4", "negative", "(none)", false, "servicenow_c", []),
  ]);
  assert.equal(s.top1, 25);
  assert.deepEqual(s.byPackage.table, { n: 2, correct: 1, accuracy: 50 });
  assert.deepEqual(s.byCluster, { k: { n: 1, correct: 0, accuracy: 0 } });
  assert.deepEqual(s.confusion[0], {
    pair: "servicenow_a -> servicenow_b",
    count: 2,
  });
  assert.equal(s.confusion[1].pair, "(no tool) -> servicenow_c");
  assert.equal(s.argValidity, null);
  assert.equal(s.planFirst, null);
});

test("lexical backend is deterministic and abstains on unrelated text", async () => {
  const surface = buildSurface("all", fixture());
  const lex = createLexicalBackend();
  const a = await lex.pick("search code for gs.sleep", surface);
  const b = await lex.pick("search code for gs.sleep", surface);
  assert.equal(a.tool, "servicenow_search_code");
  assert.deepEqual(a, b);
  assert.equal((await lex.pick("zebra quantum violin", surface)).tool, null);
});

test("recorded backend replays answers and flags missing ones", async () => {
  const surface = buildSurface("core", fixture());
  const rec = createRecordedBackend({
    model: "m",
    answers: { core: { a: { tool: "servicenow_query_table", input: {} } } },
  });
  assert.equal(rec.model, "recorded:m");
  assert.equal(
    (await rec.pick("", surface, { id: "a" })).tool,
    "servicenow_query_table",
  );
  const missing = await rec.pick("", surface, { id: "b" });
  assert.equal(missing.tool, null);
  assert.equal(missing.error, "no recorded answer");
  assert.throws(() => createRecordedBackend({}), /answers/);
});

test("anthropic backend: request shape, tool_use parsing, retry, errors", async () => {
  const surface = buildSurface("core", fixture());
  const calls = [];
  const replies = [
    { status: 529, body: { type: "error" } },
    {
      status: 200,
      body: {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Let me look." },
          {
            type: "tool_use",
            id: "t1",
            name: "servicenow_query_table",
            input: { table: "incident" },
          },
        ],
        usage: { input_tokens: 1200, output_tokens: 40 },
      },
    },
    {
      status: 200,
      body: {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "No." }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    },
    { status: 200, body: { stop_reason: "refusal", content: [] } },
    { status: 400, body: { type: "error", error: { message: "bad" } } },
  ];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init: { ...init, body: JSON.parse(init.body) } });
    const r = replies.shift();
    return {
      status: r.status,
      ok: r.status < 300,
      headers: new Map(),
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
  const api = createAnthropicBackend({
    apiKey: "k",
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(api.model, "claude-sonnet-5-5");

  const first = await api.pick("list incidents", surface);
  assert.deepEqual(first, {
    tool: "servicenow_query_table",
    input: { table: "incident" },
    usage: { input_tokens: 1200, output_tokens: 40 },
  });
  assert.equal(calls.length, 2, "529 is retried");
  const { url, init } = calls[1];
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(init.headers["x-api-key"], "k");
  assert.equal(init.headers["anthropic-version"], "2023-06-01");
  assert.equal(init.body.model, "claude-sonnet-5-5");
  assert.deepEqual(init.body.tool_choice, {
    type: "auto",
    disable_parallel_tool_use: true,
  });
  assert.equal(init.body.tools.length, surface.tools.length);
  assert.deepEqual(Object.keys(init.body.tools[0]).sort(), [
    "description",
    "input_schema",
    "name",
  ]);
  assert.deepEqual(init.body.messages, [
    { role: "user", content: "list incidents" },
  ]);

  assert.equal((await api.pick("hi", surface)).tool, null);
  assert.equal((await api.pick("x", surface)).error, "refusal");
  assert.match((await api.pick("x", surface)).error, /^HTTP 400/);
  assert.throws(() => createAnthropicBackend({}), /ANTHROPIC_API_KEY/);
});

test("evaluate + baseline comparison and description drift", async () => {
  const pub = fixture();
  const surface = buildSurface("core", pub);
  const cases = [
    {
      id: "a",
      kind: "positive",
      prompt: "q",
      expected: ["servicenow_query_table"],
    },
    {
      id: "b",
      kind: "positive",
      prompt: "q",
      expected: ["servicenow_list_cis"],
    },
  ];
  const backend = {
    id: "fake",
    model: "fake",
    pick: async () => ({ tool: "servicenow_query_table" }),
  };
  const { results, summary } = await evaluate({
    cases,
    surface,
    backend,
    concurrency: 2,
  });
  assert.equal(summary.top1, 50);
  assert.deepEqual(results[1].expected, PACKAGE_RESCUE);

  const baseline = {
    profiles: { core: { top1: 100 } },
    picks: { core: { a: { correct: true }, b: { correct: true } } },
  };
  const cmp = compareToBaseline(baseline, {
    profiles: { core: summary },
    results: { core: results },
  });
  assert.deepEqual(cmp.core, {
    before: 100,
    after: 50,
    delta: -50,
    fixed: [],
    broken: ["b"],
  });

  const before = descriptionHashes(pub.all);
  const changed = pub.all.map((t) =>
    t.name === "servicenow_list_cis" ? { ...t, description: "new" } : t,
  );
  const after = descriptionHashes([
    ...changed.slice(1),
    tool("servicenow_new"),
  ]);
  assert.deepEqual(descriptionDrift(before, after), {
    changed: ["servicenow_list_cis"],
    added: ["servicenow_new"],
    removed: ["servicenow_query_table"],
  });
});

test("the offline baseline, when present, is a lexical baseline", () => {
  let baseline;
  try {
    baseline = JSON.parse(
      readFileSync(
        new URL(
          "../evals/tool-selection/baseline.offline.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  } catch {
    return;
  }
  assert.equal(baseline.backend, "lexical");
  for (const profile of Object.values(baseline.profiles)) {
    assert.equal(typeof profile.top1, "number");
  }
});

test("caseToolNames, the hash fixture and the drift message", () => {
  const cases = [
    { id: "a", expected: ["servicenow_query_table"] },
    { id: "b", expected: ["servicenow_list_cis", "servicenow_query_table"] },
    { id: "c", expected: [] },
  ];
  const names = caseToolNames(cases);
  assert.deepEqual(names, ["servicenow_list_cis", "servicenow_query_table"]);
  const { all } = fixture();
  const hashes = descriptionHashFixture(all, names, {
    backend: "lexical",
    model: "m",
  });
  assert.deepEqual(hashes.eval, { backend: "lexical", model: "m" });
  assert.deepEqual(Object.keys(hashes.descriptions), names);
  assert.match(hashes.note, /--write-hashes/);

  assert.equal(
    descriptionDriftMessage({ changed: [], added: [], removed: [] }),
    "",
  );
  const msg = descriptionDriftMessage({
    changed: ["servicenow_list_cis"],
    added: ["servicenow_new"],
    removed: ["servicenow_old"],
  });
  assert.match(msg, /descriptions changed: servicenow_list_cis/);
  assert.match(msg, /tools not hashed yet: servicenow_new/);
  assert.match(msg, /hashed tools gone: servicenow_old/);
  assert.match(msg, /npm run eval:tools -- --write-hashes/);
});

test("every eval tool keeps the description hash of the last tool-selection eval", async () => {
  const { cases } = loadCases(CASES, KNOWN);
  const recorded = JSON.parse(readFileSync(HASHES, "utf8"));
  assert.equal(recorded.schema, 1);
  const names = new Set(caseToolNames(cases));
  const published = (await listPublishedTools(PROFILE_ENV.all)).filter((t) =>
    names.has(t.name),
  );
  const drift = descriptionDrift(
    recorded.descriptions,
    descriptionHashes(published),
  );
  // A tool the cases expect but the server no longer publishes is "gone".
  for (const name of names) {
    if (
      !published.some((t) => t.name === name) &&
      !drift.removed.includes(name)
    )
      drift.removed.push(name);
  }
  const message = descriptionDriftMessage(drift);
  assert.equal(message, "", message);
});
