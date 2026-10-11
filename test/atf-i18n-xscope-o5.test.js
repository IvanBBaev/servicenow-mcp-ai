// O-5 — ATF history, translation coverage and cross-scope read the values
// confirmed on a PDI: ATF status choices, the integer status of
// sys_restricted_caller_access, and the checked i18n tables.
import test from "node:test";
import assert from "node:assert/strict";

import { outcomeOf } from "../build/api/atf-history.js";
import { crossScopeReport, rcaStatus } from "../build/api/cross-scope.js";
import { I18N_CAVEAT } from "../build/api/i18n-coverage.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withMetadataFetch,
} from "./helpers.js";

baselineEnv();

const APP_ID = "a".repeat(32);

test("an ATF run that passed with warnings counts as a pass", () => {
  assert.equal(outcomeOf("success_with_warnings"), "pass");
  for (const s of ["pending", "waiting", "running", "paused", "canceled"]) {
    assert.equal(outcomeOf(s), "other", s);
  }
});

test("restricted caller access status names its integer choice", () => {
  assert.equal(rcaStatus("0"), "requested");
  assert.equal(rcaStatus("1"), "denied");
  assert.equal(rcaStatus("2"), "allowed");
  assert.equal(rcaStatus("3"), "invalidated");
  assert.equal(rcaStatus("9"), "9");
  assert.equal(rcaStatus(""), "");
});

test("the i18n caveat keeps only the UIB message-key assumption", () => {
  assert.doesNotMatch(I18N_CAVEAT, /unverified/);
  assert.match(I18N_CAVEAT, /message-key convention/);
});

test("a restricted caller access row reports the status name, not the integer", async () => {
  freshRuntime();
  const rows = {
    sys_restricted_caller_access: [
      {
        "source_scope.scope": "x_third",
        "target_scope.scope": "x_acme",
        source_table: "sys_script_include",
        target_table: "sys_script_include",
        target: "AcmeUtils",
        status: "2",
      },
    ],
  };
  await withMetadataFetch(
    (url) => {
      const m = /\/api\/now\/table\/([^/?]+)/.exec(new URL(url).pathname);
      return jsonResponse(200, { result: (m && rows[m[1]]) ?? [] });
    },
    async () => {
      const r = await crossScopeReport(APP_ID, "x_acme");
      assert.equal(r.restricted.length, 1);
      assert.equal(r.restricted[0].status, "allowed");
      assert.ok(!r.caveats.some((c) => /unverified until O-5/.test(c)));
    },
  );
});
