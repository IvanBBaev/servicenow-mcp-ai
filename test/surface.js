// N-57: the one place that measures the published `tools/list` surface. The
// budget tests, the size-cap test and `npm run tokens:report` all read the wire
// through this module, so they agree on what a byte is: the length of
// JSON.stringify of the tools array an MCP client receives.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerAllTools } from "../build/mcp/registry.js";
import { currentRuntime } from "../build/core/runtime.js";
import { shallowOutputSchema } from "../build/mcp/lean-list.js";
import { withEnv } from "./helpers.js";

/**
 * The measured profiles and the env each one pins. Tasks and legacy names are
 * off unless the profile turns them on, so a developer's shell cannot skew a
 * measurement. `discovery` joins with N-63.
 */
export const PROFILES = {
  core: {},
  all: { SN_TOOL_PACKAGES: "all" },
  "all+tasks": { SN_TOOL_PACKAGES: "all", SN_EXPERIMENTAL_TASKS: "1" },
  "all+legacy": { SN_TOOL_PACKAGES: "all", SN_LEGACY_TOOL_NAMES: "1" },
};

const PINNED = {
  SN_TOOL_PACKAGES: undefined,
  SN_EXPERIMENTAL_TASKS: undefined,
  SN_LEGACY_TOOL_NAMES: undefined,
};

/** Fixed bytes-per-token ratios for reports (TK-37); never used by a gate. */
export const BYTES_PER_TOKEN = { schema: 4.0, records: 3.1 };

const size = (value) =>
  value === undefined ? 0 : JSON.stringify(value).length;

/** Bytes of every `description` under the input schema's properties. */
function paramDescriptionBytes(schema) {
  let bytes = 0;
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    for (const [k, v] of Object.entries(node)) {
      if (k === "description" && typeof v === "string") bytes += size(v);
      else walk(v);
    }
  };
  walk(schema?.properties);
  return bytes;
}

/**
 * Per-tool component sizes of one published tool. The outputSchema is
 * measured in its wire form (N-60, shallow), so a manifest built from the full
 * schemas records what a client receives; on a wire tool it is a no-op.
 */
export function toolSizes(input) {
  const tool = input.outputSchema
    ? { ...input, outputSchema: shallowOutputSchema(input.outputSchema) }
    : input;
  return {
    name: tool.name,
    total: size(tool),
    description: size(tool.description),
    title: size(tool.title),
    annotations: size(tool.annotations) + size(tool.execution),
    inputSchema: size(tool.inputSchema),
    paramDescriptions: paramDescriptionBytes(tool.inputSchema),
    outputSchema: size(tool.outputSchema),
  };
}

/**
 * The tools array a client receives under `env`. `raw: true` skips the N-58
 * lean serializer, for tests and reports that compare against the SDK's list.
 */
export async function listPublishedTools(env = {}, { raw = false } = {}) {
  return withEnv({ ...PINNED, ...env }, async () => {
    const server = new McpServer({ name: "surface", version: "0.0.0" });
    registerAllTools(server, currentRuntime(), { leanList: !raw });
    const client = new Client({ name: "surface-client", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      return (await client.listTools()).tools;
    } finally {
      await client.close();
      await server.close();
    }
  });
}

/**
 * Measure one profile (a key of PROFILES): total bytes, the tool count and
 * the per-tool breakdown, heaviest first.
 */
export async function measureSurface(profile) {
  const env = PROFILES[profile];
  if (!env) throw new Error(`Unknown surface profile "${profile}".`);
  const tools = await listPublishedTools(env);
  return {
    profile,
    bytes: size(tools),
    tools: tools.length,
    perTool: tools.map(toolSizes).sort((x, y) => y.total - x.total),
  };
}

/** A budget: the measured size rounded up to 256 B. */
export const roundBudget = (bytes) => Math.ceil(bytes / 256) * 256;
