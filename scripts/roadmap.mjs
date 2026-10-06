// N-41 (TK-16): project/roadmap.yaml is the machine-readable source of the
// ROADMAP-V3.md "Sequencing (must-haves first)" table. This script imports the
// table into the YAML file, renders the table back from it, checks the two for
// drift, and prints a status summary.
//
//   npm run roadmap:sync -- --import   one-shot: rebuild project/roadmap.yaml
//                                      from the current ROADMAP-V3.md table
//   npm run roadmap:sync -- --check    dry run: does the table rendered from
//                                      roadmap.yaml match ROADMAP-V3.md? exit 1
//                                      and list the drifting rows if not
//   npm run roadmap:sync               rewrite the table between the
//                                      GENERATED:ROADMAP markers (refuses when
//                                      the markers are missing)
//   npm run roadmap:sync -- --adopt    first switch to generated mode: wrap the
//                                      located table in the markers and render it
//   npm run roadmap:status             progress per pillar / status and the open
//                                      owner gates (--json for machines,
//                                      --from-table to count the live table
//                                      instead of roadmap.yaml)
//
// Until the owner adopts generated mode, ROADMAP-V3.md stays hand-edited and
// roadmap.yaml is a snapshot: re-run --import to refresh it. --check is
// deliberately not part of `npm run check` yet.
//
// File format — a restricted YAML subset (no YAML library; no new dependency).
// It is valid YAML 1.2 and a fixpoint of Prettier's YAML printer:
//
//   - full-line comments (`#` as the first non-blank character) and blank lines;
//   - top-level `key: scalar` pairs and one top-level `items:` block sequence;
//   - each sequence entry is a flat mapping: `  - key: value` opens an entry,
//     `    key: value` continues it (two-space indent, no nesting);
//   - a value is `null`, `true`, `false`, an integer, a double-quoted string
//     (JSON escapes), a single-quoted string (`''` for a quote — Prettier picks
//     it when a string contains `"` and no other escape), or a one-line flow
//     sequence of double-quoted strings (`[]`, `["O-10", "O-21"]`);
//   - no trailing comments, multi-line scalars, anchors, tags or flow mappings.
//
// Entry schema (field order is fixed; see FIELDS below):
//
//   item:   id, title, pillar, effort, status, phase, done, gates, notes
//   marker: marker, notes            (a non-numbered row such as a release cut)
//
//   pillar  primary pillar letter, `+O` when the owner shares it ("D+O")
//   effort  S / M / L or a range ("S–M", en dash)
//   status  done | partial | open    (🟢 | 🟡 | 🔴 in the table)
//   phase   "A", "R0", "T1"… from "Phase X" in the notes, or null
//   done    the date of the leading "**Done YYYY-MM-DD" / "**Partly done …" note
//   gates   owner gates (O-n) the notes reference
//   notes   the "Why this order" cell, Markdown, pipes unescaped
//
// `#` is not stored: the table numbers items by their position (markers show
// "—"). phase / done / gates are derived on --import and are structured data
// afterwards; the table renders only the notes.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROADMAP_MD = "project/ROADMAP-V3.md";
export const ROADMAP_YAML = "project/roadmap.yaml";
export const BEGIN = "<!-- GENERATED:ROADMAP:BEGIN (npm run roadmap:sync) -->";
export const END = "<!-- GENERATED:ROADMAP:END -->";
export const HEADER = [
  "#",
  "Item",
  "Pillar",
  "Why this order",
  "Effort",
  "Status",
];
export const PILLARS = ["H", "M", "S", "D", "E", "P", "N"];
export const STATUS_EMOJI = { done: "🟢", partial: "🟡", open: "🔴" };
const EMOJI_STATUS = Object.fromEntries(
  Object.entries(STATUS_EMOJI).map(([k, v]) => [v, k]),
);
const ITEM_FIELDS = [
  "id",
  "title",
  "pillar",
  "effort",
  "status",
  "phase",
  "done",
  "gates",
  "notes",
];
const MARKER_FIELDS = ["marker", "notes"];
const TOP_FIELDS = ["schema", "source", "imported"];
const MARKER_SEQ = "—";

// ---------------------------------------------------------------------------
// Restricted YAML subset
// ---------------------------------------------------------------------------

