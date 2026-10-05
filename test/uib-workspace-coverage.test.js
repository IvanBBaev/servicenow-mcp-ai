// N-30 — workspace coverage in servicenow_explain_ui_experience: declarative
// actions (model, position, conditions, what they run), the app shell and
// chrome page properties, the UX form view per table (layouts, action bar,
// related items, contextual side panel), m2m_app_theme themes, decoded
// sys_ux_list columns and conditions, and Agent Workspace vs Configurable
// Workspace with the migration list. Unreadable tables become caveats.
// Every read goes through withMetadataFetch.
import test from "node:test";
import assert from "node:assert/strict";

import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import { readEncodedQuery } from "../build/api/query-explain.js";
import {
  WORKSPACE_CATEGORY,
  classifyWorkspace,
  conditionText,
  decodeShell,
  formViews,
} from "../build/api/uib-workspace.js";
import { baselineEnv, jsonResponse, withMetadataFetch } from "./helpers.js";

baselineEnv();

const id = (c) => c.repeat(32);
const EXP = id("a");
const CFG = id("b");
const ROOT_MP = id("c");
const SCOPE = id("9");
const LMENU = id("7");
const LIST_MODEL = id("1");
const FORM_MODEL = id("2");
const PAYLOAD = id("3");
const THEME = id("4");
const AW = id("5");
const COMPONENT = id("6");
const ACTION_DEF = id("8");

