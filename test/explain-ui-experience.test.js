// P-14 / P-15 — servicenow_explain_ui_experience: a fixture workspace walked
// from sys_ux_page_registry through app config, routes, screen variants
// (order + applicability), macroponents (component tree, data resources,
// client state, event wiring, client scripts), data brokers and their
// ux_data_broker ACLs, plus dashboards, list menus and form action layouts.
// Also the uib-composition decoder and its tolerant readers (pinned with
// fixtures), unreadable / policy-denied tables as caveats, the Mermaid
// golden, markdown / file formats, progress and cancellation. Every read goes
// through withMetadataFetch. Regenerate the golden deliberately with
// `UPDATE_GOLDEN=1 npm test`.
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

import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS, PACKAGES } from "../build/mcp/registry.js";
import {
  decodeField,
  getDecoder,
  uibCompositionDecoder,
} from "../build/core/artifacts/decoders.js";
import {
  COMPOSITION_MAX_DEPTH,
  COMPOSITION_MAX_ELEMENTS,
  compositionTree,
  dataResources,
  eventWiring,
  stateProperties,
} from "../build/core/artifacts/uib-composition.js";
import { lintMermaid } from "./mermaid-lint.js";
import {
  baselineEnv,
  jsonResponse,
  withEnv,
  withMetadataFetch,
} from "./helpers.js";

baselineEnv();

const FIXTURES = path.join(import.meta.dirname, "fixtures", "explain");

const id = (c) => c.repeat(32);
const EXP = id("a");
const CFG = id("b");
const ROOT_MP = id("c");
const HOME_MP = id("d");
const AGENT_MP = id("e");
const ST_HOME = id("f");
const ST_REC = id("1");
const APP_AGENT = id("2");
const BROKER_T = id("3");
const BROKER_S = id("4");
const BROKER_X = id("5");
const DASH = id("6");
const LMENU = id("7");
const APP_LIST = id("8");
const SCOPE = id("9");
const FAL = "ab".repeat(16);
const FA1 = "cd".repeat(16);

const COMPOSITION = [
  {
    elementId: "header",
    elementLabel: "Header",
    definition: { id: "sn-polaris-header", type: "COMPONENT" },
    slots: [
      {
        slotName: "actions",
        children: [
          {
            elementId: "button_1",
            definition: { id: "now-button", type: "COMPONENT" },
            isHidden: true,
          },
        ],
      },
    ],
  },
  {
    elementId: "list_1",
    label: "Open incidents",
    definition: { id: "now-record-list", type: "COMPONENT" },
    slots: {
      footer: [{ elementId: "pager", definition: { id: "now-pagination" } }],
    },
  },
];

