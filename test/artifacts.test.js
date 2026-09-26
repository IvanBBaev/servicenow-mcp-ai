// P-5 — generic artefact read tools: servicenow_list_artifacts /
// servicenow_get_artifact against a Table API mock (children incl. nested
// ones, scope + SDK-managed verdict, redaction, policy, the verified:false
// degrade path, key reads) and the servicenow://artifact-types resource.
import test from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  getArtifactFor,
  artifactTypeCatalog,
  CHILD_LIMIT,
} from "../build/api/artifacts.js";
import {
  ARTIFACT_TYPES,
  getArtifactType,
} from "../build/core/artifacts/registry.js";
import { runSpec } from "../build/mcp/define.js";
import {
  ALL_TOOLS,
  PACKAGES,
  registerAllTools,
  registerResources,
  resolveEnabledPackages,
} from "../build/mcp/registry.js";
import { currentRuntime } from "../build/core/runtime.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

baselineEnv();

const POLICY_ID = "a".repeat(32);
const APP_ID = "b".repeat(32);
const SDK_OFF = { SN_SDK_MANAGED_SCOPES: undefined, SN_SDK_PROJECT_DIRS: "" };

const tool = (name) => {
  const spec = ALL_TOOLS.find((s) => s.name === name);
  assert.ok(spec, `missing tool ${name}`);
  return spec;
};
const call = (name, args) => runSpec(tool(name), args);
const out = (res) => JSON.parse(res.content[0].text);

/** Route a Table API request: `routes[table]` gets (params, url, sysId). */
function tableMock(routes) {
  return (url) => {
    const u = new URL(url);
    const m = u.pathname.match(/\/api\/now\/table\/([^/]+)(?:\/([^/]+))?$/);
    assert.ok(m, `unexpected request ${url}`);
    const route = routes[m[1]];
    if (!route) return jsonResponse(404, { error: { message: "no route" } });
    return route(u.searchParams, u, m[2]);
  };
}
const rows = (result, headers) => jsonResponse(200, { result }, headers);
const tablesCalled = (calls) =>
  calls.map((c) => new URL(c.url).pathname.split("/")[4]);

const policyRecord = {
  sys_id: POLICY_ID,
  short_description: "Hide close notes",
  table: "incident",
  active: "true",
  sys_scope: APP_ID,
  script_true: "",
  script_false: "",
};

test("get_artifact on ui_policy returns its sys_ui_policy_action children", async () => {
  freshRuntime();
  await withEnv(
    { ...SDK_OFF, SN_SDK_MANAGED_SCOPES: "x_acme_app" },
    async () => {
      await withFetch(
        tableMock({
          sys_ui_policy: (_p, _u, id) => {
            assert.equal(id, POLICY_ID);
            return rows(policyRecord);
          },
          sys_scope: (p) => {
            assert.equal(p.get("sysparm_query"), `sys_id=${APP_ID}`);
            return rows([{ sys_id: APP_ID, scope: "x_acme_app" }]);
          },
          sys_ui_policy_action: (p) => {
            assert.equal(p.get("sysparm_query"), `ui_policy=${POLICY_ID}`);
            return rows([
              {
                sys_id: "1".repeat(32),
                field: "close_notes",
                visible: "false",
              },
              { sys_id: "2".repeat(32), field: "close_code", visible: "false" },
            ]);
          },
        }),
        async () => {
          const res = await call("servicenow_get_artifact", {
            artifactType: "ui_policy",
            sys_id: POLICY_ID,
          });
          assert.equal(res.isError, undefined);
          const body = res.structuredContent;
          assert.deepEqual(body, out(res));
          assert.equal(body.artifactType, "ui_policy");
          assert.equal(body.verified, true);
          assert.equal(body.caveat, undefined);
          assert.equal(body.name, "Hide close notes");
          assert.deepEqual(body.key, { sys_id: POLICY_ID });
          assert.deepEqual(body.scope, { sys_id: APP_ID, scope: "x_acme_app" });
          assert.equal(body.sdkManaged.managed, "yes");
          assert.equal(body.children.length, 1);
          const [actions] = body.children;
          assert.equal(actions.table, "sys_ui_policy_action");
          assert.equal(actions.verified, false);
          assert.equal(actions.count, 2);
          assert.deepEqual(
            actions.records.map((r) => r.field),
            ["close_notes", "close_code"],
          );
          assert.equal(body.missingFields, undefined);
        },
      );
    },
  );
});

