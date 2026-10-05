// P-6 — servicenow_explain_artifact and the decoder framework: one golden
// per registry group that has types (project/SDK-PARITY.md §4), the tolerant
// `json` decoder, pluggable decoders, the M-6 size cap, the verified:false
// degrade path, and "an invalid JSON field never fails the call".
// Regenerate the goldens deliberately with `UPDATE_GOLDEN=1 npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  jsonDecoder,
  decodeField,
  getDecoder,
  registerDecoder,
} from "../build/core/artifacts/decoders.js";
import { explainArtifactFor } from "../build/api/explain-artifact.js";
import {
  ARTIFACT_GROUPS,
  ARTIFACT_TYPES,
  getArtifactType,
} from "../build/core/artifacts/registry.js";
import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS, registerAllTools } from "../build/mcp/registry.js";
import { currentRuntime } from "../build/core/runtime.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

baselineEnv();

const SDK_OFF = { SN_SDK_MANAGED_SCOPES: undefined, SN_SDK_PROJECT_DIRS: "" };
const APP_ID = "a".repeat(32);
const id = (c) => c.repeat(32);

const FIXTURES = path.join(import.meta.dirname, "fixtures", "explain");

/** Compare parsed JSON so prettier formatting of the golden does not matter. */
function golden(name, actual) {
  const file = path.join(FIXTURES, `${name}.json`);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  assert.deepEqual(actual, JSON.parse(readFileSync(file, "utf8")), name);
}

const explainSpec = ALL_TOOLS.find(
  (s) => s.name === "servicenow_explain_artifact",
);
const explain = (args) => runSpec(explainSpec, args);

/**
 * Table API mock: `tables[name]` is a record (primary read by sys_id) or an
 * array of rows (child / list reads). Unknown tables return no rows.
 */
function tableMock(tables) {
  return (url) => {
    const u = new URL(url);
    const m = u.pathname.match(/\/api\/now\/table\/([^/]+)(?:\/([^/]+))?$/);
    assert.ok(m, `unexpected request ${url}`);
    if (m[1] === "sys_scope") {
      return jsonResponse(200, {
        result: [{ sys_id: APP_ID, scope: "x_acme_app" }],
      });
    }
    const value = tables[m[1]];
    if (m[2]) {
      if (!value || Array.isArray(value)) {
        return jsonResponse(404, { error: { message: "No Record found" } });
      }
      return jsonResponse(200, { result: value });
    }
    return jsonResponse(200, { result: Array.isArray(value) ? value : [] });
  };
}

async function explainWith(tables, args, env = {}) {
  freshRuntime();
  return withEnv({ ...SDK_OFF, ...env }, () =>
    withFetch(tableMock(tables), async () => {
      const res = await explain(args);
      assert.equal(res.isError, undefined, res.content[0].text);
      assert.deepEqual(res.structuredContent, JSON.parse(res.content[0].text));
      return res.structuredContent;
    }),
  );
}

