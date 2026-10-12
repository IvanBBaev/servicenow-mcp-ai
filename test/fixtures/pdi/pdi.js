// E-6 / O-2: the PDI fixture corpus.
//
// One list of read-only scenarios drives three consumers:
//   - scripts/record-pdi-fixtures.mjs runs them against a live instance,
//     records every HTTP exchange and the tool result, redacts both and writes
//     one JSON file per scenario next to this module;
//   - test/pdi-replay.test.js replays the recorded exchanges through the real
//     tool layer offline and compares the result with the recorded one;
//   - test/live/live-smoke.test.js (SN_LIVE=1) runs them against the instance
//     again and checks the result keeps the recorded shape.
//
// Scenarios stay on metadata and counts (dictionary, table definitions,
// choices, an aggregate): no record data leaves the instance.

import { McpServer } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerAllTools } from "../../../build/mcp/registry.js";
import {
  createRuntime,
  currentRuntime,
  installRuntime,
} from "../../../build/core/runtime.js";
import { reloadCredentialsFromEnv } from "../../../build/core/config.js";

export const FIXTURE_DIR = import.meta.dirname;

/** The host every recorded URL and string is rewritten to. */
export const FIXTURE_HOST = "pdi.example.service-now.com";

/** The configuration a replay runs under (no secrets, no retries). */
export const REPLAY_ENV = {
  SN_INSTANCE: FIXTURE_HOST,
  SN_USER: "user1@example.com",
  SN_PASSWORD: "fixture",
  SN_MAX_RETRIES: "0",
  SN_AUTH: undefined,
  SN_OAUTH_CLIENT_ID: undefined,
  SN_OAUTH_CLIENT_SECRET: undefined,
  SN_TABLES_ALLOW: undefined,
  SN_TABLES_DENY: undefined,
  SN_READONLY: undefined,
  SN_ACTIVE_PROFILE: undefined,
  SN_TOOL_PACKAGES: undefined,
};

/** Apply `REPLAY_ENV` and return a function that restores the previous env. */
export function enterReplayEnv() {
  const saved = Object.fromEntries(
    Object.keys(REPLAY_ENV).map((k) => [k, process.env[k]]),
  );
  const apply = (values) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    reloadCredentialsFromEnv();
  };
  apply(REPLAY_ENV);
  return () => apply(saved);
}

/** Install a brand-new runtime (empty caches) so every scenario starts cold. */
export async function freshRuntime() {
  const previous = installRuntime(createRuntime());
  if (previous) await previous.dispose();
}

/**
 * Run one recorded fixture through the real tool layer, answering every HTTP
 * request from its exchanges. Call under `enterReplayEnv()`.
 */
export async function replayScenario(fixture) {
  await freshRuntime();
  const replay = replayFetch(fixture.exchanges);
  const realFetch = globalThis.fetch;
  globalThis.fetch = replay.fetch;
  const { client, close } = await startServer();
  try {
    const result = await callScenario(client, fixture.tool, fixture.args);
    return { result: normalize(result), unmatched: replay.unmatched };
  } finally {
    await close();
    globalThis.fetch = realFetch;
  }
}

/**
 * `args` may be a function of the results recorded so far (by scenario id),
 * for calls that need an instance-specific sys_id.
 */
export const SCENARIOS = [
  { id: "test-connection", tool: "servicenow_test_connection", args: {} },
  {
    id: "list-tables-incident",
    tool: "servicenow_list_tables",
    args: { filter: "incident" },
  },
  {
    id: "describe-table-incident",
    tool: "servicenow_describe_table",
    args: { table: "incident" },
  },
  {
    id: "query-sys-db-object",
    tool: "servicenow_query_table",
    args: {
      table: "sys_db_object",
      query: "nameINtask,incident,problem,change_request^ORDERBYname",
      fields: ["name", "label", "super_class", "sys_id"],
      limit: 4,
    },
  },
  {
    id: "get-record-sys-db-object",
    tool: "servicenow_get_record",
    args: (results) => ({
      table: "sys_db_object",
      sys_id: firstRecord(results["query-sys-db-object"]).sys_id,
      fields: ["name", "label", "super_class", "is_extendable"],
    }),
  },
  {
    id: "query-sys-choice-priority",
    tool: "servicenow_query_table",
    args: {
      table: "sys_choice",
      query:
        "name=incident^element=priority^language=en^inactive=false^ORDERBYsequence",
      fields: ["label", "value", "sequence"],
      limit: 10,
    },
  },
  {
    id: "aggregate-incident-priority",
    tool: "servicenow_aggregate",
    args: { table: "incident", count: true, group_by: ["priority"] },
  },
];

