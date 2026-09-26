import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import { generateErDiagram, generateTableFlow } from "../build/api/diagrams.js";
import { clearSchemaCache } from "../build/core/cache.js";
import { baselineEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

// The inheritance chain is cached with the schema reads (S-1); every test
// starts cold so its own sys_db_object fake is what it sees.
beforeEach(() => clearSchemaCache());

const isTable = (url, table) =>
  new RegExp(`/api/now/table/${table}(\\?|$)`).test(url);
const queryOf = (url) => new URL(url).searchParams.get("sysparm_query") || "";

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

test("generateErDiagram emits an entity and a reference relationship", async () => {
  await withFetch(
    (url) => {
      // describeTable now resolves the inheritance chain first; an empty
      // sys_db_object answer means "no parent", so the chain is just incident.
      if (/\/api\/now\/table\/sys_db_object(\?|$)/.test(url)) {
        return jsonResponse(200, { result: [] });
      }
      assert.match(url, /\/api\/now\/table\/sys_dictionary(\?|$)/);
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
      assert.match(mermaid, /^erDiagram/);
      assert.match(mermaid, /incident \{/);
      assert.match(mermaid, /string number/);
      assert.match(mermaid, /incident \}o--\|\| sys_user : "caller_id"/);
    },
  );
});

test("generateTableFlow groups business rules into phase subgraphs", async () => {
  await withFetch(
    (url) => {
      if (isTable(url, "sys_db_object")) return chainResponse(queryOf(url));
      assert.ok(isTable(url, "sys_script"), url);
      const q = queryOf(url);
      // The whole chain plus the global rules, active only, ordered by phase
      // and order (S-1); listScripts appends its own name ordering.
      assert.match(
        q,
        /^collectionINincident,task\^ORglobal=true\^active=true\^ORDERBYwhen\^ORDERBYorder/,
      );
      return jsonResponse(200, {
        result: [
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
        ],
      });
    },
    async () => {
      const { mermaid, count, tables } = await generateTableFlow("incident");
      assert.equal(count, 2);
      assert.deepEqual(tables, ["incident", "task"]);
      assert.match(mermaid, /^flowchart TD/);
      assert.match(mermaid, /subgraph P_before/);
      assert.match(mermaid, /subgraph P_after/);
      assert.match(mermaid, /Validate \(100\)/);
      // Own rules only: no inherited or global lanes.
      assert.doesNotMatch(mermaid, /inherited from/);
      assert.doesNotMatch(mermaid, /_global\[/);
    },
  );
});

test("generateTableFlow puts inherited and global rules in their own lanes (S-1)", async () => {
  await withFetch(
    (url) => {
      if (isTable(url, "sys_db_object")) return chainResponse(queryOf(url));
      assert.ok(isTable(url, "sys_script"), url);
      return jsonResponse(200, {
        result: [
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
        ],
      });
    },
    async () => {
      const { mermaid, count, tables, table } =
        await generateTableFlow("incident");
      assert.equal(table, "incident");
      assert.deepEqual(tables, ["incident", "task"]);
      assert.equal(count, 4);
      assert.match(mermaid, /subgraph P_before_task\["inherited from task"\]/);
      assert.match(mermaid, /Task SLA \(50\)/);
      assert.match(mermaid, /subgraph P_after_global\["global"\]/);
      assert.match(mermaid, /Global audit \(150\)/);
      // The before phase has no global lane and the after phase no task lane.
      assert.doesNotMatch(mermaid, /P_before_global/);
      assert.doesNotMatch(mermaid, /P_after_task/);
      // Own rules chain into the first lane so the chart still reads downward.
      const lines = mermaid.split("\n");
      const ownBefore = lines.find((l) => /Incident defaults \(100\)/.test(l));
      const ownId = /^\s*(n\d+)\[/.exec(ownBefore)[1];
      assert.ok(lines.includes(`    ${ownId} --> P_before_task`), mermaid);
      const notify = lines.find((l) => /Notify \(200\)/.test(l));
      const notifyId = /^\s*(n\d+)\[/.exec(notify)[1];
      assert.ok(lines.includes(`    ${notifyId} --> P_after_global`), mermaid);
      assert.match(mermaid, /P_after --> done/);
    },
  );
});

test("generateTableFlow rejects a '^' in the table name before any request (DEV-7)", async () => {
  await withFetch(
    () => {
      throw new Error("fetch must not run for a caret table name");
    },
    async (calls) => {
      await assert.rejects(generateTableFlow("incident^active=true"), (err) =>
        /cannot contain '\^'/.test(err.message),
      );
      assert.equal(calls.length, 0);
    },
  );
});
