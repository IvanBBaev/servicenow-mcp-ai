// N-7 — translation coverage per language: messages, labels, choices,
// translated text, translated fields and UIB strings.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import {
  I18N_CAVEAT,
  categoryCoverage,
  i18nCoverage,
  i18nCoverageMarkdown,
  keyClauses,
} from "../build/api/i18n-coverage.js";
import {
  baselineEnv,
  fcParams,
  freshRuntime,
  jsonResponse,
  withMetadataFetch,
} from "./helpers.js";

baselineEnv();

const MP_ID = "b".repeat(32);

test("categoryCoverage: translated + missing = total; the sample is the sorted missing prefix", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), {
        maxLength: 30,
      }),
      fc.array(
        fc.record({
          key: fc.string({ minLength: 1, maxLength: 6 }),
          language: fc.constantFrom("de", "DE", "fr", "en"),
        }),
        { maxLength: 60 },
      ),
      fc.integer({ min: 0, max: 10 }),
      (keys, rows, size) => {
        const c = categoryCoverage("messages", keys, rows, "de", size);
        assert.equal(c.total, keys.length);
        assert.equal(c.translated + c.missing, c.total);
        assert.ok(c.sample.length <= Math.min(size, c.missing));
        const de = new Set(
          rows
            .filter((r) => r.language.toLowerCase() === "de")
            .map((r) => r.key),
        );
        const missing = [...keys].sort().filter((k) => !de.has(k));
        assert.deepEqual(c.sample, missing.slice(0, size));
      },
    ),
    fcParams(),
  );
});

test("keyClauses: every queryable key lands in exactly one chunk within the size bound", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 40 }), {
        maxLength: 50,
      }),
      (keys) => {
        const { clauses, skipped } = keyClauses(keys, 200);
        const terms = clauses.flatMap((c) => c.split("^OR"));
        const queryable = keys.filter((k) => !/[\^\r\n]/.test(k));
        assert.deepEqual(
          terms,
          queryable.map((k) => `key=${k}`),
        );
        assert.equal(skipped.length, keys.length - queryable.length);
        for (const c of clauses) {
          assert.ok(c.length <= 200 || !c.includes("^OR"));
        }
      },
    ),
    fcParams(),
  );
});

const composition = JSON.stringify([
  {
    elementId: "header",
    propertyValues: { title: "Welcome" },
  },
  {
    elementId: "save",
    propertyValues: { label: "Save record" },
  },
]);

const tables = (overrides = {}) => ({
  sys_db_object: [{ name: "x_acme_request" }],
  sys_ui_message: (q) =>
    q.startsWith("sys_scope")
      ? [
          { key: "Hello", language: "en" },
          { key: "Hello", language: "de" },
          { key: "Bye", language: "en" },
          { key: "Bye", language: "fr" },
        ]
      : [
          { key: "Welcome", language: "de" },
          { key: "Welcome", language: "fr" },
          { key: "Unrelated", language: "de" },
        ],
  sys_documentation: [
    { name: "x_acme_request", element: "", language: "en" },
    { name: "x_acme_request", element: "", language: "de" },
    { name: "x_acme_request", element: "state", language: "en" },
  ],
  sys_choice: [
    { name: "x_acme_request", element: "state", value: "1", language: "en" },
    { name: "x_acme_request", element: "state", value: "1", language: "de" },
    { name: "x_acme_request", element: "state", value: "2", language: "en" },
  ],
  sys_translated_text: [
    {
      tablename: "x_acme_request",
      fieldname: "short_description",
      documentkey: "c".repeat(32),
      language: "fr",
    },
  ],
  sys_translated: [
    {
      name: "x_acme_request",
      element: "u_category",
      value: "Hardware",
      language: "de",
    },
    {
      name: "x_acme_request",
      element: "u_category",
      value: "Software",
      language: "fr",
    },
  ],
  sys_language: [
    { id: "en", name: "English" },
    { id: "de", name: "German" },
    { id: "fr", name: "French" },
  ],
  sys_ux_macroponent: [
    {
      sys_id: MP_ID,
      name: "Home",
      composition,
      required_translations: JSON.stringify(["Declared only"]),
    },
  ],
  ...overrides,
});

const route = (t) => (url) => {
  const u = new URL(url);
  const m = /\/api\/now\/table\/([^/?]+)/.exec(u.pathname);
  let entry = m ? t[m[1]] : [];
  if (typeof entry === "function") {
    entry = entry(u.searchParams.get("sysparm_query") ?? "");
  }
  if (typeof entry === "number") {
    return jsonResponse(entry, { error: { message: `status ${entry}` } });
  }
  return jsonResponse(200, { result: entry ?? [] });
};

const byCat = (lang) =>
  Object.fromEntries(lang.categories.map((c) => [c.category, c]));