/** A scalar the way Prettier's YAML printer would leave it. */
export function yamlScalar(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isInteger(value))
      throw new Error(`roadmap.yaml: non-integer number ${value}`);
    return String(value);
  }
  if (typeof value === "string") {
    const json = JSON.stringify(value);
    if (/\\[^"]/.test(json.slice(1, -1)) || !value.includes('"')) return json;
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v !== "string" || /["\\]/.test(v)) {
        throw new Error(
          `roadmap.yaml: flow sequences hold plain strings only (${JSON.stringify(v)})`,
        );
      }
    }
    return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
  }
  throw new Error(`roadmap.yaml: unsupported value ${JSON.stringify(value)}`);
}

function parseScalar(text, lineNo) {
  const fail = (why) => {
    throw new Error(`roadmap.yaml line ${lineNo}: ${why}: ${text}`);
  };
  if (text === "null") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (text.startsWith('"')) {
    try {
      const v = JSON.parse(text);
      if (typeof v === "string") return v;
    } catch {
      // fall through
    }
    fail("bad double-quoted string");
  }
  if (text.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'$/.exec(text);
    if (!m) fail("bad single-quoted string");
    return m[1].replaceAll("''", "'");
  }
  if (text.startsWith("[")) {
    try {
      const v = JSON.parse(text);
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
    } catch {
      // fall through
    }
    fail("bad flow sequence (double-quoted strings only)");
  }
  return fail("unsupported scalar (quote strings)");
}

/** Serialise { ...top-level scalars, items: [flat mappings] } with a comment header. */
export function stringifyYaml(doc, { comment = [], itemFields } = {}) {
  const out = comment.map((l) => (l ? `# ${l}` : "#"));
  for (const [key, value] of Object.entries(doc)) {
    if (key === "items") continue;
    out.push(`${key}: ${yamlScalar(value)}`);
  }
  out.push("items:");
  for (const item of doc.items) {
    const keys = itemFields ? itemFields(item) : Object.keys(item);
    keys.forEach((key, i) => {
      out.push(`${i === 0 ? "  - " : "    "}${key}: ${yamlScalar(item[key])}`);
    });
  }
  return out.join("\n") + "\n";
}

/** Parse the restricted subset written by stringifyYaml (and by Prettier on it). */
export function parseYaml(text) {
  const doc = {};
  let items = null;
  let current = null;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;
    let m;
    if ((m = /^([a-z_]+):(?: (.*))?$/.exec(line))) {
      const [, key, value] = m;
      if (key in doc)
        throw new Error(`roadmap.yaml line ${lineNo}: duplicate key ${key}`);
      if (value === undefined) {
        if (key !== "items")
          throw new Error(
            `roadmap.yaml line ${lineNo}: only "items" may hold a block`,
          );
        items = doc.items = [];
      } else {
        if (items)
          throw new Error(
            `roadmap.yaml line ${lineNo}: top-level key after items`,
          );
        doc[key] = parseScalar(value, lineNo);
      }
      current = null;
      return;
    }
    if ((m = /^ {2}- ([a-z_]+): (.*)$/.exec(line)) && items) {
      current = { [m[1]]: parseScalar(m[2], lineNo) };
      items.push(current);
      return;
    }
    if ((m = /^ {4}([a-z_]+): (.*)$/.exec(line)) && current) {
      if (m[1] in current)
        throw new Error(`roadmap.yaml line ${lineNo}: duplicate key ${m[1]}`);
      current[m[1]] = parseScalar(m[2], lineNo);
      return;
    }
    throw new Error(
      `roadmap.yaml line ${lineNo}: outside the supported YAML subset: ${line}`,
    );
  });
  if (!items) throw new Error('roadmap.yaml: missing "items:"');
  return doc;
}

// ---------------------------------------------------------------------------
// Markdown table
// ---------------------------------------------------------------------------

/**
 * Display width as Prettier measures it for table padding: emoji with emoji
 * presentation and East Asian wide / fullwidth characters count 2, combining
 * marks and variation selectors 0, everything else 1.
 */
