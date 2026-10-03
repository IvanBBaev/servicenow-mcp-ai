// M-1 — server instructions, implementation info, the NOT_CONFIGURED error
// contract and the get_status v2 groups.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  buildServerInstructions,
  serverImplementation,
  INSTRUCTIONS_MAX_BYTES,
  SERVER_ICON_DATA_URI,
  SERVER_TITLE,
  SERVER_WEBSITE,
} from "../build/mcp/server-info.js";
import { activeToolSpecs, ALL_TOOLS } from "../build/mcp/registry.js";
import {
  buildStatusPayload,
  policySummary,
  serverStatusPayload,
} from "../build/mcp/status.js";
import { registerAllTools } from "../build/mcp/registry.js";
import { currentRuntime } from "../build/core/runtime.js";
import {
  appendWriteJournal,
  getWriteCounters,
} from "../build/core/write-journal.js";
import {
  notConfiguredError,
  NOT_CONFIGURED_HINT,
  ServiceNowError,
} from "../build/core/errors.js";
import { fail } from "../build/mcp/result.js";
import { testConnection } from "../build/api/diagnostics.js";
import { baselineEnv, freshRuntime, withEnv } from "./helpers.js";

baselineEnv();

const VERSION = "9.9.9";
const bytes = (s) => Buffer.byteLength(s, "utf8");

/** Env for a server with no credentials at all. */
const UNCONFIGURED = {
  SN_INSTANCE: undefined,
  SN_USER: undefined,
  SN_PASSWORD: undefined,
};

