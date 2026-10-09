import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  effectivePackages,
  registerAllTools,
  registerResources,
} from "../build/mcp/registry.js";
import { registerPrompts } from "../build/mcp/prompts.js";
import { createRuntime } from "../build/core/runtime.js";
import { TOOL_EXAMPLES } from "../build/mcp/tool-examples.js";
import { PROFILES, listPublishedTools } from "./surface.js";
import { baselineEnv, withEnv } from "./helpers.js";

/**
 * N-35 / ADR 0008, conformance step `shape`: the published surface matches the
 * 2026-07-28 shape rules on every profile. Schemas are JSON Schema 2020-12
 * (the default dialect, base-16 … base-23), tool names keep to the
 * recommended charset and length (tools-08 … tools-12), and resource URIs
 * are RFC 3986 (resources-07). Ajv comes with the MCP SDK; the 2020-12 build
 * is the reference validator here.
 */

baselineEnv();

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js").default;

/**
 * A strict 2020-12 validator: unknown keywords and bad patterns are errors.
 * Union `type` arrays are valid 2020-12, so Ajv's own opinion on them is off.
 */
function ajv() {
  return new Ajv2020({
    strict: true,
    allowUnionTypes: true,
    allErrors: true,
    validateFormats: false,
  });
}

/**
 * The schemas a client receives. Only the lean list (N-58) is served; the SDK's
 * raw list (measurement only) declares draft-07 `$schema`, which the lean
 * serializer drops, so the default 2020-12 dialect applies on the wire.
 */
async function schemasOf(profile) {
  const tools = await listPublishedTools(PROFILES[profile]);
  return tools.flatMap((tool) =>
    ["inputSchema", "outputSchema"]
      .filter((key) => tool[key] !== undefined)
      .map((key) => ({
        where: `${profile} ${tool.name}.${key}`,
        schema: tool[key],
      })),
  );
}

test("every published schema is valid JSON Schema 2020-12 on every profile", async () => {
  for (const profile of Object.keys(PROFILES)) {
    const schemas = await schemasOf(profile);
    assert.ok(schemas.length > 0, profile);
    for (const { where, schema } of schemas) {
      assert.equal(schema.$schema, undefined, `${where} declares a dialect`);
      const validator = ajv();
      assert.ok(
        validator.validateSchema(schema),
        `${where}: ${validator.errorsText(validator.errors)}`,
      );
      // Strict compilation also rejects unknown keywords and bad patterns.
      assert.doesNotThrow(() => validator.compile(schema), where);
    }
  }
});

test("every example call validates against its published 2020-12 input schema", async () => {
  const tools = await listPublishedTools(PROFILES["all+tasks"]);
  let checked = 0;
  for (const tool of tools) {
    const example = TOOL_EXAMPLES[tool.name];
    if (!example) continue;
    const validate = ajv().compile(tool.inputSchema);
    assert.ok(
      validate(example.arguments),
      `${tool.name}: ${JSON.stringify(validate.errors)}`,
    );
    checked += 1;
  }
  assert.ok(
    checked >= Object.keys(TOOL_EXAMPLES).length - 1,
    `${checked} examples`,
  );
});

test("the README states the schema dialect", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(
    readme,
    /is written in JSON Schema 2020-12, the MCP default dialect, without a `\$schema` field\. The server supports no other dialect/,
  );
});

test("tool names: 1–128 characters of [A-Za-z0-9_.-], unique, case-insensitively too", async () => {
  for (const profile of Object.keys(PROFILES)) {
    const names = (await listPublishedTools(PROFILES[profile])).map(
      (t) => t.name,
    );
    for (const name of names) {
      assert.match(name, /^[A-Za-z0-9_.-]{1,128}$/, `${profile}: ${name}`);
    }
    assert.equal(
      new Set(names).size,
      names.length,
      `${profile}: duplicate name`,
    );
    const folded = names.map((n) => n.toLowerCase());
    assert.equal(
      new Set(folded).size,
      names.length,
      `${profile}: names differ only by case`,
    );
  }
});

/** RFC 3986 `scheme ":" hier-part` with no character outside the URI set. */
const URI = /^[A-Za-z][A-Za-z0-9+.-]*:[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*$/;
/** The same for an RFC 6570 template: `{…}` expressions allowed. */
const URI_TEMPLATE =
  /^[A-Za-z][A-Za-z0-9+.-]*:[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%{}]*$/;

test("resource URIs and templates are RFC 3986 with a valid scheme", async () => {
  await withEnv(
    { SN_TOOL_PACKAGES: "all", SN_PACKAGES_DENY: "", SN_PACKAGES_READONLY: "" },
    async () => {
      const runtime = createRuntime();
      const server = new McpServer({ name: "shape", version: "0.0.0" });
      registerAllTools(server, runtime);
      registerResources(server);
      registerPrompts(server, effectivePackages().enabled);
      const client = new Client({ name: "shape-client", version: "0.0.0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(b), client.connect(a)]);
      try {
        const { resources } = await client.listResources();
        const { resourceTemplates } = await client.listResourceTemplates();
        assert.ok(resources.length > 0 && resourceTemplates.length > 0);
        for (const { uri } of resources) {
          assert.match(uri, URI, uri);
          assert.doesNotThrow(() => new URL(uri), uri);
        }
        for (const { uriTemplate } of resourceTemplates) {
          assert.match(uriTemplate, URI_TEMPLATE, uriTemplate);
        }
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
});