export function displayWidth(text) {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (
      /\p{Mark}/u.test(ch) ||
      (cp >= 0x200b && cp <= 0x200f) ||
      (cp >= 0xfe00 && cp <= 0xfe0f)
    ) {
      continue;
    }
    if (
      /\p{Emoji_Presentation}/u.test(ch) ||
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/** Raw cells of a table line (escaped pipes stay inside a cell, untrimmed). */
export function splitRow(line) {
  if (!line.startsWith("|") || !line.endsWith("|")) {
    throw new Error(`not a table row: ${line.slice(0, 80)}`);
  }
  const cells = [];
  let cell = "";
  for (let i = 1; i < line.length; i++) {
    if (line[i] === "\\" && line[i + 1] === "|") {
      cell += "\\|";
      i++;
    } else if (line[i] === "|") {
      cells.push(cell);
      cell = "";
    } else {
      cell += line[i];
    }
  }
  return cells;
}

const escapeCell = (text) => text.replaceAll("|", "\\|");
const unescapeCell = (text) => text.replaceAll("\\|", "|");

/** Find the sequencing table: between the markers when present, else by its header. */
export function locateTable(markdown) {
  const lines = markdown.split("\n");
  const bIdx = lines.indexOf(BEGIN);
  const eIdx = lines.indexOf(END);
  if (bIdx !== -1 || eIdx !== -1) {
    if (bIdx === -1 || eIdx === -1 || eIdx < bIdx) {
      throw new Error(`${ROADMAP_MD}: unbalanced ${BEGIN} / ${END} markers`);
    }
    const inner = [];
    for (let i = bIdx + 1; i < eIdx; i++) {
      if (lines[i].startsWith("|")) inner.push(i);
    }
    if (inner.length === 0) {
      return { lines, start: bIdx + 1, end: bIdx + 1, marked: true };
    }
    return { lines, start: inner[0], end: inner.at(-1) + 1, marked: true };
  }
  const start = lines.findIndex((l) => {
    if (!l.startsWith("|") || !l.endsWith("|")) return false;
    const cells = splitRow(l).map((c) => c.trim());
    return HEADER.every((h, i) => cells[i] === h);
  });
  if (start === -1)
    throw new Error(
      `${ROADMAP_MD}: sequencing table not found (header ${HEADER.join(" | ")})`,
    );
  let end = start;
  while (end < lines.length && lines[end].startsWith("|")) end++;
  return { lines, start, end, marked: false };
}

/**
 * The documented normalisations the importer applies to the hand-edited table
 * (anything else must round-trip byte for byte):
 *
 *   1. cells beyond the six header columns are dropped from the delimiter row
 *      and from body rows, provided they are blank. On 2026-10-05 the delimiter
 *      row carried a stray seventh `--- |` cell (and rows 61–63 a blank seventh
 *      cell); because GFM requires the delimiter row to match the header, the
 *      table did not render as a table at all.
 */
export function normalizeTableLines(tableLines) {
  const n = HEADER.length;
  return tableLines.map((line, i) => {
    const cells = splitRow(line);
    if (cells.length <= n) return line;
    const extra = cells.slice(n);
    const blank = i === 1 ? /^ *-+ *$/ : /^ *$/;
    if (!extra.every((c) => blank.test(c))) {
      throw new Error(
        `table line ${i + 1}: unexpected extra cells: ${extra.join("|").slice(0, 80)}`,
      );
    }
    return `|${cells.slice(0, n).join("|")}|`;
  });
}

const reDone = /\b(?:Partly done|Done) (\d{4}-\d{2}-\d{2})/;

/** Structured fields derived from the notes text. */
export function deriveFields(notes) {
  const phase = /\bPhase ([A-Z][0-9]?)\b/.exec(notes)?.[1] ?? null;
  const done = reDone.exec(notes)?.[1] ?? null;
  const gates = [...new Set(notes.match(/\bO-\d+\b/g) ?? [])].sort(
    (a, b) => Number(a.slice(2)) - Number(b.slice(2)),
  );
  return { phase, done, gates };
}

/** Table lines (header + delimiter + rows) → roadmap entries. */
export function importTable(tableLines) {
  const lines = normalizeTableLines(tableLines);
  const header = splitRow(lines[0]).map((c) => c.trim());
  if (header.join("|") !== HEADER.join("|"))
    throw new Error(`unexpected header: ${header.join(" | ")}`);
  const items = [];
  let seq = 0;
  for (let i = 2; i < lines.length; i++) {
    const [num, item, pillar, notesRaw, effort, statusRaw] = splitRow(
      lines[i],
    ).map((c) => c.trim());
    const notes = unescapeCell(notesRaw);
    const where = `table row ${i - 1} (${num} ${item.slice(0, 40)})`;
    if (num === MARKER_SEQ) {
      if (pillar || effort || statusRaw)
        throw new Error(`${where}: a marker row has only Item and notes`);
      items.push({ marker: unescapeCell(item), notes });
      continue;
    }
    seq++;
    if (Number(num) !== seq) throw new Error(`${where}: expected # ${seq}`);
    const m = /^\*\*([A-Z]+-\d+)\*\* (.+)$/.exec(item);
    if (!m) throw new Error(`${where}: Item must be "**ID** title"`);
    const status = EMOJI_STATUS[statusRaw];
    if (!status) throw new Error(`${where}: unknown status "${statusRaw}"`);
    items.push({
      id: m[1],
      title: unescapeCell(m[2]),
      pillar,
      effort,
      status,
      ...deriveFields(notes),
      notes,
    });
  }
  const doc = { items };
  validate(doc);
  return doc;
}

/** Schema check for a roadmap document; throws with every problem listed. */
export function validate(doc) {
  const problems = [];
  const ids = new Set();
  if (!Array.isArray(doc.items)) problems.push("items is not a list");
  for (const [i, it] of (doc.items ?? []).entries()) {
    const at = `items[${i}]${it.id ? ` ${it.id}` : ""}`;
    const isMarker = "marker" in it;
    const expected = isMarker ? MARKER_FIELDS : ITEM_FIELDS;
    const keys = Object.keys(it);
    if (keys.join() !== expected.join())
      problems.push(`${at}: fields ${keys.join(",")} ≠ ${expected.join(",")}`);
    const str = (k) =>
      typeof it[k] === "string" && it[k].length > 0 && !it[k].includes("\n");
    if (!str("notes"))
      problems.push(`${at}: notes must be a non-empty one-line string`);
    if (isMarker) {
      if (!str("marker"))
        problems.push(`${at}: marker must be a non-empty string`);
      continue;
    }
    if (!/^[A-Z]+-\d+$/.test(it.id ?? "")) problems.push(`${at}: bad id`);
    else if (ids.has(it.id)) problems.push(`${at}: duplicate id`);
    ids.add(it.id);
    if (!str("title")) problems.push(`${at}: title must be a non-empty string`);
    if (!/^[A-Z](\+O)?$/.test(it.pillar ?? ""))
      problems.push(`${at}: bad pillar ${it.pillar}`);
    if (!/^[SML](–[SML])?$/.test(it.effort ?? ""))
      problems.push(`${at}: bad effort ${it.effort}`);
    if (!(it.status in STATUS_EMOJI))
      problems.push(`${at}: bad status ${it.status}`);
    if (it.phase !== null && !/^[A-Z][0-9]?$/.test(it.phase))
      problems.push(`${at}: bad phase ${it.phase}`);
    if (it.done !== null && !/^\d{4}-\d{2}-\d{2}$/.test(it.done))
      problems.push(`${at}: bad done ${it.done}`);
    if (!Array.isArray(it.gates) || !it.gates.every((g) => /^O-\d+$/.test(g))) {
      problems.push(`${at}: gates must be a list of O-n ids`);
    }
  }
  if (problems.length)
    throw new Error(`invalid roadmap:\n  ${problems.join("\n  ")}`);
}

/** Entries → the Markdown table (lines joined by "\n", no trailing newline). */
export function renderTable(doc) {
  validate(doc);
  let seq = 0;
  const rows = doc.items.map((it) => {
    if ("marker" in it)
      return [
        MARKER_SEQ,
        escapeCell(it.marker),
        "",
        escapeCell(it.notes),
        "",
        "",
      ];
    seq++;
    return [
      String(seq),
      `**${it.id}** ${escapeCell(it.title)}`,
      it.pillar,
      escapeCell(it.notes),
      it.effort,
      STATUS_EMOJI[it.status],
    ];
  });
  const widths = HEADER.map((h, c) =>
    Math.max(3, displayWidth(h), ...rows.map((r) => displayWidth(r[c]))),
  );
  const line = (cells) =>
    `| ${cells.map((t, c) => t + " ".repeat(widths[c] - displayWidth(t))).join(" | ")} |`;
  return [
    line(HEADER),
    `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
    ...rows.map(line),
  ].join("\n");
}

/**
 * The ROADMAP-V3.md text with the table replaced by `table`. With markers the
 * region between them is replaced; without them only `adopt` may wrap the
 * located table in markers.
 */
export function replaceTable(markdown, table, { adopt = false } = {}) {
  const loc = locateTable(markdown);
  const { lines } = loc;
  if (loc.marked) {
    const begin = lines.indexOf(BEGIN);
    const end = lines.indexOf(END);
    return [
      ...lines.slice(0, begin + 1),
      "",
      table,
      "",
      ...lines.slice(end),
    ].join("\n");
  }
  if (!adopt) {
    throw new Error(
      `${ROADMAP_MD} has no ${BEGIN} markers yet; the table is still hand-edited. ` +
        "Run with --adopt to switch it to generated mode (owner decision).",
    );
  }
  return [
    ...lines.slice(0, loc.start),
    BEGIN,
    "",
    table,
    "",
    END,
    ...lines.slice(loc.end),
  ].join("\n");
}

/** Row ids that differ between two roadmap documents (for drift reports). */
export function diffItems(a, b) {
  const key = (it) => ("marker" in it ? `marker:${it.marker}` : it.id);
  const map = (doc) =>
    new Map(doc.items.map((it) => [key(it), JSON.stringify(it)]));
  const ma = map(a);
  const mb = map(b);
  const changed = [];
  const added = [];
  const removed = [];
  for (const [k, v] of mb) {
    if (!ma.has(k)) added.push(k);
    else if (ma.get(k) !== v) changed.push(k);
  }
  for (const k of ma.keys()) if (!mb.has(k)) removed.push(k);
  const order = a.items.map(key).join("\n") !== b.items.map(key).join("\n");
  return {
    changed,
    added,
    removed,
    reordered: order && !added.length && !removed.length,
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Owner gates from the "### O — Owner gates" checklist of ROADMAP-V3.md. */
export function parseOwnerGates(markdown) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => /^### O\b.*Owner gates/.test(l));
  if (start === -1) return [];
  const gates = [];
  for (let i = start + 1; i < lines.length && !/^#{1,3} /.test(lines[i]); i++) {
    const m = /^- \[( |x)\] \*\*(O-[^*]+)\*\* (.*)$/.exec(lines[i]);
    if (m) {
      gates.push({ id: m[2], open: m[1] === " ", text: m[3] });
    } else if (gates.length && /^ {2,}\S/.test(lines[i])) {
      gates.at(-1).text += ` ${lines[i].trim()}`;
    }
  }
  return gates;
}

function summaryOf(text, max = 96) {
  const first = text.split(/(?<=\.)\s/)[0].replace(/\*\*/g, "");
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** Counts per primary pillar and status, plus totals. */
export function statusCounts(doc) {
  const pillars = {};
  const total = { done: 0, partial: 0, open: 0, total: 0 };
  for (const it of doc.items) {
    if ("marker" in it) continue;
    const p = it.pillar[0];
    pillars[p] ??= { done: 0, partial: 0, open: 0, total: 0 };
    pillars[p][it.status]++;
    pillars[p].total++;
    total[it.status]++;
    total.total++;
  }
  const ordered = {};
  for (const p of [...PILLARS, ...Object.keys(pillars).sort()])
    if (pillars[p]) ordered[p] = pillars[p];
  return { pillars: ordered, total };
}

/**
 * The status report. Counts come from roadmap.yaml, or from the live table with
 * `fromTable`; the sync section always compares the YAML with the live table.
 */
export function buildStatus(yamlDoc, markdown, { fromTable = false } = {}) {
  const loc = locateTable(markdown);
  const liveLines = loc.lines.slice(loc.start, loc.end);
  const live = importTable(liveLines);
  const doc = fromTable ? live : yamlDoc;
  const source = fromTable ? `${ROADMAP_MD} (live table)` : ROADMAP_YAML;
  const counts = statusCounts(doc);
  const gates = parseOwnerGates(markdown);
  // In generated mode the table is rendered from the YAML, and re-importing it
  // is lossy (derived fields, escaping), so a byte-identical render is in sync.
  const rendered = loc.marked && liveLines.join("\n") === renderTable(yamlDoc);
  const drift = rendered
    ? { changed: [], added: [], removed: [], reordered: false }
    : diffItems(yamlDoc, live);
  const inSync =
    rendered ||
    (!drift.changed.length &&
      !drift.added.length &&
      !drift.removed.length &&
      !drift.reordered);
  const ownerShared = doc.items.filter(
    (it) =>
      !("marker" in it) && it.pillar.endsWith("+O") && it.status !== "done",
  );
  const byPhase = {};
  for (const it of doc.items) {
    if ("marker" in it || it.status === "done" || !it.phase) continue;
    (byPhase[it.phase] ??= []).push(it.id);
  }
  return {
    source,
    ...counts,
    openByPhase: byPhase,
    ownerShared: ownerShared.map((it) => it.id),
    ownerGates: gates.map((g) => ({ ...g, summary: summaryOf(g.text) })),
    sync: { inSync, generated: loc.marked, ...drift },
  };
}

function liveTableLines(markdown) {
  const loc = locateTable(markdown);
  return loc.lines.slice(loc.start, loc.end);
}

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "—");

export function formatStatus(s) {
  const out = [];
  out.push(`Roadmap status — ${s.source}`);
  out.push("");
  out.push("Pillar   Done  Partly  Open  Total  Done%");
  const row = (name, c) =>
    `${name.padEnd(6)} ${String(c.done).padStart(6)} ${String(c.partial).padStart(7)} ${String(c.open).padStart(5)} ${String(c.total).padStart(6)} ${pct(c.done, c.total).padStart(6)}`;
  for (const [p, c] of Object.entries(s.pillars)) out.push(row(p, c));
  out.push(row("All", s.total));
  const phases = Object.entries(s.openByPhase);
  if (phases.length) {
    out.push("");
    out.push("Not done, by phase:");
    for (const [p, ids] of phases.sort(([a], [b]) => a.localeCompare(b)))
      out.push(`  ${p.padEnd(3)} ${ids.join(", ")}`);
  }
  if (s.ownerShared.length) {
    out.push("");
    out.push(`Not done and owner-shared (+O): ${s.ownerShared.join(", ")}`);
  }
  const open = s.ownerGates.filter((g) => g.open);
  out.push("");
  out.push(`Open owner gates: ${open.length} of ${s.ownerGates.length}`);
  for (const g of open) out.push(`  ${g.id.padEnd(9)} ${g.summary}`);
  out.push("");
  if (s.sync.inSync) {
    out.push(`Sync: ${ROADMAP_YAML} matches the ${ROADMAP_MD} table.`);
  } else {
    const parts = [];
    if (s.sync.changed.length)
      parts.push(`changed ${s.sync.changed.join(", ")}`);
    if (s.sync.added.length)
      parts.push(`only in the table ${s.sync.added.join(", ")}`);
    if (s.sync.removed.length)
      parts.push(`only in the YAML ${s.sync.removed.join(", ")}`);
    if (s.sync.reordered) parts.push("rows reordered");
    out.push(
      `Sync: DRIFT between ${ROADMAP_YAML} and the ${ROADMAP_MD} table — ${parts.join("; ")}.`,
    );
    out.push(
      s.sync.generated
        ? "      The table is generated: re-render it with `npm run roadmap:sync`."
        : "      The table is still hand-edited: refresh with `npm run roadmap:sync -- --import`.",
    );
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const YAML_COMMENT = [
  "project/roadmap.yaml — machine-readable source of the ROADMAP-V3.md sequencing table (N-41).",
  "",
  "Format, schema and commands: scripts/roadmap.mjs (header comment). A restricted YAML subset:",
  "flat entries under `items`, one-line quoted strings, no anchors or multi-line scalars.",
  "Until the owner adopts generated mode the table is hand-edited and this file is a snapshot:",
  "refresh it with `npm run roadmap:sync -- --import`; `npm run roadmap:status` reports drift.",
];

export function serializeRoadmap(doc) {
  validate(doc);
  return stringifyYaml(doc, {
    comment: YAML_COMMENT,
    itemFields: (it) => ("marker" in it ? MARKER_FIELDS : ITEM_FIELDS),
  });
}

export function loadRoadmap(text) {
  const doc = parseYaml(text);
  for (const k of Object.keys(doc)) {
    if (k !== "items" && !TOP_FIELDS.includes(k))
      throw new Error(`roadmap.yaml: unknown top-level key ${k}`);
  }
  if (doc.schema !== 1)
    throw new Error(`roadmap.yaml: unsupported schema ${doc.schema}`);
  validate(doc);
  return doc;
}

/** CLI entry point; returns the exit code. `io` is injectable for tests. */
export function run(argv, io = {}) {
  const root =
    io.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  /* c8 ignore start: the process streams are only used from the command line */
  const out = io.stdout ?? ((s) => process.stdout.write(s + "\n"));
  const err = io.stderr ?? ((s) => process.stderr.write(s + "\n"));
  /* c8 ignore stop */
  const today = io.today ?? new Date().toISOString().slice(0, 10);
  const mdPath = path.join(root, ROADMAP_MD);
  const yamlPath = path.join(root, ROADMAP_YAML);
  const flags = new Set(argv);
  const known = [
    "--import",
    "--check",
    "--adopt",
    "--status",
    "--json",
    "--from-table",
  ];
  const unknown = argv.filter((a) => !known.includes(a));
  if (unknown.length) {
    err(
      `roadmap: unknown argument(s) ${unknown.join(" ")} (expected ${known.join(" ")})`,
    );
    return 2;
  }
  try {
    const markdown = readFileSync(mdPath, "utf8");

    if (flags.has("--import")) {
      const tableLines = liveTableLines(markdown);
      const doc = {
        schema: 1,
        source: ROADMAP_MD,
        imported: today,
        ...importTable(tableLines),
      };
      const rendered = renderTable(doc);
      const normalized = normalizeTableLines(tableLines).join("\n");
      writeFileSync(yamlPath, serializeRoadmap(doc));
      const n = doc.items.filter((it) => !("marker" in it)).length;
      out(
        `roadmap: wrote ${ROADMAP_YAML} — ${n} items, ${doc.items.length - n} marker row(s).`,
      );
      if (rendered === normalized) {
        const raw = tableLines.join("\n");
        out(
          rendered === raw
            ? "roadmap: round-trip exact — the rendered table equals the current table byte for byte."
            : "roadmap: round-trip exact after the documented normalisation (blank cells beyond the six header columns dropped).",
        );
      } else {
        err(
          "roadmap: WARNING — the rendered table differs from the current one (padding or escaping drift);",
        );
        err("         `npm run roadmap:sync -- --check` lists the rows.");
      }
      return 0;
    }

    const doc = loadRoadmap(readFileSync(yamlPath, "utf8"));

    if (flags.has("--status")) {
      const status = buildStatus(doc, markdown, {
        fromTable: flags.has("--from-table"),
      });
      out(
        flags.has("--json")
          ? JSON.stringify(status, null, 2)
          : formatStatus(status),
      );
      return 0;
    }

    const table = renderTable(doc);
    if (flags.has("--check")) {
      const loc = locateTable(markdown);
      const current = loc.lines.slice(loc.start, loc.end);
      const comparable = loc.marked
        ? current.join("\n")
        : normalizeTableLines(current).join("\n");
      if (comparable === table) {
        out(
          loc.marked
            ? `roadmap: ${ROADMAP_MD} table is up to date.`
            : `roadmap: ${ROADMAP_YAML} matches the hand-edited table (not adopted yet: no markers).`,
        );
        return 0;
      }
      const drift = diffItems(doc, importTable(current));
      const ids = [...drift.changed, ...drift.added, ...drift.removed];
      err(`roadmap: ${ROADMAP_MD} table is stale against ${ROADMAP_YAML}.`);
      err(
        ids.length
          ? `  rows: ${ids.join(", ")}`
          : "  rows match; only padding / order / escaping differs.",
      );
      err(
        loc.marked
          ? "  Run `npm run roadmap:sync` to regenerate it."
          : "  The table is still hand-edited: refresh the YAML with `npm run roadmap:sync -- --import`.",
      );
      return 1;
    }

    writeFileSync(
      mdPath,
      replaceTable(markdown, table, { adopt: flags.has("--adopt") }),
    );
    out(`roadmap: rendered the ${ROADMAP_MD} table from ${ROADMAP_YAML}.`);
    return 0;
  } catch (e) {
    err(`roadmap: ${e.message}`);
    return 1;
  }
}

/* c8 ignore start */
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = run(process.argv.slice(2));
}
/* c8 ignore stop */
