import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";

import {
  lintSource,
  lintSourceDetailed,
  lintSourceRegex,
  lintScript,
  codeHealth,
  securityScan,
} from "../build/api/codecheck.js";
import { parseScript, scriptCalls } from "../build/api/script-ast.js";
import {
  baselineEnv,
  withMetadataFetch,
  withEnv,
  jsonResponse,
} from "./helpers.js";

baselineEnv();

const rules = (findings) => findings.map((f) => f.rule);

// --- comment / string false positives ---------------------------------------

test("S-12: code rules no longer match comments or string contents", () => {
  const src = [
    "// eval('x'); gs.sleep(10); gs.log('a'); current.update();",
    "var msg = 'never call eval( here, nor gs.log( or gs.sleep(';",
    "/* var gr = new GlideRecord('x'); gr.query();",
    "   current.setWorkflow(false); */",
    'var help = "gr.query() inside a loop is slow";',
  ].join("\n");
  // The regex engine reports every one of these…
  const regex = rules(lintSourceRegex(src, "server"));
  for (const id of ["eval-usage", "gs-sleep", "gs-log-deprecated"]) {
    assert.ok(regex.includes(id), `regex ${id}`);
  }
  // …the AST engine none.
  const r = lintSourceDetailed(src, "server");
  assert.equal(r.engine, "ast");
  assert.deepEqual(r.findings, []);
});

test("S-12: a sys_id or instance URL in a comment is not hard-coded", () => {
  const commented = [
    "// see a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    "/* https://acme.service-now.com/nav_to.do */",
    "var x = 1;",
  ].join("\n");
  assert.deepEqual(lintSource(commented), []);
  const literal = [
    "var id = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';",
    "var url = `https://acme.service-now.com/api`;",
  ].join("\n");
  const r = lintSource(literal);
  assert.deepEqual(
    r.map((f) => [f.rule, f.line]),
    [
      ["hardcoded-sys-id", 1],
      ["hardcoded-instance-url", 2],
    ],
  );
});

test("S-12: rule ids and finding shape match the regex engine on real code", () => {
  const src = [
    "eval('x');",
    "gs.sleep(1000);",
    "gs.log('hi');",
    "current.setWorkflow(false);",
    "current.update();",
  ].join("\n");
  const ast = lintSource(src, "server");
  const regex = lintSourceRegex(src, "server");
  assert.deepEqual(
    ast.map((f) => [f.rule, f.line, f.severity]),
    regex.map((f) => [f.rule, f.line, f.severity]),
  );
  for (const f of ast) {
    assert.deepEqual(Object.keys(f).sort(), [
      "hint",
      "line",
      "rule",
      "severity",
      "snippet",
    ]);
  }
});

test("S-12: query-in-loop only for a query in the loop body", () => {
  const header = [
    "var gr = new GlideRecord('incident');",
    "gr.addQuery('active', true);",
    "gr.query();",
    "while (gr.next()) { gs.info(gr.number); }",
  ].join("\n");
  assert.ok(!rules(lintSource(header)).includes("query-in-loop"));
  const body = [
    "for (var i = 0; i < 3; i++) {",
    "  var gr = new GlideRecord('incident');",
    "  gr.addQuery('n', i);",
    "  gr.query();",
    "}",
  ].join("\n");
  const r = lintSource(body).filter((f) => f.rule === "query-in-loop");
  assert.deepEqual(
    r.map((f) => f.line),
    [2, 4],
  );
});

test("S-12: an unbounded query is judged per receiver and function", () => {
  const otherFn = [
    "function a() { var gr = new GlideRecord('x'); gr.addQuery('a', 1); }",
    "function b(gr) { gr.query(); }",
  ].join("\n");
  assert.ok(rules(lintSource(otherFn)).includes("gr-unbounded-query"));
  const other = [
    "var a = new GlideRecord('x');",
    "var b = new GlideRecord('y');",
    "a.addQuery('active', true);",
    "b.query();",
    "a.query();",
  ].join("\n");
  const r = lintSource(other).filter((f) => f.rule === "gr-unbounded-query");
  assert.deepEqual(
    r.map((f) => f.line),
    [4],
  );
  // A query with an encoded-query argument is bounded.
  assert.deepEqual(
    lintSource("var g = new GlideRecord('x');\ng.query('a=1');"),
    [],
  );
});

