import test from "node:test";
import assert from "node:assert/strict";

import {
  lintUibClientScript,
  uibLintContextFromMacroponent,
  dispatchedEventNames,
  UIB_SCRIPT_RULES,
  uibFindingsAsGeneric,
} from "../build/api/uib-script-lint.js";
import { lintScript } from "../build/api/codecheck.js";
import { baselineEnv, withMetadataFetch, jsonResponse } from "./helpers.js";

baselineEnv();

const rules = (src, ctx) =>
  lintUibClientScript(src, ctx).findings.map((f) => f.rule);
const has = (src, rule, ctx) => rules(src, ctx).includes(rule);

const handler = (body) =>
  `function handler({api, event, helpers, imports}) {\n${body}\n}`;

test("rule catalogue: unique ids, every severity valid, every hint set", () => {
  const ids = UIB_SCRIPT_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of UIB_SCRIPT_RULES) {
    assert.match(r.id, /^uib-[a-z-]+$/);
    assert.ok(["error", "warn", "info"].includes(r.severity));
    assert.ok(r.hint.length > 10);
  }
});

test("a clean handler has no findings", () => {
  const src = handler(`
    const { formatTitle } = imports["sn_app.titles"]();
    const next = [...api.state.items, event.payload.item];
    api.setState("items", next);
    api.setState("title", ({ currentValue }) => formatTitle(currentValue));
    api.emit("ITEM_ADDED", { id: event.payload.item.id });
    api.data.list_broker.refresh();
    helpers.timing.setTimeout(() => api.setState("busy", false), 100);
  `);
  const r = lintUibClientScript(src, {
    state: ["items", "title", "busy"],
    events: ["ITEM_ADDED"],
    dataResources: ["list_broker"],
  });
  assert.equal(r.parsed, true);
  assert.deepEqual(r.findings, []);
});

test("findings carry rule, severity, 1-based line/column, message and hint", () => {
  const r = lintUibClientScript(
    handler(`  var gr = new GlideRecord("incident");`),
  );
  const f = r.findings.find((x) => x.rule === "uib-server-api");
  assert.ok(f);
  assert.equal(f.severity, "error");
  assert.equal(f.line, 2);
  assert.equal(f.column, 12);
  assert.match(f.snippet, /new GlideRecord/);
  assert.match(f.message, /GlideRecord/);
  assert.match(f.hint, /data broker/);
});

test("uib-server-api: Glide constructors and classic globals", () => {
  assert.ok(has(handler(`new GlideAjax("X");`), "uib-server-api"));
  assert.ok(has(handler(`gs.info("x");`), "uib-server-api"));
  assert.ok(has(handler(`g_form.setValue("a", 1);`), "uib-server-api"));
  // Only code, never a comment or a string.
  assert.ok(
    !has(
      handler(`// new GlideRecord("x")\nconst s = "gs.info";`),
      "uib-server-api",
    ),
  );
});

test("uib-sync-wait: sync XHR, getXMLWait and clock busy-waits", () => {
  assert.ok(
    has(
      handler(`const x = new XMLHttpRequest(); x.open("GET", "/a", false);`),
      "uib-sync-wait",
    ),
  );
  assert.ok(has(handler(`ga.getXMLWait();`), "uib-sync-wait"));
  assert.ok(
    has(
      handler(`const end = Date.now() + 500; while (Date.now() < end) {}`),
      "uib-sync-wait",
    ),
  );
  assert.ok(
    has(
      handler(`for (const s = new Date(); new Date() - s < 50;) {}`),
      "uib-sync-wait",
    ),
  );
  assert.ok(!has(handler(`x.open("GET", "/a", true);`), "uib-sync-wait"));
  assert.ok(
    !has(handler(`helpers.modal.open("a", {}, false);`), "uib-sync-wait"),
  );
});

test("uib-eval: eval, new Function, string timers", () => {
  assert.ok(has(handler(`eval("1");`), "uib-eval"));
  assert.ok(has(handler(`const f = new Function("return 1");`), "uib-eval"));
  assert.ok(has(handler(`setTimeout("go()", 10);`), "uib-eval"));
  assert.ok(has(handler(`window.setInterval(\`go()\`, 10);`), "uib-eval"));
});

test("uib-state-mutation: assignment, update, delete and in-place methods", () => {
  assert.ok(has(handler(`api.state.count = 1;`), "uib-state-mutation"));
  assert.ok(has(handler(`api.state.count++;`), "uib-state-mutation"));
  assert.ok(has(handler(`api.state.user.name += "x";`), "uib-state-mutation"));
  assert.ok(has(handler(`delete api.state.tmp;`), "uib-state-mutation"));
  assert.ok(has(handler(`api.state.items.push(1);`), "uib-state-mutation"));
  assert.ok(has(handler(`api.state["items"].sort();`), "uib-state-mutation"));
  assert.ok(
    !has(
      handler(`const c = api.state.items.slice(); c.push(1);`),
      "uib-state-mutation",
    ),
  );
});

