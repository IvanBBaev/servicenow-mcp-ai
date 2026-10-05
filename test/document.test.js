import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DOC_KINDS,
  aclMatrix,
  artifactColumns,
  INSTANCE_DOC_KINDS,
  INSTANCE_TARGETS_MAX,
  documentApp,
  documentInstance,
  documentSecurity,
  documentTable,
} from "../build/api/document.js";
import { runWithCall } from "../build/core/request-context.js";
import { ARTIFACT_TYPES } from "../build/core/artifacts/registry.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import { clearSchemaCache } from "../build/core/cache.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withMetadataFetch,
} from "./helpers.js";
import { lintMermaid } from "./mermaid-lint.js";
import { docsRead } from "../build/api/docs.js";

/**
 * S-15 document writers (ID-18 … ID-26): the `table`, `app` and `security`
 * kinds of the DOC_KINDS registry. Every read is mocked and must stay on the
 * metadata allow-list. Goldens live under test/fixtures/docs/writers/ —
 * regenerate deliberately with `UPDATE_GOLDENS=1 npm test` (UPDATE_GOLDEN=1
 * also works). The volatile frontmatter fields are masked before comparing.
 */

baselineEnv();
beforeEach(() => {
  freshRuntime();
  clearSchemaCache();
});

const GOLDENS = path.join(import.meta.dirname, "fixtures", "docs", "writers");
const UPDATE =
  process.env.UPDATE_GOLDENS === "1" || process.env.UPDATE_GOLDEN === "1";

/** Mask the per-run frontmatter fields (Markdown and JSON forms). */
function stripVolatile(text, fields = ["sn_generated_at", "sn_source_hash"]) {
  let out = text;
  for (const f of fields) {
    out = out
      .replace(new RegExp(`^${f}: .*$`, "gm"), `${f}: <masked>`)
      .replace(new RegExp(`"${f}": "[^"]*"`, "g"), `"${f}": "<masked>"`);
  }
  return out;
}

function golden(name, actual) {
  const file = path.join(GOLDENS, name);
  const text = actual.endsWith("\n") ? actual : `${actual}\n`;
  if (UPDATE) {
    mkdirSync(GOLDENS, { recursive: true });
    writeFileSync(file, text);
    return;
  }
  assert.equal(text, readFileSync(file, "utf8"), name);
}

const tempDocs = () => mkdtempSync(path.join(os.tmpdir(), "sn-document-"));

/** Every ```mermaid block of a document passes the Mermaid lint. */
function lintBlocks(markdown) {
  const blocks = [...markdown.matchAll(/```mermaid\n([\s\S]*?)```/g)];
  for (const [, body] of blocks) lintMermaid(body.trimEnd());
  return blocks.length;
}

/**
 * Route Table API reads by table. An entry is an array of rows, a number (an
 * HTTP status to fail with) or a function of the encoded query returning
 * either. Honours sysparm_limit / sysparm_offset and sends X-Total-Count.
 */
const router = (tables) => (url) => {
  const u = new URL(url);
  const m = /\/api\/now\/table\/([^/?]+)/.exec(u.pathname);
  if (!m) return jsonResponse(200, { result: { stats: { count: "0" } } });
  let entry = tables[m[1]];
  if (typeof entry === "function") {
    entry = entry(u.searchParams.get("sysparm_query") ?? "");
  }
  if (typeof entry === "number") {
    return jsonResponse(entry, { error: { message: `status ${entry}` } });
  }
  const rows = entry ?? [];
  const limit = Number(u.searchParams.get("sysparm_limit") ?? "10");
  const offset = Number(u.searchParams.get("sysparm_offset") ?? "0");
  return jsonResponse(
    200,
    { result: rows.slice(offset, offset + limit) },
    { "x-total-count": String(rows.length) },
  );
};

// ---------------------------------------------------------------------------
// table kind — incident
// ---------------------------------------------------------------------------

/** incident → task dictionary, with a child override of `number`. */
const CHAIN_DICTIONARY = [
  { element: "sys_id", internal_type: "GUID", name: "task", mandatory: "true" },
  {
    element: "number",
    internal_type: "string",
    name: "task",
    column_label: "Number",
  },
  {
    element: "number",
    internal_type: "string",
    name: "incident",
    column_label: "Number",
  },
  {
    element: "assigned_to",
    internal_type: "reference",
    reference: "sys_user",
    name: "task",
    column_label: "Assigned to",
  },
  {
    element: "short_description",
    internal_type: "string",
    name: "task",
    mandatory: "true",
    max_length: "160",
    column_label: "Short description",
  },
  {
    element: "caller_id",
    internal_type: "reference",
    reference: "sys_user",
    name: "incident",
    mandatory: "true",
    column_label: "Caller",
  },
  {
    element: "category",
    internal_type: "choice",
    name: "incident",
    choice: "1",
    default_value: "inquiry",
    column_label: "Category",
  },
];

const RULE = (sys_id, name, when, order) => ({
  sys_id,
  name,
  collection: "incident",
  when,
  order,
  active: "true",
  global: "false",
  action_insert: "true",
  action_update: when !== "display" ? "true" : "false",
  action_delete: "false",
  action_query: "false",
  condition: "",
  "sys_scope.scope": "global",
});

