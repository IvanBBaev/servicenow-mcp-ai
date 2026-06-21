import test from "node:test";
import assert from "node:assert/strict";

import { whereUsed } from "../build/api/whereused.js";
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
