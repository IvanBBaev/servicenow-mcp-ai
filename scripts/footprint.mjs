// N-85: the install footprint record. Measures what `npm pack` would ship
// (files, tarball, unpacked size, the compiled build/ and the README) and
// what a production install pulls in (the lockfile's non-dev packages and
// their bytes on disk), and keeps the generated block of
// project/FOOTPRINT.md — between the GENERATED:FOOTPRINT markers — in step
// with the build, so the numbers quoted in a release note are the real ones.
//
//   npm run footprint              re-measure and rewrite the generated block
//   npm run footprint -- --check   dry run: re-measure and compare with the
//                                  recorded figures — the ceiling and the
//                                  dependency list exactly, every byte and
//                                  file count within 5 % — and refuse a
//                                  hand-edited block; exit 1 and name each
//                                  drift. Part of `npm run check`.
//
// Needs a prior `npm run build` (the tarball is measured from build/). The
// pack ceiling is read from scripts/pack-check.mjs, which stays the owner's
// file; this script never changes it. Guarded by test/footprint.test.js.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { displayWidth } from "./roadmap.mjs";

export const FOOTPRINT_MD = "project/FOOTPRINT.md";
export const BEGIN = "<!-- GENERATED:FOOTPRINT:BEGIN (npm run footprint) -->";
export const END = "<!-- GENERATED:FOOTPRINT:END -->";
const RECORD_PREFIX = "<!-- footprint: ";
const RECORD_SUFFIX = " -->";

/** Relative drift a byte figure or a count may show before --check fails. */
export const TOLERANCE = 0.05;
/** How many of the largest compiled files the record names. */
export const LARGEST = 5;

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

/** The `npm pack --dry-run --json` report (the first package). */
/* c8 ignore start: spawns npm — the gate runs it, the tests inject a report */
export function packDryRun(root) {
  // Mirrors scripts/pack-check.mjs: under `npm run`, npm_execpath is the
  // running npm's CLI script, so no shell and no PATH lookup is needed.
  const npmCli = process.env.npm_execpath;
  const args = ["pack", "--dry-run", "--json"];
  const options = {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  };
  const stdout = npmCli
    ? execFileSync(process.execPath, [npmCli, ...args], options)
    : execFileSync("npm", args, {
        ...options,
        shell: process.platform === "win32",
      });
  const [report] = JSON.parse(stdout);
  return report;
}
/* c8 ignore stop */

/** What the pack report says about the tarball; entries sorted by npm. */
export function summarizePack(report) {
  const files = Array.isArray(report.files) ? report.files : [];
  const build = files.filter(
    (f) => f.path.startsWith("build/") && f.path.endsWith(".js"),
  );
  const readme = files.find((f) => f.path === "README.md");
  return {
    entryCount: Number(report.entryCount ?? files.length),
    tarballBytes: Number(report.size),
    unpackedBytes: Number(report.unpackedSize),
    buildJsBytes: build.reduce((sum, f) => sum + Number(f.size), 0),
    readmeBytes: readme ? Number(readme.size) : 0,
    largest: [...build]
      .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))
      .slice(0, LARGEST)
      .map((f) => ({ path: f.path, bytes: Number(f.size) })),
  };
}

/** The unpacked-size ceiling that scripts/pack-check.mjs enforces. */
export function ceilingFrom(packCheckSource) {
  const match = /MAX_UNPACKED_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/.exec(
    packCheckSource,
  );
  if (!match) {
    throw new Error(
      "scripts/pack-check.mjs: MAX_UNPACKED_BYTES = <n> * 1024 * 1024 not found",
    );
  }
  return Number(match[1]) * 1024 * 1024;
}

/**
 * The production packages of a v3 lockfile: every `node_modules/...` entry
 * that is not dev-only, as `{ name, version, path }`, sorted by path. A
 * nested entry (`node_modules/a/node_modules/b`) is its own row.
 */
