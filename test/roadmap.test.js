// N-41 (TK-16): project/roadmap.yaml ⇄ the ROADMAP-V3.md sequencing table.
//
// The byte-exact round-trip runs on a frozen copy of the table
// (test/fixtures/roadmap/sequencing-table-2026-10-05.md, taken when
// roadmap.yaml was first imported), because other sessions edit the live table
// all the time and the table is not in generated mode yet. The live file is
// only reported on (t.diagnostic), never asserted, until the owner adopts the
// generator.
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as prettier from "prettier";
import {
  BEGIN,
  END,
  ROADMAP_MD,
  ROADMAP_YAML,
  buildStatus,
  deriveFields,
  diffItems,
  displayWidth,
  formatStatus,
  importTable,
  loadRoadmap,
  locateTable,
  normalizeTableLines,
  parseOwnerGates,
  parseYaml,
  renderTable,
  replaceTable,
  run,
  serializeRoadmap,
  splitRow,
  statusCounts,
  stringifyYaml,
  validate,
  yamlScalar,
} from "../scripts/roadmap.mjs";

const root = path.join(import.meta.dirname, "..");
const fixture = readFileSync(
  path.join(
    import.meta.dirname,
    "fixtures/roadmap/sequencing-table-2026-10-05.md",
  ),
  "utf8",
);
const fixtureLines = fixture.replace(/\n$/, "").split("\n");

const GATES_MD = [
  "### O — Owner gates",
  "",
  "- [ ] **O-1** ARCH-14 go/no-go (unblocks E-8). Second sentence.",
  "- [x] **O-4** Approve the register.",
  "- [ ] **O-10** Restate the budget for the post-3.0 surface, a sentence long enough to be cut by the",
  "      summary because it keeps going well past the ninety-six character limit.",
  "",
  "## SDK parity epic",
  "",
  "- [ ] **O-99** not a gate (outside the section)",
].join("\n");

const prettierMd = (text) =>
  prettier.format(text, { parser: "markdown", proseWrap: "preserve" });

function roadmapMarkdown(tableLines) {
  return [
    "# Roadmap",
    "",
    "## Sequencing (must-haves first)",
    "",
    ...tableLines,
    "",
    GATES_MD,
    "",
  ].join("\n");
}

test("restricted YAML: scalars round-trip and match Prettier's quote choice", async () => {
  const strings = [
    "plain",
    "",
    'has "dq" inside',
    "has 'sq' and \"dq\"",
    "back\\slash",
    'back\\slash and "dq"',
    "x 'one'",
    "tab\there é — 🟢 ≥ …",
    "a | pipe and `code` and **bold** and # hash: colon",
  ];
  const doc = {
    schema: 1,
    flag: true,
    off: false,
    none: null,
    items: strings.map((s, i) => ({
      id: `X-${i}`,
      text: s,
      list: i % 2 ? ["O-1", "O-22"] : [],
    })),
  };
  const text = stringifyYaml(doc, { comment: ["header", ""] });
  assert.deepEqual(parseYaml(text), {
    schema: 1,
    flag: true,
    off: false,
    none: null,
    items: doc.items,
  });
  assert.equal(
    await prettier.format(text, { parser: "yaml" }),
    text,
    "the serializer output is a Prettier fixpoint",
  );
  assert.equal(yamlScalar('say "hi"'), `'say "hi"'`);
  assert.equal(yamlScalar("it's"), `"it's"`);
  assert.equal(yamlScalar(-3), "-3");
  assert.throws(() => yamlScalar(1.5), /non-integer/);
  assert.throws(() => yamlScalar(['a"b']), /plain strings only/);
  assert.throws(() => yamlScalar({}), /unsupported value/);
});

