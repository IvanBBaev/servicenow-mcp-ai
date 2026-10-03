// H-5 — write journal v2 + deep redaction: v2 fields and ULIDs, the sha256
// hash chain and its head file, rotation with a reader across files, v1
// compatibility, the re-rendered Markdown mirror, failed/refused outcomes,
// before-state on apply, batch fan-out, local_write/config entries, the docs
// store guards, the result-boundary redaction and the CSV formula guard/BOM.
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv as parseEnvFile } from "node:util";
import fc from "fast-check";

import {
  appendWriteJournal,
  journaledWrite,
  readWriteJournal,
  ulid,
  writeOutcome,
} from "../build/core/write-journal.js";
import { runWithClient } from "../build/core/request-context.js";
import { ServiceNowError } from "../build/core/errors.js";
import { docsWrite, docsWriteRaw } from "../build/api/docs.js";
import { renderCsv, toCsv } from "../build/mcp/csv.js";
import { ok, fail, okStructured } from "../build/mcp/result.js";
import { captureBefore } from "../build/mcp/write-mode.js";
import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import { specs as tableSpecs } from "../build/tools/table.js";
import { specs as batchSpecs } from "../build/tools/batch.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

// E-2: Node's env-file parser (dotenv's replacement); a plain object, since
// Node 26 returns a null-prototype one that deepStrictEqual would reject.
const parseEnv = (text) => ({ ...parseEnvFile(text) });

baselineEnv();

const tool = (name) =>
  [...tableSpecs, ...batchSpecs].find((s) => s.name === name);
const out = (res) => JSON.parse(res.content[0].text);
const sha = (s) => createHash("sha256").update(s).digest("hex");

