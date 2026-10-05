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
//   (e) an unpacked size above 3 MB.
//
// Why 3 MB: the 2.0.1 tarball unpacked to ~390 KB; 3.0 grew build/ to ~2.4 MB
// (97 tools in 26 packages plus script intelligence, explainers, document
// and Fluent generators), past the earlier 600 KB and 800 KB ceilings. The
// owner raised it to 3 MB on 2026-10-05 instead of bundling build/. 3 MB
// still catches the mistakes this guard exists for: src/, docs/, coverage/
// or the source maps leaking in each add far more than the remaining headroom.
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
const MAX_UNPACKED_BYTES = 3 * 1024 * 1024;

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