test("restricted YAML: everything outside the subset is rejected", () => {
  const cases = [
    ["items:\n  - a: &anchor 1\n", /unsupported scalar/],
    ["items:\n  - a: bare words\n", /unsupported scalar/],
    ['items:\n  - a: "unterminated\n', /bad double-quoted/],
    ["items:\n  - a: 'bad ' quote'\n", /bad single-quoted/],
    ["items:\n  - a: [1, 2]\n", /bad flow sequence/],
    ["items:\n  - a: [oops\n", /bad flow sequence/],
    ["items:\n  - a: 1\n      b: 2\n", /outside the supported YAML subset/],
    ["items:\n  - a: 1\n    a: 2\n", /duplicate key a/],
    ["x: 1\nx: 2\nitems:\n", /duplicate key x/],
    ["items:\nx: 1\n", /top-level key after items/],
    ["block:\nitems:\n", /only "items" may hold a block/],
    ["x: 1\n", /missing "items:"/],
    ["    b: 1\nitems:\n", /outside the supported YAML subset/],
  ];
  for (const [text, re] of cases)
    assert.throws(() => parseYaml(text), re, text);
  assert.deepEqual(parseYaml("# c\n\nitems:\n  - a: 'it''s'\n    b: true\n"), {
    items: [{ a: "it's", b: true }],
  });
});

test("displayWidth and splitRow follow Prettier's table rules", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("🟢"), 2);
  assert.equal(displayWidth("S–M ≥ → … —"), 11);
  assert.equal(displayWidth("é"), 1);
  assert.equal(displayWidth("⚠️"), 1);
  assert.equal(displayWidth("漢字"), 4);
  assert.deepEqual(splitRow("| a | b \\| c |"), [" a ", " b \\| c "]);
  assert.throws(() => splitRow("a | b"), /not a table row/);
});

test("fixture: import → render reproduces the table, modulo the documented normalisation", () => {
  const doc = importTable(fixtureLines);
  const rendered = renderTable(doc).split("\n");
  assert.deepEqual(
    rendered,
    normalizeTableLines(fixtureLines),
    "byte-exact after normalisation",
  );
  assert.equal(rendered.length, fixtureLines.length);

  // The only normalisation: the stray seventh column (delimiter row + rows 61–63, P-7…P-9).
  const differing = fixtureLines.flatMap((line, i) =>
    line === rendered[i] ? [] : [i],
  );
  assert.deepEqual(differing, [1, 63, 64, 65]);
  for (const i of differing) {
    assert.equal(splitRow(fixtureLines[i]).length, 7);
    assert.equal(splitRow(rendered[i]).length, 6);
    assert.ok(
      fixtureLines[i].startsWith(rendered[i]),
      "only trailing cells are dropped",
    );
  }

  assert.equal(doc.items.length, 150);
  assert.deepEqual(doc.items[5], {
    marker: "_cut **2.1.0** here (non-breaking)_",
    notes: doc.items[5].notes,
  });
  assert.deepEqual(statusCounts(doc).total, {
    done: 76,
    partial: 15,
    open: 58,
    total: 149,
  });
});

test("fixture: the YAML round-trip is lossless and the rendered table is a Prettier fixpoint", async () => {
  const doc = {
    schema: 1,
    source: ROADMAP_MD,
    imported: "2026-10-05",
    ...importTable(fixtureLines),
  };
  const text = serializeRoadmap(doc);
  assert.deepEqual(loadRoadmap(text), doc);
  assert.equal(await prettier.format(text, { parser: "yaml" }), text);
  const table = renderTable(doc) + "\n";
  assert.equal(await prettierMd(table), table);
  const adopted = replaceTable(
    roadmapMarkdown(fixtureLines),
    renderTable(doc),
    { adopt: true },
  );
  assert.equal(await prettierMd(adopted), adopted);
});

