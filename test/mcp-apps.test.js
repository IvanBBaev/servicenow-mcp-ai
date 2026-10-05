import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../build/server.js";
import { currentRuntime } from "../build/core/runtime.js";
import {
  APP_VIEW_IDS,
  VIEW_CSP,
  VIEW_SCRIPT,
  escapeHtml,
  viewHtml,
} from "../build/mcp/apps-views.js";
import { MCP_APPS_EXTENSION, MCP_APPS_MIME } from "../build/mcp/apps.js";
import { baselineEnv, withEnv } from "./helpers.js";

/**
 * N-50 — MCP Apps views. Off (the default) the server surface is exactly the
 * one without the feature; on, the four ui:// views are listed and the tools
 * that have a view carry `_meta.ui.resourceUri` — for a client that declared
 * the extension only. The renderers are the shipped VIEW_SCRIPT, run in vm.
 * Regenerate the HTML snapshots deliberately with `UPDATE_GOLDEN=1 npm test`.
 */

baselineEnv();

const APPS_CAPS = {
  extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APPS_MIME] } },
};

/** Connect a client to a fresh server and serialise the whole surface. */
async function surface(env, capabilities = {}) {
  return withEnv({ SN_TOOL_PACKAGES: "all", ...env }, async () => {
    const server = buildMcpServer(currentRuntime());
    const client = new Client({ name: "t", version: "0" }, { capabilities });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    // The views' HTML is built at registration, so reads may follow later.
    surface.close = async () => {
      await client.close();
      await server.close();
    };
    return {
      capabilities: client.getServerCapabilities(),
      instructions: client.getInstructions(),
      tools: (await client.listTools()).tools,
      resources: (await client.listResources()).resources,
      templates: (await client.listResourceTemplates()).resourceTemplates,
      prompts: (await client.listPrompts()).prompts,
      read: (uri) => client.readResource({ uri }),
    };
  });
}

const serial = (s) => JSON.stringify({ ...s, read: undefined });
const isUi = (r) => r.uri.startsWith("ui://");

const PLAN_TOOLS = [
  "servicenow_batch",
  "servicenow_check_change_conflicts",
  "servicenow_create_change",
  "servicenow_create_ci",
  "servicenow_create_record",
  "servicenow_delete_attachment",
  "servicenow_delete_record",
  "servicenow_identify_reconcile",
  "servicenow_insert_import_set_row",
  "servicenow_order_catalog_item",
  "servicenow_revert_write",
  "servicenow_run_atf_suite",
  "servicenow_run_atf_test",
  "servicenow_send_email",
  "servicenow_set_property",
  "servicenow_update_change",
  "servicenow_update_ci",
  "servicenow_update_record",
  "servicenow_upload_attachment",
  "servicenow_upsert_artifact",
  "servicenow_upsert_record",
];
const MERMAID_TOOLS = [
  "servicenow_explain_portal",
  "servicenow_generate_er_diagram",
  "servicenow_generate_table_flow",
  "servicenow_get_artifact_dependencies",
  "servicenow_trace_table_event",
];

test("off (unset or 0): the surface is the one without the feature, even for a client that supports apps", async () => {
  const on = await surface({ SN_MCP_APPS: "1" }, APPS_CAPS);
  await surface.close();
  // The feature-less surface: the on one minus its links and its views.
  const stripped = serial({
    ...on,
    tools: on.tools.map((t) => ({ ...t, _meta: undefined })),
    resources: on.resources.filter((r) => !isUi(r)),
  });
  for (const value of [undefined, "0"]) {
    for (const caps of [{}, APPS_CAPS]) {
      const off = await surface({ SN_MCP_APPS: value }, caps);
      await surface.close();
      assert.ok(
        off.tools.every((t) => t._meta === undefined),
        "no _meta when off",
      );
      assert.ok(!off.resources.some(isUi), "no ui:// resource when off");
      assert.equal(serial(off), stripped, `SN_MCP_APPS=${value}`);
    }
  }
});

test("on: the four views are listed and readable as text/html;profile=mcp-app", async () => {
  const on = await surface({ SN_MCP_APPS: "1" }, APPS_CAPS);
  try {
    const ui = on.resources.filter(isUi);
    assert.deepEqual(
      ui.map((r) => r.uri),
      APP_VIEW_IDS.map((v) => `ui://servicenow-mcp/${v}`),
    );
    for (const r of ui) {
      assert.equal(r.mimeType, MCP_APPS_MIME);
      const { contents } = await on.read(r.uri);
      assert.equal(contents.length, 1);
      assert.equal(contents[0].uri, r.uri);
      assert.equal(contents[0].mimeType, MCP_APPS_MIME);
      assert.deepEqual(contents[0]._meta, { ui: { prefersBorder: true } });
      assert.match(contents[0].text, /^<!doctype html>/);
      assert.ok(contents[0].text.includes(`content="${VIEW_CSP}"`));
    }
  } finally {
    await surface.close();
  }
});