test("S-12: sp-param-unvalidated follows the value through variables", () => {
  const src = [
    "var t = $sp.getParameter('q');",
    "var q = 'active=true^' + t;",
    "var gr = new GlideRecord('incident');",
    "gr.addEncodedQuery(q);",
    "gr.query();",
  ].join("\n");
  const f = lintSource(src).filter((x) => x.rule === "sp-param-unvalidated");
  assert.equal(f.length, 1);
  assert.equal(f[0].line, 4);
  assert.match(f[0].hint, /addEncodedQuery/);
  // A table name from the URL is a sink too.
  const table = "var gr = new GlideRecord($sp.getParameter('table'));";
  assert.ok(rules(lintSource(table)).includes("sp-param-unvalidated"));
  // Commented out, or a constant: no finding.
  const safe = [
    "// gr.addEncodedQuery($sp.getParameter('q'));",
    "var gr = new GlideRecord('incident');",
    "gr.addEncodedQuery('active=true');",
    "gr.query();",
  ].join("\n");
  assert.ok(!rules(lintSource(safe)).includes("sp-param-unvalidated"));
  // Server scope only.
  assert.ok(
    !rules(lintSource(table, "client")).includes("sp-param-unvalidated"),
  );
});

test("S-12: client and server scoping is kept", () => {
  const src = "var gr = new GlideRecord('incident');\ngr.get('x');";
  assert.ok(rules(lintSource(src, "client")).includes("gr-on-client"));
  assert.ok(!rules(lintSource(src, "server")).includes("gr-on-client"));
  const ref = "g_form.getReference('caller_id');";
  assert.ok(rules(lintSource(ref, "client")).includes("sync-get-reference"));
  assert.ok(
    !rules(lintSource(ref + " // with a callback later", "client")).includes(
      "gr-on-client",
    ),
  );
});

// --- parse fallback ------------------------------------------------------------

test("S-12: a source that does not parse falls back to the regex rules", () => {
  const jelly = "var n = ${current.number};\neval('x');";
  const r = lintSourceDetailed(jelly, "server");
  assert.equal(r.engine, "regex");
  assert.ok(r.parseError && r.parseError.length <= 200);
  assert.ok(rules(r.findings).includes("eval-usage"));
  // The FT-5 syntax-error rule lives in the fallback.
  const broken = lintSourceDetailed("function ( {", "server");
  assert.equal(broken.engine, "regex");
  assert.ok(rules(broken.findings).includes("syntax-error"));
});

test("S-12: empty input is clean and never a fallback", () => {
  assert.deepEqual(lintSourceDetailed("", "server"), {
    engine: "ast",
    findings: [],
  });
  assert.deepEqual(lintSource("   \n  "), []);
});

// --- ES5 vs ES2021 -------------------------------------------------------------

test("S-12: ES2021 syntax in a global (ES5) script is a finding", () => {
  const modern = "let x = [1, 2].map((n) => n * 2);\nconst y = `v${x}`;";
  assert.equal(parseScript(modern, "es5").ok, false);
  assert.equal(parseScript(modern, "es2021").ok, true);

  const g = lintSourceDetailed(modern, "server", { ecma: "es5" });
  assert.equal(g.engine, "ast");
  assert.equal(g.ecma, "es2021");
  assert.deepEqual(rules(g.findings), ["es2021-syntax-in-es5"]);
  assert.equal(g.findings[0].line, 1);

  const scoped = lintSourceDetailed(modern, "server", { ecma: "es2021" });
  assert.equal(scoped.ecma, "es2021");
  assert.deepEqual(scoped.findings, []);

  const es5 = lintSourceDetailed("var x = 1;", "server", { ecma: "es5" });
  assert.equal(es5.ecma, "es5");
  assert.deepEqual(es5.findings, []);
});

