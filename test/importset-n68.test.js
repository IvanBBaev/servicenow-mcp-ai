// N-68 — multi-row and file-sourced import: `servicenow_insert_import_set_row`
// takes `rows` or a CSV / JSONL `file_path` under SN_DOCS_DIR (confined like an
// upload, size-checked before the read), sends them through `insertMultiple`
// or, when the instance lacks it (404 / 405), one request per row under one
// journal envelope whose weight is the row count (H-11).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { IMPORT_MAX_ROWS, columnsOf } from "../build/api/importset.js";
import { readWriteJournal } from "../build/core/write-journal.js";
import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

const DOCS_DIR = mkdtempSync(path.join(tmpdir(), "sn-n68-docs-"));
const OUTSIDE = mkdtempSync(path.join(tmpdir(), "sn-n68-outside-"));
process.env.SN_DOCS_DIR = DOCS_DIR;
baselineEnv();
// The insert is not destructive, but the apply:true calls below run without
// the H-3 plan-token gate like the other import-set tests (s10a).
process.env.SN_DESTRUCTIVE_CONFIRM = "off";

const IN = path.join(DOCS_DIR, "in");
mkdirSync(path.join(IN, "dir.csv"), { recursive: true });
const files = {
  // BOM, CRLF, a quoted comma, doubled quotes, an embedded newline, a blank
  // line between records and an empty last field.
  "assets.csv":
    '﻿asset_tag, model ,notes\r\nP1,"ThinkPad, T14","say ""hi""\nnext"\r\n\r\nP2,Dell,\r\n',
  "assets.jsonl":
    '{"asset_tag":"P1","count":2,"ok":true,"gone":null}\n\n  \n{"asset_tag":"P2"}\n',
  "unclosed.csv": 'a,b\n1,"x\n',
  "empty.csv": "\n\n",
  "dup.csv": "a,a\n1,2\n",
  "emptycol.csv": "a,,b\n1,2,3\n",
  "short.csv": "a,b\n1\n",
  "onlyheader.csv": "a,b\n",
  "bad.jsonl": '{"a":1}\nnope\n',
  "array.jsonl": "[1]\n",
  "nested.jsonl": '{"a":{"b":1}}\n',
  "emptykey.jsonl": '{"":1}\n',
  "big.csv": `n\n${Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => i).join("\n")}\n`,
  "notes.txt": "a,b\n1,2\n",
};
for (const [name, text] of Object.entries(files))
  writeFileSync(path.join(IN, name), text);
writeFileSync(path.join(OUTSIDE, "secret.csv"), "a\n1\n");
symlinkSync(path.join(OUTSIDE, "secret.csv"), path.join(IN, "link.csv"));