const incidentTables = (overrides = {}) => ({
  sys_db_object: (q) => {
    if (q === "name=incident")
      return [{ name: "incident", "super_class.name": "task" }];
    if (q === "name=task") return [{ name: "task", "super_class.name": "" }];
    return [];
  },
  sys_dictionary: (q) => {
    if (q.startsWith("reference=incident")) {
      return [
        {
          name: "incident_task",
          element: "incident",
          column_label: "Incident",
        },
        { name: "problem", element: "u_incident", column_label: "Incident" },
      ];
    }
    const names = /^nameIN([^^]+)/.exec(q)?.[1].split(",") ?? [];
    return CHAIN_DICTIONARY.filter((r) => names.includes(r.name));
  },
  sys_script: [
    RULE("br1", "Validate caller", "before", "100"),
    RULE("br2", "Notify assignee", "after", "200"),
    RULE("br3", "Sync to CMDB", "async", "300"),
    RULE("br4", "Show SLA", "display", "100"),
  ],
  sys_script_client: [
    {
      sys_id: "cs1",
      name: "Category onChange",
      table: "incident",
      type: "onChange",
      field: "category",
      active: "true",
      ui_type: "0",
    },
  ],
  sys_ui_policy: [
    {
      sys_id: "up1",
      short_description: "Caller mandatory on new",
      table: "incident",
      active: "true",
      order: "100",
      conditions: "",
    },
  ],
  sys_ui_action: 403,
  sys_security_acl: [
    {
      sys_id: "acl1",
      name: "incident",
      operation: "read",
      type: "record",
      active: "true",
      admin_overrides: "true",
      condition: "",
      script: "",
    },
    {
      sys_id: "acl2",
      name: "incident.caller_id",
      operation: "write",
      type: "record",
      active: "true",
      admin_overrides: "true",
      condition: "active=true",
      script: "",
    },
    {
      // Matched by nameLIKEincident but belongs to another table: filtered out.
      sys_id: "acl3",
      name: "incident_task",
      operation: "read",
      type: "record",
      active: "true",
      admin_overrides: "true",
      condition: "",
      script: "",
    },
  ],
  sys_security_acl_role: [
    { sys_security_acl: "acl1", "sys_user_role.name": "itil" },
    { sys_security_acl: "acl1", "sys_user_role.name": "sn_incident_read" },
    { sys_security_acl: "acl2", "sys_user_role.name": "itil" },
  ],
  ...overrides,
});

