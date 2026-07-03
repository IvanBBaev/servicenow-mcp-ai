import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { jiraRequest } from "../build/core/jira/http.js";
import {
  getJiraCredentials,
  hasJiraCredentials,
  saveJiraCredentials,
} from "../build/core/jira/config.js";
import { JiraError, ServiceNowError } from "../build/core/errors.js";
import { getTelemetry, _resetTelemetry } from "../build/core/http-util.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

// Baseline Jira connection most request tests assume.
const JIRA = {
  JIRA_SITE: "mycompany",
  JIRA_EMAIL: "alice@example.com",
  JIRA_API_TOKEN: "tok",
  JIRA_ALLOWED_HOSTS: undefined,
  SN_MAX_RETRIES: "0",
};

// --- config / credentials ---------------------------------------------------

test("getJiraCredentials trims the site, email and API token", async () => {
  await withEnv(
    {
      JIRA_SITE: "  mycompany  ",
      JIRA_EMAIL: "  alice@example.com  ",
      JIRA_API_TOKEN: "  tok  ",
    },
    () => {
      const c = getJiraCredentials();
      assert.equal(c.site, "mycompany");
      assert.equal(c.email, "alice@example.com");
      assert.equal(c.apiToken, "tok");
    },
  );
});

test("hasJiraCredentials is false when the token is only whitespace", async () => {
  await withEnv(
    { JIRA_SITE: "mycompany", JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "   " },
    () => {
      assert.equal(hasJiraCredentials(), false);
    },
  );
  await withEnv(
    { JIRA_SITE: "mycompany", JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "tok" },
    () => {
      assert.equal(hasJiraCredentials(), true);
    },
  );
});

