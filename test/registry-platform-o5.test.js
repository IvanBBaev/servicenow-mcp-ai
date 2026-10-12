import test from "node:test";
import assert from "node:assert/strict";

import { getArtifactType } from "../build/core/artifacts/registry.js";

/** One child of an artefact type, by table. */
function child(type, table) {
  const c = getArtifactType(type).children.find((x) => x.table === table);
  assert.ok(c, `${type} > ${table}`);
  return c;
}

test("O-5: state_model uses the PDI columns", () => {
  const t = getArtifactType("state_model");
  assert.equal(t.appliesToField, "table_name");
  assert.deepEqual(t.metaFields, ["table_name", "state_field"]);
  const state = child("state_model", "sttrm_state");
  assert.equal(state.parentField, "sttrm_model");
  assert.equal(state.nameField, "state_label");
  // No model column on a transition: it hangs off its from_state.
  const transition = child("state_model", "sttrm_state_transition");
  assert.equal(transition.parentField, "from_state");
  assert.equal(transition.parentTable, "sttrm_state");
  const condition = child("state_model", "sttrm_transition_condition");
  assert.equal(condition.parentField, "sttrm_state_transition");
  assert.equal(condition.parentTable, "sttrm_state_transition");
});

test("O-5: data_lookup uses the PDI columns", () => {
  const t = getArtifactType("data_lookup");
  assert.equal(t.appliesToField, "source_table");
  assert.ok(t.metaFields.includes("source_table"));
  assert.ok(!t.metaFields.includes("table"));
  for (const table of ["dl_definition_rel_match", "dl_definition_rel_set"]) {
    const c = child("data_lookup", table);
    assert.equal(c.parentField, "dl_definition", table);
    assert.equal(c.nameField, "source_table_field", table);
  }
});

test("O-5: dashboard widgets hang off a canvas", () => {
  const canvas = child("dashboard", "par_dashboard_canvas");
  assert.equal(canvas.parentField, "dashboard");
  const widget = child("dashboard", "par_dashboard_widget");
  assert.equal(widget.parentField, "canvas");
  assert.equal(widget.parentTable, "par_dashboard_canvas");
});

test("O-5: security_data_filter uses the PDI columns", () => {
  const t = getArtifactType("security_data_filter");
  assert.equal(t.nameField, "description");
  assert.equal(t.appliesToField, "table_name");
  assert.deepEqual(t.metaFields, ["table_name", "mode", "active"]);
  assert.ok(t.whenFields.includes("filter"));
  assert.ok(!t.whenFields.includes("condition"));
});

test("O-5: js_module, rest_message and GraphQL use the PDI columns", () => {
  const js = getArtifactType("js_module");
  assert.equal(js.nameField, "path");
  assert.deepEqual(js.scriptFields, ["content"]);
  assert.ok(
    !getArtifactType("rest_message").metaFields.includes("use_mid_server"),
  );
  const gql = getArtifactType("graphql_api");
  assert.ok(gql.metaFields.includes("namespace"));
  assert.ok(gql.metaFields.includes("application_namespace"));
  assert.ok(!gql.metaFields.includes("schema_namespace"));
  assert.equal(
    child("graphql_api", "sys_graphql_typeresolver").nameField,
    "type_name",
  );
  assert.equal(getArtifactType("graphql_type_resolver").nameField, "type_name");
});

test("O-5: email, data policy and form action rows use the PDI columns", () => {
  const inbound = getArtifactType("inbound_email_action");
  assert.ok(inbound.whenFields.includes("filter_condition"));
  assert.ok(inbound.whenFields.includes("condition_script"));
  assert.ok(!inbound.whenFields.includes("condition"));
  const policy = getArtifactType("data_policy");
  assert.ok(policy.metaFields.includes("enforce_ui"));
  assert.ok(!policy.metaFields.includes("use_as_ui_policy"));
  const action = getArtifactType("workspace_form_action");
  assert.equal(action.nameField, "name");
  assert.deepEqual(
    action.refFields.map((r) => [r.field, r.table]),
    [
      ["ui_action", "sys_ui_action"],
      ["declarative_action", "sys_declarative_action_assignment"],
    ],
  );
  assert.deepEqual(action.metaFields, [
    "table",
    "action_type",
    "specificity",
    "active",
  ]);
});
