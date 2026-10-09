// M-2 — error contract v2 (B3): every failed tool result is a flat
// { error, code, source, status?, hint?, detail? } payload with a code from the
// published table, a source that says who must act, and the fix as `hint`;
// resources throw McpError with the same code/source/hint in `data`.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import {
  ERROR_CODES,
  INSTANCE_HTTP_CODE_INFO,
  IntegrationError,
  ServiceNowError,
  errorCodeOf,
  errorCodeTable,
  errorSourceOf,
  instanceHttpCode,
  sourceOfCode,
} from "../build/core/errors.js";
import { errorPayload, fail } from "../build/mcp/result.js";
import { resourceError } from "../build/mcp/resources.js";
import {
  readSecretFile,
  resolveSecretFiles,
} from "../build/core/secret-files.js";
import {
  assertImportSetTable,
  assertPackageAllowed,
  assertTableAllowed,
  assertTableWriteAllowed,
  assertWriteAllowed,
} from "../build/core/policy.js";
import { connectionHint } from "../build/api/doctor.js";
import {
  clearPluginAvailability,
  pluginCall,
  setPluginProbe,
} from "../build/api/plugin.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import { hasAutoInstanceParam, runSpec } from "../build/mcp/define.js";
import { baselineEnv, withEnv } from "./helpers.js";

baselineEnv();

const SOURCES = new Set(["servicenow", "server", "policy"]);
const REQUIRED = [
  "NOT_CONFIGURED",
  "POLICY_DENIED",
  "PLAN_REQUIRED",
  "PLAN_EXPIRED",
  "UNREADABLE",
  "INSTANCE_HTML_RESPONSE",
  "RECIPIENT_NOT_ALLOWED",
  "CREDENTIALS_INCOMPLETE",
  "CANCELLED",
];
const isKnownCode = (code) =>
  code in ERROR_CODES || /^INSTANCE_HTTP_\d{3}$/.test(code);
const parse = (result) => JSON.parse(result.content[0].text);

