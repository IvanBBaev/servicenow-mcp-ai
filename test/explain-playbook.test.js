// P-12 — servicenow_explain_flow kind:"playbook": a fixture Process Automation
// Designer playbook (sys_pd_process_definition) with three lanes, activities
// with their definitions and a timer, triggers, inputs / outputs, variants and
// opt-in runs (sys_pd_context + sys_pd_activity_context). Acceptance: the lanes
// render as Mermaid subgraphs (golden playbook.mmd). An instance without the
// sys_pd_* family answers available:false with a caveat, never an error.
// Regenerate the golden deliberately with `UPDATE_GOLDEN=1 npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import { explainFlow, flowMarkdown } from "../build/api/explain-flow.js";
import { lintMermaid } from "./mermaid-lint.js";
import {
  assertMetadataUrl,
  baselineEnv,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "explain",
);

const id = (c) => c.repeat(32);
const PB = id("5");
const [L1, L2, L3] = ["6a", "6b", "6c"].map((p) => p.repeat(16));
const [A1, A2, A3, A4] = ["7a", "7b", "7c", "7d"].map((p) => p.repeat(16));
const [D1, D2] = ["8a", "8b"].map((p) => p.repeat(16));

function fixture() {
  return {
    sys_pd_process_definition: [
      {
        sys_id: PB,
        label: "Laptop Onboarding",
        name: "laptop_onboarding",
        table: "sn_hr_core_case",
        status: "published",
        active: "true",
        description: "Guides an agent\nthrough onboarding.",
      },
    ],
    sys_pd_lane: [
      // Out of order on purpose: the lane order wins.
      {
        sys_id: L2,
        process_definition: PB,
        label: "Fulfil",
        order: "200",
        condition: "state=2",
      },
      { sys_id: L1, process_definition: PB, label: "Intake", order: "100" },
      { sys_id: L3, process_definition: PB, label: "Close", order: "300" },
      { sys_id: "other", process_definition: id("9"), label: "Elsewhere" },
    ],
    sys_pd_activity: [
      {
        sys_id: A2,
        lane: L1,
        label: "Approve Request",
        order: "200",
        activity_definition: D2,
        condition: "approval=requested",
      },
      {
        sys_id: A1,
        lane: L1,
        label: "Collect Details",
        order: "100",
        activity_definition: D1,
      },
      {
        sys_id: A3,
        lane: L2,
        label: "Ship Laptop",
        order: "100",
        activity_definition: "",
      },
      // A definition that is not readable keeps its sys_id only.
      {
        sys_id: A4,
        lane: L2,
        name: "wait_delivery",
        order: "200",
        activity_definition: id("e"),
      },
    ],
    sys_pd_activity_definition: [
      { sys_id: D1, label: "Form" },
      { sys_id: D2, name: "approval" },
    ],
    sys_pd_timer_attributes: [
      { sys_id: "tm1", activity: A4, name: "Delivery SLA", duration: "2 days" },
      { sys_id: "tm2", activity: A4, type: "reminder" },
    ],
    sys_pd_trigger_instance: [
      {
        sys_id: "tr1",
        process_definition: PB,
        trigger_definition: "td1",
        "trigger_definition.name": "Record Created",
        table: "sn_hr_core_case",
        condition: "hr_service=laptop",
      },
      {
        sys_id: "tr2",
        process_definition: PB,
        name: "Manual start",
        trigger_type: "manual",
      },
    ],
    sys_pd_process_input: [
      {
        sys_id: "in1",
        model: PB,
        element: "case",
        label: "Case",
        internal_type: "reference",
        mandatory: "true",
        order: "1",
      },
    ],
    sys_pd_process_output: [
      {
        sys_id: "out1",
        model: PB,
        element: "asset_tag",
        label: "Asset tag",
        internal_type: "string",
        order: "1",
      },
    ],
    sys_pd_process_variant: [
      {
        sys_id: "v1",
        process_definition: PB,
        label: "EMEA",
        active: "true",
        condition: "location.region=emea",
        order: "1",
      },
      {
        sys_id: "v2",
        process_definition: PB,
        name: "legacy",
        active: "false",
        order: "2",
      },
    ],
    sys_pd_context: [
      {
        sys_id: "pc1",
        process_definition: PB,
        name: "Laptop Onboarding",
        state: "in_progress",
        sys_created_on: "2026-09-20 08:00:00",
        table: "sn_hr_core_case",
        document: "hr1",
      },
      {
        sys_id: "pc2",
        process_definition: PB,
        state: "complete",
        sys_created_on: "2026-09-10 08:00:00",
        ended: "2026-09-12 08:00:00",
      },
    ],
    sys_pd_activity_context: [
      { sys_id: "ac1", context: "pc1", state: "complete" },
      { sys_id: "ac2", context: "pc1", state: "complete" },
      { sys_id: "ac3", context: "pc1", state: "in_progress" },
      { sys_id: "ac4", context: "pc2" },
      { sys_id: "ac5", context: "zz", state: "complete" },
    ],
    sys_db_object: [{ name: "sys_pd_process_definition" }],
  };
}

