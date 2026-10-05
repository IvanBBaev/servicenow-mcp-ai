import test from "node:test";
import assert from "node:assert/strict";

import {
  buildManifest,
  readFixture,
  sinceFrom,
  sortKeys,
  MANIFEST_VERSION,
  SIZE_COMPONENTS,
  PACKAGE_VERSION,
} from "../scripts/gen-manifest.mjs";
import {
  describeAllTools,
  describeNaming,
  describeToolSchemas,
} from "../build/mcp/registry.js";
import { TOOL_OVERLAPS, TOOL_RENAMES } from "../build/mcp/naming.js";
import { errorCodeTable } from "../build/core/errors.js";
import { measureSurface, toolSizes } from "./surface.js";

test("the tool manifest matches the checked-in fixture (M-6 v2, M-2 v3, M-7 v4, N-37 v5)", () => {
  const fixture = readFixture();
  assert.equal(fixture?.manifestVersion, MANIFEST_VERSION);
  assert.deepEqual(
    buildManifest(
      describeAllTools(),
      describeToolSchemas(),
      sinceFrom(fixture),
      PACKAGE_VERSION,
      errorCodeTable(),
      describeNaming(),
      toolSizes,
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

test("manifest v3 publishes the M-2 error-code table", () => {
  const fixture = readFixture();
  const codes = fixture.errorCodes;
  for (const required of [
    "NOT_CONFIGURED",
    "POLICY_DENIED",
    "PLAN_REQUIRED",
    "PLAN_EXPIRED",
    "UNREADABLE",
    "INSTANCE_HTTP_<status>",
    "INSTANCE_HTML_RESPONSE",
    "RECIPIENT_NOT_ALLOWED",
    "CREDENTIALS_INCOMPLETE",
    "CANCELLED",
  ]) {
    assert.ok(codes[required], `errorCodes lists ${required}`);
  }
  for (const [code, info] of Object.entries(codes)) {
    assert.ok(
      ["servicenow", "server", "policy"].includes(info.source),
      `${code} has a known source`,
    );
    assert.ok(info.description.length > 0, `${code} has a description`);
  }
});

test("manifest v4 publishes the M-7 renames, parameter aliases and overlaps", () => {
  const fixture = readFixture();
  assert.equal(fixture.toolRenames.length, TOOL_RENAMES.length);
  const names = new Set(fixture.tools.map((t) => t.name));
  for (const rename of fixture.toolRenames) {
    assert.ok(names.has(rename.to), `${rename.from} -> ${rename.to} exists`);
    assert.ok(!names.has(rename.from), `${rename.from} is not a v3 name`);
    assert.ok(rename.reason.length > 0, `${rename.from} has a reason`);
  }
  for (const name of Object.keys(TOOL_OVERLAPS)) {
    const tool = fixture.tools.find((t) => t.name === name);
    assert.ok(tool?.overlap, `${name} documents why it overlaps`);
  }
  for (const tool of fixture.tools) {
    for (const map of [tool.legacyParams, tool.deprecatedParams]) {
      for (const [from, to] of Object.entries(map ?? {})) {
        assert.ok(
          tool.inputSchema.properties?.[to],
          `${tool.name}: alias ${from} targets the real parameter ${to}`,
        );
        if (map === tool.legacyParams) {
          assert.equal(
            tool.inputSchema.properties?.[from],
            undefined,
            `${tool.name}: legacy ${from} is not published with the flag off`,
          );
        }
      }
    }
  }
});

test("manifest v5 records per-tool sizes equal to the published tools/list entry (N-37)", async () => {
  const fixture = readFixture();
  const { perTool } = await measureSurface("all");
  const wire = new Map(perTool.map((t) => [t.name, t]));
  assert.equal(wire.size, fixture.tools.length, "every tool is published");
  for (const tool of fixture.tools) {
    assert.deepEqual(Object.keys(tool.sizes), SIZE_COMPONENTS, tool.name);
    const published = wire.get(tool.name);
    for (const component of SIZE_COMPONENTS) {
      assert.equal(
        tool.sizes[component],
        published[component],
        `${tool.name}.${component} matches the wire`,
      );
    }
  }
  // Without a measurer the manifest carries no sizes (pure builds above).
  const [bare] = buildManifest(describeAllTools(), describeToolSchemas()).tools;
  assert.equal(bare.sizes, undefined);
});
