// D-2 — credentials model completeness: per-method credential evaluation,
// secrets entered through elicitation only, refresh-token rotation (L6-01),
// bearer token file + AUTH_EXPIRED (L6-02), env-file writer fidelity (L2-11)
// and the per-profile auth report (L8-01).
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { ALL_TOOLS } from "../build/mcp/registry.js";
import { runSpec } from "../build/mcp/define.js";
import {
  credentialStatus,
  hasCredentials,
  saveCredentials,
  envFileAclWarning,
  ENV_FILE_ACL_WARNING,
} from "../build/core/config.js";
import {
  getAuthProvider,
  getAuthMode,
  refreshTokenState,
  tokenExpiryWarning,
  credentialWarnings,
  reloadBearerTokenFile,
} from "../build/core/auth.js";
import { queryTable } from "../build/api/table.js";
import { runDoctor, formatDoctorReport } from "../build/api/doctor.js";
import { buildStatusPayload, profilesPayload } from "../build/mcp/status.js";
import { readWriteJournal } from "../build/core/write-journal.js";
import { setLogSink } from "../build/core/logging.js";
import { setServer } from "../build/mcp/context.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

baselineEnv();

/** Every auth key a test may set — listed so withEnv restores them all. */
const AUTH_CLEAR = {
  SN_AUTH: undefined,
  SN_API_KEY: undefined,
  SN_BEARER_TOKEN: undefined,
  SN_TOKEN_FILE: undefined,
  SN_TOKEN_EXPIRES_AT: undefined,
  SN_OAUTH_CLIENT_ID: undefined,
  SN_OAUTH_CLIENT_SECRET: undefined,
  SN_OAUTH_GRANT: undefined,
  SN_OAUTH_REFRESH_TOKEN: undefined,
  SN_OAUTH_JWT_KEY: undefined,
  SN_OAUTH_JWT_KEY_FILE: undefined,
  SN_OAUTH_JWT_SUB: undefined,
  SN_TLS_CLIENT_CERT: undefined,
  SN_TLS_CLIENT_CERT_FILE: undefined,
  SN_ACTIVE_PROFILE: undefined,
  SN_PROFILE_DEV_INSTANCE: undefined,
  SN_PROFILE_DEV_AUTH: undefined,
  SN_PROFILE_DEV_API_KEY: undefined,
  SN_PROFILE_DEV_OAUTH_CLIENT_ID: undefined,
  SN_PROFILE_DEV_OAUTH_GRANT: undefined,
  SN_PROFILE_DEV_OAUTH_REFRESH_TOKEN: undefined,
  SN_READONLY: undefined,
  SN_PROFILE_DEV_READONLY: undefined,
  SN_WRITE_MODE: undefined,
  SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE: undefined,
};

/** Run `fn` in a scratch dir used as env file + docs dir, auth keys cleared. */
async function withScratch(env, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "servicenow-mcp-d2-"));
  const envFile = path.join(dir, ".env");
  freshRuntime();
  try {
    await withEnv(
      { SN_ENV_FILE: envFile, SN_DOCS_DIR: dir, ...AUTH_CLEAR, ...env },
      () => fn({ dir, envFile }),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    freshRuntime();
    baselineEnv();
  }
}

const savedFile = async (envFile) =>
  existsSync(envFile) ? dotenv.parse(await fs.readFile(envFile, "utf8")) : null;

// ---------------------------------------------------------------------------
// Per-method evaluation
// ---------------------------------------------------------------------------

