#!/usr/bin/env node
/**
 * N-49 — record the `claude plugin eval` MCP mocks from the real server.
 *
 * `claude plugin eval` never starts the plugin's MCP server (the plugin's
 * `mcpServers` entry is the published `npx servicenow-mcp-ai`): it answers
 * every `servicenow` tool from `evals/mocks/servicenow/<tool>.md`. This
 * launcher keeps those answers honest — it boots the server from `build/`
 * in-process, wires it to the fake instance (fake-instance.js, behind the
 * shared fetch double), runs one call per tool the skills use and writes
 * the server's own text answer as the mock body. `_tools.json` holds the
 * matching `tools/list` entries, so the eval model sees the real tool
 * descriptions and input schemas.
 *
 * Isolation: every inherited `SN_*` variable is dropped before the server
 * reads its config, the profiles point at `.invalid` hosts, `SN_DOCS_DIR`
 * and `SN_ENV_FILE` live in a temp directory, and the fake refuses (and
 * reports) any request to another host. Nothing here is reachable from the
 * published package (`files` ships `build/` and `bin/` only).
 *
 * Usage (after `npm run build`):
 *   node test/evals/record-mocks.js          rewrite evals/mocks/servicenow/
 *   node test/evals/record-mocks.js --check  exit 1 when a mock is stale
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  registerAllTools,
  registerResources,
} from "../../build/mcp/registry.js";
import { currentRuntime } from "../../build/core/runtime.js";
import { reloadCredentialsFromEnv } from "../../build/core/config.js";
import { freshRuntime, realFetch } from "../helpers.js";
import {
  DEV_HOST,
  PROD_HOST,
  INCIDENT_SYS_ID,
  UPDATE_SET_SYS_ID,
  BUSINESS_RULE_SYS_ID,
  SCRIPT_INCLUDE_SYS_ID,
  UX_EXPERIENCE_PATH,
  UX_PAGE_SYS_ID,
  installFakeInstance,
} from "./fake-instance.js";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "../..");
/** The plugin's MCP server name (`.claude-plugin/plugin.json` → mcpServers). */
export const SERVER_NAME = "servicenow";
export const MOCK_DIR = join(ROOT, "evals", "mocks", SERVER_NAME);

/** Stand-ins for run-specific values, so a re-recording is byte-stable. */
const DIR_PLACEHOLDER = "/home/eval";
const FIXED_TIME = "2026-10-01T09:30:00.000Z";
const PLAN_TOKEN = "pt-recorded-plan-token";
/** The server and Node versions change with a release or a runner image. */
const SERVER_VERSION_PLACEHOLDER = "0.0.0-eval";
const NODE_VERSION_PLACEHOLDER = "22.0.0-eval";
const NODE_MAJOR_PLACEHOLDER = "22";

/**
 * One call per tool the skills name, in the order a session would make
 * them (the journal entry `revert_write` reads is created by the applied
 * update earlier in the list). The recorded answer is what the eval model
 * gets for *any* call to that tool, so each call uses the arguments the
 * matching eval prompt leads to.
 */
