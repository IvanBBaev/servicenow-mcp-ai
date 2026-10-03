// M-7 (B2 + B13) — tool naming convention v3: the alias map, the legacy flag
// (SN_LEGACY_TOOL_NAMES), parameter aliases, prompt tool references, the
// per-profile resource template, reserved profile names and the policy
// resource staying free of secrets.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  ALL_TOOLS,
  activeToolSpecs,
  effectivePackages,
  registerAllTools,
  registerResources,
} from "../build/mcp/registry.js";
import { registerPrompts } from "../build/mcp/prompts.js";
import { LIST_CHANGED_NOTIFICATIONS } from "../build/mcp/packages.js";
import {
  TOOLS,
  TOOL_OVERLAPS,
  TOOL_RENAMES,
  legacyToolNames,
  renamedTo,
} from "../build/mcp/naming.js";
import { buildInputSchema } from "../build/mcp/define.js";
import { normalizeChildValues } from "../build/tools/artifacts.js";
import {
  RESERVED_PROFILE_NAMES,
  assertValidProfileName,
  loadEnv,
} from "../build/core/config.js";
import { ERROR_CODES } from "../build/core/errors.js";
import { policyResourcePayload } from "../build/mcp/policy-view.js";
import { createRuntime } from "../build/core/runtime.js";
import { readFileSync } from "node:fs";
import {
  baselineEnv,
  withEnv,
  withFetch,
  jsonResponse,
  flushAsync,
} from "./helpers.js";

baselineEnv();

const SYS_ID = "0123456789abcdef0123456789abcdef";
const REAL_NAMES = new Set(ALL_TOOLS.map((t) => t.name));

/** A connected in-memory client over a server built like src/index.ts. */
async function session(env, fn) {
  return withEnv(
    {
      SN_PACKAGES_DENY: "",
      SN_PACKAGES_READONLY: "",
      SN_TOOL_PACKAGES: "all",
      ...env,
    },
    async () => {
      const runtime = createRuntime();
      const server = new McpServer(
        { name: "m7-test", version: "0.0.0" },
        {
          capabilities: { logging: {} },
          debouncedNotificationMethods: LIST_CHANGED_NOTIFICATIONS,
        },
      );
      registerAllTools(server, runtime);
      registerResources(server);
      registerPrompts(server, effectivePackages().enabled);
      const client = new Client({ name: "m7-client", version: "0.0.0" });
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
        return await fn({ client, call, names });
      } finally {
        await client.close();
        await server.close();
      }
    },
  );
}

const text = (result) => result.content.map((c) => c.text).join("\n");

// --- the alias map ---------------------------------------------------------------

test("TOOLS names exactly the registered tools", () => {
  assert.deepEqual(
    Object.values(TOOLS).sort(),
    [...REAL_NAMES].sort(),
    "naming.ts TOOLS and ALL_TOOLS drifted",
  );
  for (const [key, name] of Object.entries(TOOLS)) {
    assert.equal(name, `servicenow_${key}`);
  }
});

test("every old name maps to an existing new name, and no alias collides", () => {
  const from = TOOL_RENAMES.map((r) => r.from);
  assert.equal(new Set(from).size, from.length, "duplicate old name");
  for (const rename of TOOL_RENAMES) {
    assert.ok(
      REAL_NAMES.has(rename.to),
      `${rename.from} -> missing ${rename.to}`,
    );
    assert.ok(!REAL_NAMES.has(rename.from), `${rename.from} is a real tool`);
    assert.notEqual(rename.from, rename.to);
    assert.ok(rename.reason.length > 0, `${rename.from} needs a reason`);
    assert.equal(renamedTo(rename.from), rename.to);
  }
  assert.equal(renamedTo("servicenow_query_table"), undefined);
  // The eight renames the roadmap names, plus the documented extras.
  for (const [a, b] of [
    ["docs_list", "list_docs"],
    ["docs_read", "read_doc"],
    ["docs_search", "search_docs"],
    ["docs_write", "write_doc"],
    ["table_logic", "describe_table_logic"],
    ["knowledge_highlights", "get_knowledge_highlights"],
    ["code_health", "check_code_health"],
    ["change_conflicts", "check_change_conflicts"],
  ]) {
    assert.equal(renamedTo(`servicenow_${a}`), `servicenow_${b}`);
  }
});

test("every overlap reason names a real tool", () => {
  for (const [name, reason] of Object.entries(TOOL_OVERLAPS)) {
    assert.ok(REAL_NAMES.has(name), name);
    assert.ok(reason.length > 0);
  }
});