async function connect(server) {
  const client = new Client({ name: "m1-test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The real index.ts wiring (implementation info + instructions + tools). */
async function startServer() {
  const server = new McpServer(serverImplementation(VERSION), {
    capabilities: { logging: {} },
    instructions: buildServerInstructions(VERSION),
  });
  registerAllTools(server, currentRuntime());
  return connect(server);
}

// M-2: the flat error payload ({ error, code, source, hint?, ... }).
const errorOf = (result) => {
  const body = JSON.parse(result.content[0].text);
  return { ...body, message: body.error };
};

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

test("instructions (configured): version, profile, auth, packages, tool count, write mode", async () => {
  await withEnv(
    { SN_TOOL_PACKAGES: undefined, SN_WRITE_MODE: undefined },
    () => {
      const text = buildServerInstructions(VERSION);
      assert.match(text, /servicenow-mcp-ai 9\.9\.9/);
      assert.match(text, /servicenow_get_status shows the live state/);
      assert.match(text, /Profile: default\./);
      assert.match(
        text,
        /Credentials: configured \(basic\) for dev00000\.service-now\.com/,
      );
      assert.match(
        text,
        new RegExp(
          `Tools: ${activeToolSpecs().length} in 5 packages: admin, aggregate, attachment, schema, table\\.`,
        ),
      );
      assert.match(
        text,
        /More via SN_TOOL_PACKAGES or servicenow_enable_package/,
      );
      assert.match(text, /Writes: plan/);
      assert.match(text, /untrusted content/);
      assert.doesNotMatch(text, /NOT configured/);
    },
  );
});

test("instructions (unconfigured): says what is missing and how to fix it", async () => {
  await withEnv(UNCONFIGURED, () => {
    const text = buildServerInstructions(VERSION);
    assert.match(
      text,
      /Credentials: NOT configured \(missing instance, user, password\)/,
    );
    assert.match(text, /NOT_CONFIGURED/);
    assert.match(text, /servicenow_set_credentials/);
    assert.match(text, /servicenow_test_connection/);
  });
});

test("instructions: other profiles, read-only and apply modes, other auth grants", async () => {
  await withEnv(
    {
      SN_PROFILE_PROD_INSTANCE: "prod.service-now.com",
      SN_READONLY: "true",
    },
    () => {
      const text = buildServerInstructions(VERSION);
      assert.match(text, /also: prod; pass instance:"<profile>"/);
      assert.match(text, /Writes: read-only/);
    },
  );
  await withEnv({ SN_WRITE_MODE: "apply" }, () => {
    assert.match(buildServerInstructions(VERSION), /Writes: apply/);
  });
  await withEnv(
    {
      SN_AUTH: "oauth",
      SN_OAUTH_CLIENT_ID: "cid",
      SN_OAUTH_CLIENT_SECRET: "csecret-value",
    },
    () => {
      const text = buildServerInstructions(VERSION);
      assert.match(text, /Credentials: configured \(oauth\/password\)/);
      assert.doesNotMatch(text, /csecret-value/);
    },
  );
  // An instance value the host resolver rejects is simply not named.
  await withEnv({ SN_INSTANCE: "http://" }, () => {
    assert.doesNotMatch(buildServerInstructions(VERSION), / for http/);
  });
});

test("instructions never carry a secret and stay under the byte cap", async () => {
  // The worst case: every package on, several profiles, unconfigured default.
  await withEnv(
    {
      ...UNCONFIGURED,
      SN_TOOL_PACKAGES: "all",
      SN_PROFILE_DEV_INSTANCE: "dev.service-now.com",
      SN_PROFILE_DEV_PASSWORD: "dev-pass-value",
      SN_PROFILE_TEST_INSTANCE: "test.service-now.com",
      SN_PROFILE_PROD_INSTANCE: "prod.service-now.com",
    },
    () => {
      const text = buildServerInstructions(VERSION);
      assert.ok(
        bytes(text) <= INSTRUCTIONS_MAX_BYTES,
        `instructions: ${bytes(text)} > ${INSTRUCTIONS_MAX_BYTES}`,
      );
      assert.doesNotMatch(text, /dev-pass-value/);
      assert.match(text, new RegExp(`Tools: ${ALL_TOOLS.length} in`));
      assert.doesNotMatch(text, /More via SN_TOOL_PACKAGES/);
    },
  );
  await withEnv({}, () => {
    const text = buildServerInstructions(VERSION);
    assert.doesNotMatch(text, /s3cret|alice/);
    assert.doesNotMatch(text, /\.env/);
  });
});

test("instructions tool count matches what registerAllTools registers", async () => {
  await withEnv(
    { SN_PACKAGES_READONLY: "table", SN_TOOL_PACKAGES: undefined },
    async () => {
      const { client, close } = await startServer();
      try {
        const listed = (await client.listTools()).tools.length;
        assert.equal(listed, activeToolSpecs().length);
        assert.match(
          client.getInstructions(),
          new RegExp(`Tools: ${listed} in`),
        );
      } finally {
        await close();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Implementation info
// ---------------------------------------------------------------------------

test("initialize carries title, websiteUrl, icons and the instructions", async () => {
  const { client, close } = await startServer();
  try {
    const info = client.getServerVersion();
    assert.equal(info.name, "servicenow-mcp-ai");
    assert.equal(info.version, VERSION);
    assert.equal(info.title, SERVER_TITLE);
    assert.equal(info.websiteUrl, SERVER_WEBSITE);
    assert.equal(info.icons.length, 1);
    assert.equal(info.icons[0].mimeType, "image/svg+xml");
    assert.equal(info.icons[0].src, SERVER_ICON_DATA_URI);
    assert.match(client.getInstructions(), /servicenow-mcp-ai 9\.9\.9/);
  } finally {
    await close();
  }
});

test("the icon is a small inline SVG data URI (no network fetch)", () => {
  assert.match(SERVER_ICON_DATA_URI, /^data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(
    SERVER_ICON_DATA_URI.split(",")[1],
    "base64",
  ).toString();
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(bytes(SERVER_ICON_DATA_URI) < 4096);
});

// ---------------------------------------------------------------------------
// NOT_CONFIGURED
// ---------------------------------------------------------------------------

test("notConfiguredError: additive code + hint, message unchanged", () => {
  const e = notConfiguredError(
    "x is not configured.",
    ["instance", "password"],
    "dev",
  );
  assert.ok(e instanceof ServiceNowError);
  assert.equal(e.message, "x is not configured.");
  assert.equal(e.code, "NOT_CONFIGURED");
  assert.equal(
    e.hint,
    `Missing for profile "dev": instance, password. ${NOT_CONFIGURED_HINT}`,
  );
  assert.equal(notConfiguredError("y").hint, NOT_CONFIGURED_HINT);
  const payload = errorOf(fail(e));
  assert.deepEqual(Object.keys(payload).sort(), [
    "code",
    "error",
    "hint",
    "message",
    "source",
  ]);
  assert.equal(payload.source, "server");
});

test("a tool call without an instance fails with NOT_CONFIGURED and a set_credentials hint", async () => {
  await withEnv(UNCONFIGURED, async () => {
    const { client, close } = await startServer();
    try {
      const result = await client.callTool({
        name: "servicenow_query_table",
        arguments: { table: "incident" },
      });
      assert.equal(result.isError, true);
      const error = errorOf(result);
      assert.match(error.message, /not configured/);
      assert.equal(error.code, "NOT_CONFIGURED");
      assert.match(error.hint, /instance/);
      assert.match(error.hint, /servicenow_set_credentials/);
    } finally {
      await close();
    }
  });
});

test("Basic auth with a missing password fails with NOT_CONFIGURED", async () => {
  await withEnv({ SN_PASSWORD: undefined }, async () => {
    const { client, close } = await startServer();
    try {
      const result = await client.callTool({
        name: "servicenow_get_record",
        arguments: { table: "incident", sys_id: "a".repeat(32) },
      });
      const error = errorOf(result);
      assert.equal(error.code, "NOT_CONFIGURED");
      assert.match(error.hint, /Missing for profile "default": password/);
    } finally {
      await close();
    }
  });
});

test("test_connection surfaces the NOT_CONFIGURED code and hint", async () => {
  await withEnv(UNCONFIGURED, async () => {
    const probe = await testConnection();
    assert.equal(probe.ok, false);
    assert.equal(probe.code, "NOT_CONFIGURED");
    assert.match(probe.hint, /servicenow_set_credentials/);
  });
});

// ---------------------------------------------------------------------------
// get_status v2
// ---------------------------------------------------------------------------

test("get_status v2: server, policy, redaction, docs, limits, writes, profile source", async () => {
  await withEnv(
    {
      SN_WRITE_MODE: undefined,
      SN_DESTRUCTIVE_CONFIRM: undefined,
      SN_REDACT_FIELDS: "email, phone",
      SN_REDACT_PII: "true",
      SN_MAX_RECORDS: "123",
    },
    () => {
      const s = buildStatusPayload();
      assert.equal(s.server.name, "servicenow-mcp-ai");
      assert.match(s.server.version, /^\d+\.\d+\.\d+/);
      assert.equal(s.server.pid, process.pid);
      assert.equal(typeof s.server.uptimeSec, "number");
      assert.ok(!Number.isNaN(Date.parse(s.server.startedAt)));
      assert.equal(s.server.node, process.versions.node);
      assert.equal(s.server.transport, "stdio");
      assert.equal(s.server.http, undefined);
      assert.equal(s.writeMode, "plan");
      assert.deepEqual(s.policy, {
        writeMode: "plan",
        destructiveConfirm: "token",
        readOnly: false,
        summary: policySummary(),
      });
      assert.deepEqual(s.redaction, { enabled: true, fields: 2, pii: true });
      assert.equal(typeof s.docs.dir, "string");
      assert.equal(s.limits.maxRecords, 123);
      for (const v of Object.values(s.limits)) assert.equal(typeof v, "number");
      assert.deepEqual(Object.keys(s.writes).sort(), [
        "applied",
        "caps",
        "failed",
        "lastAt",
        "local",
        "refused",
      ]);
      assert.equal(s.profileSource.active, "default");
      assert.equal(s.profileSource.source, "default");
      assert.equal(typeof s.profileSource.envFileExists, "boolean");
      // The v1 keys stay as they were (additive only).
      assert.deepEqual(s.profiles, ["default"]);
      assert.equal(s.profileDetails[0].name, "default");
      assert.equal(s.profileDetails[0].auth, "basic");
      assert.equal(s.profileDetails[0].writeMode, "plan");
    },
  );
});

test("get_status v2: policy summary per posture; SN_ACTIVE_PROFILE source", async () => {
  await withEnv({ SN_READONLY: "true" }, () => {
    assert.match(buildStatusPayload().policy.summary, /^read-only/);
  });
  await withEnv({ SN_WRITE_MODE: "apply" }, () => {
    const s = buildStatusPayload();
    assert.equal(s.writeMode, "apply");
    assert.match(s.policy.summary, /^apply/);
  });
  await withEnv(
    {
      SN_ACTIVE_PROFILE: "dev",
      SN_PROFILE_DEV_INSTANCE: "dev.service-now.com",
    },
    () => {
      const s = buildStatusPayload();
      assert.deepEqual(
        { active: s.profileSource.active, source: s.profileSource.source },
        { active: "dev", source: "SN_ACTIVE_PROFILE" },
      );
      const dev = s.profileDetails.find((p) => p.name === "dev");
      assert.deepEqual(dev.missing, ["user", "password"]);
    },
  );
});

test("get_status v2: docs dir existence and writability", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "m1-docs-"));
  try {
    await withEnv({ SN_DOCS_DIR: dir }, () => {
      assert.deepEqual(buildStatusPayload().docs, {
        dir,
        exists: true,
        writable: true,
      });
    });
    const missing = path.join(dir, "nope");
    await withEnv({ SN_DOCS_DIR: missing }, () => {
      assert.deepEqual(buildStatusPayload().docs, {
        dir: missing,
        exists: false,
        writable: null,
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("get_status v2: the HTTP transport shows host/port and only whether a token is set", async () => {
  await withEnv(
    {
      SN_TRANSPORT: "http",
      SN_PORT: "3999",
      SN_HTTP_TOKEN: "http-token-value",
    },
    () => {
      const server = serverStatusPayload();
      assert.equal(server.transport, "http");
      assert.deepEqual(server.http, {
        host: "127.0.0.1",
        port: 3999,
        tokenSet: true,
        // H-7: no transport running here, no calling session.
        sessions: 0,
      });
      assert.doesNotMatch(
        JSON.stringify(buildStatusPayload()),
        /http-token-value/,
      );
    },
  );
});

test("get_status v2 never leaks a secret (every credential kind set)", async () => {
  const secrets = {
    SN_PASSWORD: "pw-secret-1",
    SN_API_KEY: "apikey-secret-2",
    SN_BEARER_TOKEN: "bearer-secret-3",
    SN_OAUTH_CLIENT_ID: "cid-4",
    SN_OAUTH_CLIENT_SECRET: "client-secret-5",
    SN_OAUTH_REFRESH_TOKEN: "refresh-secret-6",
    SN_HTTP_TOKEN: "http-secret-7",
    SN_PROFILE_DEV_INSTANCE: "dev.service-now.com",
    SN_PROFILE_DEV_USER: "bob",
    SN_PROFILE_DEV_PASSWORD: "dev-pw-secret-8",
  };
  for (const auth of [undefined, "apikey", "token", "oauth"]) {
    await withEnv({ ...secrets, SN_AUTH: auth }, async () => {
      const { client, close } = await startServer();
      try {
        const result = await client.callTool({
          name: "servicenow_get_status",
          arguments: {},
        });
        assert.notEqual(result.isError, true);
        const text = JSON.stringify(result);
        for (const [key, value] of Object.entries(secrets)) {
          if (/SECRET|PASSWORD|TOKEN|API_KEY/.test(key)) {
            assert.ok(!text.includes(value), `${key} leaked (auth=${auth})`);
          }
        }
        // The v2 groups reach structuredContent through the output schema.
        assert.ok(result.structuredContent.server);
        assert.ok(result.structuredContent.profileDetails.length >= 2);
      } finally {
        await close();
      }
    });
  }
});

test("get_status via instance arg reports the request profile source", async () => {
  const { client, close } = await startServer();
  try {
    const result = await client.callTool({
      name: "servicenow_get_status",
      arguments: { instance: "default" },
    });
    assert.equal(result.structuredContent.profileSource.source, "request");
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Write counters
// ---------------------------------------------------------------------------

test("write counters count journalled lines by outcome; a fresh runtime resets them", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "m1-journal-"));
  try {
    await withEnv({ SN_DOCS_DIR: dir }, () => {
      freshRuntime();
      assert.deepEqual(getWriteCounters(), {
        applied: 0,
        failed: 0,
        refused: 0,
        local: 0,
        lastAt: null,
      });
      appendWriteJournal({ action: "create", table: "incident" });
      appendWriteJournal({
        action: "update",
        table: "incident",
        result: "failed",
      });
      appendWriteJournal({
        action: "delete",
        table: "incident",
        result: "refused",
      });
      const last = appendWriteJournal({ action: "local_write", table: "docs" });
      appendWriteJournal({ action: "config", table: "env" });
      const c = getWriteCounters();
      assert.deepEqual(
        {
          applied: c.applied,
          failed: c.failed,
          refused: c.refused,
          local: c.local,
        },
        { applied: 1, failed: 1, refused: 1, local: 2 },
      );
      assert.ok(c.lastAt >= last.ts);
      assert.equal(buildStatusPayload().writes.applied, 1);
      // A snapshot, not the live object.
      c.applied = 99;
      assert.equal(getWriteCounters().applied, 1);
      freshRuntime();
      assert.equal(getWriteCounters().applied, 0);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
