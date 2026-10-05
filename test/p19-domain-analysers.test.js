// P-19 — domain analysers: the flow, Service Portal, UI Builder and
// legacy-workflow rules
// behind check_code_health's opt-in `domains` switch. Every rule has a positive and
// a negative fixture; the instance double answers `fieldIN…` queries by
// filtering its rows, so the reads are exercised as they are sent.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ALL_TOOLS } from "../build/mcp/registry.js";
import { runSpec } from "../build/mcp/define.js";
import {
  analyseDomains,
  durationSeconds,
  routeLoops,
  DOMAIN_CHILD_MAX,
} from "../build/api/domain-analysers.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withMetadataFetch,
} from "./helpers.js";

baselineEnv();

const call = (name, args) =>
  runSpec(
    ALL_TOOLS.find((s) => s.name === name),
    args,
  );
const out = (res) => JSON.parse(res.content[0].text);

/**
 * `tables[t]` is a row list (a leading `fieldIN…` clause filters it) or a
 * function of the encoded query. `sysparm_limit` is honoured.
 */
function instance(tables, statuses = {}) {
  return (url) => {
    const u = new URL(url);
    const m = /^\/api\/now\/table\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const t = m[1];
      if (statuses[t]) {
        return jsonResponse(statuses[t], { error: { message: "denied" } });
      }
      const q = u.searchParams.get("sysparm_query") ?? "";
      const src = tables[t];
      let rows = typeof src === "function" ? src(q) : (src ?? []);
      const inq = /^([\w.]+)IN([^^]*)/.exec(q);
      if (inq && typeof src !== "function") {
        const ids = new Set(inq[2].split(","));
        rows = rows.filter((r) => ids.has(String(r[inq[1]] ?? "")));
      }
      const limit = Number(u.searchParams.get("sysparm_limit") ?? "10000");
      return jsonResponse(200, { result: rows.slice(0, limit) });
    }
    if (u.pathname.startsWith("/api/now/stats/")) {
      return jsonResponse(200, { result: { stats: { count: "0" } } });
    }
    return jsonResponse(200, { result: [] });
  };
}

async function scenario(tables, fn, statuses) {
  const docs = mkdtempSync(path.join(tmpdir(), "p19-"));
  freshRuntime();
  try {
    return await withEnv({ SN_DOCS_DIR: docs }, () =>
      withMetadataFetch(instance(tables, statuses), (calls) => fn(calls, docs)),
    );
  } finally {
    rmSync(docs, { recursive: true, force: true });
  }
}

const vals = (obj) =>
  JSON.stringify(Object.entries(obj).map(([name, value]) => ({ name, value })));

// --- fixtures -------------------------------------------------------------------

const FLOWS = [
  // run_as System + protected trigger table; draft differs; unguarded REST; long wait.
  {
    sys_id: "f1",
    name: "Grant roles",
    type: "flow",
    active: "true",
    run_as: "system",
    master_snapshot: "s1",
    latest_snapshot: "s2",
  },
  // run_as System on an ordinary table; published = latest; guarded REST; short wait.
  {
    sys_id: "f2",
    name: "Incident sync",
    type: "flow",
    active: "true",
    run_as: "system",
    master_snapshot: "s3",
    latest_snapshot: "s3",
  },
  // run_as System, a step input names a protected table; step-type REST unguarded.
  {
    sys_id: "f3",
    name: "Property writer",
    type: "flow",
    active: "true",
    run_as: "system",
    master_snapshot: "s4",
    latest_snapshot: "s4",
  },
  // Runs as the user: protected table is fine.
  {
    sys_id: "f4",
    name: "User flow",
    type: "flow",
    active: "true",
    run_as: "user",
    master_snapshot: "",
    latest_snapshot: "s5",
  },
];
const SUBFLOWS = [
  { sys_id: "sf1", name: "Called subflow" },
  { sys_id: "sf2", name: "Dead subflow" },
];
const ACTION_DEFS = [
  { sys_id: "a_rest", name: "REST call", internal_name: "rest_call" },
  { sys_id: "a_log", name: "Log", internal_name: "log" },
  { sys_id: "a_step", name: "Custom lookup", internal_name: "lookup" },
  { sys_id: "a_dead", name: "Dead action", internal_name: "dead" },
];