test("get_artifact by natural key reads nested children level by level", async () => {
  freshRuntime();
  const page = "c".repeat(32);
  const cont = ["d".repeat(32), "e".repeat(32)];
  const row = "f".repeat(32);
  await withEnv(SDK_OFF, async () => {
    await withFetch(
      tableMock({
        sp_page: (p) => {
          assert.equal(p.get("sysparm_query"), "id=index");
          assert.equal(p.get("sysparm_limit"), "2");
          return rows([
            { sys_id: page, id: "index", title: "Home", sys_scope: "global" },
          ]);
        },
        sys_scope: () => rows([{ sys_id: "global", scope: "global" }]),
        sp_container: (p) => {
          assert.equal(p.get("sysparm_query"), `sp_page=${page}^ORDERBYorder`);
          return rows(cont.map((sys_id) => ({ sys_id })));
        },
        sp_row: (p) => {
          assert.equal(
            p.get("sysparm_query"),
            `sp_containerIN${cont.join(",")}^ORDERBYorder`,
          );
          return rows([{ sys_id: row, sp_container: cont[0] }]);
        },
        sp_column: (p) => {
          assert.equal(p.get("sysparm_query"), `sp_row=${row}^ORDERBYorder`);
          return rows([]);
        },
        sp_instance: () => assert.fail("no columns, no instance read"),
      }),
      async (calls) => {
        const res = await call("servicenow_get_artifact", {
          artifactType: "sp_page",
          key: "index",
        });
        const body = out(res);
        assert.equal(body.verified, false);
        assert.match(body.caveat, /O-5/);
        assert.deepEqual(body.key, { id: "index" });
        assert.deepEqual(body.scope, { sys_id: "global", scope: "global" });
        assert.deepEqual(
          body.children.map((c) => [c.table, c.count]),
          [
            ["sp_container", 2],
            ["sp_row", 1],
            ["sp_column", 0],
            ["sp_instance", 0],
          ],
        );
        assert.equal(body.children[1].parentTable, "sp_container");
        assert.ok(!tablesCalled(calls).includes("sp_instance"));
      },
    );
  });
});

test("get_artifact: ambiguous and unmatched keys, and bad identifiers", async () => {
  freshRuntime();
  await withEnv(SDK_OFF, async () => {
    await withFetch(
      tableMock({
        sp_page: (p) =>
          p.get("sysparm_query") === "id=dup"
            ? rows([{ sys_id: "1".repeat(32) }, { sys_id: "2".repeat(32) }])
            : rows([], { "X-Total-Count": "0" }),
      }),
      async () => {
        const dup = out(
          await call("servicenow_get_artifact", {
            artifactType: "sp_page",
            key: "dup",
          }),
        );
        assert.equal(dup.error.status, 409);
        assert.equal(dup.error.code, "AMBIGUOUS_KEY");

        const none = out(
          await call("servicenow_get_artifact", {
            artifactType: "sp_page",
            key: { id: "nope" },
          }),
        );
        assert.equal(none.error.status, 404);

        const both = out(
          await call("servicenow_get_artifact", {
            artifactType: "sp_page",
            key: "x",
            sys_id: "1".repeat(32),
          }),
        );
        assert.match(both.error.message, /exactly one/);

        const missingKey = out(
          await call("servicenow_get_artifact", {
            artifactType: "sp_page",
            key: { title: "Home" },
          }),
        );
        assert.match(missingKey.error.message, /missing: id/);

        const badId = out(
          await call("servicenow_get_artifact", {
            artifactType: "sp_page",
            sys_id: "not-an-id",
          }),
        );
        assert.equal(badId.error.status, 400);

        const unknown = out(
          await call("servicenow_get_artifact", {
            artifactType: "nope",
            sys_id: "1".repeat(32),
          }),
        );
        assert.match(unknown.error.message, /Valid types: business_rule/);
      },
    );
  });
});

