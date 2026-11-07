#!/usr/bin/env node
// N-97 (PO-I1): the adoption KPI snapshot — no telemetry, only public numbers.
// Reads npm downloads (last 30 days), the VS Code Marketplace install count,
// and — through the `gh` CLI — stars, forks, discussions and the issues opened
// by people other than the maintainer and bots. Appends one dated row to
// project/KPI.md (a second run on the same day replaces that day's row). A
// source that cannot be read is recorded as "n/a", never guessed. Run it at
// every release and at each checkpoint.
//
//   npm run kpi            # append the row
//   npm run kpi -- --dry   # print the row, write nothing
//
// Guarded by test/kpi.test.js.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const KPI_FILE = "project/KPI.md";
const REPO = "IvanBBaev/servicenow-mcp-ai";
const MAINTAINER = "IvanBBaev";
const EXTENSION_ID = "ivanbbaev.servicenow-mcp-ai";
const TIMEOUT_MS = 20_000;

export const COLUMNS = [
  ["date", "Date"],
  ["version", "Version"],
  ["npmMonth", "npm downloads (30 d)"],
  ["marketplaceInstalls", "Marketplace installs"],
  ["stars", "Stars"],
  ["forks", "Forks"],
  ["humanIssues", "Issues by others"],
  ["discussions", "Discussions"],
];

/** Issues (not pull requests) opened by a person other than the maintainer. */
export function humanIssueCount(issues, maintainer = MAINTAINER) {
  return issues.filter(
    (issue) =>
      !issue.pull_request &&
      issue.user?.type === "User" &&
      issue.user.login.toLowerCase() !== maintainer.toLowerCase(),
  ).length;
}

/** The install count from a Marketplace extensionquery answer. */
export function marketplaceInstalls(answer) {
  const stats = answer?.results?.[0]?.extensions?.[0]?.statistics ?? [];
  const install = stats.find((s) => s.statisticName === "install");
  return install === undefined ? undefined : Math.round(install.value);
}

/** The cells of one snapshot; a missing value is "n/a". */
export function snapshotCells(snapshot) {
  return COLUMNS.map(([key]) => String(snapshot[key] ?? "n/a"));
}

/** A Markdown table padded the way Prettier pads it, so the gate stays green. */
export function renderTable(rows) {
  const header = COLUMNS.map(([, label]) => label);
  const widths = header.map((label, i) =>
    Math.max(3, label.length, ...rows.map((row) => row[i].length)),
  );
  const line = (cells) =>
    `| ${cells.map((cell, i) => cell.padEnd(widths[i])).join(" | ")} |`;
  return [
    line(header),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
  ].join("\n");
}

/**
 * Put `cells` into the KPI table that ends `markdown`; a row for the same date
 * is replaced. Throws when the file has no KPI table.
 */
export function appendRow(markdown, cells) {
  const lines = markdown.replace(/\n+$/, "").split("\n");
  const start = lines.findIndex((line) => /^\|\s*Date\s*\|/.test(line));
  if (start === -1) {
    throw new Error(`${KPI_FILE}: the KPI table header is missing`);
  }
  const rows = lines
    .slice(start + 2)
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter((row) => row[0] !== cells[0]);
  const table = renderTable([...rows, cells]);
  return `${[...lines.slice(0, start), table].join("\n")}\n`;
}

async function fetchJson(url, init) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function gh(args) {
  return JSON.parse(
    execFileSync("gh", args, { encoding: "utf8", timeout: TIMEOUT_MS * 3 }),
  );
}

/** Run each reader; a failing one is reported on stderr and left undefined. */
async function read(label, reader) {
  try {
    return await reader();
  } catch (error) {
    console.error(`kpi: ${label} unavailable — ${error.message}`);
    return undefined;
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === import.meta.filename
) {
  const dry = process.argv.includes("--dry");
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const [owner, name] = REPO.split("/");
  const snapshot = {
    date: new Date().toISOString().slice(0, 10),
    version: pkg.version,
    npmMonth: await read(
      "npm",
      async () =>
        (
          await fetchJson(
            `https://api.npmjs.org/downloads/point/last-month/${pkg.name}`,
          )
        ).downloads,
    ),
    marketplaceInstalls: await read("Marketplace", async () =>
      marketplaceInstalls(
        await fetchJson(
          "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json;api-version=3.0-preview.1",
            },
            body: JSON.stringify({
              filters: [{ criteria: [{ filterType: 7, value: EXTENSION_ID }] }],
              flags: 914,
            }),
          },
        ),
      ),
    ),
    ...(await read("GitHub repository", () => {
      const repo = gh(["api", `repos/${REPO}`]);
      return { stars: repo.stargazers_count, forks: repo.forks_count };
    })),
    humanIssues: await read("GitHub issues", () =>
      humanIssueCount(
        gh([
          "api",
          "--paginate",
          "--slurp",
          `repos/${REPO}/issues?state=all&per_page=100`,
        ]).flat(),
      ),
    ),
    discussions: await read(
      "GitHub discussions",
      () =>
        gh([
          "api",
          "graphql",
          "-f",
          `query={repository(owner:"${owner}",name:"${name}"){discussions{totalCount}}}`,
        ]).data.repository.discussions.totalCount,
    ),
  };
  const cells = snapshotCells(snapshot);
  if (dry) {
    console.log(renderTable([cells]));
  } else {
    const file = path.join(ROOT, KPI_FILE);
    try {
      writeFileSync(file, appendRow(readFileSync(file, "utf8"), cells));
      console.log(`kpi: ${KPI_FILE} ← ${cells.join(" | ")}`);
    } catch (error) {
      console.error(`kpi: ${error.message}`);
      process.exit(1);
    }
  }
}
