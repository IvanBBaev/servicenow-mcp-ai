// P-20 — snapshot / compare over the artefact registry: normalised records
// with children, matched by sys_id then natural key, child-aware diffs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  canonical,
  collectArtifactType,
  diffArtifactType,
  normalizeRow,
  resolveArtifactTypes,
} from "../build/api/artifact-snapshot.js";
import { snapshotInstance } from "../build/api/snapshot.js";
import { compareInstances, driftCount } from "../build/api/compare.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withMetadataFetch,
} from "./helpers.js";

baselineEnv();

const W1 = "1".repeat(32);
const W2 = "2".repeat(32);
const W3 = "3".repeat(32);
const T1 = "4".repeat(32);

const widget = (sys_id, id, extra = {}) => ({
  sys_id,
  id,
  name: `Widget ${id}`,
  script: "data.x = 1;",
  client_script: "function(){}",
  option_schema: '[{"name":"title","type":"string"}]',
  sys_updated_on: "2026-01-01 00:00:00",
  sys_mod_count: "3",
  ...extra,
});

/** Two instances: dev00000 (profile default) and dev11111 (profile b). */
const DATA = {
  "dev00000.service-now.com": {
    sp_widget: [widget(W1, "hello"), widget(W2, "only-a")],
    sp_ng_template: [
      {
        sys_id: T1,
        sp_widget: W1,
        id: "tpl.html",
        template: "<div/>",
        sys_updated_on: "x",
      },
    ],
  },
  "dev11111.service-now.com": {
    sp_widget: [
      // Same record, other volatile fields and JSON key order → equal.
      widget(W1, "hello", {
        sys_updated_on: "2026-09-09 09:09:09",
        sys_mod_count: "9",
        option_schema: '[{"type":"string","name":"title"}]',
      }),
      // Same natural key, other sys_id, other script → matched by key, different.
      widget(W3, "only-a", { script: "data.x = 2;" }),
    ],
    sp_ng_template: [
      {
        sys_id: T1,
        sp_widget: W1,
        id: "tpl.html",
        template: "<div/>",
        sys_updated_on: "y",
      },
    ],
  },
};

function instance(data = DATA) {
  return (url) => {
    const u = new URL(url);
    const tables = data[u.hostname] ?? {};
    const m = /^\/api\/now\/table\/([^/]+)$/.exec(u.pathname);
    if (!m) return jsonResponse(200, { result: [] });
    const table = m[1];
    let rows = tables[table] ?? [];
    const q = u.searchParams.get("sysparm_query") ?? "";
    const inClause = /^(\w+)IN([^^]*)/.exec(q);
    if (inClause) {
      const ids = new Set(inClause[2].split(","));
      rows = rows.filter((r) => ids.has(r[inClause[1]]));
    }
    return jsonResponse(
      200,
      { result: rows },
      { "x-total-count": String(rows.length) },
    );
  };
}