test("golden: incident table doc with write:false (own + inherited columns, logic, ACL, caveats)", async () => {
  await withMetadataFetch(router(incidentTables()), async () => {
    const r = await documentTable("incident", { write: false });
    assert.equal(r.kind, "table");
    assert.equal(r.path, "default/tables/incident.md");
    assert.equal(r.file, undefined, "write:false writes nothing");
    assert.ok(r.caveats >= 3);
    const md = r.markdown;
    assert.match(md, /### Own columns \(`incident`\)/);
    assert.match(md, /### Inherited from `task`/);
    for (const phase of ["before", "after", "async", "display"]) {
      assert.match(md, new RegExp(`\\| ${phase} \\|`), phase);
    }
    assert.match(md, /itil, sn_incident_read/);
    assert.doesNotMatch(md, /incident_task` \| read/);
    assert.match(md, /ui_action/);
    assert.match(md, /sn:manual:start purpose/);
    assert.ok(lintBlocks(md) >= 2, "ER and table-flow diagrams");
    golden("table-incident.md", md);
  });
});

test("table doc: an unreadable sys_security_acl_role becomes a caveat, not a failure", async () => {
  await withMetadataFetch(
    router(incidentTables({ sys_security_acl_role: 403 })),
    async () => {
      const r = await documentTable("incident", {
        write: false,
        diagrams: false,
      });
      assert.match(r.markdown, /sys_security_acl_role is not readable/);
      assert.doesNotMatch(r.markdown, /```mermaid/);
    },
  );
});

test("table doc: writes md + json, records the run, re-runs unchanged and keeps the manual block", async () => {
  const dir = tempDocs();
  await withEnv({ SN_DOCS_DIR: dir }, () =>
    withMetadataFetch(router(incidentTables()), async () => {
      const first = await documentTable("incident");
      assert.equal(first.status, "created");
      assert.equal(first.companion, "default/tables/incident.json");
      assert.equal(first.file, path.join(dir, "default/tables/incident.md"));
      const mdFile = path.join(dir, "default/tables/incident.md");
      const md = readFileSync(mdFile, "utf8");
      assert.match(md, /^sn_generator: servicenow_document_table$/m);
      assert.match(md, /^sn_kind: table$/m);
      assert.match(md, /^sn_generator_version: "?1"?$/m);
      golden("table-incident.written.md", stripVolatile(md));

      const json = JSON.parse(
        readFileSync(path.join(dir, "default/tables/incident.json"), "utf8"),
      );
      assert.equal(json.sn_generator, "servicenow_document_table");
      assert.equal(json.table, "incident");
      assert.deepEqual(json.chain, ["incident", "task"]);

      const index = JSON.parse(
        readFileSync(path.join(dir, "index.json"), "utf8"),
      );
      const run = index.runs.servicenow_document_table;
      assert.equal(run.profile, "default");
      assert.equal(run.partial, false);
      assert.equal(run.files, 2);
      assert.ok(run.finished_at);

      // Same metadata: nothing is rewritten, byte for byte.
      const again = await documentTable("incident");
      assert.equal(again.status, "unchanged");
      assert.equal(readFileSync(mdFile, "utf8"), md);

      // The owner fills the Purpose block; a regenerated doc keeps it.
      const edited = md.replace(
        /(<!-- sn:manual:start purpose -->\n)[\s\S]*?(<!-- sn:manual:end -->)/,
        "$1Incidents track unplanned service interruptions.\n$2",
      );
      assert.notEqual(edited, md);
      writeFileSync(mdFile, edited);
    }),
  );
  // Changed metadata (a new client script) regenerates the document.
  const changed = incidentTables();
  changed.sys_script_client = [
    ...changed.sys_script_client,
    {
      sys_id: "cs2",
      name: "Priority onLoad",
      table: "incident",
      type: "onLoad",
      active: "true",
      ui_type: "0",
    },
  ];
  await withEnv({ SN_DOCS_DIR: dir }, () =>
    withMetadataFetch(router(changed), async () => {
      const r = await documentTable("incident");
      assert.equal(r.status, "updated");
      const md = readFileSync(
        path.join(dir, "default/tables/incident.md"),
        "utf8",
      );
      assert.match(md, /Priority onLoad/);
      assert.match(md, /Incidents track unplanned service interruptions\./);
    }),
  );
});

test("table doc: two runs over the same metadata differ only in sn_generated_at", async () => {
  const outputs = [];
  for (let i = 0; i < 2; i++) {
    const dir = tempDocs();
    await withEnv({ SN_DOCS_DIR: dir }, () =>
      withMetadataFetch(router(incidentTables()), async () => {
        clearSchemaCache();
        await documentTable("incident");
        outputs.push(
          ["default/tables/incident.md", "default/tables/incident.json"].map(
            (f) => readFileSync(path.join(dir, f), "utf8"),
          ),
        );
      }),
    );
  }
  for (let f = 0; f < 2; f++) {
    assert.equal(
      stripVolatile(outputs[0][f], ["sn_generated_at"]),
      stripVolatile(outputs[1][f], ["sn_generated_at"]),
    );
  }
});

test("table doc: a name that cannot be a path is refused before any read", async () => {
  await withMetadataFetch(router({}), async (calls) => {
    await assert.rejects(
      documentTable("../incident", { write: false }),
      /cannot name a document/,
    );
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// app kind
// ---------------------------------------------------------------------------

const APP_ID = "a".repeat(32);

const appTables = () => ({
  sys_app: (q) =>
    q.startsWith("scope=x_acme")
      ? [
          {
            sys_id: APP_ID,
            name: "Acme Requests",
            scope: "x_acme",
            version: "1.2.0",
            vendor: "Acme",
            short_description: "Request intake",
          },
        ]
      : [],
  sys_db_object: (q) =>
    q.startsWith("sys_scope.scope=x_acme")
      ? [
          {
            name: "x_acme_request",
            label: "Request",
            "super_class.name": "task",
          },
          { name: "x_acme_step", label: "Step", "super_class.name": "" },
        ]
      : [],
  sys_dictionary: (q) => {
    const names = /^nameIN([^^]+)/.exec(q)?.[1].split(",") ?? [];
    return [
      {
        name: "x_acme_request",
        element: "u_owner",
        internal_type: "reference",
        reference: "sys_user",
      },
      {
        name: "x_acme_step",
        element: "u_request",
        internal_type: "reference",
        reference: "x_acme_request",
      },
    ].filter((r) => names.includes(r.name));
  },
  sys_script: [
    {
      sys_id: "b".repeat(32),
      name: "Default step order",
      collection: "x_acme_step",
      when: "before",
      order: "100",
      active: "true",
      "sys_scope.scope": "x_acme",
    },
  ],
  sys_script_include: [
    {
      sys_id: "c".repeat(32),
      name: "AcmeUtils",
      api_name: "x_acme.AcmeUtils",
      client_callable: "false",
      access: "package_private",
      active: "true",
      script: "var AcmeUtils = Class.create();",
      "sys_scope.scope": "x_acme",
    },
  ],
  sys_user_role: [
    {
      sys_id: "d".repeat(32),
      name: "x_acme.admin",
      elevated_privilege: "false",
      description: "Administers requests",
      "sys_scope.scope": "x_acme",
    },
  ],
  sys_properties: [
    {
      sys_id: "e".repeat(32),
      name: "x_acme.api_token",
      value: "hunter2",
      type: "password2",
      "sys_scope.scope": "x_acme",
    },
  ],
  // Unverified type: a 404 degrades instead of failing (gate O-5).
  sys_ui_page: 404,
  // Verified type the user cannot read: listed as unreadable.
  sys_script_client: 403,
});

test("golden: app doc with two tables, three artefact kinds, degraded and unreadable types", async () => {
  await withMetadataFetch(router(appTables()), async () => {
    const r = await documentApp("x_acme", { write: false });
    assert.equal(r.path, "default/apps/x_acme.md");
    const md = r.markdown;
    assert.match(md, /x_acme_request/);
    assert.match(md, /x_acme_step/);
    assert.match(md, /Default step order/);
    assert.match(md, /AcmeUtils/);
    assert.match(md, /x_acme\.admin/);
    assert.match(md, /## Not confirmed on this instance/);
    assert.match(md, /sys_ui_page/);
    assert.match(md, /client_script/);
    assert.doesNotMatch(md, /hunter2/, "property values are never documented");
    lintBlocks(md);
    golden("app-x_acme.md", md);
  });
});

test("app doc: the JSON companion carries app, tables, artefacts, degraded, unreadable", async () => {
  const dir = tempDocs();
  await withEnv({ SN_DOCS_DIR: dir }, () =>
    withMetadataFetch(router(appTables()), async () => {
      const r = await documentApp("x_acme");
      assert.equal(r.status, "created");
      const raw = readFileSync(
        path.join(dir, "default/apps/x_acme.json"),
        "utf8",
      );
      assert.doesNotMatch(raw, /hunter2/);
      const json = JSON.parse(raw);
      for (const key of [
        "app",
        "tables",
        "artefacts",
        "degraded",
        "unreadable",
      ]) {
        assert.ok(key in json, key);
      }
      assert.equal(json.app.scope, "x_acme");
      assert.deepEqual(
        json.tables.map((t) => t.name),
        ["x_acme_request", "x_acme_step"],
      );
      assert.ok(existsSync(path.join(dir, "default/apps/x_acme.md")));
    }),
  );
});

// --- P-21: detail (diagrams, dependency graph, lint summary) ---------------

const FLOW_ID = "f".repeat(32);
const PORTAL_ID = "9".repeat(32);

const appDetailTables = () => ({
  ...appTables(),
  sys_hub_flow: (q) =>
    q.includes("type=subflow")
      ? []
      : [
          {
            sys_id: FLOW_ID,
            name: "Route request",
            internal_name: "route_request",
            type: "flow",
            active: "true",
            status: "published",
            "sys_scope.scope": "x_acme",
          },
        ],
  sp_portal: [
    {
      sys_id: PORTAL_ID,
      title: "Acme portal",
      url_suffix: "acme",
      "sys_scope.scope": "x_acme",
    },
  ],
  sys_script_include: [
    {
      sys_id: "c".repeat(32),
      name: "AcmeUtils",
      api_name: "x_acme.AcmeUtils",
      active: "true",
      script:
        'var AcmeUtils = Class.create(); AcmeUtils.prototype = { x: function(){ eval("1"); return new x_acme.Helper(); } };',
      "sys_scope.scope": "x_acme",
    },
  ],
});

test("app doc detail: diagrams per flow and portal, a dependency graph and a lint summary; Mermaid parses; read_doc returns it (acceptance)", async () => {
  const dir = tempDocs();
  await withEnv({ SN_DOCS_DIR: dir }, () =>
    withMetadataFetch(router(appDetailTables()), async () => {
      const r = await documentApp("x_acme", { detail: true });
      assert.equal(r.status, "created");
      const { content: md } = await docsRead("apps/x_acme.md", {
        profile: "default",
      });
      assert.match(md, /## Diagrams/);
      assert.match(md, /### `flow` Route request/);
      assert.match(md, /### `sp_portal` Acme portal/);
      assert.match(md, /## Dependencies/);
      assert.match(md, /## Lint summary/);
      assert.match(md, /eval-usage/);
      assert.match(md, /## Cross-scope access/);
      assert.ok(lintBlocks(md) >= 3, "ER + flow + portal diagrams at least");
      const json = JSON.parse(
        readFileSync(path.join(dir, "default/apps/x_acme.json"), "utf8"),
      );
      assert.equal(json.detail.diagrams.length, 2);
      assert.ok(json.detail.lint.findingCount >= 1);
    }),
  );
});

test("app doc detail: a UI Builder experience gets its page map (P-14); a denied ui package is a caveat", async () => {
  const EXP_ID = "e".repeat(32);
  const tables = {
    ...appDetailTables(),
    sys_ux_page_registry: [
      {
        sys_id: EXP_ID,
        title: "Acme workspace",
        path: "acme",
        "sys_scope.scope": "x_acme",
      },
    ],
  };
  await withMetadataFetch(router(tables), async () => {
    const r = await documentApp("x_acme", { write: false, detail: true });
    const md = r.markdown;
    assert.match(md, /### `workspace` Acme workspace/);
    const block = md.slice(md.indexOf("### `workspace`"));
    assert.match(block, /```mermaid\nflowchart TD/);
    assert.doesNotMatch(md, /workspace Acme workspace: not drawn/);
  });
  await withEnv({ SN_PACKAGES_DENY: "ui" }, () =>
    withMetadataFetch(router(tables), async () => {
      const r = await documentApp("x_acme", { write: false, detail: true });
      assert.match(
        r.markdown,
        /Diagrams of workspace: the ui package is denied/,
      );
    }),
  );
});

test("app doc detail: off by default; denied packages become caveats", async () => {
  await withMetadataFetch(router(appDetailTables()), async () => {
    const plain = await documentApp("x_acme", { write: false });
    assert.doesNotMatch(plain.markdown, /## Diagrams|## Lint summary/);
  });
  await withEnv({ SN_PACKAGES_DENY: "flows,ui,artifacts,codecheck" }, () =>
    withMetadataFetch(router(appDetailTables()), async () => {
      const r = await documentApp("x_acme", { write: false, detail: true });
      const md = r.markdown;
      assert.match(md, /Diagrams of flow: the flows package is denied/);
      assert.match(md, /Diagrams of sp_portal: the ui package is denied/);
      assert.match(md, /Dependencies: the artifacts package is denied/);
      assert.match(md, /Lint: the codecheck package is denied/);
      assert.match(md, /## Lint summary\n\n_Not available._/);
    }),
  );
});

test("app doc: the global scope is refused (document_instance covers it)", async () => {
  await withMetadataFetch(router(appTables()), async (calls) => {
    await assert.rejects(
      documentApp("global", { write: false }),
      (e) => e.status === 400 && /global/.test(e.message),
    );
    assert.equal(calls.length, 0);
  });
});

test("app doc: an unknown scope is a 404", async () => {
  await withMetadataFetch(router({ ...appTables(), sys_store_app: [] }), () =>
    assert.rejects(
      documentApp("x_nope", { write: false }),
      (e) => e.status === 404,
    ),
  );
});

// ---------------------------------------------------------------------------
// security kind
// ---------------------------------------------------------------------------

const securityTables = () => ({
  sys_security_acl: [
    {
      sys_id: "s1",
      name: "x_acme_request",
      operation: "read",
      script: "",
      condition: "",
      "type.name": "record",
    },
    {
      sys_id: "s2",
      name: "x_acme_request",
      operation: "write",
      script: "",
      condition: "",
      "type.name": "record",
    },
    {
      sys_id: "s3",
      name: "x_acme_request",
      operation: "create",
      script: "",
      condition: "",
      "type.name": "record",
    },
    {
      sys_id: "s4",
      name: "x_acme_step.u_request",
      operation: "delete",
      script: "",
      condition: "",
      "type.name": "record",
    },
    {
      sys_id: "s5",
      name: "x_acme_step",
      operation: "read",
      script: "answer = eval(current.u_rule);",
      condition: "",
      "type.name": "record",
    },
  ],
  sys_security_acl_role: [
    { sys_security_acl: "s1", "sys_user_role.name": "itil", sys_id: "r1" },
    { sys_security_acl: "s3", "sys_user_role.name": "public", sys_id: "r3" },
    {
      sys_security_acl: "s4",
      "sys_user_role.name": "security_admin",
      sys_id: "r4",
    },
  ],
  sys_user_role_contains: [],
  sys_user_role: [{ sys_id: "sa", name: "security_admin" }],
  sys_ws_operation: [],
  sys_public: [],
  sys_db_object: [
    { sys_id: "t1", name: "x_acme_request", "super_class.name": "task" },
    { sys_id: "t2", name: "x_acme_step", "super_class.name": "" },
    { sys_id: "t3", name: "u_orphan", "super_class.name": "" },
  ],
});

test("golden: security doc with the ACL matrix and every check", async () => {
  await withMetadataFetch(router(securityTables()), async () => {
    const r = await documentSecurity({ write: false });
    assert.equal(r.path, "default/security.md");
    const md = r.markdown;
    assert.match(md, /## ACL matrix/);
    assert.match(md, /eval-in-acl/);
    assert.match(md, /acl-open/);
    assert.match(md, /acl-public-role/);
    assert.match(md, /acl-elevated-privilege/);
    assert.match(md, /table-no-acl/);
    assert.match(md, /## Hardening\n\nRule table v1: /);
    golden("security.md", md);
  });
});

test("security doc: a capped ACL read says so", async () => {
  const acls = Array.from({ length: 5 }, (_, i) => ({
    sys_id: `c${i}`,
    name: `u_t${i}`,
    operation: "read",
    script: "",
    condition: "x=1",
  }));
  await withEnv({ SN_MAX_RECORDS: "3" }, () =>
    withMetadataFetch(
      router({ ...securityTables(), sys_security_acl: acls }),
      async () => {
        const r = await documentSecurity({ write: false });
        assert.match(r.markdown, /Truncated/);
        assert.match(r.markdown, /SN_MAX_RECORDS/);
      },
    ),
  );
});

test("security doc: an unreadable sys_security_acl yields a short unavailable doc", async () => {
  await withMetadataFetch(
    router({ ...securityTables(), sys_security_acl: 403 }),
    async () => {
      const r = await documentSecurity({ write: false });
      assert.doesNotMatch(r.markdown, /## ACL matrix/);
      assert.match(r.markdown, /## Caveats/);
      assert.ok(r.caveats >= 1);
      golden("security-unavailable.md", r.markdown);
    },
  );
});

test("aclMatrix folds findings per table and operation, deduped by ACL", () => {
  const rows = aclMatrix([
    {
      rule: "acl-roles-only",
      sys_id: "1",
      name: "t",
      operation: "read",
      roles: ["itil"],
    },
    {
      rule: "acl-open",
      sys_id: "1",
      name: "t",
      operation: "read",
      roles: ["itil"],
    },
    {
      rule: "acl-roles-only",
      sys_id: "2",
      name: "t.f",
      operation: "write",
      roles: [],
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].table, "t");
  assert.match(JSON.stringify(rows[0]), /itil/);
  assert.match(JSON.stringify(rows[0]), /public/);
});

// ---------------------------------------------------------------------------
// registry completeness
// ---------------------------------------------------------------------------

test("every artefact type has app-doc columns (name + sdkManaged at least)", () => {
  for (const t of ARTIFACT_TYPES) {
    const cols = artifactColumns(t);
    assert.ok(cols.includes("name"), t.type);
    assert.ok(cols.includes("sdkManaged"), t.type);
    assert.equal(
      new Set(cols).size,
      cols.length,
      `${t.type}: duplicate columns`,
    );
    assert.ok(!cols.includes("value"), `${t.type}: value is never a column`);
    for (const f of t.secretFields ?? []) {
      assert.ok(!cols.includes(f), `${t.type}: secret field ${f}`);
    }
  }
});

test("every DOC_KINDS entry is complete and its public generator is a registered tool", () => {
  const tools = new Set(ALL_TOOLS.map((t) => t.name));
  for (const [id, kind] of Object.entries(DOC_KINDS)) {
    assert.equal(typeof kind.title, "string", id);
    assert.match(kind.version, /^\d+$/, id);
    assert.ok(Array.isArray(kind.requires) && kind.requires.length > 0, id);
    assert.match(kind.generator, /^servicenow_document_/, id);
    assert.equal(typeof kind.collect, "function", id);
    assert.equal(typeof kind.render, "function", id);
    assert.match(kind.path("x"), /\.md$/, id);
    // `security` has an internal entry point only (ID-23, owner decision);
    // it is reachable through document_instance({kinds}).
    if (id !== "security") assert.ok(tools.has(kind.generator), kind.generator);
  }
  assert.ok(tools.has("servicenow_document_instance"));
  for (const k of INSTANCE_DOC_KINDS) assert.ok(k in DOC_KINDS, k);
  for (const k of ["catalog", "integrations", "instance", "artifact_types"]) {
    assert.ok(k in DOC_KINDS, k);
    assert.equal(DOC_KINDS[k].generator, "servicenow_document_instance", k);
  }
});

// ---------------------------------------------------------------------------
// catalog and integrations kinds
// ---------------------------------------------------------------------------

const CAT1 = "1".repeat(32);
const CAT2 = "2".repeat(32);
const CATEGORY_HW = "3".repeat(32);
const CATEGORY_LAPTOP = "4".repeat(32);
const ITEM_LAPTOP = "5".repeat(32);
const ITEM_ACCESS = "6".repeat(32);

const catalogTables = () => ({
  sc_catalog: [
    { sys_id: CAT1, title: "Service Catalog", active: "true" },
    { sys_id: CAT2, title: "Technical Catalog", active: "false" },
  ],
  sc_category: [
    {
      sys_id: CATEGORY_HW,
      title: "Hardware",
      sc_catalog: CAT1,
      parent: "",
      active: "true",
    },
    {
      sys_id: CATEGORY_LAPTOP,
      title: "Laptops",
      sc_catalog: CAT1,
      parent: CATEGORY_HW,
      active: "true",
    },
  ],
  sc_cat_item: [
    {
      sys_id: ITEM_ACCESS,
      name: "Request access",
      sys_class_name: "sc_cat_item_producer",
      active: "true",
      category: "",
      sc_catalogs: CAT2,
    },
    {
      sys_id: ITEM_LAPTOP,
      name: "Standard laptop",
      sys_class_name: "sc_cat_item",
      active: "true",
      category: CATEGORY_LAPTOP,
      sc_catalogs: `${CAT1},${CAT2}`,
    },
  ],
  item_option_new: [
    {
      sys_id: "v2",
      name: "justification",
      question_text: "Why do you need it?",
      type: "2",
      cat_item: ITEM_LAPTOP,
      order: "200",
      mandatory: "true",
      active: "true",
    },
    {
      sys_id: "v1",
      name: "model",
      question_text: "Model",
      type: "5",
      cat_item: ITEM_LAPTOP,
      order: "100",
      mandatory: "false",
      active: "true",
    },
    {
      sys_id: "v3",
      name: "role",
      question_text: "Role | level",
      type: "8",
      cat_item: ITEM_ACCESS,
      order: "100",
      mandatory: "true",
      active: "true",
    },
  ],
});

const integrationTables = () => ({
  sys_ws_definition: [
    {
      name: "Acme Orders",
      namespace: "x_acme",
      base_uri: "/api/x_acme/orders",
      active: "true",
      "sys_scope.scope": "x_acme",
    },
  ],
  sys_rest_message: [
    {
      name: "Weather",
      rest_endpoint: "https://api.example.com/weather",
      authentication_type: "no_authentication",
      "sys_scope.scope": "global",
    },
  ],
  // Unreadable: a Caveats line, never a failure.
  sys_transform_map: 403,
  sys_data_source: [
    {
      name: "HR feed",
      type: "File",
      import_set_table_name: "u_hr_import",
      format: "CSV",
      "sys_scope.scope": "global",
    },
  ],
});

test("golden: catalog doc (catalogs → categories → items → variables)", async () => {
  await withMetadataFetch(router(catalogTables()), async () => {
    const r = await documentInstance({ kinds: ["catalog"], write: false });
    const doc = r.documents.find((d) => d.kind === "catalog");
    assert.equal(doc.path, "default/catalog.md");
    const md = doc.markdown;
    assert.match(md, /\| Laptops \| Service Catalog \| Hardware \| yes \|/);
    assert.match(md, /Service Catalog, Technical Catalog/);
    assert.match(md, /### Standard laptop/);
    assert.ok(
      md.indexOf("`model`") < md.indexOf("`justification`"),
      "variables in order",
    );
    assert.match(md, /Select box/);
    assert.match(md, /variable set/);
    golden("catalog.md", md);
  });
});

test("catalog doc: unreadable catalog tables become caveats", async () => {
  await withMetadataFetch(
    router({ ...catalogTables(), sc_category: 403, item_option_new: 500 }),
    async () => {
      const r = await documentInstance({ kinds: ["catalog"], write: false });
      const md = r.documents.find((d) => d.kind === "catalog").markdown;
      assert.match(md, /`sc_category` is not readable/);
      assert.match(md, /`item_option_new` is not readable/);
      assert.match(md, /_Not readable for this user — see Caveats\._/);
      assert.equal(r.failed, undefined);
    },
  );
});

test("golden: integrations doc (unreadable transform maps are a caveat)", async () => {
  await withMetadataFetch(router(integrationTables()), async () => {
    const r = await documentInstance({
      kinds: ["integrations"],
      write: false,
    });
    const doc = r.documents.find((d) => d.kind === "integrations");
    assert.equal(doc.path, "default/integrations.md");
    const md = doc.markdown;
    assert.match(md, /Acme Orders/);
    assert.match(md, /`sys_transform_map` is not readable/);
    assert.match(md, /Descriptive fields only/);
    golden("integrations.md", md);
  });
});

// ---------------------------------------------------------------------------
// document_instance
// ---------------------------------------------------------------------------

/** incident + x_acme + catalog + integrations + the README's own sources. */
function instanceTables() {
  const inc = incidentTables();
  const app = appTables();
  return {
    ...inc,
    ...app,
    ...catalogTables(),
    ...integrationTables(),
    sys_db_object: (q) => {
      const rows = [...inc.sys_db_object(q), ...app.sys_db_object(q)];
      if (rows.length || q !== "ORDERBYname") return rows;
      return [
        { name: "incident", label: "Incident", "super_class.name": "task" },
        { name: "task", label: "Task", "super_class.name": "" },
        {
          name: "x_acme_request",
          label: "Request",
          "super_class.name": "task",
        },
      ];
    },
    sys_dictionary: (q) => [...inc.sys_dictionary(q), ...app.sys_dictionary(q)],
    sys_script: [...inc.sys_script, ...app.sys_script],
    sys_properties: (q) =>
      q.startsWith("nameIN")
        ? [
            { name: "glide.buildname", value: "Yokohama" },
            {
              name: "glide.buildtag",
              value: "glide-yokohama-12-18-2024__patch3",
            },
          ]
        : app.sys_properties,
    sys_app: (q) =>
      q.startsWith("scope=")
        ? app.sys_app(q)
        : [
            {
              name: "Acme Requests",
              scope: "x_acme",
              version: "1.2.0",
              active: "true",
            },
          ],
    sys_store_app: [
      {
        name: "Legal Ops",
        scope: "sn_legal",
        version: "5.0.1",
        active: "true",
      },
    ],
    v_plugin: [
      {
        id: "com.snc.incident",
        name: "Incident",
        active: "active",
        version: "1",
      },
      { id: "com.glide.hub", name: "Hub", active: "inactive", version: "2" },
    ],
    sys_update_set: [
      { name: "ACME release 3", "application.scope": "x_acme" },
      { name: "Default", "application.scope": "global" },
    ],
  };
}

const INSTANCE_OPTS = {
  tables: ["incident"],
  apps: ["x_acme"],
  kinds: ["catalog", "integrations"],
};
const INSTANCE_FILES = [
  "README",
  "tables/incident",
  "apps/x_acme",
  "catalog",
  "integrations",
  "artifact-types",
].flatMap((f) => [`default/${f}.md`, `default/${f}.json`]);

test("golden: document_instance writes the README and every named document", async () => {
  const dir = tempDocs();
  await withEnv({ SN_DOCS_DIR: dir }, () =>
    withMetadataFetch(router(instanceTables()), async () => {
      const r = await documentInstance(INSTANCE_OPTS);
      assert.equal(r.path, "default/README.md");
      assert.equal(r.partial, false);
      assert.equal(r.files, 12);
      assert.equal(r.failed, undefined);
      assert.deepEqual(
        r.documents.map((d) => d.path),
        INSTANCE_FILES.filter((f) => f.endsWith(".md")),
      );
      for (const f of INSTANCE_FILES) {
        assert.ok(existsSync(path.join(dir, f)), f);
      }
      const md = readFileSync(path.join(dir, "default/README.md"), "utf8");
      assert.match(md, /^sn_generator: servicenow_document_instance$/m);
      assert.match(md, /^sn_kind: instance$/m);
      assert.match(md, /glide-yokohama/);
      assert.match(md, /\[x_acme\]\(apps\/x_acme\.md\)/);
      assert.match(md, /\[Table incident\]\(tables\/incident\.md\)/);
      assert.match(md, /ACME release 3/);
      assert.match(md, /domain-separated/);
      assert.doesNotMatch(md, /hunter2/);
      golden("instance-README.md", stripVolatile(md));

      // The table document keeps its own generator in the frontmatter.
      const table = readFileSync(
        path.join(dir, "default/tables/incident.md"),
        "utf8",
      );
      assert.match(table, /^sn_generator: servicenow_document_table$/m);

      const index = JSON.parse(
        readFileSync(path.join(dir, "index.json"), "utf8"),
      );
      const run = index.runs.servicenow_document_instance;
      assert.equal(run.partial, false);
      assert.equal(run.files, 12);

      // ID-29: the collected column follows what the run's documents hold.
      const types = JSON.parse(
        readFileSync(path.join(dir, "default/artifact-types.json"), "utf8"),
      ).types;
      const byType = Object.fromEntries(types.map((t) => [t.type, t]));
      assert.equal(types.length, ARTIFACT_TYPES.length);
      assert.equal(byType.catalog_item.collected, true);
      assert.equal(byType.rest_api.collected, true);
      assert.equal(byType.transform_map.collected, false, "unreadable");
      assert.equal(byType.business_rule.collected, true);
      const typesMd = readFileSync(
        path.join(dir, "default/artifact-types.md"),
        "utf8",
      );
      assert.match(typesMd, /\| Collected in this run \|/);
      assert.match(typesMd, /\| `catalog_item` \|.*\| yes \|$/m);
    }),
  );
});

test("document_instance: one progress tick per document, message = its path", async () => {
  const seen = [];
  await runWithCall(
    { requestId: "r", tool: "t", progress: (u) => seen.push(u) },
    () =>
      withEnv({ SN_DOCS_DIR: tempDocs() }, () =>
        withMetadataFetch(router(instanceTables()), () =>
          documentInstance(INSTANCE_OPTS),
        ),
      ),
  );
  const mds = INSTANCE_FILES.filter((f) => f.endsWith(".md"));
  assert.equal(seen.length, mds.length);
  assert.deepEqual(
    seen.map((u) => u.message),
    mds,
  );
  assert.deepEqual(
    seen.map((u) => u.progress),
    mds.map((_, i) => i + 1),
  );
  assert.ok(seen.every((u) => u.total === mds.length));
});

test("document_instance: a cancel after N documents leaves N valid documents and a partial run", async () => {
  const dir = tempDocs();
  const controller = new AbortController();
  const N = 2;
  let ticks = 0;
  await withEnv({ SN_DOCS_DIR: dir }, () =>
    withMetadataFetch(router(instanceTables()), () =>
      runWithCall(
        {
          requestId: "r",
          tool: "t",
          signal: controller.signal,
          progress: () => {
            if (++ticks === N) controller.abort();
          },
        },
        () =>
          assert.rejects(
            documentInstance(INSTANCE_OPTS),
            (e) => e.code === "CANCELLED",
          ),
      ),
    ),
  );
  const done = INSTANCE_FILES.slice(0, 2 * N);
  for (const f of done) {
    const text = readFileSync(path.join(dir, f), "utf8");
    if (f.endsWith(".json")) JSON.parse(text);
    else assert.match(text, /^---\nsn_generated: true$/m, f);
  }
  for (const f of INSTANCE_FILES.slice(2 * N)) {
    assert.ok(!existsSync(path.join(dir, f)), `${f} not written`);
  }
  const run = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8"))
    .runs.servicenow_document_instance;
  assert.equal(run.partial, true);
  assert.equal(run.files, 2 * N);
  assert.ok(run.finished_at);
});

test("document_instance: two runs over the same metadata differ only in sn_generated_at", async () => {
  const outputs = [];
  for (let i = 0; i < 2; i++) {
    const dir = tempDocs();
    clearSchemaCache();
    await withEnv({ SN_DOCS_DIR: dir }, () =>
      withMetadataFetch(router(instanceTables()), () =>
        documentInstance(INSTANCE_OPTS),
      ),
    );
    outputs.push(
      INSTANCE_FILES.map((f) => readFileSync(path.join(dir, f), "utf8")),
    );
  }
  INSTANCE_FILES.forEach((f, i) =>
    assert.equal(
      stripVolatile(outputs[0][i], ["sn_generated_at"]),
      stripVolatile(outputs[1][i], ["sn_generated_at"]),
      f,
    ),
  );
});

test("document_instance: a failing named target is reported and the run goes on", async () => {
  await withMetadataFetch(
    router({ ...instanceTables(), sys_store_app: [] }),
    async () => {
      const r = await documentInstance({
        apps: ["x_nope"],
        kinds: ["integrations"],
        write: false,
      });
      assert.equal(r.failed.length, 1);
      assert.equal(r.failed[0].path, "default/apps/x_nope.md");
      assert.deepEqual(
        r.documents.map((d) => d.kind),
        ["instance", "integrations", "artifact_types"],
      );
      assert.equal(r.files, 0);
    },
  );
});

test("document_instance: unsafe targets and unknown kinds are refused before any read", async () => {
  await withMetadataFetch(router({}), async (calls) => {
    await assert.rejects(
      documentInstance({ tables: ["../x"], write: false }),
      /cannot name a document/,
    );
    await assert.rejects(
      documentInstance({ kinds: ["table"], write: false }),
      /Unknown document kind/,
    );
    assert.equal(calls.length, 0);
  });
});

test("document_instance: the registered tool delivers the run summary", async () => {
  const tool = ALL_TOOLS.find((t) => t.name === "servicenow_document_instance");
  assert.ok(tool);
  assert.equal(tool.package, "docs");
  assert.deepEqual(tool.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.ok(tool.description.length < 400);
  await withEnv({ SN_DOCS_DIR: tempDocs() }, () =>
    withMetadataFetch(router(instanceTables()), async () => {
      const res = await tool.handler({ kinds: ["catalog"] });
      const body = JSON.parse(res.content[0].text);
      assert.equal(body.path, "default/README.md");
      assert.deepEqual(
        body.documents.map((d) => d.kind),
        ["instance", "catalog", "artifact_types"],
      );
    }),
  );
});

// ---------------------------------------------------------------------------
// S-16 discovery: document_instance({depth}) → <profile>/discovery/
// ---------------------------------------------------------------------------

/** The Markdown paths of a depth run with no named targets, in run order. */
const DISCOVERY_RUNS = {
  overview: ["README", "discovery/overview", "artifact-types"],
  apps: [
    "README",
    "discovery/overview",
    "discovery/tables-x_acme",
    "discovery/apps",
    "artifact-types",
  ],
  artefacts: [
    "README",
    "discovery/overview",
    "discovery/tables-x_acme",
    "discovery/artifacts-x_acme",
    "discovery/apps",
    "artifact-types",
  ],
};

for (const [depth, files] of Object.entries(DISCOVERY_RUNS)) {
  test(`discovery: depth '${depth}' writes exactly its file set`, async () => {
    const dir = tempDocs();
    await withEnv({ SN_DOCS_DIR: dir }, () =>
      withMetadataFetch(router(instanceTables()), async () => {
        const r = await documentInstance({ depth });
        assert.equal(r.failed, undefined);
        assert.deepEqual(
          r.documents.map((d) => d.path),
          files.map((f) => `default/${f}.md`),
        );
        assert.equal(r.files, files.length * 2);
        for (const f of files) {
          assert.ok(existsSync(path.join(dir, `default/${f}.md`)), f);
          JSON.parse(readFileSync(path.join(dir, `default/${f}.json`), "utf8"));
        }
        const written = readdirSync(path.join(dir, "default/discovery"))
          .filter((f) => f.endsWith(".md"))
          .sort();
        assert.deepEqual(
          written,
          files
            .filter((f) => f.startsWith("discovery/"))
            .map((f) => `${f.slice("discovery/".length)}.md`)
            .sort(),
        );
        const overview = readFileSync(
          path.join(dir, "default/discovery/overview.md"),
          "utf8",
        );
        assert.match(overview, /^sn_generator: servicenow_document_instance$/m);
        assert.match(overview, /^sn_kind: discovery_overview$/m);
        assert.match(overview, new RegExp(`depth \`${depth}\``));
        // The README links the discovery files it wrote.
        const readme = readFileSync(
          path.join(dir, "default/README.md"),
          "utf8",
        );
        assert.match(
          readme,
          /\[Discovery overview\]\(discovery\/overview\.md\)/,
        );
        if (depth === "artefacts") {
          for (const f of files.filter((x) => x.startsWith("discovery/"))) {
            const md = readFileSync(path.join(dir, `default/${f}.md`), "utf8");
            assert.doesNotMatch(md, /hunter2/, f);
            golden(`${f.replace("/", "-")}.md`, stripVolatile(md));
          }
        }
      }),
    );
  });
}

test("discovery: omitting depth writes no discovery folder", async () => {
  const dir = tempDocs();
  await withEnv({ SN_DOCS_DIR: dir }, () =>
    withMetadataFetch(router(instanceTables()), () =>
      documentInstance(INSTANCE_OPTS),
    ),
  );
  assert.ok(!existsSync(path.join(dir, "default/discovery")));
});

test("discovery: artifacts-<scope>.md says why each type was not collected", async () => {
  const base = instanceTables();
  const script = (i) => ({
    sys_id: i.toString(16).padStart(32, "0"),
    name: `AcmeInclude${i}`,
    api_name: `x_acme.AcmeInclude${i}`,
    active: "true",
    "sys_scope.scope": "x_acme",
  });
  await withMetadataFetch(
    router({
      ...base,
      sys_db_object: (q) =>
        q.startsWith("name=sys_ui_page")
          ? [{ name: "sys_ui_page" }]
          : base.sys_db_object(q),
      // Unverified, the table exists but this user cannot read it (O-5).
      sys_ui_page: 403,
      // Unverified, no such table on this instance.
      sysevent_script_action: 404,
      // Licensed family whose plugin is not installed.
      sn_aia_agent: 404,
      // N-8: Performance Analytics not installed (O-9).
      pa_indicators: 404,
      // More rows than one listing returns.
      sys_script_include: Array.from({ length: 1001 }, (_, i) => script(i)),
    }),
    async () => {
      const r = await documentInstance({
        depth: "artefacts",
        write: false,
      });
      const md = r.documents.find(
        (d) => d.kind === "discovery_artifacts",
      ).markdown;
      const row = (type) =>
        md.split("\n").find((l) => l.startsWith(`| \`${type}\` |`)) ?? "";
      assert.match(row("business_rule"), /\| yes \(\d+\) \|$/);
      assert.match(row("script_include"), /\| yes, 1000 of 1001 \(cap\) \|$/);
      assert.match(
        row("ui_page"),
        /no — unverified: table not readable here \(O-5\)/,
      );
      assert.match(
        row("script_action"),
        /no — unverified: the instance has no such table/,
      );
      assert.match(
        row("client_script"),
        /no — unreadable for this user \(ACL or table policy\)/,
      );
      assert.match(
        row("ai_agent"),
        /no — package off: `Now Assist AI Agents \(sn_aia\)` not installed/,
      );
      assert.match(
        row("pa_indicator"),
        /no — package off: `Performance Analytics \(com\.snc\.pa\)` not installed/,
      );
      assert.match(row("report"), /no — no records in this scope/);
      assert.match(row("fix_script"), /no — no records in this scope/);
      assert.match(row("table"), /see \[tables-x_acme\.md\]/);
      assert.match(md, /script_include: 1000 of 1001 records listed/);
    },
  );
});

test("discovery: named apps drive the scopes; unnamed runs cap sys_app scopes", async () => {
  await withMetadataFetch(router(instanceTables()), async () => {
    const r = await documentInstance({
      depth: "apps",
      apps: ["x_acme"],
      write: false,
    });
    assert.deepEqual(
      r.documents.map((d) => d.path),
      [
        "default/README.md",
        "default/discovery/overview.md",
        "default/apps/x_acme.md",
        "default/discovery/tables-x_acme.md",
        "default/discovery/apps.md",
        "default/artifact-types.md",
      ],
    );
    const apps = r.documents.find((d) => d.kind === "discovery_apps").markdown;
    assert.match(apps, /scopes named in this run/);
    assert.match(apps, /\| Acme Requests \| `x_acme` \|/);
  });

  const scopes = Array.from(
    { length: INSTANCE_TARGETS_MAX + 2 },
    (_, i) => `x_s${String(i).padStart(3, "0")}`,
  );
  await withMetadataFetch(
    router({
      ...instanceTables(),
      sys_app: [
        ...scopes.map((scope) => ({ name: scope, scope, active: "true" })),
        { name: "Global", scope: "global", active: "true" },
        { name: "Odd", scope: "x/../odd", active: "true" },
      ],
    }),
    async () => {
      const r = await documentInstance({ depth: "apps", write: false });
      const tables = r.documents.filter((d) => d.kind === "discovery_tables");
      assert.equal(tables.length, INSTANCE_TARGETS_MAX);
      assert.equal(tables[0].target, "x_s000");
      const apps = r.documents.find(
        (d) => d.kind === "discovery_apps",
      ).markdown;
      assert.match(apps, /custom applications/);
      assert.match(apps, /`x_s050`, `x_s051`/);
      assert.doesNotMatch(apps, /`global`/);
      const overview = r.documents.find(
        (d) => d.kind === "discovery_overview",
      ).markdown;
      assert.match(overview, /2 more scope\(s\) beyond the 50-scope cap/);
    },
  );
});

test("discovery: an unknown depth is refused before any read", async () => {
  await withMetadataFetch(router({}), async (calls) => {
    await assert.rejects(
      documentInstance({ depth: "everything", write: false }),
      /Unknown depth 'everything'/,
    );
    assert.equal(calls.length, 0);
  });
});

test("discovery: the registered tool passes depth through", async () => {
  const tool = ALL_TOOLS.find((t) => t.name === "servicenow_document_instance");
  assert.ok(tool.description.length <= 250);
  await withMetadataFetch(router(instanceTables()), async () => {
    const res = await tool.handler({ depth: "overview", write: false });
    const body = JSON.parse(res.content[0].text);
    assert.deepEqual(
      body.documents.map((d) => d.kind),
      ["instance", "discovery_overview", "artifact_types"],
    );
  });
});
