// S-11 — file-based delivery for large results: format:"file" on
// query_table / snapshot / compare (exports/), the Mermaid generators
// (diagrams/<name>.mmd, ID-14), fetchAll `onPage` streaming, the oversize
// note (never a silent truncation) and the SN_OVERSIZE_TO_FILE gate.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { queryTable } from "../build/api/table.js";
import { openDocStream } from "../build/api/docs.js";
import { clearSchemaCache } from "../build/core/cache.js";
import { readWriteJournal } from "../build/core/write-journal.js";
import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import {
  PREVIEW_CHARS,
  deliverJson,
  previewOf,
  safeFileName,
  summarize,
} from "../build/mcp/file-result.js";
import { lintMermaid } from "./mermaid-lint.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

const DOCS_DIR = mkdtempSync(path.join(tmpdir(), "sn-s11-"));
process.env.SN_DOCS_DIR = DOCS_DIR;
baselineEnv();

test.beforeEach(() => {
  freshRuntime();
  clearSchemaCache();
});
test.after(() => rmSync(DOCS_DIR, { recursive: true, force: true }));

const tool = (name) => {
  const spec = ALL_TOOLS.find((s) => s.name === name);
  assert.ok(spec, `missing tool ${name}`);
  return spec;
};
const call = (name, args) => runSpec(tool(name), args);
const out = (res) => JSON.parse(res.content[0].text);
const exportsDir = path.join(DOCS_DIR, "default", "exports");
const listExports = () => {
  try {
    return readdirSync(exportsDir);
  } catch {
    return [];
  }
};

/** Rows s00…sNN (sys_ids sort in row order). */
const rows = (n, extra = () => ({})) =>
  Array.from({ length: n }, (_, i) => ({
    sys_id: `s${String(i).padStart(3, "0")}`,
    n: i,
    ...extra(i),
  }));

/** A Table API list endpoint honouring `sys_id>X`, fields, limit/offset. */
const listHandler = (all) => (url) => {
  const u = new URL(url);
  const q = u.searchParams.get("sysparm_query") ?? "";
  const cursor = /(?:^|\^)sys_id>([^^]+)/.exec(q)?.[1];
  const matching = all.filter((r) => cursor === undefined || r.sys_id > cursor);
  const limit = Number(u.searchParams.get("sysparm_limit"));
  const offset = Number(u.searchParams.get("sysparm_offset") ?? "0");
  const fields = u.searchParams.get("sysparm_fields")?.split(",");
  const page = matching
    .slice(offset, offset + limit)
    .map((r) =>
      fields
        ? Object.fromEntries(fields.filter((f) => f in r).map((f) => [f, r[f]]))
        : { ...r },
    );
  return jsonResponse(
    200,
    { result: page },
    { "x-total-count": String(matching.length) },
  );
};

// --- fetchAll onPage ---------------------------------------------------------

test("onPage streams each page and accumulates nothing", async () => {
  await withFetch(listHandler(rows(5)), async () => {
    const pages = [];
    const res = await queryTable({
      table: "incident",
      fields: ["n"],
      fetchAll: true,
      limit: 2,
      onPage: (page) => {
        pages.push(page.map((r) => ({ ...r })));
      },
    });
    assert.deepEqual(res.records, []);
    assert.equal(res.total, 5);
    assert.deepEqual(
      pages.map((p) => p.map((r) => r.n)),
      [[0, 1], [2, 3], [4]],
    );
    // The cursor-only sys_id is stripped before the page is handed over.
    assert.ok(pages.flat().every((r) => !("sys_id" in r)));
  });
});

