// N-31 (UX-21, UX-22, UX-23) — UI Builder composition element diff, the
// `uib-page-weight` rule and the required_translations helper.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";

import {
  COMPOSITION_DIFF_MAX_ENTRIES,
  compositionDiff,
  compositionDiffSummary,
  elementProps,
  flattenComposition,
  isEmptyCompositionDiff,
} from "../build/core/artifacts/uib-composition-diff.js";
import {
  TRANSLATIONS_MAX,
  declaredTranslations,
  requiredTranslations,
  translatableStrings,
} from "../build/core/artifacts/uib-translations.js";
import {
  UIB_PAGE_RULES,
  UIB_PAGE_WEIGHT_THRESHOLDS,
  firesOnLoad,
  hasWhenCondition,
  lintUibPageWeight,
  uibPageMetrics,
} from "../build/api/uib-page-lint.js";
import { elementDiffs } from "../build/api/artifact-snapshot.js";

const clone = (v) => JSON.parse(JSON.stringify(v));

const el = (elementId, extra = {}) => ({
  elementId,
  definition: { id: `cmp_${elementId}`, type: "COMPONENT" },
  ...extra,
});

/** A small page: header + body with a list and a button. */
const PAGE = [
  el("header", {
    elementLabel: "Header",
    propertyValues: { title: "Incidents" },
  }),
  el("body", {
    slots: {
      main: [
        el("list", {
          propertyValues: {
            items: {
              type: "DATA_OUTPUT_BINDING",
              binding: { address: ["list_broker", "output"] },
            },
            emptyStateMessage: "No records",
          },
        }),
        el("save", { propertyValues: { label: "Save", variant: "primary" } }),
        el("cancel", { propertyValues: { label: "Cancel" } }),
      ],
    },
  }),
];

// -- flatten -------------------------------------------------------------------

test("flattenComposition: parent, slot, index and depth per element", () => {
  const f = flattenComposition(PAGE);
  assert.deepEqual(
    [...f.elements.values()].map((e) => [
      e.elementId,
      e.parent,
      e.slot,
      e.index,
      e.depth,
    ]),
    [
      ["header", "", "", 0, 1],
      ["body", "", "", 1, 1],
      ["list", "body", "main", 0, 2],
      ["save", "body", "main", 1, 2],
      ["cancel", "body", "main", 2, 2],
    ],
  );
  assert.equal(f.maxDepth, 2);
  assert.equal(f.omitted, 0);
  assert.equal(f.duplicates, 0);
});

test("flattenComposition: tolerant of junk, caps and duplicates", () => {
  assert.equal(flattenComposition("x").elements.size, 0);
  assert.equal(flattenComposition(null).elements.size, 0);
  const f = flattenComposition([el("a"), 7, el("a"), { no: 1 }]);
  assert.equal(f.elements.size, 1);
  assert.equal(f.duplicates, 1);
  const capped = flattenComposition(PAGE, { maxElements: 2 });
  assert.equal(capped.elements.size, 2);
  assert.equal(capped.omitted, 3);
  const shallow = flattenComposition(PAGE, { maxDepth: 1 });
  assert.equal(shallow.elements.size, 2);
  assert.equal(shallow.omitted, 3);
  // Slot arrays and `children` also flatten.
  const g = flattenComposition([
    el("a", {
      slots: [{ slotName: "s", children: [el("b")] }],
      children: [el("c")],
    }),
  ]);
  assert.deepEqual([...g.elements.keys()], ["a", "b", "c"]);
  assert.equal(g.elements.get("c").slot, "default");
});

test("elementProps: props, config, overrides and a bound isHidden", () => {
  const p = elementProps({
    elementId: "x",
    props: { a: 1 },
    config: { b: 2 },
    overrides: { o: { propertyValues: { c: 3 } }, plain: 4 },
    isHidden: "@state.hide",
  });
  assert.deepEqual(
    [...p.keys()],
    ["a", "config.b", "overrides.o.c", "overrides.plain", "isHidden"],
  );
});

// -- diff ------------------------------------------------------------------------

test("compositionDiff: the same page is empty", () => {
  const d = compositionDiff(PAGE, clone(PAGE));
  assert.deepEqual(d, {
    added: 0,
    removed: 0,
    moved: 0,
    changed: 0,
    elements: [],
  });
  assert.ok(isEmptyCompositionDiff(d));
});

