// P-17 — servicenow_get_artifact_dependencies: outbound edges from reference
// fields, decoded JSON and script text; inbound edges from reverse reference
// queries, script callers (search_code), flow step values and the S-9
// structural pass; the depth cap and cycle guard, the node cap, degraded
// sources, a degraded root, the pure extractors and the Mermaid golden.
// Regenerate the golden deliberately with `UPDATE_GOLDEN=1 npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  artifactDependencies,
  dependencyMermaid,
  jsonTargets,
  MAX_GRAPH_NODES,
} from "../build/api/dependencies.js";
import { ajaxScriptNames, scriptTables } from "../build/api/references.js";
import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import { lintMermaid } from "./mermaid-lint.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withFetch,
} from "./helpers.js";

baselineEnv();

const FIXTURES = path.join(import.meta.dirname, "fixtures", "explain");

const SDK_OFF = { SN_SDK_MANAGED_SCOPES: undefined, SN_SDK_PROJECT_DIRS: "" };

const id = (c) => c.repeat(32);
const PRICE = id("a");
const TAX = id("b");
const BR = id("c");
const WIDGET = id("d");
const FLOW = id("e");
const STEP = id("f");
const INST = id("1");
const DICT = id("2");

/** The fixture instance: table name → rows. */
function fixture() {
  return {
    sys_script_include: [
      {
        sys_id: PRICE,
        name: "PriceUtil",
        api_name: "global.PriceUtil",
        sys_scope: "global",
        active: "true",
        script: [
          "var PriceUtil = Class.create();",
          "PriceUtil.prototype = {",
          "  calc: function () {",
          "    var gr = new GlideRecord('x_price');",
          "    return new TaxUtil().rate();",
          "  },",
          "};",
        ].join("\n"),
      },
      {
        sys_id: TAX,
        name: "TaxUtil",
        api_name: "global.TaxUtil",
        sys_scope: "global",
        active: "true",
        script: [
          "var TaxUtil = Class.create();",
          "TaxUtil.prototype = {",
          "  rate: function () {",
          "    var ga = new GlideAggregate('x_tax');",
          "    return PriceUtil.base();",
          "  },",
          "};",
        ].join("\n"),
      },
    ],
    sys_script: [
      {
        sys_id: BR,
        name: "Price on insert",
        collection: "x_order",
        sys_scope: "global",
        active: "true",
        script:
          "(function () {\n  current.price = new PriceUtil().calc();\n  new GhostUtil().log();\n})();",
      },
    ],
    sp_widget: [
      {
        sys_id: WIDGET,
        id: "price-widget",
        name: "Price widget",
        sys_scope: "global",
        script: "data.price = new global.PriceUtil().calc();",
        client_script: "var ga = new GlideAjax('global.PriceAjax');",
        link: "",
        css: ".price { color: red; }",
        option_schema: JSON.stringify([
          { name: "source", type: "string", table: "x_order" },
        ]),
        demo_data: "",
      },
    ],
    sp_instance: [
      { sys_id: INST, sp_widget: WIDGET, sp_column: id("3"), order: "100" },
    ],
    sys_hub_flow: [
      {
        sys_id: FLOW,
        name: "Pricing flow",
        internal_name: "pricing_flow",
        type: "flow",
        sys_scope: "global",
        active: "true",
      },
    ],
    sys_hub_action_instance: [
      {
        sys_id: STEP,
        flow: FLOW,
        "flow.name": "Pricing flow",
        order: "100",
        values: JSON.stringify({
          inputs: [{ name: "script", value: "return new PriceUtil().calc();" }],
        }),
      },
    ],
    sys_db_object: [
      "sys_script_include",
      "sys_script",
      "sp_widget",
      "sp_instance",
      "sys_hub_flow",
      "sys_hub_action_instance",
      "sys_dictionary",
    ].map((name, i) => ({ sys_id: `t${i}`, name })),
    sys_dictionary: [
      {
        sys_id: DICT,
        name: "x_order",
        element: "product",
        column_label: "Product",
        internal_type: "reference",
        reference: "x_product",
        reference_qual: "javascript:new PriceUtil().filter()",
        default_value: "",
      },
    ],
  };
}

/** One encoded-query term against a row; unknown shapes match (lenient). */
function matchTerm(row, term) {
  let m;
  if ((m = /^([\w.]+)LIKE(.*)$/.exec(term))) {
    return String(row[m[1]] ?? "").includes(m[2]);
  }
  if ((m = /^([\w.]+)=(.*)$/.exec(term))) {
    return m[1] in row ? String(row[m[1]]) === m[2] : true;
  }
  return true;
}

