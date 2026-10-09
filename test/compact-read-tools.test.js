// N-62 (O-21 (a)) — the opt-in compact reads on the tools: query_table's
// `fields:"summary"`, `displayValue:"display"`, `omitEmpty` and
// `format:"table"`, get_record's `displayValue` and aggregate's
// `displayValue`. A read without them sends and returns what it always did.
import test from "node:test";
import assert from "node:assert/strict";

import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import {
  TABLE_FORM_CELL,
  EMPTY_OMITTED_NOTE,
} from "../build/api/compact-read.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withFetch,
} from "./helpers.js";

baselineEnv();

const tool = (name) => ALL_TOOLS.find((s) => s.name === name);
const id = (c) => c.repeat(32 / c.length);

const DICT = [
  { element: "number", internal_type: "string", display: "true" },
  { element: "short_description", internal_type: "string" },
  { element: "state", internal_type: "integer", choice: "1" },
  { element: "assigned_to", internal_type: "reference", reference: "sys_user" },
  { element: "opened_at", internal_type: "glide_date_time" },
  { element: "work_notes", internal_type: "journal_input" },
  { element: "sys_updated_on", internal_type: "glide_date_time" },
];

const pair = (value, display_value = value) => ({ value, display_value });

/** One incident in the `display_value=all` shape. */
const ALL_ROW = {
  sys_id: pair(id("a1")),
  number: pair("INC0010001"),
  short_description: pair("Mail down"),
  state: pair("2", "In Progress"),
  assigned_to: pair(id("b2"), "Beth Admin"),
  opened_at: pair("2026-10-01 08:00:00", "10/01/2026 10:00:00"),
  work_notes: pair("", ""),
  sys_updated_on: pair("2026-10-02 08:00:00", "10/02/2026 10:00:00"),
};

/** A mock instance recording every request URL. */
function instance(seen, { incident, layout = [] } = {}) {
  return (url) => {
    const u = new URL(url);
    seen.push(u);
    const parts = u.pathname.split("/");
    const q = u.searchParams.get("sysparm_query") ?? "";
    if (u.pathname.startsWith("/api/now/stats/")) {
      return jsonResponse(200, { result: { stats: { count: "3" } } });
    }
    const table = parts[4];
    if (table === "sys_db_object") {
      return jsonResponse(200, {
        result: [{ name: "incident", "super_class.name": "" }],
      });
    }
    if (table === "sys_dictionary") {
      return jsonResponse(200, {
        result: DICT.map((r) => ({ name: "incident", ...r })),
      });
    }
    if (table === "sys_ui_list_element") {
      assert.match(q, /^list_id\.name=incident\^/);
      return jsonResponse(200, {
        result: layout.map((element, i) => ({ element, position: String(i) })),
      });
    }
    assert.equal(table, "incident", `unexpected request ${url}`);
    const rows = incident(u.searchParams);
    if (parts[5]) return jsonResponse(200, { result: rows[0] });
    return jsonResponse(200, { result: rows }, { "X-Total-Count": "1" });
  };
}

async function call(name, args, mock) {
  freshRuntime();
  const seen = [];
  const res = await withFetch(instance(seen, mock), () =>
    runSpec(tool(name), args),
  );
  assert.ok(!res.isError, res.content[0].text);
  const reads = seen.filter((u) => u.pathname.includes("/incident"));
  return { body: JSON.parse(res.content[0].text), reads, seen };
}

/** Answers like the Table API: a pair per field with `all`, else raw. */
const answer = (params) => {
  const dv = params.get("sysparm_display_value");
  const fields = params.get("sysparm_fields")?.split(",");
  const pick = (r) =>
    fields ? Object.fromEntries(fields.map((f) => [f, r[f]])) : r;
  if (dv === "all") return [pick(ALL_ROW)];
  const key = dv === "true" ? "display_value" : "value";
  return [
    pick(
      Object.fromEntries(Object.entries(ALL_ROW).map(([k, v]) => [k, v[key]])),
    ),
  ];
};

test("N-62: a default query_table read is unchanged", async () => {
  const { body, reads } = await call(
    "servicenow_query_table",
    { table: "incident" },
    { incident: answer },
  );
  assert.equal(reads[0].searchParams.get("sysparm_display_value"), "false");
  assert.equal(reads[0].searchParams.get("sysparm_fields"), null);
  assert.equal(body.field_set, undefined);
  assert.equal(body.records[0].state, "2");
  assert.equal(body.records[0].work_notes, "");
});

test("N-62: displayValue 'display' asks for all and compacts by type", async () => {
  const { body, reads } = await call(
    "servicenow_query_table",
    { table: "incident", displayValue: "display" },
    { incident: answer },
  );
  assert.equal(reads[0].searchParams.get("sysparm_display_value"), "all");
  const r = body.records[0];
  assert.deepEqual(r.assigned_to, [id("b2"), "Beth Admin"]);
  assert.deepEqual(r.state, ["2", "In Progress"]);
  assert.equal(r.opened_at, "2026-10-01 08:00:00");
  assert.equal(r.number, "INC0010001");
  assert.equal("work_notes" in r, false, "journal dropped unless named");

  const named = await call(
    "servicenow_query_table",
    { table: "incident", displayValue: "display", fields: ["work_notes"] },
    { incident: answer },
  );
  assert.equal(named.body.records[0].work_notes, "");
});

