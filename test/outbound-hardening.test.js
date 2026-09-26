// H-6 — outbound hardening: SSRF and exfiltration vectors. Redirects are
// never followed, response bodies are capped, the host guard keeps internal
// targets closed behind suffix allow-list entries, TLS-off is surfaced, the
// OAuth loopback listener ignores stray requests, uploads and local docs are
// bounded and sanitised, and send_email only reaches allowed recipients.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { snRequest } from "../build/core/http.js";
import {
  isRedirectStatus,
  readBodyBytes,
  readJsonBody,
  resetBreakers,
} from "../build/core/http-util.js";
import { jiraRequest } from "../build/core/jira/http.js";
import { resolveHost, _isBlockedHost } from "../build/core/host.js";
import {
  warnIfTlsVerifyOff,
  TLS_VERIFY_OFF_WARNING,
} from "../build/core/dispatcher.js";
import { httpStatusPayload } from "../build/mcp/status.js";
import { setLogSink } from "../build/core/logging.js";
import { parseRedirect, runOAuthLogin } from "../build/core/oauth-login.js";
import { invalidateTokens } from "../build/core/auth.js";
import {
  estimateDecodedBytes,
  prepareUpload,
  sanitizeFileName,
  uploadAttachment,
} from "../build/api/attachment.js";
import { specs as attachmentSpecs } from "../build/tools/attachment.js";
import { specs as emailSpecs } from "../build/tools/email.js";
import { docsRead, docsSearch, docsWrite } from "../build/api/docs.js";
import { sendEmail, assertRecipientsAllowed } from "../build/api/email.js";
import { email, recipients } from "../build/mcp/define.js";
import { ServiceNowError, JiraError } from "../build/core/errors.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
  realFetch,
} from "./helpers.js";

baselineEnv();

const CLEAN = {
  SN_ALLOWED_HOSTS: undefined,
  SN_TLS_REJECT_UNAUTHORIZED: undefined,
  SN_MAX_BODY_BYTES: undefined,
  SN_MAX_UPLOAD_BYTES: undefined,
  SN_UPLOAD_MIME_ALLOW: undefined,
  SN_DOCS_MAX_FILE_BYTES: undefined,
  SN_EMAIL_ALLOWED_DOMAINS: undefined,
  SN_READONLY: undefined,
};
for (const key of Object.keys(CLEAN)) delete process.env[key];

const hasCode = (code) => (err) =>
  err instanceof ServiceNowError && err.code === code;

/** A streamed body with no Content-Length, delivered in `chunks` pieces. */
function streamResponse(totalBytes, chunks = 4, status = 200) {
  const piece = Math.ceil(totalBytes / chunks);
  let sent = 0;
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const n = Math.min(piece, totalBytes - sent);
      controller.enqueue(new Uint8Array(n).fill(0x61));
      sent += n;
    },
  });
  const res = new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
  return { res, pulls: () => pulls };
}

// --- redirects (SEC-19) -------------------------------------------------------

test("a 302 is not followed: REDIRECT_BLOCKED names the target host", async () => {
  resetBreakers();
  await withEnv(CLEAN, () =>
    withFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example:8443/steal?x=1" },
        }),
      async (calls) => {
        await assert.rejects(
          snRequest({ method: "GET", path: "/api/now/table/incident" }),
          (err) =>
            hasCode("REDIRECT_BLOCKED")(err) &&
            err.status === 302 &&
            /evil\.example:8443/.test(err.message) &&
            typeof err.hint === "string",
        );
        assert.equal(calls.length, 1, "the redirect target is never fetched");
        assert.equal(calls[0].init.redirect, "manual");
      },
    ),
  );
});

test("every redirect status is refused, with or without a Location", async () => {
  for (const status of [301, 303, 307, 308]) {
    assert.equal(isRedirectStatus(status), true);
  }
  assert.equal(isRedirectStatus(304), false);
  resetBreakers();
  await withEnv(CLEAN, () =>
    withFetch(
      (_url, _init, n) =>
        n === 1
          ? new Response(null, { status: 307 })
          : new Response(null, {
              status: 308,
              headers: { location: "http://[bad" },
            }),
      async () => {
        await assert.rejects(
          snRequest({ method: "POST", path: "/api/now/table/incident" }),
          (err) =>
            hasCode("REDIRECT_BLOCKED")(err) && /no Location/.test(err.message),
        );
        await assert.rejects(
          snRequest({ method: "GET", path: "/api/now/table/incident" }),
          (err) =>
            hasCode("REDIRECT_BLOCKED")(err) &&
            /unparseable Location/.test(err.message),
        );
      },
    ),
  );
});