const FLOW_TABLES = {
  sys_hub_flow: (q) => {
    if (q.startsWith("run_as=system")) {
      return FLOWS.filter((f) => f.run_as === "system");
    }
    if (q.startsWith("type=subflow")) return SUBFLOWS;
    return FLOWS;
  },
  sys_hub_trigger_instance_v2: [
    { sys_id: "t1", flow: "f1", table: "sys_user_has_role", values: "" },
    { sys_id: "t2", flow: "f2", table: "incident", values: "" },
    { sys_id: "t4", flow: "f4", table: "sys_user", values: "" },
  ],
  sys_hub_action_instance_v2: [
    // f1: unguarded REST.
    {
      sys_id: "i1",
      flow: "f1",
      ui_id: "u1",
      parent_ui_id: "",
      action_type: "a_rest",
      "action_type.name": "REST call",
      values: vals({ endpoint: "https://x" }),
    },
    // f2: REST inside Try; Log outside.
    {
      sys_id: "i2",
      flow: "f2",
      ui_id: "u2",
      parent_ui_id: "try1",
      action_type: "a_rest",
      "action_type.name": "REST call",
      values: "",
    },
    {
      sys_id: "i3",
      flow: "f2",
      ui_id: "u3",
      parent_ui_id: "",
      action_type: "a_log",
      "action_type.name": "Log",
      values: vals({ table: "incident" }),
    },
    // f3: writes sys_properties; its action has a REST step type.
    {
      sys_id: "i4",
      flow: "f3",
      ui_id: "u4",
      parent_ui_id: "",
      action_type: "a_step",
      "action_type.name": "Custom lookup",
      values: vals({ table_name: "sys_properties" }),
    },
    // f4 (runs as user) touches sys_user — no run-as finding.
    {
      sys_id: "i5",
      flow: "f4",
      ui_id: "u5",
      parent_ui_id: "",
      action_type: "a_log",
      "action_type.name": "Log",
      values: vals({ table: "sys_user" }),
    },
  ],
  sys_hub_flow_logic_instance_v2: [
    {
      sys_id: "l1",
      flow: "f2",
      ui_id: "try1",
      parent_ui_id: "",
      logic_definition: "ld_try",
      "logic_definition.name": "Try",
      values: "",
    },
    {
      sys_id: "l2",
      flow: "f1",
      ui_id: "w1",
      parent_ui_id: "",
      logic_definition: "ld_wait",
      "logic_definition.name": "Wait For a Duration",
      values: vals({ duration: "1970-01-03 00:00:00" }),
    },
    {
      sys_id: "l3",
      flow: "f2",
      ui_id: "w2",
      parent_ui_id: "",
      logic_definition: "ld_wait",
      "logic_definition.name": "Wait For a Duration",
      values: vals({ duration: "1970-01-01 01:00:00" }),
    },
  ],
  sys_hub_sub_flow_instance_v2: [{ sys_id: "c1", flow: "f1", subflow: "sf1" }],
  sys_hub_action_type_definition: (q) => {
    const inq = /^sys_idIN([^^]*)/.exec(q);
    if (inq) {
      const ids = new Set(inq[1].split(","));
      return ACTION_DEFS.filter((d) => ids.has(d.sys_id));
    }
    return ACTION_DEFS;
  },
  sys_hub_step_instance: [
    { sys_id: "st1", action: "a_step", "step_type.name": "REST" },
    { sys_id: "st2", action: "a_log", "step_type.name": "Log" },
  ],
};