test("normalisation refuses non-blank extra cells; the importer is strict", () => {
  const [head, sep, row] = normalizeTableLines(fixtureLines.slice(0, 3));
  assert.throws(
    () => normalizeTableLines([head, sep, `${row} surprise |`]),
    /unexpected extra cells/,
  );
  const bad = (cells) => importTable([head, sep, `| ${cells.join(" | ")} |`]);
  assert.throws(
    () => bad(["2", "**H-1** x", "H", "n", "S", "🟢"]),
    /expected # 1/,
  );
  assert.throws(() => bad(["1", "H-1 x", "H", "n", "S", "🟢"]), /Item must be/);
  assert.throws(
    () => bad(["1", "**H-1** x", "H", "n", "S", "⚪"]),
    /unknown status/,
  );
  assert.throws(() => bad(["—", "_cut_", "H", "n", "", ""]), /marker row/);
  assert.throws(
    () => importTable(["| a | b |", "| - | - |"]),
    /unexpected header/,
  );
  const piped = bad(["1", "**H-1** a \\| b", "H", "x \\| y", "S", "🟡"]);
  assert.equal(piped.items[0].title, "a | b");
  assert.equal(piped.items[0].notes, "x | y");
  assert.match(renderTable(piped), /\*\*H-1\*\* a \\\| b/);
});

test("deriveFields extracts phase, done date and referenced owner gates", () => {
  assert.deepEqual(
    deriveFields(
      "Phase R0. Waits for O-21 and O-4; O-21 again. **Partly done 2026-10-01:** x",
    ),
    {
      phase: "R0",
      done: "2026-10-01",
      gates: ["O-4", "O-21"],
    },
  );
  assert.deepEqual(deriveFields("no metadata"), {
    phase: null,
    done: null,
    gates: [],
  });
});

test("validate lists every schema problem", () => {
  const good = importTable(fixtureLines.slice(0, 4));
  validate(good);
  const item = good.items[0];
  const broken = {
    items: [
      {
        ...item,
        pillar: "h",
        effort: "XL",
        status: "done?",
        phase: "phase",
        done: "2026",
        gates: ["X"],
      },
      { ...item },
      { ...item, id: "bad", title: "" },
      { marker: "", notes: "two\nlines" },
      { id: "Z-1" },
    ],
  };
  assert.throws(
    () => validate(broken),
    (e) => {
      for (const re of [
        /bad pillar/,
        /bad effort/,
        /bad status/,
        /bad phase/,
        /bad done/,
        /gates must be/,
        /duplicate id/,
        /bad id/,
        /title must be/,
        /marker must be/,
        /notes must be/,
        /fields id ≠/,
      ]) {
        assert.match(e.message, re);
      }
      return true;
    },
  );
  assert.throws(() => validate({}), /items is not a list/);
  assert.throws(
    () => loadRoadmap("schema: 2\nitems:\n"),
    /unsupported schema 2/,
  );
  assert.throws(
    () => loadRoadmap("schema: 1\nextra: 1\nitems:\n"),
    /unknown top-level key extra/,
  );
});

test("replaceTable: markers, adoption and the refusal without markers", () => {
  const md = roadmapMarkdown(fixtureLines);
  const doc = importTable(fixtureLines);
  const table = renderTable(doc);
  assert.throws(() => replaceTable(md, table), /no .*markers yet.*--adopt/s);
  const adopted = replaceTable(md, table, { adopt: true });
  assert.ok(adopted.includes(`${BEGIN}\n\n${table}\n\n${END}\n`));
  const loc = locateTable(adopted);
  assert.equal(loc.marked, true);
  assert.equal(loc.lines.slice(loc.start, loc.end).join("\n"), table);
  assert.equal(
    replaceTable(adopted, table),
    adopted,
    "idempotent once adopted",
  );
  const empty = `x\n${BEGIN}\n${END}\n`;
  assert.deepEqual(
    (({ start, end, marked }) => ({ start, end, marked }))(locateTable(empty)),
    { start: 2, end: 2, marked: true },
  );
  assert.equal(
    replaceTable(empty, "| t |"),
    `x\n${BEGIN}\n\n| t |\n\n${END}\n`,
  );
  assert.throws(() => locateTable(`${END}\n${BEGIN}\n`), /unbalanced/);
  assert.throws(() => locateTable(`${BEGIN}\n`), /unbalanced/);
  assert.throws(
    () => locateTable("| a | b |\nno table here\n"),
    /sequencing table not found/,
  );
});