/** The fixture instance: table name → rows. */
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
        name: "chrome_header",
        type: "json",
        value: '{"title":"Acme"}',
      },
      {
        sys_id: "pp2",
        page: EXP,
        name: "listConfigId",
        type: "string",
        value: LMENU,
      },
      {
        sys_id: "pp3",
        page: EXP,
        name: "landing",
        type: "json",
        value: JSON.stringify({ dashboard: DASH }),
      },
    ],
    sys_ux_app_config: [
      { sys_id: CFG, name: "Acme config", landing_path: "home" },
    ],
    sys_ux_app_route: [
      {
        sys_id: "rt2",
        name: "record",
        route_type: "record",
        screen_type: ST_REC,
        parent_macroponent: "",
        app_config: CFG,
        order: "200",
      },
      {
        sys_id: "rt1",
        name: "home",
        route_type: "home",
        screen_type: ST_HOME,
        parent_macroponent: "",
        app_config: CFG,
        order: "100",
      },
    ],
    sys_ux_screen: [
      {
        sys_id: "sc2",
        name: "Home (agent)",
        screen_type: ST_HOME,
        macroponent: AGENT_MP,
        applicability: APP_AGENT,
        order: "200",
        active: "true",
      },
      {
        sys_id: "sc1",
        name: "Home (default)",
        screen_type: ST_HOME,
        macroponent: HOME_MP,
        applicability: "",
        order: "100",
        active: "true",
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
      {
        sys_id: HOME_MP,
        name: "Acme home",
        category: "page",
        composition: JSON.stringify(COMPOSITION),
        data: JSON.stringify([
          {
            elementId: "incidents",
            elementLabel: "Incidents",
            definition: { id: BROKER_T, type: "TRANSFORM" },
          },
          {
            elementId: "counter",
            definition: { id: BROKER_S, type: "SCRIPTLET" },
          },
          {
            elementId: "graph",
            definition: { id: BROKER_X, type: "GRAPHQL" },
          },
        ]),
        state_properties: JSON.stringify([
          { name: "selectedTab", valueType: "string", initialValue: "open" },
          { name: "count", valueType: "number" },
        ]),
        internal_event_mappings: JSON.stringify({
          "list_1.NOW_RECORD_LIST#ROW_CLICKED": [
            { definition: { id: "open_record" } },
            { operationName: "SET_STATE" },
          ],
          button_1: { NOW_BUTTON_CLICKED: [{ type: "REFRESH" }] },
        }),
      },
      {
        sys_id: AGENT_MP,
        name: "Agent home",
        category: "page",
        composition: '{"not":"a composition"}',
        data: "{bad json",
        state_properties: "42",
        internal_event_mappings: '"just text"',
      },
    ],
    sys_ux_client_script: [
      { sys_id: "cs1", name: "onLoad", type: "default", macroponent: HOME_MP },
    ],
    sys_ux_data_broker_transform: [
      {
        sys_id: BROKER_T,
        name: "Incident list",
        mutates_server_data: "false",
        properties: '[{"name":"table","type":"string"}]',
        script: "function transform(input) { return []; }",
      },
    ],
    sys_ux_data_broker_scriptlet: [
      {
        sys_id: BROKER_S,
        name: "Counter",
        properties: '[{"name":"count","type":"number"}]',
      },
    ],
    sys_security_acl: [
      {
        sys_id: "acl1",
        name: BROKER_T,
        type: "ux_data_broker",
        operation: "execute",
        active: "true",
      },
      {
        sys_id: "acl2",
        name: BROKER_S,
        type: "record",
        operation: "read",
        active: "true",
      },
    ],
    par_dashboard: [{ sys_id: DASH, name: "Acme overview", active: "true" }],
    par_dashboard_tab: [
      { sys_id: "tb2", dashboard: DASH, name: "Trends", order: "200" },
      { sys_id: "tb1", dashboard: DASH, name: "Today", order: "100" },
    ],
    par_dashboard_widget: [
      { sys_id: "w1", tab: "tb1", name: "Open P1", component: "sn-score" },
      { sys_id: "w2", tab: "tb1", name: "", component: "sn-bar" },
    ],
    sys_ux_list_menu_config: [
      { sys_id: LMENU, name: "Acme lists", active: "true" },
    ],
    sys_ux_list_category: [
      { sys_id: "cat1", configuration: LMENU, title: "Incidents", order: "1" },
    ],
    sys_ux_list: [
      {
        sys_id: "l2",
        category: "cat1",
        title: "All",
        table: "incident",
        condition: "",
        columns: "number,short_description",
        order: "2",
      },
      {
        sys_id: "l1",
        category: "cat1",
        title: "Mine",
        table: "incident",
        condition: "assigned_toDYNAMIC90d1921e5f510100a9ad2572f2b477fe",
        columns: "number, priority,state",
        order: "1",
      },
    ],
    sys_ux_applicability_m2m_list: [
      { sys_id: "m1", list: "l1", applicability: APP_LIST },
    ],
    sys_ux_applicability: [
      {
        sys_id: APP_AGENT,
        name: "Agents",
        roles: "itil, agent",
        active: "true",
      },
      { sys_id: APP_LIST, name: "Everyone", roles: "", active: "true" },
    ],
    sys_ux_form_action_layout: [
      {
        sys_id: FAL,
        name: "Incident actions",
        table: "incident",
        sys_scope: SCOPE,
      },
      { sys_id: "other", name: "Elsewhere", sys_scope: "x" },
    ],
    sys_ux_form_action_layout_item: [
      { sys_id: "it1", form_action_layout: FAL, form_action: FA1, order: "10" },
    ],
    sys_ux_form_action: [
      {
        sys_id: FA1,
        label: "Resolve",
        action: "sa1",
        applicability: APP_AGENT,
      },
    ],
    sys_db_object: [],
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

function matches(row, query) {
  const body = query.split("^ORDERBY")[0];
  if (!body) return true;
  return body.split("^").every((t) => matchTerm(row, t));
}

function instance(tables = fixture(), status = {}) {
  const reads = [];
  const handler = (url) => {
    const u = new URL(url);
    const m = u.pathname.match(/\/api\/now\/table\/([^/]+)$/);
    assert.ok(m, `unexpected request ${url}`);
    const table = m[1];
    reads.push(table);
    if (status[table]) {
      return jsonResponse(status[table], {
        error: { message: `denied ${table}`, detail: "ACL" },
      });
    }
    const query = u.searchParams.get("sysparm_query") ?? "";
    const fields = u.searchParams.get("sysparm_fields")?.split(",");
    const limit = Number(u.searchParams.get("sysparm_limit") ?? 1000);
    const orderBy = /\^ORDERBY(\w+)/.exec(query)?.[1];
    const rows = (tables[table] ?? [])
      .filter((r) => matches(r, query))
      .sort((a, b) => {
        if (!orderBy) return 0;
        const x = a[orderBy] ?? "";
        const y = b[orderBy] ?? "";
        const nx = Number(x);
        const ny = Number(y);
        if (
          x !== "" &&
          y !== "" &&
          Number.isFinite(nx) &&
          Number.isFinite(ny)
        ) {
          return nx - ny;
        }
        return String(x).localeCompare(String(y));
      })
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
  (s) => s.name === "servicenow_explain_ui_experience",
);
const payload = (result) => {
  assert.equal(result.isError, undefined, result.content[0].text);
  return JSON.parse(result.content[0].text);
};
async function run(args, mock = instance(), extra) {
  return withMetadataFetch(mock.handler, () => runSpec(spec, args, extra));
}

test("explain_ui_experience lives in the opt-in ui package", () => {
  assert.ok(spec, "tool registered");
  assert.equal(spec.package, "ui");
  assert.equal(spec.annotations.readOnlyHint, true);
  assert.ok(spec.output?.verified, "declares an output schema");
  const ui = PACKAGES.find((p) => p.name === "ui");
  assert.ok(ui.tools.some((t) => t.name === spec.name));
});

test("the fixture workspace walks routes → screen variants → macroponents", async () => {
  const res = payload(await run({ path: "now/acme" }));
  assert.equal(res.verified, false);
  assert.equal(res.experience.title, "Acme Workspace");
  assert.deepEqual(res.appConfig, {
    sys_id: CFG,
    name: "Acme config",
    landing_path: "home",
  });
  assert.deepEqual(
    res.routes.map((r) => [r.name, r.screens.map((s) => [s.name, s.order])]),
    [
      [
        "home",
        [
          ["Home (default)", 100],
          ["Home (agent)", 200],
        ],
      ],
      ["record", []],
    ],
  );
  assert.equal(res.routes[0].screens[1].applicability, APP_AGENT);
  assert.deepEqual(
    res.macroponents.map((m) => m.name),
    ["Acme shell", "Acme home", "Agent home"],
  );
  assert.deepEqual(res.counts, {
    routes: 2,
    screens: 2,
    macroponents: 3,
    elements: 4,
    dataResources: 3,
    clientScripts: 1,
    dataBrokers: 2,
    acls: 1,
    applicabilities: 2,
    dashboards: 1,
    listMenus: 1,
    lists: 2,
    formActionLayouts: 1,
    actions: 0,
    themes: 0,
  });
  assert.equal(res.missingFields, undefined);
  // By sys_id too.
  const byId = payload(await run({ sys_id: EXP }));
  assert.equal(byId.experience.path, "now/acme");
});

test("macroponent JSON: component tree, data, state and event wiring", async () => {
  const res = payload(await run({ path: "now/acme" }));
  const home = res.macroponents.find((m) => m.sys_id === HOME_MP);
  assert.equal(home.composition.decoded, true);
  assert.deepEqual(home.composition.value, {
    elements: [
      {
        elementId: "header",
        component: "sn-polaris-header",
        type: "COMPONENT",
        label: "Header",
        slots: [
          {
            name: "actions",
            elements: [
              {
                elementId: "button_1",
                component: "now-button",
                type: "COMPONENT",
                hidden: true,
                slots: [],
              },
            ],
          },
        ],
      },
      {
        elementId: "list_1",
        component: "now-record-list",
        type: "COMPONENT",
        label: "Open incidents",
        slots: [
          {
            name: "footer",
            elements: [
              { elementId: "pager", component: "now-pagination", slots: [] },
            ],
          },
        ],
      },
    ],
    count: 4,
    omitted: 0,
    skipped: 0,
  });
  assert.deepEqual(
    home.data.value.map((d) => [d.elementId, d.broker, d.type]),
    [
      ["incidents", BROKER_T, "TRANSFORM"],
      ["counter", BROKER_S, "SCRIPTLET"],
      ["graph", BROKER_X, "GRAPHQL"],
    ],
  );
  assert.deepEqual(home.state.value, [
    { name: "selectedTab", type: "string", initial: true },
    { name: "count", type: "number" },
  ]);
  assert.deepEqual(home.events.value, [
    {
      source: "list_1.NOW_RECORD_LIST#ROW_CLICKED",
      handlers: ["open_record", "SET_STATE"],
    },
    { source: "button_1", event: "NOW_BUTTON_CLICKED", handlers: ["REFRESH"] },
  ]);
  assert.deepEqual(home.clientScripts, [
    { sys_id: "cs1", name: "onLoad", type: "default" },
  ]);
  // Unknown shapes come back raw with decoded:false — never a failure.
  const agent = res.macroponents.find((m) => m.sys_id === AGENT_MP);
  assert.equal(agent.composition.decoded, false);
  assert.match(agent.composition.reason, /Not a UI Builder composition/);
  assert.equal(agent.composition.raw, '{"not":"a composition"}');
  assert.equal(agent.data.decoded, false);
  assert.equal(agent.data.reason, "Not valid JSON.");
  assert.equal(agent.state.decoded, false);
  assert.match(agent.state.reason, /Unknown state_properties shape/);
  assert.equal(agent.events.decoded, false);
  // An empty column is an empty reading.
  const shell = res.macroponents.find((m) => m.sys_id === ROOT_MP);
  assert.deepEqual(shell.data, { decoded: true, value: [] });
  assert.equal(shell.composition.value.count, 0);
});

test("data brokers, their ux_data_broker ACLs and unresolved brokers", async () => {
  const res = payload(await run({ path: "now/acme" }));
  assert.deepEqual(res.dataBrokers, [
    {
      sys_id: BROKER_T,
      table: "sys_ux_data_broker_transform",
      name: "Incident list",
      mutates_server_data: "false",
      acls: [
        {
          sys_id: "acl1",
          name: BROKER_T,
          operation: "execute",
          active: "true",
        },
      ],
    },
    {
      sys_id: BROKER_S,
      table: "sys_ux_data_broker_scriptlet",
      name: "Counter",
      acls: [],
    },
  ]);
  assert.deepEqual(res.unresolvedBrokers, [BROKER_X]);
  assert.ok(res.caveats.some((c) => /1 data resource broker/.test(c)));
});

test("N-29: REST / GraphQL brokers resolve, broker hints flag the three rules", async () => {
  const clean = payload(await run({ path: "now/acme" }));
  // The default fixture trips no broker rule: no key, no caveat.
  assert.equal(clean.brokerHints, undefined);
  assert.ok(!clean.caveats.some((c) => /Broker hints/.test(c)));

  const tables = fixture();
  // A transform that queries without an access check, mutating, unguarded.
  tables.sys_ux_data_broker_transform[0].script =
    "function transform(input) {\n  var gr = new GlideRecord('incident');\n  gr.query();\n}";
  // The scriptlet declares no input.
  tables.sys_ux_data_broker_scriptlet[0].properties = "[]";
  // BROKER_X lives in the GraphQL table: it mutates and has no ACL.
  tables.sys_ux_data_broker_graphql = [
    {
      sys_id: BROKER_X,
      name: "Graph writer",
      mutates_server_data: "true",
      properties: '[{"name":"id"}]',
    },
  ];
  const mock = instance(tables);
  const res = payload(await run({ path: "now/acme" }, mock));
  assert.deepEqual(res.unresolvedBrokers, []);
  const graph = res.dataBrokers.find((b) => b.sys_id === BROKER_X);
  assert.equal(graph.table, "sys_ux_data_broker_graphql");
  assert.equal(graph.mutates_server_data, "true");
  assert.deepEqual(graph.acls, []);
  // The REST table is read for the still-unresolved id only.
  assert.ok(mock.reads.includes("sys_ux_data_broker_rest"));
  // The transform script is read for the lint but not echoed.
  assert.equal(res.dataBrokers[0].script, undefined);
  const hint = (id) => res.brokerHints.find((h) => h.broker === id);
  assert.deepEqual(
    hint(BROKER_T).findings.map((f) => [f.rule, f.severity, f.line]),
    [["uib-transform-gliderecord-no-acl-check", "warn", 2]],
  );
  assert.deepEqual(
    hint(BROKER_S).findings.map((f) => [f.rule, f.severity]),
    [["uib-broker-no-input-schema", "info"]],
  );
  assert.deepEqual(
    hint(BROKER_X).findings.map((f) => [f.rule, f.severity]),
    [["uib-broker-mutates-no-acl", "error"]],
  );
  assert.equal(hint(BROKER_X).name, "Graph writer");
  // Hints carry no rule hint text (it is in the markdown section).
  assert.equal(hint(BROKER_X).findings[0].hint, undefined);
  assert.ok(res.caveats.some((c) => /Broker hints \(N-29\)/.test(c)));

  const md = payload(
    await run({ path: "now/acme", format: "markdown" }, instance(tables)),
  ).markdown;
  assert.match(md, /## Broker hints/);
  assert.match(md, /`uib-broker-mutates-no-acl` \(error\): /);
  assert.match(
    md,
    /\*\*Graph writer\*\* \(sys_ux_data_broker_graphql\)\n {2}- error: /,
  );

  // ACLs unreadable: whether a broker is guarded is unknown, so the
  // mutates rule stays silent; the pure rules still report.
  const denied = payload(
    await run(
      { path: "now/acme" },
      instance(tables, { sys_security_acl: 403 }),
    ),
  );
  assert.equal(
    denied.brokerHints.some((h) =>
      h.findings.some((f) => f.rule === "uib-broker-mutates-no-acl"),
    ),
    false,
  );
  assert.ok(
    denied.brokerHints.some((h) =>
      h.findings.some(
        (f) => f.rule === "uib-transform-gliderecord-no-acl-check",
      ),
    ),
  );
});

test("P-15: properties, dashboards, lists, audiences and form actions", async () => {
  const res = payload(await run({ path: "now/acme" }));
  assert.deepEqual(
    res.properties.map((p) => [p.name, p.value]),
    [
      ["chrome_header", { title: "Acme" }],
      ["landing", { dashboard: DASH }],
      ["listConfigId", LMENU],
    ],
  );
  assert.deepEqual(res.dashboards, [
    {
      sys_id: DASH,
      name: "Acme overview",
      active: "true",
      tabs: [
        {
          sys_id: "tb1",
          name: "Today",
          order: 100,
          widgets: [
            { sys_id: "w1", name: "Open P1", component: "sn-score" },
            { sys_id: "w2", component: "sn-bar" },
          ],
        },
        { sys_id: "tb2", name: "Trends", order: 200, widgets: [] },
      ],
    },
  ]);
  const [menu] = res.listMenus;
  assert.equal(menu.name, "Acme lists");
  assert.deepEqual(
    menu.categories[0].lists.map((l) => [l.title, l.order, l.applicability]),
    [
      ["Mine", 1, [APP_LIST]],
      ["All", 2, []],
    ],
  );
  assert.deepEqual(
    res.applicabilities.map((a) => [a.name, a.roles]),
    [
      ["Agents", ["itil", "agent"]],
      ["Everyone", []],
    ],
  );
  assert.deepEqual(res.formActionLayouts, [
    {
      sys_id: FAL,
      name: "Incident actions",
      table: "incident",
      items: [
        {
          sys_id: "it1",
          order: 10,
          form_action: FA1,
          label: "Resolve",
          action: "sa1",
          applicability: APP_AGENT,
        },
      ],
    },
  ]);
  assert.ok(res.caveats.some((c) => /page properties/.test(c)));
});

test("the Mermaid page map matches its golden", async () => {
  const res = payload(await run({ path: "now/acme", format: "mermaid" }));
  lintMermaid(res.mermaid);
  assert.equal(res.mermaidTruncated, undefined);
  assert.equal(res.verified, false);
  assert.equal(res.sys_id, EXP);
  const file = path.join(FIXTURES, "ui-experience.mmd");
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, `${res.mermaid}\n`);
  } else {
    assert.equal(`${res.mermaid}\n`, readFileSync(file, "utf8"));
  }
  const capped = payload(
    await withEnv({ SN_DIAGRAM_MAX_NODES: "4" }, () =>
      run({ path: "now/acme", format: "mermaid" }),
    ),
  );
  assert.ok(capped.mermaidTruncated > 0);
  lintMermaid(capped.mermaid);
});

test("markdown renders the page map, trees, brokers and caveats", async () => {
  const res = payload(await run({ path: "now/acme", format: "markdown" }));
  const md = res.markdown;
  assert.match(md, /^# Experience Acme Workspace \(\/now\/acme\)/);
  assert.match(md, /App config: \*\*Acme config\*\* \(landing home\)/);
  assert.match(md, /- \*\*record\*\* \(record\) _\(no screen\)_/);
  assert.match(
    md,
    /Variant 200: Home \(agent\) → Agent home · audience Agents \[itil, agent\]/,
  );
  assert.match(
    md,
    /Variant 100: Home \(default\) → Acme home · no applicability/,
  );
  assert.match(md, /- Header `header` → sn-polaris-header \(COMPONENT\)/);
  assert.match(
    md,
    / {2}- slot actions\n {4}- `button_1` → now-button \(COMPONENT\) _\(hidden\)_/,
  );
  assert.match(md, /- `incidents` \(TRANSFORM\) → Incident list/);
  assert.match(md, /Client state: selectedTab \(string\), count \(number\)/);
  assert.match(md, /- button_1 · NOW_BUTTON_CLICKED → REFRESH/);
  assert.match(md, /Client scripts: onLoad \(default\)/);
  assert.match(md, /_composition did not decode: Not a UI Builder composition/);
  assert.match(md, /_data did not decode: Not valid JSON\._/);
  assert.match(md, /_state_properties did not decode/);
  assert.match(md, /_internal_event_mappings did not decode/);
  assert.match(
    md,
    /\*\*Counter\*\* \(sys_ux_data_broker_scriptlet\) · no ux_data_broker ACL/,
  );
  assert.match(md, /\*\*Incident list\*\* .* · ACLs: execute/);
  assert.match(md, /- 5{32} _\(not a transform/);
  assert.match(md, /Tab Today: 2 widget\(s\) \(Open P1, sn-bar\)/);
  assert.match(md, /- Mine \(incident\) · audience Everyone/);
  assert.match(md, /- 10: Resolve/);
  assert.match(md, /chrome_header = \{"title":"Acme"\}/);
  assert.match(md, /```mermaid\nflowchart TD/);
  assert.match(
    md,
    /## Caveats\n\n- UI Builder and Next Experience tables are verified:false/,
  );
  assert.deepEqual(Object.keys(res).sort(), [
    "caveats",
    "counts",
    "markdown",
    "sys_id",
    "verified",
  ]);
});

test("format:file writes the full JSON with the diagram", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sn-p14-"));
  try {
    const res = await withEnv({ SN_DOCS_DIR: dir }, () =>
      run({ path: "now/acme", format: "file" }),
    );
    const out = payload(res);
    assert.equal(out.format, "file");
    assert.equal(out.verified, false);
    assert.equal(out.routes_count, 2);
    const written = JSON.parse(readFileSync(out.file, "utf8"));
    assert.equal(written.experience.path, "now/acme");
    assert.match(written.mermaid, /^flowchart TD/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unreadable and policy-denied tables become caveats", async () => {
  const mock = instance(fixture(), {
    sys_ux_list_category: 403,
    sys_security_acl: 404,
  });
  const res = await withEnv({ SN_TABLES_DENY: "par_dashboard" }, () =>
    run({ path: "now/acme" }, mock),
  );
  const out = payload(res);
  assert.deepEqual(
    out.unreadable.map((u) => [u.table, u.status]),
    [
      ["sys_security_acl", 404],
      ["par_dashboard", 403],
      ["sys_ux_list_category", 403],
    ],
  );
  assert.ok(
    out.caveats.some((c) =>
      /^sys_ux_list_category could not be read \(403\)/.test(c),
    ),
  );
  assert.equal(mock.reads.includes("par_dashboard"), false);
  assert.deepEqual(out.dashboards, []);
  assert.deepEqual(out.listMenus[0].categories, []);
  assert.deepEqual(
    out.dataBrokers.map((b) => b.acls.length),
    [0, 0],
  );
  // The rest of the page map is still read.
  assert.equal(out.counts.screens, 2);
  assert.equal(out.counts.formActionLayouts, 1);
  // A screen read failure leaves routes without variants.
  const noScreens = payload(
    await run(
      { path: "now/acme" },
      instance(fixture(), { sys_ux_screen: 403 }),
    ),
  );
  assert.deepEqual(
    noScreens.routes.map((r) => r.screens.length),
    [0, 0],
  );
  assert.deepEqual(
    noScreens.macroponents.map((m) => m.name),
    ["Acme shell"],
  );
});

test("missing fields, no app config and a missing macroponent", async () => {
  const tables = fixture();
  tables.sys_ux_page_registry[0].admin_panel = "";
  tables.sys_ux_page_registry[0].sys_scope = "";
  tables.sys_ux_page_property = [];
  tables.sys_ux_macroponent = [];
  for (const r of tables.sys_ux_page_registry) delete r.active;
  const res = payload(await run({ path: "now/acme" }, instance(tables)));
  assert.deepEqual(res.missingFields, { sys_ux_page_registry: ["active"] });
  assert.equal(res.appConfig, null);
  assert.deepEqual(res.routes, []);
  assert.ok(res.caveats.some((c) => /has no admin_panel/.test(c)));
  assert.ok(res.caveats.some((c) => /1 referenced macroponent/.test(c)));
  assert.equal(
    res.caveats.some((c) => /page properties/.test(c)),
    false,
  );
  const md = payload(
    await run({ path: "now/acme", format: "markdown" }, instance(tables)),
  ).markdown;
  assert.match(md, /_No routes read\._/);
  assert.match(md, /sys_ux_page_registry: fields not returned: active/);
});

test("invalid arguments and a missing experience fail cleanly", async () => {
  for (const args of [{}, { sys_id: EXP, path: "now/acme" }]) {
    const res = await run(args);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /exactly one of 'sys_id'/);
  }
  const missing = await run({ path: "now/nope" });
  assert.equal(missing.isError, true);
  assert.match(
    missing.content[0].text,
    /No sys_ux_page_registry record matches path 'now\/nope'/,
  );
  const dup = fixture();
  dup.sys_ux_page_registry.push({
    ...dup.sys_ux_page_registry[0],
    sys_id: id("0"),
  });
  const two = payload(await run({ path: "now/acme" }, instance(dup)));
  assert.ok(two.caveats.some((c) => /More than one/.test(c)));
});

test("an unreadable root table degrades with availability", async () => {
  const res = payload(
    await run(
      { path: "now/acme" },
      instance(fixture(), { sys_ux_page_registry: 400 }),
    ),
  );
  assert.equal(res.degraded.table, "sys_ux_page_registry");
  assert.equal(res.available, false);
  assert.equal(res.experience, null);
  const md = payload(
    await run(
      { sys_id: EXP, format: "markdown" },
      instance(fixture(), { sys_ux_page_registry: 403, sys_db_object: 403 }),
    ),
  );
  assert.match(md.markdown, /^# Experience \(unreadable\)/);
  const boom = await run(
    { path: "now/acme" },
    instance(fixture(), { sys_ux_macroponent: 500 }),
  );
  assert.equal(boom.isError, true);
});

test("progress is reported per read and a cancelled call stops", async () => {
  const sent = [];
  const extra = {
    requestId: 1,
    _meta: { progressToken: "p14" },
    sendNotification: async (n) => {
      sent.push(n);
    },
  };
  payload(await run({ path: "now/acme" }, instance(), extra));
  assert.ok(sent.length > 0);
  assert.equal(sent[0].params.progressToken, "p14");
  const controller = new AbortController();
  controller.abort();
  const mock = instance();
  const res = await run({ path: "now/acme" }, mock, {
    signal: controller.signal,
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /cancel/i);
  assert.deepEqual(mock.reads, []);
});

test("uib-composition decoder: registered, shape-checked, never throws", () => {
  assert.equal(getDecoder("uib-composition"), uibCompositionDecoder);
  assert.deepEqual(decodeField("uib-composition", '[{"elementId":"a"}]'), {
    decoded: true,
    value: [{ elementId: "a" }],
    decoder: "uib-composition",
  });
  assert.deepEqual(decodeField("uib-composition", "  "), {
    decoded: true,
    value: null,
    decoder: "uib-composition",
  });
  assert.deepEqual(decodeField("uib-composition", "[]").value, []);
  // Double-encoded JSON is accepted like the json decoder does.
  assert.equal(
    decodeField("uib-composition", JSON.stringify(JSON.stringify(COMPOSITION)))
      .decoded,
    true,
  );
  for (const raw of ["[1]", '{"elementId":"a"}', '[{"id":"x"}]', '"text"']) {
    const d = decodeField("uib-composition", raw);
    assert.equal(d.decoded, false, raw);
    assert.match(d.reason, /Not a UI Builder composition/);
    assert.equal(d.via, undefined);
  }
  assert.deepEqual(decodeField("uib-composition", "{x"), {
    decoded: false,
    reason: "Not valid JSON.",
    decoder: "uib-composition",
  });
});

test("composition readers are tolerant and bounded", () => {
  // Non-element items are skipped and counted; `children` is a default slot.
  const t = compositionTree([
    { elementId: "a", children: [{ elementId: "b" }, 7] },
    "noise",
    {
      elementId: "c",
      slots: [{ name: "x", elements: [{ elementId: "d" }] }, 3, { name: "y" }],
    },
    { elementId: "e", slots: { s: { children: [{ elementId: "f" }] }, t: 1 } },
  ]);
  assert.equal(t.count, 6);
  assert.equal(t.skipped, 2);
  assert.deepEqual(t.elements[0].slots, [
    { name: "default", elements: [{ elementId: "b", slots: [] }] },
  ]);
  assert.equal(t.elements[1].slots[0].name, "x");
  assert.equal(t.elements[2].slots[0].elements[0].elementId, "f");
  assert.deepEqual(compositionTree({ elementId: "x" }).elements, []);

  // Element cap.
  const many = Array.from({ length: COMPOSITION_MAX_ELEMENTS + 3 }, (_, i) => ({
    elementId: `e${i}`,
    children: i === COMPOSITION_MAX_ELEMENTS + 1 ? [{ elementId: "z" }] : [],
  }));
  const capped = compositionTree(many);
  assert.equal(capped.count, COMPOSITION_MAX_ELEMENTS);
  assert.equal(capped.omitted, 4);

  // Depth cap.
  let deep = { elementId: "leaf" };
  for (let i = 0; i < COMPOSITION_MAX_DEPTH + 2; i++) {
    deep = { elementId: `n${i}`, children: [deep] };
  }
  const shallow = compositionTree([deep]);
  assert.equal(shallow.count, COMPOSITION_MAX_DEPTH);
  assert.equal(shallow.omitted, 3);

  // data / state / events.
  assert.deepEqual(dataResources(null), []);
  assert.equal(dataResources({}), null);
  assert.deepEqual(dataResources([{ elementId: "d", label: "L" }, 1]), [
    { elementId: "d", label: "L" },
  ]);
  assert.deepEqual(
    stateProperties({ a: { type: "string", initialValue: null }, b: 1 }),
    [{ name: "a", type: "string" }, { name: "b" }],
  );
  assert.deepEqual(stateProperties([{ name: "" }, { x: 1 }]), []);
  assert.deepEqual(stateProperties(undefined), []);
  assert.deepEqual(
    eventWiring([
      { sourceElementId: "s", eventName: "E", targets: "t" },
      { elementId: "s2", handlers: [{ name: "n" }, { targetId: "tt" }, 5, ""] },
      { nothing: true },
      9,
    ]),
    [
      { source: "s", event: "E", handlers: ["t"] },
      { source: "s2", handlers: ["n", "tt"] },
    ],
  );
  assert.deepEqual(eventWiring({ s: { definition: { id: "h" } } }), [
    { source: "s", handlers: ["h"] },
  ]);
  assert.deepEqual(eventWiring({ s: undefined }), [
    { source: "s", handlers: [] },
  ]);
  assert.equal(eventWiring(5), null);
  assert.deepEqual(eventWiring(null), []);
});

// N-26 (UX-02, UX-03, UX-04, UX-06) — page explainer depth: element props and
// bindings, event → handler → target chains, component resolution and opt-in
// script bodies. The tool reaches it through format:"file" (no tools/list
// change); the API takes `detail`. Shapes are verified:false until O-5.
const CUSTOM_C = "ef".repeat(16);
const NESTED_MP = "12".repeat(16);
const EVT = "34".repeat(16);
const MISSING_C = "56".repeat(16);

const DEEP_COMPOSITION = [
  {
    elementId: "list_1",
    definition: { id: "now-record-list", type: "COMPONENT" },
    propertyValues: {
      table: { type: "JSON_LITERAL", value: "incident" },
      items: {
        type: "DATA_OUTPUT_BINDING",
        binding: { address: ["incidents", "results"] },
      },
      selected: {
        type: "STATE_BINDING",
        binding: { address: ["selectedTab"] },
      },
      sysId: {
        type: "CONTEXT_BINDING",
        binding: { address: ["props", "sysId"] },
      },
      title: "Open: @state.count of @data.counter.output",
      filter: "@state.missingState",
      onRow: { type: "CLIENT_TRANSFORM_SCRIPT", value: "function(){}" },
    },
    isHidden: { type: "STATE_BINDING", binding: { address: ["hideList"] } },
    config: { density: "compact" },
    overrides: {
      inner_1: { propertyValues: { label: "@context.props.title" } },
    },
  },
  {
    elementId: "card",
    definition: { id: CUSTOM_C, type: "COMPONENT" },
    slots: [
      {
        slotName: "body",
        children: [
          {
            elementId: "nested",
            definition: { id: NESTED_MP, type: "MACROPONENT" },
          },
        ],
      },
    ],
  },
  { elementId: "ghost", definition: { id: MISSING_C } },
  { elementId: "ghost2", definition: { id: "x-acme-widget" } },
];

const DEEP_EVENTS = [
  {
    sourceElementId: "list_1",
    event: "NOW_RECORD_LIST#ROW_CLICKED",
    handlers: [
      { type: "CLIENT_SCRIPT", definition: { id: "cs1" } },
      {
        type: "DATABROKER_OP",
        targetId: "incidents",
        operationName: "REFRESH",
      },
      {
        type: "UPDATE_STATE",
        parameters: { propName: { value: "selectedTab" } },
      },
      { definition: { id: EVT, type: "EVENT" } },
    ],
  },
  {
    sourceElementId: "card.CARD#CLICKED",
    handlers: [{ type: "SET_STATE", propName: "nope" }, { odd: 1 }],
  },
];

function deepFixture() {
  const tables = fixture();
  const home = tables.sys_ux_macroponent.find((m) => m.sys_id === HOME_MP);
  home.composition = JSON.stringify(DEEP_COMPOSITION);
  home.internal_event_mappings = JSON.stringify(DEEP_EVENTS);
  tables.sys_ux_macroponent.push({
    sys_id: NESTED_MP,
    name: "Acme nested",
    category: "component",
  });
  tables.sys_ux_client_script[0].script = "api.setState('selectedTab', 'x');";
  tables.sys_ux_data_broker_transform[0].script = "(function(){ return 1; })";
  tables.sys_ux_data_broker_scriptlet[0].script = "x".repeat(100_010);
  tables.sys_ux_lib_component = [
    { sys_id: CUSTOM_C, name: "Acme card", tag: "x-acme-card" },
    { sys_id: "lc2", name: "Record list", tag: "now-record-list" },
  ];
  tables.sys_ux_event = [{ sys_id: EVT, name: "ACME#OPEN", label: "Open" }];
  return tables;
}

test("N-26: the default JSON stays metadata-only and shallow", async () => {
  const mock = instance(deepFixture());
  const res = payload(await run({ path: "now/acme" }, mock));
  const home = res.macroponents.find((m) => m.sys_id === HOME_MP);
  assert.equal(res.detail, undefined);
  assert.equal(home.components, undefined);
  assert.equal(home.bindings, undefined);
  assert.equal(home.eventChains, undefined);
  assert.equal(home.composition.value.elements[0].props, undefined);
  assert.equal(home.clientScripts[0].script, undefined);
  assert.equal(res.dataBrokers[0].script, undefined);
  assert.ok(!mock.reads.includes("sys_ux_lib_component"));
  assert.ok(!mock.reads.includes("sys_ux_event"));
  // The flat wiring is still reported as before.
  assert.deepEqual(home.events.value[0], {
    source: "list_1",
    event: "NOW_RECORD_LIST#ROW_CLICKED",
    handlers: ["cs1", "REFRESH", "UPDATE_STATE", EVT],
  });
});

test("N-26: format:file carries props, bindings, events, components and scripts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sn-n26-"));
  try {
    const res = await withEnv({ SN_DOCS_DIR: dir }, () =>
      run({ path: "now/acme", format: "file" }, instance(deepFixture())),
    );
    const out = payload(res);
    const written = JSON.parse(readFileSync(out.file, "utf8"));
    assert.deepEqual(written.detail, {
      levels: ["elements", "bindings", "events", "scripts"],
      components: 5,
      unresolvedComponents: 2,
      bindings: 8,
      eventChains: 2,
      scripts: 3,
    });
    assert.ok(written.caveats.some((c) => /propertyValues/.test(c)));
    const home = written.macroponents.find((m) => m.sys_id === HOME_MP);

    // UX-02: props, config, overrides and a bound visibility.
    const list = home.composition.value.elements[0];
    const prop = (n) => list.props.find((p) => p.name === n);
    assert.deepEqual(prop("table"), {
      name: "table",
      source: "props",
      kind: "literal",
      value: "incident",
    });
    assert.deepEqual(prop("items").bindings, ["@data.incidents.results"]);
    assert.equal(prop("title").kind, "expression");
    assert.equal(prop("onRow").kind, "script");
    assert.equal(prop("isHidden").kind, "state");
    assert.equal(prop("density").source, "config");
    assert.deepEqual(prop("inner_1.label"), {
      name: "inner_1.label",
      source: "overrides",
      kind: "context",
      bindings: ["@context.props.title"],
    });
    const bind = (e) => home.bindings.find((b) => b.expression === e);
    assert.deepEqual(bind("@data.incidents.results").resolves, {
      dataResource: "incidents",
      broker: BROKER_T,
      brokerName: "Incident list",
    });
    assert.deepEqual(bind("@state.selectedTab").resolves, {
      state: "selectedTab",
      declared: true,
    });
    assert.deepEqual(bind("@state.missingState").resolves, {
      state: "missingState",
      declared: false,
    });
    assert.deepEqual(bind("@context.props.sysId").resolves, {
      context: "props.sysId",
    });
    assert.equal(bind("@data.counter.output").resolves.brokerName, "Counter");

    // UX-03: source → event → handler targets.
    assert.deepEqual(home.eventChains[0], {
      source: "list_1",
      element: "list_1",
      component: "now-record-list",
      event: "NOW_RECORD_LIST#ROW_CLICKED",
      targets: [
        {
          kind: "clientScript",
          sys_id: "cs1",
          name: "onLoad",
          type: "CLIENT_SCRIPT",
        },
        {
          kind: "brokerOperation",
          dataResource: "incidents",
          operation: "REFRESH",
          broker: BROKER_T,
          brokerName: "Incident list",
          type: "DATABROKER_OP",
        },
        {
          kind: "state",
          property: "selectedTab",
          declared: true,
          name: "UPDATE_STATE",
          type: "UPDATE_STATE",
        },
        { kind: "event", name: "ACME#OPEN", sys_id: EVT, type: "EVENT" },
      ],
    });
    assert.deepEqual(home.eventChains[1], {
      source: "card.CARD#CLICKED",
      element: "card",
      component: CUSTOM_C,
      event: "CARD#CLICKED",
      targets: [
        {
          kind: "state",
          property: "nope",
          declared: false,
          name: "SET_STATE",
          type: "SET_STATE",
        },
      ],
    });

    // UX-04: component resolution.
    const comp = (id) => home.components.find((c) => c.id === id);
    assert.equal(comp("now-record-list").kind, "oob");
    assert.equal(comp("now-record-list").artifactType, "uib_component");
    assert.deepEqual(comp(CUSTOM_C), {
      id: CUSTOM_C,
      kind: "custom",
      sys_id: CUSTOM_C,
      name: "Acme card",
      tag: "x-acme-card",
      table: "sys_ux_lib_component",
      artifactType: "uib_component",
      elements: ["card"],
    });
    assert.deepEqual(comp(NESTED_MP), {
      id: NESTED_MP,
      kind: "macroponent",
      sys_id: NESTED_MP,
      name: "Acme nested",
      category: "component",
      table: "sys_ux_macroponent",
      artifactType: "uib_macroponent",
      elements: ["nested"],
    });
    assert.equal(comp(MISSING_C).kind, "unresolved");
    assert.equal(comp("x-acme-widget").kind, "unresolved");

    // UX-06: script bodies, cut at UI_SCRIPT_MAX.
    assert.match(home.clientScripts[0].script, /setState/);
    const t = written.dataBrokers.find((b) => b.sys_id === BROKER_T);
    assert.match(t.script, /return 1/);
    const sl = written.dataBrokers.find((b) => b.sys_id === BROKER_S);
    assert.equal(sl.script.length, 100_000);
    assert.equal(sl.scriptTruncated, 10);

    // Event flow view.
    lintMermaid(written.eventMermaid);
    assert.match(written.eventMermaid, /ACME#OPEN|ACME/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("N-26: API levels are independent; markdown renders the deep sections", async () => {
  const {
    explainUiExperience,
    uiExperienceMarkdown,
    uiExperienceEventMermaid,
  } = await import("../build/api/ui-experience.js");
  const mock = instance(deepFixture());
  const res = await withMetadataFetch(mock.handler, () =>
    explainUiExperience({ path: "now/acme", detail: "events" }),
  );
  const home = res.macroponents.find((m) => m.sys_id === HOME_MP);
  assert.deepEqual(res.detail.levels, ["events"]);
  assert.equal(home.components, undefined);
  assert.equal(home.bindings, undefined);
  assert.equal(home.eventChains.length, 2);
  assert.ok(!mock.reads.includes("sys_ux_lib_component"));
  const md = uiExperienceMarkdown(res, "flowchart TD");
  assert.match(md, /Event chains:/);
  assert.match(md, /client script onLoad/);
  assert.match(md, /REFRESH on incidents \(Incident list\)/);
  assert.match(md, /set state nope _\(undeclared\)_/);
  // No chain → no event view.
  const plain = await withMetadataFetch(instance().handler, () =>
    explainUiExperience({ path: "now/acme" }),
  );
  assert.equal(uiExperienceEventMermaid(plain).mermaid, "");

  const all = await withMetadataFetch(instance(deepFixture()).handler, () =>
    explainUiExperience({
      path: "now/acme",
      detail: ["bindings", "elements", "bogus"],
    }),
  );
  assert.deepEqual(all.detail.levels, ["elements", "bindings"]);
  const md2 = uiExperienceMarkdown(all, "flowchart TD");
  assert.match(md2, /Components:/);
  assert.match(md2, /Bindings:/);
  assert.match(md2, /`list_1`\.selected = @state\.selectedTab → client state/);
});

test("N-26: prop and handler readers are tolerant and bounded", async () => {
  const { classifyProp, eventMappings, ELEMENT_MAX_PROPS } =
    await import("../build/core/artifacts/uib-composition.js");
  assert.deepEqual(classifyProp("@data.a.b"), {
    kind: "data",
    bindings: ["@data.a.b"],
  });
  assert.deepEqual(classifyProp("plain"), { kind: "literal", value: "plain" });
  assert.deepEqual(classifyProp(42), { kind: "literal", value: 42 });
  assert.equal(classifyProp("y".repeat(500)).value.length, 200);
  assert.deepEqual(
    classifyProp({ type: "JSON_LITERAL", value: "@state.flag" }),
    { kind: "state", bindings: ["@state.flag"] },
  );
  assert.deepEqual(
    classifyProp({ type: "MAP_CONTAINER", container: { a: "@data.r.x" } }),
    { kind: "expression", bindings: ["@data.r.x"] },
  );
  assert.deepEqual(classifyProp({ type: "STATE_BINDING" }), { kind: "state" });
  assert.deepEqual(classifyProp(undefined), { kind: "literal" });

  const many = Object.fromEntries(
    Array.from({ length: ELEMENT_MAX_PROPS + 5 }, (_, i) => [`p${i}`, i]),
  );
  const tree = compositionTree([{ elementId: "e", propertyValues: many }], {
    props: true,
  });
  assert.equal(tree.elements[0].props.length, ELEMENT_MAX_PROPS);
  assert.equal(tree.elements[0].propsOmitted, 5);

  assert.deepEqual(eventMappings(null), []);
  assert.equal(eventMappings("text"), null);
  assert.deepEqual(
    eventMappings({
      btn: { CLICKED: ["NAMED", { targetId: "r", operation: "X" }] },
    }),
    [
      {
        source: "btn",
        event: "CLICKED",
        handlers: [
          { name: "NAMED" },
          { name: "r", targetId: "r", operation: "X" },
        ],
      },
    ],
  );
});

// N-31 (UX-22, UX-23): page hints and translations.

/** A macroponent row with `n` flat elements, a slot chain `depth` deep and `data`. */
function heavyMacroponent(sysId, { n = 0, depth = 0, data = [] } = {}) {
  const composition = Array.from({ length: n }, (_, i) => ({
    elementId: `e${i}`,
  }));
  if (depth) {
    let deep = { elementId: `d${depth}` };
    for (let i = depth - 1; i >= 1; i--) {
      deep = {
        elementId: `d${i}`,
        slots: [{ slotName: "s", children: [deep] }],
      };
    }
    composition.push(deep);
  }
  return {
    sys_id: sysId,
    name: "Heavy page",
    category: "page",
    composition: JSON.stringify(composition),
    data: JSON.stringify(data),
    state_properties: "",
    internal_event_mappings: "",
  };
}

test("N-31: pageHints lists uib-page-weight findings per macroponent", async () => {
  const res = payload(await run({ path: "now/acme" }));
  // The fixture home fires three data resources on load without `when`.
  assert.deepEqual(res.pageHints, [
    {
      macroponent: HOME_MP,
      name: "Acme home",
      screens: ["Home (default)"],
      findings: [
        {
          rule: "uib-page-weight",
          severity: "info",
          metric: "unconditional-broker",
          value: 3,
          message:
            "3 data resource(s) fire on page load without a `when` condition.",
          elementIds: ["incidents", "counter", "graph"],
        },
      ],
    },
  ]);
  assert.ok(res.caveats.some((c) => /^Page hints \(uib-page-weight\)/.test(c)));
  // Default depth: no metrics or translations on the macroponents.
  for (const m of res.macroponents) {
    assert.equal(m.pageMetrics, undefined);
    assert.equal(m.translations, undefined);
  }

  // A heavy page trips every metric; JUST_IN_TIME and `when` are exempt.
  const tables = fixture();
  const data = [
    ...Array.from({ length: 6 }, (_, i) => ({ elementId: `b${i}` })),
    { elementId: "lazy", evaluationMode: "JUST_IN_TIME" },
    { elementId: "guarded", when: "@state.tab == 'x'" },
  ];
  tables.sys_ux_macroponent[1] = heavyMacroponent(HOME_MP, {
    n: 150,
    depth: 9,
    data,
  });
  const heavy = payload(await run({ path: "now/acme" }, instance(tables)));
  assert.equal(heavy.pageHints.length, 1);
  const hint = heavy.pageHints[0];
  assert.equal(hint.name, "Heavy page");
  assert.deepEqual(
    hint.findings.map((f) => [f.metric, f.value, f.threshold]),
    [
      ["elements", 159, 150],
      ["depth", 9, 8],
      ["on-load-brokers", 7, 5],
      ["unconditional-broker", 6, undefined],
    ],
  );
  assert.deepEqual(hint.findings[3].elementIds, [
    "b0",
    "b1",
    "b2",
    "b3",
    "b4",
    "b5",
  ]);
  for (const f of hint.findings) assert.equal(f.hint, undefined);

  const md = payload(
    await run({ path: "now/acme", format: "markdown" }, instance(tables)),
  ).markdown;
  assert.match(md, /## Page hints\n\n`uib-page-weight`: Split a heavy page/);
  assert.match(md, /- \*\*Heavy page\*\* \(Home \(default\)\)/);
  assert.match(md, / {2}- The page has 159 elements \(threshold 150\)\./);
  assert.match(md, /without a `when` condition\. `b0`, `b1`/);
});

test("N-31: a light page adds no pageHints and no caveat", async () => {
  const tables = fixture();
  tables.sys_ux_macroponent[1].data = JSON.stringify([
    { elementId: "incidents", evaluationMode: "LAZY" },
    { elementId: "counter", when: "@state.count > 0" },
  ]);
  const res = payload(await run({ path: "now/acme" }, instance(tables)));
  assert.equal("pageHints" in res, false);
  assert.equal(
    res.caveats.some((c) => /uib-page-weight/.test(c)),
    false,
  );
  const md = payload(
    await run({ path: "now/acme", format: "markdown" }, instance(tables)),
  ).markdown;
  assert.doesNotMatch(md, /## Page hints/);
});

test("N-31: elements depth adds page metrics and a translations summary", async () => {
  const { explainUiExperience, uiExperienceMarkdown } =
    await import("../build/api/ui-experience.js");
  const tables = fixture();
  const labels = Array.from({ length: 25 }, (_, i) => ({
    elementId: `t${i}`,
    propertyValues: { label: `Label ${String(i).padStart(2, "0")}` },
  }));
  const home = tables.sys_ux_macroponent[1];
  home.composition = JSON.stringify([
    {
      elementId: "hdr",
      propertyValues: {
        title: "Open incidents",
        heading: { type: "TRANSLATION_LITERAL", value: "Welcome" },
        table: "incident",
        tooltip: "@data.incidents.results",
      },
    },
    { elementId: "hdr2", propertyValues: { title: "Open incidents" } },
    ...labels,
  ]);
  home.required_translations = JSON.stringify([
    "Open incidents",
    { message: "Label 00" },
  ]);
  // The default read does not ask for required_translations.
  const plain = await withMetadataFetch(instance(tables).handler, () =>
    explainUiExperience({ path: "now/acme" }),
  );
  assert.equal(plain.macroponents[1].translations, undefined);
  assert.equal(plain.detail, undefined);

  const res = await withMetadataFetch(instance(tables).handler, () =>
    explainUiExperience({ path: "now/acme", detail: "elements" }),
  );
  const mp = res.macroponents.find((m) => m.sys_id === HOME_MP);
  assert.deepEqual(mp.pageMetrics, {
    elements: 27,
    maxDepth: 1,
    dataBrokers: 3,
    onLoadBrokers: 3,
    unconditionalOnLoad: ["incidents", "counter", "graph"],
  });
  assert.equal(mp.translations.strings, 28);
  assert.equal(mp.translations.texts, 27);
  assert.equal(mp.translations.declared, 2);
  assert.equal(mp.translations.undeclared, 25);
  assert.equal(mp.translations.sample.length, 20);
  assert.equal(mp.translations.sample[0], "Label 01");
  assert.ok(!mp.translations.sample.includes("Open incidents"));
  // Sorted and bounded: "Welcome" (a typed literal) is the 25th undeclared.
  assert.equal(mp.translations.sample.at(-1), "Label 20");
  assert.equal(res.detail.translatableStrings, 28);
  assert.equal(res.detail.undeclaredTranslations, 25);
  assert.ok(res.caveats.some((c) => /^Translations list user-facing/.test(c)));
  // The shell (empty composition) carries metrics but no translations.
  assert.equal(res.macroponents[0].translations, undefined);
  assert.equal(res.macroponents[0].pageMetrics.elements, 0);
  // Rows without the field are not missing while one row returns it.
  assert.deepEqual(res.missingFields, undefined);

  const md = uiExperienceMarkdown(res, "flowchart TD");
  assert.match(
    md,
    /Page weight: 27 element\(s\), slot depth 1, 3 of 3 data resource\(s\) on load, 3 without `when`/,
  );
  assert.match(
    md,
    /Translations: 27 string\(s\) in 28 use\(s\), 2 declared, 25 undeclared · missing: "Label 01", "Label 02"/,
  );
});

test("N-31: an unreadable required_translations leaves declared null", async () => {
  const { explainUiExperience } = await import("../build/api/ui-experience.js");
  const tables = fixture();
  const home = tables.sys_ux_macroponent[1];
  home.composition = JSON.stringify([
    { elementId: "a", propertyValues: { label: "Save" } },
    { elementId: "b", propertyValues: { placeholder: "Search" } },
  ]);
  home.required_translations = "{not json";
  const res = await withMetadataFetch(instance(tables).handler, () =>
    explainUiExperience({ path: "now/acme", detail: ["elements"] }),
  );
  const mp = res.macroponents.find((m) => m.sys_id === HOME_MP);
  assert.deepEqual(mp.translations, {
    strings: 2,
    texts: 2,
    declared: null,
    undeclared: 0,
    sample: ["Save", "Search"],
  });
  // The field not returned at all is unknown too, and listed as missing.
  delete home.required_translations;
  const missing = await withMetadataFetch(instance(tables).handler, () =>
    explainUiExperience({ path: "now/acme", detail: ["elements"] }),
  );
  const m2 = missing.macroponents.find((m) => m.sys_id === HOME_MP);
  assert.equal(m2.translations.declared, null);
  assert.deepEqual(missing.missingFields, {
    sys_ux_macroponent: ["required_translations"],
  });
  // An empty declaration is known: every string is undeclared.
  home.required_translations = "";
  const empty = await withMetadataFetch(instance(tables).handler, () =>
    explainUiExperience({ path: "now/acme", detail: ["elements"] }),
  );
  const m3 = empty.macroponents.find((m) => m.sys_id === HOME_MP);
  assert.equal(m3.translations.declared, 0);
  assert.equal(m3.translations.undeclared, 2);
});
