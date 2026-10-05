import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { generateErDiagram, generateTableFlow } from "../build/api/diagrams.js";
import { traceTableEvent } from "../build/api/flows.js";
import { whereUsed } from "../build/api/whereused.js";
import { clearSchemaCache } from "../build/core/cache.js";
import { ARTIFACT_TYPES } from "../build/core/artifacts/registry.js";
import {
  assertMetadataUrl,
  baselineEnv,
  jsonResponse,
  withMetadataFetch,
} from "./helpers.js";
import { lintMermaid } from "./mermaid-lint.js";

/**
 * Golden outputs of the deterministic generators (S-14). The default calls of
 * the ER and table-flow generators — and the trace / where-used graphs that
 * share the Mermaid primitives — must stay byte-identical across refactors.
 * Regenerate deliberately with `UPDATE_GOLDEN=1 npm test`.
 */

baselineEnv();
beforeEach(() => clearSchemaCache());

const FIXTURES = path.join(import.meta.dirname, "fixtures", "docs");

function golden(name, actual) {
  const file = path.join(FIXTURES, name);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, actual.endsWith("\n") ? actual : `${actual}\n`);
    return;
  }
  const expected = readFileSync(file, "utf8");
  assert.equal(`${actual}\n`.replace(/\n\n$/, "\n"), expected, name);
}

const fetchMeta = withMetadataFetch;

const tableOf = (url) => {
  const m = /\/api\/now\/table\/([^/?]+)/.exec(url);
  return m ? m[1] : "";
};
const queryOf = (url) =>
  new URL(url, "https://x").searchParams.get("sysparm_query") || "";

const chainResponse = (q) => {
  if (q === "name=incident")
    return jsonResponse(200, {
      result: [{ name: "incident", "super_class.name": "task" }],
    });
  if (q === "name=task")
    return jsonResponse(200, {
      result: [{ name: "task", "super_class.name": "" }],
    });
  return jsonResponse(200, { result: [] });
};

/** incident → task dictionary, with a child override of `number`. */
const CHAIN_DICTIONARY = [
  { element: "sys_id", internal_type: "GUID", name: "task", mandatory: "true" },
  { element: "number", internal_type: "string", name: "task" },
  { element: "number", internal_type: "string", name: "incident" },
  {
    element: "assigned_to",
    internal_type: "reference",
    reference: "sys_user",
    name: "task",
  },
  {
    element: "short_description",
    internal_type: "string",
    name: "task",
    mandatory: "true",
  },
  {
    element: "caller_id",
    internal_type: "reference",
    reference: "sys_user",
    name: "incident",
    mandatory: "true",
  },
  { element: "category", internal_type: "choice", name: "incident" },
];

const erChainFetch = (url) => {
  const t = tableOf(url);
  if (t === "sys_db_object") return chainResponse(queryOf(url));
  if (t === "sys_dictionary") {
    const q = queryOf(url);
    if (/^nameINincident,task\^/.test(q) || /^nameINtask\^/.test(q)) {
      const names = /^nameIN([^^]+)/.exec(q)[1].split(",");
      return jsonResponse(200, {
        result: CHAIN_DICTIONARY.filter((r) => names.includes(r.name)),
      });
    }
    return jsonResponse(200, { result: [] });
  }
  throw new Error("unexpected table " + t);
};

test("golden: default ER diagram for the single-table fixture", async () => {
  await fetchMeta(
    (url) => {
      if (tableOf(url) === "sys_db_object")
        return jsonResponse(200, { result: [] });
      return jsonResponse(200, {
        result: [
          { element: "number", internal_type: "string", reference: "" },
          {
            element: "caller_id",
            internal_type: "reference",
            reference: "sys_user",
          },
        ],
      });
    },
    async () => {
      const { mermaid } = await generateErDiagram(["incident"]);
      golden("er-incident.mmd", mermaid);
      lintMermaid(mermaid);
    },
  );
});

test("golden: default ER diagram over an inheritance chain", async () => {
  await fetchMeta(erChainFetch, async () => {
    const { mermaid } = await generateErDiagram(["incident"]);
    golden("er-incident-chain.mmd", mermaid);
    lintMermaid(mermaid);
  });
});