test("D-2: credentialStatus evaluates each auth method against its own requirements", async () => {
  const cases = [
    [{}, "basic", []],
    [{ SN_PASSWORD: undefined }, "basic", ["password"]],
    [{ SN_AUTH: "apikey" }, "apikey", ["api_key"]],
    [{ SN_API_KEY: "k", SN_PASSWORD: undefined }, "apikey", []],
    [{ SN_AUTH: "token" }, "token", ["bearer_token"]],
    [{ SN_TOKEN_FILE: "/tmp/tok", SN_USER: undefined }, "token", []],
    [
      { SN_AUTH: "none", SN_USER: undefined, SN_PASSWORD: undefined },
      "none",
      [],
    ],
    [{ SN_AUTH: "oauth" }, "oauth", ["oauth_client_id"]],
    [
      { SN_OAUTH_CLIENT_ID: "id", SN_PASSWORD: undefined },
      "oauth",
      ["password"],
    ],
    [
      { SN_OAUTH_CLIENT_ID: "id", SN_OAUTH_GRANT: "client_credentials" },
      "oauth",
      ["oauth_client_secret"],
    ],
    [
      {
        SN_OAUTH_CLIENT_ID: "id",
        SN_OAUTH_GRANT: "client_credentials",
        SN_OAUTH_CLIENT_SECRET: "sec",
        SN_USER: undefined,
        SN_PASSWORD: undefined,
      },
      "oauth",
      [],
    ],
    [
      { SN_OAUTH_CLIENT_ID: "id", SN_OAUTH_GRANT: "refresh_token" },
      "oauth",
      ["oauth_refresh_token"],
    ],
    [
      {
        SN_OAUTH_CLIENT_ID: "id",
        SN_OAUTH_GRANT: "jwt_bearer",
        SN_USER: undefined,
      },
      "oauth",
      ["oauth_jwt_key", "oauth_jwt_sub"],
    ],
    [
      {
        SN_OAUTH_CLIENT_ID: "id",
        SN_OAUTH_GRANT: "jwt_bearer",
        SN_OAUTH_JWT_KEY_FILE: "/k.pem",
      },
      "oauth",
      [],
    ],
    [
      { SN_OAUTH_CLIENT_ID: "id", SN_OAUTH_GRANT: "saml" },
      "oauth",
      ["oauth_grant"],
    ],
    [{ SN_INSTANCE: undefined, SN_AUTH: "none" }, "none", ["instance"]],
  ];
  for (const [env, mode, missing] of cases) {
    await withEnv({ ...AUTH_CLEAR, ...env }, () => {
      const status = credentialStatus();
      assert.equal(status.mode, mode, JSON.stringify(env));
      assert.deepEqual(status.missing, missing, JSON.stringify(env));
      assert.equal(hasCredentials(), missing.length === 0);
    });
  }
});

test("D-2: doctor is method-aware — an API-key profile without a password is configured", async () => {
  await withScratch(
    { SN_AUTH: "apikey", SN_API_KEY: "key-1", SN_PASSWORD: undefined },
    async () => {
      await withFetch(
        () => jsonResponse(200, { result: [{ sys_id: "1" }] }),
        async () => {
          const r = await runDoctor();
          assert.equal(r.config.configured, true);
          assert.equal(r.config.auth, "apikey");
          assert.deepEqual(r.config.warnings, []);
          const text = formatDoctorReport(r);
          assert.match(text, /auth: {5}apikey/);
          assert.ok(!text.includes("key-1"));
        },
      );
    },
  );
  await withScratch(
    { SN_AUTH: "token", SN_USER: undefined, SN_PASSWORD: undefined },
    async () => {
      const r = await runDoctor();
      assert.equal(r.status, "not_configured");
      assert.deepEqual(r.config.missing, ["bearer_token"]);
      assert.match(r.summary, /SN_BEARER_TOKEN or SN_TOKEN_FILE/);
    },
  );
  for (const [env, pattern] of [
    [{ SN_AUTH: "apikey" }, /SN_API_KEY/],
    [{ SN_AUTH: "oauth" }, /SN_OAUTH_CLIENT_ID/],
    [{ SN_AUTH: "none", SN_INSTANCE: undefined }, /client certificate/],
  ]) {
    await withScratch(env, async () => {
      const r = await runDoctor();
      assert.equal(r.status, "not_configured");
      assert.match(r.summary, pattern);
    });
  }
});

