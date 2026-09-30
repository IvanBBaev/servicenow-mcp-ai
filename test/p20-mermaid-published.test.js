// P-20 remainder — Mermaid graphs diffed as text in compare_instances
// (`mermaid:true`) and flows read from the published snapshot
// (sys_hub_flow.master_snapshot → child rows keyed by the snapshot).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { collectArtifactType } from "../build/api/artifact-snapshot.js";
import {
  MERMAID_DIFFS_MAX,
  MERMAID_DIFF_LINES,
  MERMAID_TYPES,
  hasMermaid,
  mermaidDiff,
} from "../build/api/artifact-mermaid.js";
import { compareInstances, driftCount } from "../build/api/compare.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withMetadataFetch,
} from "./helpers.js";

baselineEnv();

const id = (n) => n.toString(16).padStart(32, "0");
const F1 = id(0xf1);
const SNAP1 = id(0x5a1);

const flow = (sys_id, internal, extra = {}) => ({
  sys_id,
  name: `Flow ${internal}`,
  internal_name: internal,
  type: "flow",
  active: "true",
  status: "published",
  label_cache: "",
  master_snapshot: "",
  latest_snapshot: "",
  sys_updated_on: "2026-01-01 00:00:00",
  ...extra,
});

const step = (sys_id, owner, order, actionName) => ({
  sys_id,
  flow: owner,
  order: String(order),
  ui_id: `ui-${sys_id.slice(-4)}`,
  parent_ui_id: "",
  comment: "",
  values: "",
  action_type: id(0xa0 + order),
  "action_type.name": actionName,
});

/** Rows filtered by the encoded query's `f=v` / `fINa,b` clauses. */
function instance(data) {
  return (url) => {
    const u = new URL(url);
    const m = /^\/api\/now\/table\/([^/]+)$/.exec(u.pathname);
    if (!m) return jsonResponse(200, { result: [] });
    let rows = data[u.hostname]?.[m[1]] ?? [];
    for (const clause of (u.searchParams.get("sysparm_query") ?? "").split(
      "^",
    )) {
      if (!clause || clause.startsWith("ORDERBY")) continue;
      const inC = /^([\w.]+)IN(.*)$/.exec(clause);
      const eqC = /^([\w.]+)=(.*)$/.exec(clause);
      if (inC) {
        const set = new Set(inC[2].split(","));
        rows = rows.filter((r) => set.has(r[inC[1]]));
      } else if (eqC) {
        rows = rows.filter((r) => (r[eqC[1]] ?? "") === eqC[2]);
      }
    }
    return jsonResponse(
      200,
      { result: rows },
      { "x-total-count": String(rows.length) },
    );
  };
}