export const RECORDED_CALLS = [
  ["servicenow_list_instances", {}],
  ["servicenow_test_connection", {}],
  ["servicenow_get_status", {}],
  ["servicenow_check_capabilities", {}],
  ["servicenow_use_instance", { name: "default" }],
  ["servicenow_document_instance", { depth: "overview" }],
  ["servicenow_read_doc", { path: "default/discovery/overview.md" }],
  ["servicenow_search_docs", { text: "vendor" }],
  ["servicenow_document_app", { scope: "x_acme_vendor" }],
  ["servicenow_document_table", { table: "incident" }],
  ["servicenow_compare_instances", { a: "default", b: "prod" }],
  ["servicenow_snapshot_instance", { sections: ["tables"] }],
  ["servicenow_list_update_sets", { state: "in progress" }],
  ["servicenow_get_update_set", { update_set: UPDATE_SET_SYS_ID }],
  [
    "servicenow_compare_update_set",
    { update_set: UPDATE_SET_SYS_ID, with_profile: "prod" },
  ],
  [
    "servicenow_get_artifact",
    { artifactType: "business_rule", sys_id: BUSINESS_RULE_SYS_ID },
  ],
  [
    "servicenow_explain_artifact",
    { artifactType: "business_rule", sys_id: BUSINESS_RULE_SYS_ID },
  ],
  ["servicenow_explain_ui_experience", { path: UX_EXPERIENCE_PATH }],
  [
    "servicenow_get_artifact_dependencies",
    { artifactType: "uib_macroponent", sys_id: UX_PAGE_SYS_ID },
  ],
  ["servicenow_check_code_health", { domains: true }],
  ["servicenow_describe_table", { table: "incident" }],
  ["servicenow_describe_table_logic", { table: "incident" }],
  ["servicenow_where_used", { kind: "field", name: "incident.priority" }],
  ["servicenow_search_code", { text: "EscalationUtil" }],
  ["servicenow_trace_table_event", { table: "incident", operation: "update" }],
  ["servicenow_generate_er_diagram", { tables: ["incident"] }],
  ["servicenow_read_ops", { kind: "syslog", level: "warning", minutes: 1440 }],
  [
    "servicenow_get_record_history",
    { table: "incident", sys_id: INCIDENT_SYS_ID },
  ],
  ["servicenow_get_flow_runs", { record: INCIDENT_SYS_ID }],
  [
    "servicenow_get_script",
    { type: "script_include", sys_id: SCRIPT_INCLUDE_SYS_ID },
  ],
  [
    "servicenow_lint_script",
    { type: "script_include", sys_id: SCRIPT_INCLUDE_SYS_ID },
  ],
  ["servicenow_get_record", { table: "incident", sys_id: INCIDENT_SYS_ID }],
  [
    "servicenow_query_table",
    {
      table: "incident",
      query: "number=INC0010001",
      fields: ["sys_id", "number", "short_description", "priority", "state"],
    },
  ],
  [
    "servicenow_update_record",
    { table: "incident", sys_id: INCIDENT_SYS_ID, values: { priority: "2" } },
  ],
  [
    "servicenow_create_record",
    {
      table: "incident",
      values: { short_description: "Printer offline on floor 3" },
    },
  ],
  [
    "servicenow_upsert_record",
    {
      table: "incident",
      key: { number: "INC0010001" },
      values: { priority: "2" },
    },
  ],
  ["servicenow_delete_record", { table: "incident", sys_id: INCIDENT_SYS_ID }],
  [
    "servicenow_batch",
    {
      requests: [
        {
          method: "PATCH",
          url: `/api/now/table/incident/${INCIDENT_SYS_ID}`,
          body: { priority: "2" },
        },
      ],
    },
  ],
  // Apply one update (not recorded) so the journal has an entry to list
  // and to plan a revert for.
  [
    "servicenow_update_record",
    {
      table: "incident",
      sys_id: INCIDENT_SYS_ID,
      values: { urgency: "1" },
      apply: true,
    },
    { record: false },
  ],
  ["servicenow_list_writes", { table: "incident" }],
  ["servicenow_revert_write", { entry_id: "$lastEntry" }],
  ["servicenow_set_credentials", { profile: "default", user: "eval.user" }],
];

/** Every tool the recorder answers for (the mock file names). */
export const MOCKED_TOOLS = [
  ...new Set(
    RECORDED_CALLS.filter(([, , o]) => o?.record !== false).map(([n]) => n),
  ),
].sort();