test("D-2: doctor and get_status carry credential warnings; oauth shows its grant", async () => {
  await withScratch(
    {
      SN_OAUTH_CLIENT_ID: "id",
      SN_OAUTH_GRANT: "refresh_token",
      SN_OAUTH_REFRESH_TOKEN: "rt-1",
    },
    async () => {
      // Only the config stage matters here; the probes get a canned 503.
      const r = await withFetch(
        () => jsonResponse(503, {}),
        () => runDoctor(),
      );
      const cfg = r.config;
      assert.ok(cfg);
      assert.equal(cfg.auth, "oauth");
      assert.equal(cfg.grant, "refresh_token");
      assert.equal(cfg.refreshToken, "configured");
      const text = formatDoctorReport({
        ...r,
        config: { ...cfg, warnings: ["w-1"] },
      });
      assert.match(text, /auth: {5}oauth \(refresh_token\)/);
      assert.match(text, /refresh: {2}configured/);
      assert.match(text, /! w-1/);
    },
  );
  await withScratch({ SN_AUTH: "none" }, async () => {
    const warnings = buildStatusPayload().authWarnings;
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no client certificate/);
  });
  await withScratch(
    { SN_AUTH: "none", SN_TLS_CLIENT_CERT_FILE: "/c.pem" },
    async () => {
      assert.deepEqual(buildStatusPayload().authWarnings, []);
    },
  );
});

// ---------------------------------------------------------------------------
// L2-11 — env-file writer
// ---------------------------------------------------------------------------

test("L2-11: the env writer keeps a CRLF file CRLF and stores Windows paths literally", async () => {
  await withScratch({}, async ({ envFile }) => {
    await fs.writeFile(
      envFile,
      "# header\r\nSN_INSTANCE=dev00000\r\nOTHER=1\r\n",
    );
    saveCredentials({ password: " C:\\Program Files\\x " }, "default");
    const raw = await fs.readFile(envFile, "utf8");
    assert.ok(
      !/[^\r]\n/.test(raw),
      `LF-only line found: ${JSON.stringify(raw)}`,
    );
    assert.ok(raw.endsWith("\r\n"));
    assert.ok(raw.startsWith("# header\r\n"));
    assert.equal(dotenv.parse(raw).SN_PASSWORD, " C:\\Program Files\\x ");
    assert.equal(dotenv.parse(raw).OTHER, "1");
  });
  await withScratch({}, async ({ envFile }) => {
    await fs.writeFile(envFile, "A=1\n");
    saveCredentials({ user: "bob" }, "default");
    assert.equal(await fs.readFile(envFile, "utf8"), "A=1\nSN_USER=bob\n");
  });
});

test("L2-11: the Windows ACL warning is raised on win32 only and never runs icacls", () => {
  assert.equal(envFileAclWarning("win32"), ENV_FILE_ACL_WARNING);
  assert.match(ENV_FILE_ACL_WARNING, /icacls/);
  assert.equal(envFileAclWarning("linux"), undefined);
  assert.equal(envFileAclWarning("darwin"), undefined);
  assert.ok(
    credentialWarnings("default", "win32").includes(ENV_FILE_ACL_WARNING),
  );
  assert.ok(
    !credentialWarnings("default", "linux").includes(ENV_FILE_ACL_WARNING),
  );
});

// ---------------------------------------------------------------------------
// L6-01 — refresh-token rotation
// ---------------------------------------------------------------------------

const REFRESH_ENV = {
  SN_OAUTH_CLIENT_ID: "cid",
  SN_OAUTH_CLIENT_SECRET: "csec",
  SN_OAUTH_GRANT: "refresh_token",
  SN_OAUTH_REFRESH_TOKEN: "rt-old",
};

