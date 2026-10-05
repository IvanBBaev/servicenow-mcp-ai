import test from "node:test";
import assert from "node:assert/strict";

import {
  REFERENCE_SOURCES,
  STRUCTURAL_SOURCE_LIMIT,
  encodedQueryFields,
  extractReferences,
  findStructuralReferences,
  parseRefTarget,
  refMatches,
  scriptIdentifiers,
} from "../build/api/references.js";
import { whereUsed, whereUsedCaveats } from "../build/api/whereused.js";
import { runWithCall } from "../build/core/request-context.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

baselineEnv();

/** Table segment of a Table API URL. */
const tableOf = (url) => new URL(url).pathname.split("/").pop();
const queryOf = (url) => new URL(url).searchParams.get("sysparm_query") ?? "";
const source = (id) => REFERENCE_SOURCES.find((s) => s.id === id);

/** Serve `rows[table]` for a table, `[]` for everything else. */
function serve(rows) {
  return (url) => jsonResponse(200, { result: rows[tableOf(url)] ?? [] });
}

test.beforeEach(() => {
  freshRuntime();
});

// -- pure layer ---------------------------------------------------------------

test("parseRefTarget splits table.field and leaves tables and scripts alone", () => {
  assert.deepEqual(parseRefTarget("field", "incident.priority"), {
    kind: "field",
    name: "incident.priority",
    table: "incident",
    element: "priority",
  });
  assert.deepEqual(parseRefTarget("field", " priority "), {
    kind: "field",
    name: "priority",
    element: "priority",
  });
  assert.deepEqual(parseRefTarget("table", "incident"), {
    kind: "table",
    name: "incident",
  });
  assert.deepEqual(parseRefTarget("script", "MyUtil"), {
    kind: "script",
    name: "MyUtil",
  });
});

test("encodedQueryFields reads field paths from every term", () => {
  const fields = encodedQueryFields(
    "active=true^priority<=2^ORcaller_id.vip=true^NQstateISEMPTY^EQ^ORDERBYDESCsys_created_on^GROUPBYcategory",
  );
  assert.deepEqual(
    fields.map((f) => f.path),
    [
      "active",
      "priority",
      "caller_id.vip",
      "state",
      "sys_created_on",
      "category",
    ],
  );
  assert.equal(fields[1].term, "priority<=2");
  assert.deepEqual(encodedQueryFields(""), []);
});

test("scriptIdentifiers finds constructor and static calls, skipping globals", () => {
  assert.deepEqual(
    scriptIdentifiers(
      "javascript:new global.MyUtil().filter() + AcmeHelper.qual(current) + new GlideRecord('x') + JSON.stringify(a) + gs.getUserID()",
    ).sort(),
    ["AcmeHelper", "MyUtil"],
  );
  assert.deepEqual(scriptIdentifiers("priority=1"), []);
});

test("refMatches: field refs match by element, table when both known", () => {
  const ref = (target) => ({
    kind: "report",
    table: "sys_report",
    sys_id: "r",
    name: "R",
    field: "filter",
    target,
  });
  const onIncident = ref({
    kind: "field",
    element: "priority",
    table: "incident",
  });
  const tableless = ref({ kind: "field", element: "priority" });
  assert.ok(refMatches(onIncident, parseRefTarget("field", "priority")));
  assert.ok(
    refMatches(onIncident, parseRefTarget("field", "incident.priority")),
  );
  assert.ok(
    !refMatches(onIncident, parseRefTarget("field", "problem.priority")),
  );
  assert.ok(refMatches(tableless, parseRefTarget("field", "problem.priority")));
  assert.ok(!refMatches(onIncident, parseRefTarget("table", "incident")));
  assert.ok(
    refMatches(
      ref({ kind: "script", name: "MyUtil" }),
      parseRefTarget("script", "MyUtil"),
    ),
  );
});

