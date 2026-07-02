import test from "node:test";
import assert from "node:assert/strict";

import { runDoctor, formatDoctorReport, EXIT } from "../build/api/doctor.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

const okRow = () => jsonResponse(200, { result: [{ sys_id: "1" }] });
const forbidden = () =>
  jsonResponse(403, { error: { message: "ACL restricts" } });
const unauthorized = () =>
  jsonResponse(401, { error: { message: "User Not Authenticated" } });

test("healthy path — configured, reachable, every capability achievable (exit 0)", async () => {
  await withFetch(okRow, async () => {
    const r = await runDoctor();
    assert.equal(r.status, "healthy");
    assert.equal(EXIT[r.status], 0);
    // config stage
    assert.equal(r.config.configured, true);
    assert.equal(r.config.user, "alice");
    assert.deepEqual(r.config.missing, []);
    // connectivity stage
    assert.ok(r.connection);
    assert.equal(r.connection.ok, true);
    assert.equal(r.connection.status, 200);
    // capability stage
    assert.ok(r.capabilities);
    assert.equal(r.capabilities.degraded, false);
    // the report never leaks the password
    const text = formatDoctorReport(r);
    assert.ok(!text.includes("s3cret"));
    assert.match(text, /Healthy/);
    assert.match(text, /Connectivity/);
    assert.match(text, /Capabilities/);
  });
});

test("not configured — no instance/user/password for the active profile (exit 2)", async () => {
  await withEnv(
    { SN_INSTANCE: undefined, SN_USER: undefined, SN_PASSWORD: undefined },
    async () => {
      // No network call should be attempted when nothing is configured.
      await withFetch(
        () => {
          throw new Error("fetch must not be called when unconfigured");
        },
        async () => {
          const r = await runDoctor();
          assert.equal(r.status, "not_configured");
          assert.equal(EXIT[r.status], 2);
          assert.equal(r.config.configured, false);
          assert.deepEqual(r.config.missing, ["instance", "user", "password"]);
          assert.equal(r.connection, undefined);
          assert.equal(r.capabilities, undefined);
          const text = formatDoctorReport(r);
          assert.match(text, /not configured|missing/i);
          assert.ok(text.includes("(not set)"));
        },
      );
    },
  );
});

test("401 on the connectivity probe — degraded, capabilities skipped (exit 1)", async () => {
  await withFetch(unauthorized, async () => {
    const r = await runDoctor();
    assert.equal(r.status, "degraded");
    assert.equal(EXIT[r.status], 1);
    assert.ok(r.connection);
    assert.equal(r.connection.ok, false);
    assert.equal(r.connection.status, 401);
    // The capability preflight must not run once the instance is unreachable.
    assert.equal(r.capabilities, undefined);
    const text = formatDoctorReport(r);
    assert.match(text, /authentication failed \(401\)/);
  });
});

test("reachable but a restricted table degrades a capability (exit 1)", async () => {
  await withFetch(
    (url) =>
      new URL(url).pathname.includes("/table/sys_security_acl")
        ? forbidden()
        : okRow(),
    async () => {
      const r = await runDoctor();
      assert.equal(r.status, "degraded");
      assert.equal(EXIT[r.status], 1);
      assert.equal(r.connection.ok, true);
      assert.ok(r.capabilities);
      assert.equal(r.capabilities.degraded, true);
      assert.equal(r.capabilities.capabilities.acl_audit.achievable, false);
      const text = formatDoctorReport(r);
      assert.match(text, /Degraded/);
      assert.match(text, /acl_audit/);
    },
  );
});

test("403 on the connectivity probe is reported structurally, not thrown", async () => {
  await withFetch(forbidden, async () => {
    const r = await runDoctor();
    assert.equal(r.status, "degraded");
    assert.equal(r.connection.status, 403);
    const text = formatDoctorReport(r);
    assert.match(text, /access forbidden \(403\)/);
  });
});

test("a transport failure during the capability preflight degrades, never crashes", async () => {
  // First call (connectivity probe on sys_user) succeeds; a later table read
  // throws a non-HTTP transport error, which checkCapabilities re-throws.
  await withFetch(
    (url) => {
      if (new URL(url).pathname.endsWith("/table/sys_user")) return okRow();
      throw new TypeError("network down");
    },
    async () => {
      const r = await runDoctor();
      assert.equal(r.status, "degraded");
      assert.equal(EXIT[r.status], 1);
      assert.equal(r.connection.ok, true);
      assert.equal(r.capabilities, undefined);
      assert.match(r.summary, /capability preflight failed/);
    },
  );
});

test("EXIT maps each status onto its documented process code", () => {
  assert.deepEqual(EXIT, { healthy: 0, degraded: 1, not_configured: 2 });
});