const WIDGETS = [
  // public + GlideRecord → finding; embeds w5 by id.
  {
    sys_id: "w1",
    id: "w1-id",
    name: "Public reader",
    public: "true",
    script: 'var gr = new GlideRecord("incident"); gr.query();',
    template: "<div></div>",
    client_script: "$sp.getWidget('w5-id');",
    link: "",
  },
  // public + GlideRecordSecure → no finding.
  {
    sys_id: "w2",
    id: "w2-id",
    name: "Public secure",
    public: "true",
    script: 'var gr = new GlideRecordSecure("incident"); gr.query();',
    template: "<a href='?id=p4-id'>x</a>",
    client_script: "",
    link: "",
  },
  // private, placed on a public page, GlideAggregate → finding.
  {
    sys_id: "w3",
    id: "w3-id",
    name: "On public page",
    public: "false",
    script: 'var ga = new GlideAggregate("task");',
    template: "",
    client_script: "",
    link: "",
  },
  // private, not on a public page, GlideRecord → no finding; unplaced → orphan.
  {
    sys_id: "w4",
    id: "w4-id",
    name: "Private orphan",
    public: "false",
    script: 'var gr = new GlideRecord("incident");',
    template: "",
    client_script: "",
    link: "",
  },
  // unplaced but embedded by w1 → not an orphan.
  {
    sys_id: "w5",
    id: "w5-id",
    name: "Embedded",
    public: "false",
    script: "",
    template: "",
    client_script: "",
    link: "",
  },
];
const PAGES = [
  { sys_id: "p1", id: "p1-id", title: "Home", public: "true" },
  { sys_id: "p2", id: "p2-id", title: "Menu target", public: "false" },
  { sys_id: "p3", id: "p3-id", title: "Routed", public: "false" },
  { sys_id: "p4", id: "p4-id", title: "Linked by id", public: "false" },
  { sys_id: "p5", id: "p5-id", title: "Orphan", public: "false" },
];
const PAGE_KEY = "sp_column.sp_row.sp_container.sp_page";
const INSTANCES = [
  { sys_id: "in1", sp_widget: "w1", [PAGE_KEY]: "p2" },
  { sys_id: "in2", sp_widget: "w2", [PAGE_KEY]: "p2" },
  { sys_id: "in3", sp_widget: "w3", [PAGE_KEY]: "p1" },
];
const ROUTE_MAPS = [
  // p3 → p6 → p3, all portals: loop.
  {
    sys_id: "m1",
    short_description: "A",
    route_from_page: "p3",
    route_to_page: "p6",
    portals: "",
    order: "100",
  },
  {
    sys_id: "m2",
    short_description: "B",
    route_from_page: "p6",
    route_to_page: "p3",
    portals: "",
    order: "100",
  },
  // p7 → p8, no way back: no loop.
  {
    sys_id: "m3",
    short_description: "C",
    route_from_page: "p7",
    route_to_page: "p8",
    portals: "",
    order: "100",
  },
  // p9 → p10 in portal X, p10 → p9 in portal Y: no loop in either portal.
  {
    sys_id: "m4",
    short_description: "D",
    route_from_page: "p9",
    route_to_page: "p10",
    portals: "portalX",
    order: "100",
  },
  {
    sys_id: "m5",
    short_description: "E",
    route_from_page: "p10",
    route_to_page: "p9",
    portals: "portalY",
    order: "100",
  },
];

const PORTAL_TABLES = {
  sp_widget: (q) => {
    const inq = /^sys_idIN([^^]*)/.exec(q);
    if (inq) {
      const ids = new Set(inq[1].split(","));
      return WIDGETS.filter((w) => ids.has(w.sys_id));
    }
    return WIDGETS;
  },
  sp_page: (q) =>
    q.startsWith("public=true")
      ? PAGES.filter((p) => p.public === "true")
      : PAGES,
  sp_instance: INSTANCES,
  sp_portal: [
    { sys_id: "portal1", homepage: "p1", login_page: "", notfound_page: "" },
  ],
  sp_rectangle_menu_item: (q) => {
    if (q.startsWith("sp_pageIN")) return [{ sp_page: "p2" }];
    if (q.startsWith("urlLIKE")) return [{ url: "?id=nothing" }];
    return [];
  },
  sp_page_route_map: ROUTE_MAPS,
};

const WF_TABLES = {
  sc_cat_item: [
    {
      sys_id: "ci1",
      name: "Laptop",
      workflow: "wf1",
      "workflow.name": "Old approval",
    },
    {
      sys_id: "ci2",
      name: "Phone",
      workflow: "wf1",
      "workflow.name": "Old approval",
    },
  ],
  contract_sla: [
    {
      sys_id: "sla1",
      name: "P1 resolve",
      workflow: "wf2",
      "workflow.name": "SLA notify",
    },
  ],
};

// UI Builder: r1 has a screen, r2's screen type has none, r3 has no screen type.
// sc1 has no audience and shadows sc2 (same type, later order); sc3 has no
// audience and no later sibling. Broker b1 has an ACL, b2 / b3 have none.
const UIB_SCREENS = [
  {
    sys_id: "sc1",
    name: "Default home",
    screen_type: "st1",
    order: "10",
    applicability: "",
  },
  {
    sys_id: "sc2",
    name: "Agent home",
    screen_type: "st1",
    order: "20",
    applicability: "ap1",
  },
  {
    sys_id: "sc3",
    name: "Record",
    screen_type: "st3",
    order: "100",
    applicability: "",
  },
];
const UIB_TABLES = {
  sys_ux_app_route: [
    { sys_id: "r1", name: "home", screen_type: "st1", app_config: "cfg" },
    { sys_id: "r2", name: "orphan", screen_type: "st9", app_config: "cfg" },
    { sys_id: "r3", name: "blank", screen_type: "" },
  ],
  sys_ux_screen: (q) => {
    if (q.startsWith("applicabilityISEMPTY")) {
      return UIB_SCREENS.filter((s) => !s.applicability);
    }
    const m = /^screen_typeIN([^^]*)/.exec(q);
    const types = new Set(m ? m[1].split(",") : []);
    return UIB_SCREENS.filter((s) => types.has(s.screen_type));
  },
  sys_ux_data_broker_transform: [
    { sys_id: "b1", name: "Guarded transform" },
    { sys_id: "b2", name: "Open transform" },
  ],
  sys_ux_data_broker_scriptlet: [{ sys_id: "b3", name: "Open scriptlet" }],
  sys_security_acl: (q) => {
    assert.match(q, /\^type=ux_data_broker$/);
    return q.startsWith("nameIN") && q.includes("b1") ? [{ name: "b1" }] : [];
  },
};

