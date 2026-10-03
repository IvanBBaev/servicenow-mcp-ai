// E-6 / L9-02: property tests for the data-shaping codecs and stores —
// redaction, CSV, the docs-store path guard, env-file values over an
// extended alphabet, and the write-journal hash chain. Fixed seed (fcParams);
// the fs-heavy properties run fewer cases on a throw-away directory.
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv as parseEnvFile } from "node:util";
import fc from "fast-check";

import { REDACTED, redactValue } from "../build/core/redaction.js";
import { redactRecords } from "../build/mcp/redact.js";
import { renderCsv } from "../build/mcp/csv.js";
import { docsRead, docsWriteRaw } from "../build/api/docs.js";
import { formatEnvValue, persistEnv } from "../build/core/config.js";
import {
  appendWriteJournal,
  readWriteJournal,
  sha256Hex,
} from "../build/core/write-journal.js";
import { ServiceNowError } from "../build/core/errors.js";
import { baselineEnv, fcParams, withEnv } from "./helpers.js";

// E-2: Node's env-file parser (dotenv's replacement); a plain object, since
// Node 26 returns a null-prototype one that deepStrictEqual would reject.
const parseEnv = (text) => ({ ...parseEnvFile(text) });

baselineEnv();

/** A throw-away directory for one property run. */
function scratch(prefix) {
  return mkdtempSync(path.join(tmpdir(), `snmcp-prop-${prefix}-`));
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const KEYS = [
  "password",
  "token",
  "name",
  "email",
  "sys_id",
  "nested",
  "items",
];
const leaf = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.constant(""),
  fc.constant(null),
  fc.integer(),
  fc.boolean(),
  fc.constantFrom("a@b.co", "+1 555 123 4567", "123456789012"),
);
const { tree } = fc.letrec((tie) => ({
  tree: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    leaf,
    fc.array(tie("tree"), { maxLength: 3 }),
    // Plain objects, as JSON.parse produces (fc.dictionary may use a null prototype).
    fc
      .dictionary(fc.constantFrom(...KEYS), tie("tree"), { maxKeys: 4 })
      .map((d) => ({ ...d })),
  ),
}));

/** Every [key, value] pair at any depth. */
function* pairs(v) {
  if (Array.isArray(v)) for (const x of v) yield* pairs(x);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      yield [k, x];
      yield* pairs(x);
    }
  }
}

test("redaction: a named field's non-empty value never survives, at any depth; everything else is untouched", () => {
  fc.assert(
    fc.property(tree, fc.subarray(KEYS, { minLength: 1 }), (value, fields) => {
      const input = structuredClone(value);
      const rules = { fields: new Set(fields), pii: false };
      const { value: out, redacted } = redactValue(value, rules);
      assert.deepEqual(value, input, "the input is never mutated");
      let count = 0;
      // Walk input and output in lock step.
      const walk = (a, b) => {
        if (Array.isArray(a)) {
          assert.equal(b.length, a.length);
          a.forEach((x, i) => walk(x, b[i]));
        } else if (a && typeof a === "object") {
          assert.deepEqual(Object.keys(b), Object.keys(a));
          for (const [k, x] of Object.entries(a)) {
            if (fields.includes(k) && x != null && x !== "") {
              assert.equal(b[k], REDACTED, `${k} must be masked`);
              count++;
            } else walk(x, b[k]);
          }
        } else assert.equal(b, a);
      };
      walk(value, out);
      assert.equal(redacted, count);
      for (const [k, x] of pairs(out)) {
        if (fields.includes(k))
          assert.ok(x === REDACTED || x == null || x === "");
      }
    }),
    fcParams(),
  );
});

