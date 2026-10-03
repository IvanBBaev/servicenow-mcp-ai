import test from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ToolListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  ALL_TOOLS,
  activeToolSpecs,
  effectivePackages,
  registerAllTools,
  registerResources,
} from "../build/mcp/registry.js";
import { registerPrompts } from "../build/mcp/prompts.js";
import {
  LIST_CHANGED_NOTIFICATIONS,
  PackageSession,
  notifyProfileChanged,
  packageSessionOf,
  requirementMet,
} from "../build/mcp/packages.js";
import { buildStatusPayload } from "../build/mcp/status.js";
import { createRuntime, runWithRuntime } from "../build/core/runtime.js";
import { baselineEnv, withEnv, flushAsync } from "./helpers.js";

baselineEnv();

/**
 * M-5 — dynamic packages: every permitted tool is registered up front and
 * toggled per session with servicenow_enable_package / _disable_package; the
 * SDK announces each change with a (debounced) list_changed notification.
 */

const CODECHECK_TOOLS = ALL_TOOLS.filter((t) => t.package === "codecheck").map(
  (t) => t.name,
);

/** A connected in-memory client over a server built like src/index.ts. */
async function session(env, fn) {
  return withEnv(
    { SN_PACKAGES_DENY: "", SN_PACKAGES_READONLY: "", ...env },
    async () => {
      const runtime = createRuntime();
      const server = new McpServer(
        { name: "m5-test", version: "0.0.0" },
        {
          capabilities: { logging: {} },
          debouncedNotificationMethods: LIST_CHANGED_NOTIFICATIONS,
        },
      );
      registerAllTools(server, runtime);
      registerResources(server);
      registerPrompts(server, effectivePackages().enabled);
      const client = new Client({ name: "m5-client", version: "0.0.0" });
      const seen = { tools: 0, prompts: 0, resources: 0, updated: [] };
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        seen.tools += 1;
      });
      client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
        seen.prompts += 1;
      });
      client.setNotificationHandler(
        ResourceListChangedNotificationSchema,
        () => {
          seen.resources += 1;
        },
      );
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
        seen.updated.push(n.params.uri);
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(b), client.connect(a)]);
      const call = async (name, args = {}) => {
        const result = await client.callTool({ name, arguments: args });
        await flushAsync();
        return result;
      };
      const names = async () =>
        (await client.listTools()).tools.map((t) => t.name).sort();
      try {
        return await fn({ client, server, runtime, seen, call, names });
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
}

const text = (result) => result.content.map((c) => c.text).join("\n");

test("M-5: default tools/list is unchanged for core and all", async () => {
  for (const packages of [undefined, "core", "all"]) {
    await session({ SN_TOOL_PACKAGES: packages }, async ({ names }) => {
      const expected = activeToolSpecs()
        .map((t) => t.name)
        .sort();
      assert.deepEqual(await names(), expected, `profile ${packages}`);
    });
  }
});

test("M-5: a core client pulls codecheck in without a restart", async () => {
  await session({ SN_TOOL_PACKAGES: "core" }, async ({ call, names, seen }) => {
    const before = await names();
    for (const tool of CODECHECK_TOOLS) assert.ok(!before.includes(tool));

    const listed = await call("servicenow_list_packages");
    const row = listed.structuredContent.packages.find(
      (p) => p.name === "codecheck",
    );
    assert.deepEqual(row, {
      name: "codecheck",
      enabled: false,
      configured: false,
      denied: false,
      readOnly: false,
      tools: CODECHECK_TOOLS.length,
    });

    const result = await call("servicenow_enable_package", {
      name: "codecheck",
    });
    assert.equal(result.isError, undefined, text(result));
    assert.equal(result.structuredContent.changed, true);
    assert.deepEqual(result.structuredContent.tools, CODECHECK_TOOLS);
    // Debounced: one notification for the whole package.
    assert.equal(seen.tools, 1);

    const after = await names();
    for (const tool of CODECHECK_TOOLS) assert.ok(after.includes(tool), tool);
    assert.equal(after.length, before.length + CODECHECK_TOOLS.length);

    // Idempotent: a second enable changes nothing and notifies nothing.
    const again = await call("servicenow_enable_package", {
      name: " CodeCheck ",
    });
    assert.equal(again.structuredContent.changed, false);
    assert.equal(seen.tools, 1);
  });
});

