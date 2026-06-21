import test from "node:test";
import assert from "node:assert/strict";

import { checkCapabilities } from "../build/api/capabilities.js";
import { baselineEnv, withFetch, jsonResponse } from "./helpers.js";

baselineEnv();

const okRow = () => jsonResponse(200, { result: [{ sys_id: "1" }] });
const forbidden = () =>
  jsonResponse(403, { error: { message: "ACL restricts" } });

test("all tables readable → every capability achievable, not degraded", async () => {
  await withFetch(okRow, async () => {
    const r = await checkCapabilities();
    assert.equal(r.degraded, false);
    assert.equal(r.capabilities.schema_reads.achievable, true);
    assert.equal(r.capabilities.script_intelligence.achievable, true);
    assert.equal(r.capabilities.acl_audit.achievable, true);
    assert.ok(r.probed.every((p) => p.readable));
  });
});

test("403 on sys_security_acl → only acl_audit is lost; degraded", async () => {
  await withFetch(
    (url) =>
      new URL(url).pathname.includes("/table/sys_security_acl")
        ? forbidden()
        : okRow(),
    async () => {
      const r = await checkCapabilities();
      assert.equal(r.degraded, true);
      assert.equal(r.capabilities.acl_audit.achievable, false);
      assert.deepEqual(r.capabilities.acl_audit.missing, ["sys_security_acl"]);
      // Script intelligence does not depend on the ACL table.
      assert.equal(r.capabilities.script_intelligence.achievable, true);
      const acl = r.probed.find((p) => p.table === "sys_security_acl");
      assert.equal(acl.readable, false);
      assert.equal(acl.status, 403);
      assert.match(acl.reason, /no read access/);
    },
  );
});

test("403 on sys_script → script_intelligence degraded, names the missing table", async () => {
  await withFetch(
    (url) =>
      new URL(url).pathname.endsWith("/table/sys_script")
        ? forbidden()
        : okRow(),
    async () => {
      const r = await checkCapabilities();
      assert.equal(r.capabilities.script_intelligence.achievable, false);
      assert.ok(
        r.capabilities.script_intelligence.missing.includes("sys_script"),
      );
      assert.equal(r.degraded, true);
    },
  );
});

test("a transport failure (no HTTP status) propagates, not silently swallowed", async () => {
  await withFetch(
    () => {
      throw new TypeError("network down");
    },
    async () => {
      await assert.rejects(checkCapabilities());
    },
  );
});