test("SN_LEGACY_TOOL_NAMES reads as a boolean, off by default", async () => {
  await withEnv({ SN_LEGACY_TOOL_NAMES: undefined }, () =>
    assert.equal(legacyToolNames(), false),
  );
  await withEnv({ SN_LEGACY_TOOL_NAMES: "1" }, () =>
    assert.equal(legacyToolNames(), true),
  );
});

// --- the legacy flag -----------------------------------------------------------

test("legacy off: old names are absent from tools/list and unknown", async () => {
  await session(
    { SN_LEGACY_TOOL_NAMES: undefined },
    async ({ names, call }) => {
      const listed = await names();
      assert.deepEqual(
        listed,
        activeToolSpecs()
          .map((t) => t.name)
          .sort(),
      );
      for (const rename of TOOL_RENAMES) {
        assert.ok(!listed.includes(rename.from), rename.from);
      }
      const result = await call("servicenow_docs_list");
      assert.equal(result.isError, true);
      assert.match(text(result), /not found|unknown/i);
    },
  );
});

test("legacy on: every old name is listed as a deprecated alias and dispatches", async () => {
  await session({ SN_LEGACY_TOOL_NAMES: "1" }, async ({ client, call }) => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const rename of TOOL_RENAMES) {
      const alias = byName.get(rename.from);
      const target = byName.get(rename.to);
      assert.ok(alias, `${rename.from} must be listed`);
      assert.ok(target, `${rename.to} must be listed`);
      assert.match(alias.title, /deprecated name/);
      assert.match(alias.description, new RegExp(`use ${rename.to}`));
      assert.deepEqual(
        Object.keys(alias.inputSchema.properties ?? {}).sort(),
        Object.keys(target.inputSchema.properties ?? {}).sort(),
        `${rename.from} must take ${rename.to}'s parameters`,
      );
    }
    // The alias runs the v3 tool: same (local, docs-store) result.
    const viaAlias = await call("servicenow_docs_list");
    const viaName = await call("servicenow_list_docs");
    assert.notEqual(viaAlias.isError, true, text(viaAlias));
    assert.deepEqual(viaAlias.structuredContent, viaName.structuredContent);
  });
});

test("legacy on: aliases follow their tool's package (disable / enable)", async () => {
  await session({ SN_LEGACY_TOOL_NAMES: "1" }, async ({ call, names }) => {
    assert.ok((await names()).includes("servicenow_code_health"));
    const off = await call("servicenow_disable_package", { name: "codecheck" });
    assert.notEqual(off.isError, true, text(off));
    const listed = await names();
    assert.ok(!listed.includes("servicenow_check_code_health"));
    assert.ok(!listed.includes("servicenow_code_health"));
    await call("servicenow_enable_package", { name: "codecheck" });
    assert.ok((await names()).includes("servicenow_code_health"));
  });
});

// --- parameter aliases ---------------------------------------------------------

const ATTACHMENT = {
  sys_id: SYS_ID,
  file_name: "a.txt",
  table_name: "incident",
};

test("legacy params are refused without the flag and accepted with it", async () => {
  const fetchAttachment = (url) => {
    assert.match(url, new RegExp(`/api/now/attachment/${SYS_ID}`));
    return jsonResponse(200, { result: ATTACHMENT });
  };
  await session({ SN_LEGACY_TOOL_NAMES: undefined }, async ({ call }) => {
    await withFetch(fetchAttachment, async (calls) => {
      const old = await call("servicenow_get_attachment", {
        attachment_sys_id: SYS_ID,
      });
      assert.equal(old.isError, true);
      assert.equal(calls.length, 0, "no request with a refused parameter");
      const ok = await call("servicenow_get_attachment", { sys_id: SYS_ID });
      assert.notEqual(ok.isError, true, text(ok));
    });
  });
  await session({ SN_LEGACY_TOOL_NAMES: "1" }, async ({ call }) => {
    await withFetch(fetchAttachment, async (calls) => {
      const old = await call("servicenow_get_attachment", {
        attachment_sys_id: SYS_ID,
      });
      assert.notEqual(old.isError, true, text(old));
      assert.equal(calls.length, 1);
      const both = await call("servicenow_get_attachment", {
        attachment_sys_id: SYS_ID,
        sys_id: SYS_ID,
      });
      assert.equal(both.isError, true);
      assert.equal(JSON.parse(text(both)).code, "INVALID_INPUT");
    });
  });
});