/** The env the server runs under while recording. */
export function recorderEnv(dir) {
  return {
    SN_INSTANCE: DEV_HOST,
    SN_USER: "eval.user",
    SN_PASSWORD: "not-a-real-password",
    SN_PROFILE_PROD_INSTANCE: PROD_HOST,
    SN_PROFILE_PROD_USER: "eval.user",
    SN_PROFILE_PROD_PASSWORD: "not-a-real-password",
    SN_ALLOWED_HOSTS: `${DEV_HOST},${PROD_HOST}`,
    SN_MAX_RETRIES: "0",
    SN_LOG_LEVEL: "warn",
    SN_TOOL_PACKAGES: "all",
    SN_DOCS_DIR: join(dir, "docs"),
    SN_ENV_FILE: join(dir, ".env"),
  };
}

/** Run `fn` with every `SN_*` variable replaced by `env`, then restore. */
async function withIsolatedEnv(env, fn) {
  const saved = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith("SN_")),
  );
  for (const key of Object.keys(saved)) delete process.env[key];
  Object.assign(process.env, env);
  reloadCredentialsFromEnv();
  freshRuntime();
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("SN_")) delete process.env[key];
    }
    Object.assign(process.env, saved);
    reloadCredentialsFromEnv();
    freshRuntime();
  }
}

/**
 * Replace run-specific values (the temp dir, process id, timings, uptime,
 * byte counters, wall-clock timestamps, plan tokens, journal ids, server and
 * Node versions, user agent) with stable stand-ins.
 * `ids` maps each journal id seen so far to its stand-in, so one entry keeps
 * one id across answers.
 */
export function normalize(text, dir, ids = new Map()) {
  let out = text;
  // macOS hands out /var/... temp dirs that resolve to /private/var/...
  const paths = existsSync(dir) ? [realpathSync(dir), dir] : [dir];
  for (const path of new Set(paths)) {
    out = out.split(path).join(DIR_PLACEHOLDER);
  }
  out = out.replace(/"pid":\s*\d+/g, '"pid":0');
  // Timings, the process uptime, and the per-tool byte counters (they sum
  // earlier answers, so one changed answer would ripple into get_status).
  out = out.replace(
    /"(latencyMs|ms|durationMs|elapsedMs|totalMs|p50|p95|took_ms|tookMs|uptimeSec|bytesTotal|textBytes|structuredBytes|bytesP50|bytesP95)":\s*\d+(\.\d+)?/g,
    '"$1":0',
  );
  // The server identity: its version, the Node version and the user agent
  // that carries both.
  out = out.replace(
    /("name":"servicenow-mcp-ai","version":)"[^"]*"/g,
    `$1"${SERVER_VERSION_PLACEHOLDER}"`,
  );
  out = out.replace(
    /"node":"\d+\.\d+\.\d+[^"]*"/g,
    `"node":"${NODE_VERSION_PLACEHOLDER}"`,
  );
  out = out.replace(
    /servicenow-mcp-ai\/[0-9A-Za-z.+-]+ \(node\/\d+;/g,
    `servicenow-mcp-ai/${SERVER_VERSION_PLACEHOLDER} (node/${NODE_MAJOR_PLACEHOLDER};`,
  );
  out = out.replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g,
    FIXED_TIME,
  );
  out = out.replace(/"plan_token":"[^"]+"/g, `"plan_token":"${PLAN_TOKEN}"`);
  // Journal ids are ULIDs: 26 Crockford base32 characters.
  out = out.replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, (id) => {
    if (!ids.has(id)) {
      ids.set(id, `01EVAL${String(ids.size + 1).padStart(20, "0")}`);
    }
    return ids.get(id);
  });
  return out;
}

/** The mock file for one recorded answer. */
export function renderMock(tool, text, { isError = false } = {}) {
  const front = [
    "---",
    "# Recorded by test/evals/record-mocks.js from the real server against",
    "# the fake instance (test/evals/fake-instance.js). Do not edit by hand:",
    "# run `npm run eval:mocks` after a tool's output changes.",
    "type: fixed",
    ...(isError ? ["error: true"] : []),
    "---",
  ];
  return `${front.join("\n")}\n\n${text}\n`;
}