function fixture() {
  return {
    sys_ux_page_registry: [
      {
        sys_id: EXP,
        title: "Acme Workspace",
        path: "now/acme",
        root_macroponent: ROOT_MP,
        admin_panel: CFG,
        sys_scope: SCOPE,
        active: "true",
      },
    ],
    sys_ux_page_property: [
      {
        sys_id: "pp1",
        page: EXP,
        name: "chrome_toolbar",
        type: "json",
        value: JSON.stringify([
          {
            id: "lists",
            label: { translatable: true, message: "Lists" },
            icon: "list-outline",
            routeInfo: { route: "list" },
            group: "top",
            order: 200,
          },
          {
            id: "home",
            label: "Home",
            icon: "home-outline",
            routeInfo: { route: "home" },
            group: "top",
            order: 100,
          },
        ]),
      },
      {
        sys_id: "pp2",
        page: EXP,
        name: "chrome_header",
        type: "json",
        value: JSON.stringify({
          privatePage: {
            userPrefsEnabled: true,
            searchEnabled: false,
            globalTools: {
              primaryItems: [{ id: "help", label: "Help" }],
              secondaryItems: [],
            },
          },
          publicPage: { menuEnabled: false },
        }),
      },
      {
        sys_id: "pp3",
        page: EXP,
        name: "chrome_tab",
        type: "json",
        value: JSON.stringify({
          contextual: ["record"],
          newTabMenu: [
            { routeInfo: { fields: { table: "incident" } } },
            { routeInfo: { fields: { table: "problem" } } },
          ],
          maxMainTabLimit: 10,
          maxTotalSubTabLimit: 30,
        }),
      },
      {
        sys_id: "pp4",
        page: EXP,
        name: "listConfigId",
        type: "string",
        value: LMENU,
      },
    ],
    sys_ux_app_config: [{ sys_id: CFG, name: "Acme config" }],
    sys_ux_app_route: [
      {
        sys_id: "rt1",
        name: "home",
        route_type: "home",
        screen_type: "",
        app_config: CFG,
        order: "1",
      },
    ],
    sys_ux_macroponent: [
      {
        sys_id: ROOT_MP,
        name: "Acme shell",
        category: "app_shell",
        composition: "[]",
        data: "",
        state_properties: "",
        internal_event_mappings: "",
      },
    ],
    sys_ux_list_menu_config: [
      { sys_id: LMENU, name: "Acme lists", active: "true" },
    ],
    sys_ux_list_category: [
      { sys_id: "cat1", configuration: LMENU, title: "Work", order: "1" },
    ],
    sys_ux_list: [
      {
        sys_id: "l1",
        category: "cat1",
        title: "Open P1",
        table: "incident",
        condition: "active=true^priority=1^ORstate=2^ORDERBYDESCnumber",
        columns: "number, short_description,priority",
        order: "1",
      },
      {
        sys_id: "l2",
        category: "cat1",
        title: "Changes",
        table: "change_request",
        condition: "",
        columns: "",
        order: "2",
      },
    ],
    sys_ux_form_action_layout: [
      {
        sys_id: "fal1",
        name: "Incident layout",
        table: "incident",
        sys_scope: SCOPE,
      },
    ],
    sys_declarative_action_assignment: [
      {
        sys_id: "da1",
        action_name: "bulk_close",
        label: "Close selected",
        table: "incident",
        active: "true",
        order: "100",
        model: LIST_MODEL,
        declarative_action_type: "uxf_client_action",
        client_action: PAYLOAD,
        record_selection_required: "true",
        required_roles: "itil, admin",
      },
      {
        sys_id: "da2",
        action_name: "resolve",
        label: "Resolve",
        table: "incident",
        active: "true",
        order: "200",
        model: FORM_MODEL,
        declarative_action_type: "server_script",
        action: ACTION_DEF,
        form_position: "action_bar",
        record_conditions: "state!=6^active=true",
      },
      {
        sys_id: "da3",
        action_name: "kb_panel",
        label: "Knowledge",
        table: "incident",
        order: "300",
        model: FORM_MODEL,
        declarative_action_type: "action_component",
        ui_component: COMPONENT,
        form_position: "contexual_sidebar",
      },
      {
        sys_id: "da4",
        action_name: "resolve",
        label: "Resolve (AW)",
        table: "incident",
        order: "400",
        model: FORM_MODEL,
        form_position: "action_bar",
        workspace: AW,
      },
      {
        sys_id: "da5",
        action_name: "related_tasks",
        label: "Tasks",
        table: "problem",
        order: "10",
        form_position: "related_item",
      },
      {
        sys_id: "da6",
        action_name: "elsewhere",
        label: "Not shown",
        table: "sys_user",
        order: "1",
      },
    ],
    sys_declarative_action_model_definition: [
      { sys_id: LIST_MODEL, name: "Record List" },
      { sys_id: FORM_MODEL, name: "Form" },
    ],
    sys_declarative_action_definition: [
      { sys_id: ACTION_DEF, label: "Resolve incident", action_name: "resolve" },
    ],
    sys_ux_lib_component: [
      { sys_id: COMPONENT, name: "KB panel", tag: "sn-kb-panel" },
    ],
    sys_declarative_action_payload_definition: [
      { sys_id: PAYLOAD, label: "Bulk close payload", key: "BULK_CLOSE" },
    ],
    m2m_app_theme: [
      { sys_id: "mt1", app: EXP, theme: THEME, order: "1" },
      { sys_id: "mt2", app: id("0"), theme: id("8"), order: "1" },
    ],
    sys_ux_theme: [{ sys_id: THEME, name: "Acme Polaris" }],
    sys_ux_registry_m2m_category: [
      {
        sys_id: "rc1",
        page_registry: EXP,
        experience_category: WORKSPACE_CATEGORY,
      },
    ],
    sys_aw_master_config: [
      { sys_id: AW, name: "Acme Agent Workspace", sys_scope: SCOPE },
    ],
    sys_aw_list: [
      { sys_id: "aw1", title: "AW incidents", table: "incident" },
      { sys_id: "aw2", title: "AW tasks", table: "sc_task" },
    ],
    sys_db_object: [],
  };
}

function matchTerm(row, term) {
  let m;
  if ((m = /^(\w+)IN(.*)$/.exec(term))) {
    return m[2].split(",").includes(String(row[m[1]] ?? ""));
  }
  if ((m = /^(\w+)=(.*)$/.exec(term))) {
    // sys_scope is implicit on every fixture row of a scoped read.
    if (m[1] === "sys_scope" && !(m[1] in row)) return true;
    return String(row[m[1]] ?? "") === m[2];
  }
  throw new Error(`unsupported term ${term}`);
}

/**
 * The fixture instance. `ignore` lists tables whose query is ignored (an
 * unknown field on a real instance can return every row).
 */