test("class_name is a deprecated alias of table on the CMDB tools (always)", async () => {
  const fetchCis = (url) => {
    assert.match(url, /cmdb_ci_server/);
    return jsonResponse(200, { result: [] });
  };
  await session({ SN_LEGACY_TOOL_NAMES: undefined }, async ({ call }) => {
    await withFetch(fetchCis, async () => {
      const viaAlias = await call("servicenow_list_cis", {
        class_name: "cmdb_ci_server",
      });
      assert.notEqual(viaAlias.isError, true, text(viaAlias));
      const viaTable = await call("servicenow_list_cis", {
        table: "cmdb_ci_server",
      });
      assert.notEqual(viaTable.isError, true, text(viaTable));
      const both = await call("servicenow_list_cis", {
        class_name: "cmdb_ci_server",
        table: "cmdb_ci_server",
      });
      assert.equal(both.isError, true);
      assert.equal(JSON.parse(text(both)).code, "INVALID_INPUT");
    });
  });
});

test("the published schema shows deprecated aliases but never legacy ones", async () => {
  await withEnv({ SN_LEGACY_TOOL_NAMES: undefined }, () => {
    for (const spec of ALL_TOOLS) {
      const props = buildInputSchema(spec, { legacy: false }).shape;
      for (const alias of Object.keys(spec.legacyParams ?? {})) {
        assert.ok(!(alias in props), `${spec.name}.${alias} is legacy-only`);
      }
      for (const [alias, target] of Object.entries(
        spec.deprecatedParams ?? {},
      )) {
        assert.ok(alias in props, `${spec.name}.${alias} must be published`);
        assert.match(props[alias].description ?? "", /Deprecated/);
        assert.ok(
          props[target].safeParse(undefined).success,
          "canonical becomes optional",
        );
        assert.ok(target in props);
      }
    }
  });
});

test("every legacy / deprecated alias targets a real parameter", () => {
  let count = 0;
  for (const spec of ALL_TOOLS) {
    for (const [alias, target] of Object.entries({
      ...spec.legacyParams,
      ...spec.deprecatedParams,
    })) {
      count += 1;
      assert.ok(target in spec.input, `${spec.name}: ${alias} -> ${target}`);
      assert.ok(!(alias in spec.input), `${spec.name}: ${alias} still real`);
    }
  }
  assert.ok(count >= 20, `expected the M-7 aliases, found ${count}`);
});

test("upsert_artifact children: fields is legacy-only, values is required", async () => {
  await withEnv({ SN_LEGACY_TOOL_NAMES: undefined }, () => {
    assert.deepEqual(normalizeChildValues([{ values: { a: "1" } }]), [
      { fields: { a: "1" } },
    ]);
    assert.throws(
      () => normalizeChildValues([{ fields: { a: "1" } }]),
      (e) => e.code === "INVALID_INPUT" && /renamed to values/.test(e.message),
    );
    assert.throws(
      () => normalizeChildValues([{}]),
      (e) => e.code === "INVALID_INPUT",
    );
  });
  await withEnv({ SN_LEGACY_TOOL_NAMES: "1" }, () => {
    assert.deepEqual(normalizeChildValues([{ fields: { a: "1" } }]), [
      { fields: { a: "1" } },
    ]);
    assert.throws(
      () => normalizeChildValues([{ fields: { a: "1" }, values: { a: "1" } }]),
      (e) => e.code === "INVALID_INPUT",
    );
  });
});

// --- prompts --------------------------------------------------------------------

