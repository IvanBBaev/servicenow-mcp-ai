// N-62 — compact reads (dark core): the summary field-set resolver, display
// compaction by dictionary type, omit_empty and the table form.
import test from "node:test";
import assert from "node:assert/strict";

import {
  compactDisplayRecord,
  omitEmpty,
  pickDisplayField,
  summaryFields,
  TABLE_FORM_CELL,
  toTableForm,
} from "../build/api/compact-read.js";
import { runWithCall } from "../build/core/request-context.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withFetch,
} from "./helpers.js";

baselineEnv();

const col = (element, extra = {}) => ({ element, ...extra });

/**
 * A mock instance: `parents` maps a table to its super class, `dict` a table
 * to its dictionary rows, `layouts` a table to its default list elements
 * (a function there answers the layout read instead).
 */
function instance({ parents = {}, dict = {}, layouts = {} }) {
  return (url) => {
    const u = new URL(url);
    const table = u.pathname.split("/").pop();
    const q = u.searchParams.get("sysparm_query") ?? "";
    if (table === "sys_db_object") {
      const name = q.replace(/^name=/, "");
      const parent = parents[name];
      return jsonResponse(200, {
        result: [{ name, "super_class.name": parent ?? "" }],
      });
    }
    if (table === "sys_dictionary") {
      const names = q.match(/^nameIN([^^]+)/)[1].split(",");
      return jsonResponse(200, {
        result: names.flatMap((n) =>
          (dict[n] ?? []).map((r) => ({ name: n, ...r })),
        ),
      });
    }
    if (table === "sys_ui_list_element") {
      const t = q.match(/^list_id\.name=([^^]+)/)[1];
      const layout = layouts[t];
      if (typeof layout === "function") return layout();
      return jsonResponse(200, {
        result: (layout ?? []).map((element, i) => ({
          element,
          position: String(i),
        })),
      });
    }
    return jsonResponse(501, { error: { message: `no route ${table}` } });
  };
}

const TASK_DICT = [
  { element: "number", internal_type: "string", display: "true" },
  { element: "short_description", internal_type: "string" },
  { element: "state", internal_type: "integer", choice: "1" },
  { element: "priority", internal_type: "integer", choice: "1" },
  { element: "assigned_to", internal_type: "reference", reference: "sys_user" },
  { element: "sys_updated_on", internal_type: "glide_date_time" },
  { element: "work_notes", internal_type: "journal_input" },
];

test("display field: child-most display=true, then name, then number", () => {
  const chain = ["u_child", "task"];
  assert.equal(
    pickDisplayField(
      [
        col("number", { display: true, sourceTable: "task" }),
        col("u_title", { display: true, sourceTable: "u_child" }),
      ],
      chain,
    ),
    "u_title",
  );
  assert.equal(
    pickDisplayField(
      [
        col("number", { display: true, sourceTable: "task" }),
        col("x", { display: true, sourceTable: "elsewhere" }),
      ],
      chain,
    ),
    "number",
  );
  assert.equal(pickDisplayField([col("number"), col("name")], chain), "name");
  assert.equal(pickDisplayField([col("number")], chain), "number");
  assert.equal(pickDisplayField([col("u_x")], chain), undefined);
});

test("summary: the table's own default list layout", async () => {
  freshRuntime();
  await withFetch(
    instance({
      parents: { incident: "task" },
      dict: {
        task: TASK_DICT,
        incident: [{ element: "caller_id", internal_type: "reference" }],
      },
      layouts: {
        incident: [
          "number",
          "caller_id.name",
          ".split",
          "short_description",
          "u_gone",
          "state",
          "sys_updated_on",
        ],
      },
    }),
    async (calls) => {
      const s = await summaryFields("incident");
      assert.deepEqual(s, {
        table: "incident",
        field_set: "summary",
        fields: [
          "sys_id",
          "number",
          "caller_id.name",
          "short_description",
          "state",
          "sys_updated_on",
        ],
        displayField: "number",
        source: "list_layout",
        layoutTable: "incident",
      });
      const layoutQuery = new URL(
        calls.find((c) => c.url.includes("sys_ui_list_element")).url,
      ).searchParams.get("sysparm_query");
      assert.equal(
        layoutQuery,
        "list_id.name=incident^list_id.view.name=NULL^list_id.parentISEMPTY" +
          "^list_id.sys_userISEMPTY^ORDERBYposition",
      );
      // Warm: every read is served from the schema cache.
      const before = calls.length;
      assert.deepEqual(await summaryFields("incident"), s);
      assert.equal(calls.length, before);
    },
  );
});