/** The first record of a recorded query_table result. */
function firstRecord(result) {
  const records = result?.structuredContent?.records ?? result?.data?.records;
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("scenario dependency returned no records");
  }
  return records[0];
}

/** Boot the real tool registry behind an in-memory MCP client. */
export async function startServer() {
  const server = new McpServer({ name: "servicenow-pdi", version: "0.0.0" });
  registerAllTools(server, currentRuntime());
  const client = new Client({ name: "pdi-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Call a tool and keep the parts a fixture compares. */
export async function callScenario(client, tool, args) {
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.find((c) => c.type === "text")?.text;
  let data;
  try {
    data = text === undefined ? undefined : JSON.parse(text);
  } catch {
    data = text;
  }
  return {
    isError: res.isError === true,
    ...(res.structuredContent
      ? { structuredContent: res.structuredContent }
      : {}),
    ...(data !== undefined ? { data } : {}),
  };
}

/** Resolve a scenario's arguments against the results recorded so far. */
export function scenarioArgs(scenario, results) {
  return typeof scenario.args === "function"
    ? scenario.args(results)
    : scenario.args;
}

// ---------------------------------------------------------------------------
// Volatile values: timings and clocks differ on every run.

const VOLATILE_KEYS = new Set([
  "latencyMs",
  "durationMs",
  "elapsedMs",
  "tookMs",
  "fetchedAt",
  "checkedAt",
  "generatedAt",
  "cachedAt",
]);

/** Drop run-dependent keys so two runs over the same data compare equal. */
export function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !VOLATILE_KEYS.has(k))
        .map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
}

/** The structure of a value: object keys and value types, arrays by first item. */
export function shapeOf(value) {
  if (Array.isArray(value)) {
    return value.length ? [shapeOf(value[0])] : [];
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, shapeOf(value[k])]),
    );
  }
  return value === null ? "null" : typeof value;
}

// ---------------------------------------------------------------------------
// Redaction.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Keys whose value names a person; replaced by a stable pseudonym. */
const PERSON_KEYS = new Set([
  "sys_created_by",
  "sys_updated_by",
  "user",
  "user_name",
  "userName",
  "caller",
  "opened_by",
  "assigned_to",
  "email",
]);

/**
 * A redactor for one recording run. It rewrites the instance host and name,
 * every e-mail address and every person-valued key to stable placeholders,
 * so the same identity maps to the same placeholder across the corpus.
 */
export function createRedactor({ host }) {
  const instanceName = host.split(".")[0];
  const people = new Map();
  const emails = new Map();
  const person = (name) => {
    if (!people.has(name)) people.set(name, `user${people.size + 1}`);
    return people.get(name);
  };
  const email = (address) => {
    if (address.toLowerCase().endsWith("@example.com")) return address;
    if (!emails.has(address)) {
      emails.set(address, `user${emails.size + 1}@example.com`);
    }
    return emails.get(address);
  };
  const text = (s) =>
    s
      .split(host)
      .join(FIXTURE_HOST)
      .split(instanceName)
      .join("pdi")
      .replace(EMAIL, email);
  const walk = (value, key) => {
    if (typeof value === "string") {
      if (PERSON_KEYS.has(key) && value && !value.includes("@")) {
        return person(value);
      }
      return text(value);
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, key));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, walk(v, k)]),
      );
    }
    return value;
  };
  return { redact: (value) => walk(value, undefined), text };
}

/**
 * Strings that must never appear in a committed fixture: the real host, its
 * instance name, the recording user and the user's e-mail domain label.
 */
