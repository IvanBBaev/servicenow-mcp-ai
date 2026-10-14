import test from "node:test";
import assert from "node:assert/strict";

import { resolveEnabledPackages, ALL_PACKAGES } from "../build/mcp/registry.js";
import { getRequestedPackages } from "../build/core/settings.js";

test("the discovery profile expands to the default read tools; core adds attachment (B20)", () => {
  assert.deepEqual([...resolveEnabledPackages(["discovery"])].sort(), [
    "aggregate",
    "schema",
    "table",
  ]);
  assert.deepEqual([...resolveEnabledPackages(["core"])].sort(), [
    "aggregate",
    "attachment",
    "schema",
    "table",
  ]);
});

test("the all profile enables every package", () => {
  const enabled = resolveEnabledPackages(["all"]);
  assert.deepEqual([...enabled].sort(), [...ALL_PACKAGES].sort());
  assert.ok(enabled.has("batch"));
  assert.ok(enabled.has("importset"));
});

test("a single explicit package is enabled on its own", () => {
  const enabled = resolveEnabledPackages(["batch"]);
  assert.deepEqual([...enabled], ["batch"]);
});

test("unknown names are ignored but known ones still apply", () => {
  const enabled = resolveEnabledPackages(["table", "does-not-exist"]);
  assert.deepEqual([...enabled], ["table"]);
});

test("an all-unknown request falls back to the discovery profile", () => {
  const enabled = resolveEnabledPackages(["nonsense"]);
  assert.deepEqual([...enabled].sort(), ["aggregate", "schema", "table"]);
});

test("getRequestedPackages defaults to discovery when unset", () => {
  delete process.env.SN_TOOL_PACKAGES;
  assert.deepEqual(getRequestedPackages(), ["discovery"]);
});

test("getRequestedPackages splits on commas and whitespace", () => {
  process.env.SN_TOOL_PACKAGES = "table,  batch  schema";
  try {
    assert.deepEqual(getRequestedPackages(), ["table", "batch", "schema"]);
  } finally {
    delete process.env.SN_TOOL_PACKAGES;
  }
});

test("getRequestedPackages treats a blank value as discovery", () => {
  process.env.SN_TOOL_PACKAGES = "   ";
  try {
    assert.deepEqual(getRequestedPackages(), ["discovery"]);
  } finally {
    delete process.env.SN_TOOL_PACKAGES;
  }
});