test("L6-01: a rotated refresh token is persisted to the env file it was read from", async () => {
  await withScratch(REFRESH_ENV, async ({ envFile }) => {
    await withFetch(
      (url, init) => {
        assert.match(url, /oauth_token\.do$/);
        assert.match(String(init.body), /refresh_token=rt-old/);
        return jsonResponse(200, {
          access_token: "at-1",
          expires_in: 3600,
          refresh_token: "rt-new",
        });
      },
      async () => {
        await getAuthProvider().headers("dev00000.service-now.com");
      },
    );
    assert.equal((await savedFile(envFile)).SN_OAUTH_REFRESH_TOKEN, "rt-new");
    assert.equal(process.env.SN_OAUTH_REFRESH_TOKEN, "rt-new");
    assert.equal(refreshTokenState(), "configured");
  });
});

test("L6-01: a profile-scoped refresh token rotates into the profile key", async () => {
  await withScratch(
    {
      SN_ACTIVE_PROFILE: "dev",
      SN_PROFILE_DEV_INSTANCE: "dev11111.service-now.com",
      SN_PROFILE_DEV_OAUTH_CLIENT_ID: "cid",
      SN_PROFILE_DEV_OAUTH_GRANT: "refresh_token",
      SN_PROFILE_DEV_OAUTH_REFRESH_TOKEN: "rt-dev",
    },
    async ({ envFile }) => {
      await withFetch(
        () =>
          jsonResponse(200, {
            access_token: "at",
            expires_in: 3600,
            refresh_token: "rt-dev-2",
          }),
        async () => {
          await getAuthProvider().headers("dev11111.service-now.com");
        },
      );
      const file = await savedFile(envFile);
      assert.equal(file.SN_PROFILE_DEV_OAUTH_REFRESH_TOKEN, "rt-dev-2");
      assert.equal(file.SN_OAUTH_REFRESH_TOKEN, undefined);
    },
  );
});

test("L6-01: an unchanged or absent refresh token writes nothing", async () => {
  await withScratch(REFRESH_ENV, async ({ envFile }) => {
    let n = 0;
    await withFetch(
      () => {
        n += 1;
        return jsonResponse(200, {
          access_token: `at-${n}`,
          expires_in: 3600,
          ...(n === 1 ? { refresh_token: "rt-old" } : {}),
        });
      },
      async () => {
        await getAuthProvider().headers("dev00000.service-now.com");
        freshRuntime();
        await getAuthProvider().headers("dev00000.service-now.com");
      },
    );
    assert.equal(n, 2);
    assert.equal(await savedFile(envFile), null);
  });
});

test("L6-01: a read-only env file keeps the rotated token in memory and warns once", async () => {
  await withScratch(REFRESH_ENV, async ({ dir }) => {
    // A regular file used as a directory: the write fails (ENOTDIR).
    const blocker = path.join(dir, "blocker");
    await fs.writeFile(blocker, "");
    const warnings = [];
    setLogSink((level, message) => {
      if (level === "warn") warnings.push(message);
    });
    try {
      await withEnv({ SN_ENV_FILE: path.join(blocker, ".env") }, async () => {
        let n = 0;
        await withFetch(
          () => {
            n += 1;
            return jsonResponse(200, {
              access_token: `at-${n}`,
              expires_in: 1,
              refresh_token: `rt-mem-${n}`,
            });
          },
          async () => {
            const provider = getAuthProvider();
            await provider.headers("dev00000.service-now.com");
            assert.equal(process.env.SN_OAUTH_REFRESH_TOKEN, "rt-mem-1");
            assert.equal(refreshTokenState(), "rotated-in-memory");
            // A 1s TTL is inside the refresh skew: the next call refreshes
            // with the in-memory token and rotates again.
            await provider.headers("dev00000.service-now.com");
          },
        );
        assert.equal(n, 2);
        assert.equal(process.env.SN_OAUTH_REFRESH_TOKEN, "rt-mem-2");
        assert.equal(warnings.filter((m) => /in memory/.test(m)).length, 1);
        assert.ok(
          credentialWarnings().some((w) => /kept in memory only/.test(w)),
        );
        const r = await withFetch(
          () => jsonResponse(503, {}),
          () => runDoctor(),
        );
        assert.equal(r.config.refreshToken, "rotated-in-memory");
        const rt = profilesPayload().profiles[0].refreshToken;
        assert.equal(rt, "rotated-in-memory");
      });
    } finally {
      setLogSink(null);
    }
  });
});