/** A tiny encoded-query evaluator: `a^b^ORc^ORDERBYx` (OR binds tighter). */
function matches(row, query) {
  const body = query.split("^ORDERBY")[0];
  if (!body) return true;
  return body
    .split(/\^NQ|\^/)
    .reduce((groups, part) => {
      if (part.startsWith("OR") && groups.length) {
        groups.at(-1).push(part.slice(2));
      } else groups.push([part]);
      return groups;
    }, [])
    .every((group) => group.some((t) => matchTerm(row, t)));
}

/**
 * A Table API mock over `tables`; `status[table]` answers that table with an
 * error. Records every read as `table?query`.
 */
function instance(tables = fixture(), status = {}) {
  const reads = [];
  const handler = (url) => {
    const u = new URL(url);
    const m = u.pathname.match(/\/api\/now\/table\/([^/]+)(?:\/(\w+))?$/);
    if (!m) return jsonResponse(404, { error: { message: "no route" } });
    const table = m[1];
    if (m[2]) {
      reads.push(`${table}/${m[2]}`);
      if (status[table]) {
        return jsonResponse(status[table], {
          error: { message: `denied ${table}`, detail: "ACL" },
        });
      }
      const row = (tables[table] ?? []).find((r) => r.sys_id === m[2]);
      return row
        ? jsonResponse(200, { result: row })
        : jsonResponse(404, { error: { message: "No Record found" } });
    }
    const query = u.searchParams.get("sysparm_query") ?? "";
    reads.push(`${table}?${query}`);
    if (status[table]) {
      return jsonResponse(status[table], {
        error: { message: `denied ${table}`, detail: "ACL" },
      });
    }
    const fields = u.searchParams.get("sysparm_fields")?.split(",");
    const limit = Number(u.searchParams.get("sysparm_limit") ?? 1000);
    const rows = (tables[table] ?? [])
      .filter((r) => matches(r, query))
      .slice(0, limit)
      .map((r) =>
        fields
          ? Object.fromEntries(
              fields.filter((f) => f in r).map((f) => [f, r[f]]),
            )
          : r,
      );
    return jsonResponse(200, { result: rows });
  };
  return { handler, reads };
}

const spec = ALL_TOOLS.find(
  (s) => s.name === "servicenow_get_artifact_dependencies",
);

async function deps(opts, mock = instance()) {
  return withEnv(SDK_OFF, () =>
    withFetch(mock.handler, () => artifactDependencies(opts)),
  );
}

const edgeSet = (res) =>
  res.edges.map((e) => `${e.from} -> ${e.to} [${e.via}:${e.field}]`).sort();

test.beforeEach(() => {
  freshRuntime();
});

// -- pure layer ---------------------------------------------------------------

test("scriptTables reads literal GlideRecord / GlideAggregate tables only", () => {
  assert.deepEqual(
    scriptTables(
      "new GlideRecord('incident'); new GlideRecordSecure(\"task\"); new GlideAggregate('incident'); new GlideRecord(tableVar);",
    ),
    ["incident", "task"],
  );
  assert.deepEqual(scriptTables(""), []);
});

test("ajaxScriptNames reads GlideAjax class names, scoped or not", () => {
  assert.deepEqual(
    ajaxScriptNames(
      "new GlideAjax('x_app.Pricing'); new GlideAjax(\"Plain\");",
    ),
    ["Pricing", "Plain"],
  );
});

test("jsonTargets finds table keys, table+sys_id pairs and script text", () => {
  const found = jsonTargets({
    table: "incident",
    reference: "true",
    rows: [{ table_name: "task", sys_id: id("9") }],
    script: "return new Foo().bar() + new GlideRecord('x_bar');",
    note: "no call here",
    nested: { tableName: "Not A Table" },
  });
  assert.deepEqual(found, [
    { kind: "table", name: "incident" },
    { kind: "record", table: "task", sys_id: id("9") },
    { kind: "table", name: "task" },
    { kind: "script", name: "Foo" },
    { kind: "table", name: "x_bar" },
  ]);
  assert.deepEqual(jsonTargets(null), []);
});

// -- the tool -------------------------------------------------------------------

test("get_artifact_dependencies lives in the artifacts package with bounded inputs", async () => {
  assert.ok(spec, "tool registered");
  assert.equal(spec.package, "artifacts");
  assert.equal(spec.annotations.readOnlyHint, true);
  assert.ok(spec.output, "declares an outputSchema");
  assert.ok(spec.description.length <= 250);
  const bad = await runSpec(spec, {
    artifactType: "script_include",
    sys_id: PRICE,
    depth: 4,
  });
  assert.equal(bad.isError, true);
  const long = await runSpec(spec, {
    artifactType: "x".repeat(81),
    sys_id: PRICE,
  });
  assert.equal(long.isError, true);
});

