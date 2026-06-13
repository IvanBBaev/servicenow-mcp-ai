import test from "node:test";
import assert from "node:assert/strict";

import { listTables, describeTable, getTableChain } from "../build/api/meta.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

/** Dispatch mock: a two-level inheritance chain incident -> task. */
const dictRows = [
  {
    name: "task",
    element: "assigned_to",
    column_label: "Assigned to",
    internal_type: "reference",
    reference: "sys_user",
    mandatory: "false",
    max_length: "32",
  },
  {
    name: "task",
    element: "short_description",
    column_label: "Short description",
    internal_type: "string",
    mandatory: "false",
    max_length: "160",
  },
  // Child override of the parent's entry: mandatory flips to true.
  {
    name: "incident",
    element: "short_description",
    column_label: "Short description",
    internal_type: "string",
    mandatory: "true",
    max_length: "160",
  },
  {
    name: "incident",
    element: "severity",
    column_label: "Severity",
    internal_type: "integer",
    mandatory: "false",
  },
];

function chainHandler(url) {
  const u = new URL(url);
  const q = u.searchParams.get("sysparm_query") ?? "";
  if (u.pathname.includes("/table/sys_db_object")) {
    if (q.startsWith("name=incident")) {
      return jsonResponse(200, {
        result: [{ name: "incident", "super_class.name": "task" }],
      });
    }
    if (q.startsWith("name=task")) {
      // No super_class.name => root of the chain.
      return jsonResponse(200, { result: [{ name: "task" }] });
    }
    return jsonResponse(200, { result: [] });
  }
  if (u.pathname.includes("/table/sys_dictionary")) {
    assert.match(q, /^nameINincident,task\^elementISNOTEMPTY/);
    return jsonResponse(200, { result: dictRows });
  }
  throw new Error(`unexpected request: ${url}`);
}

test("getTableChain walks super_class to the root, child first", async () => {
  await withFetch(chainHandler, async () => {
    assert.deepEqual(await getTableChain("incident"), ["incident", "task"]);
  });
});

test("getTableChain returns just the table itself when unknown", async () => {
  await withFetch(chainHandler, async () => {
    assert.deepEqual(await getTableChain("no_such_table"), ["no_such_table"]);
  });
});

test("describeTable merges inherited columns and lets the child override", async () => {
  await withFetch(chainHandler, async () => {
    const columns = await describeTable("incident");
    assert.deepEqual(
      columns.map((c) => c.element),
      ["assigned_to", "severity", "short_description"],
    );

    const byName = Object.fromEntries(columns.map((c) => [c.element, c]));
    // Inherited from task.
    assert.equal(byName.assigned_to.sourceTable, "task");
    assert.equal(byName.assigned_to.reference, "sys_user");
    // Defined on incident only.
    assert.equal(byName.severity.sourceTable, "incident");
    // Overridden on incident: the child's row wins.
    assert.equal(byName.short_description.sourceTable, "incident");
    assert.equal(byName.short_description.mandatory, true);
  });
});

test("schema reads are cached with TTL; 0 disables (О-3)", async () => {
  const handler = () =>
    jsonResponse(200, { result: [{ name: "x", label: "X" }] });

  // Default TTL (300s): the second identical read is served from the cache.
  await withFetch(handler, async (calls) => {
    await listTables("cache-probe-on");
    await listTables("cache-probe-on");
    assert.equal(calls.length, 1);
  });

  // TTL 0: caching off, every read hits the instance.
  await withEnv({ SN_SCHEMA_CACHE_TTL_SEC: "0" }, () =>
    withFetch(handler, async (calls) => {
      await listTables("cache-probe-off");
      await listTables("cache-probe-off");
      assert.equal(calls.length, 2);
    }),
  );
});

test("listTables resolves superClass via dot-walk to the parent's name", async () => {
  await withFetch(
    (url) => {
      const u = new URL(url);
      assert.ok(u.pathname.includes("/table/sys_db_object"));
      assert.match(
        u.searchParams.get("sysparm_fields") ?? "",
        /super_class\.name/,
      );
      return jsonResponse(200, {
        result: [
          { name: "incident", label: "Incident", "super_class.name": "task" },
          { name: "task", label: "Task" },
        ],
      });
    },
    async () => {
      const tables = await listTables();
      assert.deepEqual(tables, [
        { name: "incident", label: "Incident", superClass: "task" },
        { name: "task", label: "Task", superClass: undefined },
      ]);
    },
  );
});

test("listTables rejects a '^' in the filter before any request (DEV-1)", async () => {
  await withFetch(
    () => {
      throw new Error("fetch must not run for a caret filter");
    },
    async (calls) => {
      await assert.rejects(listTables("incident^active=false"), (err) =>
        /cannot contain '\^'/.test(err.message),
      );
      assert.equal(calls.length, 0);
    },
  );
});