test("summary: a custom table walks up to its parent's layout and caps at 12", async () => {
  freshRuntime();
  const many = Array.from({ length: 15 }, (_, i) => `u_c${i}`);
  await withFetch(
    instance({
      parents: { u_child: "u_base" },
      dict: {
        u_base: [
          ...many.map((element) => ({ element, internal_type: "string" })),
          { element: "u_label", internal_type: "string", display: "true" },
        ],
        u_child: [],
      },
      layouts: { u_base: ["u_label", ...many] },
    }),
    async () => {
      const s = await summaryFields("u_child");
      assert.equal(s.source, "list_layout");
      assert.equal(s.layoutTable, "u_base");
      assert.equal(s.displayField, "u_label");
      assert.deepEqual(s.fields, [
        "sys_id",
        "u_label",
        ...many.slice(0, 12),
        "sys_updated_on",
      ]);
    },
  );
});

test("summary: no layout anywhere → heuristic set filtered by the dictionary", async () => {
  freshRuntime();
  await withFetch(
    instance({
      parents: { u_thing: "" },
      dict: {
        u_thing: [
          { element: "name", internal_type: "string" },
          { element: "active", internal_type: "boolean" },
          { element: "u_other", internal_type: "string" },
        ],
      },
    }),
    async () => {
      const s = await summaryFields("u_thing");
      assert.deepEqual(s, {
        table: "u_thing",
        field_set: "summary",
        fields: ["sys_id", "name", "active", "sys_updated_on"],
        displayField: "name",
        source: "heuristic",
      });
    },
  );
});

test("summary: an unreadable layout becomes a warning and is retried later", async () => {
  freshRuntime();
  let denied = true;
  await withFetch(
    instance({
      dict: { task: TASK_DICT },
      layouts: {
        task: () =>
          denied
            ? jsonResponse(403, { error: { message: "ACL" } })
            : jsonResponse(200, { result: [{ element: "priority" }] }),
      },
    }),
    async () => {
      const first = await summaryFields("task");
      assert.equal(first.source, "heuristic");
      assert.match(
        first.warnings[0],
        /^sys_ui_list_element \(task\): unavailable/,
      );
      assert.deepEqual(first.fields, [
        "sys_id",
        "number",
        "short_description",
        "state",
        "priority",
        "assigned_to",
        "sys_updated_on",
      ]);
      denied = false;
      const second = await summaryFields("task");
      assert.equal(second.source, "list_layout");
      assert.equal(second.warnings, undefined);
      assert.deepEqual(second.fields, [
        "sys_id",
        "number",
        "priority",
        "sys_updated_on",
      ]);
    },
  );
});

test("summary: a cancelled layout read propagates; a caret is rejected", async () => {
  freshRuntime();
  await withFetch(
    instance({
      dict: { task: TASK_DICT },
      layouts: {
        task: () => jsonResponse(500, { error: { message: "boom" } }),
      },
    }),
    async (calls) => {
      // Warm the dictionary; the failed layout read is not cached.
      await summaryFields("task");
      const controller = new AbortController();
      controller.abort();
      await runWithCall(
        { requestId: "r", tool: "t", signal: controller.signal },
        () =>
          assert.rejects(summaryFields("task"), (e) => e.code === "CANCELLED"),
      );
      assert.ok(calls.length > 0);
    },
  );
  await assert.rejects(summaryFields("task^ORnumber=1"), /table/);
});

