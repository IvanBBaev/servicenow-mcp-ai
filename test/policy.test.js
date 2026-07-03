// GA-5: dedicated edge-case coverage for core/policy.ts — list parsing, the
// deny-wins-over-allow rule, read-only truthiness, the per-profile override
// chain (scoped key beats the global, even when set to an empty string) and
// the package-axis guards used by the Batch API.
import test from "node:test";
import assert from "node:assert/strict";

import {
  getAllowedTables,
  getDeniedTables,
  isReadOnly,
  assertTableAllowed,
  assertWriteAllowed,
  assertPackageAllowed,
  assertPackageWriteAllowed,
} from "../build/core/policy.js";
import { ServiceNowError } from "../build/core/errors.js";
import { baselineEnv, withEnv } from "./helpers.js";

baselineEnv();

test("table lists are trimmed, lowercased and empty-entry-free", async () => {
  await withEnv(
    {
      SN_TABLES_ALLOW: " Incident , ,PROBLEM,, change_request ",
      SN_TABLES_DENY: "  SYS_USER  ",
    },
    () => {
      assert.deepEqual(getAllowedTables(), [
        "incident",
        "problem",
        "change_request",
      ]);
      assert.deepEqual(getDeniedTables(), ["sys_user"]);
    },
  );
  // Unset → empty lists, not [""].
  assert.deepEqual(getAllowedTables(), []);
  assert.deepEqual(getDeniedTables(), []);
});

test("assertTableAllowed: no policy admits everything; allowlist restricts", async () => {
  assert.doesNotThrow(() => assertTableAllowed("anything_at_all"));

  await withEnv({ SN_TABLES_ALLOW: "incident,problem" }, () => {
    // Case- and whitespace-insensitive match on the caller's table name.
    assert.doesNotThrow(() => assertTableAllowed(" INCIDENT "));
    assert.throws(
      () => assertTableAllowed("sys_user"),
      (err) =>
        err instanceof ServiceNowError &&
        err.status === 403 &&
        /SN_TABLES_ALLOW/.test(err.message),
    );
  });
});

test("assertTableAllowed: the denylist wins over the allowlist", async () => {
  await withEnv(
    { SN_TABLES_ALLOW: "incident", SN_TABLES_DENY: "incident" },
    () => {
      assert.throws(
        () => assertTableAllowed("incident"),
        (err) =>
          err instanceof ServiceNowError &&
          err.status === 403 &&
          /SN_TABLES_DENY/.test(err.message),
      );
    },
  );
});

test("isReadOnly accepts 1/true/yes/on (any case, padded); rejects the rest", async () => {
  for (const truthy of ["1", "true", "yes", "on", " TRUE ", "Yes"]) {
    await withEnv({ SN_READONLY: truthy }, () => {
      assert.equal(
        isReadOnly(),
        true,
        `expected truthy: ${JSON.stringify(truthy)}`,
      );
    });
  }
  for (const falsy of ["0", "false", "off", "", "  ", "enabled"]) {
    await withEnv({ SN_READONLY: falsy }, () => {
      assert.equal(
        isReadOnly(),
        false,
        `expected falsy: ${JSON.stringify(falsy)}`,
      );
    });
  }
});

test("assertWriteAllowed names the refused operation", async () => {
  assert.doesNotThrow(() => assertWriteAllowed("create_record"));
  await withEnv({ SN_READONLY: "true" }, () => {
    assert.throws(
      () => assertWriteAllowed("delete_record"),
      (err) =>
        err instanceof ServiceNowError &&
        err.status === 403 &&
        /SN_READONLY/.test(err.message) &&
        /delete_record/.test(err.message),
    );
  });
});

test("per-profile policy: the scoped key applies only to the active profile", async () => {
  await withEnv(
    { SN_ACTIVE_PROFILE: "prod", SN_PROFILE_PROD_READONLY: "1" },
    () => {
      assert.equal(isReadOnly(), true);
      // An explicit other profile falls back to the (unset) global key.
      assert.equal(isReadOnly("default"), false);
    },
  );
});

test("per-profile policy: a scoped empty string overrides the global", async () => {
  // The contract is `!== undefined`: setting SN_PROFILE_DEV_READONLY="" (or an
  // empty allowlist) deliberately relaxes a global restriction for one profile.
  await withEnv(
    {
      SN_ACTIVE_PROFILE: "dev",
      SN_READONLY: "true",
      SN_PROFILE_DEV_READONLY: "",
      SN_TABLES_ALLOW: "incident",
      SN_PROFILE_DEV_TABLES_ALLOW: "",
    },
    () => {
      assert.equal(isReadOnly(), false);
      assert.doesNotThrow(() => assertTableAllowed("sys_user"));
    },
  );
});

test("per-profile policy: no scoped key falls back to the global", async () => {
  await withEnv(
    { SN_ACTIVE_PROFILE: "prod", SN_TABLES_DENY: "incident" },
    () => {
      assert.throws(() => assertTableAllowed("incident"), /SN_TABLES_DENY/);
    },
  );
});

test("assertPackageAllowed enforces SN_PACKAGES_DENY", async () => {
  await withEnv({ SN_PACKAGES_DENY: "email, atf" }, () => {
    assert.doesNotThrow(() => assertPackageAllowed("table"));
    assert.throws(
      () => assertPackageAllowed("email"),
      (err) =>
        err instanceof ServiceNowError &&
        err.status === 403 &&
        /SN_PACKAGES_DENY/.test(err.message),
    );
  });
});

test("assertPackageWriteAllowed enforces SN_PACKAGES_READONLY per operation", async () => {
  await withEnv({ SN_PACKAGES_READONLY: "catalog" }, () => {
    assert.doesNotThrow(() =>
      assertPackageWriteAllowed("table", "create_record"),
    );
    assert.throws(
      () => assertPackageWriteAllowed("catalog", "order_item"),
      (err) =>
        err instanceof ServiceNowError &&
        err.status === 403 &&
        /SN_PACKAGES_READONLY/.test(err.message) &&
        /order_item/.test(err.message),
    );
  });
});