function matchTerm(row, term) {
  let m;
  if ((m = /^(\w+)IN(.*)$/.exec(term))) {
    return m[2].split(",").includes(String(row[m[1]] ?? ""));
  }
  if ((m = /^(\w+)=(.*)$/.exec(term))) return String(row[m[1]] ?? "") === m[2];
  throw new Error(`unsupported term ${term}`);
}

const matches = (row, query) => {
  const body = query.split("^ORDERBY")[0];
  if (!body || body.startsWith("ORDERBY")) return true;
  return body.split("^").every((t) => matchTerm(row, t));
};

/** A Table API mock over `tables`; `status[table]` answers with an error. */
function instance(tables = fixture(), status = {}) {
  const reads = [];
  const handler = (url) => {
    const u = new URL(url);
    const table = u.pathname.match(/\/api\/now\/table\/([^/]+)$/)[1];
    reads.push(table);
    if (status[table]) {
      return jsonResponse(status[table], {
        error: { message: `denied ${table}`, detail: "ACL" },
      });
    }
    const query = u.searchParams.get("sysparm_query") ?? "";
    const fields = u.searchParams.get("sysparm_fields")?.split(",");
    const limit = Number(u.searchParams.get("sysparm_limit") ?? 1000);
    const rows = (tables[table] ?? [])
      .filter((r) => matches(r, query))
      .slice(0, limit)
      .map((r) =>
        Object.fromEntries(fields.filter((f) => f in r).map((f) => [f, r[f]])),
      );
    return jsonResponse(200, { result: rows });
  };
  return { handler, reads };
}

const spec = ALL_TOOLS.find((s) => s.name === "servicenow_explain_flow");
const payload = (result) => {
  assert.equal(result.isError, undefined, result.content[0].text);
  return JSON.parse(result.content[0].text);
};

/** Definition tables of the sys_pd_* family; the runtime ones only on opt-in. */
const DEFINITION_EXTRA = /^sys_pd_[a-z_]+$/;
const RUNTIME = new Set(["sys_pd_context", "sys_pd_activity_context"]);

async function run(args, mock = instance()) {
  const optIn = (args.runs ?? 0) > 0;
  return withFetch(
    (url, ...rest) => {
      const table = /\/api\/now\/table\/([^/?]+)/.exec(url)?.[1] ?? "";
      if (RUNTIME.has(table)) {
        assert.ok(optIn, `runtime table read without opt-in: ${table}`);
      } else if (!DEFINITION_EXTRA.test(table)) {
        assertMetadataUrl(url);
      }
      return mock.handler(url, ...rest);
    },
    () => runSpec(spec, { kind: "playbook", ...args }),
  );
}

test("P-12: explain_flow accepts kind:'playbook'", () => {
  assert.equal(spec.input.kind.safeParse("playbook").success, true);
  assert.ok(spec.description.length <= 250);
  assert.match(spec.description, /playbook/);
});

