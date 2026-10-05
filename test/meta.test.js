import test from "node:test";
import assert from "node:assert/strict";

import {
  listTables,
  describeTable,
  describeTableDetails,
  describeTableIndexes,
  getTableChain,
} from "../build/api/meta.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import { runSpec } from "../build/mcp/define.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

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

test("describeTable reads display-value pairs (C-4)", async () => {
  // A table name no other test uses, so the schema cache cannot interfere.
  await withFetch(
    (url) => {
      const u = new URL(url);
      if (u.pathname.includes("/table/sys_db_object")) {
        return jsonResponse(200, { result: [{ name: "u_pair" }] });
      }
      return jsonResponse(200, {
        result: [
          {
            name: { value: "u_pair", display_value: "Pair" },
            element: { value: "u_code", display_value: "u_code" },
            internal_type: { value: "string", display_value: "String" },
            mandatory: { value: "true", display_value: "Yes" },
            max_length: { value: "40", display_value: "40" },
          },
          {
            name: "u_pair",
            element: "u_note",
            internal_type: "string",
            mandatory: { value: "false", display_value: "No" },
          },
        ],
      });
    },
    async () => {
      const columns = await describeTable("u_pair");
      const byName = Object.fromEntries(columns.map((c) => [c.element, c]));
      assert.equal(byName.u_code.mandatory, true);
      assert.equal(byName.u_code.maxLength, 40);
      assert.equal(byName.u_note.mandatory, false);
    },
  );
});