test("diffItems reports changed, added, removed and reordered rows", () => {
  const a = importTable(fixtureLines.slice(0, 10));
  const same = structuredClone(a);
  assert.deepEqual(diffItems(a, same), {
    changed: [],
    added: [],
    removed: [],
    reordered: false,
  });
  const b = structuredClone(a);
  b.items[0].status = "partial";
  b.items.pop();
  b.items.push({ ...b.items[1], id: "Z-9" });
  const d = diffItems(a, b);
  assert.deepEqual(d.changed, ["H-1"]);
  assert.deepEqual(d.added, ["Z-9"]);
  assert.deepEqual(d.removed, [a.items.at(-1).id]);
  assert.equal(d.reordered, false);
  const c = structuredClone(a);
  c.items.reverse();
  assert.equal(diffItems(a, c).reordered, true);
});

test("owner gates and the status report", () => {
  const gates = parseOwnerGates(GATES_MD);
  assert.deepEqual(
    gates.map((g) => [g.id, g.open]),
    [
      ["O-1", true],
      ["O-4", false],
      ["O-10", true],
    ],
  );
  assert.match(gates[2].text, /ninety-six character limit\.$/);
  assert.deepEqual(parseOwnerGates("# nothing"), []);

  const md = roadmapMarkdown(fixtureLines);
  const doc = importTable(fixtureLines);
  const s = buildStatus(doc, md);
  assert.equal(s.source, ROADMAP_YAML);
  assert.equal(s.sync.inSync, true);
  assert.deepEqual(Object.keys(s.pillars), ["H", "M", "S", "D", "E", "P", "N"]);
  assert.deepEqual(s.ownerShared, ["D-6", "E-8"]);
  assert.equal(s.ownerGates[0].summary, "ARCH-14 go/no-go (unblocks E-8).");
  assert.ok(
    s.ownerGates[2].summary.endsWith("…") &&
      s.ownerGates[2].summary.length === 96,
  );
  const text = formatStatus(s);
  assert.match(text, /^All +76 +15 +58 +149 +51%$/m);
  assert.match(text, /Open owner gates: 2 of 3/);
  assert.match(text, /Sync: project\/roadmap\.yaml matches/);

  const stale = structuredClone(doc);
  stale.items[0].status = "open";
  stale.items.push({ ...stale.items[1], id: "Z-1" });
  stale.items.splice(1, 1);
  const s2 = buildStatus(stale, md, { fromTable: true });
  assert.match(s2.source, /live table/);
  assert.equal(s2.sync.inSync, false);
  assert.match(
    formatStatus(s2),
    /DRIFT .* changed H-1; only in the table H-2; only in the YAML Z-1\./,
  );
  const c = structuredClone(doc);
  c.items.reverse();
  assert.match(formatStatus(buildStatus(c, md)), /rows reordered/);
  const custom = { items: [{ ...doc.items[0], id: "Q-1", pillar: "Q" }] };
  assert.deepEqual(Object.keys(statusCounts(custom).pillars), ["Q"]);
  assert.equal(
    formatStatus({
      ...buildStatus(custom, md),
      openByPhase: {},
      ownerShared: [],
    }).includes("by phase"),
    false,
  );
});

test("status: a generated table rendered from the YAML is in sync", () => {
  const doc = loadRoadmap(readFileSync(path.join(root, ROADMAP_YAML), "utf8"));
  const md = replaceTable(roadmapMarkdown(fixtureLines), renderTable(doc), {
    adopt: true,
  });
  const s = buildStatus(doc, md);
  assert.equal(s.sync.generated, true);
  assert.equal(s.sync.inSync, true);
  assert.deepEqual(s.sync.changed, []);
  const edited = structuredClone(doc);
  const row = edited.items.find((it) => !("marker" in it));
  row.title = `${row.title} (edited)`;
  const s2 = buildStatus(edited, md);
  assert.equal(s2.sync.inSync, false);
  assert.ok(s2.sync.changed.includes(row.id));
  assert.match(formatStatus(s2), /generated: re-render it with/);
});