test("saveJiraCredentials persists trimmed values and updates process.env", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "servicenow-mcp-jira-"));
  const envFile = path.join(dir, ".env");
  try {
    await withEnv({ SN_ENV_FILE: envFile }, () => {
      const saved = saveJiraCredentials({
        site: "  mycompany  ",
        email: "alice@example.com",
        apiToken: "  secret-token  ",
      });
      assert.equal(saved.site, "mycompany");
      assert.equal(saved.apiToken, "secret-token");
      assert.equal(process.env.JIRA_API_TOKEN, "secret-token");
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- request: auth, URL, parsing -------------------------------------------

test("sends a Basic Authorization header built from email:token", async () => {
  await withEnv(JIRA, () =>
    withFetch(
      (_url, init) => {
        const expected = `Basic ${Buffer.from("alice@example.com:tok").toString("base64")}`;
        assert.equal(init.headers.Authorization, expected);
        assert.equal(init.headers.Accept, "application/json");
        return jsonResponse(200, { key: "PROJ-1" });
      },
      async () => {
        const { data } = await jiraRequest({
          method: "GET",
          path: "/rest/api/3/issue/PROJ-1",
        });
        assert.equal(data.key, "PROJ-1");
      },
    ),
  );
});

test("resolves the site to a *.atlassian.net origin and appends query params", async () => {
  await withEnv(JIRA, () =>
    withFetch(
      (url) => {
        assert.equal(
          url,
          "https://mycompany.atlassian.net/rest/api/3/search?jql=project%3DPROJ",
        );
        return jsonResponse(200, { issues: [] });
      },
      async () => {
        await jiraRequest({
          method: "GET",
          path: "/rest/api/3/search",
          params: new URLSearchParams({ jql: "project=PROJ" }),
        });
      },
    ),
  );
});

test("serialises a JSON body and labels its Content-Type", async () => {
  await withEnv(JIRA, () =>
    withFetch(
      (_url, init) => {
        assert.equal(init.headers["Content-Type"], "application/json");
        assert.equal(init.body, JSON.stringify({ summary: "x" }));
        return jsonResponse(201, { key: "PROJ-2" });
      },
      async () => {
        await jiraRequest({
          method: "POST",
          path: "/rest/api/3/issue",
          body: { summary: "x" },
        });
      },
    ),
  );
});

test("lets fetch own the multipart Content-Type for a FormData body", async () => {
  await withEnv(JIRA, () =>
    withFetch(
      (_url, init) => {
        assert.ok(init.body instanceof FormData);
        assert.equal(init.headers["Content-Type"], undefined);
        return jsonResponse(200, [{ id: "10000" }]);
      },
      async () => {
        const form = new FormData();
        form.append("file", new Blob(["x"]), "a.txt");
        await jiraRequest({
          method: "POST",
          path: "/rest/api/3/issue/PROJ-1/attachments",
          form,
          extraHeaders: { "X-Atlassian-Token": "no-check" },
        });
      },
    ),
  );
});

// --- request: error mapping -------------------------------------------------

test("maps a non-2xx response to a JiraError with status and errorMessages", async () => {
  await withEnv(JIRA, () =>
    withFetch(
      () => jsonResponse(404, { errorMessages: ["Issue does not exist"] }),
      async () => {
        await assert.rejects(
          jiraRequest({ method: "GET", path: "/rest/api/3/issue/PROJ-9" }),
          (err) =>
            err instanceof JiraError &&
            err.status === 404 &&
            /Issue does not exist/.test(err.message),
        );
      },
    ),
  );
});

test("maps the field-level errors object into the message", async () => {
  await withEnv(JIRA, () =>
    withFetch(
      () => jsonResponse(400, { errors: { summary: "is required" } }),
      async () => {
        await assert.rejects(
          jiraRequest({
            method: "POST",
            path: "/rest/api/3/issue",
            body: {},
          }),
          (err) =>
            err instanceof JiraError &&
            err.status === 400 &&
            /summary: is required/.test(err.message),
        );
      },
    ),
  );
});

test("falls back to the top-level message field of an error body", async () => {
  await withEnv(JIRA, () =>
    withFetch(
      () => jsonResponse(500, { message: "Internal server error" }),
      async () => {
        await assert.rejects(
          jiraRequest({ method: "GET", path: "/rest/api/3/myself" }),
          (err) =>
            err instanceof JiraError &&
            err.status === 500 &&
            /Internal server error/.test(err.message),
        );
      },
    ),
  );
});

test("JiraError keeps the ServiceNowError contract (name + inheritance)", () => {
  const err = new JiraError("boom", 418, { raw: "x" });
  assert.equal(err.name, "JiraError");
  assert.equal(err.status, 418);
  assert.deepEqual(err.detail, { raw: "x" });
  // The MCP result boundary (mcp/result.ts) narrows on ServiceNowError; the
  // subclass must keep passing that check or Jira failures lose their mapping.
  assert.ok(err instanceof ServiceNowError);
});

// --- request: configuration guards -----------------------------------------

test("rejects before any request when the site is not configured", async () => {
  await withEnv({ ...JIRA, JIRA_SITE: undefined }, () =>
    withFetch(
      () => {
        throw new Error("fetch must not be called when unconfigured");
      },
      async (calls) => {
        await assert.rejects(
          jiraRequest({ method: "GET", path: "/rest/api/3/myself" }),
          /not configured/,
        );
        assert.equal(calls.length, 0);
      },
    ),
  );
});

test("rejects before any request when email or token is missing", async () => {
  await withEnv({ ...JIRA, JIRA_API_TOKEN: undefined }, () =>
    withFetch(
      () => {
        throw new Error("fetch must not be called without credentials");
      },
      async (calls) => {
        await assert.rejects(
          jiraRequest({ method: "GET", path: "/rest/api/3/myself" }),
          /JIRA_EMAIL and JIRA_API_TOKEN/,
        );
        assert.equal(calls.length, 0);
      },
    ),
  );
});

// --- request: retry policy --------------------------------------------------

test("retries a 429 then succeeds", async () => {
  await withEnv({ ...JIRA, SN_MAX_RETRIES: "1" }, () =>
    withFetch(
      (_url, _init, callNo) =>
        callNo === 1
          ? jsonResponse(429, {}, { "retry-after": "0" })
          : jsonResponse(200, { ok: true }),
      async (calls) => {
        const { data } = await jiraRequest({
          method: "GET",
          path: "/rest/api/3/myself",
        });
        assert.equal(data.ok, true);
        assert.equal(calls.length, 2);
      },
    ),
  );
});

test("retries an idempotent GET on a transport error", async () => {
  await withEnv({ ...JIRA, SN_MAX_RETRIES: "1" }, () =>
    withFetch(
      (_url, _init, callNo) => {
        if (callNo === 1) throw new Error("ECONNRESET");
        return jsonResponse(200, { ok: true });
      },
      async (calls) => {
        const { data } = await jiraRequest({
          method: "GET",
          path: "/rest/api/3/myself",
        });
        assert.equal(data.ok, true);
        assert.equal(calls.length, 2);
      },
    ),
  );
});

test("never replays a non-idempotent write on a transport error", async () => {
  await withEnv({ ...JIRA, SN_MAX_RETRIES: "2" }, () =>
    withFetch(
      () => {
        throw new Error("ECONNRESET");
      },
      async (calls) => {
        await assert.rejects(
          jiraRequest({
            method: "POST",
            path: "/rest/api/3/issue",
            body: { summary: "x" },
          }),
          (err) =>
            err instanceof JiraError &&
            /Could not reach Jira/.test(err.message),
        );
        // A single attempt — the create is never duplicated.
        assert.equal(calls.length, 1);
      },
    ),
  );
});

test("surfaces a timeout as a dedicated error message", async () => {
  await withEnv(JIRA, () =>
    withFetch(
      () => {
        const err = new Error("timed out");
        err.name = "TimeoutError";
        throw err;
      },
      async () => {
        await assert.rejects(
          jiraRequest({ method: "GET", path: "/rest/api/3/myself" }),
          /timed out after/,
        );
      },
    ),
  );
});

test("retries a 429 received on a POST (rejected before processing)", async () => {
  await withEnv({ ...JIRA, SN_MAX_RETRIES: "1" }, () =>
    withFetch(
      (_url, _init, callNo) =>
        callNo === 1
          ? jsonResponse(429, {}, { "retry-after": "0" })
          : jsonResponse(201, { key: "PROJ-3" }),
      async (calls) => {
        const { data } = await jiraRequest({
          method: "POST",
          path: "/rest/api/3/issue",
          body: { summary: "x" },
        });
        assert.equal(data.key, "PROJ-3");
        assert.equal(calls.length, 2);
      },
    ),
  );
});

test("never retries a 503 received on a POST (write may have landed)", async () => {
  await withEnv({ ...JIRA, SN_MAX_RETRIES: "2" }, () =>
    withFetch(
      () => jsonResponse(503, { errorMessages: ["unavailable"] }),
      async (calls) => {
        await assert.rejects(
          jiraRequest({
            method: "POST",
            path: "/rest/api/3/issue",
            body: { summary: "x" },
          }),
          (err) => err instanceof JiraError && err.status === 503,
        );
        // A single attempt — the create is never duplicated.
        assert.equal(calls.length, 1);
      },
    ),
  );
});

test("a 503 is still retried for an idempotent GET", async () => {
  await withEnv({ ...JIRA, SN_MAX_RETRIES: "1" }, () =>
    withFetch(
      (_url, _init, callNo) =>
        callNo === 1
          ? jsonResponse(503, {}, { "retry-after": "0" })
          : jsonResponse(200, { ok: true }),
      async (calls) => {
        const { data } = await jiraRequest({
          method: "GET",
          path: "/rest/api/3/myself",
        });
        assert.equal(data.ok, true);
        assert.equal(calls.length, 2);
      },
    ),
  );
});

// --- request: argument guards ----------------------------------------------

test("rejects a request that carries both a JSON body and a form", async () => {
  await withEnv(JIRA, () =>
    withFetch(
      () => {
        throw new Error("fetch must not be called for a malformed request");
      },
      async (calls) => {
        const form = new FormData();
        form.append("file", new Blob(["x"]), "a.txt");
        await assert.rejects(
          jiraRequest({
            method: "POST",
            path: "/rest/api/3/issue",
            body: { summary: "x" },
            form,
          }),
          /both a JSON body and a form/,
        );
        assert.equal(calls.length, 0);
      },
    ),
  );
});

test("rejects extraHeaders that would override a managed header (any casing)", async () => {
  await withEnv(JIRA, () =>
    withFetch(
      () => {
        throw new Error("fetch must not be called for a rejected request");
      },
      async (calls) => {
        await assert.rejects(
          jiraRequest({
            method: "GET",
            path: "/rest/api/3/myself",
            extraHeaders: { AUTHORIZATION: "Basic forged" },
          }),
          (err) =>
            err instanceof JiraError &&
            /must not set "AUTHORIZATION"/.test(err.message),
        );
        assert.equal(calls.length, 0);
      },
    ),
  );
});

test("joins params with & when the path already carries a query string", async () => {
  await withEnv(JIRA, () =>
    withFetch(
      (url) => {
        assert.equal(
          url,
          "https://mycompany.atlassian.net/rest/api/3/search?expand=names&jql=x",
        );
        return jsonResponse(200, { issues: [] });
      },
      async () => {
        await jiraRequest({
          method: "GET",
          path: "/rest/api/3/search?expand=names",
          params: new URLSearchParams({ jql: "x" }),
        });
      },
    ),
  );
});

// --- request: telemetry ------------------------------------------------------

test("a Jira request is counted under its own host in the shared telemetry", async () => {
  await withEnv(JIRA, () =>
    withFetch(
      () => jsonResponse(200, { ok: true }),
      async () => {
        _resetTelemetry();
        await jiraRequest({ method: "GET", path: "/rest/api/3/myself" });
        const t = getTelemetry();
        assert.equal(t.requests, 1);
        assert.equal(t.perHost["mycompany.atlassian.net"].requests, 1);
      },
    ),
  );
});

// --- request: binary download ----------------------------------------------

test("returns binary responses as base64", async () => {
  await withEnv(JIRA, () =>
    withFetch(
      () =>
        new Response(Buffer.from([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
      async () => {
        const { data, contentType } = await jiraRequest({
          method: "GET",
          path: "/rest/api/3/attachment/content/10000",
          responseType: "binary",
        });
        assert.equal(data, Buffer.from([1, 2, 3]).toString("base64"));
        assert.equal(contentType, "application/octet-stream");
      },
    ),
  );
});