test("every source exposes a query only for the kinds it can hold", () => {
  const t = parseRefTarget("table", "incident");
  const f = parseRefTarget("field", "incident.priority");
  const s = parseRefTarget("script", "MyUtil");
  const has = (target) =>
    REFERENCE_SOURCES.filter((src) => src.query(target)).map((x) => x.id);
  assert.deepEqual(has(t), [
    "dictionary_reference",
    "list_layout",
    "form_section",
    "catalog_variable",
    "flow_action_input",
    "flow_input",
    "report",
    "pa_indicator_source",
  ]);
  assert.deepEqual(has(f), [
    "list_element",
    "form_element",
    "catalog_variable",
    "report",
    "pa_indicator_source",
  ]);
  assert.deepEqual(has(s), [
    "dictionary_reference",
    "catalog_variable",
    "report",
    "pa_indicator_source",
  ]);
  assert.equal(
    source("list_element").query(f),
    "element=priority^ORelementSTARTSWITHpriority.^list_id.name=incident",
  );
  assert.equal(
    source("report").query(f),
    "filterLIKEpriority^ORfield=priority^table=incident",
  );
  // A field target without an element (e.g. "incident.") queries nothing.
  assert.equal(
    source("list_element").query(parseRefTarget("field", "incident.")),
    undefined,
  );
});

test("extractReferences returns every outbound ref of a report record (P-17 shape)", () => {
  const refs = extractReferences(source("report"), {
    sys_id: "rep1",
    title: "P1 by group",
    table: "incident",
    field: "assignment_group",
    filter:
      "priority=1^caller_id.vip=true^assigned_to=javascript:new MyUtil().me()",
  });
  assert.deepEqual(
    refs.map((r) => [r.field, r.target]),
    [
      ["table", { kind: "table", table: "incident" }],
      [
        "field",
        { kind: "field", element: "assignment_group", table: "incident" },
      ],
      ["filter", { kind: "field", element: "priority", table: "incident" }],
      ["filter", { kind: "field", element: "caller_id", table: "incident" }],
      ["filter", { kind: "field", element: "assigned_to", table: "incident" }],
      ["filter", { kind: "script", name: "MyUtil" }],
    ],
  );
  assert.ok(refs.every((r) => r.kind === "report" && r.name === "P1 by group"));
});

// -- one test per kind ----------------------------------------------------------

test("reference_field: dictionary entries that reference the table", async () => {
  await withFetch(
    serve({
      sys_dictionary: [
        {
          sys_id: "d1",
          name: "problem",
          element: "u_incident",
          reference: "incident",
        },
        // Unrelated row (e.g. a dropped condition): re-checked and left out.
        { sys_id: "d2", name: "task", element: "parent", reference: "task" },
        // The collection row has no element.
        { sys_id: "d3", name: "incident", element: "", reference: "incident" },
      ],
    }),
    async (calls) => {
      const r = await findStructuralReferences(
        parseRefTarget("table", "incident"),
      );
      const refs = r.refs.filter((x) => x.kind === "reference_field");
      assert.deepEqual(refs, [
        {
          kind: "reference_field",
          table: "sys_dictionary",
          sys_id: "d1",
          name: "problem.u_incident",
          parent: "problem",
          field: "reference",
          target: { kind: "table", table: "incident" },
          value: "incident",
        },
      ]);
      assert.equal(r.sources.dictionary_reference.scanned, 3);
      assert.equal(r.sources.dictionary_reference.matched, 1);
      const call = calls.find((c) => tableOf(c.url) === "sys_dictionary");
      assert.equal(queryOf(call.url), "reference=incident");
    },
  );
});

test("reference_field: reference qualifiers calling a script include", async () => {
  await withFetch(
    serve({
      sys_dictionary: [
        {
          sys_id: "d1",
          name: "incident",
          element: "assigned_to",
          reference: "sys_user",
          reference_qual: "javascript:new MyUtil().activeAgents()",
        },
      ],
    }),
    async () => {
      const r = await findStructuralReferences(
        parseRefTarget("script", "MyUtil"),
      );
      const [ref] = r.refs;
      assert.equal(ref.kind, "reference_field");
      assert.equal(ref.field, "reference_qual");
      assert.equal(ref.name, "incident.assigned_to");
      assert.deepEqual(ref.target, { kind: "script", name: "MyUtil" });
    },
  );
});