test.beforeEach(() => {
  rmSync(path.join(DOCS_DIR, "default"), { recursive: true, force: true });
  freshRuntime();
});
test.after(() => {
  rmSync(DOCS_DIR, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});

const TABLE = "u_imp_assets";
const tool = (name) => {
  const spec = ALL_TOOLS.find((s) => s.name === name);
  assert.ok(spec, `missing tool ${name}`);
  return spec;
};
const insert = (args) =>
  runSpec(tool("servicenow_insert_import_set_row"), { table: TABLE, ...args });
const out = (res) => JSON.parse(res.content[0].text);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const noFetch = () => {
  throw new Error("fetch must not be called");
};
const ROWS = [
  { asset_tag: "P1", model: "ThinkPad T14" },
  { asset_tag: "P2", model: "Dell", notes: "" },
];
const CSV_ROWS = [
  { asset_tag: "P1", model: "ThinkPad, T14", notes: 'say "hi"\nnext' },
  { asset_tag: "P2", model: "Dell", notes: "" },
];
const JSONL_ROWS = [
  { asset_tag: "P1", count: 2, ok: true, gone: null },
  { asset_tag: "P2" },
];

const body = (init) =>
  JSON.parse(
    typeof init.body === "string"
      ? init.body
      : Buffer.from(init.body).toString(),
  );
const importSet = (number) => ({
  import_set: number,
  staging_table: TABLE,
  result: [{ transform_map: "Assets", table: "alm_asset", status: "inserted" }],
});

/**
 * An Import Set API double: `multi` answers `insertMultiple` (a status number
 * is an error reply), `single` answers one row (called with the row index).
 * Table API GETs serve the run and the transform maps.
 */
function importFetch({ multi, single }) {
  let singles = 0;
  return (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === `/api/now/import/${TABLE}/insertMultiple`) {
      assert.equal(init.method, "POST");
      return typeof multi === "number"
        ? jsonResponse(multi, { error: { message: `HTTP ${multi}` } })
        : jsonResponse(201, multi(body(init).records));
    }
    if (pathname === `/api/now/import/${TABLE}`) {
      assert.equal(init.method, "POST");
      const reply = single(singles++, body(init));
      return typeof reply === "number"
        ? jsonResponse(reply, { error: { message: `row rejected ${reply}` } })
        : jsonResponse(201, reply);
    }
    if (pathname === "/api/now/table/sys_import_set_run") {
      return jsonResponse(200, {
        result: [{ sys_id: "run1", state: "complete", inserts: "2" }],
      });
    }
    if (pathname === "/api/now/table/sys_transform_map") {
      return jsonResponse(200, {
        result: [{ sys_id: "m1", name: "Assets", target_table: "alm_asset" }],
      });
    }
    throw new Error(`unexpected ${init.method ?? "GET"} ${pathname}`);
  };
}
const importCalls = (calls) =>
  calls.filter((c) => new URL(c.url).pathname.startsWith("/api/now/import/"));
const journal = () => readWriteJournal().entries;

/** A call that must be refused before any request leaves, in plan and apply. */
async function refused(args, code, pattern) {
  await withFetch(noFetch, async (calls) => {
    for (const apply of [false, true]) {
      const res = await insert({ ...args, apply });
      assert.equal(res.isError, true, `apply=${apply} should fail`);
      const b = out(res);
      assert.equal(b.code, code, b.error);
      assert.match(b.error, pattern);
    }
    assert.equal(calls.length, 0);
    assert.equal(journal().length, 0);
  });
}

// --- input rules ---------------------------------------------------------------

test("insert_import_set_row takes exactly one of values, rows and file_path", async () => {
  await refused(
    {},
    "INVALID_INPUT",
    /exactly one of values, rows and file_path/,
  );
  await refused(
    { values: ROWS[0], rows: ROWS },
    "INVALID_INPUT",
    /exactly one of values, rows and file_path/,
  );
  await refused(
    { rows: ROWS, file_path: "in/assets.csv" },
    "INVALID_INPUT",
    /exactly one/,
  );
  const { input } = tool("servicenow_insert_import_set_row");
  assert.equal(input.rows.safeParse([]).success, false, "rows needs one row");
  assert.equal(
    input.rows.safeParse(Array.from({ length: IMPORT_MAX_ROWS }, () => ROWS[0]))
      .success,
    true,
  );
  assert.equal(
    input.rows.safeParse(
      Array.from({ length: IMPORT_MAX_ROWS + 1 }, () => ROWS[0]),
    ).success,
    false,
    "501 inline rows must fail validation",
  );
  assert.equal(input.file_path.safeParse("x".repeat(1025)).success, false);
});

test("columnsOf lists the columns in order of first appearance", () => {
  assert.deepEqual(columnsOf(ROWS), ["asset_tag", "model", "notes"]);
  assert.deepEqual(columnsOf([{ b: 1 }, { a: 2, b: 3 }]), ["b", "a"]);
  assert.deepEqual(columnsOf([]), []);
  assert.equal(IMPORT_MAX_ROWS, 500);
});

test("the single-row path (values) is unchanged: plain preview and one journal line", async () => {
  await withFetch(
    importFetch({ single: () => importSet("ISET0001") }),
    async (calls) => {
      const plan = out(await insert({ values: ROWS[0] }));
      assert.equal(plan.mode, "plan");
      assert.deepEqual(plan.after, ROWS[0]);
      assert.equal(plan.source, undefined);
      assert.equal(calls.length, 0);

      const res = out(await insert({ values: ROWS[0], apply: true }));
      assert.equal(res.message, "Import set row inserted");
      assert.equal(res.mode, undefined);
      assert.equal(importCalls(calls).length, 1);
      const lines = journal();
      assert.equal(lines.length, 1);
      assert.deepEqual(lines[0].fields, ROWS[0]);
      assert.equal(lines[0].batch_id, undefined);
    },
  );
});