export function forbiddenStrings({ host, user }) {
  const out = [host, host.split(".")[0]];
  if (user) {
    out.push(user);
    const domain = user.split("@")[1];
    if (domain) out.push(domain.split(".")[0]);
  }
  return out.filter((s) => s && s.length >= 4).map((s) => s.toLowerCase());
}

/** A customer- or vendor-owned name: a scoped-app (`x_<vendor>_`) or `u_` prefix. */
const CUSTOM_NAME = /^(x_[a-z0-9]+_|u_)[a-z0-9_]*$/;
const CUSTOM_NAME_ANYWHERE = /"(x_[a-z0-9]+_|u_)[a-z0-9_]*/g;

const mentionsCustom = (row) =>
  Object.values(row).some(
    (v) =>
      typeof v === "string" && v.split(/[.,]/).some((p) => CUSTOM_NAME.test(p)),
  );

/**
 * Drop every row of a recorded response that names a custom table or field,
 * so the corpus holds the platform's own metadata only. `x-total-count` is
 * lowered by the rows dropped from the top-level `result` array.
 */
export function dropCustomRows(exchange) {
  const walk = (value) => {
    if (Array.isArray(value)) {
      return value
        .filter(
          (v) =>
            !(
              v &&
              typeof v === "object" &&
              !Array.isArray(v) &&
              mentionsCustom(v)
            ),
        )
        .map(walk);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, walk(v)]),
      );
    }
    return value;
  };
  const body = walk(exchange.body);
  const headers = { ...exchange.headers };
  const before = exchange.body?.result;
  const after = body?.result;
  if (
    Array.isArray(before) &&
    Array.isArray(after) &&
    headers["x-total-count"]
  ) {
    const total =
      Number(headers["x-total-count"]) - (before.length - after.length);
    headers["x-total-count"] = String(total);
  }
  return { ...exchange, headers, body };
}

/** Custom table or field names left in a serialised fixture. */
export function customNames(serialised) {
  return [...new Set(serialised.match(CUSTOM_NAME_ANYWHERE) ?? [])];
}

/** E-mail addresses outside example.com left in a serialised fixture. */
export function strayEmails(serialised) {
  return (serialised.match(EMAIL) ?? []).filter(
    (a) => !a.toLowerCase().endsWith("@example.com"),
  );
}

// ---------------------------------------------------------------------------
// HTTP exchanges.

const KEPT_HEADERS = ["content-type", "x-total-count", "link"];

/** Record a request and its response as a plain object (body cloned). */
export async function captureExchange(url, init, response) {
  const u = new URL(String(url));
  const headers = {};
  for (const h of KEPT_HEADERS) {
    const v = response.headers.get(h);
    if (v !== null) headers[h] = v;
  }
  const raw = await response.clone().text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }
  return {
    method: String(init?.method ?? "GET").toUpperCase(),
    path: u.pathname,
    search: u.search,
    status: response.status,
    headers,
    body,
  };
}

/**
 * A fetch that answers from recorded exchanges by method + path + query, in
 * recording order per key (the last answer repeats). Requests with no
 * recording are collected in `unmatched` and answered 501.
 */
export function replayFetch(exchanges) {
  const byKey = new Map();
  for (const ex of exchanges) {
    const key = `${ex.method} ${ex.path}${ex.search}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(ex);
  }
  const hits = new Map();
  const unmatched = [];
  const fetchImpl = async (input, init = {}) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    const method = String(init.method ?? "GET").toUpperCase();
    const key = `${method} ${u.pathname}${u.search}`;
    const list = byKey.get(key);
    if (!list) {
      unmatched.push(key);
      return new Response(
        JSON.stringify({ error: { message: `no recording for ${key}` } }),
        { status: 501, headers: { "content-type": "application/json" } },
      );
    }
    const n = hits.get(key) ?? 0;
    hits.set(key, n + 1);
    const ex = list[Math.min(n, list.length - 1)];
    const payload =
      typeof ex.body === "string" ? ex.body : JSON.stringify(ex.body);
    return new Response(ex.status === 204 ? null : payload, {
      status: ex.status,
      headers: ex.headers,
    });
  };
  return { fetch: fetchImpl, unmatched };
}