test("schema reads are cached with TTL; 0 disables (O-3)", async () => {
  const handler = () =>
    jsonResponse(200, { result: [{ name: "x", label: "X" }] });

  // Default TTL (300s): the second identical read is served from the cache.
  await withFetch(handler, async (calls) => {
    // One read = the page plus the end-of-data probe (no X-Total-Count here).
    await listTables("cache-probe-on");
    const perRead = calls.length;
    await listTables("cache-probe-on");
    assert.equal(calls.length, perRead);
  });

  // TTL 0: caching off, every read hits the instance.
  await withEnv({ SN_SCHEMA_CACHE_TTL_SEC: "0" }, () =>
    withFetch(handler, async (calls) => {
      await listTables("cache-probe-off");
      const perRead = calls.length;
      await listTables("cache-probe-off");
      assert.equal(calls.length, perRead * 2);
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

test("describeTable rejects a '^' in the table name before any request (DEV-6)", async () => {
  await withFetch(
    () => {
      throw new Error("fetch must not run for a caret table name");
    },
    async (calls) => {
      await assert.rejects(describeTable("incident^ORDERBYsys_id"), (err) =>
        /cannot contain '\^'/.test(err.message),
      );
      assert.equal(calls.length, 0);
    },
  );
});

/** S-7: a u_det -> u_base chain with choices on both levels and overrides. */
function detailsHandler({ failOverrides = false } = {}) {
  return (url) => {
    const u = new URL(url);
    const q = u.searchParams.get("sysparm_query") ?? "";
    if (u.pathname.includes("/table/sys_db_object")) {
      if (q.startsWith("name=u_det")) {
        return jsonResponse(200, {
          result: [{ name: "u_det", "super_class.name": "u_base" }],
        });
      }
      return jsonResponse(200, { result: [{ name: "u_base" }] });
    }
    if (u.pathname.includes("/table/sys_choice")) {
      assert.match(q, /^nameINu_det,u_base\^inactive=false\^language=en/);
      return jsonResponse(200, {
        result: [
          { name: "u_base", element: "state", value: "9", label: "Base" },
          { name: "u_det", element: "state", value: "1", label: "New" },
          { name: "u_det", element: "state", value: "2", label: "Done" },
          { name: "u_base", element: "gone", value: "x", label: "X" },
        ],
      });
    }
    if (u.pathname.includes("/table/sys_dictionary_override")) {
      if (failOverrides) return jsonResponse(403, { error: { message: "no" } });
      return jsonResponse(200, {
        result: [
          {
            name: "u_det",
            element: "state",
            default_value_override: "true",
            default_value: "1",
            mandatory_override: "true",
            mandatory: "true",
            read_only_override: "false",
            read_only: "true",
          },
        ],
      });
    }
    if (u.pathname.includes("/table/sys_dictionary")) {
      return jsonResponse(200, {
        result: [
          {
            name: "u_base",
            element: "state",
            internal_type: "integer",
            mandatory: "false",
            default_value: "9",
            read_only: "true",
            unique: "false",
            display: "false",
            choice: "3",
          },
          {
            name: "u_base",
            element: "number",
            internal_type: "string",
            mandatory: "false",
            unique: "true",
            display: "true",
            choice: "0",
          },
        ],
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };
}

test("describeTableDetails adds choices (nearest table wins) and overrides (S-7)", async () => {
  await withFetch(detailsHandler(), async () => {
    const { columns, warnings } = await describeTableDetails("u_det");
    assert.deepEqual(warnings, []);
    const byName = Object.fromEntries(columns.map((c) => [c.element, c]));
    assert.equal(byName.state.defaultValue, "9");
    assert.equal(byName.state.readOnly, true);
    assert.equal(byName.state.choice, "3");
    assert.equal(byName.number.unique, true);
    assert.equal(byName.number.display, true);
    assert.equal(byName.number.choice, undefined);
    assert.deepEqual(byName.state.choices, [
      { value: "1", label: "New" },
      { value: "2", label: "Done" },
    ]);
    assert.deepEqual(byName.state.overrides, [
      { table: "u_det", defaultValue: "1", mandatory: true },
    ]);
    // describeTable itself stays lean.
    const plain = await describeTable("u_det");
    assert.equal(plain.find((c) => c.element === "state").choices, undefined);
  });
});

test("describeTableDetails turns an unreadable table into a warning", async () => {
  await withEnv({ SN_SCHEMA_CACHE_TTL_SEC: "0" }, () =>
    withFetch(detailsHandler({ failOverrides: true }), async () => {
      const { columns, warnings } = await describeTableDetails("u_det");
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /^sys_dictionary_override: unavailable/);
      assert.ok(columns.find((c) => c.element === "state").choices);
    }),
  );
});

/** N-15: the S-7 chain plus sys_index rows on both levels and a row count. */
function indexHandler({ failIndex = false, failStats = false } = {}) {
  const details = detailsHandler();
  return (url) => {
    const u = new URL(url);
    const q = u.searchParams.get("sysparm_query") ?? "";
    if (u.pathname.includes("/table/sys_index")) {
      if (failIndex) return jsonResponse(403, { error: { message: "no" } });
      assert.match(q, /^logical_table_nameINu_det,u_base\^ORDERBYname/);
      return jsonResponse(200, {
        result: [
          {
            name: "u_base_number",
            logical_table_name: "u_base",
            col_name: "number",
            unique_index: "true",
          },
          {
            name: "u_det_state_opened",
            logical_table_name: "u_det",
            col_name: "state, opened_at",
            unique_index: "false",
          },
          { name: "empty", logical_table_name: "u_det", col_name: "" },
        ],
      });
    }
    if (u.pathname.endsWith("/stats/u_det")) {
      if (failStats) return jsonResponse(403, { error: { message: "no" } });
      assert.equal(u.searchParams.get("sysparm_count"), "true");
      return jsonResponse(200, { result: { stats: { count: "12345" } } });
    }
    return details(url);
  };
}

test("describeTableIndexes reads the chain's indexes and a row estimate (N-15)", async () => {
  await withEnv({ SN_SCHEMA_CACHE_TTL_SEC: "0" }, () =>
    withFetch(indexHandler(), async () => {
      const r = await describeTableIndexes("u_det");
      assert.deepEqual(r.warnings, []);
      assert.equal(r.rowEstimate, 12345);
      assert.deepEqual(r.indexes, [
        {
          name: "u_base_number",
          table: "u_base",
          fields: ["number"],
          unique: true,
        },
        {
          name: "u_det_state_opened",
          table: "u_det",
          fields: ["state", "opened_at"],
          unique: false,
        },
      ]);
    }),
  );
});

test("describeTableIndexes turns unreadable index / stats reads into warnings", async () => {
  await withEnv({ SN_SCHEMA_CACHE_TTL_SEC: "0" }, () =>
    withFetch(indexHandler({ failIndex: true, failStats: true }), async () => {
      const r = await describeTableIndexes("u_det");
      assert.deepEqual(r.indexes, []);
      assert.equal(r.rowEstimate, undefined);
      assert.equal(r.warnings.length, 2);
      assert.match(r.warnings[0], /^sys_index: unavailable/);
      assert.match(r.warnings[1], /^row count: unavailable/);
    }),
  );
  await assert.rejects(describeTableIndexes("u_det^x"), /cannot contain/);
});

test("describe_table details:true carries indexes and rowEstimate (N-15)", async () => {
  freshRuntime();
  const call = (args) =>
    runSpec(
      ALL_TOOLS.find((s) => s.name === "servicenow_describe_table"),
      args,
    );
  await withEnv({ SN_SCHEMA_CACHE_TTL_SEC: "0" }, () =>
    withFetch(indexHandler(), async () => {
      const lean = JSON.parse((await call({ table: "u_det" })).content[0].text);
      assert.equal(lean.indexes, undefined);
      const res = await call({ table: "u_det", details: true });
      assert.equal(res.isError, undefined);
      const body = JSON.parse(res.content[0].text);
      assert.equal(body.rowEstimate, 12345);
      assert.deepEqual(
        body.indexes.map((i) => i.name),
        ["u_base_number", "u_det_state_opened"],
      );
      assert.deepEqual(body.warnings, []);
      assert.equal(res.structuredContent.rowEstimate, 12345);
    }),
  );
});