// --- rows ----------------------------------------------------------------------

test("rows: the preview counts the rows and names the columns; nothing is sent", async () => {
  await withFetch(noFetch, async () => {
    const plan = out(await insert({ rows: ROWS }));
    assert.equal(plan.mode, "plan");
    assert.equal(plan.action, "create");
    assert.equal(plan.table, TABLE);
    assert.deepEqual(plan.after, {
      row_count: 2,
      columns: ["asset_tag", "model", "notes"],
      first: ROWS[0],
    });
    assert.equal(plan.source, undefined);
    assert.equal(journal().length, 0);
  });
});

test("rows: insertMultiple sends every row in one request under one journal envelope", async () => {
  await withFetch(
    importFetch({
      multi: (records) => {
        assert.deepEqual(records, ROWS);
        return importSet("ISET0010");
      },
      single: () => assert.fail("no per-row insert when insertMultiple works"),
    }),
    async (calls) => {
      const res = out(await insert({ rows: ROWS, apply: true }));
      assert.equal(res.message, "2 import set rows inserted");
      assert.equal(res.mode, "insertMultiple");
      assert.equal(res.rows, 2);
      assert.equal(res.sent, 2);
      assert.equal(res.failed, undefined);
      assert.deepEqual(res.import_sets, ["ISET0010"]);
      assert.equal(res.results.length, 1);
      assert.equal(res.import_set_run.state, "complete");
      assert.equal(res.transform_maps[0].used, true);
      assert.equal(importCalls(calls).length, 1);

      const lines = journal();
      assert.equal(lines.length, 1, "one envelope, no per-row lines");
      const [env] = lines;
      assert.equal(env.tool, "servicenow_insert_import_set_row");
      assert.equal(env.action, "create");
      assert.equal(env.table, TABLE);
      assert.equal(env.result, "applied");
      assert.deepEqual(env.fields, {
        rows: 2,
        columns: ["asset_tag", "model", "notes"],
      });
      assert.equal(typeof env.batch_id, "string");
      assert.equal(env.body_sha256, sha256(JSON.stringify(ROWS)));
    },
  );
});

for (const status of [404, 405]) {
  test(`rows: a ${status} on insertMultiple falls back to one request per row, each journaled under the envelope's batch_id`, async () => {
    await withFetch(
      importFetch({
        multi: status,
        single: (i, sent) => {
          assert.deepEqual(sent, ROWS[i]);
          return importSet("ISET0020");
        },
      }),
      async (calls) => {
        const res = out(await insert({ rows: ROWS, apply: true }));
        assert.equal(res.message, "2 import set rows inserted");
        assert.equal(res.mode, "sequential");
        assert.equal(res.sent, 2);
        assert.equal(res.results.length, 2);
        assert.deepEqual(res.import_sets, ["ISET0020"]);
        assert.equal(res.failed, undefined);
        assert.equal(importCalls(calls).length, 3, "1 multi + 2 singles");

        const lines = journal();
        assert.equal(lines.length, 3);
        const [env, ...rows] = lines;
        assert.equal(env.fields.rows, 2);
        assert.equal(env.result, "applied");
        assert.deepEqual(
          rows.map((l) => l.fields),
          ROWS,
        );
        for (const l of rows) {
          assert.equal(l.batch_id, env.batch_id);
          assert.equal(l.result, "applied");
          assert.equal(l.action, "create");
          assert.equal(l.table, TABLE);
        }
      },
    );
  });
}

