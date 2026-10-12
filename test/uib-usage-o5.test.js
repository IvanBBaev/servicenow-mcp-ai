// O-5 — the N-28 UI Builder usage readers against the shapes a live instance
// (the ven03019 PDI) holds: every data resource `definition.type` seen there
// maps to the table its `definition.id` lives in, and an `imports['…']` key
// is the include's api_name, whose name may hold spaces.
import test from "node:test";
import assert from "node:assert/strict";

import {
  BROKER_BASE_TABLE,
  BROKER_TABLE_NAMES,
  brokerTable,
  macroponentUses,
  uibImports,
  uibIncludeIds,
} from "../build/api/uib-usage.js";

/** `definition.type` → sys_class_name of its `definition.id` on the PDI. */
const PDI_TYPES = {
  TRANSFORM: "sys_ux_data_broker_transform",
  SCRIPTLET: "sys_ux_data_broker_scriptlet",
  REST: "sys_ux_data_broker_rest",
  GRAPHQL: "sys_ux_data_broker_graphql",
  COMPOSITE: "sys_ux_data_broker_composite",
  CLIENT_STATE: "sys_ux_data_broker_proxy",
  CONTROLLER: "sys_ux_controller",
};

test("O-5: every PDI data resource type names its table", () => {
  for (const [type, table] of Object.entries(PDI_TYPES)) {
    assert.equal(brokerTable(type).table, table, type);
    assert.ok(BROKER_TABLE_NAMES.includes(table), table);
  }
  assert.equal(brokerTable("graphql").table, PDI_TYPES.GRAPHQL);
  assert.equal(brokerTable("UNKNOWN").table, BROKER_BASE_TABLE);
  assert.equal(brokerTable(undefined).table, BROKER_BASE_TABLE);
  // Only the four broker kinds the registry knows carry a type.
  assert.equal(brokerTable("COMPOSITE").type, undefined);
  assert.equal(brokerTable("GRAPHQL").type, "uib_data_broker_graphql");
});

test("O-5: a PDI-shaped data column yields its brokers with their types", () => {
  const COMPOSITE = "b997a84053021010cbc2ddeeff7b1228";
  const TRANSFORM = "8be6412d9729da10b67cdf14a253af17";
  const GRAPHQL = "546cccd25310101024e5ddeeff7b123b";
  const data = JSON.stringify([
    {
      elementId: "look_up_records_1",
      elementLabel: "GetAllStockroom",
      definition: { id: COMPOSITE, type: "COMPOSITE" },
      dependencies: {},
      inputValues: { table: { type: "JSON_LITERAL", value: "alm_stockroom" } },
      eventMappings: [],
      readEvaluationMode: "EAGER",
    },
    {
      elementId: "fetch_stockrooms_1",
      definition: { id: TRANSFORM, type: "TRANSFORM" },
      inputValues: {},
      eventMappings: [],
    },
    {
      elementId: "aggregation_query_1",
      definition: { id: GRAPHQL, type: "GRAPHQL" },
      inputValues: {},
      eventMappings: [],
    },
  ]);
  const { brokers } = macroponentUses({ data });
  assert.deepEqual(
    brokers.map((b) => [b.id, b.type, brokerTable(b.type).table]),
    [
      [COMPOSITE, "COMPOSITE", "sys_ux_data_broker_composite"],
      [TRANSFORM, "TRANSFORM", "sys_ux_data_broker_transform"],
      [GRAPHQL, "GRAPHQL", "sys_ux_data_broker_graphql"],
    ],
  );
});

test("O-5: imports keys are api_names; the name after the scope is kept whole", () => {
  assert.deepEqual(
    uibImports(
      "function handler({api, event, helpers, imports}) {\n" +
        "imports['x_nuvo_nps.Load Pendo'](helpers);\n" +
        "return imports['global.mergePARFilters']()(a, b);\n}",
    ),
    ["Load Pendo", "mergePARFilters"],
  );
  assert.deepEqual(uibImports('imports["MyInclude"]; imports.Other'), [
    "MyInclude",
    "Other",
  ]);
  assert.deepEqual(uibImports("imports['x_acme.v2.Util']"), ["v2.Util"]);
});

test("O-5: includes is a glide_list of include sys_ids", () => {
  const A = "669a58121ba5d650bc1362c7b04bcb7f";
  const B = "8f0ec3492c5f441781f1f44f36351242";
  assert.deepEqual(uibIncludeIds(`${A},${B}, ${A},not-an-id`), [A, B]);
  assert.deepEqual(uibIncludeIds(""), []);
});