const ALL = {
  ...FLOW_TABLES,
  ...PORTAL_TABLES,
  ...WF_TABLES,
  ...UIB_TABLES,
};

const ids = (d, rule) =>
  d.findings
    .filter((f) => f.rule === rule)
    .map((f) => f.ref.sys_id)
    .sort();

// --- tests -----------------------------------------------------------------------

test("check_code_health: domains is opt-in — the default reads no flow / portal table", async () => {
  await scenario(ALL, async (calls) => {
    const r = out(await call("servicenow_check_code_health", {}));
    assert.equal(r.domains, undefined);
    const touched = calls.map((c) => new URL(c.url).pathname);
    assert.ok(
      !touched.some((p) => /sys_hub_|sp_page_route_map|contract_sla/.test(p)),
    );
  });
});

test("check_code_health domains: result, report section and bounded candidate reads (acceptance)", async () => {
  await scenario(ALL, async (calls, docs) => {
    const r = out(
      await call("servicenow_check_code_health", { domains: true, limit: 10 }),
    );
    const d = r.domains;
    assert.ok(d, JSON.stringify(r).slice(0, 400));
    assert.equal(d.limit, 10);
    assert.equal(d.findingCount, d.findings.length);
    for (const f of d.findings) {
      assert.ok(
        f.rule && f.severity && f.ref.sys_id && f.ref.table && f.message,
      );
    }
    assert.equal(
      d.bySeverity.warn,
      d.findings.filter((f) => f.severity === "warn").length,
    );
    // Warnings sort first.
    const firstInfo = d.findings.findIndex((f) => f.severity === "info");
    assert.ok(d.findings.slice(firstInfo).every((f) => f.severity === "info"));
    const md = readFileSync(
      r.reportFile.startsWith("/")
        ? r.reportFile
        : path.join(docs, r.reportFile),
      "utf8",
    );
    assert.match(md, /## Domain analysers/);
    assert.match(md, /flow-run-as-system-protected/);
    // Candidate reads carry limit + 1.
    const flowReads = calls
      .map((c) => new URL(c.url))
      .filter((u) => u.pathname.endsWith("/sys_hub_flow"));
    assert.ok(flowReads.length >= 3);
    for (const u of flowReads)
      assert.equal(u.searchParams.get("sysparm_limit"), "11");
  });
});

test("flow-run-as-system-protected: trigger and step tables (positive) vs ordinary table / run as user (negative)", async () => {
  await scenario(ALL, async () => {
    const d = await analyseDomains();
    assert.deepEqual(ids(d, "flow-run-as-system-protected"), ["f1", "f3"]);
    const f1 = d.findings.find(
      (f) => f.rule === "flow-run-as-system-protected" && f.ref.sys_id === "f1",
    );
    assert.equal(f1.severity, "warn");
    assert.equal(f1.ref.artifactType, "flow");
    assert.deepEqual(
      f1.details.tables.map((t) => t.table),
      ["sys_user_has_role"],
    );
    assert.equal(d.rules["flow-run-as-system-protected"].scanned, 3);
  });
});

test("flow-draft-differs: latest != master (positive) vs equal or unpublished (negative)", async () => {
  await scenario(ALL, async () => {
    const d = await analyseDomains();
    assert.deepEqual(ids(d, "flow-draft-differs"), ["f1"]);
    assert.ok(d.caveats.some((c) => /draft-differs/.test(c)));
  });
});

test("flow-integration-no-error-handling: unguarded REST (name / step type) vs inside Try or non-integration", async () => {
  await scenario(ALL, async () => {
    const d = await analyseDomains();
    assert.deepEqual(ids(d, "flow-integration-no-error-handling"), [
      "f1",
      "f3",
    ]);
  });
});

test("flow-long-wait: 2 days (positive) vs 1 hour (negative)", async () => {
  await scenario(ALL, async () => {
    const d = await analyseDomains();
    assert.deepEqual(ids(d, "flow-long-wait"), ["f1"]);
    const f = d.findings.find((x) => x.rule === "flow-long-wait");
    assert.equal(f.details.seconds, 172800);
  });
});

test("flow-unused-subflow / flow-unused-action: no calling step (positive) vs called (negative)", async () => {
  await scenario(ALL, async (calls) => {
    const d = await analyseDomains();
    assert.deepEqual(ids(d, "flow-unused-subflow"), ["sf2"]);
    assert.deepEqual(ids(d, "flow-unused-action"), ["a_dead"]);
    const sub = d.findings.find((f) => f.rule === "flow-unused-subflow");
    assert.equal(sub.ref.artifactType, "subflow");
    // Custom candidates only.
    const q = calls
      .map((c) => new URL(c.url))
      .filter((u) => u.pathname.endsWith("/sys_hub_flow"))
      .map((u) => u.searchParams.get("sysparm_query"))
      .find((x) => x.startsWith("type=subflow"));
    assert.match(q, /sys_scope\.scopeNOT LIKEsn_/);
  });
});

test("unused rules never report a candidate whose callers were capped", async () => {
  const many = Array.from({ length: DOMAIN_CHILD_MAX + 1 }, (_, i) => ({
    sys_id: `c${i}`,
    flow: "f1",
    subflow: "sf1",
  }));
  await scenario({ ...ALL, sys_hub_sub_flow_instance_v2: many }, async () => {
    const d = await analyseDomains();
    assert.deepEqual(ids(d, "flow-unused-subflow"), []);
    assert.equal(d.rules["flow-unused-subflow"].truncated, true);
  });
});

test("portal-public-data-widget: public or on a public page with GlideRecord / GlideAggregate vs Secure or private", async () => {
  await scenario(ALL, async () => {
    const d = await analyseDomains();
    assert.deepEqual(ids(d, "portal-public-data-widget"), ["w1", "w3"]);
    const w3 = d.findings.find(
      (f) => f.rule === "portal-public-data-widget" && f.ref.sys_id === "w3",
    );
    assert.deepEqual(w3.details.publicPages, ["p1-id"]);
  });
});

test("portal-orphan-widget: unplaced and unreferenced (positive) vs placed or embedded by id (negative)", async () => {
  await scenario(ALL, async () => {
    const d = await analyseDomains();
    assert.deepEqual(ids(d, "portal-orphan-widget"), ["w4"]);
  });
});

test("portal-orphan-page: unlinked (positive) vs portal / menu / route map / ?id= link (negative)", async () => {
  await scenario(ALL, async () => {
    const d = await analyseDomains();
    assert.deepEqual(ids(d, "portal-orphan-page"), ["p5"]);
    const f = d.findings.find((x) => x.rule === "portal-orphan-page");
    assert.equal(f.ref.name, "p5-id");
  });
});

test("portal-route-map-loop: a two-map cycle (positive) vs a chain and a cross-portal pair (negative)", async () => {
  await scenario(ALL, async () => {
    const d = await analyseDomains();
    const loops = d.findings.filter((f) => f.rule === "portal-route-map-loop");
    assert.equal(loops.length, 1);
    assert.deepEqual([...loops[0].details.maps].sort(), ["m1", "m2"]);
    assert.equal(loops[0].details.portal, undefined);
  });
});

test("routeLoops: a portal-specific map closes a loop with a global one; the lowest order wins", () => {
  const m = (sys_id, from, to, portals = "", order = "100") => ({
    sys_id,
    route_from_page: from,
    route_to_page: to,
    portals,
    order,
  });
  const loops = routeLoops([m("a", "x", "y", "px"), m("b", "y", "x")]);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].portal, "px");
  // A lower-order map from y leads away, so no loop.
  assert.deepEqual(
    routeLoops([
      m("a", "x", "y"),
      m("b", "y", "x", "", "200"),
      m("c", "y", "z", "", "50"),
    ]),
    [],
  );
  // A self-loop.
  assert.equal(routeLoops([m("s", "q", "q")]).length, 1);
});

