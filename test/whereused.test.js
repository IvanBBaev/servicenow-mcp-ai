import test from "node:test";
import assert from "node:assert/strict";

import {
  whereUsed,
  whereUsedCaveats,
  HITS_PER_REF,
} from "../build/api/whereused.js";
import { baselineEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

test("whereUsed(field) returns textual references from the code search (DF-4)", async () => {
  await withFetch(
    (url) => {
      const seg = new URL(url).pathname.split("/").pop();
      if (seg === "sys_script") {
        return jsonResponse(200, {
          result: [
            {
              sys_id: "br2",
              name: "Uses Priority",
              script: "current.priority = 1;",
            },
          ],
        });
      }
      return jsonResponse(200, { result: [] });
    },
    async () => {
      const r = await whereUsed("field", "priority");
      assert.equal(r.kind, "field");
      const refs = r.references.filter((x) => x.relation === "references");
      assert.ok(refs.some((x) => x.name === "Uses Priority"));
      // H-8 C-12: cross-scope / visibility caveats travel with the result.
      assert.ok(r.caveats.some((c) => /Cross-scope/.test(c)));
    },
  );
});

test("whereUsed(table) lists attached artefacts and renders a mermaid graph (DF-4)", async () => {
  await withFetch(
    (url) => {
      const seg = new URL(url).pathname.split("/").pop();
      // Business rules attached to the table (tableLogic) + code search hits.
      if (seg === "sys_script") {
        return jsonResponse(200, {
          result: [{ sys_id: "br1", name: "BR One", script: "noop" }],
        });
      }
      return jsonResponse(200, { result: [] });
    },
    async () => {
      const r = await whereUsed("table", "incident", { mermaid: true });
      assert.equal(r.kind, "table");
      assert.ok(r.count >= 1);
      const attached = r.references.filter((x) => x.relation === "attached_to");
      assert.ok(attached.some((x) => x.name === "BR One"));
      assert.match(r.mermaid, /graph LR/);
    },
  );
});

test("whereUsed lists every matching line per reference, capped (S-4)", async () => {
  const script = Array.from(
    { length: 8 },
    (_, i) => `current.priority = ${i};`,
  ).join("\n");
  await withFetch(
    (url) => {
      const seg = new URL(url).pathname.split("/").pop();
      if (seg === "sys_script") {
        return jsonResponse(200, {
          result: [{ sys_id: "br2", name: "Busy", script }],
        });
      }
      return jsonResponse(200, { result: [] });
    },
    async () => {
      const r = await whereUsed("field", "priority");
      const ref = r.references.find((x) => x.sys_id === "br2");
      // The pre-S-4 fields are untouched.
      assert.equal(ref.field, "script");
      assert.equal(ref.line, 1);
      assert.equal(ref.hits.length, HITS_PER_REF);
      assert.equal(ref.hitCount, 8);
      // Compact: no context lines in a where-used answer.
      assert.deepEqual(ref.hits[1], {
        field: "script",
        line: 2,
        text: "current.priority = 1;",
      });
    },
  );
});

test("whereUsed(table, scope) scopes both the search and the attached automation (S-4)", async () => {
  await withFetch(
    () => jsonResponse(200, { result: [] }),
    async (calls) => {
      const r = await whereUsed("table", "incident", { scope: "x_acme_app" });
      assert.ok(calls.length > 5);
      for (const c of calls) {
        const q = new URL(c.url).searchParams.get("sysparm_query") ?? "";
        assert.match(q, /sys_scope\.scope=x_acme_app/, c.url);
      }
      assert.ok(
        r.caveats.some((c) =>
          /Restricted to application scope "x_acme_app"/.test(c),
        ),
      );
    },
  );
});

test("whereUsed reports unreadable artefact types as a caveat (S-4)", async () => {
  await withFetch(
    (url) =>
      /\/table\/(sp_widget|sys_ui_macro)\?/.test(url)
        ? jsonResponse(403, { error: { message: "denied" } })
        : jsonResponse(200, { result: [] }),
    async () => {
      const r = await whereUsed("table", "incident");
      const caveat = r.caveats.find((c) => /^Not searched/.test(c));
      assert.ok(caveat, r.caveats.join(" | "));
      assert.match(caveat, /sp_widget/);
      assert.match(caveat, /ui_macro/);
    },
  );
});

test("whereUsedCaveats is unchanged without the S-4 extras", () => {
  const base = whereUsedCaveats("field", "priority", 0);
  assert.deepEqual(whereUsedCaveats("field", "priority", 0, {}), base);
  assert.equal(base.length, 3);
});