test("on: _meta.ui.resourceUri links exactly the plan, Mermaid, flow and UIB tools — for a capable client only", async () => {
  const on = await surface({ SN_MCP_APPS: "1" }, APPS_CAPS);
  await surface.close();
  const links = Object.fromEntries(
    on.tools
      .filter((t) => t._meta)
      .map((t) => [t.name, t._meta.ui.resourceUri]),
  );
  const expected = {
    ...Object.fromEntries(
      PLAN_TOOLS.map((n) => [n, "ui://servicenow-mcp/plan-diff"]),
    ),
    ...Object.fromEntries(
      MERMAID_TOOLS.map((n) => [n, "ui://servicenow-mcp/mermaid"]),
    ),
    servicenow_explain_flow: "ui://servicenow-mcp/flow",
    servicenow_explain_ui_experience: "ui://servicenow-mcp/uib-tree",
  };
  assert.deepEqual(links, expected);
  for (const t of on.tools.filter((t) => t._meta))
    assert.deepEqual(Object.keys(t._meta), ["ui"]);

  // A client without the extension (or with another MIME type) gets no link.
  for (const caps of [
    {},
    { extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: ["text/html"] } } },
  ]) {
    const bare = await surface({ SN_MCP_APPS: "1" }, caps);
    await surface.close();
    assert.ok(bare.tools.every((t) => t._meta === undefined));
    assert.equal(bare.resources.filter(isUi).length, APP_VIEW_IDS.length);
  }
});

