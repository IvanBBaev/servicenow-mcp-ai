import test from "node:test";
import assert from "node:assert/strict";

import {
  listScripts,
  getScript,
  searchCode,
  tableLogic,
} from "../build/api/scripts.js";
import { ServiceNowError } from "../build/core/errors.js";
import { baselineEnv, withFetch, withEnv, jsonResponse } from "./helpers.js";

baselineEnv();

test("a '^' in search/list filters is rejected before any request (K-5)", async () => {
  await withFetch(
    () => {
      throw new Error("fetch must not be called for an invalid filter");
    },
    async (calls) => {
      await assert.rejects(
        searchCode({ text: "a^ORactive=false" }),
        (err) => err instanceof ServiceNowError && /'\^'/.test(err.message),
      );
      await assert.rejects(
        listScripts({ type: "business_rule", name: "x^y" }),
        (err) => err instanceof ServiceNowError && /'\^'/.test(err.message),
      );
      await assert.rejects(
        listScripts({ type: "business_rule", table: "incident^" }),
        (err) => err instanceof ServiceNowError,
      );
      assert.equal(calls.length, 0);
    },
  );
});

const queryOf = (url) => new URL(url).searchParams.get("sysparm_query");
const fieldsOf = (url) =>
  (new URL(url).searchParams.get("sysparm_fields") ?? "").split(",");

// --- listScripts -------------------------------------------------------------

test("listScripts filters business rules by collection and omits the script body", async () => {
  await withFetch(
    (url) => {
      assert.match(url, /\/api\/now\/table\/sys_script(\?|$)/);
      assert.equal(queryOf(url), "collection=incident^ORDERBYname");
      const fields = fieldsOf(url);
      assert.ok(fields.includes("collection"));
      assert.ok(!fields.includes("script"));
      return jsonResponse(200, {
        result: [{ sys_id: "br1", name: "Set priority", when: "before" }],
      });
    },
    async () => {
      const result = await listScripts({
        type: "business_rule",
        table: "incident",
      });
      assert.equal(result.type, "business_rule");
      assert.equal(result.count, 1);
      assert.equal(result.scripts[0].name, "Set priority");
      assert.equal(result.scripts[0].when, "before");
    },
  );
});

test("listScripts rejects an unknown type without calling fetch", async () => {
  await withFetch(
    () => {
      throw new Error("fetch should not be called");
    },
    async () => {
      await assert.rejects(
        () => listScripts({ type: "nope" }),
        (err) => {
          assert.ok(err instanceof ServiceNowError);
          assert.equal(err.status, 400);
          return true;
        },
      );
    },
  );
});

// --- getScript ---------------------------------------------------------------

test("getScript reads the full record from the type's table", async () => {
  await withFetch(
    (url) => {
      assert.match(url, /\/api\/now\/table\/sys_script_include\/si123(\?|$)/);
      return jsonResponse(200, {
        result: { sys_id: "si123", name: "Util", script: "var Util = {};" },
      });
    },
    async () => {
      const result = await getScript("script_include", "si123");
      assert.equal(result.table, "sys_script_include");
      assert.equal(result.record.script, "var Util = {};");
    },
  );
});

// --- searchCode --------------------------------------------------------------

test("searchCode finds a substring and returns a line snippet", async () => {
  await withFetch(
    (url) => {
      assert.match(url, /\/api\/now\/table\/sys_script(\?|$)/);
      assert.equal(queryOf(url), "scriptLIKEgs.addInfoMessage");
      return jsonResponse(200, {
        result: [
          {
            sys_id: "br9",
            name: "Notify",
            collection: "incident",
            script: "function onBefore() {\n  gs.addInfoMessage('hi');\n}",
          },
        ],
      });
    },
    async () => {
      const result = await searchCode({
        text: "gs.addInfoMessage",
        type: "business_rule",
      });
      assert.equal(result.count, 1);
      const m = result.matches[0];
      assert.equal(m.field, "script");
      assert.equal(m.line, 2);
      assert.equal(m.table, "incident");
      assert.match(m.snippet, /gs\.addInfoMessage/);
    },
  );
});

test("searchCode rejects empty text without calling fetch", async () => {
  await withFetch(
    () => {
      throw new Error("fetch should not be called");
    },
    async () => {
      await assert.rejects(
        () => searchCode({ text: "   " }),
        (err) => {
          assert.ok(err instanceof ServiceNowError);
          assert.equal(err.status, 400);
          return true;
        },
      );
    },
  );
});

// --- tableLogic --------------------------------------------------------------