test("list_layout / form_layout: table layouts and field elements", async () => {
  await withFetch(
    serve({
      sys_ui_list: [
        { sys_id: "l1", name: "incident", "view.name": "" },
        { sys_id: "l2", name: "incident", "view.name": "ess" },
      ],
      sys_ui_section: [
        {
          sys_id: "s1",
          name: "incident",
          caption: "Notes",
          "view.name": "",
        },
      ],
      sys_ui_list_element: [
        {
          sys_id: "le1",
          element: "priority",
          "list_id.name": "incident",
          "list_id.view.name": "",
        },
        {
          sys_id: "le2",
          element: "priority.label",
          "list_id.name": "incident",
          "list_id.view.name": "",
        },
      ],
      sys_ui_element: [
        {
          sys_id: "fe1",
          element: "priority",
          "sys_ui_section.name": "incident",
          "sys_ui_section.view.name": "ess",
        },
        // Same field on another table: excluded for incident.priority.
        {
          sys_id: "fe2",
          element: "priority",
          "sys_ui_section.name": "problem",
          "sys_ui_section.view.name": "",
        },
      ],
    }),
    async () => {
      const t = await findStructuralReferences(
        parseRefTarget("table", "incident"),
      );
      assert.deepEqual(
        t.refs.map((x) => [x.kind, x.table, x.name, x.field]),
        [
          [
            "list_layout",
            "sys_ui_list",
            "incident list [Default view]",
            "name",
          ],
          ["list_layout", "sys_ui_list", "incident list [ess]", "name"],
          [
            "form_layout",
            "sys_ui_section",
            "incident form [Default view] Notes",
            "name",
          ],
        ],
      );

      const f = await findStructuralReferences(
        parseRefTarget("field", "incident.priority"),
      );
      assert.deepEqual(
        f.refs.map((x) => [x.kind, x.sys_id, x.name, x.value]),
        [
          [
            "list_layout",
            "le1",
            "incident list [Default view]: priority",
            "priority",
          ],
          [
            "list_layout",
            "le2",
            "incident list [Default view]: priority.label",
            "priority.label",
          ],
          ["form_layout", "fe1", "incident form [ess]: priority", "priority"],
        ],
      );
      assert.equal(f.byKind.list_layout, 2);
      assert.equal(f.byKind.form_layout, 1);
    },
  );
});

test("catalog_variable: reference / list / lookup tables, mapped fields, qualifiers", async () => {
  const variables = [
    {
      sys_id: "v1",
      name: "affected_incident",
      "cat_item.name": "Report outage",
      reference: "incident",
    },
    {
      sys_id: "v2",
      name: "related",
      "variable_set.title": "Common",
      list_table: "incident",
      reference_qual: "javascript:AcmeQual.forUser()",
    },
    {
      sys_id: "v3",
      name: "urgency_pick",
      "cat_item.name": "Create incident",
      map_to_field: "true",
      field: "priority",
      default_value: "javascript:new MyUtil().defaultPriority()",
    },
    // Mapping switched off: the field value is not a reference.
    {
      sys_id: "v4",
      name: "unmapped",
      map_to_field: "false",
      field: "priority",
    },
  ];
  await withFetch(serve({ item_option_new: variables }), async () => {
    const t = await findStructuralReferences(
      parseRefTarget("table", "incident"),
    );
    assert.deepEqual(
      t.refs.map((x) => [x.sys_id, x.name, x.field, x.parent]),
      [
        [
          "v1",
          "Report outage: affected_incident",
          "reference",
          "Report outage",
        ],
        ["v2", "Common: related", "list_table", "Common"],
      ],
    );

    // The producer's table is not on the variable: matches any table.
    const f = await findStructuralReferences(
      parseRefTarget("field", "incident.priority"),
    );
    assert.deepEqual(
      f.refs.map((x) => [x.sys_id, x.field, x.target]),
      [["v3", "field", { kind: "field", element: "priority" }]],
    );

    const s = await findStructuralReferences(
      parseRefTarget("script", "MyUtil"),
    );
    assert.deepEqual(
      s.refs.map((x) => [x.sys_id, x.field]),
      [["v3", "default_value"]],
    );
    const q = await findStructuralReferences(
      parseRefTarget("script", "AcmeQual"),
    );
    assert.deepEqual(
      q.refs.map((x) => [x.sys_id, x.field]),
      [["v2", "reference_qual"]],
    );
    assert.equal(q.sources.catalog_variable.verified, false);
  });
});