/** One fixture per §4 group that has registered types. */
const CASES = {
  core: {
    artifactType: "acl",
    tables: {
      sys_security_acl: {
        sys_id: id("1"),
        name: "incident.close_notes",
        operation: "write",
        type: "record",
        active: "true",
        admin_overrides: "true",
        condition: "active=true",
        script: "answer = gs.hasRole('itil');",
        description: "Only ITIL users may write close notes.",
        sys_scope: APP_ID,
        sys_updated_on: "2026-09-01 10:00:00",
      },
    },
  },
  server: {
    artifactType: "business_rule",
    tables: {
      sys_script: {
        sys_id: id("2"),
        name: "Set assignment group",
        collection: "incident",
        when: "before",
        order: "100",
        action_insert: "true",
        action_update: "true",
        action_delete: "false",
        condition: "current.assignment_group.nil()",
        active: "true",
        advanced: "true",
        script:
          "(function executeRule(current, previous) {\n  current.assignment_group = 'x';\n})(current, previous);",
        sys_scope: APP_ID,
      },
    },
  },
  "classic-ui": {
    artifactType: "ui_policy",
    tables: {
      sys_ui_policy: {
        sys_id: id("3"),
        short_description: "Hide close notes",
        table: "incident",
        active: "true",
        on_load: "true",
        reverse_if_false: "true",
        conditions: "state=1",
        run_scripts: "false",
        script_true: "",
        script_false: "",
        sys_scope: APP_ID,
      },
      sys_ui_policy_action: [
        {
          sys_id: id("4"),
          ui_policy: id("3"),
          field: "close_notes",
          visible: "false",
          mandatory: "ignore",
        },
      ],
    },
  },
  "next-experience": {
    artifactType: "workspace",
    tables: {
      sys_ux_page_registry: {
        sys_id: id("5"),
        title: "Acme Workspace",
        path: "acme",
        root_macroponent: id("6"),
        admin_panel: { value: id("7"), link: "https://x/api" },
        sys_scope: APP_ID,
      },
    },
  },
  uib: {
    artifactType: "uib_macroponent",
    tables: {
      sys_ux_macroponent: {
        sys_id: id("8"),
        name: "Acme home",
        category: "page",
        composition: '[{"elementId":"heading_1","definition":{"id":"abc"}}]',
        data: "{not json",
        props: '{"title":"Home",}',
        internal_event_mappings: "",
        state_properties: '"[{\\"name\\":\\"tab\\"}]"',
        sys_scope: APP_ID,
      },
      sys_ux_client_script: [
        {
          sys_id: id("9"),
          macroponent: id("8"),
          name: "onTabChange",
          script: "function handler({api}) { api.setState('tab', 1); }",
        },
      ],
    },
  },
  portal: {
    artifactType: "sp_page",
    tables: {
      sp_page: {
        sys_id: id("b"),
        id: "acme_home",
        title: "Acme home",
        public: "false",
        sys_scope: APP_ID,
      },
      sp_container: [
        { sys_id: id("c"), sp_page: id("b"), order: "1", width: "container" },
      ],
      sp_row: [{ sys_id: id("d"), sp_container: id("c"), order: "1" }],
      sp_column: [{ sys_id: id("e"), sp_row: id("d"), order: "1", size: "12" }],
      sp_instance: [
        {
          sys_id: id("f"),
          sp_column: id("e"),
          order: "1",
          sp_widget: id("0"),
          widget_parameters: '{"title":{"value":"Welcome"}}',
        },
        {
          sys_id: "0f".repeat(16),
          sp_column: id("e"),
          order: "2",
          sp_widget: id("0"),
          widget_parameters: "{'title': broken}",
        },
      ],
    },
  },
  flow: {
    artifactType: "flow",
    tables: {
      sys_hub_flow: {
        sys_id: "1a".repeat(16),
        name: "Acme onboarding",
        internal_name: "acme_onboarding",
        active: "true",
        status: "published",
        label_cache: '[{"name":"Created","label":"Trigger ➛ Created"}]',
        latest_snapshot: "2a".repeat(16),
        sys_scope: APP_ID,
      },
      sys_hub_trigger_instance: [
        {
          sys_id: "3a".repeat(16),
          flow: "1a".repeat(16),
          trigger_type: "record_create",
        },
      ],
      sys_hub_action_instance: [
        {
          sys_id: "4a".repeat(16),
          flow: "1a".repeat(16),
          order: "1",
          action_type: "5a".repeat(16),
          values: "H4sIAAAAAAAAA6tWSs7PS8tMLVKyUkpNzyjJTEsFAA==",
        },
      ],
    },
  },
  workflow: {
    artifactType: "workflow",
    tables: {
      wf_workflow: {
        sys_id: "1b".repeat(16),
        name: "Acme approval",
        active: "true",
        description: "Legacy approval workflow.",
        sys_scope: APP_ID,
      },
      wf_workflow_version: [
        {
          sys_id: "2b".repeat(16),
          workflow: "1b".repeat(16),
          name: "Acme approval",
          published: "true",
          table: "sc_req_item",
        },
      ],
      wf_activity: [
        {
          sys_id: "3b".repeat(16),
          workflow: "1b".repeat(16),
          name: "Begin",
          order: "1",
        },
        {
          sys_id: "4b".repeat(16),
          workflow: "1b".repeat(16),
          name: "Approval - User",
          order: "2",
        },
      ],
      wf_transition: [
        { sys_id: "5b".repeat(16), from: "3b".repeat(16), to: "4b".repeat(16) },
      ],
    },
  },
  catalog: {
    artifactType: "catalog_item",
    tables: {
      sc_cat_item: {
        sys_id: "1c".repeat(16),
        name: "Acme laptop",
        short_description: "Request a laptop.",
        active: "true",
        workflow: "1b".repeat(16),
        sys_scope: APP_ID,
      },
      item_option_new: [
        {
          sys_id: "2c".repeat(16),
          cat_item: "1c".repeat(16),
          name: "model",
          question_text: "Model",
          order: "100",
          type: "5",
        },
      ],
      catalog_script_client: [
        {
          sys_id: "3c".repeat(16),
          cat_item: "1c".repeat(16),
          name: "onLoad hint",
          type: "onLoad",
          script: "function onLoad() {}",
        },
      ],
    },
  },
  quality: {
    artifactType: "atf_test",
    tables: {
      sys_atf_test: {
        sys_id: "1d".repeat(16),
        name: "Acme laptop order",
        description: "Orders a laptop through the catalog.",
        active: "true",
        sys_scope: APP_ID,
      },
      sys_atf_step: [
        {
          sys_id: "2d".repeat(16),
          test: "1d".repeat(16),
          order: "1",
          step_config: "3d".repeat(16),
          description: "Open a catalog item",
        },
      ],
    },
  },
  ai: {
    artifactType: "ai_agent",
    tables: {
      sn_aia_agent: {
        sys_id: "1e".repeat(16),
        name: "Acme triage agent",
        description: "Routes incidents.",
        active: "true",
        sys_scope: APP_ID,
      },
      sn_aia_agent_tool_m2m: [
        {
          sys_id: "2e".repeat(16),
          agent: "1e".repeat(16),
          tool: "3e".repeat(16),
        },
      ],
      sn_aia_tool: [
        { sys_id: "3e".repeat(16), name: "Lookup incident", type: "script" },
      ],
    },
  },
  application: {
    artifactType: "application",
    tables: {
      sys_app: {
        sys_id: APP_ID,
        name: "Acme app",
        scope: "x_acme_app",
        version: "1.2.0",
        vendor: "Acme",
        active: "true",
        sys_scope: APP_ID,
      },
      sys_scope_dependency: [
        { sys_id: "2f".repeat(16), scope: APP_ID, dependency: "3f".repeat(16) },
      ],
    },
  },
  // N-8; O-5: verify on a live instance (queued for the O-2 corpus).
  reporting: {
    artifactType: "report",
    tables: {
      sys_report: {
        sys_id: "1a".repeat(16),
        title: "Open P1 incidents by group",
        table: "incident",
        type: "bar",
        field: "assignment_group",
        aggregate: "COUNT",
        filter: "active=true^priority=1",
        is_published: "true",
        report_source: "4a".repeat(16),
        sys_scope: APP_ID,
      },
      sys_report_users_groups: [
        {
          sys_id: "2a".repeat(16),
          report_id: "1a".repeat(16),
          group_id: "3a".repeat(16),
        },
      ],
    },
  },
};