test("a relative redirect resolves against the instance host", async () => {
  resetBreakers();
  await withEnv(CLEAN, () =>
    withFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "/login.do" },
        }),
      async () => {
        await assert.rejects(
          snRequest({ method: "GET", path: "/api/now/table/incident" }),
          (err) =>
            hasCode("REDIRECT_BLOCKED")(err) &&
            /dev00000\.service-now\.com/.test(err.message),
        );
      },
    ),
  );
});

test("the Jira client refuses redirects with a JiraError", async () => {
  resetBreakers();
  await withEnv(
    {
      ...CLEAN,
      JIRA_SITE: "mycompany",
      JIRA_EMAIL: "a@b.c",
      JIRA_API_TOKEN: "tok",
    },
    () =>
      withFetch(
        () =>
          new Response(null, {
            status: 301,
            headers: { location: "https://attacker.example/" },
          }),
        async () => {
          await assert.rejects(
            jiraRequest({ method: "GET", path: "/rest/api/3/myself" }),
            (err) =>
              err instanceof JiraError &&
              err.code === "REDIRECT_BLOCKED" &&
              /attacker\.example/.test(err.message),
          );
        },
      ),
  );
});

// --- body cap (SN_MAX_BODY_BYTES) -------------------------------------------

test("a declared Content-Length over the cap is refused before reading", async () => {
  resetBreakers();
  await withEnv({ ...CLEAN, SN_MAX_BODY_BYTES: "100" }, () =>
    withFetch(
      () =>
        new Response("x".repeat(500), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": "500",
          },
        }),
      async () => {
        await assert.rejects(
          snRequest({ method: "GET", path: "/api/now/table/incident" }),
          (err) =>
            hasCode("RESPONSE_TOO_LARGE")(err) &&
            /declares 500 bytes/.test(err.message),
        );
      },
    ),
  );
});

test("a streamed body without Content-Length stops at the cap", async () => {
  resetBreakers();
  await withEnv({ ...CLEAN, SN_MAX_BODY_BYTES: "1000" }, async () => {
    const big = streamResponse(1_000_000, 1000);
    await withFetch(
      () => big.res,
      async () => {
        await assert.rejects(
          snRequest({ method: "GET", path: "/api/now/table/incident" }),
          hasCode("RESPONSE_TOO_LARGE"),
        );
      },
    );
    assert.ok(big.pulls() < 10, "the stream was cancelled early");

    const bin = streamResponse(5000, 5);
    await withFetch(
      () => bin.res,
      async () => {
        await assert.rejects(
          snRequest({
            method: "GET",
            path: "/api/now/attachment/a/file",
            responseType: "binary",
          }),
          hasCode("RESPONSE_TOO_LARGE"),
        );
      },
    );
  });
});

test("a body under the cap is returned intact (JSON and binary)", async () => {
  resetBreakers();
  await withEnv({ ...CLEAN, SN_MAX_BODY_BYTES: "4096" }, async () => {
    await withFetch(
      () => jsonResponse(200, { result: [{ n: 1 }] }),
      async () => {
        const { data } = await snRequest({
          method: "GET",
          path: "/api/now/table/incident",
        });
        assert.deepEqual(data, { result: [{ n: 1 }] });
      },
    );
    await withFetch(
      () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      async () => {
        const { data } = await snRequest({
          method: "GET",
          path: "/api/now/attachment/a/file",
          responseType: "binary",
        });
        assert.equal(data, Buffer.from([1, 2, 3]).toString("base64"));
      },
    );
  });
});