test("workflow-migration-candidate: referenced by catalog items / SLAs (positive) vs none (negative)", async () => {
  await scenario(ALL, async () => {
    const d = await analyseDomains();
    assert.deepEqual(ids(d, "workflow-migration-candidate"), ["wf1", "wf2"]);
    const wf1 = d.findings.find((f) => f.ref.sys_id === "wf1");
    assert.equal(wf1.ref.table, "wf_workflow");
    assert.deepEqual(wf1.details.catalogItems, ["Laptop", "Phone"]);
    assert.equal(wf1.ref.name, "Old approval");
  });
  await scenario({ ...ALL, sc_cat_item: [], contract_sla: [] }, async () => {
    const d = await analyseDomains();
    assert.deepEqual(ids(d, "workflow-migration-candidate"), []);
    assert.equal(d.rules["workflow-migration-candidate"].available, true);
  });
});

test("uib-route-no-screen: a screen type with no screen or none at all (positive) vs a screen (negative)", async () => {
  await scenario(ALL, async (calls) => {
    const d = await analyseDomains({ limit: 10 });
    assert.deepEqual(ids(d, "uib-route-no-screen"), ["r2", "r3"]);
    const r2 = d.findings.find((f) => f.ref.sys_id === "r2");
    assert.equal(r2.domain, "uib");
    assert.equal(r2.severity, "warn");
    assert.equal(r2.ref.table, "sys_ux_app_route");
    assert.deepEqual(r2.details, { screenType: "st9", appConfig: "cfg" });
    assert.equal(d.rules["uib-route-no-screen"].scanned, 3);
    const routeReads = calls
      .map((c) => new URL(c.url))
      .filter((u) => u.pathname.endsWith("/sys_ux_app_route"));
    assert.equal(routeReads.length, 1);
    assert.equal(routeReads[0].searchParams.get("sysparm_limit"), "11");
    assert.match(
      routeReads[0].searchParams.get("sysparm_query"),
      /sys_scope\.scopeNOT LIKEsn_/,
    );
  });
});