test("onPage honours the SN_MAX_RECORDS cap and awaits the callback", async () => {
  await withEnv({ SN_MAX_RECORDS: "3" }, () =>
    withFetch(listHandler(rows(10)), async () => {
      const seen = [];
      const res = await queryTable({
        table: "incident",
        fetchAll: true,
        limit: 2,
        onPage: async (page) => {
          await new Promise((r) => setImmediate(r));
          seen.push(...page.map((r) => r.n));
        },
      });
      assert.deepEqual(seen, [0, 1, 2]);
      assert.equal(res.truncated, true);
      assert.equal(res.truncatedReason, "cap");
    }),
  );
});

test("onPage keeps the exact filtered count of a keyset read", async () => {
  // Every third row is withheld after paging (row-level ACL).
  const all = rows(9);
  const handler = (url) => {
    const res = listHandler(all)(url);
    return res
      .json()
      .then((body) =>
        jsonResponse(
          200,
          { result: body.result.filter((r) => r.n % 3 !== 2) },
          { "x-total-count": res.headers.get("x-total-count") },
        ),
      );
  };
  await withFetch(handler, async () => {
    let count = 0;
    const res = await queryTable({
      table: "incident",
      fetchAll: true,
      limit: 3,
      onPage: (page) => {
        count += page.length;
      },
    });
    assert.equal(count, 6);
    assert.equal(res.filtered, 3);
  });
});

// --- query_table format:"file" ----------------------------------------------

test('query_table format:"file" streams a guarded CSV into exports/', async () => {
  const data = rows(5, (i) => ({
    short_description: i === 1 ? "=HYPERLINK(1)" : `row, ${i}`,
  }));
  await withFetch(listHandler(data), async () => {
    const res = out(
      await call("servicenow_query_table", {
        table: "incident",
        fields: ["n", "short_description"],
        fetchAll: true,
        limit: 2,
        format: "file",
      }),
    );
    assert.equal(res.format, "file");
    assert.equal(res.file_format, "csv");
    assert.equal(res.rows, 5);
    assert.equal(res.total, 5);
    assert.deepEqual(res.columns, ["n", "short_description"]);
    assert.deepEqual(res._meta.csv, { escaped: 1, bom: true });
    assert.match(res.path, /^default\/exports\/incident-.*\.csv$/);
    assert.equal(res.file, path.resolve(DOCS_DIR, res.path));
    const text = readFileSync(res.file, "utf8");
    assert.equal(Buffer.byteLength(text), res.bytes);
    assert.equal(res.preview, text);
    assert.equal(res.preview_truncated, undefined);
    const lines = text.replace(/^\uFEFF/, "").split("\n");
    assert.ok(text.startsWith("\uFEFF"), "one BOM at the start");
    assert.equal(text.lastIndexOf("\uFEFF"), 0, "BOM written once");
    assert.deepEqual(lines, [
      "n,short_description",
      '0,"row, 0"',
      "1,'=HYPERLINK(1)",
      '2,"row, 2"',
      '3,"row, 3"',
      '4,"row, 4"',
    ]);
    // Local writes are journalled like every docs-store write (L2-04).
    const journal = readWriteJournal({ limit: 50 });
    const entry = journal.entries.find(
      (e) => e.action === "local_write" && e.target === `docs/${res.path}`,
    );
    assert.ok(entry, "local_write journalled");
    assert.equal(entry.bytes, res.bytes);
  });
});

test("query_table file export: jsonl, redaction, long preview", async () => {
  const data = rows(60, (i) => ({
    email: `user${i}@example.com`,
    pad: "x".repeat(40),
  }));
  await withEnv({ SN_REDACT_FIELDS: "email" }, () =>
    withFetch(listHandler(data), async () => {
      const res = out(
        await call("servicenow_query_table", {
          table: "incident",
          fetchAll: true,
          limit: 25,
          format: "file",
          fileFormat: "jsonl",
        }),
      );
      assert.equal(res.file_format, "jsonl");
      assert.equal(res.rows, 60);
      assert.equal(res.redacted, 60);
      assert.equal(res.columns, undefined);
      const text = readFileSync(res.file, "utf8");
      const lines = text
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      assert.equal(lines.length, 60);
      assert.ok(lines.every((r) => r.email === "[redacted]"));
      assert.equal(lines[59].sys_id, "s059", "all keys kept in jsonl");
      assert.equal(res.preview.length, PREVIEW_CHARS);
      assert.equal(res.preview_truncated, true);
      assert.equal(res.preview, text.slice(0, PREVIEW_CHARS));
      assert.ok(!text.includes("@example.com"));
    }),
  );
});