test("an oversized error body is excerpted, never buffered whole", async () => {
  resetBreakers();
  await withEnv(CLEAN, async () => {
    const big = streamResponse(10_000_000, 10_000, 500);
    await withFetch(
      () => big.res,
      async () => {
        await assert.rejects(
          snRequest({ method: "GET", path: "/api/now/table/incident" }),
          (err) => err instanceof ServiceNowError && err.status === 500,
        );
      },
    );
    assert.ok(big.pulls() < 100, "only a bounded prefix was read");
  });
});

test("the Jira client and the body readers honour the cap", async () => {
  resetBreakers();
  await withEnv(
    {
      ...CLEAN,
      SN_MAX_BODY_BYTES: "50",
      JIRA_SITE: "mycompany",
      JIRA_EMAIL: "a@b.c",
      JIRA_API_TOKEN: "tok",
    },
    async () => {
      await withFetch(
        () => jsonResponse(200, { big: "y".repeat(200) }),
        async () => {
          await assert.rejects(
            jiraRequest({ method: "GET", path: "/rest/api/3/myself" }),
            (err) =>
              err instanceof JiraError && err.code === "RESPONSE_TOO_LARGE",
          );
          await assert.rejects(
            jiraRequest({
              method: "GET",
              path: "/rest/api/3/attachment/content/1",
              responseType: "binary",
            }),
            (err) =>
              err instanceof JiraError && err.code === "RESPONSE_TOO_LARGE",
          );
        },
      );
      // Default context (no makeError) raises a ServiceNowError.
      await assert.rejects(
        readJsonBody(new Response("z".repeat(80))),
        hasCode("RESPONSE_TOO_LARGE"),
      );
      assert.deepEqual(await readJsonBody(new Response("")), {});
      assert.deepEqual(await readJsonBody(new Response("not json")), {
        raw: "not json",
      });
      const exact = await readBodyBytes(new Response("abc"), {
        system: "T",
        safeUrl: "u",
        limit: 3,
      });
      assert.equal(exact.toString(), "abc");
      // A body-less stand-in is read through arrayBuffer().
      const standIn = {
        status: 200,
        body: null,
        arrayBuffer: async () => new Uint8Array(10).buffer,
      };
      await assert.rejects(
        readBodyBytes(standIn, { system: "T", safeUrl: "u", limit: 5 }),
        hasCode("RESPONSE_TOO_LARGE"),
      );
      const small = { ...standIn, arrayBuffer: async () => new ArrayBuffer(2) };
      assert.equal(
        (await readBodyBytes(small, { system: "T", safeUrl: "u", limit: 5 }))
          .length,
        2,
      );
    },
  );
});

test("the OAuth token endpoint is covered by the redirect guard", async () => {
  resetBreakers();
  await withEnv(
    {
      ...CLEAN,
      SN_AUTH: "oauth",
      SN_OAUTH_CLIENT_ID: "cid",
      SN_OAUTH_CLIENT_SECRET: "sec",
    },
    () =>
      withFetch(
        () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://phish.example/oauth_token.do" },
          }),
        async (calls) => {
          invalidateTokens();
          await assert.rejects(
            snRequest({ method: "GET", path: "/api/now/table/incident" }),
            (err) =>
              hasCode("REDIRECT_BLOCKED")(err) &&
              /phish\.example/.test(err.message),
          );
          assert.equal(calls.length, 1);
          invalidateTokens();
        },
      ),
  );
});

// --- host guard (SEC-18) ------------------------------------------------------

test("isBlockedHost covers IPv4 and IPv6 internal ranges", () => {
  const blocked = [
    "localhost",
    "a.localhost",
    "printer.local",
    "metadata.google.internal",
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "::1",
    "[::1]",
    "::",
    "fe80::1",
    "febf::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "::127.0.0.1",
  ];
  for (const h of blocked) assert.equal(_isBlockedHost(h), true, h);
  const open = [
    "dev1.service-now.com",
    "fcbank.com",
    "fd.example.com",
    "2001:db8::1",
    "::ffff:8.8.8.8",
    "::ffff:808:808",
    "8.8.8.8",
    "172.32.0.1",
    "fec0::1",
  ];
  for (const h of open) assert.equal(_isBlockedHost(h), false, h);
});