test("acceptance: a script include shows its business rule, flow step and widget callers", async () => {
  const mock = instance();
  const res = await deps(
    { artifactType: "script_include", sys_id: PRICE, direction: "inbound" },
    mock,
  );
  assert.equal(res.root, "script:PriceUtil");
  const inbound = res.edges.filter((e) => e.to === "script:PriceUtil");
  const from = new Set(inbound.map((e) => e.from));
  assert.ok(from.has(`sys_script:${BR}`), "business rule");
  assert.ok(from.has(`sp_widget:${WIDGET}`), "widget");
  assert.ok(from.has(`sys_hub_flow:${FLOW}`), "flow script step");
  const flowEdge = inbound.find((e) => e.from === `sys_hub_flow:${FLOW}`);
  assert.equal(flowEdge.via, "flow_step");
  assert.equal(flowEdge.source, "sys_hub_action_instance");
  const flowNode = res.nodes.find((n) => n.id === `sys_hub_flow:${FLOW}`);
  assert.equal(flowNode.name, "Pricing flow");
  assert.equal(flowNode.type, "flow");
  // The S-9 structural pass: a reference qualifier calling the include.
  assert.ok(
    inbound.some((e) => e.via === "structural" && e.field === "reference_qual"),
  );
  // The script include itself is not its own caller.
  assert.ok(!from.has("script:PriceUtil"));
  assert.equal(res.count.inbound, inbound.length);
  assert.equal(res.count.outbound, 0);
  assert.ok(res.caveats[0].includes("base64"));
  assert.ok(mock.reads.some((r) => r.startsWith("sys_hub_action_instance?")));
});

test("outbound edges of a script include: calls and GlideRecord tables, not Class or itself", async () => {
  const res = await deps({
    artifactType: "script_include",
    key: "global.PriceUtil",
    direction: "outbound",
  });
  assert.deepEqual(edgeSet(res), [
    "script:PriceUtil -> script:TaxUtil [script:script]",
    "script:PriceUtil -> table:x_price [script:script]",
  ]);
  assert.equal(res.count.inbound, 0);
});

test("outbound edges of a widget: server script, GlideAjax, option_schema JSON; CSS skipped", async () => {
  const res = await deps({
    artifactType: "sp_widget",
    key: "price-widget",
    direction: "outbound",
  });
  assert.deepEqual(edgeSet(res), [
    `sp_widget:${WIDGET} -> script:PriceAjax [script:client_script]`,
    `sp_widget:${WIDGET} -> script:PriceUtil [script:script]`,
    `sp_widget:${WIDGET} -> table:x_order [json:option_schema]`,
  ]);
});

test("outbound edges of a flow come from decoded step values on child rows", async () => {
  const res = await deps({
    artifactType: "flow",
    sys_id: FLOW,
    direction: "outbound",
  });
  assert.deepEqual(res.edges, [
    {
      from: `sys_hub_flow:${FLOW}`,
      to: "script:PriceUtil",
      via: "json",
      field: "values",
      source: "sys_hub_action_instance",
    },
  ]);
});

test("depth walks through script includes; the cycle is visited once; a missing include is flagged", async () => {
  const res = await deps({
    artifactType: "business_rule",
    sys_id: BR,
    direction: "outbound",
    depth: 3,
  });
  assert.deepEqual(edgeSet(res), [
    "script:PriceUtil -> script:TaxUtil [script:script]",
    "script:PriceUtil -> table:x_price [script:script]",
    "script:TaxUtil -> script:PriceUtil [script:script]",
    "script:TaxUtil -> table:x_tax [script:script]",
    `sys_script:${BR} -> script:GhostUtil [script:script]`,
    `sys_script:${BR} -> script:PriceUtil [script:script]`,
    `sys_script:${BR} -> table:x_order [reference:collection]`,
  ]);
  const byId = Object.fromEntries(res.nodes.map((n) => [n.id, n]));
  assert.equal(byId["script:PriceUtil"].depth, 1);
  assert.equal(byId["script:TaxUtil"].depth, 2);
  assert.equal(byId["script:TaxUtil"].sys_id, TAX);
  assert.equal(byId["script:GhostUtil"].missing, true);
  assert.equal(res.nodes.filter((n) => n.id === "script:PriceUtil").length, 1);
});