async function scenario(env, fn, data) {
  const docs = mkdtempSync(path.join(tmpdir(), "p20-"));
  freshRuntime();
  try {
    return await withEnv(
      {
        SN_DOCS_DIR: docs,
        SN_PROFILE_B_INSTANCE: "dev11111.service-now.com",
        SN_PROFILE_B_USER: "u",
        SN_PROFILE_B_PASSWORD: "p",
        ...env,
      },
      () => withMetadataFetch(instance(data), (calls) => fn(calls, docs)),
    );
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
}

test("normalizeRow: volatile fields dropped, JSON decoded with sorted keys, secrets masked", () => {
  const a = normalizeRow(
    {
      sys_id: "x",
      name: "n",
      sys_updated_on: "t1",
      sys_mod_count: "1",
      cfg: '{"b":1,"a":{"d":2,"c":3}}',
      pw: "hunter2",
    },
    {
      jsonFields: [{ field: "cfg", decoder: "json", writable: true }],
      secretFields: ["pw"],
    },
  );
  assert.deepEqual(Object.keys(a), ["cfg", "name", "pw", "sys_id"]);
  assert.equal(JSON.stringify(a.cfg), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(a.pw, "[redacted]");
  const b = normalizeRow(
    {
      sys_id: "x",
      name: "n",
      sys_updated_on: "t2",
      cfg: '{"a":{"c":3,"d":2},"b":1}',
      pw: "other",
    },
    {
      jsonFields: [{ field: "cfg", decoder: "json", writable: true }],
      secretFields: ["pw"],
    },
  );
  assert.equal(canonical(a), canonical(b));
});

test("collectArtifactType: primary by sys_id order, children by parent IN list, hashes stable", async () => {
  await scenario({}, async (calls) => {
    const snap = await collectArtifactType("sp_widget");
    assert.equal(snap.table, "sp_widget");
    assert.deepEqual(
      snap.records.map((r) => r.key),
      ["hello", "only-a"],
    );
    const hello = snap.records[0];
    assert.equal(hello.children.sp_ng_template.length, 1);
    assert.equal(hello.children.sp_ng_template[0].key, "tpl.html");
    assert.equal(snap.records[1].children.sp_ng_template.length, 0);
    assert.equal(hello.fields.sys_updated_on, undefined);
    const primary = calls.find((c) =>
      new URL(c.url).pathname.endsWith("/sp_widget"),
    );
    assert.match(
      new URL(primary.url).searchParams.get("sysparm_query"),
      /ORDERBYsys_id$/,
    );
    const child = calls.find((c) =>
      new URL(c.url).pathname.endsWith("/sp_ng_template"),
    );
    assert.match(
      new URL(child.url).searchParams.get("sysparm_query"),
      new RegExp(`^sp_widgetIN${W1},${W2}\\^ORDERBYsys_id$`),
    );
    const again = await collectArtifactType("sp_widget");
    assert.deepEqual(
      again.records.map((r) => r.hash),
      snap.records.map((r) => r.hash),
    );
  });
});

test("types: unknown types are refused before any request; 'all' expands to the registry", async () => {
  assert.ok(resolveArtifactTypes(["all"]).length > 50);
  assert.deepEqual(resolveArtifactTypes(["sp_widget", "sp_widget"]), [
    "sp_widget",
  ]);
  await scenario({}, async (calls) => {
    await assert.rejects(
      snapshotInstance({ types: ["nope"], sections: ["plugins"] }),
      /Unknown artifact type 'nope'/,
    );
    assert.equal(calls.length, 0);
  });
});

test("snapshot types: writes artifacts/<type>.json + .md; a re-run of an unchanged instance is unchanged", async () => {
  await scenario({}, async (_calls, docs) => {
    const first = await snapshotInstance({
      types: ["sp_widget"],
      sections: ["plugins"],
    });
    const json = path.join(docs, "default", "artifacts", "sp_widget.json");
    assert.ok(existsSync(json));
    assert.ok(
      existsSync(path.join(docs, "default", "artifacts", "sp_widget.md")),
    );
    const stored = JSON.parse(readFileSync(json, "utf8"));
    assert.equal(stored.records.length, 2);
    assert.equal(first.changes["default/artifacts/sp_widget.json"], "created");
    const second = await snapshotInstance({
      types: ["sp_widget"],
      sections: ["plugins"],
    });
    assert.equal(
      second.changes["default/artifacts/sp_widget.json"],
      "unchanged",
    );
    assert.equal(second.changes["default/artifacts/sp_widget.md"], "unchanged");
  });
});

test("compare types: the same instance twice gives no artefact diff (acceptance)", async () => {
  const same = {
    ...DATA,
    "dev11111.service-now.com": DATA["dev00000.service-now.com"],
  };
  await scenario(
    {},
    async () => {
      const r = await compareInstances({
        a: "default",
        b: "b",
        types: ["sp_widget"],
      });
      assert.deepEqual(r.artifactDiffs, []);
    },
    same,
  );
});

test("compare types: matched by sys_id, then natural key; volatile fields and JSON key order are not drift", async () => {
  await scenario({}, async () => {
    const r = await compareInstances({
      a: "default",
      b: "b",
      types: ["sp_widget"],
    });
    assert.deepEqual(r.artifactDiffs, [
      {
        type: "sp_widget",
        key: "only-a",
        status: "different",
        fields: ["script"],
      },
    ]);
    const without = await compareInstances({ a: "default", b: "b" });
    assert.equal(without.artifactDiffs, undefined);
    assert.equal(driftCount(r), driftCount(without) + 1);
  });
});

test("compare types: child-aware diff counts added, removed and changed children", () => {
  const side = (children) => ({
    type: "sp_widget",
    table: "sp_widget",
    verified: false,
    warnings: [],
    records: [
      {
        sys_id: W1,
        key: "k",
        name: "n",
        hash: canonical(children),
        fields: { a: "1" },
        children,
      },
    ],
  });
  const a = side({
    sp_ng_template: [
      { sys_id: "t1", key: "a", hash: "1" },
      { sys_id: "t2", key: "b", hash: "2" },
    ],
  });
  const b = side({
    sp_ng_template: [
      { sys_id: "t1", key: "a", hash: "X" },
      { sys_id: "t3", key: "c", hash: "3" },
    ],
  });
  assert.deepEqual(diffArtifactType(a, b), [
    {
      type: "sp_widget",
      key: "k",
      status: "different",
      children: {
        sp_ng_template: { only_in_a: 1, only_in_b: 1, different: 1 },
      },
    },
  ]);
});

test("compare types from_snapshot reads the stored artefact files", async () => {
  await scenario({}, async (calls) => {
    await snapshotInstance({ types: ["sp_widget"], sections: ["plugins"] });
    await withEnv({ SN_ACTIVE_PROFILE: "b" }, () =>
      snapshotInstance({ types: ["sp_widget"], sections: ["plugins"] }),
    );
    const before = calls.length;
    const r = await compareInstances({
      a: "default",
      b: "b",
      types: ["sp_widget"],
      fromSnapshot: true,
    });
    assert.equal(r.artifactDiffs.length, 1);
    // The collector reads whole rows (no sysparm_fields); the script diff
    // of compare also reads sp_widget, with fields.
    const live = calls
      .slice(before)
      .map((c) => new URL(c.url))
      .filter(
        (u) =>
          /\/sp_widget$|\/sp_ng_template$/.test(u.pathname) &&
          !u.searchParams.has("sysparm_fields"),
      );
    assert.equal(live.length, 0, "artefacts came from the snapshot files");
  });
});

test("compare types: a UIB macroponent gets a per-element composition diff (N-31)", async () => {
  const M1 = "5".repeat(32);
  const el = (elementId, extra = {}) => ({
    elementId,
    definition: { id: `cmp_${elementId}`, type: "COMPONENT" },
    ...extra,
  });
  const page = (composition) => ({
    sys_id: M1,
    name: "Incident page",
    composition: JSON.stringify(composition),
    data: "[]",
    sys_updated_on: "x",
  });
  const a = [el("header", { propertyValues: { title: "A" } }), el("list")];
  const b = [el("header", { propertyValues: { title: "B" } }), el("button")];
  const data = {
    "dev00000.service-now.com": { sys_ux_macroponent: [page(a)] },
    "dev11111.service-now.com": { sys_ux_macroponent: [page(b)] },
  };
  await scenario(
    {},
    async (_calls, docs) => {
      const r = await compareInstances({
        a: "default",
        b: "b",
        types: ["uib_macroponent"],
      });
      assert.equal(r.artifactDiffs.length, 1);
      const d = r.artifactDiffs[0];
      assert.deepEqual(d.fields, ["composition"]);
      assert.deepEqual(
        d.elementDiff.composition.elements.map((e) => [e.elementId, e.status]),
        [
          ["button", "added"],
          ["header", "changed"],
          ["list", "removed"],
        ],
      );
      assert.match(
        readFileSync(path.join(docs, r.report), "utf8"),
        /composition \[elements \+1 -1 ~1\]/,
      );
      assert.equal(d.rawDiff, undefined, "no JSON hunk without raw");
      const raw = await compareInstances({
        a: "default",
        b: "b",
        types: ["uib_macroponent"],
        raw: true,
      });
      const hunk = raw.artifactDiffs[0].rawDiff.composition;
      assert.match(hunk, new RegExp(`^--- default/${M1}\\.composition`, "m"));
      assert.match(hunk, new RegExp(`^\\+\\+\\+ b/${M1}\\.composition`, "m"));
      assert.match(hunk, /^- +"title": "A"$/m);
      assert.match(hunk, /^\+ +"title": "B"$/m);
      const report = readFileSync(path.join(docs, raw.report), "utf8");
      assert.match(report, /### Composition JSON diffs/);
      assert.match(
        report,
        new RegExp(`#### uib_macroponent: ${d.key} \\(composition\\)`),
      );
    },
    data,
  );
});