for (const [status, outcome] of [
  [400, "failed"],
  [403, "refused"],
]) {
  test(`rows: sequential mode stops at the first failing row (${status} → ${outcome}); the rows after it are not sent`, async () => {
    const three = [...ROWS, { asset_tag: "P3", model: "HP" }];
    await withFetch(
      importFetch({
        multi: 404,
        single: (i) => (i === 1 ? status : importSet("ISET0030")),
      }),
      async (calls) => {
        const res = out(await insert({ rows: three, apply: true }));
        assert.equal(
          res.message,
          "Import stopped at row 1: 1 of 3 rows inserted",
        );
        assert.equal(res.mode, "sequential");
        assert.equal(res.rows, 3);
        assert.equal(res.sent, 1);
        assert.equal(res.failed.index, 1);
        assert.match(res.failed.error, /row rejected/);
        assert.equal(typeof res.failed.code, "string");
        assert.deepEqual(res.import_sets, ["ISET0030"]);
        assert.equal(importCalls(calls).length, 3, "1 multi + 2 singles");

        const [env, first, second, ...rest] = journal();
        assert.equal(rest.length, 0, "the third row never reached the journal");
        assert.equal(env.result, "failed");
        assert.match(env.error, /^row 1: .*row rejected/);
        assert.equal(first.result, "applied");
        assert.equal(second.result, outcome);
        assert.match(second.error, /row rejected/);
        assert.equal(second.batch_id, env.batch_id);
      },
    );
  });
}

test("rows: an insertMultiple failure other than 404 / 405 fails the whole call", async () => {
  await withFetch(
    importFetch({ multi: 500, single: () => assert.fail("no fallback") }),
    async (calls) => {
      const res = await insert({ rows: ROWS, apply: true });
      assert.equal(res.isError, true);
      assert.equal(importCalls(calls).length, 1);
      const [env, ...rest] = journal();
      assert.equal(rest.length, 0);
      assert.equal(env.result, "failed");
      assert.equal(env.fields.rows, 2);
    },
  );
});

test("rows: the H-11 write cap counts every row before anything is sent", async () => {
  await withEnv({ SN_MAX_WRITES_PER_SESSION: "2" }, async () => {
    await withFetch(noFetch, async (calls) => {
      const res = await insert({ rows: [...ROWS, ROWS[0]], apply: true });
      assert.equal(res.isError, true);
      const b = out(res);
      assert.equal(b.code, "WRITE_CAP");
      assert.match(b.error, /this call needs 3 more/);
      assert.equal(calls.length, 0);
      const [line] = journal();
      assert.equal(line.result, "refused");
      assert.equal(line.cap_hit, true);
    });
    await withFetch(
      importFetch({ multi: () => importSet("ISET0040"), single: () => 500 }),
      async () => {
        const ok = out(await insert({ rows: ROWS, apply: true }));
        assert.equal(ok.sent, 2);
        // The two rows used the whole cap: the next write is refused.
        const next = await insert({ values: ROWS[0], apply: true });
        assert.equal(next.isError, true);
        assert.equal(out(next).code, "WRITE_CAP");
      },
    );
  });
});

// --- file_path -----------------------------------------------------------------

test("file_path: a CSV with a BOM, CRLF, quoted commas, doubled quotes, embedded newlines and blank lines", async () => {
  await withFetch(
    importFetch({
      multi: (records) => {
        assert.deepEqual(records, CSV_ROWS);
        return importSet("ISET0050");
      },
      single: () => assert.fail("insertMultiple works here"),
    }),
    async (calls) => {
      const plan = out(await insert({ file_path: "in/assets.csv" }));
      assert.equal(plan.mode, "plan");
      assert.deepEqual(plan.after, {
        row_count: 2,
        columns: ["asset_tag", "model", "notes"],
        first: CSV_ROWS[0],
      });
      assert.deepEqual(plan.source, {
        file_path: "in/assets.csv",
        format: "csv",
      });
      assert.equal(calls.length, 0);

      const res = out(
        await insert({ file_path: "in/assets.csv", apply: true }),
      );
      assert.equal(res.message, "2 import set rows inserted");
      assert.equal(res.mode, "insertMultiple");
      const [env] = journal();
      assert.deepEqual(env.fields, {
        rows: 2,
        columns: ["asset_tag", "model", "notes"],
        file_path: "in/assets.csv",
        format: "csv",
      });
      assert.equal(env.body_sha256, sha256(JSON.stringify(CSV_ROWS)));
    },
  );
});

