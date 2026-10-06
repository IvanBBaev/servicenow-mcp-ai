// N-49: the `claude plugin eval` suite under evals/ needs a model key, so it
// never runs here. This file checks what can be checked offline: every skill
// has a trigger and a negative case, the case files use only the documented
// keys, every MCP tool a skill or grader names has a recorded mock, and the
// mocks are what the real server answers against the fake instance.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ALL_TOOLS } from "../build/mcp/registry.js";
import { buildOutputSchema } from "../build/mcp/define.js";
import {
  DEV_HOST,
  PROD_HOST,
  createDatasets,
  installFakeInstance,
  runQuery,
} from "./evals/fake-instance.js";
import {
  MOCK_DIR,
  MOCKED_TOOLS,
  SERVER_NAME,
  mockFiles,
  normalize,
  recordMocks,
} from "./evals/record-mocks.js";
import { realFetch } from "./helpers.js";

const root = join(import.meta.dirname, "..");
const evalsDir = join(root, "evals");
const specs = new Map(ALL_TOOLS.map((s) => [s.name, s]));
const MCP_PREFIX = `mcp__plugin_servicenow-mcp-ai_${SERVER_NAME}__`;
const TOOL_NAME = /\bservicenow_[a-z0-9_]+\b/g;

// The documented prompt.md and grader keys; an unknown key fails the case.
const PROMPT_KEYS = new Set([
  "schema_version",
  "name",
  "description",
  "tags",
  "plugins",
  "runs",
  "expected_outcome",
  "model",
  "max_turns",
  "timeout_seconds",
  "allowed_tools",
  "append_system_prompt",
  "env",
]);
const GRADER_KEYS = {
  regex: ["pattern", "flags", "match", "target"],
  tool_used: ["tool", "input_match", "min", "max"],
  tool_order: ["before", "after"],
  file_exists: ["path", "exists"],
  llm: ["criteria", "focus"],
  baseline: ["baseline_file", "criteria"],
};
const COMMON_GRADER_KEYS = ["type", "weight", "arm"];
// Recorded on purpose as an error: set_credentials needs a confirmation the
// recorder cannot give, and the refusal is what a skill should see.
const EXPECTED_ERRORS = new Set(["servicenow_set_credentials"]);

/** Top-level `key: value` pairs of a frontmatter block (comments skipped). */
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return undefined;
  const fields = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^'.*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
    else if (/^".*"$/.test(value)) value = JSON.parse(value);
    fields[kv[1]] = value;
  }
  return { fields, body: text.slice(m[0].length) };
}

const skills = readdirSync(join(root, "skills"))
  .filter((name) => existsSync(join(root, "skills", name, "SKILL.md")))
  .sort();

function caseDirs() {
  const out = [];
  const walk = (dir) => {
    if (existsSync(join(dir, "prompt.md"))) {
      out.push(dir);
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (["mocks", "results"].includes(entry.name)) continue;
      walk(join(dir, entry.name));
    }
  };
  walk(evalsDir);
  return out.sort();
}

function graders(dir) {
  const gdir = join(dir, "graders");
  if (!existsSync(gdir)) return [];
  return readdirSync(gdir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({
      name: f.slice(0, -3),
      ...frontmatter(readFileSync(join(gdir, f), "utf8")),
    }));
}

const cases = caseDirs();
const committedMocks = readdirSync(MOCK_DIR).filter((f) => f.endsWith(".md"));
const mockedNames = new Set(committedMocks.map((f) => f.slice(0, -3)));

const skillGrader = (gs, skill) =>
  gs.find(
    (g) =>
      g.fields?.type === "tool_used" &&
      g.fields.tool === "Skill" &&
      new RegExp(g.fields.input_match).test(
        `{"skill":"servicenow-mcp-ai:${skill}"}`,
      ),
  );

for (const skill of skills) {
  test(`skill ${skill} has a trigger and a negative eval case`, () => {
    const trigger = join(evalsDir, skill, `${skill}-trigger`);
    const negative = join(evalsDir, skill, `${skill}-negative`);
    assert.ok(cases.includes(trigger), `missing ${trigger}`);
    assert.ok(cases.includes(negative), `missing ${negative}`);

    const fired = skillGrader(graders(trigger), skill);
    assert.ok(fired, "the trigger case asserts the skill was invoked");
    assert.equal(fired.fields.max, undefined);

    const quiet = skillGrader(graders(negative), skill);
    assert.ok(quiet, "the negative case asserts the skill was not invoked");
    assert.equal(quiet.fields.min, "0");
    assert.equal(quiet.fields.max, "0");
    // A "must not invoke" check passes trivially without the plugin; it is
    // excluded from a two-arm score unless forced into both arms.
    assert.equal(quiet.fields.arm, "both");
  });

  test(`every tool skill ${skill} names has a recorded mock`, () => {
    const text = readFileSync(join(root, "skills", skill, "SKILL.md"), "utf8");
    const named = [...new Set(text.match(TOOL_NAME) ?? [])];
    assert.ok(named.length > 0);
    const missing = named.filter((n) => !mockedNames.has(n));
    assert.deepEqual(missing, [], "run `npm run eval:mocks`");
  });
}

