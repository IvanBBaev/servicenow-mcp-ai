// N-30 (O-5) — action exclusions: sys_workspace_declarative_action_exclusion
// hides a declarative action assignment (usually one on `global`, such as
// "New" or "Edit") on a table, optionally on its child tables and in one
// view. Table, fields and the action_assignment reference were checked on a
// PDI (475 rows). explain_ui_experience reads the exclusions on the
// workspace's tables and those reaching them from a parent table.
import test from "node:test";
import assert from "node:assert/strict";

import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import {
  readActionExclusions,
  workspaceLines,
} from "../build/api/uib-workspace.js";
import { clearSchemaCache } from "../build/core/cache.js";
import { baselineEnv, jsonResponse, withMetadataFetch } from "./helpers.js";

baselineEnv();

const id = (c) => c.repeat(32);
const EXP = id("a");
const NEW = id("1");
const EDIT = id("2");

const TABLES = {
  sys_ux_page_registry: [
    { sys_id: EXP, title: "Acme Workspace", path: "now/acme", active: "true" },
  ],
  sys_ux_page_property: [
    {
      sys_id: "pp1",
      page: EXP,
      name: "chrome_tab",
      type: "json",
      value: JSON.stringify({
        newTabMenu: [{ routeInfo: { fields: { table: "incident" } } }],
      }),
    },
  ],
  sys_workspace_declarative_action_exclusion: [
    {
      sys_id: "x1",
      table: "incident",
      action_assignment: NEW,
      "action_assignment.action_name": "create-new-uxf",
      "action_assignment.label": "New",
      "action_assignment.table": "global",
      exclude_self: "true",
      exclude_all_child_tables: "false",
      "view.name": "",
    },
    {
      sys_id: "x2",
      table: "incident",
      action_assignment: EDIT,
      "action_assignment.action_name": "edit_({{count}})",
      exclude_self: "false",
      exclude_all_child_tables: "true",
      "view.name": "sow",
    },
    {
      sys_id: "x3",
      table: "problem",
      action_assignment: NEW,
      exclude_self: "true",
    },
    { sys_id: "x4", table: "incident", action_assignment: "" },
  ],
};

/** A fake WorkspaceIo that ignores the filter (as an unknown field would). */
const io = (tables = TABLES, reads = []) => ({
  read: async (table) => {
    reads.push(table);
    return tables[table] ?? [];
  },
  readIn: async (table) => {
    reads.push(table);
    return tables[table] ?? [];
  },
});

test("exclusions on the wanted tables, other tables' rows dropped", async () => {
  const out = await readActionExclusions(io(), ["incident"]);
  assert.deepEqual(out, [
    {
      sys_id: "x2",
      table: "incident",
      action_assignment: EDIT,
      action_name: "edit_({{count}})",
      exclude_self: false,
      exclude_all_child_tables: true,
      view: "sow",
    },
    {
      sys_id: "x1",
      table: "incident",
      action_assignment: NEW,
      action_name: "create-new-uxf",
      label: "New",
      assignmentTable: "global",
      exclude_self: true,
      exclude_all_child_tables: false,
    },
  ]);
});

test("no safe table reads nothing", async () => {
  const reads = [];
  assert.deepEqual(
    await readActionExclusions(io(TABLES, reads), ["", "bad table"]),
    [],
  );
  assert.deepEqual(reads, []);
});

/** task ← incident ← incident_ext; problem extends task too. */
const PARENTS = { incident: "task", incident_ext: "incident", problem: "task" };
const chainOf = async (t) => {
  const out = [t];
  while (PARENTS[out.at(-1)]) out.push(PARENTS[out.at(-1)]);
  return out;
};
const TASK_ROWS = [
  {
    sys_id: "t1",
    table: "task",
    action_assignment: EDIT,
    "action_assignment.label": "Edit",
    exclude_self: "true",
    exclude_all_child_tables: "true",
  },
  {
    sys_id: "t2",
    table: "task",
    action_assignment: NEW,
    exclude_self: "true",
    exclude_all_child_tables: "false",
  },
];

test("exclusions on a parent with exclude_all_child_tables are inherited", async () => {
  const reads = [];
  const tables = {
    sys_workspace_declarative_action_exclusion: [
      ...TABLES.sys_workspace_declarative_action_exclusion,
      ...TASK_ROWS,
    ],
  };
  const out = await readActionExclusions(
    io(tables, reads),
    ["incident", "incident_ext"],
    chainOf,
  );
  assert.deepEqual(reads, ["sys_workspace_declarative_action_exclusion"]);
  assert.deepEqual(
    out.map((x) => [x.table, x.inheritedFrom ?? "", x.sys_id]),
    [
      ["incident", "", "x2"],
      ["incident", "", "x1"],
      ["incident", "task", "t1"],
      ["incident_ext", "incident", "x2"],
      ["incident_ext", "task", "t1"],
    ],
  );
});

test("an exclusion on a workspace table that is also a parent keeps both roles", async () => {
  const out = await readActionExclusions(
    io(),
    ["incident_ext", "incident"],
    chainOf,
  );
  const x2 = out.filter((x) => x.sys_id === "x2");
  assert.deepEqual(
    x2.map((x) => [x.table, x.inheritedFrom]),
    [
      ["incident", undefined],
      ["incident_ext", "incident"],
    ],
  );
});