test("flow_input: action and flow inputs that reference the table", async () => {
  await withFetch(
    serve({
      sys_hub_action_input: [
        {
          sys_id: "ai1",
          element: "incident_record",
          label: "Incident",
          reference: "incident",
          "model.name": "Resolve Incident",
        },
      ],
      sys_hub_flow_input: [
        { sys_id: "fi1", element: "rec", label: "", reference: "incident" },
        { sys_id: "fi2", element: "user", reference: "sys_user" },
      ],
    }),
    async () => {
      const r = await findStructuralReferences(
        parseRefTarget("table", "incident"),
      );
      assert.deepEqual(
        r.refs
          .filter((x) => x.kind === "flow_input")
          .map((x) => [x.table, x.sys_id, x.name, x.field]),
        [
          [
            "sys_hub_action_input",
            "ai1",
            "Resolve Incident: Incident",
            "reference",
          ],
          ["sys_hub_flow_input", "fi1", "rec", "reference"],
        ],
      );
      assert.equal(r.sources.flow_action_input.verified, false);
      assert.equal(r.sources.flow_input.available, true);
    },
  );
});

test("report: table, group-by and filter conditions", async () => {
  const reports = [
    {
      sys_id: "r1",
      title: "Open P1",
      table: "incident",
      field: "",
      filter: "active=true^priority=1",
    },
    {
      sys_id: "r2",
      title: "By priority",
      table: "incident",
      field: "priority",
      filter: "",
    },
    // LIKE matched `u_priority_x`, not `priority`: re-checked and left out.
    {
      sys_id: "r3",
      title: "Custom",
      table: "incident",
      field: "",
      filter: "u_priority_x=2",
    },
  ];
  await withFetch(serve({ sys_report: reports }), async () => {
    const f = await findStructuralReferences(
      parseRefTarget("field", "priority"),
    );
    assert.deepEqual(
      f.refs.map((x) => [x.sys_id, x.field, x.value]),
      [
        ["r1", "filter", "priority=1"],
        ["r2", "field", "priority"],
      ],
    );
    const t = await findStructuralReferences(
      parseRefTarget("table", "incident"),
    );
    assert.equal(t.byKind.report, 3);
    assert.ok(t.refs.every((x) => x.kind !== "report" || x.field === "table"));
  });
});

// N-8; O-5: verify on a live instance (fixture queued for the O-2 corpus).
test("where_used of a field finds the report and the PA indicator source that filter on it", async () => {
  await withFetch(
    serve({
      sys_report: [
        {
          sys_id: "r1",
          title: "Open P1",
          table: "incident",
          field: "",
          filter: "active=true^priority=1",
        },
      ],
      pa_cubes: [
        {
          sys_id: "c1",
          name: "Open incidents",
          facts_table: "incident",
          conditions: "active=true^priorityIN1,2",
        },
        // Another table's source: never a match for incident.priority.
        {
          sys_id: "c2",
          name: "Open problems",
          facts_table: "problem",
          conditions: "priority=1",
        },
      ],
    }),
    async (calls) => {
      const f = await findStructuralReferences(
        parseRefTarget("field", "incident.priority"),
      );
      assert.deepEqual(
        f.refs.map((x) => [x.kind, x.table, x.sys_id, x.field, x.value]),
        [
          ["report", "sys_report", "r1", "filter", "priority=1"],
          [
            "pa_indicator_source",
            "pa_cubes",
            "c1",
            "conditions",
            "priorityIN1,2",
          ],
        ],
      );
      assert.equal(f.sources.pa_indicator_source.verified, false);
      assert.ok(
        calls.some(
          (c) =>
            tableOf(c.url) === "pa_cubes" &&
            queryOf(c.url) === "conditionsLIKEpriority^facts_table=incident",
        ),
      );
      const t = await findStructuralReferences(
        parseRefTarget("table", "incident"),
      );
      assert.deepEqual(
        t.refs
          .filter((x) => x.kind === "pa_indicator_source")
          .map((x) => [x.sys_id, x.field]),
        [["c1", "facts_table"]],
      );
    },
  );
});