for (const dir of cases) {
  const rel = dir.slice(evalsDir.length + 1);
  test(`eval case ${rel} uses only documented keys`, () => {
    const prompt = frontmatter(readFileSync(join(dir, "prompt.md"), "utf8"));
    assert.ok(prompt, "prompt.md needs a frontmatter block");
    for (const key of Object.keys(prompt.fields))
      assert.ok(PROMPT_KEYS.has(key), `unknown prompt.md key ${key}`);
    assert.ok(prompt.body.trim().length > 0, "the prompt body is empty");
    assert.equal(prompt.fields.plugins, '["../../.."]');
    assert.ok(
      existsSync(
        join(dir, prompt.fields.plugins.slice(2, -2), ".claude-plugin"),
      ),
      "plugins points at the plugin root",
    );

    const gs = graders(dir);
    assert.ok(gs.length > 0, "a case needs at least one grader");
    for (const g of gs) {
      const allowed = GRADER_KEYS[g.fields?.type];
      assert.ok(allowed, `${g.name}: unknown grader type ${g.fields?.type}`);
      for (const key of Object.keys(g.fields))
        assert.ok(
          COMMON_GRADER_KEYS.includes(key) || allowed.includes(key),
          `${g.name}: unknown key ${key}`,
        );
      if (g.fields.input_match) new RegExp(g.fields.input_match);
      if (g.fields.pattern) new RegExp(g.fields.pattern, g.fields.flags);
    }
  });

  test(`eval case ${rel} names only mocked MCP tools`, () => {
    const text = readdirSync(join(dir, "graders"))
      .map((f) => readFileSync(join(dir, "graders", f), "utf8"))
      .join("\n");
    const tools = [...text.matchAll(/\bmcp__[\w-]+__(\w+)/g)];
    for (const [full, tool] of tools) {
      assert.ok(full.startsWith(MCP_PREFIX), `${full}: wrong server prefix`);
      assert.ok(mockedNames.has(tool), `${tool} has no mock`);
    }
  });
}

test("every mock answers a registered tool, and _tools.json lists them", () => {
  for (const name of mockedNames)
    assert.ok(specs.has(name), `${name} is not a registered tool`);
  assert.deepEqual([...mockedNames].sort(), MOCKED_TOOLS);
  const listed = JSON.parse(
    readFileSync(join(MOCK_DIR, "_tools.json"), "utf8"),
  );
  assert.deepEqual(
    listed.tools.map((t) => t.name),
    MOCKED_TOOLS,
  );
  for (const tool of listed.tools) {
    assert.equal(tool.inputSchema?.type, "object", tool.name);
    assert.ok(tool.description, tool.name);
  }
});

test("committed mocks are valid answers of their tools", () => {
  for (const file of committedMocks) {
    const name = file.slice(0, -3);
    const { fields, body } = frontmatter(
      readFileSync(join(MOCK_DIR, file), "utf8"),
    );
    assert.equal(fields.type, "fixed", name);
    // A recorded body is returned verbatim; `{{` would be a substitution.
    assert.ok(!body.includes("{{"), `${name} contains a template marker`);
    if (fields.error === "true") {
      assert.ok(EXPECTED_ERRORS.has(name), `${name} recorded an error`);
      continue;
    }
    const answer = JSON.parse(body);
    const spec = specs.get(name);
    if (spec.output) {
      const parsed = buildOutputSchema(spec).safeParse(answer);
      assert.ok(parsed.success, `${name} matches its outputSchema`);
    }
  }
});

test("the recorder covers every mocked tool against the fake instance only", async () => {
  const recorded = await recordMocks();
  assert.deepEqual(recorded.forbidden, [], "no request left the fake hosts");
  assert.ok(recorded.requests > 0);
  assert.deepEqual([...recorded.answers.keys()].sort(), MOCKED_TOOLS);
  assert.equal(recorded.tools.length, MOCKED_TOOLS.length);
  assert.ok(recorded.tools.every(Boolean), "every mocked tool is listed");
  for (const [name, answer] of recorded.answers) {
    assert.equal(answer.isError, EXPECTED_ERRORS.has(name), name);
  }
  // The recorder rewrites exactly the committed file set (the contents are
  // compared by `npm run eval:mocks:check`, a step of `npm run check`).
  assert.deepEqual(
    [...mockFiles(recorded).keys()].sort(),
    [...committedMocks, "_tools.json"].sort(),
  );
  assert.equal(globalThis.fetch, realFetch, "the real fetch is restored");
});