test("uib-loop-on-state: while / do-while on api.state", () => {
  assert.ok(has(handler(`while (api.state.loading) {}`), "uib-loop-on-state"));
  assert.ok(
    has(handler(`do { x++; } while (!api.state.ready);`), "uib-loop-on-state"),
  );
  assert.ok(
    !has(
      handler(`for (let i = 0; i < api.state.items.length; i++) {}`),
      "uib-loop-on-state",
    ),
  );
});

test("uib-undeclared-state / -event checked against the contract only", () => {
  const ctx = { state: ["count"], events: ["SAVED"] };
  assert.ok(
    has(handler(`api.setState("cnt", 1);`), "uib-undeclared-state", ctx),
  );
  assert.ok(
    !has(handler(`api.setState("count", 1);`), "uib-undeclared-state", ctx),
  );
  assert.ok(has(handler(`api.emit("SAVE", {});`), "uib-undeclared-event", ctx));
  assert.ok(
    !has(handler(`api.emit(\`SAVED\`, {});`), "uib-undeclared-event", ctx),
  );
  // No contract → silent.
  assert.ok(
    !has(
      handler(`api.setState("cnt", 1); api.emit("X");`),
      "uib-undeclared-state",
    ),
  );
  assert.ok(!has(handler(`api.emit("X");`), "uib-undeclared-event"));
  // Computed names cannot be checked.
  assert.ok(
    has(handler(`api.setState(key, 1);`), "uib-dynamic-state-key", ctx),
  );
  assert.ok(has(handler(`api.emit("E_" + n);`), "uib-dynamic-state-key", ctx));
});

test("uib-undeclared-data-resource", () => {
  const ctx = { dataResources: ["incidents"] };
  assert.ok(
    has(
      handler(`api.data.incident.refresh();`),
      "uib-undeclared-data-resource",
      ctx,
    ),
  );
  assert.ok(
    !has(
      handler(`api.data.incidents.refresh();`),
      "uib-undeclared-data-resource",
      ctx,
    ),
  );
  assert.ok(
    !has(handler(`api.data.anything;`), "uib-undeclared-data-resource"),
  );
});

test("uib-unused-import: bindings and discarded imports", () => {
  assert.ok(
    has(handler(`const util = imports["sn_app.util"]();`), "uib-unused-import"),
  );
  const r = lintUibClientScript(
    handler(`const { a, b: bee } = imports["sn_app.util"](); a();`),
  );
  const unused = r.findings.filter((f) => f.rule === "uib-unused-import");
  assert.equal(unused.length, 1);
  assert.match(unused[0].message, /bee/);
  assert.ok(has(handler(`imports["sn_app.util"];`), "uib-unused-import"));
  assert.ok(
    !has(handler(`const u = imports.util(); u.go();`), "uib-unused-import"),
  );
});

test("uib-dom-access and uib-blocking-dialog", () => {
  assert.ok(has(handler(`document.getElementById("x");`), "uib-dom-access"));
  assert.ok(has(handler(`window.location.href = "/x";`), "uib-dom-access"));
  assert.ok(has(handler(`jQuery(".a").hide();`), "uib-dom-access"));
  assert.ok(has(handler(`el.querySelector("div");`), "uib-dom-access"));
  assert.ok(has(handler(`alert("hi");`), "uib-blocking-dialog"));
  assert.ok(has(handler(`if (confirm("ok?")) {}`), "uib-blocking-dialog"));
  assert.ok(
    !has(handler(`helpers.modal.confirm("ok?");`), "uib-blocking-dialog"),
  );
});

test("uib-update-in-loop", () => {
  assert.ok(
    has(
      handler(`for (const i of items) api.setState("x", i);`),
      "uib-update-in-loop",
    ),
  );
  assert.ok(
    has(
      handler(`items.forEach(() => {}); for (;;) { api.emit("E"); break; }`),
      "uib-update-in-loop",
    ),
  );
  // A callback defined in a loop body is its own function.
  assert.ok(
    !has(
      handler(
        `for (const i of items) { cbs.push(() => api.setState("x", i)); }`,
      ),
      "uib-update-in-loop",
    ),
  );
});

test("hard-coded sys_ids and instance URLs", () => {
  assert.ok(
    has(
      handler(`const id = "0123456789abcdef0123456789abcdef";`),
      "uib-hardcoded-sys-id",
    ),
  );
  assert.ok(
    has(
      handler(`const u = "https://dev1.service-now.com/x";`),
      "uib-hardcoded-instance-url",
    ),
  );
  assert.ok(
    has(
      handler("const u = `https://acme.service-now.com/${p}`;"),
      "uib-hardcoded-instance-url",
    ),
  );
});

test("info rules: raw timers, raw http, console", () => {
  assert.ok(has(handler(`setTimeout(() => {}, 5);`), "uib-raw-timer"));
  assert.ok(has(handler(`fetch("/api/now/table/x");`), "uib-raw-http"));
  assert.ok(has(handler(`console.log(event);`), "uib-console"));
});