test("uib-screen-no-applicability: warn when it shadows a later variant, info otherwise; audience screens are clean", async () => {
  await scenario(ALL, async () => {
    const d = await analyseDomains();
    assert.deepEqual(ids(d, "uib-screen-no-applicability"), ["sc1", "sc3"]);
    const by = (id) => d.findings.find((f) => f.ref.sys_id === id);
    assert.equal(by("sc1").severity, "warn");
    assert.equal(by("sc1").details.shadowedVariants, 1);
    assert.equal(by("sc3").severity, "info");
    assert.equal(by("sc3").details.shadowedVariants, 0);
  });
});

test("uib-data-broker-no-acl: brokers with no ux_data_broker ACL (positive) vs guarded (negative)", async () => {
  await scenario(ALL, async () => {
    const d = await analyseDomains();
    assert.deepEqual(ids(d, "uib-data-broker-no-acl"), ["b2", "b3"]);
    const b3 = d.findings.find((f) => f.ref.sys_id === "b3");
    assert.equal(b3.ref.artifactType, "uib_data_broker_scriptlet");
    assert.equal(b3.ref.table, "sys_ux_data_broker_scriptlet");
    assert.equal(d.rules["uib-data-broker-no-acl"].scanned, 3);
  });
  // One broker table unreadable: the other is still checked.
  await scenario(
    ALL,
    async () => {
      const d = await analyseDomains();
      assert.deepEqual(ids(d, "uib-data-broker-no-acl"), ["b2"]);
      assert.equal(d.rules["uib-data-broker-no-acl"].available, true);
    },
    { sys_ux_data_broker_scriptlet: 403 },
  );
});

// N-29: broker rows with the fields the new rules read.
const N29_BROKERS = {
  ...UIB_TABLES,
  sys_ux_data_broker_transform: [
    // Guarded (b1 ACL), mutates, queries without a check, has a schema.
    {
      sys_id: "b1",
      name: "Guarded transform",
      mutates_server_data: "true",
      properties: '[{"name":"table"}]',
      script:
        "function transform(input) {\n  var gr = new GlideRecord('incident');\n  gr.query();\n}",
    },
    // Mutates, no ACL; checks access; empty schema.
    {
      sys_id: "b2",
      name: "Open transform",
      mutates_server_data: "true",
      properties: "[]",
      script:
        "function transform(input) {\n  var gr = new GlideRecord('incident');\n  if (!gr.canWrite()) return;\n}",
    },
  ],
  sys_ux_data_broker_scriptlet: [
    { sys_id: "b3", name: "Open scriptlet", properties: "" },
  ],
  sys_ux_data_broker_rest: [
    {
      sys_id: "b4",
      name: "REST writer",
      mutates_server_data: "true",
      properties: '[{"name":"id"}]',
    },
    { sys_id: "b5", name: "REST reader", mutates_server_data: "false" },
  ],
  sys_ux_data_broker_graphql: [
    {
      sys_id: "b6",
      name: "Graph",
      mutates_server_data: "false",
      properties: "{}",
    },
  ],
};