export function prodDependencies(lock) {
  const packages =
    lock && typeof lock.packages === "object" ? lock.packages : {};
  const rows = [];
  for (const [key, entry] of Object.entries(packages)) {
    if (key === "" || !key.includes("node_modules/")) continue;
    if (entry.dev === true) continue;
    const name = key.slice(
      key.lastIndexOf("node_modules/") + "node_modules/".length,
    );
    rows.push({ name, version: String(entry.version ?? ""), path: key });
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Bytes of a package's files on disk, nested node_modules excluded (those are
 * separate lockfile rows); null when the directory is not installed.
 */
export function installedBytes(dir) {
  let total = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path.join(current, entry.name));
      } else if (entry.isFile()) {
        total += statSync(path.join(current, entry.name)).size;
      }
    }
  };
  try {
    walk(dir);
  } catch {
    return null;
  }
  return total;
}

/** Measure the repository at `root`; `pack` defaults to running npm. */
export function measure(root, { pack = packDryRun, today } = {}) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(
    readFileSync(path.join(root, "package-lock.json"), "utf8"),
  );
  const ceilingBytes = ceilingFrom(
    readFileSync(path.join(root, "scripts", "pack-check.mjs"), "utf8"),
  );
  const dependencies = prodDependencies(lock).map((dep) => ({
    ...dep,
    bytes: installedBytes(path.join(root, dep.path)),
  }));
  const installed = dependencies.every((dep) => dep.bytes !== null)
    ? dependencies.reduce((sum, dep) => sum + dep.bytes, 0)
    : null;
  return {
    measured: today ?? new Date().toISOString().slice(0, 10),
    version: String(pkg.version),
    ...summarizePack(pack(root)),
    ceilingBytes,
    dependencies,
    installedBytes: installed,
  };
}

// ---------------------------------------------------------------------------
// Rendering (a Prettier fixpoint: padded pipe tables, no wrapped prose)
// ---------------------------------------------------------------------------

const n = (value) => value.toLocaleString("en-US");
const kb = (bytes) => `${n(Math.round(bytes / 1024))} KB`;
const bytesCell = (bytes) => `${n(bytes)} B (${kb(bytes)})`;
const percent = (part, whole) => `${Math.round((part / whole) * 100)} %`;

/** A Markdown pipe table padded the way Prettier prints it. */
export function table(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(3, displayWidth(h), ...rows.map((r) => displayWidth(r[i]))),
  );
  const pad = (cell, i) => cell + " ".repeat(widths[i] - displayWidth(cell));
  const line = (cells) => `| ${cells.map(pad).join(" | ")} |`;
  return [
    line(headers),
    `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
    ...rows.map(line),
  ].join("\n");
}

/** The generated block for a record (markers included). */
export function render(record) {
  const deps = record.dependencies;
  const installed =
    record.installedBytes === null
      ? "not installed locally"
      : kb(record.installedBytes);
  const largest = record.largest
    .map((f) => `\`${f.path}\` ${kb(f.bytes)}`)
    .join(", ");
  return [
    BEGIN,
    "",
    `${RECORD_PREFIX}${JSON.stringify(record)}${RECORD_SUFFIX}`,
    "",
    `Measured ${record.measured} for version ${record.version} with \`npm run footprint\`.`,
    "",
    table(
      ["Measure", "Value"],
      [
        ["`npm pack --dry-run` — files", n(record.entryCount)],
        ["`npm pack --dry-run` — tarball", bytesCell(record.tarballBytes)],
        ["`npm pack --dry-run` — unpacked", bytesCell(record.unpackedBytes)],
        [
          "`npm run pack:check` ceiling",
          `${bytesCell(record.ceilingBytes)} — ${percent(record.unpackedBytes, record.ceilingBytes)} used`,
        ],
        ["`build/**/*.js` in the tarball", bytesCell(record.buildJsBytes)],
        ["`README.md` in the tarball", bytesCell(record.readmeBytes)],
        [
          "Production packages (lockfile, excluding this one)",
          `${n(deps.length)} — ${installed}`,
        ],
      ],
    ),
    "",
    `Largest compiled files: ${largest}.`,
    "",
    table(
      ["Package", "Version", "Installed"],
      deps.map((dep) => [
        `\`${dep.name}\``,
        dep.version,
        dep.bytes === null ? "—" : kb(dep.bytes),
      ]),
    ),
    "",
    END,
  ].join("\n");
}

/** The record embedded in a generated block, or undefined. */
export function parseRecord(markdown) {
  for (const line of markdown.split("\n")) {
    if (line.startsWith(RECORD_PREFIX) && line.endsWith(RECORD_SUFFIX)) {
      return JSON.parse(
        line.slice(RECORD_PREFIX.length, line.length - RECORD_SUFFIX.length),
      );
    }
  }
  return undefined;
}