test("a script that does not parse yields uib-parse-error and nothing else", () => {
  const r = lintUibClientScript(
    "function handler({api}) {\n  api.setState(;\n}",
  );
  assert.equal(r.parsed, false);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, "uib-parse-error");
  assert.equal(r.findings[0].line, 2);
  // Never throws on junk input.
  assert.equal(lintUibClientScript(undefined).parsed, true);
});

test("findings are sorted by line then column and deduplicated", () => {
  const r = lintUibClientScript(handler(`gs.info(1);\nalert(gs.x);`));
  const pos = r.findings.map((f) => [f.line, f.column]);
  const sorted = [...pos].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  assert.deepEqual(pos, sorted);
  const keys = r.findings.map((f) => `${f.rule}:${f.line}:${f.column}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("uibLintContextFromMacroponent decodes the raw row", () => {
  const ctx = uibLintContextFromMacroponent({
    state_properties: JSON.stringify([
      { name: "count", valueType: "number", initialValue: 0 },
    ]),
    dispatched_events: JSON.stringify([{ name: "SAVED" }, "CLOSED"]),
    data: JSON.stringify([
      { elementId: "incidents", definition: { id: "b1" } },
    ]),
  });
  assert.deepEqual(ctx, {
    state: ["count"],
    events: ["SAVED", "CLOSED"],
    dataResources: ["incidents"],
  });
  // Unknown shapes leave the field out so the rule stays silent.
  assert.deepEqual(
    uibLintContextFromMacroponent({ dispatched_events: "{bad", data: "{}" }),
    {},
  );
  assert.equal(dispatchedEventNames({ a: 1 }), undefined);
  assert.deepEqual(dispatchedEventNames(""), []);
});

test("uibFindingsAsGeneric drops restated generic rules and the parse error", () => {
  const uib = lintUibClientScript(
    handler(`var gr = new GlideRecord("x");\napi.state.a = 1;`),
  ).findings;
  const generic = [
    { rule: "gr-on-client", severity: "error", line: 2, snippet: "", hint: "" },
  ];
  const merged = uibFindingsAsGeneric(uib, generic);
  assert.deepEqual(
    merged.map((f) => f.rule),
    ["uib-state-mutation"],
  );
  assert.deepEqual(Object.keys(merged[0]).sort(), [
    "hint",
    "line",
    "rule",
    "severity",
    "snippet",
  ]);
  assert.match(merged[0].hint, /^Direct write to api\.state\. \(col \d+\)/);
  const bad = lintUibClientScript("function (").findings;
  assert.deepEqual(uibFindingsAsGeneric(bad, []), []);
});

test("lintScript (uib_client_script) runs the UIB rules against the macroponent contract", async () => {
  const MP = "a".repeat(32);
  const reads = [];
  await withMetadataFetch(
    (url) => {
      const u = new URL(url);
      reads.push(u.pathname);
      if (u.pathname.endsWith("/sys_ux_client_script/cs1")) {
        return jsonResponse(200, {
          result: {
            name: "On save",
            macroponent: { value: MP, link: "x" },
            script: handler(
              `api.setState("count", 1);\napi.setState("cnt", 2);\napi.emit("SAVED");\napi.emit("SAVD");`,
            ),
          },
        });
      }
      if (u.pathname.endsWith("/sys_ux_macroponent")) {
        assert.equal(u.searchParams.get("sysparm_query"), `sys_id=${MP}`);
        return jsonResponse(200, {
          result: [
            {
              sys_id: MP,
              state_properties: JSON.stringify([{ name: "count" }]),
              dispatched_events: JSON.stringify(["SAVED"]),
              data: "[]",
            },
          ],
        });
      }
      return jsonResponse(404, { error: { message: "not found" } });
    },
    async () => {
      const { results } = await lintScript("uib_client_script", "cs1");
      const found = results[0].findings.map((f) => `${f.rule}:${f.line}`);
      assert.deepEqual(found.sort(), [
        "uib-undeclared-event:5",
        "uib-undeclared-state:3",
      ]);
    },
  );
  assert.ok(reads.some((p) => p.endsWith("/sys_ux_macroponent")));
});

test("lintScript (uib_client_script) without a macroponent: no contract rules, no extra read", async () => {
  const reads = [];
  await withMetadataFetch(
    (url) => {
      reads.push(new URL(url).pathname);
      return jsonResponse(200, {
        result: {
          name: "Loose",
          script: handler(
            `api.setState("anything", 1);\nwhile (api.state.busy) {}`,
          ),
        },
      });
    },
    async () => {
      const { results } = await lintScript("uib_client_script", "cs2");
      assert.deepEqual(
        results[0].findings.map((f) => f.rule),
        ["uib-loop-on-state"],
      );
    },
  );
  assert.equal(reads.length, 1);
});
