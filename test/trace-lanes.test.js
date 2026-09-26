import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  TRACE_LANES,
  traceTableEvent,
  traceTableFlow,
} from "../build/api/flows.js";
import { generateTableFlow } from "../build/api/diagrams.js";
import { ServiceNowError } from "../build/core/errors.js";
import { clearSchemaCache } from "../build/core/cache.js";
import { baselineEnv, withFetch, jsonResponse } from "./helpers.js";
import { lintMermaid } from "./mermaid-lint.js";

/** S-5 — the opt-in trace lanes. */

baselineEnv();
beforeEach(() => clearSchemaCache());

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

const LANE_RECORDS = {
  sys_script_client: [
    {
      sys_id: "c2",
      name: "Priority hint",
      type: "onChange",
      field: "priority",
      table: "incident",
    },
    {
      sys_id: "c1",
      name: "Form setup",
      type: "onLoad",
      field: "",
      table: "incident",
    },
    // A parent script that is not inherited never reaches an incident form.
    {
      sys_id: "c3",
      name: "Task only",
      type: "onLoad",
      table: "task",
      inherited: "false",
    },
    {
      sys_id: "c4",
      name: "Task shared",
      type: "onSubmit",
      table: "task",
      inherited: "true",
    },
  ],
  sys_ui_policy: [
    {
      sys_id: "u2",
      short_description: "Lock closed",
      conditions: "state=7",
      table: "incident",
      order: "200",
      on_load: "false",
    },
    {
      sys_id: "u1",
      short_description: "Show caller",
      conditions: "",
      table: "task",
      inherit: "true",
      order: "100",
      on_load: "true",
    },
  ],
  sys_data_policy2: [
    {
      sys_id: "d1",
      short_description: "Close notes required",
      conditions: "state=7",
      model_table: "incident",
    },
    {
      sys_id: "d2",
      short_description: "Task only policy",
      model_table: "task",
      inherit: "false",
    },
  ],
  contract_sla: [
    {
      sys_id: "s1",
      name: "P1 resolution",
      collection: "incident",
      start_condition: "priority=1",
    },
  ],
  sysevent_register: [
    { event_name: "incident.assigned", table: "incident" },
    { event_name: "task.closed", table: "task" },
    { event_name: "bad^name", table: "incident" },
  ],
  sysevent_script_action: [
    {
      sys_id: "e1",
      name: "Log assignment",
      event_name: "incident.assigned",
      order: "100",
    },
    { sys_id: "e2", name: "Close children", event_name: "task.closed" },
  ],
  sys_transform_map: [
    { sys_id: "t1", name: "Legacy import", source_table: "u_legacy_inc" },
  ],
  sysauto_script: [
    { sys_id: "j1", name: "Nightly incident cleanup", run_type: "daily" },
  ],
};

/** A backend answering every lane; `reverse` flips each lane's row order. */
const laneFetch =
  (reverse = false) =>
  (url) => {
    const table = tableOf(url);
    if (table === "sys_db_object") return chainResponse(queryOf(url));
    const rows = LANE_RECORDS[table];
    if (rows)
      return jsonResponse(200, {
        result: reverse ? [...rows].reverse() : rows,
      });
    return jsonResponse(200, { result: [] });
  };

const LANE_TABLES = new Set(Object.keys(LANE_RECORDS));

test("a trace without lanes reads none of the lane tables and has no lanes key", async () => {
  await withFetch(laneFetch(), async (calls) => {
    const trace = await traceTableEvent("incident", "update");
    assert.equal("lanes" in trace, false);
    assert.ok(!calls.some((c) => LANE_TABLES.has(tableOf(c.url))));
  });
});

test("every lane lands in its phase, in execution order, with its origin", async () => {
  await withFetch(laneFetch(), async (calls) => {
    const trace = await traceTableEvent("incident", "update", {
      lanes: [...TRACE_LANES].reverse(),
    });
    // Normalised to TRACE_LANES order whatever order the caller used.
    assert.deepEqual(trace.lanes, [...TRACE_LANES]);
    assert.deepEqual(trace.warnings, []);
    const phases = [...new Set(trace.chain.map((c) => c.phase))];
    assert.deepEqual(phases, [
      "transform_map",
      "scheduled_job",
      "client",
      "data_policy",
      "database",
      "sla",
      "event_script",
    ]);
    const names = (phase) =>
      trace.chain.filter((c) => c.phase === phase).map((c) => c.name);
    // Client scripts (by name, the non-inherited parent one dropped), then
    // UI policies by order.
    assert.deepEqual(names("client"), [
      "Form setup",
      "Priority hint",
      "Task shared",
      "Show caller",
      "Lock closed",
    ]);
    const hint = trace.chain.find((c) => c.name === "Priority hint");
    assert.equal(hint.type, "client_script");
    assert.equal(hint.condition, "onChange of priority");
    const caller = trace.chain.find((c) => c.name === "Show caller");
    assert.equal(caller.type, "ui_policy");
    assert.equal(caller.inherited_from, "task");
    assert.deepEqual(names("data_policy"), ["Close notes required"]);
    assert.deepEqual(names("sla"), ["P1 resolution"]);
    assert.equal(
      trace.chain.find((c) => c.phase === "sla").condition,
      "priority=1",
    );
    assert.deepEqual(names("event_script"), [
      "Log assignment",
      "Close children",
    ]);
    const close = trace.chain.find((c) => c.name === "Close children");
    assert.equal(close.condition, "on task.closed");
    assert.equal(close.inherited_from, "task");
    assert.deepEqual(names("transform_map"), ["Legacy import"]);
    assert.equal(
      trace.chain.find((c) => c.phase === "transform_map").condition,
      "from u_legacy_inc",
    );
    assert.deepEqual(names("scheduled_job"), ["Nightly incident cleanup"]);

    const q = (table) =>
      calls.filter((c) => tableOf(c.url) === table).map((c) => queryOf(c.url));
    assert.deepEqual(q("sys_script_client"), [
      "tableINincident,task^active=true^ORDERBYname",
    ]);
    assert.deepEqual(q("sys_data_policy2"), [
      "model_tableINincident,task^active=true^ORDERBYshort_description",
    ]);
    // The caret-bearing event name never reaches the IN list.
    assert.deepEqual(q("sysevent_script_action"), [
      "event_nameINincident.assigned,task.closed^active=true^ORDERBYorder",
    ]);
    assert.deepEqual(q("sys_transform_map"), [
      "target_table=incident^active=true^ORDERBYname",
    ]);
    assert.deepEqual(q("sysauto_script"), [
      "active=true^scriptLIKEincident^ORDERBYname",
    ]);

    lintMermaid(trace.mermaid);
    assert.match(trace.mermaid, /subgraph P_client/);
    assert.match(trace.mermaid, /subgraph P_event_script/);
  });
});