/** Run `fn(dir)` with a throw-away SN_DOCS_DIR. */
async function withDocs(env, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "snmcp-h5-"));
  try {
    return await withEnv({ SN_DOCS_DIR: dir, ...env }, () => fn(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const journalFile = (dir, name = "write-journal.jsonl") =>
  path.join(dir, "default", name);
const lines = (dir) =>
  readFileSync(journalFile(dir), "utf8").split("\n").filter(Boolean);

test("ulid: 26 Crockford base32 chars, time-sortable", () => {
  const a = ulid(1_000_000);
  const b = ulid(2_000_000);
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(a.slice(0, 10) < b.slice(0, 10));
  assert.notEqual(ulid(5), ulid(5)); // random part differs
});

test("v2 line: schema_version, id, result, client and a verifiable chain", async () => {
  await withDocs({}, (dir) => {
    const first = appendWriteJournal({ action: "create", table: "incident" });
    const second = runWithClient("session-42", () =>
      appendWriteJournal({ action: "delete", table: "incident", sys_id: "x" }),
    );
    assert.equal(first.schema_version, 2);
    assert.match(first.id, /^[0-9A-Z]{26}$/);
    assert.equal(first.result, "applied");
    assert.equal(first.prev, undefined);
    assert.equal(first.client, undefined);
    assert.equal(second.client, "session-42");

    const [l1, l2] = lines(dir);
    assert.equal(second.prev, sha(l1));
    assert.equal(
      readFileSync(journalFile(dir, "write-journal.head"), "utf8"),
      sha(l2),
    );
    const read = readWriteJournal();
    assert.equal(read.integrity, "ok");
    assert.deepEqual(read.files, ["write-journal.jsonl"]);
    assert.equal(read.entries.length, 2);
    assert.equal(readWriteJournal({ action: "delete" }).entries.length, 1);
  });
});

test("tampering breaks the chain at the first bad line", async () => {
  await withDocs({}, (dir) => {
    for (let i = 0; i < 4; i++) {
      appendWriteJournal({ action: "update", table: "t", sys_id: `r${i}` });
    }
    const ls = lines(dir);
    ls[1] = ls[1].replace('"r1"', '"rX"');
    writeFileSync(journalFile(dir), ls.join("\n") + "\n");
    // Line 2 itself still links to line 1; line 3's link no longer matches.
    assert.equal(readWriteJournal().integrity, "broken@3");

    // A truncated tail no longer matches the head file.
    const good = lines(dir).slice(0, 2);
    writeFileSync(journalFile(dir), good.join("\n") + "\n");
    assert.match(readWriteJournal().integrity, /^broken@/);

    // A line that is not JSON breaks the chain where it sits.
    writeFileSync(journalFile(dir), "not json\n");
    assert.equal(readWriteJournal().integrity, "broken@1");
  });
});

test("a missing journal reads as empty and intact", async () => {
  await withDocs({}, () => {
    assert.deepEqual(readWriteJournal({ profile: "nobody" }), {
      entries: [],
      integrity: "ok",
      files: [],
    });
  });
});

test("rotation at SN_JOURNAL_MAX_BYTES keeps the chain across files", async () => {
  await withDocs({ SN_JOURNAL_MAX_BYTES: "600" }, (dir) => {
    for (let i = 0; i < 8; i++) {
      appendWriteJournal({
        action: "create",
        table: "incident",
        sys_id: `rec${i}`,
        fields: { short_description: "x".repeat(60) },
      });
    }
    const files = readdirSync(path.join(dir, "default"));
    const rotated = files.filter((f) => /^write-journal\..+\.jsonl$/.test(f));
    assert.ok(rotated.length >= 2, files.join(","));
    const read = readWriteJournal();
    assert.equal(read.integrity, "ok");
    assert.equal(read.entries.length, 8);
    assert.deepEqual(
      read.entries.map((e) => e.sys_id),
      [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `rec${i}`),
    );
    assert.equal(read.files.at(-1), "write-journal.jsonl");
  });
});

test("v1 lines stay readable with defaults and seed the chain", async () => {
  await withDocs({}, (dir) => {
    mkdirSync(path.join(dir, "default"), { recursive: true });
    const v1 = JSON.stringify({
      ts: "2026-01-01T00:00:00.000Z",
      profile: "default",
      action: "create",
      table: "incident",
      sys_id: "old",
    });
    writeFileSync(journalFile(dir), v1 + "\n");
    const next = appendWriteJournal({ action: "update", table: "incident" });
    // No head file yet: the link falls back to the last existing line.
    assert.equal(next.prev, sha(v1));
    const read = readWriteJournal();
    assert.equal(read.integrity, "ok");
    assert.equal(read.entries[0].schema_version, 1);
    assert.equal(read.entries[0].result, "applied");
    assert.equal(read.entries[1].schema_version, 2);
  });
});

test("the Markdown mirror is re-rendered from the last 200 entries", async () => {
  await withDocs({}, (dir) => {
    for (let i = 0; i < 203; i++) {
      appendWriteJournal({ action: "create", table: `t|${i}` });
    }
    appendWriteJournal({
      action: "config",
      table: "config",
      target: "env:default",
      keys: ["SN_USER"],
    });
    const md = readFileSync(journalFile(dir, "write-journal.md"), "utf8");
    assert.match(md, /^# Write journal — default/);
    assert.ok(md.includes("| Time | Action | Target | Fields | Result |"));
    const rows = md.split("\n").filter((l) => /^\| 20/.test(l));
    assert.equal(rows.length, 200);
    assert.ok(!md.includes("t\\|3 |")); // oldest rows dropped
    assert.ok(md.includes("| create | t\\|202 | — | applied |")); // pipes escaped
    assert.ok(md.includes("| config | env:default | SN_USER | applied |"));
  });
});

test("journal values go through the redaction rules; keys stay", async () => {
  await withDocs(
    { SN_REDACT_FIELDS: "password,token", SN_REDACT_PII: "1" },
    (dir) => {
      appendWriteJournal({
        action: "update",
        table: "sys_user",
        sys_id: "u1",
        fields: { password: "hunter2", nested: { token: "t0k" } },
        before: { password: "old-pass", email: "a@example.com" },
        error: "mail bob@example.com failed",
      });
      const raw = readFileSync(journalFile(dir), "utf8");
      for (const secret of ["hunter2", "t0k", "old-pass", "@example.com"]) {
        assert.ok(!raw.includes(secret), secret);
      }
      const [entry] = readWriteJournal().entries;
      assert.equal(entry.fields.password, "[redacted]");
      assert.equal(entry.fields.nested.token, "[redacted]");
    },
  );
});

test("journaledWrite records applied, failed and refused, and rethrows", async () => {
  await withDocs({}, async () => {
    const created = await journaledWrite(
      { action: "create", table: "incident" },
      async () => ({ sys_id: "new1" }),
      (r) => ({ sys_id: r.sys_id }),
    );
    assert.equal(created.sys_id, "new1");
    await assert.rejects(
      journaledWrite({ action: "update", table: "incident" }, async () => {
        throw new ServiceNowError("ACL says no", 403);
      }),
      /ACL says no/,
    );
    await assert.rejects(
      journaledWrite({ action: "delete", table: "incident" }, async () => {
        throw "plain";
      }),
    );
    const { entries } = readWriteJournal();
    assert.deepEqual(
      entries.map((e) => [e.action, e.result, e.sys_id, e.error]),
      [
        ["create", "applied", "new1", undefined],
        ["update", "refused", undefined, "ACL says no"],
        ["delete", "failed", undefined, "plain"],
      ],
    );
    assert.equal(writeOutcome(new ServiceNowError("x", 500)), "failed");
  });
});

test("captureBefore swallows a failed read", async () => {
  assert.equal(
    await captureBefore(async () => {
      throw new Error("404");
    }),
    undefined,
  );
  assert.deepEqual(await captureBefore(async () => ({ a: 1 })), { a: 1 });
});

test("update/delete apply journal the before-state; a read-only refusal is journalled", async () => {
  await withDocs({ SN_WRITE_MODE: "apply" }, async () => {
    await withFetch(
      (url, init) => {
        if (!init?.method || init.method === "GET") {
          return jsonResponse(200, { result: { sys_id: "s1", state: "1" } });
        }
        if (init.method === "DELETE")
          return new Response(null, { status: 204 });
        return jsonResponse(200, { result: { sys_id: "s1", state: "2" } });
      },
      async () => {
        await tool("servicenow_update_record").handler({
          table: "incident",
          sys_id: "s1",
          values: { state: "2" },
        });
        await tool("servicenow_delete_record").handler({
          table: "incident",
          sys_id: "s1",
        });
      },
    );
    await withEnv({ SN_READONLY: "true" }, async () => {
      await assert.rejects(
        tool("servicenow_create_record").handler({
          table: "incident",
          values: { short_description: "x" },
        }),
        /read-only/,
      );
    });
    const { entries, integrity } = readWriteJournal();
    assert.equal(integrity, "ok");
    assert.deepEqual(entries[0].before, { sys_id: "s1", state: "1" });
    assert.equal(entries[1].action, "delete");
    assert.deepEqual(entries[1].before, { sys_id: "s1", state: "1" });
    assert.equal(entries[2].result, "refused");
  });
});

test("batch: one line per write sub-request plus the envelope, sharing batch_id", async () => {
  await withDocs({ SN_WRITE_MODE: "apply" }, async () => {
    await withFetch(
      () =>
        jsonResponse(200, {
          serviced_requests: [
            { id: "1", status_code: 200, body: "" },
            { id: "2", status_code: 200, body: "" },
            { id: "3", status_code: 403, body: "" },
            {
              id: "5",
              status_code: 201,
              body: Buffer.from(
                JSON.stringify({ result: { sys_id: "made" } }),
              ).toString("base64"),
            },
            { id: "g", status_code: 200, body: "" },
          ],
          unserviced_requests: [{ id: "6", error_message: "timeout" }],
        }),
      async () => {
        await tool("servicenow_batch").handler({
          requests: [
            {
              method: "PATCH",
              url: "/api/now/table/incident/a1",
              body: { state: "2" },
            },
            {
              method: "PUT",
              url: "/api/now/v1/table/incident/a2/",
              body: { state: "2" },
            },
            { method: "DELETE", url: "/api/now/table/incident/a3?x=1" },
            {
              method: "PATCH",
              url: "/api/now/table/incident/a4",
              body: { state: "2" },
            },
            {
              method: "POST",
              url: "/api/now/table/incident",
              body: { short_description: "n" },
            },
            {
              method: "POST",
              url: "/api/now/import/u_staging",
              body: { a: "b" },
            },
            {
              id: "g",
              method: "GET",
              url: "/api/now/table/incident?sysparm_limit=1",
            },
          ],
        });
      },
    );
    const { entries } = readWriteJournal();
    assert.equal(entries.length, 7); // envelope + 6 writes, the GET skipped
    const [envelope, ...subs] = entries;
    assert.equal(envelope.table, "batch");
    assert.equal(envelope.action, "execute");
    assert.ok(subs.every((e) => e.batch_id === envelope.batch_id));
    assert.deepEqual(
      subs.map((e) => [e.action, e.table, e.sys_id, e.result]),
      [
        ["update", "incident", "a1", "applied"],
        ["update", "incident", "a2", "applied"],
        ["delete", "incident", "a3", "refused"],
        ["update", "incident", "a4", "failed"], // no result returned
        ["create", "incident", "made", "applied"],
        ["create", "/api/now/import/u_staging", undefined, "failed"],
      ],
    );
    assert.equal(subs[0].body_sha256, sha(JSON.stringify({ state: "2" })));
    assert.equal(subs[2].body_sha256, undefined);
    assert.equal(subs[3].error, "No result returned.");
    assert.equal(subs[5].error, "timeout");
    assert.equal(subs[2].error, "HTTP 403");
  });
});

test("batch: a batch that fails outright journals only the failed envelope", async () => {
  await withDocs({ SN_WRITE_MODE: "apply" }, async () => {
    await withFetch(
      () => jsonResponse(500, { error: { message: "down" } }),
      async () => {
        await assert.rejects(
          tool("servicenow_batch").handler({
            requests: [{ method: "DELETE", url: "/api/now/table/incident/z" }],
          }),
        );
      },
    );
    const { entries } = readWriteJournal();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].result, "failed");
  });
});

test("docs store: local_write is journalled; journal files and symlink escapes are refused", async () => {
  await withDocs({}, async (dir) => {
    await docsWrite("notes/a.md", "hello");
    const [entry] = readWriteJournal().entries;
    assert.equal(entry.action, "local_write");
    assert.equal(entry.target, "docs/notes/a.md");
    assert.equal(entry.bytes, 5);
    assert.equal(entry.sha256, sha("hello"));

    await assert.rejects(
      docsWrite("default/write-journal.md", "# forged"),
      /write journal/,
    );
    await assert.rejects(
      docsWriteRaw("default/WRITE-JOURNAL.jsonl", "{}", [".jsonl"]),
      /write journal/,
    );

    const outside = mkdtempSync(path.join(tmpdir(), "snmcp-outside-"));
    try {
      symlinkSync(outside, path.join(dir, "escape"), "dir");
      await assert.rejects(
        docsWrite("escape/pwned.md", "x"),
        /through a symbolic link/,
      );
      await assert.rejects(
        docsWrite("escape/deeper/pwned.md", "x"),
        /through a symbolic link/,
      );
      assert.equal(existsSync(path.join(outside, "pwned.md")), false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("config entries carry key names only; concurrent set_credentials leaves a valid .env", async () => {
  await withDocs({}, async (dir) => {
    const envFile = path.join(dir, ".env");
    await withEnv(
      {
        SN_ENV_FILE: envFile,
        SN_ALLOW_UNCONFIRMED_CREDENTIAL_CHANGE: "1",
      },
      async () => {
        const spec = ALL_TOOLS.find(
          (s) => s.name === "servicenow_set_credentials",
        );
        const results = await Promise.all(
          ["pw-one", "pw-two", "pw-three", "pw-four"].map((password) =>
            runSpec(spec, { password }),
          ),
        );
        assert.ok(
          results.every((r) => !r.isError),
          JSON.stringify(results),
        );
        const saved = parseEnv(readFileSync(envFile, "utf8"));
        assert.ok(/^pw-/.test(saved.SN_PASSWORD));
        assert.deepEqual(
          readdirSync(dir).filter((f) => f.endsWith(".tmp")),
          [],
        );

        const use = ALL_TOOLS.find((s) => s.name === "servicenow_use_instance");
        const switched = await runSpec(use, { name: "default" });
        assert.ok(!switched.isError, JSON.stringify(switched));

        const raw = readFileSync(journalFile(dir), "utf8");
        assert.ok(!raw.includes("pw-"), "a password value reached the journal");
        const { entries } = readWriteJournal({ action: "config" });
        assert.equal(entries.length, 5);
        assert.deepEqual(entries[0].keys, ["SN_PASSWORD"]);
        assert.equal(entries[0].target, "env:default");
        assert.deepEqual(entries[4].keys, ["SN_ACTIVE_PROFILE"]);
      },
    );
  });
  baselineEnv();
});

test("redaction applies deeply at the ok / okStructured / fail boundary", async () => {
  await withEnv({ SN_REDACT_FIELDS: "password" }, () => {
    const res = ok({
      record: { user: "a", password: "p", deep: [{ password: "q" }] },
    });
    const text = res.content[0].text;
    assert.ok(!text.includes('"p"') && !text.includes('"q"'), text);
    const structured = okStructured({ nested: { password: "z" } });
    assert.equal(structured.structuredContent.nested.password, "[redacted]");
    const failed = fail(new ServiceNowError("nope", 400, { password: "leak" }));
    assert.ok(!failed.content[0].text.includes("leak"), failed.content[0].text);
  });
  // Redaction off: same data passes through untouched.
  assert.ok(ok({ password: "visible" }).content[0].text.includes("visible"));
});

test("write tools echo records through the redaction boundary", async () => {
  await withDocs(
    { SN_WRITE_MODE: "apply", SN_REDACT_FIELDS: "u_secret" },
    async () => {
      await withFetch(
        () => jsonResponse(201, { result: { sys_id: "n1", u_secret: "abc" } }),
        async () => {
          const res = await tool("servicenow_create_record").handler({
            table: "incident",
            values: { u_secret: "abc" },
          });
          assert.equal(out(res).record.u_secret, "[redacted]");
        },
      );
      assert.equal(readWriteJournal().entries[0].fields.u_secret, "[redacted]");
    },
  );
});

test("CSV: formula-like cells are neutralised and counted; BOM is optional", () => {
  const records = [
    { a: "=1+1", b: "-5", c: "  @SUM(A1)", d: "\tx", e: "plain", f: -5 },
  ];
  const r = renderCsv(records, undefined, { bom: true });
  assert.equal(r.escaped, 4);
  assert.equal(r.bom, true);
  assert.ok(r.csv.startsWith("﻿a,b,c,d,e,f\n"));
  assert.ok(r.csv.endsWith("'=1+1,'-5,'  @SUM(A1),'\tx,plain,-5"), r.csv);
  assert.equal(toCsv([{ a: "=1" }], ["a"], { formulaGuard: false }), "a\n=1");
});

test("CSV property: no guarded cell starts with a formula trigger", () => {
  fc.assert(
    fc.property(fc.string(), (value) => {
      const csv = toCsv([{ v: value }], ["v"]);
      const cell = csv.slice(2); // after "v\n"
      const unquoted = cell.startsWith('"') ? cell.slice(1) : cell;
      return (
        !/^[=+\-@\t\r]/.test(unquoted.trimStart()) || unquoted.startsWith("'")
      );
    }),
  );
});

test("query_table csv honours SN_CSV_BOM / SN_CSV_FORMULA_GUARD and reports _meta.csv", async () => {
  await withFetch(
    () =>
      jsonResponse(200, { result: [{ short_description: "=HYPERLINK(1)" }] }),
    async () => {
      const q = tool("servicenow_query_table");
      const on = out(
        await q.handler({
          table: "incident",
          fields: ["short_description"],
          format: "csv",
        }),
      );
      assert.deepEqual(on._meta, { csv: { escaped: 1, bom: true } });
      assert.ok(on.content.startsWith("﻿"));
      await withEnv(
        { SN_CSV_BOM: "0", SN_CSV_FORMULA_GUARD: "off" },
        async () => {
          const off = out(
            await q.handler({
              table: "incident",
              fields: ["short_description"],
              format: "csv",
            }),
          );
          assert.deepEqual(off._meta, { csv: { escaped: 0, bom: false } });
          assert.equal(off.content, "short_description\n=HYPERLINK(1)");
        },
      );
    },
  );
});