async function scenario(data, fn) {
  const docs = mkdtempSync(path.join(tmpdir(), "p20m-"));
  freshRuntime();
  try {
    return await withEnv(
      {
        SN_DOCS_DIR: docs,
        SN_PROFILE_B_INSTANCE: "dev11111.service-now.com",
        SN_PROFILE_B_USER: "u",
        SN_PROFILE_B_PASSWORD: "p",
      },
      () => withMetadataFetch(instance(data), (calls) => fn(calls, docs)),
    );
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
}

const A = "dev00000.service-now.com";
const B = "dev11111.service-now.com";

const childQuery = (calls, table) =>
  calls
    .map((c) => new URL(c.url))
    .filter(
      (u) =>
        u.pathname.endsWith(`/${table}`) &&
        !u.searchParams.has("sysparm_fields"),
    )
    .map((u) => u.searchParams.get("sysparm_query"));

// --- (b) flows from the published snapshot ------------------------------------

test("flow without master_snapshot: children from the draft, query and output unchanged", async () => {
  const data = {
    [A]: {
      sys_hub_flow: [flow(F1, "f1")],
      sys_hub_action_instance: [step(id(0x101), F1, 1, "Create Record")],
    },
  };
  await scenario(data, async (calls) => {
    const snap = await collectArtifactType("flow");
    const [rec] = snap.records;
    assert.equal(rec.source, undefined);
    assert.equal(rec.snapshot, undefined);
    assert.ok(!("source" in rec), "no source key without a snapshot");
    assert.equal(rec.children.sys_hub_action_instance.length, 1);
    assert.deepEqual(childQuery(calls, "sys_hub_action_instance"), [
      `flowIN${F1}^ORDERBYsys_id`,
    ]);
    assert.ok(
      !snap.warnings.some((w) => /snapshot/.test(w)),
      snap.warnings.join("\n"),
    );
  });
});

test("flow with master_snapshot: children read under the published snapshot, marked and warned (O-5)", async () => {
  const data = {
    [A]: {
      sys_hub_flow: [flow(F1, "f1", { master_snapshot: SNAP1 })],
      sys_hub_action_instance: [
        step(id(0x101), F1, 1, "Draft step"),
        step(id(0x102), F1, 2, "Draft step 2"),
        step(id(0x201), SNAP1, 1, "Published step"),
      ],
    },
  };
  await scenario(data, async (calls) => {
    const snap = await collectArtifactType("flow");
    const [rec] = snap.records;
    assert.equal(rec.source, "published");
    assert.equal(rec.snapshot, SNAP1);
    assert.deepEqual(
      rec.children.sys_hub_action_instance.map((c) => c.sys_id),
      [id(0x201)],
    );
    assert.deepEqual(childQuery(calls, "sys_hub_action_instance"), [
      `flowIN${F1},${SNAP1}^ORDERBYsys_id`,
    ]);
    assert.equal(snap.verified, false);
    const w = snap.warnings.find((x) => /published snapshot/.test(x));
    assert.ok(w, snap.warnings.join("\n"));
    assert.match(w, /^flow: 1 record\(s\) read from the published snapshot/);
    assert.match(w, /unverified \(O-5\)/);
  });
});

test("flow whose master_snapshot has no child rows: the draft stands, with a warning", async () => {
  const data = {
    [A]: {
      sys_hub_flow: [flow(F1, "f1", { master_snapshot: SNAP1 })],
      sys_hub_action_instance: [step(id(0x101), F1, 1, "Draft step")],
    },
  };
  await scenario(data, async () => {
    const snap = await collectArtifactType("flow");
    const [rec] = snap.records;
    assert.equal(rec.source, undefined);
    assert.deepEqual(
      rec.children.sys_hub_action_instance.map((c) => c.sys_id),
      [id(0x101)],
    );
    assert.ok(
      snap.warnings.some((w) =>
        /1 record\(s\) have a master_snapshot with no child rows/.test(w),
      ),
      snap.warnings.join("\n"),
    );
    assert.ok(!snap.warnings.some((w) => /read from the published/.test(w)));
  });
});

test("a master_snapshot equal to the flow's own sys_id is not a published snapshot", async () => {
  const data = {
    [A]: {
      sys_hub_flow: [flow(F1, "f1", { master_snapshot: F1 })],
      sys_hub_action_instance: [step(id(0x101), F1, 1, "Draft step")],
    },
  };
  await scenario(data, async (calls) => {
    const snap = await collectArtifactType("flow");
    assert.equal(snap.records[0].source, undefined);
    assert.deepEqual(childQuery(calls, "sys_hub_action_instance"), [
      `flowIN${F1}^ORDERBYsys_id`,
    ]);
    assert.deepEqual(snap.warnings, []);
  });
});

// --- (a) Mermaid graphs diffed as text ---------------------------------------

test("mermaidDiff: identical sources give nothing; cut and node truncation are flagged", () => {
  const src = "flowchart TD\n  a --> b";
  assert.equal(
    mermaidDiff(
      "flow",
      "k",
      { label: "a", mermaid: src, truncated: 0 },
      { label: "b", mermaid: src, truncated: 0 },
    ),
    undefined,
  );
  const d = mermaidDiff(
    "flow",
    "k",
    { label: "a", mermaid: src, truncated: 0 },
    { label: "b", mermaid: `${src}\n  b --> c`, truncated: 2 },
  );
  assert.equal(d.type, "flow");
  assert.equal(d.key, "k");
  assert.match(d.diff, /^--- a\n\+\+\+ b\n@@/);
  assert.match(d.diff, /\n\+ {2}b --> c/);
  assert.equal(d.cut, undefined);
  assert.deepEqual(d.nodesTruncated, { a: 0, b: 2 });
  const long = Array.from(
    { length: MERMAID_DIFF_LINES + 20 },
    (_, i) => `n${i}`,
  );
  const big = mermaidDiff(
    "flow",
    "k",
    { label: "a", mermaid: "", truncated: 0 },
    { label: "b", mermaid: long.join("\n"), truncated: 0 },
  );
  assert.equal(big.cut, true);
  assert.equal(big.diff.split("\n").length, MERMAID_DIFF_LINES + 1);
  assert.equal(big.nodesTruncated, undefined);
});

test("mermaid types cover the diagram explainers only", () => {
  for (const t of ["flow", "subflow", "workflow", "sp_portal", "workspace"]) {
    assert.ok(hasMermaid(t), t);
  }
  assert.ok(!hasMermaid("sp_widget"));
  assert.ok(!hasMermaid("toString"));
  assert.deepEqual([...MERMAID_TYPES].sort(), MERMAID_TYPES);
});

/** Two instances with the same flow; side b renamed one step's action. */
const TWO = (flowsN = 1) => {
  const side = (actionName) => {
    const flows = [];
    const steps = [];
    for (let i = 0; i < flowsN; i++) {
      const fid = id(0xf00 + i);
      flows.push(flow(fid, `f${i}`));
      steps.push(step(id(0x1000 + i), fid, 1, actionName));
    }
    return { sys_hub_flow: flows, sys_hub_action_instance: steps };
  };
  // The collector reads whole rows: the step's action_type differs too.
  const b = side("Update Record");
  b.sys_hub_action_instance = b.sys_hub_action_instance.map((s) => ({
    ...s,
    action_type: id(0xbb),
  }));
  return { [A]: side("Create Record"), [B]: b };
};

test("compare mermaid:true diffs the changed flow's diagram as text; drift count unchanged", async () => {
  await scenario(TWO(), async (_calls, docs) => {
    const plain = await compareInstances({
      a: "default",
      b: "b",
      types: ["flow"],
    });
    assert.equal(plain.mermaidDiffs, undefined);
    assert.equal(plain.artifactDiffs.length, 1);
    const r = await compareInstances({
      a: "default",
      b: "b",
      types: ["flow"],
      mermaid: true,
    });
    assert.deepEqual(r.artifactDiffs, plain.artifactDiffs);
    assert.equal(driftCount(r), driftCount(plain));
    assert.equal(r.mermaidDiffs.length, 1);
    const [d] = r.mermaidDiffs;
    assert.equal(d.type, "flow");
    assert.equal(d.key, "f0");
    assert.match(
      d.diff,
      /^--- default\/flow\/f0\.mmd\n\+\+\+ b\/flow\/f0\.mmd/,
    );
    assert.match(d.diff, /\n-.*Create Record/);
    assert.match(d.diff, /\n\+.*Update Record/);
    const report = readFileSync(
      path.join(docs, "_compare", "default-vs-b.md"),
      "utf8",
    );
    assert.match(report, /### Mermaid diffs/);
    assert.match(
      report,
      /#### flow: f0\n\n```diff\n--- default\/flow\/f0\.mmd/,
    );
    const plainReport = await compareInstances({
      a: "default",
      b: "b",
      types: ["flow"],
    }).then(() =>
      readFileSync(path.join(docs, "_compare", "default-vs-b.md"), "utf8"),
    );
    assert.doesNotMatch(plainReport, /Mermaid/);
  });
});

test("compare mermaid:true without types, or over non-diagram types, adds nothing", async () => {
  await scenario(TWO(), async () => {
    const r = await compareInstances({ a: "default", b: "b", mermaid: true });
    assert.equal(r.mermaidDiffs, undefined);
    assert.equal(r.artifactDiffs, undefined);
    const w = await compareInstances({
      a: "default",
      b: "b",
      types: ["sp_widget"],
      mermaid: true,
    });
    assert.deepEqual(w.mermaidDiffs, []);
  });
});

test("compare mermaid:true is capped at MERMAID_DIFFS_MAX records, the rest named in a warning", async () => {
  const n = MERMAID_DIFFS_MAX + 2;
  await scenario(TWO(n), async () => {
    const r = await compareInstances({
      a: "default",
      b: "b",
      types: ["flow"],
      mermaid: true,
    });
    assert.equal(r.artifactDiffs.length, n);
    assert.equal(r.mermaidDiffs.length, MERMAID_DIFFS_MAX);
    assert.ok(
      r.warnings.includes(
        `mermaid: 2 more changed diagram record(s) not diffed (cap ${MERMAID_DIFFS_MAX}).`,
      ),
      r.warnings.join("\n"),
    );
  });
});