const flowRules = (rules) => (url) => {
  const t = tableOf(url);
  if (t === "sys_db_object") return chainResponse(queryOf(url));
  if (t === "sys_script") return jsonResponse(200, { result: rules });
  throw new Error("unexpected table " + t);
};

const OWN_RULES = [
  {
    sys_id: "1",
    name: "Validate",
    when: "before",
    order: "100",
    collection: "incident",
    global: "false",
  },
  {
    sys_id: "2",
    name: "Notify",
    when: "after",
    order: "200",
    collection: "incident",
    global: "false",
  },
];

const LANE_RULES = [
  {
    sys_id: "d1",
    name: "Load form hints",
    when: "display",
    order: "10",
    collection: "incident",
    global: "false",
  },
  {
    sys_id: "t1",
    name: "Task SLA",
    when: "before",
    order: "50",
    collection: "task",
    global: "false",
  },
  {
    sys_id: "i1",
    name: "Incident defaults",
    when: "before",
    order: "100",
    collection: "incident",
    global: "false",
  },
  {
    sys_id: "g1",
    name: "Global audit",
    when: "after",
    order: "150",
    collection: "global",
    global: "true",
  },
  {
    sys_id: "i2",
    name: "Notify",
    when: "after",
    order: "200",
    collection: "incident",
    global: "false",
  },
  {
    sys_id: "a1",
    name: "Sync to CMDB",
    when: "async",
    order: "",
    collection: "incident",
    global: "false",
  },
];

test("golden: default table flow with own rules only", async () => {
  await fetchMeta(flowRules(OWN_RULES), async () => {
    const { mermaid } = await generateTableFlow("incident");
    golden("flow-incident.mmd", mermaid);
    lintMermaid(mermaid);
  });
});

test("golden: default table flow with inherited and global lanes", async () => {
  await fetchMeta(flowRules(LANE_RULES), async () => {
    const { mermaid } = await generateTableFlow("incident");
    golden("flow-incident-lanes.mmd", mermaid);
    lintMermaid(mermaid);
  });
});

const traceFetch = (url) => {
  const table = tableOf(url);
  const q = queryOf(url);
  if (table === "sys_db_object") return chainResponse(q);
  if (table === "sys_script") {
    const when = /when=(\w+)/.exec(q)?.[1];
    return jsonResponse(200, {
      result: LANE_RULES.filter((r) => r.when === when),
    });
  }
  if (table === "sys_hub_trigger_instance")
    return jsonResponse(200, {
      result: [
        {
          flow: "f1",
          "flow.name": "Incident SLA",
          table_name: "incident",
          trigger_type: "record_update",
        },
      ],
    });
  if (table === "wf_workflow") return jsonResponse(200, { result: [] });
  if (table === "sysevent_email_action")
    return jsonResponse(200, {
      result: [
        {
          sys_id: "n1",
          name: "Incident assigned",
          condition: "",
          collection: "incident",
          action_insert: "false",
          action_update: "true",
        },
      ],
    });
  throw new Error("unexpected table " + table);
};

test("golden: trace_table_event graph", async () => {
  await fetchMeta(traceFetch, async () => {
    const trace = await traceTableEvent("incident", "update");
    golden("trace-incident-update.mmd", trace.mermaid);
    lintMermaid(trace.mermaid);
  });
});

test("golden: where-used graph", async () => {
  await fetchMeta(
    (url) => {
      const seg = new URL(url).pathname.split("/").pop();
      if (seg === "sys_script")
        return jsonResponse(200, {
          result: [{ sys_id: "br1", name: "BR One", script: "noop" }],
        });
      return jsonResponse(200, { result: [] });
    },
    async () => {
      const r = await whereUsed("table", "incident", { mermaid: true });
      golden("whereused-incident.mmd", r.mermaid);
      lintMermaid(r.mermaid);
    },
  );
});

test("golden: ER diagram with columns / max_columns / depth", async () => {
  await fetchMeta(erChainFetch, async () => {
    const own = await generateErDiagram(["incident"], { columns: "own" });
    golden("er-incident-own.mmd", own.mermaid);
    lintMermaid(own.mermaid);

    const keys = await generateErDiagram(["incident"], {
      columns: "keys",
      depth: 1,
    });
    golden("er-incident-keys-depth1.mmd", keys.mermaid);
    lintMermaid(keys.mermaid);
    assert.deepEqual(keys.added, ["sys_user"]);

    const folded = await generateErDiagram(["incident"], { max_columns: 2 });
    golden("er-incident-max2.mmd", folded.mermaid);
    lintMermaid(folded.mermaid);
  });
});