test("normalize replaces run-specific values with stable stand-ins", () => {
  const ids = new Map();
  const text =
    '{"path":"/tmp/x/docs/a.md","pid":4242,"ms":17,"at":"2026-01-02T03:04:05.678Z",' +
    '"plan_token":"abc.def","entry":"01M45ZDBJZ722X42GMD7DQ977P"}';
  const out = normalize(text, "/tmp/x", ids);
  assert.equal(
    out,
    '{"path":"/home/eval/docs/a.md","pid":0,"ms":0,"at":"2026-10-01T09:30:00.000Z",' +
      '"plan_token":"pt-recorded-plan-token","entry":"01EVAL00000000000000000001"}',
  );
  // The same id keeps its stand-in; a new one gets the next.
  assert.match(normalize("01M45ZDBJZ722X42GMD7DQ977P", "/tmp/x", ids), /0001$/);
  assert.match(normalize("01M45ZDC2JSZ4AAET6GZ2MGSNY", "/tmp/x", ids), /0002$/);
});

test("normalize pins the server identity, uptime and byte counters", () => {
  const text =
    '{"server":{"name":"servicenow-mcp-ai","version":"2.3.4","uptimeSec":17,' +
    '"node":"24.1.0","transport":"stdio"},"http":{"userAgent":' +
    '"servicenow-mcp-ai/2.3.4 (node/24; stdio; unknown)"},"tools":{"t":' +
    '{"bytesTotal":854,"textBytes":427,"structuredBytes":427,"bytesP50":854,' +
    '"bytesP95":854}},"version":{"status":"unknown"}}';
  assert.equal(
    normalize(text, "/tmp/x"),
    '{"server":{"name":"servicenow-mcp-ai","version":"0.0.0-eval","uptimeSec":0,' +
      '"node":"22.0.0-eval","transport":"stdio"},"http":{"userAgent":' +
      '"servicenow-mcp-ai/0.0.0-eval (node/22; stdio; unknown)"},"tools":{"t":' +
      '{"bytesTotal":0,"textBytes":0,"structuredBytes":0,"bytesP50":0,' +
      '"bytesP95":0}},"version":{"status":"unknown"}}',
  );
});

test("runQuery evaluates encoded-query operators", () => {
  const rows = [
    {
      number: "INC1",
      priority: "1",
      short_description: "Mail down",
      state: "",
    },
    {
      number: "INC2",
      priority: "3",
      short_description: "VPN slow",
      state: "2",
    },
    {
      number: "INC3",
      priority: "1",
      short_description: "VPN down",
      state: "2",
    },
  ];
  const nums = (q) => runQuery(rows, q).map((r) => r.number);
  assert.deepEqual(nums("priority=1"), ["INC1", "INC3"]);
  assert.deepEqual(nums("priority!=1"), ["INC2"]);
  assert.deepEqual(nums("priorityIN1,3^short_descriptionLIKEVPN"), [
    "INC2",
    "INC3",
  ]);
  assert.deepEqual(nums("priorityNOT IN1"), ["INC2"]);
  assert.deepEqual(nums("short_descriptionSTARTSWITHMail"), ["INC1"]);
  assert.deepEqual(nums("short_descriptionENDSWITHdown"), ["INC1", "INC3"]);
  assert.deepEqual(nums("short_descriptionNOT LIKEVPN"), ["INC1"]);
  assert.deepEqual(nums("stateISEMPTY"), ["INC1"]);
  assert.deepEqual(nums("stateISNOTEMPTY^ORDERBYDESCnumber"), ["INC3", "INC2"]);
  assert.deepEqual(nums("priority=3^ORpriority=1^short_descriptionLIKEMail"), [
    "INC1",
  ]);
  assert.deepEqual(nums("priority=3^NQshort_descriptionLIKEMail"), [
    "INC1",
    "INC2",
  ]);
});

test("the fake instance answers its two hosts and refuses every other", async () => {
  const fake = installFakeInstance({ datasets: createDatasets() });
  try {
    const dev = await fetch(
      `https://${DEV_HOST}/api/now/table/incident?sysparm_query=priority=1&sysparm_fields=number`,
    );
    assert.equal(dev.status, 200);
    assert.deepEqual((await dev.json()).result, [{ number: "INC0010002" }]);
    const prod = await fetch(
      `https://${PROD_HOST}/api/now/table/u_vendor_contract`,
    );
    assert.deepEqual((await prod.json()).result, []);
    await assert.rejects(
      fetch("https://example.service-now.com/api/now/table/incident"),
      /refused request/,
    );
    assert.deepEqual(fake.forbidden, [
      "https://example.service-now.com/api/now/table/incident",
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