test("inbound reverse reference queries report the referencing child row", async () => {
  const res = await deps({
    artifactType: "sp_widget",
    sys_id: WIDGET,
    direction: "inbound",
  });
  const edge = res.edges.find((e) => e.from === `sp_instance:${INST}`);
  assert.deepEqual(edge, {
    from: `sp_instance:${INST}`,
    to: `sp_widget:${WIDGET}`,
    via: "reference",
    field: "sp_widget",
  });
});

test("a child row whose parent is the primary table reports the parent record", async () => {
  const tables = {
    ...fixture(),
    m2m_sp_ng_pro_sp_widget: [
      { sys_id: "m1", sp_widget: WIDGET, sp_angular_provider: id("5") },
    ],
    sp_angular_provider: [{ sys_id: id("5"), name: "priceTip" }],
  };
  const res = await deps(
    {
      artifactType: "sp_angular_provider",
      sys_id: id("5"),
      direction: "inbound",
    },
    instance(tables),
  );
  assert.ok(
    res.edges.some(
      (e) =>
        e.from === `sp_widget:${WIDGET}` &&
        e.to === `sp_angular_provider:${id("5")}` &&
        e.source === "m2m_sp_ng_pro_sp_widget",
    ),
    JSON.stringify(res.edges),
  );
});

test("both directions share one graph; an unreadable source becomes an unavailable entry", async () => {
  const res = await deps(
    { artifactType: "script_include", sys_id: PRICE },
    instance(fixture(), { sys_hub_action_instance: 403 }),
  );
  assert.ok(res.count.outbound >= 2);
  assert.ok(res.edges.some((e) => e.from === `sys_script:${BR}`));
  assert.ok(!res.edges.some((e) => e.via === "flow_step"));
  const miss = res.unavailable.find(
    (u) => u.source === "sys_hub_action_instance",
  );
  assert.equal(miss.node, "script:PriceUtil");
  assert.match(miss.reason, /denied/);
});

test("the node cap truncates the graph", async () => {
  const providers = Array.from({ length: MAX_GRAPH_NODES + 10 }, (_, i) => ({
    sys_id: `m${i}`,
    sp_widget: WIDGET,
    sp_angular_provider: i.toString(16).padStart(32, "0"),
  }));
  const res = await deps(
    { artifactType: "sp_widget", sys_id: WIDGET, direction: "outbound" },
    instance({ ...fixture(), m2m_sp_ng_pro_sp_widget: providers }),
  );
  assert.equal(res.truncated, true);
  assert.equal(res.nodes.length, MAX_GRAPH_NODES);
});

test("a degraded root of an unverified type answers an empty graph", async () => {
  const res = await deps(
    { artifactType: "sp_widget", sys_id: WIDGET },
    instance({ sys_db_object: [] }, { sp_widget: 404 }),
  );
  assert.equal(res.root, null);
  assert.deepEqual(res.nodes, []);
  assert.equal(res.degraded.status, 404);
  assert.equal(res.available, false);
});

test("the tool returns JSON by default and a Mermaid graph that matches its golden", async () => {
  const mock = instance();
  await withEnv(SDK_OFF, () =>
    withFetch(mock.handler, async () => {
      const json = await runSpec(spec, {
        artifactType: "script_include",
        sys_id: PRICE,
      });
      assert.equal(json.isError, undefined, json.content[0].text);
      assert.ok(Array.isArray(json.structuredContent.nodes));

      const res = await runSpec(spec, {
        artifactType: "script_include",
        sys_id: PRICE,
        format: "mermaid",
      });
      assert.equal(res.isError, undefined, res.content[0].text);
      const out = res.structuredContent;
      assert.equal(out.nodes, undefined);
      assert.equal(out.edges, undefined);
      assert.equal(out.mermaidTruncated, undefined);
      assert.ok(out.count.edges > 0);
      lintMermaid(out.mermaid);
      const file = path.join(FIXTURES, "dependencies.mmd");
      if (process.env.UPDATE_GOLDEN === "1") {
        mkdirSync(FIXTURES, { recursive: true });
        writeFileSync(file, `${out.mermaid}\n`);
      } else {
        assert.equal(`${out.mermaid}\n`, readFileSync(file, "utf8"));
      }
    }),
  );
});

test("dependencyMermaid reports nodes dropped by the diagram cap", async () => {
  const res = await deps({ artifactType: "script_include", sys_id: PRICE });
  await withEnv({ SN_DIAGRAM_MAX_NODES: "2" }, () => {
    freshRuntime();
    const { mermaid, truncated } = dependencyMermaid(res);
    assert.equal(truncated, res.nodes.length - 2);
    assert.match(mermaid, /more_nodes/);
  });
});