test("S-12: lintScript takes the ES level from the record's scope", async () => {
  const modern = "const n = () => 1;";
  for (const [scope, expected] of [
    ["global", ["es2021-syntax-in-es5"]],
    ["0123456789abcdef0123456789abcdef", []],
  ]) {
    await withMetadataFetch(
      () =>
        jsonResponse(200, {
          result: { name: "BR", script: modern, sys_scope: scope },
        }),
      async () => {
        const { results } = await lintScript("business_rule", "br1");
        assert.equal(results.length, 1);
        assert.equal(results[0].engine, "ast");
        assert.deepEqual(rules(results[0].findings), expected);
      },
    );
  }
});

test("S-12: lintScript reports the fallback per field", async () => {
  await withMetadataFetch(
    () =>
      jsonResponse(200, {
        result: { name: "BR", script: "var a = ${x};", sys_scope: "global" },
      }),
    async () => {
      const { results } = await lintScript("business_rule", "br1");
      assert.equal(results[0].engine, "regex");
      assert.ok(results[0].parseError);
    },
  );
});

// --- ACL scripts ---------------------------------------------------------------

test("S-12: ACL script rules ignore comments and strings", async () => {
  await withMetadataFetch(
    (url) => {
      if (!/\/api\/now\/table\/sys_security_acl\?/.test(url)) {
        return jsonResponse(200, { result: [] });
      }
      return jsonResponse(200, {
        result: [
          {
            sys_id: "a1",
            name: "incident.read",
            operation: "read",
            script:
              "// eval(x) was removed\nanswer = true; // gs.getUser() too\nvar s = 'gr.update()';",
            condition: "",
          },
          {
            sys_id: "a2",
            name: "incident.write",
            operation: "write",
            script: "answer = gs.getUserID() == current.caller_id;",
            condition: "",
          },
          {
            // Does not parse: the regex fallback still sees the eval.
            sys_id: "a3",
            name: "incident.delete",
            operation: "delete",
            script: "answer = eval(${x});",
            condition: "",
          },
        ],
      });
    },
    async () => {
      const scan = await securityScan();
      const by = (id) =>
        scan.findings
          .filter((f) => f.sys_id === id)
          .map((f) => f.rule)
          .filter((r) => /-in-acl$/.test(r));
      assert.deepEqual(by("a1"), []);
      assert.deepEqual(by("a2"), ["getuser-in-acl"]);
      assert.deepEqual(by("a3"), ["eval-in-acl"]);
    },
  );
});

// --- baseline ------------------------------------------------------------------