function instance(tables = fixture(), status = {}, ignore = []) {
  const reads = [];
  const handler = (url) => {
    const u = new URL(url);
    const m = u.pathname.match(/\/api\/now\/table\/([^/]+)$/);
    assert.ok(m, `unexpected request ${url}`);
    const table = m[1];
    reads.push({ table, query: u.searchParams.get("sysparm_query") ?? "" });
    if (status[table]) {
      return jsonResponse(status[table], {
        error: { message: `denied ${table}`, detail: "ACL" },
      });
    }
    const query = u.searchParams.get("sysparm_query") ?? "";
    const fields = u.searchParams.get("sysparm_fields")?.split(",");
    const body = query.split("^ORDERBY")[0];
    const orderBy = /\^ORDERBY(\w+)/.exec(query)?.[1];
    const rows = (tables[table] ?? [])
      .filter(
        (r) =>
          ignore.includes(table) ||
          !body ||
          body.split("^").every((t) => matchTerm(r, t)),
      )
      .sort((a, b) =>
        orderBy ? Number(a[orderBy] ?? 0) - Number(b[orderBy] ?? 0) : 0,
      )
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
  (s) => s.name === "servicenow_explain_ui_experience",
);
const payload = (result) => {
  assert.equal(result.isError, undefined, result.content[0].text);
  return JSON.parse(result.content[0].text);
};
const run = (args, mock = instance()) =>
  withMetadataFetch(mock.handler, () => runSpec(spec, args));

test("readEncodedQuery keeps values, OR, NQ blocks, ORDERBY and GROUPBY", () => {
  const r = readEncodedQuery(
    "active=true^priority=1^ORpriority=2^NQstate!=6^short_descriptionLIKEdisk^GROUPBYassignment_group^ORDERBYDESCnumber^javascript:gs.now()",
  );
  assert.deepEqual(
    r.terms.map((t) => [t.block, t.or, t.field, t.operator, t.value]),
    [
      [0, false, "active", "=", "true"],
      [0, false, "priority", "=", "1"],
      [0, true, "priority", "=", "2"],
      [1, false, "state", "!=", "6"],
      [1, false, "short_description", "LIKE", "disk"],
    ],
  );
  assert.deepEqual(r.orderBy, [{ field: "number", desc: true }]);
  assert.deepEqual(r.groupBy, ["assignment_group"]);
  assert.deepEqual(r.unparsed, ["javascript:gs.now()"]);
  assert.equal(
    conditionText(r.terms),
    "active = true AND priority = 1 OR priority = 2 | NQ | state != 6 AND short_description LIKE disk",
  );
  assert.deepEqual(readEncodedQuery(""), {
    terms: [],
    orderBy: [],
    groupBy: [],
    unparsed: [],
  });
  const dyn = readEncodedQuery(
    "assigned_toDYNAMIC90d1921e5f510100a9ad2572f2b477fe^stateIN1,2",
  );
  assert.deepEqual(
    dyn.terms.map((t) => [t.operator, t.value]),
    [
      ["DYNAMIC", "90d1921e5f510100a9ad2572f2b477fe"],
      ["IN", "1,2"],
    ],
  );
});

test("sys_ux_list columns and conditions are decoded", async () => {
  const res = payload(await run({ path: "now/acme" }));
  const [open, changes] = res.listMenus[0].categories[0].lists;
  assert.deepEqual(open.columns, ["number", "short_description", "priority"]);
  assert.deepEqual(
    open.conditionTerms.map((t) => [t.or, t.field, t.operator, t.value]),
    [
      [false, "active", "=", "true"],
      [false, "priority", "=", "1"],
      [true, "state", "=", "2"],
    ],
  );
  assert.equal(changes.columns, undefined);
  assert.equal(changes.conditionTerms, undefined);
});

test("the shell decodes the root macroponent and the chrome properties", async () => {
  const res = payload(await run({ path: "now/acme" }));
  assert.deepEqual(res.shell, {
    root_macroponent: ROOT_MP,
    name: "Acme shell",
    category: "app_shell",
    toolbar: [
      {
        id: "home",
        label: "Home",
        icon: "home-outline",
        route: "home",
        group: "top",
        order: 100,
      },
      {
        id: "lists",
        label: "Lists",
        icon: "list-outline",
        route: "list",
        group: "top",
        order: 200,
      },
    ],
    header: {
      searchEnabled: false,
      userPrefsEnabled: true,
      menuEnabled: false,
      globalTools: [{ id: "help", label: "Help" }],
    },
    tabs: {
      contextual: ["record"],
      newTabTables: ["incident", "problem"],
      maxMainTabLimit: 10,
      maxTotalSubTabLimit: 30,
    },
    footer: false,
    undecoded: [],
  });
});

test("declarative actions: model, position, conditions and what they run", async () => {
  const mock = instance();
  const res = payload(await run({ path: "now/acme" }, mock));
  // Tables come from the lists, the form action layout and the new-tab menu.
  const q = mock.reads.find(
    (r) => r.table === "sys_declarative_action_assignment",
  ).query;
  assert.deepEqual(q.split("^")[0].replace("tableIN", "").split(",").sort(), [
    "change_request",
    "incident",
    "problem",
  ]);
  assert.deepEqual(
    res.actions.map((a) => [a.table, a.sys_id, a.surface]),
    [
      ["incident", "da1", "list"],
      ["incident", "da2", "form"],
      ["incident", "da3", "form"],
      ["incident", "da4", "form"],
      ["problem", "da5", "form"],
    ],
  );
  const [bulk, resolve, kb, awOnly] = res.actions;
  assert.equal(bulk.model, "Record List");
  assert.equal(bulk.implementation, "uxf_client_action");
  assert.deepEqual(bulk.runs, [
    {
      field: "client_action",
      table: "sys_declarative_action_payload_definition",
      sys_id: PAYLOAD,
      name: "Bulk close payload",
    },
  ]);
  assert.deepEqual(bulk.required_roles, ["itil", "admin"]);
  assert.equal(bulk.record_selection_required, "true");
  assert.deepEqual(
    resolve.conditionTerms.map((t) => [t.field, t.operator, t.value]),
    [
      ["state", "!=", "6"],
      ["active", "=", "true"],
    ],
  );
  // N-30: the action definition and the UI component are named too.
  assert.deepEqual(resolve.runs, [
    {
      field: "action",
      table: "sys_declarative_action_definition",
      sys_id: ACTION_DEF,
      name: "Resolve incident",
    },
  ]);
  assert.deepEqual(kb.runs, [
    {
      field: "ui_component",
      table: "sys_ux_lib_component",
      sys_id: COMPONENT,
      name: "KB panel",
    },
  ]);
  assert.equal(awOnly.agentWorkspace, AW);
  assert.equal(res.counts.actions, 5);
  // One read per run-target table, by sys_id, only for referenced ids.
  const nameReads = mock.reads.filter((r) =>
    [
      "sys_ux_lib_component",
      "sys_declarative_action_definition",
      "sys_declarative_action_payload_definition",
    ].includes(r.table),
  );
  assert.deepEqual(nameReads.map((r) => r.query).sort(), [
    `sys_idIN${PAYLOAD}`,
    `sys_idIN${COMPONENT}`,
    `sys_idIN${ACTION_DEF}`,
  ]);
});

test("an ignored action filter is filtered again on the client", async () => {
  const res = payload(
    await run(
      { path: "now/acme" },
      instance(fixture(), {}, [
        "sys_declarative_action_assignment",
        "m2m_app_theme",
      ]),
    ),
  );
  assert.ok(!res.actions.some((a) => a.table === "sys_user"));
  assert.deepEqual(
    res.themes.map((t) => t.sys_id),
    [THEME],
  );
});

test("form views group layouts, action bar, related items and side panel", async () => {
  const res = payload(await run({ path: "now/acme" }));
  assert.deepEqual(res.forms, [
    {
      table: "incident",
      formActionLayouts: ["Incident layout"],
      actionBar: ["Resolve", "Resolve (AW)"],
      relatedItems: [],
      sidePanel: ["Knowledge"],
    },
    {
      table: "problem",
      formActionLayouts: [],
      actionBar: [],
      relatedItems: ["Tasks"],
      sidePanel: [],
    },
  ]);
  assert.deepEqual(
    formViews([{ sys_id: "x", table: "t", form_position: "elsewhere" }], []),
    [],
  );
});

test("themes come from m2m_app_theme", async () => {
  const res = payload(await run({ path: "now/acme" }));
  assert.deepEqual(res.themes, [
    { sys_id: THEME, name: "Acme Polaris", link: "mt1", order: 1 },
  ]);
  assert.equal(res.counts.themes, 1);
});

test("Agent vs Configurable Workspace: signals and the migration list", async () => {
  const res = payload(await run({ path: "now/acme" }));
  assert.equal(res.workspace.kind, "mixed");
  assert.deepEqual(
    res.workspace.signals.map((s) => s.kind),
    ["configurable", "configurable", "configurable", "agent", "agent"],
  );
  assert.deepEqual(res.workspace.migration, [
    {
      table: "sys_aw_master_config",
      sys_id: AW,
      name: "Acme Agent Workspace",
      counterpart: "Acme Workspace",
    },
    {
      table: "sys_aw_list",
      sys_id: "aw1",
      name: "AW incidents",
      counterpart: "sys_ux_list on incident",
    },
    { table: "sys_aw_list", sys_id: "aw2", name: "AW tasks" },
    {
      table: "sys_declarative_action_assignment",
      sys_id: "da4",
      name: "Resolve (AW)",
      counterpart: "unrestricted resolve on incident",
    },
  ]);
  assert.ok(res.caveats.some((c) => /Workspace coverage \(N-30\)/.test(c)));

  // Pure classification.
  const base = {
    categories: [],
    propertyNames: [],
    routes: 0,
    actions: [],
    awConfigs: [],
    awLists: [],
    uxListTables: [],
  };
  assert.equal(classifyWorkspace(base).kind, "unknown");
  assert.equal(
    classifyWorkspace({ ...base, path: "now/workspace/agent" }).kind,
    "agent",
  );
  const cw = classifyWorkspace({
    ...base,
    categories: [WORKSPACE_CATEGORY],
    routes: 3,
  });
  assert.equal(cw.kind, "configurable");
  assert.deepEqual(cw.migration, []);
  // Routes alone (any UI Builder app) do not make a workspace.
  assert.equal(classifyWorkspace({ ...base, routes: 3 }).kind, "unknown");
});

test("unreadable workspace tables become caveats; the rest is still read", async () => {
  const mock = instance(fixture(), {
    sys_declarative_action_assignment: 403,
    m2m_app_theme: 404,
    sys_aw_master_config: 404,
  });
  const res = payload(await run({ path: "now/acme" }, mock));
  assert.deepEqual(
    res.unreadable.map((u) => [u.table, u.status]),
    [
      ["sys_declarative_action_assignment", 403],
      ["m2m_app_theme", 404],
      ["sys_aw_master_config", 404],
    ],
  );
  assert.ok(
    res.caveats.some((c) =>
      /^sys_declarative_action_assignment could not be read \(403\)/.test(c),
    ),
  );
  assert.deepEqual(res.actions, []);
  assert.deepEqual(res.themes, []);
  assert.equal(res.shell.toolbar.length, 2);
  assert.deepEqual(
    res.forms.map((f) => f.table),
    ["incident"],
  );
  assert.equal(res.workspace.kind, "configurable");
  assert.deepEqual(
    res.workspace.migration.map((m) => m.sys_id),
    ["aw1", "aw2"],
  );
  assert.ok(
    !mock.reads.some(
      (r) => r.table === "sys_declarative_action_model_definition",
    ),
  );
});

test("unknown chrome shapes are reported, not thrown", () => {
  const shell = decodeShell([
    { name: "chrome_toolbar", value: '"not json"' },
    { name: "chrome_header", value: { other: true } },
    { name: "chrome_tab", value: 42 },
    { name: "chrome_footer", value: { public_page: {} } },
  ]);
  assert.deepEqual(shell, {
    toolbar: [],
    footer: true,
    undecoded: ["chrome_toolbar", "chrome_header", "chrome_tab"],
  });
  assert.equal(decodeShell([{ name: "landing", value: "x" }]), null);
});

test("markdown renders the workspace section", async () => {
  const res = payload(await run({ path: "now/acme", format: "markdown" }));
  const md = res.markdown;
  assert.match(
    md,
    /5 declarative action\(s\), 1 theme\(s\)\. verified:false\./,
  );
  assert.match(
    md,
    / {6}- columns number, short_description, priority · condition active = true AND priority = 1 OR state = 2/,
  );
  assert.match(md, /## Workspace\n\nKind: \*\*mixed\*\*/);
  assert.match(md, /- Toolbar: Home → home, Lists → list/);
  assert.match(
    md,
    /- Header: searchEnabled false · userPrefsEnabled true · menuEnabled false · global tools Help/,
  );
  assert.match(
    md,
    /- Tabs: contextual record · new-tab tables incident, problem/,
  );
  assert.match(md, /Themes: Acme Polaris/);
  assert.match(
    md,
    /- \*\*incident\*\*: layouts Incident layout · action bar Resolve, Resolve \(AW\) · side panel Knowledge/,
  );
  assert.match(
    md,
    /- incident · list: \*\*Close selected\*\* · uxf_client_action → Bulk close payload · roles itil, admin/,
  );
  assert.match(
    md,
    /- incident · form \(action_bar\): \*\*Resolve\*\* · server_script → Resolve incident · when state != 6 AND active = true/,
  );
  assert.match(md, /Agent Workspace only/);
  assert.match(
    md,
    /- sys_aw_list: AW tasks → _no Configurable Workspace counterpart_/,
  );
});