test("CLI: import, check, status, adopt and render in a scratch repo", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "roadmap-"));
  try {
    mkdirSync(path.join(dir, "project"));
    const mdPath = path.join(dir, ROADMAP_MD);
    const yamlPath = path.join(dir, ROADMAP_YAML);
    writeFileSync(mdPath, roadmapMarkdown(fixtureLines));
    const cli = (...argv) => {
      const out = [];
      const err = [];
      const code = run(argv, {
        root: dir,
        stdout: (s) => out.push(s),
        stderr: (s) => err.push(s),
        today: "2026-10-05",
      });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };

    assert.equal(cli("--bogus").code, 2);
    assert.match(cli("--check").err, /ENOENT/, "no roadmap.yaml yet");

    let r = cli("--import");
    assert.equal(r.code, 0);
    assert.match(r.out, /149 items, 1 marker row/);
    assert.match(r.out, /after the documented normalisation/);
    assert.match(readFileSync(yamlPath, "utf8"), /^imported: "2026-10-05"$/m);

    assert.equal(cli("--check").code, 0);
    assert.match(cli("--status").out, /^All +76 +15 +58 +149 +51%$/m);
    assert.equal(
      JSON.parse(cli("--status", "--json", "--from-table").out).total.total,
      149,
    );

    // A hand edit of the live table shows up as drift.
    const edited = readFileSync(mdPath, "utf8").replace(
      "| **H-1** dependency floor + green audit ",
      "| **H-1** dependency floor + green audiT ",
    );
    writeFileSync(mdPath, edited);
    r = cli("--check");
    assert.equal(r.code, 1);
    assert.match(r.err, /rows: H-1/);
    assert.match(r.err, /--import/);
    assert.match(cli("--status").out, /DRIFT .* changed H-1/);

    // Writing needs markers; --adopt adds them.
    r = cli();
    assert.equal(r.code, 1);
    assert.match(r.err, /--adopt/);
    r = cli("--adopt");
    assert.equal(r.code, 0);
    const adopted = readFileSync(mdPath, "utf8");
    assert.ok(adopted.includes(BEGIN) && adopted.includes(END));
    assert.ok(
      adopted.includes("green audit "),
      "the YAML wins over the hand edit",
    );
    assert.match(cli("--check").out, /is up to date/);

    // Once adopted, a stale table is regenerated by the plain command.
    writeFileSync(mdPath, adopted.replace("green audit ", "green audiT "));
    r = cli("--check");
    assert.equal(r.code, 1);
    assert.match(r.err, /rows: H-1/);
    assert.match(r.err, /npm run roadmap:sync`/);
    assert.equal(cli().code, 0);
    assert.equal(readFileSync(mdPath, "utf8"), adopted);

    // Padding-only drift names no rows; an import that cannot reproduce warns.
    writeFileSync(mdPath, adopted.replace("| 1   | **H-1**", "| 1 | **H-1**"));
    r = cli("--check");
    assert.equal(r.code, 1);
    assert.match(r.err, /only padding/);
    r = cli("--import");
    assert.equal(r.code, 0);
    assert.match(r.err, /WARNING/);

    // An exact table imports without normalisation.
    writeFileSync(mdPath, adopted);
    assert.match(cli("--import").out, /byte for byte/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the committed roadmap.yaml is valid, Prettier-clean and renders a valid table", async (t) => {
  const text = readFileSync(path.join(root, ROADMAP_YAML), "utf8");
  const doc = loadRoadmap(text);
  assert.equal(await prettier.format(text, { parser: "yaml" }), text);
  const table = renderTable(doc) + "\n";
  assert.equal(await prettierMd(table), table);

  // Live table: reported, not asserted (it is still hand-edited; see the header).
  try {
    const md = readFileSync(path.join(root, ROADMAP_MD), "utf8");
    const s = buildStatus(doc, md);
    t.diagnostic(
      s.sync.inSync
        ? "roadmap.yaml matches the live table"
        : `live drift: ${JSON.stringify(s.sync)}`,
    );
  } catch (e) {
    t.diagnostic(`live table not importable: ${e.message}`);
  }
});
