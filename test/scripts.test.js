import test from "node:test";
import assert from "node:assert/strict";

import {
  listScripts,
  getScript,
  searchCode,
  tableLogic,
  MAX_HITS_PER_ARTEFACT,
  SCRIPT_TYPE_NAMES,
  OPT_IN_SCRIPT_TYPE_NAMES,
} from "../build/api/scripts.js";
import { specs as scriptSpecs } from "../build/tools/scripts.js";
import { z } from "zod";
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

// --- S-4: all hits, line context, scope, widened types -----------------------

test("searchCode returns every hit with one line of context and a hitCount (S-4)", async () => {
  await withFetch(
    () =>
      jsonResponse(200, {
        result: [
          {
            sys_id: "br1",
            name: "Multi",
            collection: "incident",
            script: [
              "var a = 1;",
              "gs.log('one');",
              "",
              "gs.log('two');",
              "return a;",
            ].join("\n"),
          },
        ],
      }),
    async () => {
      const { matches } = await searchCode({
        text: "gs.log",
        type: "business_rule",
      });
      assert.equal(matches.length, 1);
      const m = matches[0];
      // The pre-S-4 fields still describe the first hit.
      assert.equal(m.field, "script");
      assert.equal(m.line, 2);
      assert.equal(m.snippet, "gs.log('one');");
      assert.equal(m.hitCount, 2);
      assert.deepEqual(m.hits, [
        {
          field: "script",
          line: 2,
          text: "gs.log('one');",
          before: "var a = 1;",
        },
        {
          field: "script",
          line: 4,
          text: "gs.log('two');",
          after: "return a;",
        },
      ]);
    },
  );
});

test("searchCode caps hits per artefact but keeps the full hitCount (S-4)", async () => {
  const script = Array.from(
    { length: 25 },
    (_, i) => `x(${i}); // needle`,
  ).join("\n");
  await withFetch(
    () =>
      jsonResponse(200, {
        result: [{ sys_id: "si1", name: "Loud", script }],
      }),
    async () => {
      const { matches } = await searchCode({
        text: "needle",
        type: "script_include",
      });
      assert.equal(matches[0].hits.length, MAX_HITS_PER_ARTEFACT);
      assert.equal(MAX_HITS_PER_ARTEFACT, 20);
      assert.equal(matches[0].hitCount, 25);

      const capped = await searchCode({
        text: "needle",
        type: "script_include",
        maxHits: 0,
      });
      assert.equal(capped.matches[0].hits.length, 1, "clamped to at least 1");
    },
  );
});

test("searchCode collects hits across every script field of a widget (S-4)", async () => {
  await withFetch(
    (url) => {
      assert.match(url, /\/api\/now\/table\/sp_widget(\?|$)/);
      assert.equal(
        queryOf(url),
        "scriptLIKEspUtil^ORclient_scriptLIKEspUtil^ORlinkLIKEspUtil^ORcssLIKEspUtil",
      );
      return jsonResponse(200, {
        result: [
          {
            sys_id: "w1",
            name: "Widget",
            script: "data.x = $sp.getValue();",
            client_script: "function() {\n  spUtil.update($scope);\n}",
            link: "function link() { spUtil.addInfoMessage('x'); }",
            css: ".a { color: red; }",
          },
        ],
      });
    },
    async () => {
      const { matches } = await searchCode({
        text: "spUtil",
        type: "sp_widget",
      });
      assert.equal(matches[0].field, "client_script");
      assert.equal(matches[0].line, 2);
      assert.deepEqual(
        matches[0].hits.map((h) => h.field),
        ["client_script", "link"],
      );
    },
  );
});

test("searchCode ANDs a scope clause into the query and skips Code Search (S-4)", async () => {
  await withEnv({ SN_CODESEARCH: "true" }, async () => {
    await withFetch(
      (url) => {
        assert.doesNotMatch(url, /code_search/);
        return jsonResponse(200, { result: [] });
      },
      async (calls) => {
        await searchCode({
          text: "needle",
          type: "business_rule",
          scope: "x_acme_app",
        });
        assert.equal(
          queryOf(calls[0].url),
          "sys_scope.scope=x_acme_app^scriptLIKEneedle",
        );
        const sysId = "0123456789abcdef0123456789abcdef";
        await searchCode({
          text: "needle",
          type: "business_rule",
          scope: sysId,
        });
        assert.equal(
          queryOf(calls[1].url),
          `sys_scope=${sysId}^scriptLIKEneedle`,
        );
      },
    );
  });
  await assert.rejects(
    searchCode({ text: "x", scope: "global^ORactive=true" }),
    (err) => err instanceof ServiceNowError && /'\^'/.test(err.message),
  );
});

