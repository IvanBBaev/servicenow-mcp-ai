#!/usr/bin/env node
// P-29: the Fluent round-trip oracle.
//
// Takes every golden in test/fixtures/fluent/ (the emitters' output over the
// fixture records), writes it into one temporary ServiceNow SDK project and
//   1. type-checks every .now.ts against the real @servicenow/sdk types
//      (strict tsc, excess-property checks on), and
//   2. runs `now-sdk build` (offline) and checks that every record the
//      golden's keys file declares comes out under its own sys_id, as
//      dist/app/update/<table>_<sys_id>.xml or nested in its parent's update
//      XML (flow logic, playbook lanes), and that no DELETE is emitted (a
//      declared key no `$id` uses). Goldens that emit a common record (each is
//      a self-contained export) are built in separate projects.
//
// @servicenow/sdk is a dev dependency only (owner gate O-7). Without it
// (`npm ci --omit=dev`) the script prints a SKIPPED line and exits 0.
//
// Usage: node scripts/fluent-verify.mjs [--json] [--no-build] [--keep]
//   --json      print one JSON report on stdout (used by the test)
//   --no-build  type-check only
//   --keep      keep the temporary project and print its path

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const GOLDEN_DIR = path.join(ROOT, "test", "fixtures", "fluent");
const SDK_VERSION = "4.12.2";
const SCOPE = "x_fluent_oracle";
const SCOPE_ID = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const TSC_TIMEOUT_MS = 300_000;
const BUILD_TIMEOUT_MS = 300_000;

const argv = new Set(process.argv.slice(2));
const asJson = argv.has("--json");
const noBuild = argv.has("--no-build");
const keep = argv.has("--keep");

/** The installed SDK version, or undefined when the dev dependency is absent. */
export function sdkVersion() {
  // The SDK's exports map hides package.json from require.resolve, so read it
  // from node_modules directly.
  const pkg = path.join(
    ROOT,
    "node_modules",
    "@servicenow",
    "sdk",
    "package.json",
  );
  try {
    return JSON.parse(fs.readFileSync(pkg, "utf8")).version;
  } catch {
    return undefined;
  }
}

/** Split a golden into its files; `(…)` sections are metadata, not files. */
function goldenFiles(text) {
  const out = [];
  for (const part of text.split(/^=== /m).filter(Boolean)) {
    const nl = part.indexOf("\n");
    const name = part.slice(0, nl).trim();
    if (name.startsWith("(")) continue;
    out.push({ name, content: part.slice(nl + 1) });
  }
  return out;
}

/** `{ key, table, id }` entries of a keys fragment. */
function keyEntries(content) {
  const re =
    /'?([\w.-]+)'?\s*:\s*\{\s*table:\s*'([^']+)'\s*id:\s*'([^']+)'\s*\}/g;
  return [...content.matchAll(re)].map((m) => ({
    key: m[1],
    table: m[2],
    id: m[3],
  }));
}

function keysFile(entries) {
  const body = entries
    .map(
      (e) =>
        `                    '${e.key}': {\n                        table: '${e.table}'\n                        id: '${e.id}'\n                    }`,
    )
    .join("\n");
  return `import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
${body}
                }
            }
        }
    }
}
`;
}

/** Every golden's name (without `.golden.txt`), sorted. */
function allGoldens() {
  return fs
    .readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith(".golden.txt"))
    .map((g) => g.replace(/\.golden\.txt$/, ""))
    .sort();
}

/**
 * Goldens split into build groups that share no keyed record. Each golden is
 * a self-contained export, so two of them may both emit one record (a
 * catalog item and the variable set it uses); in one project `now-sdk build`
 * rejects that as a duplicate definition.
 */
function buildGroups(goldens) {
  const groups = [];
  for (const name of goldens) {
    const ids = new Set();
    for (const f of goldenFiles(
      fs.readFileSync(path.join(GOLDEN_DIR, `${name}.golden.txt`), "utf8"),
    )) {
      if (!f.name.endsWith(".keys.ts")) continue;
      for (const e of keyEntries(f.content)) ids.add(`${e.table}:${e.id}`);
    }
    let g = groups.find((x) => ![...ids].some((id) => x.ids.has(id)));
    if (!g) groups.push((g = { names: [], ids: new Set() }));
    g.names.push(name);
    for (const id of ids) g.ids.add(id);
  }
  return groups.map((g) => g.names);
}