test("compositionDiff: added, removed, moved, prop and binding changes", () => {
  const b = clone(PAGE);
  const main = b[1].slots.main;
  // move: `save` leaves body/main for the root.
  const [save] = main.splice(1, 1);
  b.push(save);
  // removed `cancel`, added `help`.
  main.splice(1, 1);
  main.push(el("help", { elementLabel: "Help" }));
  // prop change on the header, binding change on the list.
  b[0].propertyValues.title = "My incidents";
  main[0].propertyValues.items = "@data.other_broker.output";
  // attribute change on body.
  b[1].isHidden = true;

  const d = compositionDiff(PAGE, b);
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.equal(d.moved, 1);
  assert.equal(d.changed, 4);
  assert.deepEqual(d.elements, [
    {
      elementId: "body",
      status: "changed",
      component: "cmp_body",
      attributes: ["isHidden"],
    },
    { elementId: "cancel", status: "removed", component: "cmp_cancel" },
    {
      elementId: "header",
      status: "changed",
      component: "cmp_header",
      label: "Header",
      props: ["title"],
    },
    {
      elementId: "help",
      status: "added",
      component: "cmp_help",
      label: "Help",
    },
    {
      elementId: "list",
      status: "changed",
      component: "cmp_list",
      bindings: ["items"],
    },
    {
      elementId: "save",
      status: "changed",
      component: "cmp_save",
      moved: { from: "body/main#1", to: "(root)#2" },
    },
  ]);
  assert.equal(compositionDiffSummary(d), "+1 -1 ~4 (moved 1)");
});

test("compositionDiff: an insertion does not mark later siblings as moved; a swap marks one", () => {
  const b = clone(PAGE);
  b[1].slots.main.unshift(el("first"));
  const d = compositionDiff(PAGE, b);
  assert.deepEqual(
    d.elements.map((e) => [e.elementId, e.status]),
    [["first", "added"]],
  );
  const s = clone(PAGE);
  const main = s[1].slots.main;
  [main[0], main[2]] = [main[2], main[0]];
  const swapped = compositionDiff(PAGE, s);
  assert.ok(swapped.moved >= 1 && swapped.moved <= 2);
  assert.equal(swapped.added + swapped.removed, 0);
});

test("compositionDiff: a bound isHidden is a binding, a literal one an attribute", () => {
  const a = [el("x", { isHidden: false })];
  const b = [el("x", { isHidden: "@state.hidden" })];
  assert.deepEqual(compositionDiff(a, b).elements, [
    {
      elementId: "x",
      status: "changed",
      component: "cmp_x",
      bindings: ["isHidden"],
    },
  ]);
});

test("compositionDiff: entries are capped; a partial side is flagged", () => {
  const many = Array.from(
    { length: COMPOSITION_DIFF_MAX_ENTRIES + 5 },
    (_, i) => el(`e${i}`),
  );
  const d = compositionDiff([], many);
  assert.equal(d.added, COMPOSITION_DIFF_MAX_ENTRIES + 5);
  assert.equal(d.elements.length, COMPOSITION_DIFF_MAX_ENTRIES);
  assert.equal(d.omitted, 5);
  const dup = compositionDiff([el("a"), el("a")], [el("a")]);
  assert.equal(dup.truncated, true);
  assert.match(compositionDiffSummary(dup), /partial/);
});

// -- property tests ----------------------------------------------------------------

/** A random composition with unique ids, built from parent links. */
const compositionArb = fc
  .array(
    fc.record({
      parent: fc.nat(),
      slot: fc.constantFrom("main", "side"),
      title: fc.option(fc.string({ maxLength: 6 }), { nil: undefined }),
      bound: fc.boolean(),
    }),
    { minLength: 1, maxLength: 25 },
  )
  .map((specs) => {
    const nodes = specs.map((s, i) => ({
      elementId: `e${i}`,
      definition: { id: "cmp", type: "COMPONENT" },
      propertyValues: {
        ...(s.title !== undefined ? { title: s.title } : {}),
        ...(s.bound ? { value: `@state.v${i}` } : {}),
      },
    }));
    const roots = [];
    specs.forEach((s, i) => {
      // Element i hangs under an earlier element or the root.
      const p = i === 0 ? -1 : (s.parent % (i + 1)) - 1;
      if (p < 0) roots.push(nodes[i]);
      else {
        const parent = nodes[p];
        parent.slots ??= {};
        (parent.slots[s.slot] ??= []).push(nodes[i]);
      }
    });
    return roots;
  });

test("property: diffing a composition against itself is empty", () => {
  fc.assert(
    fc.property(compositionArb, (c) => {
      assert.ok(isEmptyCompositionDiff(compositionDiff(c, clone(c))));
    }),
  );
});