test("every §4 group with registered types has an explain golden", () => {
  const withTypes = ARTIFACT_GROUPS.filter((g) =>
    ARTIFACT_TYPES.some((t) => t.group === g),
  );
  assert.deepEqual(Object.keys(CASES).sort(), [...withTypes].sort());
  for (const [group, c] of Object.entries(CASES)) {
    assert.equal(getArtifactType(c.artifactType).group, group);
  }
});

for (const [group, c] of Object.entries(CASES)) {
  test(`explain_artifact golden — ${group} (${c.artifactType})`, async () => {
    const t = getArtifactType(c.artifactType);
    const primary = c.tables[t.table];
    const body = await explainWith(c.tables, {
      artifactType: c.artifactType,
      sys_id: primary.sys_id.value ?? primary.sys_id,
    });
    golden(c.artifactType, body);
  });
}

test("golden shapes: when, references, decoded outcomes", async () => {
  const br = await explainWith(CASES.server.tables, {
    artifactType: "business_rule",
    sys_id: id("2"),
  });
  assert.deepEqual(br.when, {
    when: "before",
    order: "100",
    action_insert: "true",
    action_update: "true",
    action_delete: "false",
    condition: "current.assignment_group.nil()",
  });
  assert.match(br.summary, /^business_rule 'Set assignment group'/);
  assert.match(br.summary, /applies to incident; active; scope x_acme_app/);

  const ws = await explainWith(CASES["next-experience"].tables, {
    artifactType: "workspace",
    sys_id: id("5"),
  });
  assert.deepEqual(
    ws.references.map((r) => [r.field, r.type, r.sys_id]),
    [
      ["root_macroponent", "uib_macroponent", id("6")],
      ["admin_panel", "uib_app_config", id("7")],
    ],
  );

  const uib = await explainWith(CASES.uib.tables, {
    artifactType: "uib_macroponent",
    sys_id: id("8"),
  });
  const by = Object.fromEntries(uib.decoded.map((d) => [d.field, d]));
  assert.equal(by.composition.decoded, true);
  assert.equal(by.composition.via, undefined, "uib-composition ships (P-14)");
  assert.equal(by.data.decoded, false);
  assert.equal(by.data.raw, "{not json");
  assert.deepEqual(by.props.value, { title: "Home" });
  assert.deepEqual(by.state_properties.value, [{ name: "tab" }]);
  assert.equal(by.internal_event_mappings, undefined, "empty fields skipped");
  assert.equal(uib.fields.data, undefined, "JSON fields live in decoded");
  assert.match(uib.summary, /3\/4 JSON field\(s\) decoded/);
});