test("redaction: PII mode leaves no email/phone/id pattern in any string, and with no rules the records pass by reference", async () => {
  fc.assert(
    fc.property(tree, (value) => {
      const { value: out } = redactValue(value, {
        fields: new Set(),
        pii: true,
      });
      for (const s of JSON.stringify(out).match(/"(?:[^"\\]|\\.)*"/g) ?? []) {
        const text = JSON.parse(s);
        assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[\w.-]+/, text);
        assert.doesNotMatch(text, /\b\d{9,}\b/, text);
      }
    }),
    fcParams(),
  );
  await withEnv(
    { SN_REDACT_FIELDS: undefined, SN_REDACT_PII: undefined },
    () => {
      fc.assert(
        fc.property(
          fc.array(fc.dictionary(fc.constantFrom(...KEYS), leaf)),
          (records) => {
            const r = redactRecords(records);
            assert.equal(r.records, records);
            assert.equal(r.redacted, 0);
          },
        ),
        fcParams({ scale: 0.5 }),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** A strict RFC 4180 reader (LF record separator, as renderCsv writes). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let i = 0;
  let quoted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        quoted = false;
        i++;
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === "") quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      assert.ok(
        c !== '"' && c !== "\r",
        `unquoted ${JSON.stringify(c)} in ${JSON.stringify(text)}`,
      );
      cell += c;
    }
    i++;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

const FORMULA = /^[=+\-@\t\r]/;
const csvText = fc.string({
  unit: fc.constantFrom(
    "a",
    "Z",
    "1",
    " ",
    ",",
    '"',
    "\n",
    "\r",
    "=",
    "+",
    "-",
    "@",
    "\t",
    "é",
    "'",
  ),
  maxLength: 10,
});
const csvValue = fc.oneof(
  csvText,
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.dictionary(fc.constantFrom("value", "display_value"), csvText, {
    maxKeys: 2,
  }),
);
const csvInput = fc
  .uniqueArray(fc.stringMatching(/^[a-z_]{1,6}$/), {
    minLength: 1,
    maxLength: 4,
  })
  .chain((fields) =>
    fc.tuple(
      fc.constant(fields),
      fc.array(
        fc
          .tuple(...fields.map(() => csvValue))
          .map((vs) => Object.fromEntries(fields.map((f, i) => [f, vs[i]]))),
        { maxLength: 4 },
      ),
    ),
  );
const asText = (v) =>
  v == null
    ? ""
    : typeof v === "string"
      ? v
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);

test("CSV: with the formula guard off, an RFC 4180 reader gets every cell back verbatim", () => {
  fc.assert(
    fc.property(csvInput, fc.boolean(), ([fields, records], bom) => {
      const { csv, escaped } = renderCsv(records, fields, {
        formulaGuard: false,
        bom,
      });
      assert.equal(escaped, 0);
      assert.equal(csv.startsWith("﻿"), bom);
      const rows = parseCsv(bom ? csv.slice(1) : csv);
      assert.deepEqual(rows, [
        fields,
        ...records.map((r) => fields.map((f) => asText(r[f]))),
      ]);
    }),
    fcParams(),
  );
});

test("CSV: with the formula guard on, no text cell can start a formula, and only formula-like text changes", () => {
  fc.assert(
    fc.property(csvInput, ([fields, records]) => {
      const { csv, escaped } = renderCsv(records, fields);
      const rows = parseCsv(csv).slice(1);
      let guarded = 0;
      records.forEach((r, ri) => {
        fields.forEach((f, ci) => {
          const got = rows[ri][ci];
          const v = r[f];
          // Numbers (a plain "-1") are data, not formulas; only text is guarded.
          if (typeof v === "string") {
            assert.ok(
              !FORMULA.test(got) && !FORMULA.test(got.trimStart()),
              JSON.stringify(got),
            );
          }
          if (
            typeof v === "string" &&
            (FORMULA.test(v) || FORMULA.test(v.trimStart()))
          ) {
            assert.equal(got, `'${v}`);
            guarded++;
          } else assert.equal(got, asText(v));
        });
      });
      assert.equal(escaped, guarded);
    }),
    fcParams(),
  );
});

// ---------------------------------------------------------------------------
// Docs-store path guard
// ---------------------------------------------------------------------------

const segment = fc.constantFrom(
  "a",
  "b",
  "sub",
  "..",
  ".",
  "",
  "link",
  "CON",
  "nul.md",
  "x:y",
  "c:",
  "lpt1",
  "write-journal.md",
  "a.md",
  "é",
);
const docPath = fc
  .tuple(
    fc.constantFrom("", "/", "//", "\\"),
    fc.array(fc.tuple(segment, fc.constantFrom("/", "\\")), {
      minLength: 0,
      maxLength: 4,
    }),
    fc.constantFrom("doc", "..", "CON", "x:y", "index", "a"),
    fc.constantFrom(".md", ".json", ".MD", ".txt", ""),
  )
  .map(
    ([lead, segs, base, ext]) =>
      lead + segs.map(([s, sep]) => s + sep).join("") + base + ext,
  );

const STORE_FILES = new Set(["index.md", "index.json"]);