test("tableLogic rejects a '^' in the table before any sub-query fires (DEV-4)", async () => {
  await withFetch(
    () => {
      throw new Error("fetch must not run for a caret table");
    },
    async (calls) => {
      await assert.rejects(
        tableLogic("incident^active=false"),
        (err) => err instanceof ServiceNowError && /'\^'/.test(err.message),
      );
      assert.equal(calls.length, 0, "no sub-query may reach the instance");
    },
  );
});

test("tableLogic gathers automation across the script tables", async () => {
  await withFetch(
    (url) => {
      const byTable = {
        sys_script: [{ sys_id: "br1", name: "BR", when: "after" }],
        sys_script_client: [{ sys_id: "cs1", name: "CS" }],
        sys_ui_policy: [{ sys_id: "up1", short_description: "UP" }],
        sys_ui_action: [{ sys_id: "ua1", name: "UA" }],
        sys_security_acl: [{ sys_id: "acl1", name: "incident" }],
      };
      // sysparm_query is on the query string, table is the last path segment.
      const seg = new URL(url).pathname.split("/").pop();
      return jsonResponse(200, { result: byTable[seg] ?? [] });
    },
    async () => {
      const logic = await tableLogic("incident");
      assert.equal(logic.table, "incident");
      assert.equal(logic.businessRules[0].name, "BR");
      assert.equal(logic.clientScripts[0].name, "CS");
      assert.equal(logic.uiPolicies[0].name, "UP");
      assert.equal(logic.uiActions[0].name, "UA");
      assert.equal(logic.acls[0].name, "incident");
    },
  );
});

test("tableLogic degrades a 403 on one artefact table to an 'unreadable' flag (DF-0)", async () => {
  await withFetch(
    (url) => {
      const seg = new URL(url).pathname.split("/").pop();
      if (seg === "sys_security_acl") {
        return jsonResponse(403, { error: { message: "no read access" } });
      }
      const byTable = {
        sys_script: [{ sys_id: "br1", name: "BR", when: "after" }],
        sys_script_client: [{ sys_id: "cs1", name: "CS" }],
        sys_ui_policy: [{ sys_id: "up1", short_description: "UP" }],
        sys_ui_action: [{ sys_id: "ua1", name: "UA" }],
      };
      return jsonResponse(200, { result: byTable[seg] ?? [] });
    },
    async () => {
      const logic = await tableLogic("incident");
      // Readable types still come back...
      assert.equal(logic.businessRules[0].name, "BR");
      assert.equal(logic.acls.length, 0);
      // ...and the denied one is flagged, not a hard failure.
      assert.deepEqual(logic.unreadable, ["acl"]);
    },
  );
});

test("tableLogic orders business rules by when then order", async () => {
  await withFetch(
    (url) => {
      const seg = new URL(url).pathname.split("/").pop();
      if (seg === "sys_script") {
        assert.equal(
          queryOf(url),
          "collection=incident^ORDERBYwhen^ORDERBYorder^ORDERBYname",
        );
      }
      return jsonResponse(200, { result: [] });
    },
    async () => {
      await tableLogic("incident");
    },
  );
});

// --- FT-7: Code Search opt-in ------------------------------------------------

test("searchCode uses the Code Search API when opted in (FT-7)", async () => {
  await withEnv({ SN_CODESEARCH: "true" }, async () => {
    await withFetch(
      (url) => {
        assert.match(url, /\/api\/sn_codesearch\/code_search\/search/);
        assert.equal(new URL(url).searchParams.get("term"), "GlideRecord");
        return jsonResponse(200, {
          result: {
            results: [
              {
                table: "sys_script",
                name: "BR",
                sys_id: "br1",
                field: "script",
                line: 7,
                snippet: "new GlideRecord()",
              },
            ],
          },
        });
      },
      async () => {
        const { count, matches } = await searchCode({ text: "GlideRecord" });
        assert.equal(count, 1);
        assert.equal(matches[0].sys_id, "br1");
        assert.equal(matches[0].line, 7);
      },
    );
  });
});

test("searchCode falls back to LIKE when Code Search is unavailable (FT-7)", async () => {
  await withEnv({ SN_CODESEARCH: "true" }, async () => {
    let codeSearchHit = false;
    await withFetch(
      (url) => {
        if (/code_search\/search/.test(url)) {
          codeSearchHit = true;
          return jsonResponse(404, {
            error: { message: "does not represent any resource" },
          });
        }
        return jsonResponse(200, { result: [] });
      },
      async () => {
        const { count } = await searchCode({
          text: "needle",
          type: "business_rule",
        });
        assert.ok(codeSearchHit, "Code Search was attempted first");
        assert.equal(count, 0, "the LIKE fallback ran and found nothing");
      },
    );
  });
});