test("an invalid JSON field never fails the call", async () => {
  const flow = await explainWith(CASES.flow.tables, {
    artifactType: "flow",
    sys_id: "1a".repeat(16),
  });
  const values = flow.decoded.find((d) => d.field === "values");
  assert.equal(values.source, "sys_hub_action_instance");
  assert.equal(values.decoded, false);
  assert.equal(values.decoder, "flow-values");
  assert.equal(values.via, undefined);
  assert.match(values.reason, /did not inflate: .* \d+ bytes returned raw\./);
  assert.equal(values.raw, CASES.flow.tables.sys_hub_action_instance[0].values);

  const portal = await explainWith(CASES.portal.tables, {
    artifactType: "sp_page",
    sys_id: id("b"),
  });
  assert.deepEqual(
    portal.decoded.map((d) => d.decoded),
    [true, false],
  );
  assert.equal(
    portal.references.filter((r) => r.table === "sp_widget").length,
    2,
  );
  assert.deepEqual(portal.references[0].from, {
    table: "sp_instance",
    sys_id: id("f"),
  });
});

test("json decoder is tolerant and never throws", () => {
  const ok = (raw) => {
    const r = jsonDecoder.decode(raw);
    assert.equal(r.decoded, true, raw);
    return r.value;
  };
  assert.deepEqual(ok('﻿  {"a":1}  '), { a: 1 });
  assert.deepEqual(ok('{"a":[1,2,],}'), { a: [1, 2] });
  assert.deepEqual(ok('{"a":",}","b":[1,\n]}'), { a: ",}", b: [1] });
  assert.deepEqual(ok('{"a":"\\",]","b":1,}'), { a: '",]', b: 1 });
  assert.deepEqual(ok('"{\\"x\\":true}"'), { x: true });
  assert.equal(ok('"{not json"'), "{not json");
  assert.equal(ok('"plain"'), "plain");
  assert.equal(ok("   "), null);
  assert.equal(ok("42"), 42);
  for (const bad of ["{a:1}", "[1,2", "undefined", "{'a': 1}"]) {
    assert.deepEqual(jsonDecoder.decode(bad), {
      decoded: false,
      reason: "Not valid JSON.",
    });
  }
});

