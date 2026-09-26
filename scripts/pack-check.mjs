// L9-04: tarball guard. Runs `npm pack --dry-run --json` and fails when the
// package that `npm publish` would ship contains something it must not:
//
//   (a) anything under a jira/ directory — the Jira client is dark until the
//       ARCH-14 decision lands, so its compiled modules stay out of the tarball
//       (package.json `files` excludes them; this proves the exclusion holds);
//   (b) a source map (`.map`);
//   (c) tests or instance docs (test/, docs/instance/);
//   (d) a top-level entry outside the allow-list below, which is exactly what
//       the 2.0.1 tarball contained;
//   (e) an unpacked size above 800 KB.
//
// Why 800 KB: the 2.0.1 tarball unpacks to ~390 KB and 3.0 keeps growing —
// every new tool package and the SDK artefact registry add to build/ (the
// 3.0 work tree reached ~640 KB on 2026-09-24, past the first 600 KB
// ceiling). 800 KB still catches the mistakes this guard exists for (src/,
// docs/, coverage/ or the maps leaking in), each of which adds far more than
// the remaining headroom.
//
// Wired into `npm run check`, hence into prepublishOnly and publish.yml.
import { execFileSync } from "node:child_process";

const ALLOWED_TOP_LEVEL = new Set([
  "LICENSE",
  "README.md",
  "package.json",
  "bin",
  "build",
]);
const MAX_UNPACKED_BYTES = 800 * 1024;

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

function packDryRun() {
  // Under `npm run`, npm_execpath is the running npm's CLI script: run it with
  // the current node so the check needs no shell and no PATH lookup (Windows
  // included). Outside npm, fall back to the `npm` on PATH.
  const npmCli = process.env.npm_execpath;
  const args = ["pack", "--dry-run", "--json"];
  const stdout = npmCli
    ? execFileSync(process.execPath, [npmCli, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      })
    : execFileSync("npm", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        shell: process.platform === "win32",
      });
  const [report] = JSON.parse(stdout);
  return report;
}

const report = packDryRun();
const problems = [];

for (const { path: entry } of report.files) {
  if (/(^|\/)jira\//.test(entry)) {
    problems.push(`jira code must not ship (ARCH-14 pending): ${entry}`);
  }
  if (entry.endsWith(".map")) {
    problems.push(`source map must not ship: ${entry}`);
  }
  if (entry.startsWith("test/") || entry.startsWith("docs/instance/")) {
    problems.push(`tests / instance docs must not ship: ${entry}`);
  }
  const top = entry.split("/")[0];
  if (!ALLOWED_TOP_LEVEL.has(top)) {
    problems.push(`unexpected top-level entry: ${entry}`);
  }
}

if (report.unpackedSize > MAX_UNPACKED_BYTES) {
  problems.push(
    `unpacked size ${kb(report.unpackedSize)} exceeds the ${kb(MAX_UNPACKED_BYTES)} ceiling`,
  );
}

if (problems.length > 0) {
  process.stderr.write(
    `pack-check: ${report.filename} must not be published:\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      "\n",
  );
  process.exit(1);
}

console.log(
  `pack-check: ${report.filename} — ${report.entryCount} files, ` +
    `${kb(report.unpackedSize)} unpacked (limit ${kb(MAX_UNPACKED_BYTES)}), ` +
    "no jira/, .map, test/ or docs/instance/ entries",
);