test("M-5: a denied package cannot be pulled in", async () => {
  await session(
    { SN_TOOL_PACKAGES: "core", SN_PACKAGES_DENY: "codecheck" },
    async ({ call, names, seen }) => {
      const result = await call("servicenow_enable_package", {
        name: "codecheck",
      });
      assert.equal(result.isError, true);
      assert.match(text(result), /PACKAGE_DENIED/);
      assert.equal(seen.tools, 0);
      const listed = await names();
      for (const tool of CODECHECK_TOOLS) assert.ok(!listed.includes(tool));
      // Never registered at all: the SDK does not know the tool.
      const direct = await call(CODECHECK_TOOLS[0], {});
      assert.equal(direct.isError, true);
      assert.match(text(direct), /not found/);
      const row = (
        await call("servicenow_list_packages")
      ).structuredContent.packages.find((p) => p.name === "codecheck");
      assert.equal(row.denied, true);
      assert.equal(row.tools, 0);
    },
  );
});

test("M-5: a package denied after startup is refused too", async () => {
  await session({ SN_TOOL_PACKAGES: "core" }, async ({ call }) => {
    process.env.SN_PACKAGES_DENY = "codecheck";
    const result = await call("servicenow_enable_package", {
      name: "codecheck",
    });
    assert.match(text(result), /PACKAGE_DENIED/);
  });
});

test("M-5: a read-only package stays read-only when enabled", async () => {
  await session(
    { SN_TOOL_PACKAGES: "schema", SN_PACKAGES_READONLY: "table" },
    async ({ call, names }) => {
      const result = await call("servicenow_enable_package", {
        name: "table",
      });
      assert.equal(result.structuredContent.readOnly, true);
      const listed = await names();
      for (const spec of ALL_TOOLS.filter((t) => t.package === "table")) {
        assert.equal(
          listed.includes(spec.name),
          spec.annotations.readOnlyHint === true,
          spec.name,
        );
      }
    },
  );
});

test("M-5: disable withdraws tools, resources and prompts; enable restores them", async () => {
  await session(
    { SN_TOOL_PACKAGES: "core" },
    async ({ client, call, names, seen }) => {
      const templates = async () =>
        (await client.listResourceTemplates()).resourceTemplates.map(
          (t) => t.uriTemplate,
        );
      const resources = async () =>
        (await client.listResources()).resources.map((r) => r.uri);
      const prompts = async () =>
        (await client.listPrompts()).prompts.map((p) => p.name).sort();

      const tplBefore = await templates();
      const resBefore = await resources();
      assert.ok(resBefore.includes("servicenow://reference/encoded-query"));
      assert.ok(tplBefore.length > 0);
      assert.ok((await prompts()).includes("servicenow_incident_triage"));

      await call("servicenow_disable_package", { name: "table" });
      await call("servicenow_disable_package", { name: "schema" });
      assert.ok(!(await names()).includes("servicenow_query_table"));
      assert.ok(
        !(await resources()).includes("servicenow://reference/encoded-query"),
      );
      assert.ok((await templates()).length < tplBefore.length);
      assert.ok(!(await prompts()).includes("servicenow_incident_triage"));
      assert.ok(seen.prompts >= 1);
      assert.ok(seen.resources >= 1);

      const disabled = await call("servicenow_query_table", {
        table: "incident",
      });
      assert.equal(disabled.isError, true);
      assert.match(text(disabled), /disabled/);

      await call("servicenow_enable_package", { name: "table" });
      await call("servicenow_enable_package", { name: "schema" });
      assert.ok((await names()).includes("servicenow_query_table"));
      assert.deepEqual((await resources()).sort(), [...resBefore].sort());
      assert.deepEqual((await templates()).sort(), [...tplBefore].sort());
      assert.ok((await prompts()).includes("servicenow_incident_triage"));
    },
  );
});

test("M-5: prompts follow their package requirement", async () => {
  await session(
    { SN_TOOL_PACKAGES: "core" },
    async ({ client, call, seen }) => {
      const prompts = async () =>
        (await client.listPrompts()).prompts.map((p) => p.name).sort();
      assert.deepEqual(await prompts(), [
        "servicenow_change_impact_analysis",
        "servicenow_incident_triage",
        "servicenow_instance_overview",
      ]);
      const result = await call("servicenow_enable_package", { name: "ops" });
      assert.deepEqual(result.structuredContent.prompts, [
        "servicenow_change_impact_analysis",
        "servicenow_incident_triage",
        "servicenow_instance_overview",
        "servicenow_why_is_it_slow",
      ]);
      assert.equal(seen.prompts, 1);
      assert.ok((await prompts()).includes("servicenow_why_is_it_slow"));
    },
  );
});