test("decodeField: fallback to json, pluggable decoders, throwing decoder", () => {
  assert.equal(getDecoder("json"), jsonDecoder);
  // flow-values ships with P-10 and uib-composition with P-14; an id with no
  // implementation (a future domain) falls back to json.
  assert.equal(getDecoder("flow-values").id, "flow-values");
  assert.deepEqual(decodeField("flow-values", "[1]"), {
    decoded: true,
    value: [1],
    decoder: "flow-values",
  });
  assert.equal(getDecoder("uib-composition").id, "uib-composition");
  assert.equal(getDecoder("future-domain"), undefined);
  assert.deepEqual(decodeField("future-domain", "[1]"), {
    decoded: true,
    value: [1],
    decoder: "future-domain",
    via: "json",
  });
  assert.match(
    decodeField("future-domain", "{x").reason,
    /'future-domain' decoder is not available yet/,
  );
  assert.deepEqual(decodeField("json", "nope"), {
    decoded: false,
    reason: "Not valid JSON.",
    decoder: "json",
  });

  const shipped = getDecoder("uib-composition");
  const restore = registerDecoder({
    id: "uib-composition",
    decode: (raw) => ({ decoded: true, value: { length: raw.length } }),
  });
  try {
    assert.deepEqual(decodeField("uib-composition", "abc"), {
      decoded: true,
      value: { length: 3 },
      decoder: "uib-composition",
    });
  } finally {
    restore();
  }
  assert.equal(getDecoder("uib-composition"), shipped);
  const restoreNew = registerDecoder({
    id: "future-domain",
    decode: () => ({ decoded: true, value: 1 }),
  });
  restoreNew();
  assert.equal(getDecoder("future-domain"), undefined);

  const restoreThrow = registerDecoder({
    id: "json",
    decode: () => {
      throw new Error("boom");
    },
  });
  try {
    assert.deepEqual(decodeField("json", "{}"), {
      decoded: false,
      reason: "boom",
      decoder: "json",
    });
  } finally {
    restoreThrow();
  }
  assert.equal(getDecoder("json"), jsonDecoder);
});

test("a registered decoder is used by explain_artifact", async () => {
  const restore = registerDecoder({
    id: "flow-values",
    decode: () => ({ decoded: true, value: { inputs: [] } }),
  });
  try {
    const flow = await explainWith(CASES.flow.tables, {
      artifactType: "flow",
      sys_id: "1a".repeat(16),
    });
    const values = flow.decoded.find((d) => d.field === "values");
    assert.deepEqual(values.value, { inputs: [] });
    assert.equal(values.via, undefined);
  } finally {
    restore();
  }
});

