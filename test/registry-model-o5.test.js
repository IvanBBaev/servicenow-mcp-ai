import test from "node:test";
import assert from "node:assert/strict";

import { getArtifactType } from "../build/core/artifacts/registry.js";

const child = (type, table) =>
  getArtifactType(type).children.find((c) => c.table === table);

test("flow instance inputs use the PDI-verified columns (O-5)", () => {
  const fields = (type, table) =>
    (child(type, table).jsonFields ?? []).map((f) => f.field);
  for (const type of ["flow", "subflow"]) {
    // The plain action table keeps its inputs in sys_variable_value.
    assert.deepEqual(fields(type, "sys_hub_action_instance"), []);
    assert.deepEqual(fields(type, "sys_hub_action_instance_v2"), ["values"]);
    assert.deepEqual(fields(type, "sys_hub_sub_flow_instance_v2"), [
      "subflow_inputs",
    ]);
  }
});

test("business_rule does not read a sys_script.global column (O-5)", () => {
  assert.ok(!getArtifactType("business_rule").metaFields.includes("global"));
});