test("markdown lists the action exclusions", () => {
  const out = [];
  workspaceLines(
    {
      shell: null,
      actions: [],
      forms: [],
      themes: [],
      workspace: { kind: "unknown", signals: [], migration: [] },
      actionExclusions: [
        {
          sys_id: "x1",
          table: "incident",
          action_assignment: NEW,
          label: "New",
          assignmentTable: "global",
          exclude_self: true,
          exclude_all_child_tables: true,
          view: "sow",
        },
        {
          sys_id: "t1",
          table: "incident",
          inheritedFrom: "task",
          action_assignment: EDIT,
          label: "Edit",
          exclude_self: true,
          exclude_all_child_tables: true,
        },
        {
          sys_id: "x2",
          table: "problem",
          action_assignment: EDIT,
          exclude_self: false,
          exclude_all_child_tables: false,
        },
      ],
    },
    out,
  );
  const md = out.join("\n");
  assert.match(md, /### Action exclusions/);
  assert.match(
    md,
    /- incident: \*\*New\*\* \(from global\) hidden on this table and child tables · view sow/,
  );
  assert.match(
    md,
    /- incident: \*\*Edit\*\* hidden on this table and child tables of task$/m,
  );
  assert.match(
    md,
    new RegExp(`- problem: \\*\\*${EDIT}\\*\\* hidden on nothing`),
  );
});

const spec = ALL_TOOLS.find(
  (s) => s.name === "servicenow_explain_ui_experience",
);
const handlerFor = (tables) => (url) => {
  const m = /\/api\/now\/table\/([^/?]+)/.exec(new URL(url).pathname);
  return jsonResponse(200, { result: (m && tables[m[1]]) ?? [] });
};

test("explain_ui_experience returns actionExclusions for the workspace tables", async () => {
  const res = await withMetadataFetch(handlerFor(TABLES), () =>
    runSpec(spec, { path: "now/acme" }),
  );
  assert.equal(res.isError, undefined, res.content[0].text);
  const out = JSON.parse(res.content[0].text);
  assert.deepEqual(
    out.actionExclusions.map((x) => x.sys_id),
    ["x2", "x1"],
  );
});

test("an experience without exclusions has no actionExclusions key", async () => {
  const tables = { ...TABLES, sys_workspace_declarative_action_exclusion: [] };
  const res = await withMetadataFetch(handlerFor(tables), () =>
    runSpec(spec, { path: "now/acme" }),
  );
  assert.ok(!("actionExclusions" in JSON.parse(res.content[0].text)));
});

test("an unreadable exclusion table degrades to a caveat", async () => {
  const res = await withMetadataFetch(
    (url) => {
      const m = /\/api\/now\/table\/([^/?]+)/.exec(new URL(url).pathname);
      if (m?.[1] === "sys_workspace_declarative_action_exclusion")
        return jsonResponse(403, { error: { message: "denied" } });
      return handlerFor(TABLES)(url);
    },
    () => runSpec(spec, { path: "now/acme" }),
  );
  assert.equal(res.isError, undefined, res.content[0].text);
  const out = JSON.parse(res.content[0].text);
  assert.ok(!("actionExclusions" in out));
  assert.ok(
    JSON.stringify(out).includes("sys_workspace_declarative_action_exclusion"),
  );
});

test("explain_ui_experience walks sys_db_object for inherited exclusions", async () => {
  clearSchemaCache();
  const tables = {
    ...TABLES,
    sys_workspace_declarative_action_exclusion: TASK_ROWS,
  };
  const res = await withMetadataFetch(
    (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/sys_db_object")) {
        const name = /name=([^^]+)/.exec(
          u.searchParams.get("sysparm_query"),
        )?.[1];
        const parent = PARENTS[name];
        return jsonResponse(200, {
          result: parent ? [{ name, "super_class.name": parent }] : [],
        });
      }
      return handlerFor(tables)(url);
    },
    () => runSpec(spec, { path: "now/acme" }),
  );
  const out = JSON.parse(res.content[0].text);
  assert.deepEqual(
    out.actionExclusions.map((x) => [x.table, x.inheritedFrom, x.sys_id]),
    [["incident", "task", "t1"]],
  );
});

test("an unreadable sys_db_object degrades to a caveat", async () => {
  clearSchemaCache();
  const res = await withMetadataFetch(
    (url) => {
      if (new URL(url).pathname.endsWith("/sys_db_object"))
        return jsonResponse(403, { error: { message: "denied" } });
      return handlerFor(TABLES)(url);
    },
    () => runSpec(spec, { path: "now/acme" }),
  );
  assert.equal(res.isError, undefined, res.content[0].text);
  const out = JSON.parse(res.content[0].text);
  assert.deepEqual(
    out.actionExclusions.map((x) => x.sys_id),
    ["x2", "x1"],
  );
  assert.ok(out.caveats.some((c) => c.includes("sys_db_object")));
});
