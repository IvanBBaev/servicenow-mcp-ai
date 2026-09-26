import test from "node:test";
import assert from "node:assert/strict";

import {
  buildManifest,
  readFixture,
  sinceFrom,
  sortKeys,
  MANIFEST_VERSION,
  PACKAGE_VERSION,
} from "../scripts/gen-manifest.mjs";
import {
  describeAllTools,
  describeToolSchemas,
} from "../build/mcp/registry.js";

test("the tool manifest matches the checked-in fixture (M-6 v2)", () => {
  const fixture = readFixture();
  assert.equal(fixture?.manifestVersion, MANIFEST_VERSION);
  assert.deepEqual(
    buildManifest(
      describeAllTools(),
      describeToolSchemas(),
      sinceFrom(fixture),
    ),
    fixture,
    "Tool surface changed — if intentional, run `npm run gen:manifest` and commit the fixture diff",
  );
});

test("manifest v2 pins schemas, a description hash and since", () => {
  const manifest = buildManifest(describeAllTools(), describeToolSchemas());
  for (const tool of manifest.tools) {
    assert.match(tool.description_sha256, /^[0-9a-f]{64}$/, tool.name);
    assert.equal(tool.since, PACKAGE_VERSION, "no history: current version");
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.deepEqual(
      Object.keys(tool.inputSchema),
      Object.keys(tool.inputSchema).sort(),
      `${tool.name} inputSchema keys are sorted`,
    );
  }
  const status = manifest.tools.find((t) => t.name === "servicenow_get_status");
  assert.equal(status.outputSchema?.type, "object");
});

test("since survives regeneration; sortKeys sorts deeply, keeps arrays", () => {
  const tools = describeAllTools().slice(0, 1);
  const schemas = describeToolSchemas();
  const since = new Map([[tools[0].name, "1.0.0"]]);
  const [first] = buildManifest(tools, schemas, since, "9.9.9").tools;
  assert.equal(first.since, "1.0.0");
  assert.equal(sinceFrom({ tools: [first] }).get(first.name), "1.0.0");
  assert.deepEqual(
    JSON.stringify(sortKeys({ b: 1, a: { d: [3, 1], c: 2 } })),
    '{"a":{"c":2,"d":[3,1]},"b":1}',
  );
});
