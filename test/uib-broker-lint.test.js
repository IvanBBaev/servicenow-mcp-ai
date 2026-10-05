// N-29 — the pure UI Builder data broker rules (src/api/uib-broker-lint.ts):
// field decoding, the unchecked-GlideRecord scan and the three rules.
import test from "node:test";
import assert from "node:assert/strict";

import {
  UIB_BROKER_RULES,
  brokerMutates,
  hasInputSchema,
  lintUibBroker,
  uncheckedGlideRecord,
} from "../build/api/uib-broker-lint.js";

const rules = (findings) => findings.map((f) => f.rule).sort();

test("rule catalogue: three rules with their severities", () => {
  assert.deepEqual(
    UIB_BROKER_RULES.map((r) => [r.id, r.severity]),
    [
      ["uib-broker-mutates-no-acl", "error"],
      ["uib-transform-gliderecord-no-acl-check", "warn"],
      ["uib-broker-no-input-schema", "info"],
    ],
  );
});

test("brokerMutates reads booleans and strings; unknown stays undefined", () => {
  assert.equal(brokerMutates(true), true);
  assert.equal(brokerMutates("true"), true);
  assert.equal(brokerMutates("1"), true);
  assert.equal(brokerMutates("false"), false);
  assert.equal(brokerMutates(""), false);
  assert.equal(brokerMutates(undefined), undefined);
  assert.equal(brokerMutates("maybe"), undefined);
});

test("hasInputSchema: arrays, schema objects, empty and undecodable values", () => {
  assert.equal(hasInputSchema(undefined), undefined);
  assert.equal(hasInputSchema(""), false);
  assert.equal(hasInputSchema("[]"), false);
  assert.equal(hasInputSchema('[{"name":"table"}]'), true);
  assert.equal(hasInputSchema('{"properties":{}}'), false);
  assert.equal(hasInputSchema('{"properties":{"id":{}}}'), true);
  assert.equal(hasInputSchema("{}"), false);
  assert.equal(hasInputSchema("{not json"), undefined);
});

test("uncheckedGlideRecord: first query line unless access is checked", () => {
  const bare =
    "function t(input) {\n  var gr = new GlideRecord('incident');\n  gr.query();\n}";
  assert.equal(uncheckedGlideRecord(bare), 2);
  assert.equal(
    uncheckedGlideRecord(
      "var gr = new GlideRecord('incident');\nif (!gr.canRead()) return;",
    ),
    null,
  );
  assert.equal(
    uncheckedGlideRecord(
      "var gr = new GlideRecordSecure('incident');\nvar ga = new GlideAggregate('task');",
    ),
    null,
  );
  assert.equal(uncheckedGlideRecord("return input.a + 1;"), null);
  // Unparseable source falls back to the regex scan.
  assert.equal(uncheckedGlideRecord("var x = {\nnew GlideRecord('x'"), 2);
  assert.equal(
    uncheckedGlideRecord("var x = {\nnew GlideRecord('x'); gs.hasRole('admin'"),
    null,
  );
});

test("lintUibBroker: each rule fires only on known evidence", () => {
  const script = "var gr = new GlideRecord('incident');\ngr.query();";
  assert.deepEqual(
    rules(
      lintUibBroker(
        {
          kind: "transform",
          mutates_server_data: "true",
          properties: "[]",
          script,
        },
        { hasAcl: false },
      ),
    ),
    [
      "uib-broker-mutates-no-acl",
      "uib-broker-no-input-schema",
      "uib-transform-gliderecord-no-acl-check",
    ],
  );
  // ACLs unknown, fields not returned: nothing fires.
  assert.deepEqual(
    lintUibBroker({
      kind: "transform",
      mutates_server_data: "true",
      script: "",
    }),
    [],
  );
  // An ACL guards it; the script rule is transform-only.
  assert.deepEqual(
    lintUibBroker(
      {
        kind: "rest",
        mutates_server_data: true,
        properties: '[{"name":"q"}]',
        script,
      },
      { hasAcl: true },
    ),
    [],
  );
  const [f] = lintUibBroker({ kind: "transform", script });
  assert.equal(f.rule, "uib-transform-gliderecord-no-acl-check");
  assert.equal(f.severity, "warn");
  assert.equal(f.line, 1);
  assert.match(f.hint, /GlideRecordSecure/);
});
