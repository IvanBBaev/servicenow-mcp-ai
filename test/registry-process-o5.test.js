// O-5 — the process / AI / application / reporting rows of
// registry-process.ts use the column names a PDI dictionary confirms
// (sys_dictionary, read-only). Each assertion names the column it pins.
import test from "node:test";
import assert from "node:assert/strict";

import {
  getArtifactType,
  validateArtifactTypes,
} from "../build/core/artifacts/registry.js";

const child = (type, table) =>
  getArtifactType(type).children.find((c) => c.table === table);

test("O-5: the registry still validates after the PDI column fixes", () => {
  assert.deepEqual(validateArtifactTypes(), []);
});

test("O-5: flow_action steps decode sys_hub_step_instance.inputs", () => {
  const step = child("flow_action", "sys_hub_step_instance");
  assert.deepEqual(
    step.jsonFields.map((j) => j.field),
    ["inputs"],
  );
});

test("O-5: wf_activity hangs off wf_workflow_version, with no order column", () => {
  const act = child("workflow", "wf_activity");
  assert.equal(act.parentField, "workflow_version");
  assert.equal(act.parentTable, "wf_workflow_version");
  assert.equal(act.orderField, undefined);
  // wf_workflow has no `active`; it lives on wf_workflow_version.
  assert.equal(getArtifactType("workflow").activeField, undefined);
});

test("O-5: AI agents — versions by target_id, triggers by use case, no active", () => {
  assert.equal(child("ai_agent", "sn_aia_version").parentField, "target_id");
  assert.equal(child("ai_agent", "sn_aia_trigger_configuration"), undefined);
  assert.equal(
    child("ai_agentic_workflow", "sn_aia_trigger_configuration").parentField,
    "usecase",
  );
  for (const type of ["ai_agent", "ai_agentic_workflow"]) {
    const t = getArtifactType(type);
    assert.equal(t.activeField, undefined, type);
    assert.ok(!t.metaFields.includes("active"), type);
  }
});

test("O-5: source_control reads current_branch and sys_app", () => {
  assert.deepEqual(getArtifactType("source_control").metaFields, [
    "url",
    "current_branch",
    "sys_app",
  ]);
});

test("O-5: Performance Analytics rows drop active; pa_script reads table / arguments", () => {
  for (const type of ["pa_indicator", "pa_breakdown"]) {
    const t = getArtifactType(type);
    assert.equal(t.activeField, undefined, type);
    assert.ok(!t.metaFields.includes("active"), type);
  }
  const script = getArtifactType("pa_script");
  assert.equal(script.appliesToField, "table");
  assert.deepEqual(script.metaFields, ["table", "arguments"]);
});

test("O-5: keyFields are unchanged by the column fixes", () => {
  assert.deepEqual(getArtifactType("flow_action").keyFields, ["internal_name"]);
});
