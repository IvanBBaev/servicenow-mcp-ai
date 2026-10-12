import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * N-35 / ADR 0008 — the protocol 2026-07-28 conformance matrix. Every
 * normative server requirement of the revision is one row in
 * test/fixtures/protocol-2026-07-28-conformance.json. "Full support" is proven
 * by tests, not claimed: a `covered` row names the tests that pin it, a
 * `pending` row names the N-35 step that will, and an `n/a` row says why the
 * server is out of its scope. The pending count only shrinks.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX_PATH = join(
  ROOT,
  "test/fixtures/protocol-2026-07-28-conformance.json",
);
const DOC_PATH = join(ROOT, "project/CONFORMANCE-2026-07-28.md");

const matrix = JSON.parse(readFileSync(MATRIX_PATH, "utf8"));
const rows = matrix.requirements;

const LEVELS = new Set(["MUST", "MUST NOT", "SHOULD", "SHOULD NOT"]);
const STATUSES = new Set(["covered", "pending", "n/a", "deviation"]);
const ID_PATTERN = /^[a-z]+-\d{2}$/;
/** RFC 2119: REQUIRED/SHALL mean MUST, RECOMMENDED means SHOULD. */
const KEYWORD_EQUIVALENTS = {
  MUST: ["REQUIRED", "SHALL"],
  SHOULD: ["RECOMMENDED"],
};
/** The core revision, plus the tasks extension published in its own repository. */
const SOURCES = [
  /^https:\/\/modelcontextprotocol\.io\/specification\/2026-07-28/,
  /^https:\/\/github\.com\/modelcontextprotocol\/ext-tasks\/blob\/main\/specification\/2026-07-28\//,
];

/** Parses `test/<file>.test.js :: <exact title>`. */
function parseTestRef(ref) {
  const match = /^(test\/[\w./-]+\.test\.js) :: (.+)$/.exec(ref);
  return match ? { file: match[1], title: match[2] } : null;
}

test("matrix header: revision, sources, areas and steps", () => {
  assert.equal(matrix.revision, "2026-07-28");
  assert.match(
    matrix.source,
    /^https:\/\/modelcontextprotocol\.io\/specification\/2026-07-28/,
  );
  assert.ok(Array.isArray(rows) && rows.length > 0, "no requirements");
  for (const [key, text] of Object.entries(matrix.steps)) {
    assert.match(key, /^[a-z][a-z0-9-]*$/, `step key ${key}`);
    assert.ok(text.length > 0, `step ${key} has no description`);
  }
  for (const [key, text] of Object.entries(matrix.areas)) {
    assert.match(key, /^[a-z]+$/, `area key ${key}`);
    assert.ok(text.length > 0, `area ${key} has no description`);
  }
});

test("every row is well formed: id, level, verbatim text, source, applies", () => {
  const seen = new Set();
  for (const row of rows) {
    assert.match(row.id, ID_PATTERN, `bad id ${row.id}`);
    assert.ok(!seen.has(row.id), `duplicate id ${row.id}`);
    seen.add(row.id);
    const area = row.id.replace(/-\d{2}$/, "");
    assert.ok(area in matrix.areas, `${row.id}: unknown area ${area}`);
    assert.ok(LEVELS.has(row.level), `${row.id}: bad level ${row.level}`);
    assert.ok(
      [row.level, ...(KEYWORD_EQUIVALENTS[row.level] ?? [])].some((k) =>
        row.text.includes(k),
      ),
      `${row.id}: text does not carry the keyword ${row.level}`,
    );
    assert.ok(
      SOURCES.some((re) => re.test(row.source)),
      `${row.id}: source ${row.source}`,
    );
    assert.ok(
      ["always", "http", "stdio", "tasks", "auth"].includes(row.applies),
      `${row.id}: applies`,
    );
    assert.ok(STATUSES.has(row.status), `${row.id}: bad status ${row.status}`);
  }
});

test("covered rows name tests that exist with that exact title", () => {
  const sources = new Map();
  for (const row of rows.filter((r) => r.status === "covered")) {
    assert.ok(
      Array.isArray(row.tests) && row.tests.length > 0,
      `${row.id}: covered without tests`,
    );
    for (const ref of row.tests) {
      const parsed = parseTestRef(ref);
      assert.ok(parsed, `${row.id}: bad test reference ${ref}`);
      const path = join(ROOT, parsed.file);
      assert.ok(existsSync(path), `${row.id}: missing ${parsed.file}`);
      if (!sources.has(path)) sources.set(path, readFileSync(path, "utf8"));
      assert.ok(
        sources.get(path).includes(JSON.stringify(parsed.title)),
        `${row.id}: no test titled ${JSON.stringify(parsed.title)} in ${parsed.file}`,
      );
    }
  }
});

test("pending rows name an N-35 step; n/a and deviation rows give a reason; none lists tests", () => {
  for (const row of rows) {
    if (row.status === "pending") {
      assert.ok(
        row.step in matrix.steps,
        `${row.id}: pending on unknown step ${row.step}`,
      );
    }
    if (row.status === "n/a" || row.status === "deviation") {
      assert.ok(
        typeof row.reason === "string" && row.reason.length > 0,
        `${row.id}: ${row.status} without reason`,
      );
    }
    if (row.status === "deviation") {
      assert.ok(
        Number.isInteger(row.ownerQuestion),
        `${row.id}: a deviation needs the owner decision (ownerQuestion)`,
      );
    }
    if (row.status !== "covered") {
      assert.equal(
        row.tests,
        undefined,
        `${row.id}: ${row.status} row lists tests`,
      );
    }
  }
});

test("the pending count only shrinks: lower `pendingCeiling` with each row covered", () => {
  const pending = rows.filter((r) => r.status === "pending").length;
  assert.ok(
    pending <= matrix.pendingCeiling,
    `${pending} pending rows exceed the ceiling ${matrix.pendingCeiling}`,
  );
  assert.equal(
    pending,
    matrix.pendingCeiling,
    `pending is ${pending}: lower pendingCeiling to ${pending} so it cannot grow back`,
  );
});

test("the project doc states the current counts", () => {
  const doc = readFileSync(DOC_PATH, "utf8");
  const count = (status) => rows.filter((r) => r.status === status).length;
  const cells = [
    rows.length,
    count("covered"),
    count("pending"),
    count("n/a"),
    count("deviation"),
  ];
  const expected = `| ${cells.join(" | ")} |`;
  // Prettier pads table cells, so match the row with any spacing.
  const row = new RegExp(
    `^\\|${cells.map((c) => ` *${c} *`).join("\\|")}\\|$`,
    "m",
  );
  assert.ok(row.test(doc), `${DOC_PATH} must carry the counts row ${expected}`);
});
