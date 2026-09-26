import test from "node:test";
import assert from "node:assert/strict";

import {
  collectTables,
  collectSchema,
  collectPlugins,
  collectApps,
  collectAutomation,
  collectRecordSection,
  PLUGIN_SOURCES,
  APP_SOURCES,
} from "../build/api/collectors.js";
import { SCRIPT_TYPES } from "../build/api/scripts.js";
import { runWithCall } from "../build/core/request-context.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

/**
 * E-7 collectors: plain data plus `unreadable` / `truncated` / `capped` /
 * `errors`, never a thrown read failure, and CANCELLED on an aborted signal.
 */

test.beforeEach(() => {
  baselineEnv();
  freshRuntime();
});

const tableOf = (url) => new URL(url).pathname.split("/").pop();
const denied = () => jsonResponse(403, { error: { message: "ACL denied" } });

const PLUGIN = {
  id: "com.x",
  source: "com.x",
  name: "X",
  active: "true",
  version: "1",
};

test("collectTables returns sys_db_object rows; a failed read is unreadable", async () => {
  await withFetch(
    () =>
      jsonResponse(200, {
        result: [
          { name: "incident", label: "Incident", "super_class.name": "task" },
        ],
      }),
    async () => {
      const r = await collectTables();
      assert.deepEqual(r.unreadable, []);
      assert.equal(r.truncated, undefined);
      assert.equal(r.data[0].name, "incident");
      assert.equal(r.data[0].superClass, "task");
    },
  );
  freshRuntime();
  await withFetch(denied, async () => {
    const r = await collectTables({});
    assert.deepEqual(r.data, []);
    assert.deepEqual(r.unreadable, ["sys_db_object"]);
    assert.ok(r.errors.sys_db_object instanceof Error);
  });
});

test("collectSchema lists a table's columns; a failed read is unreadable", async () => {
  await withFetch(
    (url) => {
      if (tableOf(url) === "sys_db_object") {
        return jsonResponse(200, { result: [{ name: "incident" }] });
      }
      return jsonResponse(200, {
        result: [
          {
            element: "number",
            column_label: "Number",
            internal_type: "string",
            mandatory: "false",
            name: "incident",
          },
        ],
      });
    },
    async () => {
      const r = await collectSchema({}, "incident");
      assert.deepEqual(r.unreadable, []);
      assert.deepEqual(
        r.data.map((c) => c.element),
        ["number"],
      );
    },
  );
  freshRuntime();
  await withFetch(denied, async () => {
    const r = await collectSchema({}, "incident");
    assert.deepEqual(r.data, []);
    assert.deepEqual(r.unreadable, ["incident"]);
    assert.match(r.errors.incident.message, /403|ACL|denied/i);
  });
});

test("collectPlugins falls back to sys_plugins; unreadable only when all fail", async () => {
  assert.deepEqual([...PLUGIN_SOURCES], ["v_plugin", "sys_plugins"]);
  await withFetch(
    (url) =>
      tableOf(url) === "v_plugin"
        ? denied()
        : jsonResponse(200, { result: [PLUGIN] }),
    async () => {
      const r = await collectPlugins();
      assert.equal(r.data.source, "sys_plugins");
      assert.deepEqual(r.data.plugins, [
        { id: "com.x", name: "X", active: "true", version: "1" },
      ]);
      assert.deepEqual(r.unreadable, []);
      assert.ok(r.errors.v_plugin, "the failed primary source keeps its error");
    },
  );
  await withFetch(denied, async () => {
    const r = await collectPlugins();
    assert.equal(r.data, undefined);
    assert.deepEqual(r.unreadable, ["v_plugin", "sys_plugins"]);
  });
  // A narrowed source list (compare reads v_plugin only).
  await withFetch(denied, async (calls) => {
    const r = await collectPlugins({}, ["v_plugin"]);
    assert.deepEqual(r.unreadable, ["v_plugin"]);
    assert.equal(calls.length, 1);
  });
});

test("collectPlugins flags a capped read as truncated", async () => {
  await withEnv({ SN_MAX_RECORDS: "1" }, () =>
    withFetch(
      () => jsonResponse(200, { result: [PLUGIN] }),
      async () => {
        const r = await collectPlugins();
        assert.equal(r.truncated, true);
        assert.deepEqual(r.capped, ["v_plugin"]);
      },
    ),
  );
});

test("collectApps reads both tables, reports progress, leaves out an unreadable one", async () => {
  const seen = [];
  await withFetch(
    (url) =>
      tableOf(url) === "sys_store_app"
        ? denied()
        : jsonResponse(200, {
            result: [
              { name: "App", scope: "x_app", version: "1.0", active: "true" },
            ],
          }),
    async () => {
      const r = await collectApps({ progress: (m) => seen.push(m) });
      assert.deepEqual(Object.keys(r.data), ["sys_app"]);
      assert.equal(r.data.sys_app[0].scope, "x_app");
      assert.deepEqual(r.unreadable, ["sys_store_app"]);
      assert.equal(r.truncated, undefined);
    },
  );
  assert.deepEqual(
    seen,
    APP_SOURCES.map((t) => `apps: ${t}`),
  );
});