test("prompts reference tools through TOOLS: every servicenow_* tool name exists", () => {
  const source = readFileSync(
    new URL("../src/mcp/prompts.ts", import.meta.url),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replaceAll("servicenow_*", "");
  // Tool names are interpolated from TOOLS, so no literal tool name remains
  // in prompt text (prompt names themselves are not tools).
  const promptNames = new Set(
    [...source.matchAll(/^\s+"(servicenow_\w+)",$/gm)].map((m) => m[1]),
  );
  for (const match of source.matchAll(/servicenow_(\w+)/g)) {
    const name = match[0];
    if (promptNames.has(name)) continue;
    assert.fail(
      `literal tool name ${name} in prompts.ts — use TOOLS.${match[1]}`,
    );
  }
  for (const match of source.matchAll(/TOOLS\.(\w+)/g)) {
    assert.ok(match[1] in TOOLS, `TOOLS.${match[1]}`);
  }
});

test("rendered prompts name only real tools", async () => {
  await session({}, async ({ client }) => {
    const { prompts } = await client.listPrompts();
    assert.ok(prompts.length > 0);
    const args = {
      incident: "INC0010001",
      change: "CHG0030001",
      table: "incident",
      symptom: "slow",
    };
    for (const prompt of prompts) {
      const wanted = Object.fromEntries(
        (prompt.arguments ?? [])
          .filter((a) => a.name in args)
          .map((a) => [a.name, args[a.name]]),
      );
      const rendered = await client.getPrompt({
        name: prompt.name,
        arguments: wanted,
      });
      const body = JSON.stringify(rendered.messages);
      for (const [name] of body.matchAll(/servicenow_[a-z_]+/g)) {
        if (name === "servicenow_") continue;
        assert.ok(REAL_NAMES.has(name), `${prompt.name} names ${name}`);
      }
    }
  });
});

// --- B13: the per-profile resource template and reserved profiles ---------------

const PROD = {
  SN_PROFILE_PROD_INSTANCE: "prod00000.service-now.com",
  SN_PROFILE_PROD_USER: "bob",
  SN_PROFILE_PROD_PASSWORD: "pr0d-pass",
};
const schemaFetch = (url) =>
  /sys_db_object/.test(url)
    ? jsonResponse(200, { result: [] })
    : jsonResponse(200, {
        result: [
          {
            element: "number",
            column_label: "Number",
            internal_type: { value: "string" },
            name: "incident",
          },
        ],
      });

test("both profile schema templates read the same schema; the old one is not listed", async () => {
  await session(PROD, async ({ client }) => {
    await withFetch(schemaFetch, async () => {
      const v3 = await client.readResource({
        uri: "servicenow://profiles/prod/schema/incident",
      });
      const v2 = await client.readResource({
        uri: "servicenow://prod/schema/incident",
      });
      const a = JSON.parse(v3.contents[0].text);
      const b = JSON.parse(v2.contents[0].text);
      assert.equal(a.profile, "prod");
      assert.deepEqual(
        { ...b, columns: b.columns.length },
        { ...a, columns: a.columns.length },
      );
    });
    const { resourceTemplates } = await client.listResourceTemplates();
    const templates = resourceTemplates.map((t) => t.uriTemplate);
    assert.ok(
      templates.includes("servicenow://profiles/{profile}/schema/{table}"),
    );
    const legacy = resourceTemplates.find(
      (t) => t.uriTemplate === "servicenow://{profile}/schema/{table}",
    );
    assert.ok(legacy, "the v2 template stays for one minor");
    assert.match(legacy.description, /Deprecated/);
    const { resources } = await client.listResources();
    for (const r of resources) {
      assert.doesNotMatch(r.uri, /^servicenow:\/\/prod\/schema\//);
    }
  });
});

test("reserved profile names are refused with RESERVED_PROFILE_NAME", async () => {
  assert.ok(ERROR_CODES.RESERVED_PROFILE_NAME);
  assert.deepEqual([...RESERVED_PROFILE_NAMES].sort(), [
    "capabilities",
    "docs",
    "policy",
    "profiles",
    "reference",
    "schema",
    "status",
  ]);
  for (const name of RESERVED_PROFILE_NAMES) {
    assert.throws(
      () => assertValidProfileName(name),
      (e) =>
        e.code === "RESERVED_PROFILE_NAME" &&
        typeof e.hint === "string" &&
        e.hint.includes(`SN_PROFILE_${name.toUpperCase()}_`),
    );
  }
  assert.doesNotThrow(() => assertValidProfileName("prod"));

  const dir = mkdtempSync(join(tmpdir(), "sn-m7-"));
  try {
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "SN_PROFILE_DOCS_INSTANCE=x.service-now.com\n");
    await withEnv(
      { SN_ENV_FILE: envFile, SN_PROFILE_DOCS_INSTANCE: undefined },
      () => {
        try {
          assert.throws(
            () => loadEnv(),
            (e) =>
              e.code === "RESERVED_PROFILE_NAME" && /"docs"/.test(e.message),
          );
        } finally {
          delete process.env.SN_PROFILE_DOCS_INSTANCE;
        }
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- servicenow://policy -------------------------------------------------------

test("servicenow://policy is read-only data with no secrets", async () => {
  const secrets = {
    SN_PASSWORD: "top-s3cret-pw",
    SN_OAUTH_CLIENT_ID: "client-id-xyz",
    SN_OAUTH_CLIENT_SECRET: "oauth-s3cret-xyz",
    SN_API_KEY: "api-key-s3cret",
    ...PROD,
  };
  await withEnv(secrets, async () => {
    const body = JSON.stringify(policyResourcePayload());
    for (const value of [
      "top-s3cret-pw",
      "oauth-s3cret-xyz",
      "api-key-s3cret",
      "pr0d-pass",
    ]) {
      assert.ok(!body.includes(value), `policy leaks ${value}`);
    }
    assert.doesNotMatch(body, /"(password|client_secret|api_key)":/i);
  });
  await session(secrets, async ({ client }) => {
    const res = await client.readResource({ uri: "servicenow://policy" });
    assert.doesNotMatch(
      res.contents[0].text,
      /top-s3cret-pw|oauth-s3cret|api-key-s3cret|pr0d-pass/,
    );
    const { resources } = await client.listResources();
    assert.ok(resources.some((r) => r.uri === "servicenow://policy"));
  });
});
