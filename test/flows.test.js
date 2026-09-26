import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  traceTableEvent,
  listFlows,
  getFlow,
  getFlowRuns,
} from "../build/api/flows.js";
import { ServiceNowError } from "../build/core/errors.js";
import { clearSchemaCache } from "../build/core/cache.js";
import { baselineEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

// getTableChain is cached with the schema reads (S-1); every trace test
// starts from a cold cache so its own sys_db_object fake is what it sees.
beforeEach(() => clearSchemaCache());

const tableOf = (url) => {
  const m = /\/api\/now\/table\/([^/?]+)/.exec(url);
  return m ? m[1] : "";
};
const queryOf = (url) =>
  new URL(url, "https://x").searchParams.get("sysparm_query") || "";

/** sys_db_object answers for the incident → task chain. */
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

const RULES_QUERY =
  /^collectionINincident,task\^ORglobal=true\^active=true\^when=\w+\^action_\w+=true\^ORDERBYorder$/;

test("traceTableEvent builds the ordered chain with a Mermaid flowchart (FT-2)", async () => {
  await withFetch(
    (url) => {
      const table = tableOf(url);
      const q = queryOf(url);
      if (table === "sys_db_object") return chainResponse(q);
      if (table === "sys_script") {
        if (/when=before/.test(q))
          return jsonResponse(200, {
            result: [
              {
                sys_id: "b1",
                name: "Set defaults",
                order: "100",
                when: "before",
                condition: "priority=1",
                collection: "incident",
                global: "false",
              },
            ],
          });
        if (/when=after/.test(q))
          return jsonResponse(200, {
            result: [
              {
                sys_id: "a1",
                name: "Notify group",
                order: "200",
                when: "after",
                collection: "incident",
                global: "false",
              },
            ],
          });
        return jsonResponse(200, { result: [] }); // display, async
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
    },
    async (calls) => {
      const trace = await traceTableEvent("incident", "update");
      const phases = trace.chain.map((c) => c.phase);
      // before precedes database, which precedes after/async/flow/notification.
      assert.ok(phases.indexOf("before") < phases.indexOf("database"));
      assert.ok(phases.indexOf("database") < phases.indexOf("after"));
      assert.ok(phases.includes("flow"));
      assert.ok(phases.includes("notification"));
      const before = trace.chain.find((c) => c.phase === "before");
      assert.equal(before.name, "Set defaults");
      assert.equal(before.condition, "priority=1");
      assert.match(trace.mermaid, /^flowchart TD/);
      assert.match(trace.mermaid, /database write/);
      assert.equal(trace.warnings.length, 0);
      // Every rule query covers the whole chain plus the global rules (S-1).
      const ruleQueries = calls
        .filter((c) => tableOf(c.url) === "sys_script")
        .map((c) => queryOf(c.url));
      assert.equal(ruleQueries.length, 4); // display, before, after, async
      for (const q of ruleQueries) {
        assert.ok(q.includes("collectionINincident,task^ORglobal=true"), q);
        assert.ok(q.endsWith("ORDERBYorder"), q);
        assert.match(q, RULES_QUERY);
      }
      // Flows and notifications are resolved across the chain too.
      const flowQuery = calls
        .filter((c) => tableOf(c.url) === "sys_hub_trigger_instance")
        .map((c) => queryOf(c.url));
      assert.deepEqual(flowQuery, [
        "table_nameINincident,task^flow.active=true",
      ]);
      const notificationQuery = calls
        .filter((c) => tableOf(c.url) === "sysevent_email_action")
        .map((c) => queryOf(c.url));
      assert.deepEqual(notificationQuery, [
        "collectionINincident,task^active=true",
      ]);
    },
  );
});

test("traceTableEvent rejects a caret in the table before any request (FT-2)", async () => {
  await withFetch(
    () => {
      throw new Error("fetch must not run for a caret table");
    },
    async (calls) => {
      await assert.rejects(
        traceTableEvent("incident^active=true", "update"),
        (err) =>
          err instanceof ServiceNowError && /cannot contain/.test(err.message),
      );
      assert.equal(calls.length, 0);
    },
  );
});

test("a failing section becomes a warning, not a failed trace (FT-2)", async () => {
  await withFetch(
    (url) => {
      if (tableOf(url) === "wf_workflow")
        return jsonResponse(403, { error: { message: "no access" } });
      return jsonResponse(200, { result: [] });
    },
    async () => {
      const trace = await traceTableEvent("incident", "insert");
      assert.ok(trace.warnings.some((w) => /workflows/.test(w)));
      // The database step is always present even when everything else is empty.
      assert.ok(trace.chain.some((c) => c.phase === "database"));
    },
  );
});

test("an incident trace sees task and global rules in order (S-1)", async () => {
  await withFetch(
    (url) => {
      const table = tableOf(url);
      const q = queryOf(url);
      if (table === "sys_db_object") return chainResponse(q);
      if (table === "sys_script") {
        if (/when=before/.test(q))
          // Shuffled on purpose: the trace must sort by `order` itself.
          return jsonResponse(200, {
            result: [
              {
                sys_id: "g1",
                name: "Global audit",
                order: "150",
                when: "before",
                collection: "global",
                global: "true",
              },
              {
                sys_id: "i1",
                name: "Incident defaults",
                order: "100",
                when: "before",
                collection: "incident",
                global: "false",
              },
              {
                sys_id: "t1",
                name: "Task SLA",
                order: "50",
                when: "before",
                collection: "task",
                global: "false",
              },
            ],
          });
        return jsonResponse(200, { result: [] });
      }
      return jsonResponse(200, { result: [] });
    },
    async () => {
      const trace = await traceTableEvent("incident", "insert");
      assert.deepEqual(trace.tables, ["incident", "task"]);
      const before = trace.chain.filter((c) => c.phase === "before");
      assert.deepEqual(
        before.map((c) => c.name),
        ["Task SLA", "Incident defaults", "Global audit"],
      );
      const [taskRule, incidentRule, globalRule] = before;
      assert.equal(taskRule.table, "task");
      assert.equal(taskRule.inherited_from, "task");
      assert.equal(taskRule.global, undefined);
      assert.equal(incidentRule.table, "incident");
      assert.equal(incidentRule.inherited_from, undefined);
      assert.equal(incidentRule.global, undefined);
      assert.equal(globalRule.global, true);
      assert.equal(globalRule.table, "global");
      assert.equal(globalRule.inherited_from, undefined);
      assert.ok(trace.mermaid.includes("Task SLA · task"), trace.mermaid);
      assert.ok(trace.mermaid.includes("Global audit · global"), trace.mermaid);
      assert.ok(!trace.mermaid.includes("Incident defaults ·"), trace.mermaid);
      assert.equal(trace.warnings.length, 0);
    },
  );
});

test("flow triggers are filtered by the traced operation (S-1)", async () => {
  const triggers = [
    {
      flow: "f1",
      "flow.name": "On create",
      table_name: "incident",
      trigger_type: "record_create",
    },
    {
      flow: "f2",
      "flow.name": "On update",
      table_name: "incident",
      trigger_type: "record_update",
    },
    {
      flow: "f3",
      "flow.name": "On either",
      table_name: "incident",
      trigger_type: "record_create_or_update",
    },
    {
      flow: "f4",
      "flow.name": "Odd trigger",
      table_name: "incident",
      trigger_type: "something_else",
    },
    {
      flow: "f5",
      "flow.name": "Task update",
      table_name: "task",
      trigger_type: "record_update",
    },
  ];
  const handler = (url) => {
    const table = tableOf(url);
    if (table === "sys_db_object") return chainResponse(queryOf(url));
    if (table === "sys_hub_trigger_instance")
      return jsonResponse(200, { result: triggers });
    return jsonResponse(200, { result: [] });
  };
  await withFetch(handler, async (calls) => {
    const trace = await traceTableEvent("incident", "update");
    const flows = trace.chain.filter((c) => c.phase === "flow");
    assert.deepEqual(
      flows.map((c) => c.name),
      ["On update", "On either", "Odd trigger", "Task update"],
    );
    const taskFlow = flows.find((c) => c.name === "Task update");
    assert.equal(taskFlow.table, "task");
    assert.equal(taskFlow.inherited_from, "task");
    assert.equal(
      flows.find((c) => c.name === "On update").inherited_from,
      undefined,
    );
    assert.ok(calls.some((c) => tableOf(c.url) === "sys_hub_trigger_instance"));
  });
  clearSchemaCache();
  await withFetch(handler, async (calls) => {
    const trace = await traceTableEvent("incident", "query");
    assert.equal(trace.chain.filter((c) => c.phase === "flow").length, 0);
    assert.equal(trace.chain.filter((c) => c.phase === "workflow").length, 0);
    // Nothing record-triggered fires on a read, so the triggers are not read.
    assert.ok(
      !calls.some((c) => tableOf(c.url) === "sys_hub_trigger_instance"),
    );
    assert.ok(!calls.some((c) => tableOf(c.url) === "wf_workflow"));
  });
});

test("notifications are filtered by the traced operation (S-1)", async () => {
  const notifications = [
    {
      sys_id: "n1",
      name: "On insert",
      collection: "incident",
      action_insert: "true",
      action_update: "false",
      event_name: "",
    },
    {
      sys_id: "n2",
      name: "On update",
      collection: "incident",
      action_insert: "false",
      action_update: "true",
      event_name: "",
    },
    {
      sys_id: "n3",
      name: "On event",
      collection: "task",
      action_insert: "false",
      action_update: "false",
      event_name: "task.assigned",
    },
  ];
  const handler = (url) => {
    const table = tableOf(url);
    if (table === "sys_db_object") return chainResponse(queryOf(url));
    if (table === "sysevent_email_action")
      return jsonResponse(200, { result: notifications });
    if (table === "wf_workflow")
      return jsonResponse(200, {
        result: [{ sys_id: "w1", name: "Legacy approval", condition: "" }],
      });
    return jsonResponse(200, { result: [] });
  };
  await withFetch(handler, async () => {
    const trace = await traceTableEvent("incident", "insert");
    const names = trace.chain
      .filter((c) => c.phase === "notification")
      .map((c) => c.name);
    assert.deepEqual(names, ["On insert", "On event"]);
    const onEvent = trace.chain.find((c) => c.name === "On event");
    assert.equal(onEvent.condition, "on task.assigned");
    assert.equal(onEvent.inherited_from, "task");
    const workflow = trace.chain.find((c) => c.phase === "workflow");
    assert.equal(workflow.name, "Legacy approval");
    assert.equal(workflow.table, "incident");
  });
  clearSchemaCache();
  await withFetch(handler, async () => {
    const trace = await traceTableEvent("incident", "delete");
    const names = trace.chain
      .filter((c) => c.phase === "notification")
      .map((c) => c.name);
    assert.deepEqual(names, ["On event"]);
    assert.equal(trace.chain.filter((c) => c.phase === "workflow").length, 0);
  });
});

test("a failing table-chain lookup falls back to the table alone with a warning (S-1)", async () => {
  await withFetch(
    (url) => {
      if (tableOf(url) === "sys_db_object")
        return jsonResponse(403, {
          error: { message: "no dictionary access" },
        });
      return jsonResponse(200, { result: [] });
    },
    async (calls) => {
      const trace = await traceTableEvent("incident", "update");
      assert.deepEqual(trace.tables, ["incident"]);
      assert.ok(
        trace.warnings.some((w) => /table chain/.test(w)),
        trace.warnings,
      );
      assert.ok(
        trace.warnings.some((w) => /tracing incident alone/.test(w)),
        trace.warnings,
      );
      const ruleQueries = calls
        .filter((c) => tableOf(c.url) === "sys_script")
        .map((c) => queryOf(c.url));
      assert.ok(ruleQueries.length > 0);
      for (const q of ruleQueries)
        assert.ok(q.startsWith("collectionINincident^ORglobal=true^"), q);
    },
  );
});

test("listFlows reads sys_hub_flow and maps metadata (FT-1)", async () => {
  await withFetch(
    (url) => {
      assert.equal(tableOf(url), "sys_hub_flow");
      return jsonResponse(200, {
        result: [
          {
            sys_id: "f1",
            name: "Onboarding",
            active: "true",
            description: "x",
          },
        ],
      });
    },
    async () => {
      const { kind, count, flows } = await listFlows({ active: true });
      assert.equal(kind, "flow");
      assert.equal(count, 1);
      assert.equal(flows[0].name, "Onboarding");
    },
  );
});

test("getFlow assembles trigger + ordered steps (FT-1)", async () => {
  await withFetch(
    (url) => {
      const table = tableOf(url);
      if (table === "sys_hub_flow")
        return jsonResponse(200, {
          result: { sys_id: "f1", name: "SLA flow", active: "true" },
        });
      if (table === "sys_hub_trigger_instance")
        return jsonResponse(200, {
          result: [
            {
              table_name: "incident",
              trigger_type: "record_update",
              condition: "active=true",
            },
          ],
        });
      if (table === "sys_hub_action_instance")
        return jsonResponse(200, {
          result: [
            {
              order: "1",
              action_type: "at1",
              "action_type.name": "Create Task",
            },
            {
              order: "2",
              action_type: "at2",
              "action_type.name": "Send Notification",
            },
          ],
        });
      throw new Error("unexpected " + table);
    },
    async () => {
      const flow = await getFlow("f1");
      assert.equal(flow.name, "SLA flow");
      assert.equal(flow.trigger.table, "incident");
      assert.equal(flow.steps.length, 2);
      assert.equal(flow.steps[0].action, "Create Task");
    },
  );
});

test("getFlowRuns needs a flow or record, then reads sys_flow_context (FT-3)", async () => {
  await withFetch(
    () => {
      throw new Error("fetch must not run without a filter");
    },
    async (calls) => {
      await assert.rejects(
        getFlowRuns({}),
        (err) => err instanceof ServiceNowError && err.status === 400,
      );
      assert.equal(calls.length, 0);
    },
  );

  await withFetch(
    (url) => {
      assert.equal(tableOf(url), "sys_flow_context");
      assert.match(queryOf(url), /document_id=rec1/);
      return jsonResponse(200, {
        result: [
          {
            sys_id: "c1",
            name: "SLA flow",
            state: "Complete",
            document_id: "rec1",
            sys_created_on: "2026-01-01",
          },
        ],
      });
    },
    async () => {
      const { count, runs } = await getFlowRuns({ record: "rec1" });
      assert.equal(count, 1);
      assert.equal(runs[0].state, "Complete");
      assert.equal(runs[0].recordId, "rec1");
    },
  );
});