test("searchCode narrows sys_dictionary with the registry base query (S-4)", async () => {
  await withFetch(
    (url) => {
      assert.match(url, /\/api\/now\/table\/sys_dictionary(\?|$)/);
      assert.equal(
        queryOf(url),
        "virtual=true^ORdefault_valueSTARTSWITHjavascript:" +
          "^calculationLIKEgs.getUser^ORdefault_valueLIKEgs.getUser",
      );
      return jsonResponse(200, {
        result: [
          {
            sys_id: "d1",
            element: "u_owner",
            name: "incident",
            default_value: "javascript:gs.getUserID()",
          },
        ],
      });
    },
    async () => {
      const { matches } = await searchCode({
        text: "gs.getUser",
        type: "dictionary_script",
      });
      assert.equal(matches[0].name, "u_owner");
      assert.equal(matches[0].table, "incident");
      assert.equal(matches[0].field, "default_value");
    },
  );
});

test("an all-types search skips an unreadable widened table, not a legacy one (S-4)", async () => {
  await withFetch(
    (url) => {
      if (/\/table\/(sp_widget|sys_processor)\?/.test(url)) {
        return jsonResponse(403, { error: { message: "denied" } });
      }
      if (/\/table\/sys_script\?/.test(url)) {
        return jsonResponse(200, {
          result: [{ sys_id: "br1", name: "BR", script: "needle()" }],
        });
      }
      return jsonResponse(200, { result: [] });
    },
    async () => {
      const r = await searchCode({ text: "needle" });
      assert.equal(r.count, 1);
      assert.deepEqual(r.unreadable, ["processor", "sp_widget"]);
      // An explicit type still fails loudly.
      await assert.rejects(
        searchCode({ text: "needle", type: "sp_widget" }),
        (err) => err instanceof ServiceNowError && err.status === 403,
      );
    },
  );
  await withFetch(
    (url) =>
      /\/table\/sys_script_include\?/.test(url)
        ? jsonResponse(403, { error: { message: "denied" } })
        : jsonResponse(200, { result: [] }),
    async () => {
      await assert.rejects(
        searchCode({ text: "needle" }),
        (err) => err instanceof ServiceNowError && err.status === 403,
      );
    },
  );
});

test("a clean all-types search carries no unreadable key (S-4)", async () => {
  await withFetch(
    () => jsonResponse(200, { result: [] }),
    async (calls) => {
      const r = await searchCode({ text: "needle" });
      assert.deepEqual(r, { count: 0, matches: [] });
      // One query per script type: the nine originals plus the S-4 view.
      assert.equal(calls.length, SCRIPT_TYPE_NAMES.length);
    },
  );
});

test("listScripts: scope and the registry active field; no active flag is a 400 (S-4)", async () => {
  await withFetch(
    () => jsonResponse(200, { result: [] }),
    async (calls) => {
      await listScripts({ type: "processor", active: true, scope: "global" });
      assert.equal(
        queryOf(calls[0].url),
        "sys_scope.scope=global^active=true^ORDERBYname",
      );
      await listScripts({ type: "dictionary_script", table: "incident" });
      assert.equal(
        queryOf(calls[1].url),
        "virtual=true^ORdefault_valueSTARTSWITHjavascript:^name=incident^ORDERBYelement",
      );
      await assert.rejects(
        listScripts({ type: "fix_script", active: true }),
        (err) =>
          err instanceof ServiceNowError &&
          err.status === 400 &&
          /no active flag/.test(err.message),
      );
      assert.equal(calls.length, 2);
    },
  );
});

test("tableLogic passes a scope to every sub-query (S-4)", async () => {
  await withFetch(
    () => jsonResponse(200, { result: [] }),
    async (calls) => {
      await tableLogic("incident", { scope: "x_acme_app" });
      assert.equal(calls.length, 5);
      for (const c of calls) {
        assert.match(queryOf(c.url), /^sys_scope\.scope=x_acme_app\^/);
      }
    },
  );
});

// --- P-9: opt-in script types (UI Builder, portal providers / templates, …) --

const tableOf = (url) => new URL(url).pathname.split("/").pop();