test("the view documents are self-contained: no external URL, no eval, a strict CSP", () => {
  assert.match(VIEW_CSP, /^default-src 'none';/);
  assert.match(VIEW_CSP, /script-src 'sha256-[A-Za-z0-9+/=]+';/);
  assert.match(VIEW_CSP, /connect-src 'none'/);
  assert.doesNotMatch(VIEW_CSP, /unsafe-(eval|inline)|\*|https?:/);
  for (const view of APP_VIEW_IDS) {
    const html = viewHtml(view, "T", "1.0.0");
    assert.doesNotMatch(html, /https?:|\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
    assert.doesNotMatch(html, /\b(src|href|action|srcset)\s*=/i);
    assert.doesNotMatch(html, /url\(|@import/i);
    assert.doesNotMatch(html, /\beval\s*\(|new Function|setTimeout\(\s*["']/);
    assert.equal(html.match(/<script>/g).length, 1);
    assert.ok(html.length < 24_000, `${view}: ${html.length} bytes`);
  }
  assert.equal(
    escapeHtml(`<a href="x">'&'</a>`),
    "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
  );
});

// ── The renderers (the exact VIEW_SCRIPT that ships) ─────────────────────────

const views = runInNewContext(
  `${VIEW_SCRIPT}\n;({ esc, render, parseMermaid })`,
);
/** A vm-realm value as a plain value of this realm (for deepEqual). */
const plain = (v) => JSON.parse(JSON.stringify(v));
const result = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});

const EVIL = `<script>alert(1)</script><img src=x onerror="alert('x')">&`;
/** Only the renderers' own tags (and class attributes) reach the markup. */
const TAGS = new Set(
  "table tr th td section h2 p pre ul li details summary b span div".split(" "),
);
const assertInert = (html) => {
  for (const [, tag, attrs] of html.matchAll(/<\/?([a-z0-9]+)([^>]*)>/gi)) {
    assert.ok(TAGS.has(tag), `unexpected <${tag}> in ${html}`);
    assert.match(attrs, /^(| class="[a-z ]+")$/, html);
  }
  assert.ok(html.includes("&lt;script&gt;"));
};

test("esc escapes every HTML metacharacter and serialises objects", () => {
  assert.equal(views.esc(EVIL).includes("<"), false);
  assert.equal(views.esc(`"'`), "&quot;&#39;");
  assert.equal(
    views.esc({ a: "<b>" }),
    "{&quot;a&quot;:&quot;&lt;b&gt;&quot;}",
  );
  assert.equal(views.esc(null), "");
  assert.equal(views.esc(0), "0");
});

test("every renderer escapes untrusted values", () => {
  assertInert(
    views.render(
      "plan-diff",
      result({
        mode: "plan",
        action: "update",
        table: EVIL,
        before: { short_description: EVIL, [EVIL]: "k" },
        after: { short_description: `${EVIL}2` },
        plan_token: EVIL,
        note: EVIL,
      }),
    ),
  );
  assertInert(
    views.render(
      "mermaid",
      result({
        mermaid: `flowchart LR\n  a["${EVIL.replaceAll('"', "'")}"] -->|"x"| b["<b>y</b>"]`,
        title: EVIL,
      }),
    ),
  );
  assertInert(
    views.render(
      "flow",
      result({
        kind: "flow",
        flow: { name: EVIL },
        trigger: { type: EVIL },
        steps: [
          { number: "1", kind: EVIL, name: EVIL, children: [{ name: EVIL }] },
        ],
        caveats: [EVIL],
      }),
    ),
  );
  assertInert(
    views.render(
      "uib-tree",
      result({
        experience: { title: EVIL, root_macroponent: "m1" },
        routes: [{ name: EVIL, screens: [{ name: EVIL, macroponent: "m1" }] }],
        macroponents: [
          {
            sys_id: "m1",
            name: EVIL,
            composition: {
              decoded: true,
              value: {
                elements: [{ label: EVIL, type: EVIL, component: EVIL }],
              },
            },
          },
        ],
      }),
    ),
  );
  // An error result and a non-JSON text result are shown as text, escaped.
  assertInert(
    views.render("flow", { isError: true, ...result({ error: EVIL }) }),
  );
  assertInert(
    views.render("mermaid", { content: [{ type: "text", text: EVIL }] }),
  );
  assert.match(views.render("flow", {}), /No result to show/);
});

test("parseMermaid reads the generators' node, edge and entity syntax", () => {
  const g = views.parseMermaid(
    'flowchart LR\n  a["Incident"] -->|"opened"| b[/"Rule: x"/]\n  b -.-> c[("Table")]\n',
  );
  assert.equal(g.type, "flowchart");
  assert.deepEqual(plain(g.labels), {
    a: "Incident",
    b: "Rule: x",
    c: "Table",
  });
  assert.deepEqual(plain(g.edges), [
    ["a", "opened", "b"],
    ["b", "", "c"],
  ]);
  const er = views.parseMermaid(
    'erDiagram\n  incident {\n    string number PK "Number"\n  }\n  incident }o--|| sys_user : "caller_id"\n',
  );
  assert.deepEqual(plain(er.entities.incident), [
    ["number", "string", "PK", "Number"],
  ]);
  assert.deepEqual(plain(er.edges), [["incident", "caller_id", "sys_user"]]);
});

// ── HTML snapshots, one per view ─────────────────────────────────────────────

const FIXTURES = path.join(import.meta.dirname, "fixtures", "apps");

function golden(name, actual) {
  const file = path.join(FIXTURES, name);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, `${actual}\n`);
    return;
  }
  assert.equal(`${actual}\n`, readFileSync(file, "utf8"), name);
}

const SAMPLES = {
  "plan-diff": {
    structuredContent: {
      mode: "plan",
      action: "update",
      table: "incident",
      sys_id: "a1b2c3",
      before: { short_description: "Printer down", state: "1", urgency: "2" },
      after: { state: "2", work_notes: "Picked up" },
      plan_token: "tok_123",
      plan_token_expires_at: "2026-10-05T12:00:00.000Z",
      note: "Re-run with apply:true and plan_token to execute.",
    },
  },
  mermaid: result({
    table: "incident",
    mermaid:
      'flowchart LR\n  t[("incident")]\n  br1[/"Before: Set priority"/]\n  t -->|"insert"| br1\n  br1 -.-> n1["Notify assignee"]',
    nodes: 3,
  }),
  flow: result({
    kind: "flow",
    flow: {
      name: "Incident escalation",
      internal_name: "incident_escalation",
      sys_id: "f1",
      status: "published",
      active: true,
    },
    trigger: {
      type: "record_updated",
      table: "incident",
      condition: "priority=1",
    },
    steps: [
      {
        number: "1",
        kind: "action",
        name: "Look up on-call",
        ref: { name: "Get On-Call" },
        callee: {
          kind: "subflow",
          name: "Notify",
          steps: [{ number: "1", kind: "action", name: "Send SMS" }],
        },
      },
      {
        number: "2",
        kind: "flow_logic",
        name: "If",
        comment: "only P1",
        children: [{ number: "2.1", kind: "action", name: "Create task" }],
      },
    ],
    inputs: [
      {
        element: "record",
        label: "Record",
        type: "reference",
        mandatory: true,
      },
    ],
    counts: { steps: 4 },
    caveats: ["Subflow inputs are not resolved."],
  }),
  "uib-tree": result({
    experience: {
      sys_id: "x1",
      title: "Agent Workspace",
      path: "now/agent",
      root_macroponent: "shell",
    },
    appConfig: { landing_path: "home" },
    routes: [
      {
        sys_id: "r1",
        name: "home",
        route_type: "home",
        screens: [
          {
            sys_id: "s1",
            name: "Home default",
            macroponent: "page1",
            applicability: "All",
          },
        ],
      },
    ],
    macroponents: [
      { sys_id: "shell", name: "Shell", category: "shell" },
      {
        sys_id: "page1",
        name: "Home page",
        composition: {
          decoded: true,
          value: {
            elements: [
              {
                elementId: "list1",
                label: "My work",
                type: "component",
                component: "now-record-list",
                slots: [
                  {
                    name: "header",
                    elements: [
                      {
                        elementId: "h1",
                        type: "component",
                        component: "now-heading",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
        data: {
          decoded: true,
          value: [
            {
              elementId: "lookup",
              label: "Lookup",
              type: "transform",
              broker: "b1",
            },
          ],
        },
      },
    ],
    dataBrokers: [
      {
        sys_id: "b1",
        name: "Lookup records",
        table: "sys_ux_data_broker_transform",
        acls: [{}],
      },
    ],
    counts: { routes: 1, screens: 1 },
  }),
};

for (const view of APP_VIEW_IDS) {
  test(`snapshot: ${view}`, () => {
    golden(`${view}.html`, views.render(view, SAMPLES[view]));
  });
}