test("N-29 broker rules: mutates-no-acl (error, replaces no-acl), GlideRecord without a check, no input schema", async () => {
  await scenario(N29_BROKERS, async () => {
    const d = await analyseDomains();
    // b2 (transform) and b4 (REST) mutate with no ACL: the error rule, and
    // b2 is no longer reported as uib-data-broker-no-acl.
    assert.deepEqual(ids(d, "uib-broker-mutates-no-acl"), ["b2", "b4"]);
    assert.deepEqual(ids(d, "uib-data-broker-no-acl"), ["b3"]);
    const b4 = d.findings.find(
      (f) => f.rule === "uib-broker-mutates-no-acl" && f.ref.sys_id === "b4",
    );
    assert.equal(b4.severity, "error");
    assert.equal(b4.ref.artifactType, "uib_data_broker_rest");
    assert.equal(b4.details.kind, "rest");
    // REST / GraphQL brokers do not join the transform / scriptlet rule.
    assert.equal(d.rules["uib-data-broker-no-acl"].scanned, 3);
    assert.equal(d.rules["uib-broker-mutates-no-acl"].scanned, 6);
    // b1 queries and never checks; b2 checks canWrite().
    assert.deepEqual(ids(d, "uib-transform-gliderecord-no-acl-check"), ["b1"]);
    const gr = d.findings.find(
      (f) => f.rule === "uib-transform-gliderecord-no-acl-check",
    );
    assert.equal(gr.severity, "warn");
    assert.equal(gr.details.line, 2);
    assert.equal(d.rules["uib-transform-gliderecord-no-acl-check"].scanned, 2);
    // Empty "[]", "" and "{}" are no schema; b5 has no properties field
    // (unknown), so it is not reported.
    assert.deepEqual(ids(d, "uib-broker-no-input-schema"), ["b2", "b3", "b6"]);
    assert.equal(
      d.findings.find((f) => f.rule === "uib-broker-no-input-schema").severity,
      "info",
    );
  });
  // REST / GraphQL tables unreadable: they are skipped, the rules still run.
  await scenario(
    N29_BROKERS,
    async () => {
      const d = await analyseDomains();
      assert.equal(d.rules["uib-broker-mutates-no-acl"].available, true);
      assert.deepEqual(ids(d, "uib-broker-mutates-no-acl"), ["b2"]);
      assert.deepEqual(ids(d, "uib-broker-no-input-schema"), ["b2", "b3"]);
    },
    { sys_ux_data_broker_rest: 404, sys_ux_data_broker_graphql: 403 },
  );
  // No ACL table: both ACL rules unavailable, the pure rules still run.
  await scenario(
    N29_BROKERS,
    async () => {
      const d = await analyseDomains();
      assert.equal(d.rules["uib-broker-mutates-no-acl"].available, false);
      assert.equal(d.rules["uib-data-broker-no-acl"].available, false);
      assert.equal(
        d.rules["uib-transform-gliderecord-no-acl-check"].available,
        true,
      );
      assert.deepEqual(ids(d, "uib-transform-gliderecord-no-acl-check"), [
        "b1",
      ]);
    },
    { sys_security_acl: 404 },
  );
  // Neither transform nor scriptlet readable: every broker rule unavailable.
  await scenario(
    N29_BROKERS,
    async () => {
      const d = await analyseDomains();
      for (const rule of [
        "uib-broker-mutates-no-acl",
        "uib-transform-gliderecord-no-acl-check",
        "uib-broker-no-input-schema",
      ]) {
        assert.equal(d.rules[rule].available, false, rule);
        assert.match(
          d.rules[rule].unavailableReason,
          /sys_ux_data_broker_transform/,
        );
      }
    },
    { sys_ux_data_broker_transform: 403, sys_ux_data_broker_scriptlet: 403 },
  );
});

