import test from "node:test";
import assert from "node:assert/strict";

import {
  leanJsonSchema,
  leanTool,
  leanToolsList,
  wireAnnotations,
} from "../build/mcp/lean-list.js";
import { baselineEnv } from "./helpers.js";
import { PROFILES, listPublishedTools } from "./surface.js";

baselineEnv();

/**
 * N-58 — the lean `tools/list` serializer (src/mcp/lean-list.ts), wired since
 * O-10 (b) (ADR 0006): these tests pin each rule, that the wire carries the
 * lean form of the SDK's list, and the saving on the real surface.
 */

const MAX = Number.MAX_SAFE_INTEGER;

test("rule 1: $schema is dropped at the root only as a keyword", () => {
  const lean = leanJsonSchema({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { $schema: { type: "string" } },
  });
  assert.deepEqual(lean, {
    type: "object",
    properties: { $schema: { type: "string" } },
  });
});

test("rule 3: maxLength goes only when an anchored class pattern bounds it", () => {
  const drop = {
    type: "string",
    maxLength: 80,
    pattern: "^[A-Za-z0-9_]{1,80}$",
  };
  assert.deepEqual(leanJsonSchema(drop), {
    type: "string",
    pattern: "^[A-Za-z0-9_]{1,80}$",
  });
  // A maxLength below the pattern's bound is a real constraint.
  const tighter = { type: "string", maxLength: 40, pattern: "^[a-z]{1,80}$" };
  assert.deepEqual(leanJsonSchema(tighter), tighter);
  // The comma field list (`+`) and the email pattern keep their bound.
  const list = {
    type: "string",
    maxLength: 255,
    pattern: "^[A-Za-z0-9_.]+(?:\\s*,\\s*[A-Za-z0-9_.]+)*$",
  };
  assert.deepEqual(leanJsonSchema(list), list);
  const email = {
    type: "string",
    maxLength: 254,
    pattern: "^[^@\\s]{1,64}@[^@\\s]+$",
  };
  assert.deepEqual(leanJsonSchema(email), email);
  // minLength stays.
  assert.equal(
    leanJsonSchema({
      minLength: 1,
      maxLength: 32,
      pattern: "^[a-f0-9]{32,32}$",
    }).minLength,
    1,
  );
});

test("rule 4: only the ±(2^53−1) integer bounds are dropped", () => {
  assert.deepEqual(
    leanJsonSchema({ type: "integer", minimum: -MAX, maximum: MAX }),
    { type: "integer" },
  );
  const real = { type: "integer", minimum: 0, maximum: 1000 };
  assert.deepEqual(leanJsonSchema(real), real);
});

test("rule 5: propertyNames {type: string} is dropped, others stay", () => {
  assert.deepEqual(
    leanJsonSchema({
      type: "object",
      propertyNames: { type: "string" },
      additionalProperties: {},
    }),
    { type: "object", additionalProperties: {} },
  );
  const bounded = {
    type: "object",
    propertyNames: { type: "string", maxLength: 40 },
  };
  assert.deepEqual(leanJsonSchema(bounded), bounded);
});

test("the walk follows schema positions and never a property name", () => {
  const schema = {
    type: "object",
    properties: {
      maximum: { type: "integer", maximum: MAX },
      propertyNames: { type: "string" },
      list: {
        type: "array",
        items: { type: "integer", minimum: -MAX },
      },
      either: {
        anyOf: [{ type: "string", maxLength: 8, pattern: "^[a-z]{1,8}$" }],
      },
    },
  };
  const before = JSON.stringify(schema);
  assert.deepEqual(leanJsonSchema(schema), {
    type: "object",
    properties: {
      maximum: { type: "integer" },
      propertyNames: { type: "string" },
      list: { type: "array", items: { type: "integer" } },
      either: { anyOf: [{ type: "string", pattern: "^[a-z]{1,8}$" }] },
    },
  });
  // Pure: the input is not mutated.
  assert.equal(JSON.stringify(schema), before);
});

