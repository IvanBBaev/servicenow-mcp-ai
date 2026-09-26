import test from "node:test";
import assert from "node:assert/strict";

import { ALL_TOOLS } from "../build/mcp/registry.js";
import {
  buildInputSchema,
  buildOutputSchema,
  sysId,
  tableName,
  fieldName,
  encodedQuery,
  fieldList,
  shortText,
  longText,
  tableList,
  sysIdList,
  email,
  recipients,
  ENCODED_QUERY_MAX,
} from "../build/mcp/define.js";

/**
 * M-8 (GAP L2-06 / L2-07): the input leaves deliberately left without a
 * schema bound, each with the run-time cap that governs it instead.
 */
const INTENTIONALLY_UNBOUNDED = new Map([
  // Record field values: any column value, sized by the instance itself.
  ["servicenow_create_record.fields{}", "field values (instance-sized)"],
  ["servicenow_update_record.fields{}", "field values (instance-sized)"],
  ["servicenow_upsert_record.fields{}", "field values (instance-sized)"],
  ["servicenow_upsert_record.key{}", "field values (instance-sized)"],
  ["servicenow_insert_import_set_row.fields{}", "field values"],
  ["servicenow_create_change.fields{}", "field values"],
  ["servicenow_update_change.fields{}", "field values"],
  ["servicenow_create_ci.attributes{}", "CI attribute values"],
  ["servicenow_update_ci.attributes{}", "CI attribute values"],
  ["servicenow_identify_reconcile.items[].values{}", "CI attribute values"],
  ["servicenow_order_catalog_item.variables{}", "catalog variable values"],
  // Payloads capped by an SN_* setting at run time.
  ["servicenow_upload_attachment.content_base64", "SN_MAX_UPLOAD_BYTES"],
  ["servicenow_docs_write.content", "SN_DOCS_MAX_FILE_BYTES"],
  ["servicenow_batch.requests[].body", "SN_MAX_BODY_BYTES"],
  // Left to S-9 (where-used rework) to avoid a merge conflict.
  ["servicenow_where_used.name", "S-9"],
]);

/** Walk a zod schema, collecting every unbounded string, array and record leaf. */
function unboundedLeaves(schema, path, out) {
  const d = schema._def;
  switch (d.typeName) {
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
      return unboundedLeaves(d.innerType, path, out);
    case "ZodEffects":
      return unboundedLeaves(d.schema, path, out);
    case "ZodString":
      if (!d.checks.some((c) => c.kind === "max" || c.kind === "length"))
        out.push(path);
      return;
    case "ZodArray":
      if (!d.maxLength) out.push(path);
      return unboundedLeaves(d.type, `${path}[]`, out);
    case "ZodObject":
      for (const [k, v] of Object.entries(d.shape()))
        unboundedLeaves(v, `${path}.${k}`, out);
      return;
    case "ZodRecord":
      return unboundedLeaves(d.valueType, `${path}{}`, out);
    case "ZodUnion":
      for (const o of d.options) unboundedLeaves(o, path, out);
      return;
    case "ZodUnknown":
      out.push(path);
      return;
    default:
      return;
  }
}

test("every tool input string/array is bounded, except the documented allow-list", () => {
  const found = new Set();
  for (const spec of ALL_TOOLS) {
    const out = [];
    unboundedLeaves(buildInputSchema(spec), spec.name, out);
    out.forEach((p) => found.add(p));
  }
  const unexpected = [...found].filter((p) => !INTENTIONALLY_UNBOUNDED.has(p));
  assert.deepEqual(unexpected, [], "new unbounded input parameters");
  // The allow-list stays honest: every entry is still an unbounded leaf.
  const stale = [...INTENTIONALLY_UNBOUNDED.keys()].filter(
    (p) => !found.has(p),
  );
  assert.deepEqual(stale, [], "allow-list entries that are bounded now");
});

test("output schemas do not reach the input bounds walk (M-6)", () => {
  // The walker covers inputs only: output shapes are deliberately loose
  // (z.unknown(), unbounded arrays) and bound nothing a client sends. It
  // still accepts them without throwing, and declaring an output shape never
  // changes the input leaves the bounds check sees.
  for (const spec of ALL_TOOLS.filter((s) => s.output)) {
    const outLeaves = [];
    unboundedLeaves(buildOutputSchema(spec), `${spec.name}#out`, outLeaves);
    const withOutput = [];
    unboundedLeaves(buildInputSchema(spec), spec.name, withOutput);
    const withoutOutput = [];
    unboundedLeaves(
      buildInputSchema({ ...spec, output: undefined }),
      spec.name,
      withoutOutput,
    );
    assert.deepEqual(withOutput, withoutOutput, spec.name);
  }
});