// ---------------------------------------------------------------------------
// L6-02 — bearer token file, AUTH_EXPIRED, expiry warning
// ---------------------------------------------------------------------------

test("L6-02: SN_TOKEN_FILE wins over SN_BEARER_TOKEN and is re-read once on a 401", async () => {
  await withScratch({}, async ({ dir }) => {
    const tokenFile = path.join(dir, "token");
    await fs.writeFile(tokenFile, "tok-1\n");
    await withEnv(
      { SN_TOKEN_FILE: tokenFile, SN_BEARER_TOKEN: "inline" },
      async () => {
        assert.equal(getAuthMode(), "token");
        const seen = [];
        await withFetch(
          async (url, init) => {
            seen.push(init.headers.Authorization);
            if (init.headers.Authorization === "Bearer tok-1") {
              // The issuer rotates the file while the old token is rejected.
              await fs.writeFile(tokenFile, "tok-2");
              return jsonResponse(401, { error: { message: "expired" } });
            }
            return jsonResponse(200, { result: [] });
          },
          async () => {
            await queryTable({ table: "incident" });
          },
        );
        assert.deepEqual(seen, ["Bearer tok-1", "Bearer tok-2"]);
        // An unchanged file is not a reason to retry.
        assert.equal(reloadBearerTokenFile(), false);
      },
    );
  });
});

test("L6-02: a rejected bearer token without a fresher file fails with AUTH_EXPIRED", async () => {
  await withScratch(
    { SN_AUTH: "token", SN_BEARER_TOKEN: "stale" },
    async () => {
      await withFetch(
        () =>
          jsonResponse(401, { error: { message: "User Not Authenticated" } }),
        async (calls) => {
          await assert.rejects(queryTable({ table: "incident" }), (err) => {
            assert.equal(err.code, "AUTH_EXPIRED");
            assert.equal(err.status, 401);
            assert.match(err.hint, /SN_TOKEN_FILE/);
            return true;
          });
          assert.equal(calls.length, 1);
        },
      );
    },
  );
  await withScratch(
    { SN_AUTH: "token", SN_TOKEN_FILE: "/nonexistent/tok" },
    async () => {
      await assert.rejects(
        queryTable({ table: "incident" }),
        /Cannot read SN_TOKEN_FILE/,
      );
      assert.equal(reloadBearerTokenFile(), false);
    },
  );
  await withScratch({ SN_AUTH: "token" }, async ({ dir }) => {
    const empty = path.join(dir, "empty");
    await fs.writeFile(empty, "  \n");
    await withEnv({ SN_TOKEN_FILE: empty }, async () => {
      await assert.rejects(
        queryTable({ table: "incident" }),
        /SN_TOKEN_FILE is empty/,
      );
    });
    await assert.rejects(
      queryTable({ table: "incident" }),
      /requires SN_BEARER_TOKEN or SN_TOKEN_FILE/,
    );
  });
  // Basic auth keeps its plain 401 (no AUTH_EXPIRED code).
  await withScratch({}, async () => {
    await withFetch(
      () => jsonResponse(401, { error: { message: "nope" } }),
      async () => {
        await assert.rejects(queryTable({ table: "incident" }), (err) => {
          assert.equal(err.status, 401);
          assert.equal(err.code, undefined);
          return true;
        });
      },
    );
  });
});