test("PA unreadable: an absent pa_cubes table degrades to available:false naming the plugin", async () => {
  await withFetch(
    (url) =>
      tableOf(url) === "pa_cubes"
        ? jsonResponse(400, { error: { message: "Invalid table pa_cubes" } })
        : jsonResponse(200, { result: [] }),
    async () => {
      const r = await findStructuralReferences(
        parseRefTarget("field", "incident.priority"),
      );
      const pa = r.sources.pa_indicator_source;
      assert.equal(pa.available, false);
      assert.match(
        pa.unavailableReason,
        /pa_cubes does not exist.*400.*requires Performance Analytics \(com\.snc\.pa\)/,
      );
      assert.equal(r.sources.report.available, true);
    },
  );
});

// -- degrade path -----------------------------------------------------------------

test("an unreadable or missing source degrades to available:false", async () => {
  await withFetch(
    (url) => {
      const table = tableOf(url);
      if (table === "sys_hub_action_input" || table === "sys_hub_flow_input") {
        return jsonResponse(400, { error: { message: "Invalid table" } });
      }
      if (table === "sys_report") {
        return jsonResponse(403, { error: { message: "denied" } });
      }
      if (table === "sys_dictionary") {
        return jsonResponse(200, {
          result: [
            {
              sys_id: "d1",
              name: "problem",
              element: "x",
              reference: "incident",
            },
          ],
        });
      }
      return jsonResponse(200, { result: [] });
    },
    async () => {
      const r = await findStructuralReferences(
        parseRefTarget("table", "incident"),
      );
      assert.equal(r.count, 1);
      assert.equal(r.sources.sys_report, undefined);
      const rep = r.sources.report;
      assert.equal(rep.available, false);
      assert.match(rep.unavailableReason, /sys_report is not readable.*403/);
      assert.equal(r.sources.flow_action_input.available, false);
      assert.match(
        r.sources.flow_action_input.unavailableReason,
        /does not exist.*400/,
      );
      assert.equal(r.sources.dictionary_reference.available, true);
    },
  );
});

test("a policy-denied source degrades without a request", async () => {
  await withEnv({ SN_TABLES_DENY: "sys_report,item_option_new" }, async () => {
    await withFetch(serve({}), async (calls) => {
      const r = await findStructuralReferences(
        parseRefTarget("table", "incident"),
      );
      assert.equal(r.sources.report.available, false);
      assert.equal(r.sources.catalog_variable.available, false);
      assert.ok(
        !calls.some((c) =>
          ["sys_report", "item_option_new"].includes(tableOf(c.url)),
        ),
      );
      assert.equal(r.sources.list_layout.available, true);
    });
  });
});

test("a transport failure degrades every source instead of throwing", async () => {
  const failure = new Error("socket hang up");
  await withFetch(
    () => {
      throw failure;
    },
    async () => {
      const r = await findStructuralReferences(
        parseRefTarget("script", "MyUtil"),
      );
      assert.ok(Object.values(r.sources).every((s) => !s.available));
    },
  );
});

test("a full page marks the source truncated", async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({
    sys_id: `d${i}`,
    name: "problem",
    element: `f${i}`,
    reference: "incident",
  }));
  await withFetch(serve({ sys_dictionary: rows }), async (calls) => {
    const r = await findStructuralReferences(
      parseRefTarget("table", "incident"),
      { limit: 3, sources: [source("dictionary_reference")] },
    );
    assert.equal(r.sources.dictionary_reference.truncated, true);
    assert.equal(r.count, 3);
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).searchParams.get("sysparm_limit"), "3");
  });
  assert.equal(STRUCTURAL_SOURCE_LIMIT, 100);
});

// -- scope filtering ----------------------------------------------------------------