test("N-62: fields 'summary' resolves the list view and says so", async () => {
  const { body, reads } = await call(
    "servicenow_query_table",
    { table: "incident", fields: "summary" },
    {
      incident: answer,
      layout: ["number", "short_description", "state", "sys_updated_on"],
    },
  );
  const fields = [
    "sys_id",
    "number",
    "short_description",
    "state",
    "sys_updated_on",
  ];
  assert.equal(reads[0].searchParams.get("sysparm_fields"), fields.join(","));
  assert.equal(body.field_set, "summary");
  assert.deepEqual(body.fields, fields);
  assert.deepEqual(Object.keys(body.records[0]), fields);
});

test("N-62: format 'table' returns columns and rows", async () => {
  const { body } = await call(
    "servicenow_query_table",
    {
      table: "incident",
      displayValue: "display",
      format: "table",
      fields: ["number", "state", "assigned_to"],
    },
    { incident: answer },
  );
  assert.deepEqual(body.columns, ["number", "state", "assigned_to"]);
  assert.deepEqual(body.rows, [
    ["INC0010001", ["2", "In Progress"], [id("b2"), "Beth Admin"]],
  ]);
  assert.equal(body.cell, TABLE_FORM_CELL);
  assert.equal(body.total, 1);
  assert.equal(body.truncated, false);
  assert.equal(body.records, undefined);
});

test("N-62: omitEmpty drops empty cells, keeps 0 and false, lists the columns", async () => {
  const { body } = await call(
    "servicenow_query_table",
    { table: "incident", omitEmpty: true },
    {
      incident: () => [
        {
          sys_id: id("a1"),
          number: "INC1",
          short_description: "",
          state: "0",
          active: "false",
        },
      ],
    },
  );
  assert.deepEqual(body.records, [
    { sys_id: id("a1"), number: "INC1", state: "0", active: "false" },
  ]);
  assert.deepEqual(body.columns, [
    "sys_id",
    "number",
    "short_description",
    "state",
    "active",
  ]);
  assert.equal(body.empty_omitted, 1);
  assert.equal(body.empty_note, EMPTY_OMITTED_NOTE);
});

test("N-62: displayValue 'display' with csv sends display values", async () => {
  const { body, reads } = await call(
    "servicenow_query_table",
    {
      table: "incident",
      displayValue: "display",
      format: "csv",
      fields: ["state"],
    },
    { incident: answer },
  );
  assert.equal(reads[0].searchParams.get("sysparm_display_value"), "true");
  assert.match(body.content, /In Progress/);
});

test("N-62: get_record takes displayValue; the default sends none", async () => {
  const plain = await call(
    "servicenow_get_record",
    { table: "incident", sys_id: id("a1") },
    { incident: answer },
  );
  assert.equal(plain.reads[0].searchParams.has("sysparm_display_value"), false);
  assert.equal(plain.body.state, "2");

  const shown = await call(
    "servicenow_get_record",
    { table: "incident", sys_id: id("a1"), displayValue: "true" },
    { incident: answer },
  );
  assert.equal(
    shown.reads[0].searchParams.get("sysparm_display_value"),
    "true",
  );
  assert.equal(shown.body.state, "In Progress");

  const compact = await call(
    "servicenow_get_record",
    { table: "incident", sys_id: id("a1"), displayValue: "display" },
    { incident: answer },
  );
  assert.equal(
    compact.reads[0].searchParams.get("sysparm_display_value"),
    "all",
  );
  assert.deepEqual(compact.body.assigned_to, [id("b2"), "Beth Admin"]);
  assert.equal("work_notes" in compact.body, false);
});

test("N-62: get_record display survives a failed dictionary read", async () => {
  freshRuntime();
  const res = await withFetch(
    (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/incident/" + id("a1"))) {
        return jsonResponse(200, { result: ALL_ROW });
      }
      return jsonResponse(403, { error: { message: "ACL denied" } });
    },
    () =>
      runSpec(tool("servicenow_get_record"), {
        table: "incident",
        sys_id: id("a1"),
        displayValue: "display",
      }),
  );
  const body = JSON.parse(res.content[0].text);
  assert.deepEqual(body.state, ["2", "In Progress"]);
  assert.equal(body.number, "INC0010001");
  assert.match(body._warnings[0], /^dictionary \(incident\): unavailable/);
});

test("N-62: aggregate displayValue sends sysparm_display_value=all; the default none", async () => {
  const plain = await call(
    "servicenow_aggregate",
    { table: "incident", count: true, group_by: ["assigned_to"] },
    {},
  );
  assert.equal(plain.seen[0].searchParams.has("sysparm_display_value"), false);
  const shown = await call(
    "servicenow_aggregate",
    {
      table: "incident",
      count: true,
      group_by: ["assigned_to"],
      displayValue: true,
    },
    {},
  );
  assert.equal(shown.seen[0].searchParams.get("sysparm_display_value"), "all");
});