test("query_table file export: single page, header from first page keys, cap note", async () => {
  await withEnv({ SN_CSV_BOM: "0", SN_MAX_RECORDS: "2" }, () =>
    withFetch(listHandler(rows(3)), async () => {
      const single = out(
        await call("servicenow_query_table", {
          table: "incident",
          limit: 3,
          format: "file",
        }),
      );
      assert.equal(single.rows, 3);
      assert.deepEqual(single.columns, ["sys_id", "n"]);
      assert.equal(
        readFileSync(single.file, "utf8"),
        "sys_id,n\ns000,0\ns001,1\ns002,2",
      );
      const capped = out(
        await call("servicenow_query_table", {
          table: "incident",
          fetchAll: true,
          format: "file",
        }),
      );
      assert.equal(capped.rows, 2);
      assert.equal(capped.truncated, true);
      assert.match(capped.note, /SN_MAX_RECORDS/);
    }),
  );
});

test("query_table file export of no rows writes the header only", async () => {
  await withFetch(listHandler([]), async () => {
    const res = out(
      await call("servicenow_query_table", {
        table: "incident",
        fields: ["number", "state"],
        fetchAll: true,
        format: "file",
      }),
    );
    assert.equal(res.rows, 0);
    assert.equal(readFileSync(res.file, "utf8"), "\uFEFFnumber,state");
  });
});

test("a failed file export leaves no file behind", async () => {
  const before = listExports().length;
  await withFetch(
    () => jsonResponse(500, { error: { message: "boom" } }),
    async () => {
      const res = await call("servicenow_query_table", {
        table: "incident_fail",
        fetchAll: true,
        format: "file",
      });
      assert.equal(res.isError, true);
    },
  );
  const after = listExports();
  assert.equal(after.length, before);
  assert.ok(!after.some((f) => f.includes("incident_fail")));
  assert.ok(!after.some((f) => f.endsWith(".part")));
});

test("inline query truncation names format:file (never silent)", async () => {
  await withEnv({ SN_MAX_RESULT_CHARS: "400" }, () =>
    withFetch(listHandler(rows(50)), async () => {
      const res = out(
        await call("servicenow_query_table", { table: "incident", limit: 50 }),
      );
      assert.equal(res.truncated, true);
      assert.match(res.note, /format:"file"/);
    }),
  );
});

// --- the stream writer's confinement -----------------------------------------

test("openDocStream confines paths and refuses the journal", async () => {
  await assert.rejects(openDocStream("../escape.csv", [".csv"]), /escapes/);
  await assert.rejects(
    openDocStream("default/exports/x.exe", [".csv"]),
    /Only \.csv/,
  );
  await assert.rejects(
    openDocStream("default/write-journal.csv", [".csv"]),
    /write journal/,
  );
  await assert.rejects(openDocStream("default/a:b.csv", [".csv"]), /":"/);
});

test("openDocStream abort removes the partial file; double close fails", async () => {
  const s = await openDocStream("default/exports/aborted.csv", [".csv"]);
  await s.write("partial");
  await s.abort();
  await s.abort(); // idempotent
  assert.ok(!listExports().some((f) => f.startsWith("aborted")));
  await assert.rejects(s.write("more"), /already closed/);

  const t = await openDocStream("default/exports/closed.csv", [".csv"]);
  await t.write("");
  const done = await t.close();
  assert.equal(done.bytes, 0);
  await assert.rejects(t.close(), /already closed/);
});