test("UI Builder rules degrade: unreadable tables disable their rule, capped confirming reads report nothing", async () => {
  await scenario(
    ALL,
    async () => {
      const d = await analyseDomains();
      assert.equal(d.rules["uib-route-no-screen"].available, false);
      assert.match(
        d.rules["uib-route-no-screen"].unavailableReason,
        /sys_ux_screen/,
      );
      assert.equal(d.rules["uib-screen-no-applicability"].available, false);
      assert.equal(d.rules["uib-data-broker-no-acl"].available, false);
      assert.match(
        d.rules["uib-data-broker-no-acl"].unavailableReason,
        /sys_security_acl/,
      );
      assert.equal(d.findings.filter((f) => f.domain === "uib").length, 0);
      // Other domains still run.
      assert.equal(d.rules["portal-route-map-loop"].available, true);
    },
    { sys_ux_screen: 403, sys_security_acl: 404 },
  );
  await scenario(
    ALL,
    async () => {
      const d = await analyseDomains();
      assert.equal(d.rules["uib-data-broker-no-acl"].available, false);
      assert.match(
        d.rules["uib-data-broker-no-acl"].unavailableReason,
        /sys_ux_data_broker_transform/,
      );
    },
    { sys_ux_data_broker_transform: 403, sys_ux_data_broker_scriptlet: 403 },
  );
  // A capped screen / ACL read cannot prove absence.
  const many = Array.from({ length: DOMAIN_CHILD_MAX + 1 }, (_, i) => ({
    sys_id: `x${i}`,
    screen_type: "st9",
    name: `b${i}`,
  }));
  await scenario(
    { ...UIB_TABLES, sys_ux_screen: () => many, sys_security_acl: () => many },
    async () => {
      const d = await analyseDomains();
      assert.deepEqual(ids(d, "uib-route-no-screen"), []);
      assert.equal(d.rules["uib-route-no-screen"].truncated, true);
      assert.deepEqual(ids(d, "uib-data-broker-no-acl"), []);
      assert.equal(d.rules["uib-data-broker-no-acl"].truncated, true);
    },
  );
});

test("a clean instance: every rule available, no findings", async () => {
  await scenario({}, async () => {
    const d = await analyseDomains();
    assert.equal(d.findingCount, 0);
    for (const [rule, r] of Object.entries(d.rules)) {
      assert.equal(r.available, true, rule);
    }
  });
});

test("unreadable tables make their rules unavailable, never a failure", async () => {
  await scenario(
    ALL,
    async () => {
      const d = await analyseDomains();
      for (const rule of [
        "flow-run-as-system-protected",
        "flow-draft-differs",
        "flow-unused-subflow",
        "flow-long-wait",
      ]) {
        assert.equal(d.rules[rule].available, false, rule);
        assert.match(d.rules[rule].unavailableReason, /sys_hub_flow/);
      }
      assert.equal(ids(d, "flow-draft-differs").length, 0);
      // Portal and workflow rules still run.
      assert.equal(d.rules["portal-route-map-loop"].available, true);
      assert.deepEqual(ids(d, "portal-orphan-page"), ["p5"]);
      assert.equal(d.rules["workflow-migration-candidate"].available, false);
      assert.ok(d.warnings.some((w) => /sys_hub_flow/.test(w)));
    },
    { sys_hub_flow: 403, sc_cat_item: 403, contract_sla: 404 },
  );
});

test("portal-orphan-page reports nothing when a link source is unreadable", async () => {
  await scenario(
    ALL,
    async () => {
      const d = await analyseDomains();
      assert.deepEqual(ids(d, "portal-orphan-page"), []);
      assert.equal(d.rules["portal-orphan-page"].available, true);
      assert.equal(d.rules["portal-orphan-page"].truncated, true);
    },
    { sp_portal: 403 },
  );
});

test("a capped candidate read marks the rule truncated", async () => {
  await scenario(ALL, async () => {
    const d = await analyseDomains({ limit: 1 });
    assert.equal(d.limit, 1);
    assert.equal(d.rules["flow-unused-subflow"].truncated, true);
    assert.equal(d.rules["flow-unused-subflow"].scanned, 1);
  });
});

test("durationSeconds: glide_duration, days + clock, ISO 8601, seconds; pills are unknown", () => {
  assert.equal(durationSeconds("1970-01-02 00:00:01"), 86401);
  assert.equal(durationSeconds("3 days 01:00:00"), 3 * 86400 + 3600);
  assert.equal(durationSeconds("12:30:00"), 45000);
  assert.equal(durationSeconds("P1DT2H"), 93600);
  assert.equal(durationSeconds("PT30M"), 1800);
  assert.equal(durationSeconds("P2W"), 1209600);
  assert.equal(durationSeconds("3600"), 3600);
  assert.equal(durationSeconds(90), 90);
  assert.equal(durationSeconds("{{trigger.duration}}"), undefined);
  assert.equal(durationSeconds("P"), undefined);
  assert.equal(durationSeconds("soon"), undefined);
  assert.equal(durationSeconds(null), undefined);
  assert.equal(durationSeconds(-1), undefined);
});