test("rule 6: wireAnnotations keeps every non-default hint", () => {
  assert.deepEqual(
    wireAnnotations({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    }),
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  );
  assert.deepEqual(
    wireAnnotations({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    }),
    { openWorldHint: false },
  );
  // A write tool that does not destroy says so.
  assert.deepEqual(
    wireAnnotations({ readOnlyHint: false, destructiveHint: false }),
    { destructiveHint: false },
  );
  assert.deepEqual(wireAnnotations(undefined), {});
});

test("rule 2: execution goes only when it is the forbidden default", () => {
  const base = { name: "x", inputSchema: { type: "object" } };
  assert.equal(
    "execution" in
      leanTool({ ...base, execution: { taskSupport: "forbidden" } }),
    false,
  );
  assert.deepEqual(
    leanTool({ ...base, execution: { taskSupport: "optional" } }).execution,
    { taskSupport: "optional" },
  );
});

/** Every schema node of a published tool, keywords only. */
function* schemaNodes(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  yield schema;
  for (const key of ["items", "additionalProperties", "not", "contains"]) {
    yield* schemaNodes(schema[key]);
  }
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    for (const s of schema[key] ?? []) yield* schemaNodes(s);
  }
  for (const key of ["properties", "patternProperties", "$defs"]) {
    for (const s of Object.values(schema[key] ?? {})) yield* schemaNodes(s);
  }
}

/** The hints a client reads, with the MCP defaults filled in. */
const effectiveHints = (a = {}) => {
  const readOnly = a.readOnlyHint ?? false;
  return {
    readOnlyHint: readOnly,
    destructiveHint: readOnly
      ? (a.destructiveHint ?? false)
      : (a.destructiveHint ?? true),
    idempotentHint: a.idempotentHint ?? false,
    openWorldHint: a.openWorldHint ?? true,
  };
};

for (const [profile, env] of Object.entries(PROFILES)) {
  test(`lean ${profile} surface: rules hold and meaning is unchanged`, async () => {
    const tools = await listPublishedTools(env, { raw: true });
    const lean = leanToolsList(tools);
    assert.equal(lean.length, tools.length);
    // The wire is exactly the lean form of the SDK's list.
    assert.deepEqual(await listPublishedTools(env), lean);
    lean.forEach((tool, i) => {
      const original = tools[i];
      assert.equal(tool.name, original.name);
      assert.equal(tool.description, original.description);
      assert.equal(tool.title, original.title);
      if (!env.SN_EXPERIMENTAL_TASKS) assert.equal("execution" in tool, false);
      // The model reads the same hints once the defaults are applied.
      const hints = effectiveHints(original.annotations);
      if (original.annotations?.readOnlyHint === true) {
        // A read tool keeps an explicit destructiveHint:false.
        assert.equal(tool.annotations.destructiveHint, false, tool.name);
      }
      assert.deepEqual(effectiveHints(tool.annotations), hints, tool.name);
      for (const schema of [tool.inputSchema, tool.outputSchema]) {
        if (!schema) continue;
        assert.equal("$schema" in schema, false, tool.name);
        for (const node of schemaNodes(schema)) {
          // Dialect guard: the lean schemas need no 2020-12-only keyword.
          for (const k of ["$ref", "$defs", "prefixItems", "format"]) {
            assert.equal(k in node, false, `${tool.name}: ${k}`);
          }
          assert.notEqual(node.maximum, MAX, tool.name);
          assert.notEqual(node.minimum, -MAX, tool.name);
          assert.notDeepEqual(
            node.propertyNames,
            { type: "string" },
            tool.name,
          );
        }
      }
      // Idempotent: a second pass changes nothing.
      assert.deepEqual(leanTool(tool), tool);
    });
  });
}

test("lean projection saves what the plan measured (N-58)", async () => {
  // TOKEN-OPTIMIZATION-PLAN-2026-10 §1.2: core −4,191 B, all −16,493 B on
  // the 2026-10-05 surface. A floor, so a later spec change cannot hide a
  // broken rule; the exact figures are in `npm run tokens:report`.
  const saved = async (env) =>
    JSON.stringify(await listPublishedTools(env, { raw: true })).length -
    JSON.stringify(await listPublishedTools(env)).length;
  assert.ok((await saved(PROFILES.core)) >= 4000);
  assert.ok((await saved(PROFILES.all)) >= 16000);
});
