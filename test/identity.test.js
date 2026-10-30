import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { SERVER_VERSION, userAgent } from "../build/core/identity.js";
import { withEnv } from "./helpers.js";

const pkg = createRequire(import.meta.url)("../package.json");
const NODE_MAJOR = process.versions.node.split(".")[0];
const NO_SUFFIX = {
  SN_USER_AGENT_SUFFIX: undefined,
  SN_TRANSPORT: undefined,
  SN_USER: undefined,
};

test("SERVER_VERSION comes from package.json", () => {
  assert.equal(SERVER_VERSION, pkg.version);
});

test("userAgent names the server, Node and the transport — never the MCP client or the user", async () => {
  await withEnv(NO_SUFFIX, () => {
    assert.equal(
      userAgent(),
      `servicenow-mcp-ai/${pkg.version} (node/${NODE_MAJOR}; stdio)`,
    );
  });
  await withEnv({ ...NO_SUFFIX, SN_TRANSPORT: "http" }, () => {
    assert.equal(
      userAgent(),
      `servicenow-mcp-ai/${pkg.version} (node/${NODE_MAJOR}; http)`,
    );
  });
});

test("userAgent never names the configured ServiceNow user", async () => {
  await withEnv({ ...NO_SUFFIX, SN_USER: "ivan.baev" }, () => {
    assert.equal(
      userAgent(),
      `servicenow-mcp-ai/${pkg.version} (node/${NODE_MAJOR}; stdio)`,
    );
  });
});

test("SN_USER_AGENT_SUFFIX is appended, kept printable and capped at 80 chars", async () => {
  await withEnv(
    { ...NO_SUFFIX, SN_USER_AGENT_SUFFIX: "  team-platformINC0010042\n" },
    () => {
      assert.ok(userAgent().endsWith("; stdio) team-platform INC0010042"));
    },
  );
  await withEnv({ ...NO_SUFFIX, SN_USER_AGENT_SUFFIX: "x".repeat(200) }, () => {
    const [, suffix] = userAgent().split(") ");
    assert.equal(suffix.length, 80);
  });
  await withEnv({ ...NO_SUFFIX, SN_USER_AGENT_SUFFIX: "   " }, () => {
    assert.ok(userAgent().endsWith("; stdio)"));
  });
});
