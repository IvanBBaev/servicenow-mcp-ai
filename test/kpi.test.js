// N-97: the KPI snapshot counts the right issues, reads the Marketplace answer
// and keeps project/KPI.md a Prettier-clean table with one row per date.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  COLUMNS,
  appendRow,
  humanIssueCount,
  marketplaceInstalls,
  renderTable,
  snapshotCells,
} from "../scripts/kpi.mjs";

const root = path.join(import.meta.dirname, "..");

test("only issues by people other than the maintainer count", () => {
  const issues = [
    { user: { login: "someone", type: "User" } },
    { user: { login: "ivanbbaev", type: "User" } },
    { user: { login: "github-actions[bot]", type: "Bot" } },
    { user: { login: "other", type: "User" }, pull_request: {} },
    { user: { login: "another", type: "User" } },
  ];
  assert.equal(humanIssueCount(issues, "IvanBBaev"), 2);
  assert.equal(humanIssueCount([], "IvanBBaev"), 0);
});

test("the Marketplace install statistic is read, or left undefined", () => {
  const answer = {
    results: [
      {
        extensions: [
          {
            statistics: [
              { statisticName: "downloadCount", value: 9 },
              { statisticName: "install", value: 612.0 },
            ],
          },
        ],
      },
    ],
  };
  assert.equal(marketplaceInstalls(answer), 612);
  assert.equal(marketplaceInstalls({ results: [] }), undefined);
  assert.equal(marketplaceInstalls(undefined), undefined);
});

test("a source that could not be read is recorded as n/a", () => {
  const cells = snapshotCells({
    date: "2026-11-07",
    version: "3.1.1",
    stars: 0,
  });
  assert.equal(cells.length, COLUMNS.length);
  assert.deepEqual(cells.slice(0, 5), [
    "2026-11-07",
    "3.1.1",
    "n/a",
    "n/a",
    "0",
  ]);
});

test("a row is appended, a same-day row replaced, and the table stays padded", () => {
  const intro = "# KPIs\n\nText.\n\n";
  const empty = `${intro}${renderTable([])}\n`;
  const day1 = snapshotCells({
    date: "2026-11-07",
    version: "3.1.1",
    npmMonth: 5,
  });
  const day2 = snapshotCells({
    date: "2026-12-01",
    version: "3.2.0",
    npmMonth: 12345,
  });
  const once = appendRow(empty, day1);
  assert.ok(once.startsWith(intro));
  const twice = appendRow(appendRow(once, day2), day1);
  const rows = twice.split("\n").filter((line) => /^\| \d{4}-/.test(line));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^\| 2026-12-01 \| 3\.2\.0 /);
  const widths = new Set(
    twice
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .map((line) => line.length),
  );
  assert.equal(widths.size, 1, "every table line has the same width");
  assert.throws(() => appendRow("# no table\n", day1), /header is missing/);
});

test("project/KPI.md holds a KPI table", () => {
  const kpi = readFileSync(path.join(root, "project/KPI.md"), "utf8");
  assert.match(kpi, /^\| Date\s+\| Version\s+\|/m);
  assert.match(kpi, /^\| \d{4}-\d{2}-\d{2} \|/m);
});