test("property: a move is never reported as remove + add", () => {
  fc.assert(
    fc.property(compositionArb, fc.nat(), (c, pick) => {
      const b = clone(c);
      // Detach a random element (with its subtree) and append it at the root.
      const holders = [];
      const visit = (list) => {
        list.forEach((n, i) => {
          holders.push([list, i]);
          for (const sub of Object.values(n.slots ?? {})) visit(sub);
        });
      };
      visit(b);
      const [list, i] = holders[pick % holders.length];
      const [node] = list.splice(i, 1);
      b.push(node);
      const d = compositionDiff(c, b);
      assert.equal(d.added, 0);
      assert.equal(d.removed, 0);
      // A root element moved to the end of the root may be in its place already.
      if (d.changed > 0) {
        assert.ok(d.elements.every((e) => e.status === "changed" && e.moved));
      }
    }),
  );
});

// -- snapshot / compare wiring -------------------------------------------------------

test("elementDiffs: only composition fields that differ, only decoded compositions", () => {
  const b = clone(PAGE);
  b.push(el("new"));
  const d = elementDiffs(
    "uib_macroponent",
    ["composition", "name"],
    { composition: PAGE },
    { composition: b },
  );
  assert.deepEqual(Object.keys(d), ["composition"]);
  assert.equal(d.composition.added, 1);
  // Not named as a differing field → not diffed.
  assert.equal(
    elementDiffs(
      "uib_macroponent",
      ["name"],
      { composition: PAGE },
      { composition: b },
    ),
    undefined,
  );
  // A raw (undecoded) side is skipped; an empty side is an empty page.
  assert.equal(
    elementDiffs(
      "uib_macroponent",
      ["composition"],
      { composition: "{x" },
      { composition: b },
    ),
    undefined,
  );
  assert.equal(
    elementDiffs(
      "uib_macroponent",
      ["composition"],
      { composition: "" },
      { composition: b },
    ).composition.added,
    6,
  );
  // Another type has no composition field.
  assert.equal(
    elementDiffs(
      "sp_widget",
      ["composition"],
      { composition: PAGE },
      { composition: b },
    ),
    undefined,
  );
  // Equal compositions (a reformatted value) give nothing.
  assert.equal(
    elementDiffs(
      "uib_macroponent",
      ["composition"],
      { composition: PAGE },
      { composition: clone(PAGE) },
    ),
    undefined,
  );
});

// -- required_translations -------------------------------------------------------------

test("translatableStrings: text-like literal props and typed translation literals", () => {
  const comp = [
    el("a", {
      propertyValues: {
        label: "Save",
        title: "@state.title",
        heading: "8f3a0c1e9b7d4e2f8a6c5b4d3e2f1a0b",
        tooltip: "https://example.com/x",
        variant: "primary",
        count: 3,
        body: {
          type: "TRANSLATION_LITERAL",
          value: { message: "Hello world" },
        },
        other: { translatable: true, value: "Flagged" },
        wrapped: { type: "LITERAL", value: "not text-like" },
        placeholder: { type: "LITERAL", value: "Search…" },
      },
      config: { ariaLabel: "Close dialog", empty: "" },
      overrides: { mobile: { propertyValues: { label: "Save!" } } },
    }),
  ];
  const { strings, omitted } = translatableStrings(comp);
  assert.equal(omitted, 0);
  assert.deepEqual(
    strings.map((s) => [s.prop, s.text]),
    [
      ["label", "Save"],
      ["body", "Hello world"],
      ["other", "Flagged"],
      ["placeholder", "Search…"],
      ["config.ariaLabel", "Close dialog"],
      ["overrides.mobile.label", "Save!"],
    ],
  );
  assert.ok(strings.every((s) => s.elementId === "a"));
});

test("translatableStrings: bounded", () => {
  const comp = Array.from({ length: TRANSLATIONS_MAX + 3 }, (_, i) =>
    el(`e${i}`, { propertyValues: { label: `Label ${i}` } }),
  );
  const r = translatableStrings(comp);
  assert.equal(r.strings.length, TRANSLATIONS_MAX);
  assert.equal(r.omitted, 3);
  assert.equal(requiredTranslations(comp).omitted, 3);
});

test("declaredTranslations: tolerant shapes", () => {
  assert.deepEqual(declaredTranslations(undefined), []);
  assert.deepEqual(declaredTranslations(""), []);
  assert.deepEqual(declaredTranslations(["b", "a", "a", " "]), ["a", "b"]);
  assert.deepEqual(
    declaredTranslations([
      { message: "Save" },
      { key: "k" },
      { text: "t" },
      { nope: 1 },
      5,
    ]),
    ["Save", "k", "t"],
  );
  assert.deepEqual(declaredTranslations({ Save: {}, Cancel: {} }), [
    "Cancel",
    "Save",
  ]);
  assert.equal(declaredTranslations(42), null);
});

