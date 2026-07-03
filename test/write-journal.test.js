// GA-5: dedicated coverage for core/write-journal.ts — the entry shape, the
// jsonl/md files it appends under <SN_DOCS_DIR>/<profile>/, append-only
// semantics and profile routing. (The best-effort never-throws contract is
// pinned in coverage-extra.test.js.)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { appendWriteJournal } from "../build/core/write-journal.js";
import { baselineEnv, withEnv } from "./helpers.js";

baselineEnv();

const tempDocsDir = () => mkdtempSync(path.join(tmpdir(), "snmcp-journal-"));

test("appendWriteJournal stamps ts + profile and writes both files", async () => {
  const dir = tempDocsDir();
  try {
    await withEnv({ SN_DOCS_DIR: dir }, () => {
      const entry = appendWriteJournal({
        action: "create",
        table: "incident",
        sys_id: "abc123",
        fields: { short_description: "boom", urgency: 1 },
      });

      assert.equal(entry.profile, "default");
      assert.equal(entry.action, "create");
      // ts is a real ISO-8601 instant, not just any string.
      assert.equal(new Date(entry.ts).toISOString(), entry.ts);

      const jsonl = readFileSync(
        path.join(dir, "default", "write-journal.jsonl"),
        "utf8",
      );
      assert.deepEqual(JSON.parse(jsonl.trim()), entry);

      const md = readFileSync(
        path.join(dir, "default", "write-journal.md"),
        "utf8",
      );
      // target is table/sys_id; fields column lists the keys only (no values —
      // the values may hold data the journal must not duplicate in Markdown).
      assert.ok(
        md.includes(
          `| create | incident/abc123 | short_description, urgency |`,
        ),
        md,
      );
      assert.ok(!md.includes("boom"));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("append-only: entries accumulate; no-fields rows render an em dash", async () => {
  const dir = tempDocsDir();
  try {
    await withEnv({ SN_DOCS_DIR: dir }, () => {
      appendWriteJournal({ action: "delete", table: "incident", sys_id: "x1" });
      appendWriteJournal({ action: "execute", table: "sys_script_include" });

      const lines = readFileSync(
        path.join(dir, "default", "write-journal.jsonl"),
        "utf8",
      )
        .trim()
        .split("\n");
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]).action, "delete");
      assert.equal(JSON.parse(lines[1]).action, "execute");

      const md = readFileSync(
        path.join(dir, "default", "write-journal.md"),
        "utf8",
      );
      assert.ok(md.includes("| delete | incident/x1 | — |"), md);
      // Without a sys_id the target is the bare table name.
      assert.ok(md.includes("| execute | sys_script_include | — |"), md);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("entries are routed to the active profile's directory", async () => {
  const dir = tempDocsDir();
  try {
    await withEnv({ SN_DOCS_DIR: dir, SN_ACTIVE_PROFILE: "dev" }, () => {
      const entry = appendWriteJournal({
        action: "update",
        table: "problem",
        sys_id: "p1",
        fields: { state: 2 },
      });
      assert.equal(entry.profile, "dev");
      const jsonl = readFileSync(
        path.join(dir, "dev", "write-journal.jsonl"),
        "utf8",
      );
      assert.equal(JSON.parse(jsonl.trim()).profile, "dev");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
