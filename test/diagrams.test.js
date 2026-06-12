import test from "node:test";
import assert from "node:assert/strict";

import { generateErDiagram, generateTableFlow } from "../build/api/diagrams.js";
import { baselineEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

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
          { element: "caller_id", internal_type: "reference", reference: "sys_user" },
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
      assert.match(url, /\/api\/now\/table\/sys_script(\?|$)/);
      const q = new URL(url).searchParams.get("sysparm_query");
      assert.match(q, /collection=incident\^active=true/);
      return jsonResponse(200, {
        result: [
          { sys_id: "1", name: "Validate", when: "before", order: "100" },
          { sys_id: "2", name: "Notify", when: "after", order: "200" },
        ],
      });
    },
    async () => {
      const { mermaid, count } = await generateTableFlow("incident");
      assert.equal(count, 2);
      assert.match(mermaid, /^flowchart TD/);
      assert.match(mermaid, /subgraph P_before/);
      assert.match(mermaid, /subgraph P_after/);
      assert.match(mermaid, /Validate \(100\)/);
    },
  );
});
