// N-65 (O-21 (c)) — the large readers carry
// `_meta["anthropic/maxResultSizeChars"]` in tools/list, tied to
// SN_MAX_RESULT_CHARS; SN_RESULT_SIZE_HINTS=0 drops them. A tool with an MCP
// Apps view keeps the hint next to its `ui` link.
import test from "node:test";
import assert from "node:assert/strict";

import {
  linkToolView,
  MCP_APPS_EXTENSION,
  MCP_APPS_MIME,
} from "../build/mcp/apps.js";
import {
  MAX_RESULT_SIZE_KEY,
  RESULT_HINT_TOOLS,
  resultHintMeta,
} from "../build/mcp/result-hints.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import { baselineEnv, withEnv } from "./helpers.js";
import { listPublishedTools, PROFILES } from "./surface.js";

baselineEnv();

const hinted = (tools) =>
  Object.fromEntries(
    tools.filter((t) => t._meta).map((t) => [t.name, t._meta]),
  );

test("N-65: every hinted tool exists", () => {
  const names = new Set(ALL_TOOLS.map((s) => s.name));
  for (const name of RESULT_HINT_TOOLS) assert.ok(names.has(name), name);
});

test("N-65: the large readers carry the hint at SN_MAX_RESULT_CHARS by default", async () => {
  const tools = await listPublishedTools(PROFILES.all);
  assert.deepEqual(
    hinted(tools),
    Object.fromEntries(
      [...RESULT_HINT_TOOLS].map((n) => [n, { [MAX_RESULT_SIZE_KEY]: 48_000 }]),
    ),
  );
  const custom = await listPublishedTools({
    ...PROFILES.all,
    SN_MAX_RESULT_CHARS: "60000",
  });
  assert.equal(
    custom.find((t) => t.name === "servicenow_get_script")._meta[
      MAX_RESULT_SIZE_KEY
    ],
    60_000,
  );
});

test("N-65: SN_RESULT_SIZE_HINTS=0 drops every hint", async () => {
  for (const value of ["0", "false", "off"]) {
    const tools = await listPublishedTools({
      ...PROFILES.all,
      SN_RESULT_SIZE_HINTS: value,
    });
    assert.deepEqual(hinted(tools), {}, value);
  }
  await withEnv({ SN_RESULT_SIZE_HINTS: "0" }, () =>
    assert.equal(resultHintMeta("servicenow_get_script"), undefined),
  );
  assert.equal(resultHintMeta("servicenow_query_table"), undefined);
});

test("N-65: an MCP Apps link keeps the hint registered with the tool", () => {
  const spec = ALL_TOOLS.find((s) => s.name === "servicenow_explain_flow");
  let caps = {};
  const server = { server: { getClientCapabilities: () => caps } };
  const hint = { [MAX_RESULT_SIZE_KEY]: 48_000 };
  const handle = { _meta: hint };
  linkToolView(server, spec, handle);
  assert.deepEqual(handle._meta, hint, "no link for a plain client");
  caps = {
    extensions: { [MCP_APPS_EXTENSION]: { mimeTypes: [MCP_APPS_MIME] } },
  };
  assert.deepEqual(handle._meta, {
    ...hint,
    ui: { resourceUri: "ui://servicenow-mcp/flow" },
  });
});