const COLUMNS = [
  col("assigned_to", { type: "reference", reference: "sys_user" }),
  col("caller_id", { type: "reference" }),
  col("state", { type: "integer", choice: "1" }),
  col("priority", { type: "integer", choice: "1" }),
  col("opened_at", { type: "glide_date_time" }),
  col("work_notes", { type: "journal_input" }),
  col("comments", { type: "journal_input" }),
  col("impact_score", { type: "decimal" }),
];

test("display compaction by dictionary type", () => {
  const out = compactDisplayRecord(
    {
      sys_id: "abc",
      assigned_to: {
        value: "u1",
        display_value: "Beth Anglin",
        link: "https://x/api/now/table/sys_user/u1",
      },
      caller_id: { value: "", display_value: "" },
      state: { value: "2", display_value: "In Progress" },
      priority: { value: "Low", display_value: "Low" },
      opened_at: {
        value: "2026-10-01 08:00:00",
        display_value: "01.10.2026 11:00:00",
      },
      work_notes: { value: "x", display_value: "long journal" },
      comments: { value: "c", display_value: "named journal" },
      impact_score: { value: "1000", display_value: "1,000" },
      "caller_id.name": { value: "Abel", display_value: "Abel" },
      "caller_id.dept": { value: "d1", display_value: "IT" },
      raw_object: { nested: true },
      gone: null,
    },
    COLUMNS,
    new Set(["comments"]),
  );
  assert.deepEqual(out, {
    sys_id: "abc",
    assigned_to: ["u1", "Beth Anglin"],
    caller_id: "",
    state: ["2", "In Progress"],
    priority: "Low",
    opened_at: "2026-10-01 08:00:00",
    comments: "named journal",
    impact_score: "1,000",
    "caller_id.name": "Abel",
    "caller_id.dept": ["d1", "IT"],
    raw_object: '{"nested":true}',
    gone: null,
  });
  assert.equal("work_notes" in out, false);
});

test("display compaction: journal dropped by default, plain values pass through", () => {
  assert.deepEqual(
    compactDisplayRecord({ work_notes: "plain", n: 3, b: false }, COLUMNS),
    { n: 3, b: false },
  );
});

test("omit_empty drops empty cells but keeps 0 and false", () => {
  const { records, emptyOmitted } = omitEmpty([
    {
      a: "",
      b: "0",
      c: "false",
      d: null,
      e: { value: "", display_value: "" },
      f: { value: "", display_value: "x" },
      g: ["", ""],
      h: ["u1", ""],
      i: 0,
      j: false,
    },
    { a: "x", d: undefined },
  ]);
  assert.deepEqual(records, [
    {
      b: "0",
      c: "false",
      f: { value: "", display_value: "x" },
      h: ["u1", ""],
      i: 0,
      j: false,
    },
    { a: "x" },
  ]);
  assert.equal(emptyOmitted, 5);
});

test("table form with display_value=all records", () => {
  const records = [
    {
      number: { value: "INC1", display_value: "INC1" },
      assigned_to: {
        value: "u1",
        display_value: "Beth",
        link: "https://x/api/now/table/sys_user/u1",
      },
      state: { value: "2", display_value: "In Progress" },
    },
    { number: "INC2", extra: 5 },
    { number: "INC3" },
  ];
  assert.deepEqual(toTableForm(records), {
    columns: ["number", "assigned_to", "state", "extra"],
    rows: [
      ["INC1", ["u1", "Beth"], ["2", "In Progress"], null],
      ["INC2", null, null, 5],
      ["INC3", null, null, null],
    ],
    cell: TABLE_FORM_CELL,
    total: 3,
    truncated: false,
  });

  const capped = toTableForm(records, {
    columns: ["number"],
    total: 40,
    maxRows: 2,
  });
  assert.deepEqual(capped.rows, [["INC1"], ["INC2"]]);
  assert.equal(capped.total, 40);
  assert.equal(capped.truncated, true);

  const passed = toTableForm(records.slice(0, 1), { truncated: true });
  assert.equal(passed.truncated, true);
  assert.equal(toTableForm([], { maxRows: -1 }).rows.length, 0);
});
