// SN_COMPAT=2 (owner, 2026-10-14): the 2.x defaults for every compat setting
// left unset; an explicit value always wins.
import test from "node:test";
import assert from "node:assert/strict";

import {
  getBatchUnmapped,
  getDestructiveConfirm,
  getRequestedPackages,
} from "../build/core/settings.js";
import { protectedTablesWrite } from "../build/core/policy.js";
import { legacyToolNames } from "../build/mcp/naming.js";
import { withEnv } from "./helpers.js";

const UNSET = {
  SN_PROTECTED_TABLES_WRITE: undefined,
  SN_DESTRUCTIVE_CONFIRM: undefined,
  SN_BATCH_UNMAPPED: undefined,
  SN_LEGACY_TOOL_NAMES: undefined,
  SN_TOOL_PACKAGES: undefined,
};

const snapshot = () => ({
  protected: protectedTablesWrite(),
  destructive: getDestructiveConfirm(),
  batch: getBatchUnmapped(),
  legacy: legacyToolNames(),
  packages: getRequestedPackages(),
});

test("without SN_COMPAT the 3.0 defaults apply", async () => {
  for (const compat of [undefined, "3"]) {
    await withEnv({ ...UNSET, SN_COMPAT: compat }, () =>
      assert.deepEqual(snapshot(), {
        protected: "confirm",
        destructive: "token",
        batch: "deny",
        legacy: false,
        packages: ["discovery"],
      }),
    );
  }
});

test("SN_COMPAT=2 restores the 2.x defaults", async () => {
  await withEnv({ ...UNSET, SN_COMPAT: "2" }, () =>
    assert.deepEqual(snapshot(), {
      protected: "allow",
      destructive: "off",
      batch: "allow",
      legacy: true,
      packages: ["core"],
    }),
  );
});

test("SN_COMPAT=2: an explicit setting wins", async () => {
  await withEnv(
    {
      SN_COMPAT: "2",
      SN_PROTECTED_TABLES_WRITE: "deny",
      SN_DESTRUCTIVE_CONFIRM: "elicit",
      SN_BATCH_UNMAPPED: "deny",
      SN_LEGACY_TOOL_NAMES: "0",
      SN_TOOL_PACKAGES: "all",
    },
    () =>
      assert.deepEqual(snapshot(), {
        protected: "deny",
        destructive: "elicit",
        batch: "deny",
        legacy: false,
        packages: ["all"],
      }),
  );
});
