// O-5 / N-25 — the UI Builder readers against the JSON shapes a PDI returns.
// test/fixtures/uib/pdi-oob.json holds one OOB sys_ux_macroponent and one OOB
// REST data broker row, trimmed to their structure: children nested under
// `overrides.composition` with a `slot` name, `{source: [handlers]}` event
// mappings with typed sub-objects, and the broker input schema in `props`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  compositionTree,
  dataResources,
  eventMappings,
  eventWiring,
  slotsOf,
  stateProperties,
} from "../build/core/artifacts/uib-composition.js";
import {
  compositionDiff,
  elementProps,
  flattenComposition,
} from "../build/core/artifacts/uib-composition-diff.js";
import {
  brokerMutates,
  hasInputSchema,
  lintUibBroker,
} from "../build/api/uib-broker-lint.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/uib/pdi-oob.json", import.meta.url),
    "utf8",
  ),
);
const mp = fixture.macroponent;
const composition = JSON.parse(mp.composition);

const ids = (elements) =>
  elements.flatMap((e) => [
    e.elementId,
    ...e.slots.flatMap((s) => ids(s.elements)),
  ]);

test("composition: children under overrides.composition are walked by slot", () => {
  const tree = compositionTree(composition);
  assert.equal(tree.count, 17);
  assert.equal(tree.omitted, 0);
  assert.equal(tree.skipped, 0);
  assert.deepEqual(
    tree.elements.map((e) => e.elementId),
    ["playbook_card_component", "modal_viewport_1"],
  );
  const card = tree.elements[0];
  // A named slot ("content") and the default slot of a null `slot`.
  assert.deepEqual(
    card.slots.map((s) => s.name),
    ["content"],
  );
  assert.deepEqual(
    card.slots[0].elements.map((e) => e.elementId),
    ["in_progress_container", "completed_container"],
  );
  assert.equal(card.slots[0].elements[0].slots[0].name, "default");
  assert.ok(ids(tree.elements).includes("label_value_stacked_1"));
  assert.equal(new Set(ids(tree.elements)).size, 17);
});

test("composition: slotsOf groups live children by their slot name", () => {
  const card = composition[0];
  const slots = slotsOf(card);
  assert.deepEqual(
    slots.map(([name, items]) => [name, items.length]),
    [["content", 2]],
  );
  // An element without nested children has no slots.
  assert.deepEqual(slotsOf({ elementId: "leaf", overrides: {} }), []);
});

test("composition: overrides.composition is structure, not a prop", () => {
  const tree = compositionTree(composition, { props: true });
  const all = [];
  const walk = (els) =>
    els.forEach((e) => {
      all.push(...(e.props ?? []));
      e.slots.forEach((s) => walk(s.elements));
    });
  walk(tree.elements);
  assert.ok(all.length > 0);
  assert.ok(all.every((p) => p.name !== "composition"));
  assert.ok(all.some((p) => p.source === "props"));
  assert.ok(
    [...elementProps(composition[0]).keys()].every(
      (k) => k !== "overrides.composition",
    ),
  );
});

test("composition diff: a child moved to another slot is one moved entry", () => {
  const flat = flattenComposition(composition);
  assert.equal(flat.elements.size, 17);
  assert.equal(flat.elements.get("form_1").parent, "form_container");

  const moved = structuredClone(composition);
  const content = moved[0].overrides.composition;
  // Move completed_container out of the card's "content" slot.
  content[1].slot = "footer";
  const diff = compositionDiff(composition, moved);
  assert.deepEqual(
    diff.elements.map((e) => [e.elementId, e.status, !!e.moved]),
    [["completed_container", "changed", true]],
  );
  assert.equal(diff.elements[0].attributes, undefined);
  assert.deepEqual(compositionDiff(composition, composition).elements, []);
});

test("data, state and event mappings decode the live shapes", () => {
  const data = dataResources(JSON.parse(mp.data));
  assert.equal(data.length, 2);
  assert.ok(data.every((d) => /^[0-9a-f]{32}$/.test(d.broker)));

  const state = stateProperties(JSON.parse(mp.state_properties));
  assert.deepEqual(
    state.map((s) => s.type),
    ["json", "boolean", "boolean"],
  );

  const raw = JSON.parse(mp.internal_event_mappings);
  const mappings = eventMappings(raw);
  assert.equal(mappings.length, Object.keys(raw).length);
  const handlers = mappings.flatMap((m) => m.handlers);
  const byType = (t) => handlers.filter((h) => h.type === t);
  // clientScript.sysId and event.sysId are the definition; event.apiName
  // names the handler; operation.operationName is the broker operation.
  assert.ok(
    byType("CLIENT_SCRIPT").every(
      (h) => /^[0-9a-f]{32}$/.test(h.definitionId) && h.targetId,
    ),
  );
  assert.ok(
    byType("EVENT").every(
      (h) => h.name.includes(".") && /^[0-9a-f]{32}$/.test(h.definitionId),
    ),
  );
  assert.deepEqual(
    byType("DATABROKER_OP").map((h) => [h.name, h.operation]),
    [["REFRESH", "REFRESH"]],
  );
  // The short wiring names the same handlers.
  assert.deepEqual(
    eventWiring(raw).flatMap((w) => w.handlers),
    handlers.map((h) => h.name),
  );
  // An empty map (most macroponents with no wiring) is no wiring, not unknown.
  assert.deepEqual(eventMappings({}), []);
});

test("broker: the input schema is the props array", () => {
  const { props, mutates_server_data } = fixture.restBroker;
  assert.equal(hasInputSchema(props), true);
  assert.equal(brokerMutates(mutates_server_data), true);
  assert.equal(hasInputSchema(""), false);
  assert.equal(hasInputSchema("[]"), false);
  // A row read with `props` reports a missing schema; one without it is unknown.
  const rules = (row) =>
    lintUibBroker(row, { hasAcl: true }).map((f) => f.rule);
  assert.deepEqual(rules({ kind: "rest", props: "" }), [
    "uib-broker-no-input-schema",
  ]);
  assert.deepEqual(rules({ kind: "rest", props }), []);
  assert.deepEqual(rules({ kind: "rest" }), []);
});