test("a partial de translation lists exactly the missing keys per category (done when)", async () => {
  freshRuntime();
  await withMetadataFetch(route(tables()), async () => {
    const r = await i18nCoverage({ scope: "x_acme" });
    assert.equal(r.languageSource, "sys_language");
    assert.deepEqual(
      r.languages.map((l) => [l.language, l.name]),
      [
        ["de", "German"],
        ["fr", "French"],
      ],
      "the base language is left out of the default list",
    );
    assert.equal(r.macroponents, 1);
    const de = byCat(r.languages[0]);
    assert.deepEqual(de.messages.sample, ["Bye"]);
    assert.deepEqual(de.labels.sample, ["x_acme_request.state"]);
    assert.deepEqual(de.choices.sample, ["x_acme_request.state.2"]);
    assert.deepEqual(de.translatedText.sample, [
      `x_acme_request.short_description.${"c".repeat(32)}`,
    ]);
    assert.deepEqual(de.translatedFields.sample, [
      "x_acme_request.u_category.Software",
    ]);
    assert.deepEqual(de.uibStrings.sample, ["Declared only", "Save record"]);
    assert.equal(de.uibStrings.total, 3);
    assert.equal(de.uibStrings.translated, 1);
    const l = r.languages[0];
    assert.equal(l.translated + l.missing, l.total);
    assert.equal(l.total, 2 + 2 + 2 + 1 + 2 + 3);
    const fr = byCat(r.languages[1]);
    assert.equal(fr.translatedText.missing, 0);
    assert.deepEqual(fr.translatedFields.sample, [
      "x_acme_request.u_category.Hardware",
    ]);
    assert.deepEqual(fr.messages.sample, ["Hello"]);
    assert.ok(r.sources.every((s) => s.status === "read"));
    assert.ok(r.caveats.includes(I18N_CAVEAT));
  });
});

test("given languages override sys_language; macroponents alone skip the scope sources", async () => {
  freshRuntime();
  const queries = [];
  await withMetadataFetch(
    (url) => {
      queries.push(new URL(url).pathname);
      return route(tables())(url);
    },
    async () => {
      const r = await i18nCoverage({
        macroponents: [MP_ID, "not-an-id"],
        languages: ["DE", "de", "x!"],
        sampleSize: 1,
      });
      assert.equal(r.languageSource, "given");
      assert.deepEqual(
        r.languages.map((l) => l.language),
        ["de"],
      );
      const skipped = r.sources.filter((s) => s.status === "skipped");
      assert.deepEqual(
        skipped.map((s) => s.category),
        ["messages", "labels", "choices", "translatedText", "translatedFields"],
      );
      const c = r.languages[0].categories;
      assert.equal(c.length, 1);
      assert.equal(c[0].category, "uibStrings");
      assert.equal(c[0].missing, 2);
      assert.deepEqual(c[0].sample, ["Declared only"]);
      assert.ok(r.caveats.some((x) => /not sys_ids/.test(x)));
      assert.ok(r.caveats.some((x) => /language codes/.test(x)));
      assert.ok(!queries.some((p) => /sys_language|sys_db_object/.test(p)));
    },
  );
});

test("unreadable tables degrade per category with caveats", async () => {
  freshRuntime();
  await withMetadataFetch(
    route(
      tables({ sys_choice: 403, sys_language: 403, sys_translated_text: 500 }),
    ),
    async () => {
      const r = await i18nCoverage({ scope: "x_acme" });
      const status = Object.fromEntries(
        r.sources.map((s) => [s.category, s.status]),
      );
      assert.equal(status.choices, "unreadable");
      assert.equal(status.translatedText, "unreadable");
      assert.equal(status.labels, "read");
      assert.equal(r.languageSource, "observed");
      assert.deepEqual(
        r.languages.map((l) => l.language),
        ["de", "fr"],
      );
      assert.ok(
        r.languages.every(
          (l) =>
            !l.categories.some((c) =>
              ["choices", "translatedText"].includes(c.category),
            ),
        ),
      );
      assert.ok(r.caveats.some((c) => /sys_choice could not be read/.test(c)));
      assert.ok(r.caveats.some((c) => /sys_language/.test(c)));
    },
  );
});

test("an unreadable sys_db_object leaves labels, choices, translated text and translated fields unreadable", async () => {
  freshRuntime();
  await withMetadataFetch(route(tables({ sys_db_object: 403 })), async () => {
    const r = await i18nCoverage({ scope: "x_acme", languages: ["de"] });
    const status = Object.fromEntries(
      r.sources.map((s) => [s.category, s.status]),
    );
    assert.equal(status.messages, "read");
    assert.equal(status.labels, "unreadable");
    assert.equal(status.choices, "unreadable");
    assert.equal(status.translatedText, "unreadable");
    assert.equal(status.translatedFields, "unreadable");
    assert.equal(status.uibStrings, "read");
    assert.ok(r.caveats.some((c) => /sys_db_object/.test(c)));
  });
});

test("neither scope nor macroponents is an input error", async () => {
  await assert.rejects(() => i18nCoverage({}), /scope or macroponent/);
});

test("i18nCoverageMarkdown: sources, a coverage table and the missing samples", async () => {
  freshRuntime();
  await withMetadataFetch(route(tables()), async () => {
    const r = await i18nCoverage({ scope: "x_acme" });
    const md = i18nCoverageMarkdown(r);
    assert.match(md, /^# Translation coverage/);
    assert.match(md, /## Sources/);
    assert.match(md, /\| de \(German\) \| \d+ \| \d+ \| 12 \| \d+ % \|/);
    assert.match(md, /## Missing: de/);
    assert.match(md, /- UIB strings: 2 of 3 — `Declared only`, `Save record`/);
    assert.match(md, /## Caveats/);
  });
});