test("get_artifact: denied child is redacted, failing child degrades, secrets and SN_REDACT_FIELDS are masked", async () => {
  freshRuntime();
  const descriptor = {
    ...getArtifactType("workflow"),
    secretFields: ["password"],
  };
  const wf = "1".repeat(32);
  await withEnv(
    {
      ...SDK_OFF,
      SN_TABLES_DENY: "wf_workflow_version",
      SN_REDACT_FIELDS: "token",
    },
    async () => {
      await withFetch(
        tableMock({
          wf_workflow: () =>
            rows({
              sys_id: wf,
              name: "Approve",
              sys_scope: "",
              password: "hunter2",
              token: "abc",
            }),
          wf_activity: () =>
            jsonResponse(403, { error: { message: "ACL denied" } }),
          wf_transition: () => assert.fail("parent not read"),
        }),
        async (calls) => {
          const body = await getArtifactFor(descriptor, { sys_id: wf });
          assert.equal(body.record.password, "[redacted]");
          assert.equal(body.scope.sys_id, null);
          assert.equal(body.sdkManaged.managed, "unknown");
          const [version, activity, transition] = body.children;
          assert.equal(version.redacted, true);
          assert.match(version.reason, /SN_TABLES_DENY/);
          assert.equal(activity.status, 403);
          assert.deepEqual(activity.records, []);
          assert.match(transition.reason, /wf_activity was not read/);
          assert.ok(!tablesCalled(calls).includes("wf_workflow_version"));

          // Through the tool, SN_REDACT_FIELDS masks at the result boundary.
          const res = await call("servicenow_get_artifact", {
            artifactType: "workflow",
            sys_id: wf,
          });
          assert.equal(out(res).record.token, "[redacted]");
          assert.equal(res.structuredContent.record.token, "[redacted]");
        },
      );
    },
  );
});

test("get_artifact: child rows past CHILD_LIMIT are truncated; policy on the primary table errors", async () => {
  freshRuntime();
  await withEnv(SDK_OFF, async () => {
    await withFetch(
      tableMock({
        sys_ui_policy: () => rows({ ...policyRecord, sys_scope: "" }),
        sys_ui_policy_action: (p) => {
          assert.equal(p.get("sysparm_limit"), String(CHILD_LIMIT + 1));
          return rows(
            Array.from({ length: CHILD_LIMIT + 1 }, (_, i) => ({
              sys_id: String(i).padStart(32, "0"),
            })),
          );
        },
      }),
      async () => {
        const body = out(
          await call("servicenow_get_artifact", {
            artifactType: "ui_policy",
            sys_id: POLICY_ID,
          }),
        );
        assert.equal(body.children[0].count, CHILD_LIMIT);
        assert.equal(body.children[0].truncated, true);
      },
    );
  });
  await withEnv({ ...SDK_OFF, SN_TABLES_DENY: "sys_ui_policy" }, async () => {
    await withFetch(
      () => assert.fail("no request"),
      async () => {
        const body = out(
          await call("servicenow_get_artifact", {
            artifactType: "ui_policy",
            sys_id: POLICY_ID,
          }),
        );
        assert.equal(body.error.status, 403);
      },
    );
  });
});