test("golden: table flow for one operation", async () => {
  await fetchMeta(traceFetch, async () => {
    const flow = await generateTableFlow("incident", { operation: "update" });
    assert.equal(flow.operation, "update");
    golden("flow-incident-update.mmd", flow.mermaid);
    lintMermaid(flow.mermaid);
  });
});

/** One row per S-5 lane table, answered on top of the trace fixture. */
const S5_LANES = {
  sys_transform_map: [
    { sys_id: "t1", name: "Legacy import", source_table: "u_legacy" },
  ],
  sysauto_script: [
    { sys_id: "j1", name: "Nightly cleanup", run_type: "daily" },
  ],
  sys_script_client: [
    { sys_id: "c1", name: "Form setup", type: "onLoad", table: "incident" },
  ],
  sys_ui_policy: [
    {
      sys_id: "u1",
      short_description: "Show caller",
      table: "task",
      inherit: "true",
      order: "100",
    },
  ],
  sys_data_policy2: [
    { sys_id: "d1", short_description: "Close notes", model_table: "incident" },
  ],
  contract_sla: [
    { sys_id: "s1", name: "P1 resolution", collection: "incident" },
  ],
  sysevent_register: [{ event_name: "incident.assigned", table: "incident" }],
  sysevent_script_action: [
    { sys_id: "e1", name: "Log assignment", event_name: "incident.assigned" },
  ],
};

test("golden: table flow with every S-5 lane", async () => {
  const handler = (url) => {
    const rows = S5_LANES[tableOf(url)];
    return rows ? jsonResponse(200, { result: rows }) : traceFetch(url);
  };
  await fetchMeta(handler, async () => {
    const flow = await generateTableFlow("incident", {
      operation: "update",
      lanes: [
        "client",
        "data_policy",
        "sla",
        "event_script",
        "transform_map",
        "scheduled_job",
      ],
    });
    assert.deepEqual(flow.warnings, []);
    golden("flow-incident-update-lanes.mmd", flow.mermaid);
    lintMermaid(flow.mermaid);
  });
});

test("the allow-list guard rejects record-data reads", () => {
  assert.throws(
    () => assertMetadataUrl("https://x/api/now/table/incident?sysparm_limit=1"),
    /non-metadata table: incident/,
  );
  assert.throws(
    () => assertMetadataUrl("https://x/api/now/attachment/abc/file"),
    /non-table request/,
  );
  assertMetadataUrl("https://x/api/now/stats/sys_script");
});

test("ID-27: the allow-list covers every registry table and the S-3 / S-15 tables", () => {
  const registry = ARTIFACT_TYPES.flatMap((t) => [
    t.table,
    ...t.children.map((c) => c.table),
  ]);
  assert.ok(registry.length >= ARTIFACT_TYPES.length);
  // N-8: the report and Performance Analytics tables come from the registry.
  for (const table of ["sys_report", "pa_indicators", "pa_cubes", "pa_tabs"])
    assert.ok(registry.includes(table), table);
  const named = [
    "sys_security_acl_role",
    "sys_user_role",
    "sys_user_role_contains",
    "sys_ui_page",
    "sys_public",
    "sys_ws_definition",
    "sys_ws_operation",
    "sys_rest_message",
    "sys_properties",
    "sysevent_email_action",
    "sys_choice",
    "sc_catalog",
    "sc_category",
    "sc_cat_item",
    "item_option_new",
  ];
  for (const table of [...registry, ...named])
    assertMetadataUrl(`https://x/api/now/table/${table}?sysparm_limit=1`);
});

test("ID-27: a swallowed guard violation still fails withMetadataFetch", async () => {
  await assert.rejects(
    withMetadataFetch(
      () => jsonResponse(200, { result: [] }),
      async () => {
        // A collector that degrades on a fetch error would hide the throw.
        await globalThis
          .fetch("https://x/api/now/table/incident")
          .catch(() => undefined);
        return "degraded";
      },
    ),
    /non-metadata table: incident/,
  );
  assert.equal(
    await withMetadataFetch(
      () => jsonResponse(200, { result: [] }),
      () => "ok",
    ),
    "ok",
  );
});