test("scope restricts every source read through its scope field", async () => {
  await withFetch(serve({}), async (calls) => {
    await findStructuralReferences(parseRefTarget("table", "incident"), {
      scope: "x_acme_app",
    });
    await findStructuralReferences(parseRefTarget("field", "priority"), {
      scope: "0123456789abcdef0123456789abcdef",
    });
    const q = Object.fromEntries(
      calls.map((c) => [`${tableOf(c.url)}`, queryOf(c.url)]),
    );
    assert.match(
      q.sys_dictionary,
      /^sys_scope\.scope=x_acme_app\^reference=incident$/,
    );
    assert.match(q.sys_ui_list, /^sys_scope\.scope=x_acme_app\^/);
    assert.equal(
      q.sys_ui_list_element,
      "list_id.sys_scope=0123456789abcdef0123456789abcdef^element=priority^ORelementSTARTSWITHpriority.",
    );
    assert.match(
      q.sys_ui_element,
      /^sys_ui_section\.sys_scope=0123456789abcdef0123456789abcdef\^/,
    );
    assert.match(q.sys_report, /^sys_scope=0123456789abcdef0123456789abcdef\^/);
  });
  await assert.rejects(
    findStructuralReferences(parseRefTarget("table", "incident"), {
      scope: "x^y",
    }),
  );
});

// -- where-used integration -----------------------------------------------------------

test("whereUsed adds a structural section and keeps count/byType textual", async () => {
  await withFetch(
    serve({
      sys_dictionary: [
        {
          sys_id: "d1",
          name: "problem",
          element: "u_inc",
          reference: "incident",
        },
      ],
      sys_report: [
        { sys_id: "r1", title: "Incidents", table: "incident", filter: "" },
      ],
      sys_hub_flow_input: [],
    }),
    async () => {
      const r = await whereUsed("table", "incident", { mermaid: true });
      assert.equal(r.count, r.references.length);
      assert.equal(r.structural.count, 2);
      assert.deepEqual(r.structural.byKind, {
        reference_field: 1,
        report: 1,
      });
      assert.ok(!("reference_field" in r.byType));
      assert.match(r.caveats[0], /structural pass/);
      assert.match(r.mermaid, /reference_field: problem\.u_inc/);
      assert.match(r.mermaid, /report: Incidents/);
    },
  );
});

test("whereUsed(structural:false) skips the structural reads", async () => {
  await withFetch(serve({}), async (calls) => {
    const r = await whereUsed("table", "incident", { structural: false });
    assert.equal(r.structural, undefined);
    assert.deepEqual(r.caveats, whereUsedCaveats("table", "incident", 0));
    assert.ok(
      !calls.some((c) =>
        ["sys_report", "sys_ui_list", "item_option_new"].includes(
          tableOf(c.url),
        ),
      ),
    );
  });
});

test("whereUsed lists unreadable and truncated structural sources as caveats", async () => {
  const many = Array.from({ length: STRUCTURAL_SOURCE_LIMIT }, (_, i) => ({
    sys_id: `l${i}`,
    name: "incident",
  }));
  await withFetch(
    (url) =>
      tableOf(url) === "sys_report"
        ? jsonResponse(403, { error: { message: "denied" } })
        : serve({ sys_ui_list: many })(url),
    async () => {
      const r = await whereUsed("table", "incident", { scope: "global" });
      const unread = r.caveats.find((c) => /^Not searched/.test(c));
      assert.match(unread, /sys_report/);
      assert.ok(
        r.caveats.some((c) =>
          /structural pass stopped early on sys_ui_list/.test(c),
        ),
      );
      assert.equal(r.structural.sources.list_layout.truncated, true);
    },
  );
});

test("whereUsed(field, table.field) searches layouts of that table", async () => {
  await withFetch(serve({}), async (calls) => {
    const r = await whereUsed("field", "incident.priority");
    assert.equal(r.structural.count, 0);
    const le = calls.find((c) => tableOf(c.url) === "sys_ui_list_element");
    assert.match(queryOf(le.url), /list_id\.name=incident$/);
  });
});

test("a cancelled call fails with CANCELLED instead of degrading", async () => {
  const controller = new AbortController();
  controller.abort();
  await runWithCall(
    {
      requestId: "r",
      tool: "servicenow_where_used",
      signal: controller.signal,
    },
    async () => {
      await withFetch(serve({}), async (calls) => {
        await assert.rejects(
          findStructuralReferences(parseRefTarget("table", "incident")),
          (err) => err.code === "CANCELLED",
        );
        assert.equal(calls.length, 0);
      });
    },
  );
});