test("get_artifact: an unverified type degrades on 400, a verified one fails", async () => {
  freshRuntime();
  await withEnv(SDK_OFF, async () => {
    await withFetch(
      () => jsonResponse(400, { error: { message: "Invalid table" } }),
      async () => {
        const res = await call("servicenow_get_artifact", {
          artifactType: "flow",
          sys_id: "1".repeat(32),
        });
        assert.equal(res.isError, undefined);
        const body = res.structuredContent;
        assert.equal(body.record, null);
        assert.equal(body.degraded.status, 400);
        assert.equal(body.verified, false);

        const verified = out(
          await call("servicenow_get_artifact", {
            artifactType: "ui_policy",
            sys_id: POLICY_ID,
          }),
        );
        assert.equal(verified.error.status, 400);
      },
    );
    await withFetch(
      () => jsonResponse(404, { error: { message: "No Record found" } }),
      async () => {
        const body = out(
          await call("servicenow_get_artifact", {
            artifactType: "flow",
            sys_id: "1".repeat(32),
          }),
        );
        assert.equal(body.error.status, 404);
      },
    );
  });
});

test("list_artifacts builds the query, summarises rows and caches one verdict per scope", async () => {
  freshRuntime();
  await withEnv(
    { ...SDK_OFF, SN_SDK_MANAGED_SCOPES: "x_acme_app" },
    async () => {
      await withFetch(
        tableMock({
          sys_ui_policy: (p) => {
            assert.equal(
              p.get("sysparm_query"),
              "sys_scope.scope=x_acme_app^active=true^table=incident^ORDERBYshort_description",
            );
            assert.equal(p.get("sysparm_limit"), "50");
            assert.equal(p.get("sysparm_display_value"), "false");
            assert.ok(p.get("sysparm_fields").includes("sys_scope.scope"));
            return rows([
              { ...policyRecord, "sys_scope.scope": "x_acme_app" },
              {
                ...policyRecord,
                sys_id: "9".repeat(32),
                short_description: "Other",
                active: "false",
                "sys_scope.scope": "x_acme_app",
              },
            ]);
          },
        }),
        async (calls) => {
          const res = await call("servicenow_list_artifacts", {
            artifactType: "ui_policy",
            scope: "x_acme_app",
            active: true,
            query: "table=incident",
          });
          assert.equal(res.isError, undefined);
          const body = res.structuredContent;
          assert.equal(body.count, 2);
          assert.equal(calls.length, 1, "no sys_scope lookups while listing");
          const [first, second] = body.artifacts;
          assert.equal(first.name, "Hide close notes");
          assert.deepEqual(first.scope, {
            sys_id: APP_ID,
            scope: "x_acme_app",
          });
          assert.equal(first.sdkManaged, "yes");
          assert.equal(first.active, true);
          assert.equal(first.table, "incident");
          assert.equal(second.active, false);
          assert.equal(first.script_true, undefined);
        },
      );
    },
  );
});

test("list_artifacts: base query first, missing fields, active refusal, degrade and policy", async () => {
  freshRuntime();
  await withEnv(SDK_OFF, async () => {
    // dictionary_script carries a base query with ^OR; it must lead.
    const dict = getArtifactType("dictionary_script");
    await withFetch(
      tableMock({
        [dict.table]: (p) => {
          assert.ok(p.get("sysparm_query").startsWith(dict.baseQuery + "^"));
          return rows([{ sys_id: "1".repeat(32) }]);
        },
      }),
      async () => {
        const body = out(
          await call("servicenow_list_artifacts", {
            artifactType: "dictionary_script",
            limit: 5,
          }),
        );
        assert.equal(body.count, 1);
        assert.ok(body.missingFields.includes(dict.nameField));
        assert.equal(body.artifacts[0].sdkManaged, "unknown");
      },
    );

    const noActive = out(
      await call("servicenow_list_artifacts", {
        artifactType: "sp_page",
        active: true,
      }),
    );
    assert.match(noActive.error.message, /no active flag/);

    await withFetch(
      () => jsonResponse(403, { error: { message: "ACL" } }),
      async () => {
        const degraded = await call("servicenow_list_artifacts", {
          artifactType: "flow",
        });
        assert.equal(degraded.isError, undefined);
        assert.equal(degraded.structuredContent.degraded.status, 403);
        assert.deepEqual(degraded.structuredContent.artifacts, []);

        const verified = out(
          await call("servicenow_list_artifacts", {
            artifactType: "business_rule",
          }),
        );
        assert.equal(verified.error.status, 403);
      },
    );
  });
  await withEnv({ ...SDK_OFF, SN_TABLES_ALLOW: "incident" }, async () => {
    await withFetch(
      () => assert.fail("no request"),
      async () => {
        const denied = out(
          await call("servicenow_list_artifacts", { artifactType: "flow" }),
        );
        assert.equal(denied.error.status, 403);
      },
    );
  });
});