const sandbox = mkdtempSync(join(tmpdir(), "sn-error-contract-"));
test.after(() => rmSync(sandbox, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// the code table
// ---------------------------------------------------------------------------

test("ERROR_CODES carries every required code with a valid source", () => {
  for (const code of REQUIRED) assert.ok(code in ERROR_CODES, code);
  for (const [code, info] of Object.entries(ERROR_CODES)) {
    assert.match(code, /^[A-Z][A-Z0-9_]+$/, code);
    assert.ok(SOURCES.has(info.source), `${code}: ${info.source}`);
    assert.ok(info.description.length > 10, code);
  }
  assert.equal(ERROR_CODES.POLICY_DENIED.source, "policy");
  assert.equal(ERROR_CODES.INSTANCE_HTML_RESPONSE.source, "servicenow");
  assert.equal(ERROR_CODES.NOT_CONFIGURED.source, "server");
});

test("errorCodeTable adds the INSTANCE_HTTP_<status> family, sorted", () => {
  const table = errorCodeTable();
  assert.deepEqual(table["INSTANCE_HTTP_<status>"], INSTANCE_HTTP_CODE_INFO);
  const keys = Object.keys(table);
  assert.deepEqual(
    keys,
    [...keys].sort((a, b) => a.localeCompare(b)),
  );
  assert.equal(keys.length, Object.keys(ERROR_CODES).length + 1);
  assert.equal(instanceHttpCode(503), "INSTANCE_HTTP_503");
});

test("sourceOfCode: table lookup, INSTANCE_HTTP_ prefix, server default", () => {
  assert.equal(sourceOfCode("POLICY_DENIED"), "policy");
  assert.equal(sourceOfCode("INSTANCE_HTTP_418"), "servicenow");
  assert.equal(sourceOfCode("NOT_A_CODE"), "server");
});

// ---------------------------------------------------------------------------
// code and source derivation
// ---------------------------------------------------------------------------

test("errorCodeOf / errorSourceOf derivation order", () => {
  const own = new ServiceNowError("x", 500, undefined, {
    code: "BUSY",
  });
  assert.equal(errorCodeOf(own), "BUSY");
  assert.equal(errorSourceOf(own), "server");

  const upstream = new ServiceNowError("x", 502, undefined, {
    source: "servicenow",
  });
  assert.equal(errorCodeOf(upstream), "INSTANCE_HTTP_502");
  assert.equal(errorSourceOf(upstream), "servicenow");

  const statusOnly = [
    [400, "INVALID_INPUT"],
    [422, "INVALID_INPUT"],
    [404, "NOT_FOUND"],
    [409, "CONFLICT"],
    [413, "PAYLOAD_TOO_LARGE"],
    [403, "REQUEST_FAILED"],
    [undefined, "REQUEST_FAILED"],
  ];
  for (const [status, code] of statusOnly) {
    assert.equal(errorCodeOf(new IntegrationError("x", status)), code);
  }

  const zod = Object.assign(new Error("bad"), { name: "ZodError", issues: [] });
  assert.equal(errorCodeOf(zod), "INVALID_INPUT");
  assert.equal(errorCodeOf(new TypeError("boom")), "INTERNAL_ERROR");
  assert.equal(errorCodeOf("a string"), "INTERNAL_ERROR");
  assert.equal(errorSourceOf(new TypeError("boom")), "server");

  // An explicit source wins over the code's.
  const overridden = new ServiceNowError("x", undefined, undefined, {
    code: "UNEXPECTED_RESPONSE",
    source: "servicenow",
  });
  assert.equal(errorSourceOf(overridden), "servicenow");
});

test("ARCH-11b: ServiceNowError extends IntegrationError", () => {
  const sn = new ServiceNowError("a");
  const base = new IntegrationError("c");
  assert.ok(sn instanceof IntegrationError);
  assert.equal(sn.name, "ServiceNowError");
  assert.equal(base.name, "IntegrationError");
  assert.equal(errorCodeOf(base), "REQUEST_FAILED");
});

// ---------------------------------------------------------------------------
// the payload
// ---------------------------------------------------------------------------

test("fail() emits the flat v2 payload: error, code, source, status, hint, detail", () => {
  const err = new ServiceNowError(
    "ServiceNow API error (403)",
    403,
    {
      error: { message: "ACL", detail: "no read" },
      status: "failure",
    },
    { source: "servicenow", hint: "Grant a role." },
  );
  const body = parse(fail(err));
  assert.deepEqual(body, {
    error: "ServiceNow API error (403)",
    code: "INSTANCE_HTTP_403",
    source: "servicenow",
    status: 403,
    hint: "Grant a role.",
    detail: { message: "ACL", detail: "no read" },
  });
  assert.equal("snDetail" in body, false);
  assert.equal(fail(err).isError, true);

  // A string with options; optional fields are omitted, not null.
  const plain = parse(
    fail("Nothing to do", { code: "INVALID_INPUT", hint: "Pass a table." }),
  );
  assert.deepEqual(plain, {
    error: "Nothing to do",
    code: "INVALID_INPUT",
    source: "server",
    hint: "Pass a table.",
  });
  assert.deepEqual(parse(fail(new Error("oops"))), {
    error: "oops",
    code: "INTERNAL_ERROR",
    source: "server",
  });
});

test("property: any failure maps to a known code and a valid source", () => {
  const codes = Object.keys(ERROR_CODES);
  const failure = fc.oneof(
    fc.string().map((m) => new Error(m)),
    fc.string(),
    fc
      .record({
        message: fc.string(),
        status: fc.option(fc.integer({ min: 100, max: 599 }), {
          nil: undefined,
        }),
        code: fc.option(fc.constantFrom(...codes), { nil: undefined }),
        source: fc.option(fc.constantFrom(...SOURCES), { nil: undefined }),
        hint: fc.option(fc.string(), { nil: undefined }),
      })
      .map(
        ({ message, status, code, source, hint }) =>
          new ServiceNowError(message, status, undefined, {
            code,
            source,
            hint,
          }),
      ),
  );
  fc.assert(
    fc.property(failure, (error) => {
      const payload = errorPayload(error);
      assert.equal(typeof payload.error, "string");
      assert.ok(isKnownCode(payload.code), payload.code);
      assert.ok(SOURCES.has(payload.source), payload.source);
      const body = parse(fail(error));
      assert.equal(body.code, payload.code);
      assert.equal(body.source, payload.source);
    }),
  );
});

// ---------------------------------------------------------------------------
// codes raised at the edges
// ---------------------------------------------------------------------------

test("secret files: an unreadable or empty file is UNREADABLE with a hint; a conflict is NOT_CONFIGURED", () => {
  const missing = join(sandbox, "absent.txt");
  assert.throws(
    () => readSecretFile("SN_PASSWORD_FILE", missing),
    (err) => {
      assert.ok(err instanceof ServiceNowError);
      assert.equal(err.code, "UNREADABLE");
      assert.match(err.hint, /SN_PASSWORD_FILE/);
      assert.equal(err.cause?.code, "ENOENT");
      return true;
    },
  );
  const empty = join(sandbox, "empty.txt");
  writeFileSync(empty, "\n");
  assert.throws(
    () => readSecretFile("SN_PASSWORD_FILE", empty),
    (err) => err.code === "UNREADABLE" && err.hint.includes(empty),
  );
  const full = join(sandbox, "full.txt");
  writeFileSync(full, "pw\n");
  assert.throws(
    () => resolveSecretFiles({ SN_PASSWORD: "x", SN_PASSWORD_FILE: full }),
    (err) =>
      err.code === "NOT_CONFIGURED" &&
      /SN_PASSWORD_FILE/.test(err.hint) &&
      errorSourceOf(err) === "server",
  );
});

test("policy denials carry POLICY_DENIED, source policy and the setting to change as hint", async () => {
  const denied = (fn) => {
    try {
      fn();
    } catch (err) {
      return errorPayload(err);
    }
    assert.fail("expected a policy denial");
  };
  await withEnv({ SN_TABLES_DENY: "sys_user,u_secret_*" }, () => {
    const exact = denied(() => assertTableAllowed("sys_user"));
    assert.equal(exact.code, "POLICY_DENIED");
    assert.equal(exact.source, "policy");
    assert.equal(exact.status, 403);
    assert.match(exact.hint, /Remove "sys_user" from SN_TABLES_DENY/);
    const pattern = denied(() => assertTableAllowed("u_secret_x"));
    assert.match(pattern.hint, /Narrow the SN_TABLES_DENY/);
  });
  await withEnv({ SN_TABLES_ALLOW: "incident" }, () => {
    const outside = denied(() => assertTableAllowed("problem"));
    assert.match(outside.hint, /Add "problem" to SN_TABLES_ALLOW/);
  });
  await withEnv({ SN_PROTECTED_TABLES_WRITE: "deny" }, () => {
    const prot = denied(() => assertTableWriteAllowed("sys_user_has_role"));
    assert.equal(prot.code, "POLICY_DENIED");
    assert.match(prot.hint, /SN_PROTECTED_TABLES_WRITE=allow/);
  });
  await withEnv({ SN_READONLY: "true" }, () => {
    const ro = denied(() => assertWriteAllowed("create_record"));
    assert.equal(ro.code, "POLICY_DENIED");
    assert.equal(ro.source, "policy");
    assert.match(ro.hint, /Unset SN_READONLY/);
  });
  await withEnv({ SN_IMPORT_SET_TABLES: "imp_only" }, () => {
    const imp = denied(() => assertImportSetTable("u_other"));
    assert.equal(imp.code, "POLICY_DENIED");
    assert.match(imp.hint, /SN_IMPORT_SET_TABLES/);
  });
  await withEnv({ SN_PACKAGES_DENY: "email" }, () => {
    const pkg = denied(() => assertPackageAllowed("email"));
    assert.equal(pkg.code, "POLICY_DENIED");
    assert.match(pkg.hint, /SN_PACKAGES_DENY/);
  });
});

test("doctor: connectionHint names the fix per status", () => {
  const config = { configured: true, auth: "basic", missing: [] };
  assert.equal(connectionHint({ ok: true, status: 200 }, config), undefined);
  assert.match(
    connectionHint({ ok: false, status: 401 }, config),
    /servicenow_set_credentials/,
  );
  assert.match(
    connectionHint({ ok: false, status: 403 }, config),
    /snc_platform_rest_api_access/,
  );
  assert.match(
    connectionHint({ ok: false, status: null }, config),
    /HTTPS_PROXY/,
  );
  assert.equal(connectionHint({ ok: false, status: 500 }, config), undefined);
});

test("pluginCall keeps the upstream code, hint and source; a cached 404 is INSTANCE_HTTP_404", async () => {
  clearPluginAvailability();
  const previous = setPluginProbe(async () => undefined);
  try {
    const upstream = new ServiceNowError(
      "ServiceNow API error (404)",
      404,
      {
        error: { message: "Requested URI does not represent any resource" },
      },
      { source: "servicenow", hint: "Activate the plugin." },
    );
    await assert.rejects(
      pluginCall("Knowledge", async () => {
        throw upstream;
      }),
      (err) => {
        const body = errorPayload(err);
        assert.equal(body.code, "INSTANCE_HTTP_404");
        assert.equal(body.source, "servicenow");
        assert.equal(body.hint, "Activate the plugin.");
        return true;
      },
    );
    await assert.rejects(
      pluginCall("Knowledge", async () => "never"),
      (err) =>
        err.code === "INSTANCE_HTTP_404" &&
        err.source === "servicenow" &&
        /namespace 404 was cached/.test(err.message),
    );
  } finally {
    setPluginProbe(previous);
    clearPluginAvailability();
  }
});

// ---------------------------------------------------------------------------
// resources
// ---------------------------------------------------------------------------

test("resourceError: caller mistakes are InvalidParams, the rest InternalError, data carries the contract", () => {
  const notFound = resourceError(
    "schema",
    new ServiceNowError("gone", 404, undefined, { source: "servicenow" }),
  );
  assert.ok(notFound instanceof McpError);
  assert.equal(notFound.code, ErrorCode.InvalidParams);
  assert.deepEqual(notFound.data, {
    code: "INSTANCE_HTTP_404",
    source: "servicenow",
  });

  const unknown = resourceError(
    "schema",
    new IntegrationError("Unknown connection profile", undefined, undefined, {
      code: "UNKNOWN_PROFILE",
      hint: "See servicenow_list_instances.",
    }),
  );
  assert.equal(unknown.code, ErrorCode.InvalidParams);
  assert.equal(unknown.data.hint, "See servicenow_list_instances.");

  const down = resourceError(
    "tables",
    new ServiceNowError("x", undefined, undefined, { code: "UNREACHABLE" }),
  );
  assert.equal(down.code, ErrorCode.InternalError);
  assert.deepEqual(down.data, { code: "UNREACHABLE", source: "server" });

  const policy = resourceError(
    "schema",
    new ServiceNowError("no", 403, undefined, {
      code: "POLICY_DENIED",
      source: "policy",
    }),
  );
  assert.equal(policy.code, ErrorCode.InternalError);
  assert.equal(policy.data.source, "policy");

  const passthrough = new McpError(ErrorCode.InvalidParams, "already");
  assert.equal(resourceError("docs", passthrough), passthrough);
});

// ---------------------------------------------------------------------------
// the tool boundary, across every tool
// ---------------------------------------------------------------------------

test("sweep: every tool with the auto `instance` parameter refuses an unknown profile with UNKNOWN_PROFILE", async () => {
  const swept = ALL_TOOLS.filter(hasAutoInstanceParam);
  assert.ok(swept.length > 50, `swept ${swept.length}`);
  for (const spec of swept) {
    const result = await runSpec(spec, { instance: "nope-m2-sweep" });
    assert.equal(result.isError, true, spec.name);
    const body = parse(result);
    assert.equal(body.code, "UNKNOWN_PROFILE", spec.name);
    assert.equal(body.source, "server", spec.name);
    assert.match(body.hint, /servicenow_list_instances/, spec.name);
    assert.equal(typeof body.error, "string", spec.name);
  }
});