test("file_path: JSONL keeps numbers, booleans and null and skips blank lines", async () => {
  await withFetch(
    importFetch({ multi: 404, single: (i) => importSet(`ISET006${i}`) }),
    async (calls) => {
      const plan = out(
        await insert({ file_path: path.join(DOCS_DIR, "in/assets.jsonl") }),
      );
      assert.deepEqual(plan.after, {
        row_count: 2,
        columns: ["asset_tag", "count", "ok", "gone"],
        first: JSONL_ROWS[0],
      });
      assert.deepEqual(plan.source, {
        file_path: "in/assets.jsonl",
        format: "jsonl",
      });

      const res = out(
        await insert({ file_path: "in/assets.jsonl", apply: true }),
      );
      assert.equal(res.mode, "sequential");
      assert.deepEqual(res.import_sets, ["ISET0060", "ISET0061"]);
      assert.equal(importCalls(calls).length, 3);
      const [env, ...rows] = journal();
      assert.equal(env.fields.format, "jsonl");
      assert.deepEqual(
        rows.map((l) => l.fields),
        JSONL_ROWS,
      );
    },
  );
});

test("file_path: paths that leave SN_DOCS_DIR, symlinks, missing files, directories, the journal and other extensions are refused", async () => {
  await refused({ file_path: "../escape.csv" }, "INVALID_INPUT", /escapes/);
  await refused(
    { file_path: path.join(OUTSIDE, "secret.csv") },
    "INVALID_INPUT",
    /escapes the docs directory/,
  );
  await refused({ file_path: "in/link.csv" }, "INVALID_INPUT", /symbolic link/);
  await refused({ file_path: "   " }, "INVALID_INPUT", /file_path is empty/);
  await refused(
    { file_path: "in/missing.csv" },
    "INVALID_INPUT",
    /File not found: in\/missing\.csv/,
  );
  await refused(
    { file_path: "in/dir.csv" },
    "INVALID_INPUT",
    /Not a regular file/,
  );
  await refused(
    { file_path: "default/write-journal.jsonl" },
    "INVALID_INPUT",
    /write journal cannot be uploaded/,
  );
  await refused(
    { file_path: "in/notes.txt" },
    "INVALID_INPUT",
    /Only \.csv and \.jsonl import files are supported: in\/notes\.txt/,
  );
});

test("file_path: malformed CSV and JSONL are refused with the line that is wrong", async () => {
  const cases = [
    [
      "in/unclosed.csv",
      /in\/unclosed\.csv: the quoted field starting on line 2 is not closed/,
    ],
    ["in/empty.csv", /in\/empty\.csv has no header row/],
    ["in/dup.csv", /header column names must be unique/],
    ["in/emptycol.csv", /header column 2 is empty/],
    ["in/short.csv", /in\/short\.csv line 2: expected 2 fields, got 1/],
    ["in/onlyheader.csv", /in\/onlyheader\.csv has no data rows/],
    ["in/bad.jsonl", /in\/bad\.jsonl line 2: not valid JSON/],
    ["in/array.jsonl", /line 1: expected a JSON object/],
    [
      "in/nested.jsonl",
      /line 1: column a must be a string, number, boolean or null/,
    ],
    ["in/emptykey.jsonl", /line 1: a column name is empty/],
    [
      "in/big.csv",
      /in\/big\.csv has 501 rows, over the 500-row limit of one call/,
    ],
  ];
  for (const [file_path, pattern] of cases) {
    await refused({ file_path }, "INVALID_INPUT", pattern);
  }
});

test("file_path: SN_DOCS_MAX_FILE_BYTES caps the file on the stat before the read", async () => {
  await withEnv({ SN_DOCS_MAX_FILE_BYTES: "16" }, () =>
    refused(
      { file_path: "in/assets.csv" },
      "PAYLOAD_TOO_LARGE",
      /in\/assets\.csv is \d+ bytes, over the SN_DOCS_MAX_FILE_BYTES limit of 16/,
    ),
  );
});