test("every tool declares all four annotation hints (M-8 / L4-07)", () => {
  for (const spec of ALL_TOOLS) {
    const a = spec.annotations;
    for (const key of [
      "readOnlyHint",
      "destructiveHint",
      "idempotentHint",
      "openWorldHint",
    ]) {
      assert.equal(typeof a[key], "boolean", `${spec.name}.${key}`);
    }
    if (a.readOnlyHint) {
      assert.equal(a.destructiveHint, false, `${spec.name} read-only`);
    }
  }
  const byName = new Map(ALL_TOOLS.map((s) => [s.name, s.annotations]));
  assert.equal(byName.get("servicenow_docs_write").destructiveHint, true);
  for (const name of [
    "servicenow_docs_list",
    "servicenow_docs_read",
    "servicenow_docs_search",
  ]) {
    assert.equal(byName.get(name).openWorldHint, false, name);
  }
});

test("buildInputSchema: strict object with the automatic instance parameter", () => {
  const spec = ALL_TOOLS.find((s) => s.name === "servicenow_get_record");
  const schema = buildInputSchema(spec);
  assert.ok(
    schema.safeParse({ table: "incident", sys_id: "a".repeat(32) }).success,
  );
  assert.ok(
    schema.safeParse({ table: "incident", sys_id: "x", instance: "dev" })
      .success,
  );
  const typo = schema.safeParse({ tabel: "incident", sys_id: "x" });
  assert.equal(typo.success, false);
  assert.ok(
    schema.safeParse({
      table: "incident",
      sys_id: "x",
      instance: "d".repeat(129),
    }).success === false,
  );
});

test("sysId: accepts generated and readable ids, rejects URL/query metacharacters", () => {
  for (const ok of [
    "0123456789abcdef0123456789abcdef",
    "global",
    "-1",
    "A_b-9",
  ])
    assert.ok(sysId().safeParse(ok).success, ok);
  for (const bad of [
    "",
    "a".repeat(33),
    "abc/def",
    "a?b",
    "a^b",
    "a b",
    "../x",
  ])
    assert.equal(sysId().safeParse(bad).success, false, bad);
});

test("tableName: letters, digits and underscore up to 80", () => {
  for (const ok of [
    "incident",
    "x_acme_app_table",
    "u_Custom1",
    "a".repeat(80),
  ])
    assert.ok(tableName().safeParse(ok).success, ok);
  for (const bad of ["", "a".repeat(81), "incident/1", "inc^ident", "sys user"])
    assert.equal(tableName().safeParse(bad).success, false, bad);
});

test("fieldName / fieldList: dot-walks and comma lists, no query syntax", () => {
  for (const ok of ["short_description", "caller_id.name", "number, state"])
    assert.ok(fieldName().safeParse(ok).success, ok);
  for (const bad of ["", "a^b", "a=b", "a,", "x".repeat(256)])
    assert.equal(fieldName().safeParse(bad).success, false, bad);
  assert.ok(fieldList().safeParse(Array(200).fill("a")).success);
  assert.equal(fieldList().safeParse(Array(201).fill("a")).success, false);
});

test("text and list builders enforce their maximum lengths", () => {
  assert.ok(encodedQuery().safeParse("a".repeat(ENCODED_QUERY_MAX)).success);
  assert.equal(
    encodedQuery().safeParse("a".repeat(ENCODED_QUERY_MAX + 1)).success,
    false,
  );
  assert.equal(encodedQuery(10).safeParse("a".repeat(11)).success, false);
  assert.ok(shortText().safeParse("a".repeat(255)).success);
  assert.equal(shortText().safeParse("a".repeat(256)).success, false);
  assert.ok(longText().safeParse("a".repeat(100_000)).success);
  assert.equal(longText(5).safeParse("abcdef").success, false);
  assert.ok(tableList().safeParse(["incident", "problem"]).success);
  assert.equal(tableList(1).safeParse(["a", "b"]).success, false);
  assert.ok(sysIdList().safeParse(Array(500).fill("abc")).success);
  assert.equal(sysIdList().safeParse(Array(501).fill("abc")).success, false);
  assert.equal(sysIdList().safeParse(["a/b"]).success, false);
});

test("email / recipients", () => {
  assert.ok(email().safeParse("a@example.com").success);
  assert.equal(email().safeParse("A <a@example.com>").success, false);
  assert.equal(recipients().safeParse([]).success, false);
  assert.equal(
    recipients(2).safeParse(["a@x.io", "b@x.io", "c@x.io"]).success,
    false,
  );
});
