// O-5 — the elevated role names and the S-4 widened artefact tables were
// checked on a PDI. The advice stays informational and the preflight still
// probes verified types only until the owner flips their flags.
import test from "node:test";
import assert from "node:assert/strict";

import { ELEVATED_ROLES } from "../build/api/privilege.js";
import { ARTIFACT_TYPES } from "../build/core/artifacts/registry.js";

test("the elevated roles are the out-of-box names seen on a PDI", () => {
  assert.deepEqual(Object.keys(ELEVATED_ROLES).sort(), [
    "admin",
    "atf_test_admin",
    "catalog_admin",
    "import_admin",
    "knowledge_admin",
    "maint",
    "oauth_admin",
    "security_admin",
    "user_admin",
    "web_service_admin",
  ]);
});

test("the S-4 widened script types keep their PDI-checked tables and fields", () => {
  const byType = Object.fromEntries(
    ARTIFACT_TYPES.filter((t) => t.scriptTools && !t.verified).map((t) => [
      t.type,
      { table: t.table, fields: [...t.scriptFields].sort() },
    ]),
  );
  assert.deepEqual(byType.ui_page, {
    table: "sys_ui_page",
    fields: ["client_script", "html", "processing_script"],
  });
  assert.deepEqual(byType.sp_widget, {
    table: "sp_widget",
    fields: ["client_script", "css", "link", "script"],
  });
  assert.deepEqual(byType.catalog_client_script, {
    table: "catalog_script_client",
    fields: ["script"],
  });
  assert.deepEqual(byType.transform_entry, {
    table: "sys_transform_entry",
    fields: ["source_script"],
  });
});
