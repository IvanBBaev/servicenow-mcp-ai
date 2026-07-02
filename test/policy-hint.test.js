// UX review §6 / §11: two discoverability affordances.
//  (A) Every policy-denial message ends with a pointer to servicenow_get_status
//      so a model/human knows where to inspect the active policy.
//  (B) SN_TOOL_PACKAGES accepts the named presets reader / developer / admin
//      (on top of the existing core / all profiles and explicit lists).
import test from "node:test";
import assert from "node:assert/strict";

import {
  assertTableAllowed,
  assertWriteAllowed,
  assertPackageAllowed,
  assertPackageWriteAllowed,
} from "../build/core/policy.js";
import { ServiceNowError } from "../build/core/errors.js";
import { resolveEnabledPackages, ALL_PACKAGES } from "../build/mcp/registry.js";
import { baselineEnv, withEnv } from "./helpers.js";

baselineEnv();

const HINT = "Run servicenow_get_status to see the active policy.";

// --- Task A: the discoverability hint on every denial site ------------------

test("SN_TABLES_DENY denial points at servicenow_get_status", async () => {
  await withEnv({ SN_TABLES_DENY: "sys_user" }, () => {
    assert.throws(
      () => assertTableAllowed("sys_user"),
      (err) =>
        err instanceof ServiceNowError &&
        err.status === 403 &&
        /SN_TABLES_DENY/.test(err.message) &&
        err.message.includes(HINT),
    );
  });
});

test("SN_TABLES_ALLOW denial points at servicenow_get_status", async () => {
  await withEnv({ SN_TABLES_ALLOW: "incident" }, () => {
    assert.throws(
      () => assertTableAllowed("sys_user"),
      (err) =>
        err instanceof ServiceNowError &&
        err.status === 403 &&
        /SN_TABLES_ALLOW/.test(err.message) &&
        err.message.includes(HINT),
    );
  });
});

test("SN_READONLY denial points at servicenow_get_status", async () => {
  await withEnv({ SN_READONLY: "true" }, () => {
    assert.throws(
      () => assertWriteAllowed("delete_record"),
      (err) =>
        err instanceof ServiceNowError &&
        err.status === 403 &&
        /SN_READONLY/.test(err.message) &&
        err.message.includes(HINT),
    );
  });
});

test("SN_PACKAGES_DENY denial points at servicenow_get_status", async () => {
  await withEnv({ SN_PACKAGES_DENY: "email" }, () => {
    assert.throws(
      () => assertPackageAllowed("email"),
      (err) =>
        err instanceof ServiceNowError &&
        err.status === 403 &&
        /SN_PACKAGES_DENY/.test(err.message) &&
        err.message.includes(HINT),
    );
  });
});

test("SN_PACKAGES_READONLY denial points at servicenow_get_status", async () => {
  await withEnv({ SN_PACKAGES_READONLY: "catalog" }, () => {
    assert.throws(
      () => assertPackageWriteAllowed("catalog", "order_item"),
      (err) =>
        err instanceof ServiceNowError &&
        err.status === 403 &&
        /SN_PACKAGES_READONLY/.test(err.message) &&
        err.message.includes(HINT),
    );
  });
});

test("the hint is appended with exactly one leading space", async () => {
  // Guards the join: the sentence must not run into the previous word.
  await withEnv({ SN_TABLES_DENY: "sys_user" }, () => {
    assert.throws(
      () => assertTableAllowed("sys_user"),
      (err) => err.message.endsWith(`SN_TABLES_DENY. ${HINT}`),
    );
  });
});

// --- Task B: the named tool-package presets ---------------------------------

test("the reader preset is the read-first surface", () => {
  const enabled = resolveEnabledPackages(["reader"]);
  assert.deepEqual([...enabled].sort(), ["aggregate", "schema", "table"]);
});

test("the developer preset is the reader set plus the build packages", () => {
  const enabled = resolveEnabledPackages(["developer"]);
  assert.deepEqual([...enabled].sort(), [
    "aggregate",
    "codecheck",
    "docs",
    "flows",
    "schema",
    "scripts",
    "table",
  ]);
});

test("the admin preset is equivalent to the all profile", () => {
  const enabled = resolveEnabledPackages(["admin"]);
  assert.deepEqual([...enabled].sort(), [...ALL_PACKAGES].sort());
});

test("a preset combines with explicit packages", () => {
  const enabled = resolveEnabledPackages(["reader", "batch"]);
  assert.deepEqual([...enabled].sort(), [
    "aggregate",
    "batch",
    "schema",
    "table",
  ]);
});

test("an explicit comma-list still resolves without any preset", () => {
  const enabled = resolveEnabledPackages(["table", "email"]);
  assert.deepEqual([...enabled].sort(), ["email", "table"]);
});