test("output is size-capped to the SN_MAX_RESULT_CHARS budget", async () => {
  const big = "x".repeat(5000);
  const bigJson = JSON.stringify({ blob: "y".repeat(5000) });
  const tables = {
    sys_ux_macroponent: {
      sys_id: id("8"),
      name: "Big",
      category: big,
      props: bigJson,
      data: `{${big}`,
      sys_scope: APP_ID,
    },
    sys_ux_client_script: Array.from({ length: 40 }, (_, i) => ({
      sys_id: String(i).padStart(32, "0"),
      macroponent: id("8"),
      name: `s${i}`,
      script: "z".repeat(400),
    })),
  };
  const body = await explainWith(
    tables,
    { artifactType: "uib_macroponent", sys_id: id("8") },
    { SN_MAX_RESULT_CHARS: "10000" },
  );
  // Per-value cap: max(500, 10000 / 20) = 500.
  assert.deepEqual(body.truncatedFields, ["category"]);
  assert.equal(body.fields.category.length, 500);
  const props = body.decoded.find((d) => d.field === "props");
  assert.equal(props.decoded, true);
  assert.equal(props.truncated, true);
  assert.equal(props.chars, bigJson.length);
  assert.equal(props.preview.length, 500);
  assert.equal(props.value, undefined);
  const data = body.decoded.find((d) => d.field === "data");
  assert.equal(data.decoded, false);
  assert.equal(data.truncated, true);
  assert.equal(data.raw.length, 500);
  const [scripts] = body.children;
  assert.equal(scripts.count, 40);
  assert.ok(scripts.omitted > 0, "the budget leaves rows out");
  assert.equal(scripts.items.length + scripts.omitted, 40);
  assert.ok(JSON.stringify(body).length < 12_000);
});

test("an unreadable unverified type degrades instead of failing", async () => {
  freshRuntime();
  await withEnv(SDK_OFF, () =>
    withFetch(
      () => jsonResponse(400, { error: { message: "Invalid table" } }),
      async () => {
        const res = await explain({
          artifactType: "workflow",
          sys_id: id("1"),
        });
        assert.equal(res.isError, undefined);
        const body = res.structuredContent;
        assert.equal(body.verified, false);
        assert.ok(body.caveat);
        assert.equal(body.summary, "workflow (wf_workflow) could not be read.");
        assert.equal(body.when, null);
        assert.deepEqual(body.fields, {});
        assert.deepEqual(body.children, []);
        assert.deepEqual(body.references, []);
        assert.deepEqual(body.decoded, []);
      },
    ),
  );
});

test("a missing record of a verified type is an error", async () => {
  freshRuntime();
  await withEnv(SDK_OFF, () =>
    withFetch(
      () => jsonResponse(404, { error: { message: "No Record found" } }),
      async () => {
        const res = await explain({ artifactType: "acl", sys_id: id("1") });
        assert.equal(res.isError, true);
      },
    ),
  );
});

test("explainArtifactFor honours descriptor whenFields", async () => {
  freshRuntime();
  const t = getArtifactType("client_script");
  assert.deepEqual(t.whenFields, ["type", "field", "ui_type", "condition"]);
  await withEnv(SDK_OFF, () =>
    withFetch(
      tableMock({
        [t.table]: {
          sys_id: id("1"),
          name: "Warn on change",
          table: "incident",
          type: "onChange",
          field: "priority",
          ui_type: "0",
          order: "100",
          script: "function onChange() {}",
        },
      }),
      async () => {
        const body = await explainArtifactFor(t, { sys_id: id("1") });
        assert.deepEqual(body.when, {
          type: "onChange",
          field: "priority",
          ui_type: "0",
        });
      },
    ),
  );
});

test("MCP round trip: explain_artifact output validates against its schema", async () => {
  freshRuntime();
  await withEnv({ ...SDK_OFF, SN_TOOL_PACKAGES: "artifacts" }, async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    registerAllTools(server, currentRuntime());
    const client = new Client({ name: "c", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const { tools } = await client.listTools();
      const spec = tools.find((t) => t.name === "servicenow_explain_artifact");
      assert.ok(spec.outputSchema);
      assert.equal(spec.annotations.readOnlyHint, true);
      await withFetch(tableMock(CASES.portal.tables), async () => {
        const res = await client.callTool({
          name: "servicenow_explain_artifact",
          arguments: { artifactType: "sp_page", sys_id: id("b") },
        });
        assert.equal(res.isError, undefined);
        assert.equal(res.structuredContent.children.length, 4);
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