// --- helpers ------------------------------------------------------------------

test("safeFileName, previewOf and summarize", () => {
  assert.equal(safeFileName("../etc/passwd"), "etc_passwd");
  assert.equal(safeFileName("..."), "export");
  assert.equal(safeFileName("a".repeat(200)).length, 80);
  assert.deepEqual(previewOf("abc"), { preview: "abc" });
  const long = previewOf("y".repeat(PREVIEW_CHARS + 1));
  assert.equal(long.preview.length, PREVIEW_CHARS);
  assert.equal(long.preview_truncated, true);
  assert.deepEqual(
    summarize({
      a: "x",
      b: 2,
      c: true,
      d: [1, 2],
      e: { k: 1 },
      f: "z".repeat(201),
    }),
    { a: "x", b: 2, c: true, d_count: 2 },
  );
});

test("deliverJson: inline, oversize note, gated auto-file", async () => {
  const data = {
    a: "dev",
    b: "prod",
    items: Array.from({ length: 50 }, (_, i) => `item-${i}`),
  };
  const small = out(await deliverJson(data, "compare-dev-vs-prod", undefined));
  assert.deepEqual(small, data);

  await withEnv({ SN_MAX_RESULT_CHARS: "100" }, async () => {
    const noted = out(await deliverJson(data, "compare-dev-vs-prod", "json"));
    assert.deepEqual(noted.items, data.items, "content unchanged");
    assert.match(noted.note, /over SN_MAX_RESULT_CHARS \(100\).*format:"file"/);

    await withEnv({ SN_OVERSIZE_TO_FILE: "true" }, async () => {
      const auto = out(
        await deliverJson(data, "compare-dev-vs-prod", undefined),
      );
      assert.equal(auto.format, "file");
      assert.equal(auto.items_count, 50);
      assert.match(auto.note, /SN_OVERSIZE_TO_FILE/);
      assert.match(
        auto.path,
        /^default\/exports\/compare-dev-vs-prod-.*\.json$/,
      );
      assert.deepEqual(JSON.parse(readFileSync(auto.file, "utf8")), data);
    });
  });
});

// --- snapshot / compare tools ----------------------------------------------

const emptyInstance = (url) =>
  new URL(url).pathname.includes("/stats/")
    ? jsonResponse(200, { result: { stats: { count: "0" } } })
    : jsonResponse(200, { result: [] });

test('snapshot_instance format:"file" writes the result JSON to exports/', async () => {
  await withFetch(emptyInstance, async () => {
    const res = out(
      await call("servicenow_snapshot_instance", {
        sections: ["tables"],
        format: "file",
      }),
    );
    assert.equal(res.format, "file");
    assert.equal(res.profile, "default");
    assert.ok(res.files_count >= 1);
    assert.match(res.path, /^default\/exports\/snapshot-.*\.json$/);
    const full = JSON.parse(readFileSync(res.file, "utf8"));
    assert.equal(full.profile, "default");
    assert.ok(Array.isArray(full.files));
    assert.equal(
      res.preview,
      readFileSync(res.file, "utf8").slice(0, PREVIEW_CHARS),
    );
  });
});

test('compare_instances format:"file" writes under the active profile', async () => {
  await withEnv(
    {
      SN_PROFILE_PROD_INSTANCE: "prod99999.service-now.com",
      SN_PROFILE_PROD_USER: "prod.user",
      SN_PROFILE_PROD_PASSWORD: "pr0d",
    },
    () =>
      withFetch(emptyInstance, async () => {
        const res = out(
          await call("servicenow_compare_instances", {
            a: "default",
            b: "prod",
            format: "file",
          }),
        );
        assert.equal(res.format, "file", JSON.stringify(res));
        assert.equal(res.a, "default");
        assert.equal(res.b, "prod");
        assert.match(
          res.path,
          /^default\/exports\/compare-default-vs-prod-.*\.json$/,
        );
        const full = JSON.parse(readFileSync(res.file, "utf8"));
        assert.ok(Array.isArray(full.caveats));
      }),
  );
});

