// N-7 — the `i18n` kind of servicenow_document_app: translation coverage of
// one scoped app as i18n/<scope>.md + .json.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateDocument } from "../build/api/document.js";
import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import {
  baselineEnv,
  freshRuntime,
  jsonResponse,
  withEnv,
  withMetadataFetch,
} from "./helpers.js";

baselineEnv();

const FIXTURES = path.join(import.meta.dirname, "fixtures", "docs");

function golden(name, actual) {
  const file = path.join(FIXTURES, name);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, actual.endsWith("\n") ? actual : `${actual}\n`);
    return;
  }
  const expected = readFileSync(file, "utf8");
  assert.equal(`${actual}\n`.replace(/\n\n$/, "\n"), expected, name);
}

const MP_ID = "b".repeat(32);

/** A scoped app with a partial German and French translation. */
const TABLES = {
  sys_db_object: [{ name: "x_acme_request" }],
  sys_ui_message: (q) =>
    q.startsWith("sys_scope")
      ? [
          { key: "Hello", language: "en" },
          { key: "Hello", language: "de" },
          { key: "Bye", language: "en" },
          { key: "Bye", language: "fr" },
        ]
      : [{ key: "Welcome", language: "de" }],
  sys_documentation: [
    { name: "x_acme_request", element: "", language: "en" },
    { name: "x_acme_request", element: "", language: "de" },
    { name: "x_acme_request", element: "state", language: "en" },
  ],
  sys_choice: [
    { name: "x_acme_request", element: "state", value: "1", language: "de" },
    { name: "x_acme_request", element: "state", value: "2", language: "en" },
  ],
  sys_translated_text: [],
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
      composition: JSON.stringify([
        { elementId: "header", propertyValues: { title: "Welcome" } },
        { elementId: "save", propertyValues: { label: "Save record" } },
      ]),
    },
  ],
};

const route = (url) => {
  const u = new URL(url);
  const m = /\/api\/now\/table\/([^/?]+)/.exec(u.pathname);
  let entry = m ? TABLES[m[1]] : [];
  if (typeof entry === "function") {
    entry = entry(u.searchParams.get("sysparm_query") ?? "");
  }
  return jsonResponse(200, { result: entry ?? [] });
};

const documentApp = (args) =>
  runSpec(
    ALL_TOOLS.find((s) => s.name === "servicenow_document_app"),
    args,
  );

test("a partial de translation lists exactly the missing keys (done when, golden)", async () => {
  freshRuntime();
  await withMetadataFetch(route, async () => {
    const doc = await generateDocument("i18n", "x_acme", {
      write: false,
      language: "de",
    });
    assert.equal(doc.kind, "i18n");
    assert.match(doc.path, /\/i18n\/x_acme\.md$/);
    const md = doc.markdown;
    assert.match(md, /^# Translation coverage — `x_acme`$/m);
    assert.match(md, /languages from given/);
    assert.match(md, /^## Missing: de$/m);
    assert.doesNotMatch(md, /^## Missing: fr$/m, "only the given language");
    assert.match(md, /- UI messages: 1 of 2 — `Bye`/);
    assert.match(md, /- Field labels: 1 of 2 — `x_acme_request\.state`/);
    assert.match(md, /- Choices: 1 of 2 — `x_acme_request\.state\.2`/);
    assert.match(
      md,
      /- Translated fields: 1 of 2 — `x_acme_request\.u_category\.Software`/,
    );
    assert.match(md, /- UIB strings: 1 of 2 — `Save record`/);
    assert.ok(doc.caveats >= 1, "the O-5 caveat is counted");
    golden("i18n-x_acme-de.md", md);
  });
});

test("without a language every active language except the base is measured", async () => {
  freshRuntime();
  await withMetadataFetch(route, async () => {
    const doc = await generateDocument("i18n", "x_acme", { write: false });
    assert.match(doc.markdown, /languages from sys_language/);
    assert.match(doc.markdown, /^## Missing: de$/m);
    assert.match(doc.markdown, /^## Missing: fr$/m);
    assert.doesNotMatch(doc.markdown, /^## Missing: en$/m);
  });
});

test("document_app kind i18n writes i18n/<scope>.md and its JSON companion", async () => {
  freshRuntime();
  const dir = mkdtempSync(path.join(os.tmpdir(), "sn-document-i18n-"));
  await withEnv({ SN_DOCS_DIR: dir }, () =>
    withMetadataFetch(route, async () => {
      const res = await documentApp({
        scope: "x_acme",
        kind: "i18n",
        language: "de",
      });
      assert.notEqual(res.isError, true, JSON.stringify(res.content));
    }),
  );
  const md = readFileSync(path.join(dir, "default/i18n/x_acme.md"), "utf8");
  assert.match(md, /generator: servicenow_document_app/);
  assert.match(md, /^## Missing: de$/m);
  const json = JSON.parse(
    readFileSync(path.join(dir, "default/i18n/x_acme.json"), "utf8"),
  );
  assert.equal(json.scope, "x_acme");
  assert.deepEqual(
    json.languages.map((l) => l.language),
    ["de"],
  );
});

test("document_app kind i18n rejects a scope that cannot name a document", async () => {
  freshRuntime();
  await withMetadataFetch(
    () => {
      throw new Error("no read for a rejected target");
    },
    async () => {
      await assert.rejects(
        generateDocument("i18n", "../x_acme", { write: false }),
        /cannot name a document/,
      );
    },
  );
});