test("collectAutomation aggregates the given types; a failed type is null", async () => {
  const types = {
    business_rule: SCRIPT_TYPES.business_rule,
    script_include: SCRIPT_TYPES.script_include,
  };
  const seen = [];
  await withFetch(
    (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/sys_script_include")) return denied();
      return jsonResponse(200, {
        result: [
          {
            groupby_fields: [{ field: "active", value: "true" }],
            stats: {
              count: "3",
              max: { sys_updated_on: "2026-06-01 10:00:00" },
            },
          },
          {
            groupby_fields: [{ field: "active", value: "false" }],
            stats: {
              count: "1",
              max: { sys_updated_on: "2026-05-01 10:00:00" },
            },
          },
        ],
      });
    },
    async () => {
      const r = await collectAutomation(
        { progress: (m) => seen.push(m) },
        types,
      );
      assert.deepEqual(r.data.business_rule, {
        table: "sys_script",
        total: 4,
        active: 3,
        lastUpdated: "2026-06-01 10:00:00",
      });
      assert.equal(r.data.script_include, null);
      assert.deepEqual(r.unreadable, ["script_include"]);
      assert.ok(r.errors.script_include);
    },
  );
  assert.deepEqual(seen, [
    "automation: business_rule",
    "automation: script_include",
  ]);
});

test("collectRecordSection redacts secrets, hashes ACL scripts, flags truncation", async () => {
  await withFetch(
    () =>
      jsonResponse(200, {
        result: [
          {
            sys_id: "p1",
            name: "glide.ui.title",
            type: "string",
            value: "Dev",
          },
          { sys_id: "p2", name: "x.api_key", type: "string", value: "s3cr3t" },
          { sys_id: "p3", name: "x.login", type: "password2", value: "enc" },
        ],
      }),
    async () => {
      const r = await collectRecordSection({}, "properties");
      assert.deepEqual(
        r.data.map((p) => p.value),
        ["Dev", "[redacted]", "[redacted]"],
      );
      assert.deepEqual(r.unreadable, []);
    },
  );
  await withEnv({ SN_MAX_RECORDS: "1" }, () =>
    withFetch(
      () =>
        jsonResponse(200, {
          result: [
            { sys_id: "a1", name: "incident", operation: "read", script: "x" },
          ],
        }),
      async () => {
        const r = await collectRecordSection({}, "acls");
        assert.equal(r.truncated, true);
        assert.deepEqual(r.capped, ["sys_security_acl"]);
        assert.equal(r.data[0].script, undefined);
        assert.match(r.data[0].script_hash, /^[0-9a-f]{16}$/);
      },
    ),
  );
  await withFetch(denied, async () => {
    const r = await collectRecordSection({}, "roles");
    assert.deepEqual(r.data, []);
    assert.deepEqual(r.unreadable, ["sys_user_role"]);
  });
});

test("every collector throws CANCELLED on an aborted signal", async () => {
  const signal = AbortSignal.abort();
  await withFetch(
    () => jsonResponse(200, { result: [] }),
    async (calls) => {
      for (const run of [
        () => collectTables({ signal }),
        () => collectSchema({ signal }, "incident"),
        () => collectPlugins({ signal }),
        () => collectApps({ signal }),
        () => collectAutomation({ signal }),
        () => collectRecordSection({ signal }, "roles"),
      ]) {
        await assert.rejects(run, (e) => e.code === "CANCELLED");
      }
      assert.equal(calls.length, 0, "nothing is read after the abort");
    },
  );
});

test("a signal aborted mid-run stops the collector and keeps the call context", async () => {
  const controller = new AbortController();
  await withFetch(
    () => {
      controller.abort();
      return jsonResponse(200, { result: [] });
    },
    async (calls) => {
      await runWithCall({ requestId: "r1", tool: "t" }, () =>
        assert.rejects(
          collectApps({ signal: controller.signal }),
          (e) => e.code === "CANCELLED",
        ),
      );
      assert.equal(calls.length, 1, "the second table is not read");
    },
  );
});

test("snParams skips empty values, keeps 0, joins lists", async () => {
  const { snParams } = await import("../build/api/shared.js");
  const p = snParams({
    sysparm_query: "active=true",
    sysparm_text: "",
    sysparm_limit: 0,
    sysparm_offset: undefined,
    sysparm_fields: ["a", "b"],
    sysparm_group_by: [],
    sysparm_count: true,
    sysparm_no_count: false,
    sysparm_view: null,
  });
  assert.equal(
    p.toString(),
    "sysparm_query=active%3Dtrue&sysparm_limit=0&sysparm_fields=a%2Cb&sysparm_count=true",
  );
});