test("P-9: search_code extended:true finds code in sp_widget.client_script and sys_ux_client_script.script", async () => {
  await withFetch(
    (url) => {
      if (tableOf(url) === "sp_widget") {
        assert.equal(
          queryOf(url),
          "scriptLIKEneedleFn^ORclient_scriptLIKEneedleFn^ORlinkLIKEneedleFn^ORcssLIKEneedleFn",
        );
        return jsonResponse(200, {
          result: [
            {
              sys_id: "w1",
              name: "Widget",
              script: "data.x = 1;",
              client_script: "api.controller = function() {\n  needleFn();\n};",
              link: "",
              css: "",
            },
          ],
        });
      }
      if (tableOf(url) === "sys_ux_client_script") {
        assert.equal(queryOf(url), "scriptLIKEneedleFn");
        return jsonResponse(200, {
          result: [
            {
              sys_id: "cs1",
              name: "onLoad handler",
              script: "function handler({api}) {\n  needleFn(api);\n}",
            },
          ],
        });
      }
      return jsonResponse(200, { result: [] });
    },
    async (calls) => {
      const r = await searchCode({ text: "needleFn", extended: true });
      assert.equal(r.unreadable, undefined);
      const byType = Object.fromEntries(r.matches.map((m) => [m.type, m]));
      assert.equal(byType.sp_widget.field, "client_script");
      assert.equal(byType.sp_widget.line, 2);
      assert.equal(byType.uib_client_script.sys_id, "cs1");
      assert.equal(byType.uib_client_script.field, "script");
      assert.equal(byType.uib_client_script.line, 2);
      // Default types first, then every opt-in type, one query each.
      assert.deepEqual(
        calls.map((c) => tableOf(c.url)).slice(SCRIPT_TYPE_NAMES.length),
        [
          "sys_ux_client_script",
          "sys_ux_client_script_include",
          "sys_ux_data_broker_transform",
          "sys_ux_data_broker_scriptlet",
          "sp_ng_template",
          "sp_angular_provider",
          "sp_theme",
          "sp_css",
          "sp_search_source",
        ],
      );
      assert.equal(
        calls.length,
        SCRIPT_TYPE_NAMES.length + OPT_IN_SCRIPT_TYPE_NAMES.length,
      );
    },
  );
});

test("P-9: the default sweep never reaches an opt-in table", async () => {
  await withFetch(
    () => jsonResponse(200, { result: [] }),
    async (calls) => {
      assert.deepEqual(await searchCode({ text: "needle" }), {
        count: 0,
        matches: [],
      });
      assert.deepEqual(await searchCode({ text: "needle", extended: false }), {
        count: 0,
        matches: [],
      });
      assert.equal(calls.length, 2 * SCRIPT_TYPE_NAMES.length);
      for (const { url } of calls) {
        assert.doesNotMatch(
          tableOf(url),
          /^(sys_ux_|sp_ng_template|sp_angular_provider|sp_theme|sp_css|sp_search_source)/,
        );
      }
    },
  );
});

test("P-9: an explicit opt-in type is searched, listed and read; extended is ignored with a type", async () => {
  await withFetch(
    (url) => {
      assert.match(url, /\/api\/now\/table\/sys_ux_client_script(\/|\?)/);
      if (/\/sys_ux_client_script\/cs1/.test(url)) {
        return jsonResponse(200, {
          result: { sys_id: "cs1", name: "h", script: "x()" },
        });
      }
      return jsonResponse(200, {
        result: [{ sys_id: "cs1", name: "h", script: "needle()" }],
      });
    },
    async (calls) => {
      const r = await searchCode({
        text: "needle",
        type: "uib_client_script",
        extended: true,
      });
      assert.equal(r.count, 1);
      assert.equal(r.matches[0].type, "uib_client_script");
      assert.equal(calls.length, 1);
      const list = await listScripts({ type: "uib_client_script" });
      assert.equal(list.scripts[0].sys_id, "cs1");
      const got = await getScript("uib_client_script", "cs1");
      assert.equal(got.table, "sys_ux_client_script");
    },
  );
});

test("P-9: an unreadable opt-in table is skipped in an extended sweep, loud when explicit", async () => {
  await withFetch(
    (url) =>
      tableOf(url) === "sp_angular_provider"
        ? jsonResponse(404, { error: { message: "Invalid table" } })
        : jsonResponse(200, { result: [] }),
    async () => {
      const r = await searchCode({ text: "needle", extended: true });
      assert.deepEqual(r.unreadable, ["sp_angular_provider"]);
      await assert.rejects(
        searchCode({ text: "needle", type: "sp_angular_provider" }),
        (err) => err instanceof ServiceNowError && err.status === 404,
      );
    },
  );
});

test("P-9: the tool schema accepts extended and the opt-in types; lint and where_used do not", async () => {
  const search = scriptSpecs.find((s) => s.name === "servicenow_search_code");
  const schema = z.object(search.input).strict();
  assert.ok(schema.safeParse({ text: "x", extended: true }).success);
  assert.ok(schema.safeParse({ text: "x", type: "uib_client_script" }).success);
  assert.ok(!schema.safeParse({ text: "x", extended: "yes" }).success);
  for (const name of ["servicenow_list_scripts", "servicenow_get_script"]) {
    const spec = scriptSpecs.find((s) => s.name === name);
    assert.ok(spec.input.type.safeParse("sp_angular_provider").success, name);
  }
  // Explicit-only: the opt-in types stay out of the default names list.
  for (const name of OPT_IN_SCRIPT_TYPE_NAMES) {
    assert.ok(!SCRIPT_TYPE_NAMES.includes(name), name);
  }
});