test("a suffix allow-list entry never opens an internal host", async () => {
  await withEnv({ ...CLEAN, SN_ALLOWED_HOSTS: "internal,local" }, () => {
    assert.throws(
      () => resolveHost("sn.internal"),
      /internal\/loopback host "sn\.internal".*exactly/,
    );
    assert.throws(() => resolveHost("printer.local"), /internal\/loopback/);
  });
  await withEnv({ ...CLEAN, SN_ALLOWED_HOSTS: "com" }, () => {
    assert.equal(resolveHost("dev1.example.com"), "dev1.example.com");
  });
});

test("an exact allow-list entry is a deliberate opt-in to an internal host", async () => {
  await withEnv(
    { ...CLEAN, SN_ALLOWED_HOSTS: "sn.internal,127.0.0.1:8443,[::1]" },
    () => {
      assert.equal(resolveHost("sn.internal"), "sn.internal");
      assert.equal(resolveHost("127.0.0.1:8443"), "127.0.0.1:8443");
      assert.equal(resolveHost("[::1]"), "[::1]");
      // The same address on another port is not the listed entry.
      assert.throws(() => resolveHost("127.0.0.1"), /not permitted/);
      assert.throws(() => resolveHost("[::2]"), /not permitted/);
    },
  );
});

test("IPv6 literals stay refused without an allow-list", async () => {
  await withEnv(CLEAN, () => {
    for (const v of [
      "[::1]",
      "[fe80::1]",
      "[::ffff:127.0.0.1]",
      "[2001:db8::1]",
    ])
      assert.throws(() => resolveHost(v), /IPv6 literal/, v);
    assert.throws(() => resolveHost("169.254.169.254"), /internal\/loopback/);
  });
});

// --- TLS verification off (SEC-16) ---------------------------------------------

test("TLS verification off warns once at startup and shows in status", async () => {
  const seen = [];
  setLogSink((level, message) => {
    if (level === "warn") seen.push(message);
  });
  try {
    freshRuntime();
    await withEnv({ ...CLEAN, SN_TLS_REJECT_UNAUTHORIZED: "false" }, () => {
      assert.equal(warnIfTlsVerifyOff(), true);
      assert.equal(warnIfTlsVerifyOff(), true);
      const http = httpStatusPayload("dev00000");
      assert.equal(http.tls.verify, "off");
      assert.deepEqual(http.warnings, [TLS_VERIFY_OFF_WARNING]);
    });
    assert.equal(
      seen.filter((m) => m === TLS_VERIFY_OFF_WARNING).length,
      1,
      "logged exactly once",
    );
    await withEnv(CLEAN, () => {
      assert.equal(warnIfTlsVerifyOff(), false);
      assert.deepEqual(httpStatusPayload("dev00000").warnings, []);
    });
  } finally {
    setLogSink(null);
    freshRuntime();
  }
});

// --- OAuth loopback callback (SEC-17) --------------------------------------------

test("parseRedirect ignores other paths and foreign state", () => {
  assert.deepEqual(
    parseRedirect("/callback?code=c&state=s", "s", "/callback"),
    {
      code: "c",
    },
  );
  const favicon = parseRedirect("/favicon.ico", "s", "/callback");
  assert.equal(favicon.ignored, true);
  assert.match(favicon.error, /unexpected path/);
  const forged = parseRedirect("/callback?code=evil&state=x", "s", "/callback");
  assert.equal(forged.ignored, true);
  assert.equal(forged.code, undefined);
  // A forged error cannot abort the login either — state is checked first.
  const forgedError = parseRedirect(
    "/callback?error=access_denied&state=x",
    "s",
    "/callback",
  );
  assert.equal(forgedError.ignored, true);
  const denied = parseRedirect(
    "/callback?error=access_denied&state=s",
    "s",
    "/callback",
  );
  assert.equal(denied.ignored, undefined);
  assert.equal(denied.error, "access_denied");
});

