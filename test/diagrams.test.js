import test from "node:test";
import assert from "node:assert/strict";

import { generateErDiagram, generateTableFlow } from "../build/api/diagrams.js";

// Baseline: valid instance, Basic auth, no retries, no policy restrictions.
process.env.SN_INSTANCE = "ven03019.service-now.com";
process.env.SN_USER = "alice";
process.env.SN_PASSWORD = "s3cret";
process.env.SN_MAX_RETRIES = "0";
delete process.env.SN_AUTH;
delete process.env.SN_OAUTH_CLIENT_ID;
delete process.env.SN_TABLES_ALLOW;
delete process.env.SN_TABLES_DENY;
delete process.env.SN_READONLY;

const realFetch = globalThis.fetch;

async function withFetch(handler, fn) {
  globalThis.fetch = async (url, init) => handler(String(url), init);
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("generateErDiagram emits an entity and a reference relationship", async () => {
  await withFetch(
    (url) => {
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