/** Write a temporary SDK project over `goldens`; returns its path and the expected records. */
function scaffold(goldens) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fluent-oracle-"));
  const fluent = path.join(dir, "src", "fluent");
  fs.mkdirSync(path.join(fluent, "generated"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src", "server"), { recursive: true });
  fs.symlinkSync(
    path.join(ROOT, "node_modules"),
    path.join(dir, "node_modules"),
  );
  const keys = new Map();
  const conflicts = [];
  const expected = [];
  for (const name of goldens) {
    const out = path.join(fluent, name);
    fs.mkdirSync(out, { recursive: true });
    for (const f of goldenFiles(
      fs.readFileSync(path.join(GOLDEN_DIR, `${name}.golden.txt`), "utf8"),
    )) {
      if (f.name.endsWith(".keys.ts")) {
        for (const e of keyEntries(f.content)) {
          const prev = keys.get(e.key);
          if (prev && (prev.id !== e.id || prev.table !== e.table)) {
            conflicts.push(
              `${name}: key '${e.key}' is also ${prev.table} ${prev.id} in ${prev.golden}`,
            );
            continue;
          }
          keys.set(e.key, { ...e, golden: name });
          expected.push({ golden: name, ...e });
        }
        continue; // merged into generated/keys.ts below
      }
      fs.writeFileSync(path.join(out, f.name), f.content);
    }
  }
  fs.writeFileSync(
    path.join(fluent, "generated", "keys.ts"),
    keysFile([...keys.values()]),
  );
  fs.writeFileSync(
    path.join(dir, "now.config.json"),
    JSON.stringify(
      {
        scope: SCOPE,
        scopeId: SCOPE_ID,
        name: "fluent-oracle",
        tsconfigPath: "./src/server/tsconfig.json",
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "fluent-oracle",
        version: "0.0.1",
        private: true,
        devDependencies: { "@servicenow/sdk": SDK_VERSION },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(dir, "src", "server", "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "es2022",
          target: "es2022",
          moduleResolution: "bundler",
          allowJs: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["./**/*.ts"],
        exclude: ["**/*.now.ts"],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(dir, "src", "server", "index.ts"), "export {}\n");
  fs.writeFileSync(
    path.join(dir, "tsconfig.oracle.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "es2022",
          target: "es2022",
          moduleResolution: "bundler",
          noEmit: true,
          strict: true,
          skipLibCheck: true,
          types: [],
        },
        include: ["src/fluent/**/*.ts"],
      },
      null,
      2,
    ),
  );
  return { dir, expected, conflicts };
}

/** tsc diagnostics as `{ file, line, message }`. */
function typeCheck(dir) {
  const tsc = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const r = spawnSync(
    process.execPath,
    [tsc, "-p", "tsconfig.oracle.json", "--pretty", "false"],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: TSC_TIMEOUT_MS,
    },
  );
  if (r.error)
    return { errors: [{ file: "(tsc)", line: 0, message: String(r.error) }] };
  const errors = [];
  for (const line of `${r.stdout}${r.stderr}`.split("\n")) {
    const m = /^(.+?)\((\d+),\d+\): error (TS\d+: .*)$/.exec(line.trim());
    if (m) errors.push({ file: m[1], line: Number(m[2]), message: m[3] });
    else if (/error TS\d+/.test(line))
      errors.push({ file: "(tsc)", line: 0, message: line.trim() });
  }
  if (r.status !== 0 && errors.length === 0) {
    errors.push({ file: "(tsc)", line: 0, message: `tsc exited ${r.status}` });
  }
  return { errors };
}

/** `now-sdk build`, then the expected record files. */
function build(dir, expected) {
  const bin = path.join(
    ROOT,
    "node_modules",
    "@servicenow",
    "sdk",
    "bin",
    "index.js",
  );
  const cmd = fs.existsSync(bin)
    ? [process.execPath, [bin, "build"]]
    : [path.join(ROOT, "node_modules", ".bin", "now-sdk"), ["build"]];
  const r = spawnSync(cmd[0], cmd[1], {
    cwd: dir,
    encoding: "utf8",
    timeout: BUILD_TIMEOUT_MS,
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
  });
  const log = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.error || r.status !== 0) {
    return {
      ok: false,
      log: log.split("\n").slice(-40).join("\n") || String(r.error),
      missing: [],
    };
  }
  const update = path.join(dir, "dist", "app", "update");
  const files = new Set(fs.existsSync(update) ? fs.readdirSync(update) : []);
  // Composite records (flow logic and actions, playbook lanes) are written
  // inside the parent's update XML, not as files of their own.
  const xml = [...files]
    .map((f) => fs.readFileSync(path.join(update, f), "utf8"))
    .join("\n");
  const missing = [];
  let checked = 0;
  for (const e of expected) {
    const file = `${e.table}_${e.id}.xml`;
    const own = files.has(file)
      ? fs.readFileSync(path.join(update, file), "utf8")
      : null;
    if (
      own
        ? !own.includes(`<sys_id>${e.id}</sys_id>`)
        : !xml.includes(`<sys_id>${e.id}</sys_id>`)
    ) {
      missing.push(
        own
          ? `${e.golden}: ${file} does not carry sys_id ${e.id}`
          : `${e.golden}: ${e.key} -> ${file}`,
      );
      continue;
    }
    checked++;
  }
  // A DELETE here means a keys.ts entry no `$id` uses: installing would
  // remove that record from the instance.
  const elective = path.join(dir, "dist", "app", "author_elective_update");
  for (const f of fs.existsSync(elective) ? fs.readdirSync(elective) : []) {
    if (/action="DELETE"/.test(fs.readFileSync(path.join(elective, f), "utf8")))
      missing.push(`DELETE emitted for ${f} (a declared key no $id uses)`);
  }
  return {
    ok: missing.length === 0,
    log: "",
    missing,
    checked,
    records: files.size,
  };
}