const freePort = () =>
  new Promise((res) => {
    const s = createServer();
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

test("the loopback listener survives stray and forged requests", async () => {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "sn-h6-oauth-"));
  try {
    await withEnv(
      {
        ...CLEAN,
        SN_INSTANCE: "dev00000.service-now.com",
        SN_OAUTH_CLIENT_ID: "cid",
        SN_OAUTH_CLIENT_SECRET: "sec",
        SN_OAUTH_REDIRECT_URI: `http://localhost:${port}/callback`,
        SN_ENV_FILE: join(dir, ".env"),
        SN_ACTIVE_PROFILE: "default",
      },
      async () => {
        globalThis.fetch = async () =>
          jsonResponse(200, { access_token: "at", refresh_token: "rt-h6" });
        try {
          let authUrl;
          const p = runOAuthLogin({
            open: false,
            onAuthUrl: (u) => (authUrl = u),
          });
          for (let i = 0; i < 300 && !authUrl; i++) {
            await new Promise((r) => setTimeout(r, 10));
          }
          const state = new URL(authUrl).searchParams.get("state");
          const base = `http://localhost:${port}`;
          const stray = await realFetch(`${base}/favicon.ico`);
          assert.equal(stray.status, 404);
          await stray.text();
          const forged = await realFetch(
            `${base}/callback?code=evil&state=not-${state}`,
          );
          assert.equal(forged.status, 400);
          await forged.text();
          const good = await realFetch(
            `${base}/callback?code=real&state=${state}`,
          );
          assert.equal(good.status, 200);
          await good.text();
          await p;
          assert.equal(process.env.SN_OAUTH_REFRESH_TOKEN, "rt-h6");
        } finally {
          globalThis.fetch = realFetch;
          delete process.env.SN_OAUTH_REFRESH_TOKEN;
          delete process.env.SN_OAUTH_GRANT;
          delete process.env.SN_AUTH;
          invalidateTokens();
        }
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- attachment upload (GAP L2-09) ------------------------------------------------

test("an 11 MiB upload is refused before decoding or sending", async () => {
  const b64 = Buffer.alloc(11 * 1024 * 1024).toString("base64");
  await withEnv(CLEAN, () =>
    withFetch(
      () => {
        throw new Error("must not upload");
      },
      async (calls) => {
        await assert.rejects(
          uploadAttachment({
            table: "incident",
            sysId: "r1",
            fileName: "big.bin",
            contentBase64: b64,
          }),
          hasCode("PAYLOAD_TOO_LARGE"),
        );
        assert.equal(calls.length, 0);
      },
    ),
  );
});

test("estimateDecodedBytes matches the decoded size", () => {
  for (const n of [0, 1, 2, 3, 4, 5, 100]) {
    const b64 = Buffer.alloc(n).toString("base64");
    assert.equal(estimateDecodedBytes(b64), n, `n=${n}`);
    assert.equal(estimateDecodedBytes(b64.replace(/(.{2})/g, "$1\n")), n);
  }
});

test("the upload file name is reduced to a safe leaf name", async () => {
  assert.equal(sanitizeFileName("../../x.txt"), "x.txt");
  assert.equal(sanitizeFileName("..\\..\\win.ini"), "win.ini");
  assert.equal(sanitizeFileName("a\u0000b\r\n.txt"), "ab.txt");
  assert.equal(sanitizeFileName("evil\u202Etxt.exe"), "eviltxt.exe");
  const long = sanitizeFileName(`${"é".repeat(300)}.pdf`);
  assert.ok(Buffer.byteLength(long, "utf8") <= 255);
  assert.ok(long.endsWith(".pdf"));
  assert.ok(!long.includes("\uFFFD"));
  assert.equal(Buffer.byteLength(sanitizeFileName("a".repeat(400))), 255);
  for (const bad of ["", "dir/", "..", "\u0001\u0002"]) {
    assert.throws(() => sanitizeFileName(bad), /empty/, JSON.stringify(bad));
  }
  await withEnv(CLEAN, () =>
    withFetch(
      () => jsonResponse(201, { result: { sys_id: "a1" } }),
      async (calls) => {
        await uploadAttachment({
          table: "incident",
          sysId: "r1",
          fileName: "../../x.txt",
          contentBase64: "QUJD",
        });
        assert.equal(
          new URL(calls[0].url).searchParams.get("file_name"),
          "x.txt",
        );
      },
    ),
  );
});

test("SN_UPLOAD_MIME_ALLOW limits upload content types", async () => {
  await withEnv(
    { ...CLEAN, SN_UPLOAD_MIME_ALLOW: "image/*, application/pdf" },
    () => {
      const ok = prepareUpload({
        fileName: "a.png",
        contentBase64: "QUJD",
        contentType: "IMAGE/PNG",
      });
      assert.equal(ok.bytes.length, 3);
      prepareUpload({
        fileName: "a.pdf",
        contentBase64: "QUJD",
        contentType: "application/pdf; charset=binary",
      });
      assert.throws(
        () =>
          prepareUpload({
            fileName: "a.html",
            contentBase64: "QUJD",
            contentType: "text/html",
          }),
        hasCode("MIME_NOT_ALLOWED"),
      );
      // The data-URL media type is the effective type when none is given.
      assert.throws(
        () =>
          prepareUpload({
            fileName: "a.svg",
            contentBase64: "data:text/html;base64,QUJD",
          }),
        hasCode("MIME_NOT_ALLOWED"),
      );
      // octet-stream default is not implicitly allowed.
      assert.throws(
        () => prepareUpload({ fileName: "a", contentBase64: "QUJD" }),
        hasCode("MIME_NOT_ALLOWED"),
      );
    },
  );
});

test("the upload plan preview shows the validated envelope, never the payload", async () => {
  const tool = attachmentSpecs.find(
    (s) => s.name === "servicenow_upload_attachment",
  );
  await withEnv({ ...CLEAN, SN_MAX_UPLOAD_BYTES: "2" }, async () => {
    const res = await tool.handler({
      table: "incident",
      sys_id: "r1",
      file_name: "../x.txt",
      content_base64: "QQ==",
    });
    const o = JSON.parse(res.content[0].text);
    assert.equal(o.after.file_name, "x.txt");
    assert.equal(o.after.bytes, 1);
    assert.equal(
      o.after.sha256,
      "559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd",
    );
    assert.equal(o.after.content_type, "application/octet-stream");
    assert.equal(res.content[0].text.includes("QQ=="), false);
    await assert.rejects(
      tool.handler({
        table: "incident",
        sys_id: "r1",
        file_name: "x.txt",
        content_base64: "QUJD",
      }),
      hasCode("PAYLOAD_TOO_LARGE"),
    );
  });
});

// --- docs store (GAP L2-10, SEC-24) ------------------------------------------------

test("the docs store rejects Windows device names and ':' streams", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sn-h6-docs-"));
  try {
    await withEnv({ ...CLEAN, SN_DOCS_DIR: dir }, async () => {
      for (const bad of [
        "con.md",
        "CON.md",
        "sub/aux.md",
        "nul",
        "lpt1/x.md",
        "com9.backup.md",
      ]) {
        await assert.rejects(docsWrite(bad, "x"), /reserved Windows/, bad);
      }
      for (const bad of ["a.md:hidden", "c:/x.md", "dir:x/y.md"]) {
        await assert.rejects(docsWrite(bad, "x"), /":"/, bad);
      }
      await assert.rejects(docsRead("prn.md"), /reserved Windows/);
      // Look-alikes are ordinary names.
      await docsWrite("console.md", "ok");
      await docsWrite("com10.md", "ok");
      assert.equal((await docsRead("console.md")).content, "ok");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SN_DOCS_MAX_FILE_BYTES caps writes, truncates reads, skips in search", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sn-h6-docs-"));
  try {
    await withEnv(
      { ...CLEAN, SN_DOCS_DIR: dir, SN_DOCS_MAX_FILE_BYTES: "64" },
      async () => {
        await assert.rejects(
          docsWrite("big.md", "x".repeat(65)),
          (err) => hasCode("PAYLOAD_TOO_LARGE")(err) && err.status === 413,
        );
        assert.equal(existsSync(join(dir, "big.md")), false);
        await docsWrite("small.md", "needle here");
        // A file placed out-of-band (or before the cap was lowered).
        writeFileSync(join(dir, "huge.md"), `needle ${"y".repeat(200)}`);
        const r = await docsRead("huge.md");
        assert.equal(r.truncated, true);
        assert.equal(r.bytes, 207);
        assert.equal(Buffer.byteLength(r.content), 64);
        assert.equal((await docsRead("small.md")).truncated, undefined);
        // A multi-byte character split by the cut is dropped, not mangled.
        writeFileSync(join(dir, "utf.md"), "é".repeat(40));
        assert.equal((await docsRead("utf.md")).content, "é".repeat(32));
        const s = await docsSearch("needle");
        assert.deepEqual(
          s.matches.map((m) => m.path),
          ["small.md"],
        );
        // index.md (maintained by docsWrite) and utf.md are over 64 bytes too.
        assert.deepEqual(
          s.skipped.find((f) => f.path === "huge.md"),
          { path: "huge.md", bytes: 207 },
        );
        assert.ok(s.skipped.every((f) => f.bytes > 64));
      },
    );
    await withEnv({ ...CLEAN, SN_DOCS_DIR: dir }, async () => {
      const s = await docsSearch("needle");
      assert.equal(s.skipped, undefined);
      assert.equal(s.count, 2);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a symlink inside the docs folder cannot escape it (SEC-24)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sn-h6-docs-"));
  const outside = mkdtempSync(join(tmpdir(), "sn-h6-outside-"));
  try {
    writeFileSync(join(outside, "secret.md"), "top secret");
    try {
      symlinkSync(outside, join(dir, "link"), "dir");
      symlinkSync(join(outside, "secret.md"), join(dir, "file.md"), "file");
    } catch {
      t.skip("symlinks are not available here");
      return;
    }
    mkdirSync(join(dir, "real"));
    await withEnv({ ...CLEAN, SN_DOCS_DIR: dir }, async () => {
      await assert.rejects(docsRead("link/secret.md"), /symbolic link/);
      await assert.rejects(docsRead("file.md"), /symbolic link/);
      await assert.rejects(docsWrite("link/new.md", "x"), /symbolic link/);
      await assert.rejects(docsWrite("link/deep/new.md", "x"), /symbolic link/);
      assert.equal(existsSync(join(outside, "new.md")), false);
      assert.equal(
        readFileSync(join(outside, "secret.md"), "utf8"),
        "top secret",
      );
      // Ordinary nested paths still work.
      await docsWrite("real/a/b.md", "fine");
      assert.equal((await docsRead("real/a/b.md")).content, "fine");
      await assert.rejects(docsRead("real/missing.md"), /not found/);
    });
    // A docs folder that does not exist yet has nothing to escape through.
    await withEnv(
      { ...CLEAN, SN_DOCS_DIR: join(dir, "not-yet", "docs") },
      async () => {
        await docsWrite("first.md", "hello");
        assert.equal((await docsRead("first.md")).content, "hello");
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// --- email recipients (SEC-14, GAP L4-06) --------------------------------------------

test("email() and recipients(50) accept only single, bounded addresses", () => {
  assert.equal(email().safeParse("a.b+tag@sub.example.com").success, true);
  for (const bad of [
    "x",
    "a@b",
    "a@b.com,c@d.com",
    "Name <a@b.com>",
    "a b@c.com",
    "a^b@c.com",
    "a=b@c.com",
    "a@-b.com",
    `${"a".repeat(65)}@b.com`,
  ]) {
    assert.equal(email().safeParse(bad).success, false, bad);
  }
  assert.equal(recipients(50).safeParse(["x"]).success, false);
  assert.equal(recipients(50).safeParse([]).success, false);
  const fifty = Array.from({ length: 50 }, (_, i) => `u${i}@x.com`);
  assert.equal(recipients(50).safeParse(fifty).success, true);
  assert.equal(
    recipients(50).safeParse([...fifty, "u50@x.com"]).success,
    false,
  );
  assert.equal(recipients().safeParse(["a@x.com"]).success, true);
  const tool = emailSpecs.find((s) => s.name === "servicenow_send_email");
  assert.ok(tool.input.to.safeParse(["a@x.com"]).success);
  assert.equal(tool.input.to.safeParse(["x"]).success, false);
});

test("SN_EMAIL_ALLOWED_DOMAINS limits to, cc and bcc before any request", async () => {
  await withEnv(
    { ...CLEAN, SN_EMAIL_ALLOWED_DOMAINS: "@corp.example, .partner.example" },
    () =>
      withFetch(
        () => jsonResponse(200, { result: { id: "em1" } }),
        async (calls) => {
          await sendEmail({
            to: ["A@Corp.Example", "b@eu.corp.example"],
            cc: ["c@partner.example"],
            subject: "s",
            body: "b",
          });
          assert.equal(calls.length, 1);
          await assert.rejects(
            sendEmail({
              to: ["a@corp.example"],
              bcc: ["drop@attacker.example"],
              subject: "s",
              body: "secret",
            }),
            (err) =>
              hasCode("RECIPIENT_NOT_ALLOWED")(err) &&
              err.status === 403 &&
              /drop@attacker\.example/.test(err.message),
          );
          await assert.rejects(
            sendEmail({ to: ["a@notcorp.example"], subject: "s", body: "b" }),
            hasCode("RECIPIENT_NOT_ALLOWED"),
          );
          await assert.rejects(
            sendEmail({ to: ["a@x.com,b@y.com"], subject: "s", body: "b" }),
            /Not a single email address/,
          );
          assert.equal(calls.length, 1, "no refused email reached the wire");
        },
      ),
  );
  await withEnv({ ...CLEAN, SN_EMAIL_ALLOWED_DOMAINS: "*" }, () =>
    withFetch(
      () => jsonResponse(200, { result: {} }),
      async (calls) => {
        await assertRecipientsAllowed(["anyone@anywhere.example"]);
        assert.equal(calls.length, 0);
      },
    ),
  );
});

test("without an allow-list only sys_user emails may be addressed", async () => {
  await withEnv(CLEAN, () =>
    withFetch(
      (url, init) => {
        if (init?.method === "GET") {
          const q = new URL(url).searchParams.get("sysparm_query");
          assert.match(url, /\/api\/now\/table\/sys_user\?/);
          assert.equal(q, "emailINalice@corp.example,bob@corp.example");
          return jsonResponse(200, {
            result: [{ email: "Alice@Corp.Example" }, { email: "" }],
          });
        }
        return jsonResponse(200, { result: { id: "em1" } });
      },
      async (calls) => {
        await assert.rejects(
          sendEmail({
            to: ["alice@corp.example"],
            cc: ["bob@corp.example"],
            subject: "s",
            body: "b",
          }),
          (err) =>
            hasCode("RECIPIENT_NOT_ALLOWED")(err) &&
            /bob@corp\.example/.test(err.message) &&
            !/alice/.test(err.message) &&
            /SN_EMAIL_ALLOWED_DOMAINS/.test(err.hint),
        );
        assert.equal(calls.filter((c) => c.init?.method === "POST").length, 0);
      },
    ),
  );
  await withEnv(CLEAN, () =>
    withFetch(
      (_url, init) =>
        init?.method === "GET"
          ? jsonResponse(200, { result: [{ email: "alice@corp.example" }] })
          : jsonResponse(200, { result: { id: "em1" } }),
      async (calls) => {
        const out = await sendEmail({
          to: ["Alice@corp.example"],
          subject: "s",
          body: "b",
        });
        assert.deepEqual(out, { id: "em1" });
        assert.equal(calls.length, 2);
      },
    ),
  );
});

test("a failed directory lookup fails closed", async () => {
  resetBreakers();
  await withEnv(CLEAN, async () => {
    await withFetch(
      () => jsonResponse(500, { error: { message: "boom" } }),
      async (calls) => {
        await assert.rejects(
          sendEmail({ to: ["a@corp.example"], subject: "s", body: "b" }),
          (err) =>
            hasCode("RECIPIENT_NOT_ALLOWED")(err) &&
            /could not verify/i.test(err.message),
        );
        assert.equal(calls.length, 1);
      },
    );
    await withFetch(
      () => jsonResponse(200, { result: "not-a-list" }),
      async () => {
        await assert.rejects(
          sendEmail({ to: ["a@corp.example"], subject: "s", body: "b" }),
          hasCode("RECIPIENT_NOT_ALLOWED"),
        );
      },
    );
  });
  resetBreakers();
});