test("lanes are filtered by the traced operation", async () => {
  await withFetch(laneFetch(), async (calls) => {
    const trace = await traceTableEvent("incident", "query", {
      lanes: [...TRACE_LANES],
    });
    const names = (phase) =>
      trace.chain.filter((c) => c.phase === phase).map((c) => c.name);
    // A read keeps only what runs on form load; no write-side lanes.
    assert.deepEqual(names("client"), ["Form setup", "Show caller"]);
    assert.deepEqual(names("data_policy"), []);
    assert.deepEqual(names("sla"), []);
    assert.deepEqual(names("transform_map"), []);
    // Events and jobs are not tied to an operation.
    assert.equal(names("event_script").length, 2);
    assert.equal(names("scheduled_job").length, 1);
    for (const t of ["sys_data_policy2", "contract_sla", "sys_transform_map"])
      assert.ok(!calls.some((c) => tableOf(c.url) === t), t);
  });
});

test("a failing lane is a warning and the rest of the trace stands", async () => {
  await withFetch(
    (url) => {
      if (tableOf(url) === "contract_sla")
        return jsonResponse(403, { error: { message: "no SLA access" } });
      if (tableOf(url) === "sysevent_register")
        return jsonResponse(200, { result: [] });
      return laneFetch()(url);
    },
    async (calls) => {
      const trace = await traceTableEvent("incident", "insert", {
        lanes: ["sla", "data_policy", "event_script"],
      });
      assert.ok(
        trace.warnings.some((w) => /^SLA definitions: .*no SLA access/.test(w)),
        trace.warnings,
      );
      assert.equal(trace.chain.filter((c) => c.phase === "sla").length, 0);
      assert.equal(
        trace.chain.filter((c) => c.phase === "data_policy").length,
        1,
      );
      // No registered events: the script actions are not queried.
      assert.ok(
        !calls.some((c) => tableOf(c.url) === "sysevent_script_action"),
      );
    },
  );
});

test("an unknown lane is refused before any request", async () => {
  await withFetch(
    () => {
      throw new Error("fetch must not run");
    },
    async (calls) => {
      await assert.rejects(
        traceTableEvent("incident", "update", { lanes: ["audit"] }),
        (err) =>
          err instanceof ServiceNowError &&
          /Unknown lane "audit"/.test(err.message),
      );
      assert.equal(calls.length, 0);
    },
  );
});

test("the traced lanes are stable across backend row order (snapshot compare)", async () => {
  const run = (reverse) =>
    withFetch(laneFetch(reverse), async () => {
      clearSchemaCache();
      return traceTableEvent("incident", "update", {
        lanes: [...TRACE_LANES],
      });
    });
  const a = await run(false);
  const b = await run(true);
  assert.deepEqual(b.chain, a.chain);
  assert.equal(b.mermaid, a.mermaid);
});

test("generate_table_flow draws the lanes, for an operation and the lifecycle view", async () => {
  await withFetch(laneFetch(), async () => {
    const flow = await generateTableFlow("incident", {
      operation: "update",
      lanes: ["client", "sla"],
    });
    assert.deepEqual(flow.lanes, ["client", "sla"]);
    lintMermaid(flow.mermaid);
    assert.match(flow.mermaid, /client scripts and UI policies/);
    assert.match(flow.mermaid, /SLA definitions/);
    assert.match(flow.mermaid, /inherited from task/);
    // The client lane is drawn before the database write, SLAs after it.
    const at = (s) => flow.mermaid.indexOf(s);
    assert.ok(at("P_client") < at("database write"));
    assert.ok(at("database write") < at("P_sla"));
  });
  clearSchemaCache();
  await withFetch(
    (url) => {
      if (tableOf(url) === "sys_script")
        return jsonResponse(200, {
          result: [
            {
              sys_id: "b1",
              name: "Defaults",
              when: "before",
              order: "100",
              collection: "incident",
            },
          ],
        });
      return laneFetch()(url);
    },
    async () => {
      const lifecycle = await traceTableFlow("incident", undefined, {
        lanes: ["data_policy", "transform_map"],
      });
      assert.equal(lifecycle.operation, undefined);
      assert.deepEqual(lifecycle.lanes, ["transform_map", "data_policy"]);
      assert.equal(lifecycle.count, 3);
      const flow = await generateTableFlow("incident", {
        lanes: ["data_policy", "transform_map"],
      });
      lintMermaid(flow.mermaid);
      assert.equal(flow.warnings, undefined);
      const at = (s) => flow.mermaid.indexOf(s);
      assert.ok(at("P_transform_map") < at("P_before"));
      assert.ok(at("P_data_policy") < at("P_before"));
    },
  );
});