test("S-12: check_code_health records a baseline, then reports new and fixed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sn-s12-baseline-"));
  let acls = [];
  const fetch = (url) => {
    if (/\/api\/now\/table\/sys_security_acl\?/.test(url)) {
      return jsonResponse(200, { result: acls });
    }
    if (url.includes("/api/now/table/")) {
      return jsonResponse(200, { result: [] });
    }
    return jsonResponse(200, { result: { stats: { count: "1" } } });
  };
  const acl = (sys_id, script) => ({
    sys_id,
    name: `incident.${sys_id}`,
    operation: "read",
    script,
    condition: "",
  });
  const run = (opts) =>
    withMetadataFetch(fetch, () => codeHealth(undefined, opts));
  try {
    await withEnv({ SN_DOCS_DIR: dir }, async () => {
      acls = [acl("a1", "answer = eval(x);"), acl("a2", "gr.update();")];
      const first = await run();
      assert.equal(first.delta.baselineCreated, true);
      assert.equal(first.delta.updated, true);
      assert.equal(first.delta.sections.security.compared, false);
      assert.equal(
        first.delta.baselineFile,
        "default/code-health.baseline.json",
      );
      const stored = JSON.parse(
        readFileSync(join(dir, first.delta.baselineFile), "utf8"),
      );
      assert.equal(stored.sn_generator, "servicenow_check_code_health");
      assert.equal(stored.sn_kind, "code-health-baseline");
      assert.ok(stored.scopes.instance.sections.security.length >= 2);

      // a2 fixed, a3 new; the baseline is not moved.
      acls = [acl("a1", "answer = eval(x);"), acl("a3", "answer = eval(y);")];
      const second = await run();
      assert.equal(second.delta.baselineCreated, false);
      assert.equal(second.delta.updated, false);
      assert.equal(second.delta.sections.security.compared, true);
      const fps = (list) => list.map((e) => e.fingerprint);
      assert.ok(fps(second.delta.new).some((f) => f.includes("|a3|")));
      assert.ok(fps(second.delta.fixed).some((f) => f.includes("|a2|")));
      assert.ok(!fps(second.delta.new).some((f) => f.includes("|a1|")));
      const md = readFileSync(join(dir, second.reportFile), "utf8");
      assert.match(md, /## Baseline delta/);

      // Same run again: the same delta (the ratchet holds).
      const again = await run();
      assert.equal(again.delta.newCount, second.delta.newCount);
      assert.equal(again.delta.fixedCount, second.delta.fixedCount);

      // update_baseline moves it; the next run is clean.
      const moved = await run({ updateBaseline: true });
      assert.equal(moved.delta.updated, true);
      const clean = await run();
      assert.equal(clean.delta.newCount, 0);
      assert.equal(clean.delta.fixedCount, 0);
      assert.ok(clean.delta.sections.security.unchanged >= 2);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S-12: a finding of an unreadable unit is partial, not fixed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sn-s12-partial-"));
  let aclStatus = 200;
  const fetch = (url) => {
    if (/\/api\/now\/table\/sys_security_acl\?/.test(url)) {
      return aclStatus === 200
        ? jsonResponse(200, {
            result: [
              {
                sys_id: "a1",
                name: "incident.read",
                operation: "read",
                script: "answer = eval(x);",
                condition: "",
              },
            ],
          })
        : jsonResponse(403, { error: { message: "no access" } });
    }
    if (url.includes("/api/now/table/")) {
      return jsonResponse(200, { result: [] });
    }
    return jsonResponse(200, { result: { stats: { count: "1" } } });
  };
  try {
    await withEnv({ SN_DOCS_DIR: dir }, async () => {
      await withMetadataFetch(fetch, () => codeHealth());
      aclStatus = 403;
      const r = await withMetadataFetch(fetch, () => codeHealth());
      assert.equal(r.security.available, false);
      assert.equal(r.delta.fixedCount, 0);
      assert.ok(r.delta.sections.security.partial >= 1);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- property: the parser never throws through ---------------------------------

const TOKENS = [
  "var ",
  "let ",
  "const ",
  "x",
  "gr",
  " = ",
  "new GlideRecord('t')",
  ".query()",
  ".addQuery('a', 1)",
  "eval(",
  "$sp.getParameter('q')",
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  ";",
  "\n",
  "//",
  "/*",
  "*/",
  "'",
  '"',
  "`",
  "${",
  "=>",
  "for (;;) ",
  "while (x) ",
  "function f() ",
  "return ",
  "<j:if>",
  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
];

const sourceArb = fc.oneof(
  fc.string({ maxLength: 200 }),
  fc.string({ unit: "binary", maxLength: 120 }),
  fc
    .array(fc.constantFrom(...TOKENS), { maxLength: 60 })
    .map((parts) => parts.join("")),
);

test("S-12 (property): lintSource never throws and always names an engine", () => {
  fc.assert(
    fc.property(
      sourceArb,
      fc.constantFrom("server", "client"),
      fc.constantFrom("es5", "es2021", undefined),
      (src, scope, ecma) => {
        const r = lintSourceDetailed(src, scope, ecma ? { ecma } : {});
        assert.ok(r.engine === "ast" || r.engine === "regex");
        assert.ok(Array.isArray(r.findings));
        for (const f of r.findings) {
          assert.equal(typeof f.rule, "string");
          assert.ok(Number.isInteger(f.line) && f.line >= 0);
        }
        const calls = scriptCalls(src);
        assert.ok(calls === undefined || Array.isArray(calls));
      },
    ),
    { numRuns: 400 },
  );
});

test("S-12: deeply nested input does not overflow the walker", () => {
  const deep = "x = " + "[".repeat(5000) + "]".repeat(5000) + ";";
  const r = lintSourceDetailed(deep, "server");
  assert.ok(r.engine === "ast" || r.engine === "regex");
});
