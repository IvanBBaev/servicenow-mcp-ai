import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  docsList,
  docsRead,
  docsSearch,
  docsWrite,
} from "../build/api/docs.js";
import { ServiceNowError } from "../build/core/errors.js";

// Each test file runs in its own process, so a per-file temp docs dir is safe.
const DOCS_DIR = path.join(os.tmpdir(), `servicenow-mcp-docs-${process.pid}`);
process.env.SN_DOCS_DIR = DOCS_DIR;

test.before(async () => {
  await fs.rm(DOCS_DIR, { recursive: true, force: true });
});

test.after(async () => {
  await fs.rm(DOCS_DIR, { recursive: true, force: true });
});

test("docsWrite creates a file and regenerates index.md", async () => {
  const result = await docsWrite("tables/incident.md", "# Incident\n\nNotes.");
  assert.equal(result.path, "tables/incident.md");
  assert.ok(result.bytes > 0);

  const onDisk = await fs.readFile(
    path.join(DOCS_DIR, "tables", "incident.md"),
    "utf8",
  );
  assert.match(onDisk, /# Incident/);

  const index = await fs.readFile(path.join(DOCS_DIR, "index.md"), "utf8");
  assert.match(index, /\[tables\/incident\.md\]\(tables\/incident\.md\)/);
});

test("docsRead returns written content", async () => {
  await docsWrite("notes.md", "hello world");
  const { content } = await docsRead("notes.md");
  assert.equal(content, "hello world");
});

test("docsList enumerates markdown files", async () => {
  await docsWrite("a.md", "a");
  await docsWrite("sub/b.md", "b");
  const { files } = await docsList();
  assert.ok(files.includes("a.md"));
  assert.ok(files.includes("sub/b.md"));
});

test("docsSearch finds a substring with a line number", async () => {
  await docsWrite("search.md", "line one\nfind me here\nline three");
  const { matches } = await docsSearch("find me");
  const match = matches.find((m) => m.path === "search.md");
  assert.ok(match);
  assert.equal(match.line, 2);
  assert.match(match.snippet, /find me/);
});

test("docsRead rejects path traversal", async () => {
  await assert.rejects(
    () => docsRead("../escape.md"),
    (err) => {
      assert.ok(err instanceof ServiceNowError);
      assert.equal(err.status, 400);
      return true;
    },
  );
});

test("docsWrite rejects a non-markdown extension", async () => {
  await assert.rejects(
    () => docsWrite("evil.sh", "rm -rf"),
    (err) => {
      assert.ok(err instanceof ServiceNowError);
      assert.equal(err.status, 400);
      return true;
    },
  );
});

test("docsRead reports a missing document as 404", async () => {
  await assert.rejects(
    () => docsRead("does-not-exist.md"),
    (err) => {
      assert.ok(err instanceof ServiceNowError);
      assert.equal(err.status, 404);
      return true;
    },
  );
});

test("a whitespace-only document path is rejected as a 400 (QA-15)", async () => {
  for (const bad of ["   ", "\t", ""]) {
    await assert.rejects(
      () => docsRead(bad),
      (err) =>
        err instanceof ServiceNowError &&
        err.status === 400 &&
        /document path is required/.test(err.message),
    );
  }
});

test("concurrent docsWrite calls all land in index.md (DEV-3)", async () => {
  // Without serialized regeneration, an interleaved walk() drops some of these
  // entries; serialization guarantees the last rebuild sees every file.
  const names = Array.from({ length: 12 }, (_, i) => `concurrent/doc-${i}.md`);
  await Promise.all(names.map((n) => docsWrite(n, `# ${n}\n`)));
  const index = await fs.readFile(path.join(DOCS_DIR, "index.md"), "utf8");
  for (const n of names) {
    assert.match(
      index,
      new RegExp(`\\[${n}\\]\\(${n}\\)`),
      `index must list ${n}`,
    );
  }
});