test("P-12: the playbook's lanes, activities, triggers, variables and variants", async () => {
  const mock = instance();
  const res = payload(await run({ sys_id: PB }, mock));
  assert.equal(res.kind, "playbook");
  assert.equal(res.verified, false);
  assert.equal(res.name, "Laptop Onboarding");
  assert.deepEqual(res.playbook, {
    sys_id: PB,
    name: "Laptop Onboarding",
    internal_name: "laptop_onboarding",
    table: "sn_hr_core_case",
    status: "published",
    active: true,
    description: "Guides an agent\nthrough onboarding.",
  });
  assert.deepEqual(
    res.lanes.map((l) => [l.number, l.name, l.condition]),
    [
      ["1", "Intake", undefined],
      ["2", "Fulfil", "state=2"],
      ["3", "Close", undefined],
    ],
  );
  assert.deepEqual(
    res.lanes.flatMap((l) => l.activities).map((a) => [a.number, a.name]),
    [
      ["1.1", "Collect Details"],
      ["1.2", "Approve Request"],
      ["2.1", "Ship Laptop"],
      ["2.2", "wait_delivery"],
    ],
  );
  const [collect, approve] = res.lanes[0].activities;
  assert.deepEqual(collect.definition, { sys_id: D1, name: "Form" });
  assert.deepEqual(approve.definition, { sys_id: D2, name: "approval" });
  assert.equal(approve.condition, "approval=requested");
  const [ship, wait] = res.lanes[1].activities;
  assert.equal(ship.definition, undefined);
  assert.deepEqual(wait.definition, { sys_id: id("e") });
  assert.deepEqual(
    wait.timers.map((t) => t.sys_id),
    ["tm1", "tm2"],
  );
  assert.equal(res.lanes[2].activities.length, 0);
  assert.deepEqual(
    res.triggers.map((t) => [t.sys_id, t.name, t.definition?.name, t.type]),
    [
      ["tr1", undefined, "Record Created", undefined],
      ["tr2", "Manual start", undefined, "manual"],
    ],
  );
  assert.deepEqual(
    res.inputs.map((v) => v.element),
    ["case"],
  );
  assert.deepEqual(
    res.outputs.map((v) => v.element),
    ["asset_tag"],
  );
  assert.deepEqual(res.variants, [
    {
      sys_id: "v1",
      name: "EMEA",
      active: true,
      condition: "location.region=emea",
      order: 1,
    },
    { sys_id: "v2", name: "legacy", active: false, order: 2 },
  ]);
  assert.equal(res.runs, undefined);
  assert.ok(!mock.reads.includes("sys_pd_context"));
  assert.equal(res.counts.lanes, 3);
  assert.equal(res.counts.activities, 4);
  assert.equal(res.counts.triggers, 2);
  assert.equal(res.counts.timers, 2);
  assert.equal(res.counts.variants, 2);
  assert.equal(res.counts.inputs, 1);
  assert.equal(res.counts.outputs, 1);
  assert.ok(res.caveats.some((c) => /verified:false/.test(c)));
});

test("P-12: opt-in runs read sys_pd_context with activity states", async () => {
  const res = payload(await run({ sys_id: PB, runs: 5 }));
  assert.deepEqual(
    res.runs.map((r) => [r.sys_id, r.state, r.record, r.activityStates]),
    [
      ["pc1", "in_progress", "hr1", { complete: 2, in_progress: 1 }],
      ["pc2", "complete", undefined, { unknown: 1 }],
    ],
  );
  assert.equal(res.runs[1].ended, "2026-09-12 08:00:00");
  assert.equal(res.counts.runs, 2);
  const tables = fixture();
  tables.sys_pd_context = [];
  const none = payload(await run({ sys_id: PB, runs: 5 }, instance(tables)));
  assert.deepEqual(none.runs, []);
});

test("P-12 acceptance: the fixture playbook renders lanes as Mermaid subgraphs", async () => {
  const res = payload(await run({ sys_id: PB, format: "mermaid" }));
  lintMermaid(res.mermaid);
  assert.equal(res.mermaidTruncated, undefined);
  for (const lane of [L1, L2, L3]) {
    assert.match(res.mermaid, new RegExp(`subgraph lane_${lane}\\b`));
    assert.match(res.mermaid, new RegExp(`pb -\\.-> lane_${lane}$`, "m"));
  }
  const subgraphs = res.mermaid.match(/^\s*subgraph /gm);
  assert.equal(subgraphs.length, 3);
  // Activities chain inside their lane; the timer count is on the node.
  assert.match(res.mermaid, new RegExp(`act_${A1} --> act_${A2}`));
  assert.match(res.mermaid, /2\.2 wait_delivery · 2 timer\(s\)/);
  assert.match(res.mermaid, /1\.2 Approve Request · approval/);
  assert.match(res.mermaid, /Trigger: Record Created · sn_hr_core_case/);
  const file = path.join(FIXTURES, "playbook.mmd");
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, `${res.mermaid}\n`);
  } else {
    assert.equal(`${res.mermaid}\n`, readFileSync(file, "utf8"));
  }
});