function main() {
  const version = sdkVersion();
  if (!version) {
    const msg =
      "SKIPPED: @servicenow/sdk is not installed (dev dependency; npm ci --omit=dev). The Fluent oracle needs it.";
    if (asJson) console.log(JSON.stringify({ skipped: true, reason: msg }));
    else console.log(msg);
    return 0;
  }
  const goldens = allGoldens();
  const { dir, conflicts } = scaffold(goldens);
  const tc = typeCheck(dir);
  const rel = (f) => f.replace(/^src\/fluent\//, "");
  const report = {
    skipped: false,
    sdk: version,
    goldens: goldens.length,
    typeErrors: tc.errors.map((e) => `${rel(e.file)}(${e.line}): ${e.message}`),
    keyConflicts: conflicts,
    build: undefined,
  };
  const dirs = [dir];
  if (!noBuild && tc.errors.length === 0) {
    const total = { ok: true, log: "", missing: [], checked: 0, records: 0 };
    const groups = buildGroups(goldens);
    for (const group of groups) {
      const p = scaffold(group);
      dirs.push(p.dir);
      const r = build(p.dir, p.expected);
      total.ok &&= r.ok;
      total.log += r.log;
      total.missing.push(...r.missing);
      total.checked += r.checked ?? 0;
      total.records += r.records ?? 0;
      if (!r.ok) break;
    }
    total.projects = groups.length;
    report.build = total;
  }
  if (keep) report.project = dirs.join(", ");
  else for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });

  const ok =
    report.typeErrors.length === 0 &&
    conflicts.length === 0 &&
    (noBuild || report.build?.ok === true);
  report.ok = ok;
  if (asJson) {
    console.log(JSON.stringify(report));
  } else {
    console.log(
      `Fluent oracle: @servicenow/sdk ${version}, ${goldens.length} goldens.`,
    );
    console.log(`Type check: ${report.typeErrors.length} error(s).`);
    for (const e of report.typeErrors) console.log(`  ${e}`);
    for (const c of conflicts) console.log(`  key conflict: ${c}`);
    if (noBuild) console.log("Build: skipped (--no-build).");
    else if (!report.build) console.log("Build: not run (type errors).");
    else if (report.build.ok)
      console.log(
        `Build: ok (${report.build.projects} project(s)); ${report.build.checked} keyed record(s) found among ${report.build.records} built.`,
      );
    else {
      console.log("Build: FAILED.");
      for (const m of report.build.missing) console.log(`  missing: ${m}`);
      if (report.build.log) console.log(report.build.log);
    }
    if (keep) console.log(`Project kept at ${dir}`);
  }
  return ok ? 0 : 1;
}

process.exitCode = main();