test("M-5: admin and unknown names are refused", async () => {
  await session({ SN_TOOL_PACKAGES: "core" }, async ({ call }) => {
    const admin = await call("servicenow_disable_package", { name: "admin" });
    assert.equal(JSON.parse(text(admin)).code, "PACKAGE_ALWAYS_ON");
    const unknown = await call("servicenow_enable_package", { name: "nope" });
    const body = JSON.parse(text(unknown));
    assert.equal(body.code, "UNKNOWN_PACKAGE");
    assert.equal(body.source, "server");
    assert.match(body.error, /^'nope' is not a package\. Known: .*codecheck/);
  });
});

test("M-5: status reports the live session set; dispose resets it", async () => {
  await session(
    { SN_TOOL_PACKAGES: "core" },
    async ({ call, names, runtime, server }) => {
      const configured = await names();
      await call("servicenow_enable_package", { name: "codecheck" });
      assert.ok(
        runWithRuntime(runtime, () =>
          buildStatusPayload().enabledPackages.includes("codecheck"),
        ),
      );
      assert.equal(packageSessionOf(server).modified(), true);

      await runtime.dispose();
      await flushAsync();
      assert.deepEqual(await names(), configured);
      assert.equal(packageSessionOf(server).modified(), false);
    },
  );
});

test("M-5: toggling without a session fails closed", async () => {
  const toggle = ALL_TOOLS.find((t) => t.name === "servicenow_enable_package");
  const list = ALL_TOOLS.find((t) => t.name === "servicenow_list_packages");
  await runWithRuntime(createRuntime(), async () => {
    for (const result of [
      await toggle.handler({ name: "codecheck" }),
      await list.handler({}),
    ]) {
      assert.equal(result.isError, true);
      assert.match(text(result), /NO_PACKAGE_SESSION/);
    }
  });
});

test("M-5: a profile change announces resources and updates status subscribers", async () => {
  await session(
    { SN_TOOL_PACKAGES: "core" },
    async ({ client, server, seen }) => {
      assert.equal(client.getServerCapabilities().resources.subscribe, true);
      await client.subscribeResource({ uri: "servicenow://status" });
      await notifyProfileChanged(server);
      await flushAsync();
      assert.equal(seen.resources, 1);
      assert.deepEqual(seen.updated, ["servicenow://status"]);

      await client.unsubscribeResource({ uri: "servicenow://status" });
      await notifyProfileChanged(server);
      await flushAsync();
      assert.equal(seen.resources, 2);
      assert.deepEqual(seen.updated, ["servicenow://status"]);
    },
  );
  // No server / not connected: a no-op.
  await notifyProfileChanged(null);
});

test("M-5: the overview prompt names only real tools", async () => {
  await session({ SN_TOOL_PACKAGES: "all" }, async ({ client }) => {
    const known = new Set(ALL_TOOLS.map((t) => t.name));
    for (const { name } of (await client.listPrompts()).prompts) {
      const prompt = await client.getPrompt({
        name,
        arguments:
          name === "servicenow_incident_triage"
            ? { incident: "INC0010001" }
            : name === "servicenow_change_impact_analysis"
              ? { change: "CHG0030001" }
              : name === "servicenow_document_table"
                ? { table: "incident" }
                : name === "servicenow_instance_overview"
                  ? { goal: "review incident rules" }
                  : {},
      });
      const body = prompt.messages.map((m) => m.content.text ?? "").join("\n");
      for (const [tool] of body.matchAll(/servicenow_[a-z_]+/g)) {
        if (tool === prompt.name) continue;
        assert.ok(known.has(tool), `${name} mentions unknown ${tool}`);
      }
    }
    const overview = await client.getPrompt({
      name: "servicenow_instance_overview",
      arguments: {},
    });
    const body = overview.messages[0].content.text;
    assert.match(body, /production/);
    assert.ok(
      body.indexOf("servicenow_check_capabilities") <
        body.indexOf("servicenow_get_status"),
    );
  });
});

test("M-5: requirementMet and a session without resources", () => {
  const on = new Set(["table"]);
  assert.equal(requirementMet({}, on), true);
  assert.equal(requirementMet({ all: ["table"] }, on), true);
  assert.equal(requirementMet({ all: ["table", "docs"] }, on), false);
  assert.equal(requirementMet({ any: ["change", "table"] }, on), true);
  assert.equal(requirementMet({ any: ["change"] }, on), false);

  const s = new PackageSession(
    new McpServer({ name: "x", version: "0" }),
    ["table", "schema"],
    new Set(["table"]),
    new Set(),
    new Set(),
  );
  assert.equal(s.disable("table").changed, true);
  assert.equal(s.disable("table").changed, false);
  s.reset();
  assert.deepEqual(s.enabledPackages(), ["table"]);
  assert.equal(s.modified(), false);
});