test("L6-02: SN_TOKEN_EXPIRES_AT warns within 24h, when expired and when unparsable", async () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const cases = [
    ["2026-09-30T12:00:00Z", null],
    ["2026-09-25T06:00:00Z", /expires in about 18h/],
    ["2026-09-24T11:00:00Z", /expired at/],
    ["next tuesday", /not an ISO 8601 date/],
  ];
  for (const [at, pattern] of cases) {
    await withEnv(
      { ...AUTH_CLEAR, SN_BEARER_TOKEN: "t", SN_TOKEN_EXPIRES_AT: at },
      () => {
        const warning = tokenExpiryWarning("default", now);
        if (pattern) assert.match(warning, pattern, at);
        else assert.equal(warning, undefined, at);
      },
    );
  }
  // Only meaningful in token mode.
  await withEnv(
    { ...AUTH_CLEAR, SN_TOKEN_EXPIRES_AT: "2000-01-01T00:00:00Z" },
    () => assert.equal(tokenExpiryWarning("default", now), undefined),
  );
  await withEnv(
    {
      ...AUTH_CLEAR,
      SN_BEARER_TOKEN: "t",
      SN_TOKEN_EXPIRES_AT: "2000-01-01T00:00:00Z",
    },
    () => {
      assert.ok(
        buildStatusPayload().authWarnings.some((w) => /expired/.test(w)),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// L8-01 — per-profile auth report
// ---------------------------------------------------------------------------

test("L8-01: profiles report auth, grant, refresh and write mode — never a secret", async () => {
  await withScratch(
    {
      SN_API_KEY: "SECRET-API-KEY",
      SN_WRITE_MODE: "apply",
      SN_PROFILE_DEV_INSTANCE: "dev11111.service-now.com",
      // Profiles inherit unscoped auth keys, so the method is pinned here.
      SN_PROFILE_DEV_AUTH: "oauth",
      SN_PROFILE_DEV_OAUTH_CLIENT_ID: "cid",
      SN_PROFILE_DEV_OAUTH_GRANT: "refresh_token",
      SN_PROFILE_DEV_OAUTH_REFRESH_TOKEN: "SECRET-REFRESH",
      SN_PROFILE_DEV_READONLY: "true",
    },
    () => {
      const payload = profilesPayload();
      const byName = Object.fromEntries(
        payload.profiles.map((p) => [p.name, p]),
      );
      assert.deepEqual(byName.default, {
        name: "default",
        active: true,
        instance: "dev00000.service-now.com",
        user: "alice",
        readOnly: false,
        hasCredentials: true,
        auth: "apikey",
        refreshToken: "none",
        writeMode: "apply",
      });
      assert.deepEqual(byName.dev, {
        name: "dev",
        active: false,
        instance: "dev11111.service-now.com",
        user: "(not set)",
        readOnly: true,
        hasCredentials: true,
        auth: "oauth",
        grant: "refresh_token",
        refreshToken: "configured",
        writeMode: "read-only",
      });
      const text = JSON.stringify(payload);
      assert.ok(!/SECRET|s3cret/.test(text), text);
    },
  );
  await withScratch({ SN_AUTH: "apikey" }, () => {
    assert.deepEqual(profilesPayload().profiles[0].missing, ["api_key"]);
    assert.equal(profilesPayload().profiles[0].writeMode, "plan");
  });
});

// ---------------------------------------------------------------------------
// set_credentials — auth method + secrets through elicitation
// ---------------------------------------------------------------------------

const spec = ALL_TOOLS.find((s) => s.name === "servicenow_set_credentials");
const setCredentials = (args) => runSpec(spec, args);
const payload = (res) => JSON.parse(res.content[0].text);
const errorMessage = (res) => payload(res).error.message;

async function connectedServer(clientCapabilities, onElicit) {
  const server = new McpServer({ name: "d2-test", version: "0.0.0" });
  setServer(server);
  const client = new Client(
    { name: "d2-client", version: "0.0.0" },
    { capabilities: clientCapabilities },
  );
  if (clientCapabilities.elicitation && onElicit) {
    client.setRequestHandler(ElicitRequestSchema, onElicit);
  }
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    close: async () => {
      setServer(null);
      await client.close();
      await server.close();
    },
  };
}

test("D-2: set_credentials stores the auth method and non-secret OAuth settings", async () => {
  await withScratch(
    { SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE: "1" },
    async ({ envFile, dir }) => {
      setServer(null);
      const res = await setCredentials({
        auth: "oauth",
        oauth_client_id: " cid-1 ",
        oauth_grant: "password",
      });
      assert.equal(res.isError, undefined, JSON.stringify(res));
      const body = payload(res);
      assert.equal(body.auth, "oauth");
      assert.equal(body.grant, "password");
      assert.equal(body.configured, true);
      const file = await savedFile(envFile);
      assert.equal(file.SN_AUTH, "oauth");
      assert.equal(file.SN_OAUTH_CLIENT_ID, "cid-1");
      assert.equal(file.SN_OAUTH_GRANT, "password");
      assert.equal(getAuthMode(), "oauth");
      await withEnv({ SN_DOCS_DIR: dir }, () => {
        const { entries } = readWriteJournal({ action: "config" });
        assert.deepEqual(entries.at(-1).keys, [
          "SN_AUTH",
          "SN_OAUTH_CLIENT_ID",
          "SN_OAUTH_GRANT",
        ]);
      });

      const empty = await setCredentials({});
      assert.equal(empty.isError, true);
      assert.match(errorMessage(empty), /request_secrets/);
    },
  );
});

test("D-2: secrets are refused without elicitation — even with the confirmation opt-out", async () => {
  await withScratch(
    { SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE: "1" },
    async ({ envFile }) => {
      setServer(null);
      let res = await setCredentials({ request_secrets: ["api_key"] });
      assert.equal(res.isError, true);
      assert.match(errorMessage(res), /never accepted as tool arguments/);
      assert.match(errorMessage(res), /SN_API_KEY/);
      const { close } = await connectedServer({}, null);
      try {
        res = await setCredentials({
          request_secrets: ["oauth_client_secret"],
        });
        assert.equal(res.isError, true);
        assert.match(errorMessage(res), /SN_OAUTH_CLIENT_SECRET/);
      } finally {
        await close();
      }
      assert.equal(await savedFile(envFile), null);
    },
  );
});

test("D-2: secrets entered through elicitation are saved, never echoed or journaled", async () => {
  await withScratch({}, async ({ envFile, dir }) => {
    let answer;
    const prompts = [];
    const { close } = await connectedServer(
      { elicitation: {} },
      async (req) => {
        prompts.push(req.params);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    );
    try {
      // Declined, cancelled, blank and failing prompts change nothing.
      for (const reply of [
        { action: "decline" },
        { action: "cancel" },
        { action: "accept", content: { api_key: "  " } },
        new Error("prompt exploded"),
      ]) {
        answer = reply;
        const res = await setCredentials({ request_secrets: ["api_key"] });
        assert.equal(res.isError, true, String(reply?.action ?? reply));
      }
      assert.equal(await savedFile(envFile), null);

      answer = {
        action: "accept",
        content: { api_key: "hush-key-1", oauth_client_secret: "hush-cs-1" },
      };
      const res = await setCredentials({
        auth: "apikey",
        request_secrets: ["api_key", "oauth_client_secret", "api_key"],
      });
      assert.equal(res.isError, undefined, JSON.stringify(res));
      const text = res.content[0].text;
      assert.ok(!text.includes("hush-"), text);
      const body = payload(res);
      assert.deepEqual(body.secretsSaved, ["api_key", "oauth_client_secret"]);
      assert.equal(body.auth, "apikey");
      assert.equal(body.configured, true);

      const last = prompts.at(-1);
      assert.deepEqual(last.requestedSchema.required, [
        "api_key",
        "oauth_client_secret",
      ]);
      assert.equal(last.requestedSchema.properties.api_key.type, "string");
      assert.ok(!JSON.stringify(last).includes("hush-"));

      const file = await savedFile(envFile);
      assert.equal(file.SN_API_KEY, "hush-key-1");
      assert.equal(file.SN_OAUTH_CLIENT_SECRET, "hush-cs-1");
      assert.equal(getAuthMode(), "apikey");

      await withEnv({ SN_DOCS_DIR: dir }, async () => {
        const { entries } = readWriteJournal({ action: "config" });
        assert.deepEqual(entries.at(-1).keys, [
          "SN_AUTH",
          "SN_API_KEY",
          "SN_OAUTH_CLIENT_SECRET",
        ]);
      });
      const journals = await fs.readdir(dir, { recursive: true });
      for (const f of journals) {
        const full = path.join(dir, f);
        if ((await fs.stat(full)).isFile() && full !== envFile) {
          assert.ok(!(await fs.readFile(full, "utf8")).includes("hush-"), f);
        }
      }
    } finally {
      await close();
    }
  });
});

test("D-2 / H-2: a host change needs the next auth method's own material", async () => {
  await withScratch({ SN_API_KEY: "old-key" }, async ({ envFile }) => {
    let answer = { action: "accept", content: { api_key: "new-key" } };
    const { close } = await connectedServer(
      { elicitation: {} },
      async () => answer,
    );
    try {
      // API key profile: user + password are not enough, a new key is.
      let res = await setCredentials({
        instance: "dev99999",
        user: "bob",
        password: "pw",
      });
      assert.equal(res.isError, true);
      assert.match(errorMessage(res), /^CREDENTIALS_INCOMPLETE: .*new API key/);

      // OAuth client_credentials: the client secret must come along.
      res = await setCredentials({
        instance: "dev99999",
        auth: "oauth",
        oauth_client_id: "cid",
        oauth_grant: "client_credentials",
      });
      assert.match(errorMessage(res), /OAuth client secret/);
      // OAuth password grant: user, password and secret.
      res = await setCredentials({
        instance: "dev99999",
        auth: "oauth",
        oauth_client_id: "cid",
        request_secrets: ["oauth_client_secret"],
      });
      assert.match(
        errorMessage(res),
        /user, password and a new OAuth client secret/,
      );
      // Grants and modes this tool cannot supply material for are refused.
      res = await setCredentials({
        instance: "dev99999",
        auth: "oauth",
        oauth_client_id: "cid",
        oauth_grant: "jwt_bearer",
      });
      assert.match(errorMessage(res), /jwt_bearer grant material/);
      res = await setCredentials({ instance: "dev99999", auth: "token" });
      assert.match(errorMessage(res), /new bearer token/);
      res = await setCredentials({
        instance: "dev99999",
        auth: "none",
        user: "bob",
      });
      assert.match(errorMessage(res), /user and password/);
      assert.equal(await savedFile(envFile), null);

      res = await setCredentials({
        instance: "dev99999",
        request_secrets: ["api_key"],
      });
      assert.equal(res.isError, undefined, JSON.stringify(res));
      const file = await savedFile(envFile);
      assert.equal(file.SN_INSTANCE, "dev99999");
      assert.equal(file.SN_API_KEY, "new-key");

      answer = { action: "accept", content: { oauth_client_secret: "cs" } };
      res = await setCredentials({
        instance: "dev88888",
        auth: "oauth",
        oauth_client_id: "cid",
        oauth_grant: "client_credentials",
        request_secrets: ["oauth_client_secret"],
      });
      assert.equal(res.isError, undefined, JSON.stringify(res));
      assert.equal(payload(res).grant, "client_credentials");
    } finally {
      await close();
    }
  });
});

test("D-2: set_credentials reports missing material and the win32 ACL warning shape", async () => {
  await withScratch(
    { SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE: "1" },
    async () => {
      setServer(null);
      const res = await setCredentials({ auth: "token" });
      assert.equal(res.isError, undefined, JSON.stringify(res));
      const body = payload(res);
      assert.equal(body.configured, false);
      assert.deepEqual(body.missing, ["bearer_token"]);
      // Not on win32 here: no warnings key at all.
      assert.equal(body.warnings, undefined);
    },
  );
});