/** The text between the markers (markers included), or undefined. */
export function locateBlock(markdown) {
  const lines = markdown.split("\n");
  const begin = lines.indexOf(BEGIN);
  const end = lines.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) return undefined;
  return { begin, end, text: lines.slice(begin, end + 1).join("\n") };
}

/** `markdown` with its generated block replaced by `block`. */
export function replaceBlock(markdown, block) {
  const loc = locateBlock(markdown);
  if (!loc) {
    throw new Error(
      `${FOOTPRINT_MD}: the ${BEGIN} … ${END} markers are missing`,
    );
  }
  const lines = markdown.split("\n");
  return [
    ...lines.slice(0, loc.begin),
    block,
    ...lines.slice(loc.end + 1),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

const within = (recorded, measured) =>
  Math.abs(measured - recorded) <= TOLERANCE * Math.max(recorded, 1);

/**
 * Why `measured` no longer matches `recorded`: the ceiling and the dependency
 * list must match exactly, counts and byte figures within TOLERANCE. The
 * measured date and the version are informational.
 */
export function compare(recorded, measured) {
  const problems = [];
  if (recorded.ceilingBytes !== measured.ceilingBytes) {
    problems.push(
      `pack ceiling: recorded ${n(recorded.ceilingBytes)} B, pack-check.mjs enforces ${n(measured.ceilingBytes)} B`,
    );
  }
  const depList = (r) => r.dependencies.map((d) => `${d.name}@${d.version}`);
  const [was, is] = [depList(recorded), depList(measured)];
  if (was.join("\n") !== is.join("\n")) {
    const added = is.filter((d) => !was.includes(d));
    const removed = was.filter((d) => !is.includes(d));
    problems.push(
      `production packages: ${[...added.map((d) => `+${d}`), ...removed.map((d) => `-${d}`)].join(", ")}`,
    );
  }
  for (const key of [
    "entryCount",
    "tarballBytes",
    "unpackedBytes",
    "buildJsBytes",
    "readmeBytes",
    "installedBytes",
  ]) {
    const [a, b] = [recorded[key], measured[key]];
    if (typeof a !== "number" || typeof b !== "number") continue;
    if (!within(a, b)) {
      problems.push(
        `${key}: recorded ${n(a)}, measured ${n(b)} (more than ${TOLERANCE * 100} % apart)`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function run(argv, io = {}) {
  const root =
    io.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  /* c8 ignore start: the process streams are only used from the command line */
  const out = io.stdout ?? ((s) => process.stdout.write(s + "\n"));
  const err = io.stderr ?? ((s) => process.stderr.write(s + "\n"));
  /* c8 ignore stop */
  const unknown = argv.filter((a) => a !== "--check");
  if (unknown.length) {
    err(
      `footprint: unknown argument(s) ${unknown.join(" ")} (expected --check)`,
    );
    return 2;
  }
  const mdPath = path.join(root, FOOTPRINT_MD);
  try {
    const markdown = readFileSync(mdPath, "utf8");
    const measured = measure(root, { pack: io.pack, today: io.today });
    if (argv.includes("--check")) {
      const loc = locateBlock(markdown);
      const recorded = parseRecord(markdown);
      if (!loc || !recorded) {
        err(
          `footprint: ${FOOTPRINT_MD} has no generated block — run npm run footprint`,
        );
        return 1;
      }
      const problems = compare(recorded, measured);
      if (loc.text !== render(recorded)) {
        problems.push("the generated block was edited by hand");
      }
      if (problems.length) {
        err(`footprint: ${FOOTPRINT_MD} is out of date (npm run footprint):`);
        for (const p of problems) err(`  - ${p}`);
        return 1;
      }
      out(
        `footprint: ok — ${n(measured.entryCount)} files, ${kb(measured.unpackedBytes)} unpacked, ${measured.dependencies.length} production packages`,
      );
      return 0;
    }
    writeFileSync(mdPath, replaceBlock(markdown, render(measured)));
    out(`footprint: wrote ${FOOTPRINT_MD}`);
    return 0;
  } catch (error) {
    err(`footprint: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (path.resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = run(process.argv.slice(2));
}
