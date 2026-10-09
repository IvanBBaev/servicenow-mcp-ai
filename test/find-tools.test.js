import test from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ALL_TOOLS, registerAllTools } from "../build/mcp/registry.js";
import {
  FIND_TOOLS_DEFAULT_LIMIT,
  findTools,
  terms,
} from "../build/mcp/tool-search.js";
import { createRuntime } from "../build/core/runtime.js";
import { baselineEnv, withEnv } from "./helpers.js";

baselineEnv();

/**
 * N-36 — servicenow_find_tools: a core client finds a tool of a package it
 * has not loaded, by intent, and learns which package to enable.
 */

const entry = (name, pkg, description, extra = {}) => ({
  name,
  package: pkg,
  title: name,
  description,
  readOnly: true,
  enabled: false,
  ...extra,
});

test("N-36: terms lower-case, split and drop plural endings", () => {
  assert.deepEqual(terms("Run ATF suites"), ["run", "atf", "suite"]);
  assert.deepEqual(terms("system_properties, class"), [
    "system",
    "property",
    "class",
  ]);
  assert.deepEqual(terms("a b"), []);
});

test("N-36: a name hit outranks a description hit, and stopwords are ignored", () => {
  const catalog = [
    entry(
      "servicenow_list_scripts",
      "scripts",
      "List flows that call a script.",
    ),
    entry("servicenow_get_flow", "flows", "Read one flow."),
  ];
  const [first, second] = findTools(catalog, "show me the flow");
  assert.equal(first.name, "servicenow_get_flow");
  assert.equal(second.name, "servicenow_list_scripts");
  assert.ok(first.score > second.score);
  assert.deepEqual(findTools(catalog, "the tools to use"), []);
});

test("N-36: prefixes match at half weight; ties favour enabled tools", () => {
  const catalog = [
    entry("servicenow_list_ci_relations", "cmdb", "CI relations."),
    entry("servicenow_get_ci", "cmdb", "One CI.", { enabled: true }),
    entry("servicenow_get_change", "change", "One change."),
  ];
  const [hit] = findTools(catalog, "relationships");
  assert.equal(hit.name, "servicenow_list_ci_relations");
  assert.equal(hit.score, 1.5);
  // Equal scores: the enabled get_ci goes before get_change despite the name.
  const tie = findTools(catalog, "one");
  assert.deepEqual(
    tie.map((m) => m.name),
    ["servicenow_get_ci", "servicenow_get_change"],
  );
});

test("N-36: the limit caps the matches", () => {
  const catalog = Array.from({ length: 30 }, (_, i) =>
    entry(`servicenow_get_thing${i}`, "table", "Get a record."),
  );
  assert.equal(findTools(catalog, "record").length, FIND_TOOLS_DEFAULT_LIMIT);
  assert.equal(findTools(catalog, "record", { limit: 3 }).length, 3);
});

/** A connected in-memory client over a server built like src/index.ts. */
async function session(env, fn) {
  return withEnv(
    { SN_PACKAGES_DENY: "", SN_PACKAGES_READONLY: "", ...env },
    async () => {
      const server = new McpServer({ name: "n36-test", version: "0.0.0" });
      registerAllTools(server, createRuntime());
      const client = new Client({ name: "n36-client", version: "0.0.0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(b), client.connect(a)]);
      const find = async (query, extra = {}) =>
        (
          await client.callTool({
            name: "servicenow_find_tools",
            arguments: { query, ...extra },
          })
        ).structuredContent;
      try {
        return await fn({ client, find });
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
}

test("N-36: find_tools is in the core tools/list", async () => {
  await session({ SN_TOOL_PACKAGES: "core" }, async ({ client }) => {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes("servicenow_find_tools"));
  });
});

test("N-36: a core client finds an ATF tool and the package to enable", async () => {
  await session({ SN_TOOL_PACKAGES: "core" }, async ({ client, find }) => {
    const found = await find("run an ATF suite", { limit: 3 });
    assert.equal(found.matches[0].name, "servicenow_run_atf_suite");
    assert.deepEqual(Object.keys(found.matches[0]).sort(), [
      "description",
      "enabled",
      "name",
      "package",
      "readOnly",
      "title",
    ]);
    assert.equal(found.matches[0].enabled, false);
    assert.equal(found.matches[0].package, "atf");
    assert.match(found.hint, /servicenow_enable_package: atf\./);

    await client.callTool({
      name: "servicenow_enable_package",
      arguments: { name: "atf" },
    });
    const again = await find("run an ATF suite", { limit: 3 });
    assert.equal(again.matches[0].enabled, true);
    assert.equal(again.hint, undefined);
  });
});

test("N-36: denied packages and read-only write tools are never offered", async () => {
  await session(
    {
      SN_TOOL_PACKAGES: "core",
      SN_PACKAGES_DENY: "atf",
      SN_PACKAGES_READONLY: "change",
    },
    async ({ find }) => {
      const atf = await find("ATF test suite", { limit: 25 });
      assert.ok(atf.matches.every((m) => m.package !== "atf"));
      const change = await find("create change request", { limit: 25 });
      const changeTools = change.matches.filter((m) => m.package === "change");
      assert.ok(changeTools.length > 0);
      assert.ok(
        changeTools.every((m) => m.readOnly),
        "only read tools",
      );
    },
  );
});

test("N-36: every searchable tool is a manifest tool outside admin", async () => {
  await session({ SN_TOOL_PACKAGES: "core" }, async ({ find }) => {
    const names = new Set(
      ALL_TOOLS.filter((t) => t.package !== "admin").map((t) => t.name),
    );
    const found = await find("record", { limit: 25 });
    assert.ok(found.matches.length > 0);
    for (const m of found.matches) assert.ok(names.has(m.name), m.name);
  });
});
