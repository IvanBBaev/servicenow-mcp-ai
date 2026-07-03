import test from "node:test";
import assert from "node:assert/strict";

import {
  adfFromText,
  adfToText,
  toAdf,
  expectJira,
  expectJiraArray,
} from "../build/api/jira/shared.js";
import { JiraError } from "../build/core/errors.js";

test("adfFromText wraps a single line into a minimal doc", () => {
  const doc = adfFromText("hello");
  assert.equal(doc.type, "doc");
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.content, [
    { type: "paragraph", content: [{ type: "text", text: "hello" }] },
  ]);
});

test("adfFromText emits one paragraph per line", () => {
  const doc = adfFromText("a\nb");
  assert.equal(doc.content.length, 2);
  assert.equal(doc.content[0].content[0].text, "a");
  assert.equal(doc.content[1].content[0].text, "b");
});

test("adfFromText represents a blank line as an empty paragraph", () => {
  const doc = adfFromText("a\n\nb");
  assert.deepEqual(doc.content[1], { type: "paragraph" });
});

test("adfFromText normalises Windows CRLF line endings", () => {
  const doc = adfFromText("line1\r\nline2");
  // No stray carriage return should leak into the text nodes.
  assert.equal(doc.content[0].content[0].text, "line1");
  assert.equal(doc.content[1].content[0].text, "line2");
});

test("adfFromText turns an empty string into one empty paragraph", () => {
  assert.deepEqual(adfFromText("").content, [{ type: "paragraph" }]);
});

test("adfToText flattens paragraphs and headings with line breaks", () => {
  const doc = adfFromText("a\nb");
  assert.equal(adfToText(doc), "a\nb\n");
});

test("adfToText handles text, hardBreak and mention nodes", () => {
  assert.equal(adfToText({ type: "text", text: "hi" }), "hi");
  assert.equal(adfToText({ type: "hardBreak" }), "\n");
  assert.equal(
    adfToText({ type: "mention", attrs: { text: "@alice" } }),
    "@alice",
  );
  assert.equal(adfToText({ type: "mention" }), "");
});

test("adfToText recurses into unknown node types so no text is dropped", () => {
  const node = {
    type: "weirdCustomNode",
    content: [{ type: "text", text: "kept" }],
  };
  assert.equal(adfToText(node), "kept");
});

test("adfToText surfaces smart-link URLs (inlineCard / blockCard)", () => {
  assert.equal(
    adfToText({ type: "inlineCard", attrs: { url: "https://example.com/x" } }),
    "https://example.com/x",
  );
  assert.equal(
    adfToText({ type: "blockCard", attrs: { url: "https://example.com/y" } }),
    "https://example.com/y\n",
  );
  // A card with no resolvable URL contributes nothing rather than throwing.
  assert.equal(adfToText({ type: "inlineCard" }), "");
  // A document whose only content is a smart link is no longer blank.
  const doc = {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          { type: "inlineCard", attrs: { url: "https://example.com" } },
        ],
      },
    ],
  };
  assert.equal(adfToText(doc), "https://example.com\n");
});

test("adfToText tolerates null, primitives, strings and arrays", () => {
  assert.equal(adfToText(null), "");
  assert.equal(adfToText(undefined), "");
  assert.equal(adfToText(42), "");
  assert.equal(adfToText("raw"), "raw");
  assert.equal(
    adfToText([
      { type: "text", text: "x" },
      { type: "text", text: "y" },
    ]),
    "xy",
  );
});

test("toAdf wraps a string and passes an ADF object through untouched", () => {
  assert.equal(toAdf("hi").type, "doc");
  const custom = { type: "doc", version: 1, content: [] };
  assert.equal(toAdf(custom), custom);
});

test("toAdf rejects arrays and non-object values", () => {
  assert.throws(() => toAdf([]), JiraError);
  assert.throws(() => toAdf([{ type: "text" }]), JiraError);
  assert.throws(() => toAdf(null), JiraError);
  assert.throws(() => toAdf(42), JiraError);
});

test("expectJira returns a plain object and rejects everything else", () => {
  const obj = { id: "1" };
  assert.equal(expectJira(obj, "issue"), obj);
  assert.throws(() => expectJira(null, "issue"), /Unexpected response/);
  assert.throws(() => expectJira(undefined, "issue"), /Unexpected response/);
  assert.throws(() => expectJira([], "issue"), /Unexpected response/);
  assert.throws(() => expectJira("str", "issue"), /Unexpected response/);
});

test("expectJiraArray returns arrays (incl. empty) and rejects everything else", () => {
  const arr = [{ id: "10000" }];
  assert.equal(expectJiraArray(arr, "attachments"), arr);
  assert.deepEqual(expectJiraArray([], "attachments"), []);
  assert.throws(
    () => expectJiraArray({ id: "1" }, "attachments"),
    /Unexpected/,
  );
  assert.throws(() => expectJiraArray(null, "attachments"), /Unexpected/);
  assert.throws(() => expectJiraArray("str", "attachments"), /Unexpected/);
});