test("docs path: a write either lands inside SN_DOCS_DIR (and reads back) or is refused with 400 — never outside, never through a link", async () => {
  await fc.assert(
    fc.asyncProperty(docPath, async (rel) => {
      const base = scratch("docs");
      const root = path.join(base, "root");
      const outside = path.join(base, "outside");
      mkdirSync(root);
      mkdirSync(outside);
      // A link inside the docs dir pointing out of it (symlink escape).
      symlinkSync(outside, path.join(root, "link"), "dir");
      try {
        await withEnv({ SN_DOCS_DIR: root }, async () => {
          let result;
          try {
            result = await docsWriteRaw(rel, "payload", [".md", ".json"]);
          } catch (e) {
            assert.ok(e instanceof ServiceNowError, `${rel}: ${e}`);
            assert.equal(e.status, 400, `${rel}: ${e.message}`);
          }
          assert.deepEqual(readdirSync(outside), [], `${rel} escaped`);
          if (!result) return;
          const landed = path.resolve(root, rel.trim().replace(/^[/\\]+/, ""));
          assert.ok(existsSync(landed), `${rel} → ${landed}`);
          const real = path.relative(realpathSync(root), realpathSync(landed));
          assert.ok(
            real && !real.startsWith("..") && !path.isAbsolute(real),
            real,
          );
          assert.ok(
            [".md", ".json"].includes(path.extname(landed).toLowerCase()),
          );
          // The store's own index.md / index.json are rebuilt after every
          // write, replacing what was written there (finding F3, todo below).
          if (!STORE_FILES.has(path.basename(landed).toLowerCase())) {
            assert.equal((await docsRead(rel)).content, "payload");
          }
        });
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }),
    fcParams({ scale: 0.4 }),
  );
});

test(
  "docs store: a raw write to the store's own index.md / index.json is refused (not silently replaced)",
  {
    todo: "E-6 finding F3 (owner decision): docsWriteRaw accepts index.md / index.json, which the store rebuilds right after the write",
  },
  async () => {
    const root = scratch("docs-index");
    try {
      await withEnv({ SN_DOCS_DIR: root }, async () => {
        for (const name of ["index.md", "index.json"]) {
          await assert.rejects(
            () => docsWriteRaw(name, "mine", [".md", ".json"]),
            (e) => e instanceof ServiceNowError && e.status === 400,
          );
        }
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Env-file values (extended alphabet)
// ---------------------------------------------------------------------------

const envUnit = fc.constantFrom(
  "a",
  "Z",
  "1",
  " ",
  "\t",
  "#",
  "$",
  "=",
  "\\",
  "'",
  '"',
  "`",
  "\n",
  "\r",
  "\0",
  "é",
  "ж",
  "漢",
  "🙂",
  " ",
  " ",
  "﻿",
  "{",
  "}",
);
const envValue = fc.string({ unit: envUnit, maxLength: 16 });

const needsQuoting = (v) => v === "" || /^\s|\s$|#/.test(v) || /^['"`]/.test(v);

/** The documented refusal rule, written out independently of the code. */
function mustRefuse(v) {
  if (/[\r\n]/.test(v)) return true;
  return (
    needsQuoting(v) &&
    v.includes("'") &&
    v.includes("`") &&
    (v.includes('"') || v.includes("\\"))
  );
}

test("env value: refuses exactly the unrepresentable, and everything else round-trips next to other keys", () => {
  fc.assert(
    fc.property(envValue, envValue, (v1, v2) => {
      let f1;
      let f2;
      try {
        f1 = formatEnvValue(v1);
      } catch {
        f1 = undefined;
      }
      try {
        f2 = formatEnvValue(v2);
      } catch {
        f2 = undefined;
      }
      assert.equal(f1 === undefined, mustRefuse(v1), JSON.stringify(v1));
      assert.equal(f2 === undefined, mustRefuse(v2), JSON.stringify(v2));
      if (f1 === undefined || f2 === undefined) return;
      assert.doesNotMatch(f1, /[\r\n]/);
      const parsed = parseEnv(`# c\nA=${f1}\nB=${f2}\nC='tail'\nD=#x\n`);
      assert.deepEqual(parsed, { A: v1, B: v2, C: "tail", D: "" });
    }),
    fcParams({ scale: 3 }),
  );
});

test("env value: the real env-file writer round-trips an accepted value and leaves the other keys intact", () => {
  const dir = scratch("env");
  const file = path.join(dir, ".env");
  const saved = { ...process.env };
  try {
    process.env.SN_ENV_FILE = file;
    fc.assert(
      fc.property(
        envValue.filter((v) => !mustRefuse(v)),
        fc.boolean(),
        (value, crlf) => {
          // The key is replaced in place, between other keys (quoted ones too).
          const eol = crlf ? "\r\n" : "\n";
          writeFileSync(
            file,
            ["# keep me", "SN_PROP_VALUE=old", "SN_OTHER='kept'", ""].join(eol),
          );
          persistEnv({ SN_PROP_VALUE: value });
          const text = readFileSync(file, "utf8");
          assert.ok(text.startsWith(`# keep me${eol}`));
          assert.deepEqual(parseEnv(text), {
            SN_PROP_VALUE: value,
            SN_OTHER: "kept",
          });
        },
      ),
      fcParams({ scale: 0.5 }),
    );
  } finally {
    for (const k of Object.keys(process.env))
      if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});

// E-6 findings F1 / F2 were dotenv parser hazards (`\'` read as an escaped
// quote; U+2028 / U+2029 as line ends). E-2 replaced dotenv with Node's own
// env-file parser (process.loadEnvFile / util.parseEnv), which has neither,
// so the round-trip properties above no longer exclude these values and the
// former todo tests are regular regressions.
test("env value: a quoted value ending in a backslash does not swallow the next line", () => {
  const value = "pa#ss\\";
  const parsed = parseEnv(`A=${formatEnvValue(value)}\nB='#x'\n`);
  assert.deepEqual(parsed, { A: value, B: "#x" });
});

test("env value: U+2028 / U+2029 in a value survive the env-file parser", () => {
  for (const value of ["a\u2028`b`", 'x\u2029"y"']) {
    let formatted;
    try {
      formatted = formatEnvValue(value);
    } catch {
      continue; // refusing is an acceptable fix
    }
    assert.deepEqual(parseEnv(`A=${formatted}\nB=z\n`), {
      A: value,
      B: "z",
    });
  }
});

// ---------------------------------------------------------------------------
// Write-journal hash chain
// ---------------------------------------------------------------------------

const journalEntry = fc.record({
  action: fc.constantFrom("create", "update", "delete", "execute"),
  table: fc.stringMatching(/^[a-z_]{1,10}$/),
  sys_id: fc.string({
    unit: fc.constantFrom("a", "1", "é", '"', "\\", "\n", "🙂"),
    minLength: 1,
    maxLength: 8,
  }),
  result: fc.constantFrom("applied", "failed", "refused"),
});

/** Append `entries` to a fresh journal and hand back its directory. */
async function withJournal(entries, fn) {
  const root = scratch("journal");
  try {
    return await withEnv(
      { SN_DOCS_DIR: root, SN_REDACT_FIELDS: undefined },
      async () => {
        for (const e of entries) appendWriteJournal(e);
        const file = path.join(root, "default", "write-journal.jsonl");
        return await fn(file);
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const lines = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean);
const rewrite = (file, ls) =>
  writeFileSync(file, ls.map((l) => `${l}\n`).join(""));

test("journal chain: an untouched journal verifies, links every line to the previous one and keeps the order", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(journalEntry, { minLength: 1, maxLength: 6 }),
      async (entries) => {
        await withJournal(entries, async (file) => {
          const read = readWriteJournal();
          assert.equal(read.integrity, "ok");
          assert.deepEqual(
            read.entries.map((e) => e.sys_id),
            entries.map((e) => e.sys_id),
          );
          const ls = lines(file);
          ls.forEach((l, i) => {
            assert.equal(
              JSON.parse(l).prev,
              i === 0 ? undefined : sha256Hex(ls[i - 1]),
            );
          });
          const head = readFileSync(
            path.join(path.dirname(file), "write-journal.head"),
            "utf8",
          );
          assert.equal(head.trim(), sha256Hex(ls.at(-1)));
        });
      },
    ),
    fcParams({ scale: 0.3 }),
  );
});

test("journal chain: any edit, deletion, swap or truncation is reported at the first line that no longer verifies", async () => {
  const tamper = fc.constantFrom("edit", "delete", "swap", "truncate");
  await fc.assert(
    fc.asyncProperty(
      fc.array(journalEntry, { minLength: 2, maxLength: 6 }),
      tamper,
      fc.nat(),
      async (entries, kind, pick) => {
        const n = entries.length;
        await withJournal(entries, async (file) => {
          const ls = lines(file);
          let want;
          if (kind === "edit") {
            const i = pick % n;
            const obj = JSON.parse(ls[i]);
            obj.sys_id = `${obj.sys_id}X`;
            ls[i] = JSON.stringify(obj);
            // The edited line's successor stops linking; the last line is
            // caught by the head file instead.
            want = i < n - 1 ? i + 2 : n;
          } else if (kind === "delete") {
            const i = pick % n;
            ls.splice(i, 1);
            want = i < n - 1 ? i + 1 : n - 1;
          } else if (kind === "swap") {
            const i = pick % (n - 1);
            [ls[i], ls[i + 1]] = [ls[i + 1], ls[i]];
            want = i + 1;
          } else {
            const keep = 1 + (pick % (n - 1));
            ls.length = keep;
            want = keep;
          }
          rewrite(file, ls);
          assert.equal(
            readWriteJournal().integrity,
            `broken@${want}`,
            `${kind} ${pick} of ${n}`,
          );
        });
      },
    ),
    fcParams({ scale: 0.4 }),
  );
});