test("the artifacts package is opt-in and holds exactly the four tools", () => {
  const pkg = PACKAGES.find((p) => p.name === "artifacts");
  assert.ok(pkg);
  assert.deepEqual(
    pkg.tools.map((t) => t.name),
    [
      "servicenow_list_artifacts",
      "servicenow_get_artifact",
      "servicenow_explain_artifact",
      "servicenow_artifact_dependencies",
    ],
  );
  for (const t of pkg.tools) {
    assert.equal(t.package, "artifacts");
    assert.equal(t.annotations.readOnlyHint, true);
    assert.ok(t.output, `${t.name} declares an outputSchema`);
  }
  for (const profile of ["core", "reader", "developer"]) {
    assert.ok(!resolveEnabledPackages([profile]).has("artifacts"), profile);
  }
  assert.ok(resolveEnabledPackages(["all"]).has("artifacts"));
});

test("artifact-types catalogue covers every registry type", () => {
  const cat = artifactTypeCatalog();
  assert.equal(cat.count, ARTIFACT_TYPES.length);
  const ui = cat.types.find((t) => t.type === "ui_policy");
  assert.deepEqual(ui.children, [
    { table: "sys_ui_policy_action", parentField: "ui_policy" },
  ]);
  assert.equal(ui.verified, true);
  const row = cat.types
    .find((t) => t.type === "sp_page")
    .children.find((c) => c.table === "sp_row");
  assert.equal(row.parentTable, "sp_container");
});

test("MCP round trip: resource is listed with the package, outputSchema validates", async () => {
  freshRuntime();
  await withEnv({ ...SDK_OFF, SN_TOOL_PACKAGES: "artifacts" }, async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    registerAllTools(server, currentRuntime());
    registerResources(server);
    const client = new Client({ name: "c", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const { resources } = await client.listResources();
      assert.ok(resources.some((r) => r.uri === "servicenow://artifact-types"));
      const read = await client.readResource({
        uri: "servicenow://artifact-types",
      });
      assert.equal(
        JSON.parse(read.contents[0].text).count,
        ARTIFACT_TYPES.length,
      );

      const { tools } = await client.listTools();
      const list = tools.find((t) => t.name === "servicenow_list_artifacts");
      assert.ok(list.outputSchema);

      await withFetch(
        tableMock({
          sys_ui_policy: () =>
            rows([{ ...policyRecord, "sys_scope.scope": "x_acme_app" }]),
        }),
        async () => {
          const res = await client.callTool({
            name: "servicenow_list_artifacts",
            arguments: { artifactType: "ui_policy" },
          });
          assert.equal(res.isError, undefined);
          assert.equal(res.structuredContent.count, 1);
        },
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  await withEnv({ SN_TOOL_PACKAGES: "core" }, async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    registerResources(server);
    const client = new Client({ name: "c", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const { resources } = await client.listResources();
      assert.ok(
        !resources.some((r) => r.uri === "servicenow://artifact-types"),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