test("requiredTranslations: page strings against the declared list", () => {
  const r = requiredTranslations(PAGE, [{ message: "Save" }, "Incidents"]);
  assert.deepEqual(r.texts, ["Cancel", "Incidents", "No records", "Save"]);
  assert.deepEqual(r.declared, ["Incidents", "Save"]);
  assert.deepEqual(r.undeclared, ["Cancel", "No records"]);
  assert.equal(r.strings.length, 4);
  assert.equal(r.omitted, undefined);
  const unknown = requiredTranslations(PAGE, 7);
  assert.equal(unknown.declared, null);
  assert.deepEqual(unknown.undeclared, []);
  assert.deepEqual(requiredTranslations("junk").texts, []);
});

// -- uib-page-weight ---------------------------------------------------------------------

test("page-weight rule catalogue has the existing rule shape", () => {
  assert.deepEqual(
    UIB_PAGE_RULES.map((r) => r.id),
    ["uib-page-weight"],
  );
  for (const r of UIB_PAGE_RULES) {
    assert.ok(["error", "warn", "info"].includes(r.severity));
    assert.ok(r.hint.length > 10);
  }
});

test("firesOnLoad / hasWhenCondition", () => {
  assert.equal(firesOnLoad({}), true);
  assert.equal(firesOnLoad({ evaluationMode: "EAGER" }), true);
  assert.equal(firesOnLoad({ evaluationMode: "JUST_IN_TIME" }), false);
  assert.equal(firesOnLoad({ invocation: "ON_DEMAND" }), false);
  assert.equal(hasWhenCondition({}), false);
  assert.equal(hasWhenCondition({ when: " " }), false);
  assert.equal(hasWhenCondition({ when: "@state.ready" }), true);
  assert.equal(hasWhenCondition({ condition: { type: "X" } }), true);
  assert.equal(hasWhenCondition({ whenCondition: [1] }), true);
});

test("a light page has no findings", () => {
  const r = lintUibPageWeight({
    composition: JSON.stringify(PAGE),
    data: JSON.stringify([{ elementId: "list_broker", when: "@state.ready" }]),
  });
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.metrics, {
    elements: 5,
    maxDepth: 2,
    dataBrokers: 1,
    onLoadBrokers: 1,
    unconditionalOnLoad: [],
  });
});

test("uibPageMetrics: missing, empty and undecodable columns", () => {
  assert.deepEqual(uibPageMetrics({}), {
    elements: 0,
    maxDepth: 0,
    dataBrokers: 0,
    onLoadBrokers: 0,
    unconditionalOnLoad: [],
  });
  assert.equal(
    uibPageMetrics({ composition: "  ", data: "" }).partial,
    undefined,
  );
  assert.equal(uibPageMetrics({ composition: "{x" }).partial, true);
  assert.equal(uibPageMetrics({ data: "{x" }).partial, true);
  assert.equal(uibPageMetrics({ data: { a: 1 } }).partial, true);
});

/** A heavy page: wide, deep and with many eager brokers. */
function heavyPage() {
  const wide = Array.from({ length: 160 }, (_, i) => el(`w${i}`));
  let deep = el("d10");
  for (let i = 9; i >= 1; i--) deep = el(`d${i}`, { slots: { main: [deep] } });
  const data = [
    ...Array.from({ length: 6 }, (_, i) => ({
      elementId: `eager${i}`,
      definition: { id: "b", type: "TRANSFORM" },
    })),
    { elementId: "guarded", when: "@state.open" },
    { elementId: "lazy", evaluationMode: "JUST_IN_TIME" },
  ];
  return { composition: [...wide, deep], data };
}

const FIXTURES = path.join(import.meta.dirname, "fixtures", "uib");

test("page-weight golden: a heavy page", () => {
  const actual = `${JSON.stringify(lintUibPageWeight(heavyPage()), null, 2)}\n`;
  const file = path.join(FIXTURES, "page-weight.golden.json");
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  assert.equal(actual, readFileSync(file, "utf8"));
});

test("page-weight thresholds can be overridden", () => {
  const r = lintUibPageWeight(heavyPage(), {
    elements: 1000,
    depth: 20,
    onLoadBrokers: 10,
  });
  assert.deepEqual(
    r.findings.map((f) => f.metric),
    ["unconditional-broker"],
  );
  assert.equal(UIB_PAGE_WEIGHT_THRESHOLDS.elements, 150);
});