test("P-12: the markdown report and the file format", async () => {
  const md = payload(
    await run({ sys_id: PB, runs: 5, format: "markdown" }),
  ).markdown;
  assert.match(md, /^# Playbook Laptop Onboarding$/m);
  assert.match(
    md,
    /3 lane\(s\), 4 activity\(ies\), 2 trigger\(s\), 2 timer\(s\), 2 variant\(s\)\. verified:false\./,
  );
  assert.match(md, /- Internal name: laptop_onboarding/);
  assert.match(md, /- Description: Guides an agent through onboarding\./);
  assert.match(md, /## Triggers[\s\S]*condition: hr_service=laptop/);
  assert.match(md, /- \*\*2 Fulfil\*\* · condition: state=2/);
  assert.match(md, /- 1\.1 Collect Details _\(Form\)_/);
  assert.match(md, new RegExp(`- 2\\.2 wait_delivery _\\(${id("e")}\\)_`));
  assert.match(md, /- timer Delivery SLA \(2 days\)/);
  assert.match(md, /- timer reminder$/m);
  assert.match(md, /- \*\*3 Close\*\*\n {2}- _No activities\._/);
  assert.match(md, /## Inputs[\s\S]*\| case \| Case \|/);
  assert.match(md, /## Outputs/);
  assert.match(md, /- legacy \(inactive\)/);
  assert.match(md, /- EMEA · condition: location\.region=emea/);
  assert.match(md, /\(pc1\)\n {2}- activities: complete 2, in_progress 1/);
  assert.match(md, /```mermaid\n[\s\S]*subgraph lane_/);

  const dir = mkdtempSync(path.join(tmpdir(), "sn-p12-"));
  try {
    const out = payload(
      await withEnv({ SN_DOCS_DIR: dir }, () =>
        run({ sys_id: PB, format: "file" }),
      ),
    );
    assert.equal(out.format, "file");
    assert.equal(out.kind, "playbook");
    const written = JSON.parse(readFileSync(out.file, "utf8"));
    assert.equal(written.lanes.length, 3);
    assert.match(written.mermaid, /subgraph lane_/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P-12: a playbook without lanes, triggers or variants still renders", async () => {
  const tables = fixture();
  for (const t of [
    "sys_pd_lane",
    "sys_pd_trigger_instance",
    "sys_pd_process_variant",
    "sys_pd_process_input",
    "sys_pd_process_output",
  ]) {
    tables[t] = [];
  }
  tables.sys_pd_process_definition = [{ sys_id: PB, name: "bare" }];
  const mock = instance(tables);
  const res = payload(await run({ sys_id: PB, format: "markdown" }, mock));
  assert.ok(!mock.reads.includes("sys_pd_activity"));
  assert.match(res.markdown, /^# Playbook bare$/m);
  assert.match(res.markdown, /_No lanes found\._/);
  assert.doesNotMatch(res.markdown, /## Triggers|## Variants|Internal name/);
  assert.equal(res.counts.lanes, 0);
});

test("P-12: an instance without Process Automation Designer is not an error", async () => {
  const tables = fixture();
  tables.sys_db_object = [];
  const res = payload(
    await run(
      { sys_id: PB, format: "markdown" },
      instance(tables, { sys_pd_process_definition: 400 }),
    ),
  );
  assert.ok(
    res.caveats.some((c) => /Process Automation Designer/.test(c)),
    res.caveats.join("\n"),
  );
  assert.match(res.markdown, /_Process Automation Designer is not available/);

  const json = payload(
    await run(
      { sys_id: PB },
      instance(tables, { sys_pd_process_definition: 404 }),
    ),
  );
  assert.equal(json.available, false);
  assert.equal(json.lanes, undefined);

  // Readable in sys_db_object but denied: degraded, still available.
  const denied = payload(
    await run(
      { sys_id: PB, format: "markdown" },
      instance(fixture(), { sys_pd_process_definition: 403 }),
    ),
  );
  assert.equal(
    denied.caveats.some((c) => /not available/.test(c)),
    false,
  );
  assert.match(denied.markdown, /_The playbook could not be read\._/);
});

test("P-12: an unreadable child table is a caveat; a missing record an error", async () => {
  const res = payload(
    await run(
      { sys_id: PB },
      instance(fixture(), {
        sys_pd_timer_attributes: 403,
        sys_pd_process_variant: 404,
      }),
    ),
  );
  assert.deepEqual(
    res.unreadable.map((u) => [u.table, u.status]),
    [
      ["sys_pd_timer_attributes", 403],
      ["sys_pd_process_variant", 404],
    ],
  );
  assert.equal(res.counts.timers, 0);
  assert.deepEqual(res.variants, []);
  assert.equal(res.lanes.length, 3);

  const missing = await run({ sys_id: id("9") });
  assert.equal(missing.isError, true);
  assert.match(
    missing.content[0].text,
    /No sys_pd_process_definition record matches/,
  );
  assert.match(missing.content[0].text, /kind:'playbook'/);
});

test("P-12: depth and migration are ignored with a caveat", async () => {
  const res = payload(await run({ sys_id: PB, depth: 2, migration: true }));
  assert.ok(res.caveats.some((c) => /depth applies to flows/.test(c)));
  assert.ok(res.caveats.some((c) => /migration applies/.test(c)));
});

test("P-12: the API renders the header when sys_id is the only name", async () => {
  const tables = fixture();
  const mock = instance(tables);
  const result = await withFetch(mock.handler, () =>
    explainFlow({ sys_id: PB, kind: "playbook" }),
  );
  delete result.playbook;
  const md = flowMarkdown(result, "");
  assert.match(md, new RegExp(`^# Playbook ${PB}$`, "m"));
});