/**
 * Boot the server against the fake instance and run `RECORDED_CALLS`.
 * Resolves to `{ answers, tools, requests, forbidden }`: `answers` maps a
 * tool name to `{ text, isError }` (normalized), `tools` is the
 * `tools/list` entry of each mocked tool, `requests` counts the fake's
 * requests and `forbidden` lists any that targeted another host.
 */
export async function recordMocks() {
  const dir = mkdtempSync(join(tmpdir(), "sn-eval-mocks-"));
  const fake = installFakeInstance();
  try {
    return await withIsolatedEnv(recorderEnv(dir), async () => {
      const server = new McpServer({
        name: "servicenow-mcp-eval",
        version: "0.0.0",
      });
      registerAllTools(server, currentRuntime());
      registerResources(server);
      const client = new Client({ name: "eval-recorder", version: "0.0.0" });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await Promise.all([
        server.connect(serverSide),
        client.connect(clientSide),
      ]);
      try {
        const answers = new Map();
        const ids = new Map();
        let lastEntry;
        for (const [name, rawArgs, opts] of RECORDED_CALLS) {
          const args = { ...rawArgs };
          if (args.entry_id === "$lastEntry") args.entry_id = lastEntry ?? "";
          const res = await client.callTool({ name, arguments: args });
          const text = res.content?.find((c) => c.type === "text")?.text ?? "";
          if (name === "servicenow_list_writes" && !res.isError) {
            lastEntry = JSON.parse(text).entries?.[0]?.id;
          }
          if (opts?.record === false) continue;
          answers.set(name, {
            text: normalize(text, dir, ids),
            isError: res.isError === true,
          });
        }
        const listed = (await client.listTools()).tools;
        const tools = MOCKED_TOOLS.map((n) => listed.find((t) => t.name === n));
        return {
          answers,
          tools,
          requests: fake.double.calls.length,
          forbidden: [...fake.forbidden],
        };
      } finally {
        await client.close();
        await server.close();
      }
    });
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The files `recordMocks` output maps to, keyed by path under MOCK_DIR. */
export function mockFiles({ answers, tools }) {
  const files = new Map();
  for (const [tool, answer] of answers) {
    files.set(`${tool}.md`, renderMock(tool, answer.text, answer));
  }
  files.set("_tools.json", `${JSON.stringify({ tools }, null, 2)}\n`);
  return files;
}

async function main(argv) {
  const check = argv.includes("--check");
  const recorded = await recordMocks();
  if (recorded.forbidden.length > 0) {
    throw new Error(`refused requests: ${recorded.forbidden.join(", ")}`);
  }
  const files = mockFiles(recorded);
  const stale = [];
  mkdirSync(MOCK_DIR, { recursive: true });
  for (const [name, content] of files) {
    const path = join(MOCK_DIR, name);
    let current;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = undefined;
    }
    if (current === content) continue;
    stale.push(name);
    if (!check) writeFileSync(path, content);
  }
  const extra = readdirSync(MOCK_DIR).filter(
    (f) => f.endsWith(".md") && !files.has(f),
  );
  for (const [tool, answer] of recorded.answers) {
    if (answer.isError) console.warn(`warning: ${tool} recorded an error`);
  }
  if (check) {
    if (stale.length > 0 || extra.length > 0) {
      console.error(
        `evals/mocks/${SERVER_NAME} is stale: ${[...stale, ...extra].join(", ")}` +
          "\nRun `npm run eval:mocks`.",
      );
      process.exitCode = 1;
      return;
    }
    console.log(`evals/mocks/${SERVER_NAME}: ${files.size} files up to date`);
    return;
  }
  if (extra.length > 0) {
    console.warn(`not recorded (remove if obsolete): ${extra.join(", ")}`);
  }
  console.log(
    `evals/mocks/${SERVER_NAME}: ${stale.length} of ${files.size} files written ` +
      `(${recorded.requests} fake-instance requests)`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
