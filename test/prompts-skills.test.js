// MC-3: every plugin skill has an MCP prompt twin, so a client without the
// plugin (VS Code, Claude Desktop, Cursor) gets the same workflow; and the
// safe-write prompt follows the live write mode.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerPrompts, writeModeGuidance } from "../build/mcp/prompts.js";
import { baselineEnv, freshRuntime, withEnv } from "./helpers.js";

baselineEnv();
test.beforeEach(() => freshRuntime());

const root = join(import.meta.dirname, "..");

/** Skill directory → the prompt that mirrors it. A new skill must add a row. */
const TWINS = {
  "sn-discover": "servicenow_discover_instance",
  "sn-drift": "servicenow_drift_review",
  "sn-impact": "servicenow_schema_impact",
  "sn-safe-write": "servicenow_safe_write",
  "sn-triage": "servicenow_incident_triage",
  "sn-uib": "servicenow_uib_page_review",
};

/** Arguments that make each mirrored prompt render its full step list. */
const ARGS = {
  servicenow_discover_instance: { depth: "artefacts" },
  servicenow_drift_review: { a: "dev" },
  servicenow_schema_impact: { kind: "field", name: "incident.priority" },
  servicenow_safe_write: { change: "set priority 2", table: "incident" },
  servicenow_incident_triage: { incident: "INC0010001" },
  servicenow_uib_page_review: { experience: "now/sow" },
};

function skills() {
  return readdirSync(join(root, "skills"))
    .filter((d) => existsSync(join(root, "skills", d, "SKILL.md")))
    .sort();
}

async function withPrompts(fn) {
  const server = new McpServer({ name: "t", version: "0.0.0" });
  registerPrompts(server);
  const client = new Client({ name: "c", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const promptText = (p) =>
  p.messages.map((m) => m.content.text ?? "").join("\n");

test("every skill has a prompt twin and every twin is registered", async () => {
  assert.deepEqual(skills(), Object.keys(TWINS).sort());
  await withPrompts(async (client) => {
    const names = new Set(
      (await client.listPrompts()).prompts.map((p) => p.name),
    );
    for (const [skill, prompt] of Object.entries(TWINS)) {
      assert.ok(names.has(prompt), `${skill}: ${prompt} is not registered`);
    }
  });
});

test("the MC-3 prompts name every tool their skill names", async () => {
  const mc3 = ["sn-discover", "sn-drift", "sn-impact", "sn-safe-write"];
  await withPrompts(async (client) => {
    for (const skill of mc3) {
      const name = TWINS[skill];
      const body = promptText(
        await client.getPrompt({ name, arguments: ARGS[name] }),
      );
      const md = readFileSync(join(root, "skills", skill, "SKILL.md"), "utf8");
      for (const [tool] of md.matchAll(/\bservicenow_[a-z0-9_]+\b/g)) {
        // Credentials are never part of a workflow prompt.
        if (tool === "servicenow_set_credentials") continue;
        assert.ok(
          body.includes(tool),
          `${name} misses ${tool} (from ${skill})`,
        );
      }
    }
  });
});

test("safe_write follows the write mode: apply asks before every write", async () => {
  await withEnv({ SN_WRITE_MODE: undefined, SN_ENV: undefined }, () => {
    const plan = writeModeGuidance();
    assert.match(plan, /Write mode is plan/);
    assert.match(plan, /apply:true only after the user approves/);
    assert.doesNotMatch(plan, /PRODUCTION/);
  });
  await withEnv({ SN_WRITE_MODE: "apply", SN_ENV: undefined }, () => {
    const apply = writeModeGuidance();
    assert.match(apply, /APPLY \(SN_WRITE_MODE=apply\)/);
    assert.match(apply, /no preview/);
    assert.match(apply, /Before EVERY write call/);
  });
  // A prod profile stays in plan mode without the acknowledgement, and says so.
  await withEnv({ SN_WRITE_MODE: "apply", SN_ENV: "prod" }, () => {
    const prod = writeModeGuidance();
    assert.match(prod, /Write mode is plan \(.*marked prod/);
    assert.match(prod, /PRODUCTION/);
  });
  await withEnv({ SN_READONLY: "true" }, () =>
    assert.match(writeModeGuidance(), /Writes are disabled/),
  );
  await withEnv({ SN_WRITE_MODE: "apply" }, () =>
    withPrompts(async (client) => {
      const body = promptText(
        await client.getPrompt({
          name: "servicenow_safe_write",
          arguments: ARGS.servicenow_safe_write,
        }),
      );
      assert.match(body, /Before EVERY write call/);
      assert.ok(
        body.indexOf("APPLY") < body.indexOf("1. servicenow_get_status"),
      );
    }),
  );
});

test("choice-like prompt arguments are normalised strings", async () => {
  await withPrompts(async (client) => {
    const impact = promptText(
      await client.getPrompt({
        name: "servicenow_schema_impact",
        arguments: { kind: "Field", name: "incident.priority" },
      }),
    );
    assert.match(impact, /with kind field and name/);
    const unknown = promptText(
      await client.getPrompt({
        name: "servicenow_discover_instance",
        arguments: { depth: "everything" },
      }),
    );
    assert.match(unknown, /at depth overview\./);
    const { completion } = await client.complete({
      ref: { type: "ref/prompt", name: "servicenow_discover_instance" },
      argument: { name: "depth", value: "a" },
    });
    assert.deepEqual(completion.values, ["apps", "artefacts"]);
  });
});