// --- generators (ID-14) --------------------------------------------------------

/** sys_dictionary with `n` columns on one table (plus a reference). */
const wideTable = (n) => (url) => {
  const u = new URL(url);
  if (u.pathname.includes("/table/sys_db_object")) {
    return jsonResponse(200, { result: [] });
  }
  return jsonResponse(200, {
    result: [
      {
        element: "sys_id",
        internal_type: "GUID",
        reference: "",
        name: "u_wide",
      },
      {
        element: "caller_id",
        internal_type: "reference",
        reference: "sys_user",
        name: "u_wide",
      },
      ...Array.from({ length: n }, (_, i) => ({
        element: `u_column_${i}`,
        column_label: `Column ${i}`,
        internal_type: "string",
        reference: "",
        mandatory: i % 7 === 0 ? "true" : "false",
        name: "u_wide",
      })),
    ],
  });
};

test("a 300-column ER diagram crosses the cap into diagrams/<name>.mmd", async () => {
  const args = {
    tables: ["u_wide"],
    columns: "all",
    max_columns: 400,
  };
  await withEnv(
    { SN_MAX_RESULT_CHARS: "5000", SN_OVERSIZE_TO_FILE: "true" },
    () =>
      withFetch(wideTable(300), async () => {
        const res = await call("servicenow_generate_er_diagram", args);
        assert.ok(res.content[0].text.length < 5000, "result under the cap");
        const body = out(res);
        assert.equal(body.format, "file");
        assert.equal(body.mermaid, undefined);
        assert.equal(body.path, "default/diagrams/er-u_wide.mmd");
        assert.equal(body.preview.length, PREVIEW_CHARS);
        assert.equal(body.preview_truncated, true);
        assert.match(body.note, /SN_OVERSIZE_TO_FILE/);
        const text = readFileSync(body.file, "utf8");
        assert.equal(Buffer.byteLength(text), body.bytes);
        assert.ok(text.startsWith(body.preview));
        lintMermaid(text);
        for (const i of [0, 150, 299])
          assert.match(text, new RegExp(`u_column_${i}\\b`));
        // Not a Markdown document: the docs index does not list it.
        const index = JSON.parse(
          readFileSync(path.join(DOCS_DIR, "index.json"), "utf8"),
        );
        assert.ok(!JSON.stringify(index).includes("er-u_wide"));
      }),
  );
  // Under the cap the same diagram stays inline.
  await withEnv({ SN_OVERSIZE_TO_FILE: "true" }, () =>
    withFetch(wideTable(3), async () => {
      const body = out(await call("servicenow_generate_er_diagram", args));
      assert.match(body.mermaid, /^erDiagram/);
      assert.equal(body.path, undefined);
      assert.equal(body.note, undefined);
    }),
  );
  // Over the cap without the gate: returned in full, with a note.
  await withEnv({ SN_MAX_RESULT_CHARS: "5000" }, () =>
    withFetch(wideTable(300), async () => {
      const body = out(await call("servicenow_generate_er_diagram", args));
      assert.match(body.mermaid, /u_column_299/);
      assert.match(body.note, /format:"file"/);
    }),
  );
});

test('generate_table_flow format:"file" writes flow-<table>-<op>.mmd', async () => {
  await withFetch(
    () => jsonResponse(200, { result: [] }),
    async () => {
      const body = out(
        await call("servicenow_generate_table_flow", {
          table: "incident",
          operation: "insert",
          format: "file",
        }),
      );
      assert.equal(body.format, "file");
      assert.equal(body.table, "incident");
      assert.equal(body.path, "default/diagrams/flow-incident-insert.mmd");
      const text = readFileSync(body.file, "utf8");
      assert.equal(body.preview, text);
      lintMermaid(text);
    },
  );
});
