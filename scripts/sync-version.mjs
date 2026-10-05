// L9-12: one version, everywhere. package.json is the single source of truth;
// this script copies its version into every other file that carries one:
//
//   package-lock.json             version + packages[""].version
//   server.json                   version + every packages[].version
//   extension/package.json        version
//   extension/package-lock.json   version + packages[""].version
//   .claude-plugin/plugin.json    version
//   mcpb/manifest.json            version (N-51 bundle manifest)
//   docs/index.html               "softwareVersion": "<v>"  and  <span class="ver-pill">v<v></span>
//
// It is wired into `npm version` through the "version" lifecycle script, so a
// bump can never leave a follower behind (the 2.0.0-vs-2.0.1 plugin/extension
// skew is what this closes); test/version-sync.test.js is the guard that fails
// CI on any remaining drift.
//
//   node scripts/sync-version.mjs            rewrite the followers in place
//   node scripts/sync-version.mjs --check    dry run: list the drift, exit 1
//
// JSON followers are rewritten via parse/stringify (2-space indent, trailing
// newline). A follower whose committed form is not that canonical output —
// .claude-plugin/plugin.json keeps prettier's one-line arrays/objects — gets
// only its top-level "version" line replaced, because a canonical rewrite
// would fail `npm run format:check`. The result is re-parsed and compared with
// the intended document, so a nested version field this shortcut cannot reach
// is an error rather than a silent miss.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const setTopLevel = (json, version) => {
  json.version = version;
};
const setLockfile = (json, version) => {
  json.version = version;
  if (json.packages && json.packages[""]) json.packages[""].version = version;
};
const setServerJson = (json, version) => {
  json.version = version;
  for (const pkg of json.packages ?? []) pkg.version = version;
};

/** The files that follow package.json, in the order they are rewritten. */
export const FOLLOWERS = [
  { file: "package-lock.json", kind: "json", apply: setLockfile },
  { file: "server.json", kind: "json", apply: setServerJson },
  { file: "extension/package.json", kind: "json", apply: setTopLevel },
  { file: "extension/package-lock.json", kind: "json", apply: setLockfile },
  { file: ".claude-plugin/plugin.json", kind: "json", apply: setTopLevel },
  { file: "mcpb/manifest.json", kind: "json", apply: setTopLevel },
  { file: "docs/index.html", kind: "html" },
];

const SOFTWARE_VERSION = /"softwareVersion": "[^"]*"/;
const VER_PILL = /<span class="ver-pill">v[^<]*<\/span>/;

function nextJson(file, text, version, apply) {
  const wanted = JSON.parse(text);
  apply(wanted, version);
  const canonical = (json) => JSON.stringify(json, null, 2) + "\n";
  if (canonical(JSON.parse(text)) === text) return canonical(wanted);
  // Non-canonical (prettier-shaped) file: touch only the top-level version line.
  const patched = text.replace(
    /^( {2}"version": )"[^"]*"/m,
    (_match, key) => `${key}"${version}"`,
  );
  if (JSON.stringify(JSON.parse(patched)) !== JSON.stringify(wanted)) {
    throw new Error(
      `${file}: not in canonical JSON form and its version fields are not all top-level; ` +
        "reformat it (JSON.stringify, 2-space indent) or move the version to the top level",
    );
  }
  return patched;
}

function nextHtml(file, text, version) {
  if (!SOFTWARE_VERSION.test(text) || !VER_PILL.test(text)) {
    throw new Error(
      `${file}: expected both "softwareVersion": "<v>" and <span class="ver-pill">v<v></span>`,
    );
  }
  return text
    .replace(SOFTWARE_VERSION, `"softwareVersion": "${version}"`)
    .replace(VER_PILL, `<span class="ver-pill">v${version}</span>`);
}

/**
 * Bring every follower in `root` to the package.json version.
 * With `check` nothing is written. Returns the version and the followers that
 * were (or, under `check`, would be) rewritten.
 */
export function syncVersion({ root, check = false }) {
  const { version } = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  if (typeof version !== "string" || version === "") {
    throw new Error("package.json: missing version");
  }
  const drift = [];
  for (const follower of FOLLOWERS) {
    const abs = path.join(root, follower.file);
    const text = readFileSync(abs, "utf8");
    const next =
      follower.kind === "html"
        ? nextHtml(follower.file, text, version)
        : nextJson(follower.file, text, version, follower.apply);
    if (next === text) continue;
    drift.push(follower.file);
    if (!check) writeFileSync(abs, next);
  }
  return { version, drift };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  const check = process.argv.includes("--check");
  const root = path.join(import.meta.dirname, "..");
  try {
    const { version, drift } = syncVersion({ root, check });
    if (drift.length === 0) {
      console.log(`version-sync: every file is at ${version}`);
    } else if (check) {
      console.error(
        `version-sync: ${drift.length} file(s) drift from package.json ${version}:\n` +
          drift.map((file) => `  ${file}`).join("\n") +
          "\nRun: npm run version:sync",
      );
      process.exit(1);
    } else {
      console.log(`version-sync: wrote ${version} into ${drift.join(", ")}`);
    }
  } catch (err) {
    console.error(`version-sync: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
