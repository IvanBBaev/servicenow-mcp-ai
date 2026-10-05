// N-51 / TK-27: packs the MCP bundle (`.mcpb`) — a zip holding
// mcpb/manifest.json (as manifest.json), the compiled server and its
// production dependencies, so an MCPB host (Claude Desktop, …) installs the
// server in one click with no npm / npx on the user's machine.
//
// The bundle is built beside the npm package, never inside it: the staging
// happens in a temp dir, the output lands in the git-ignored dist/mcpb/, and
// package.json "files" does not change — pack:check is unaffected.
//
//   npm run mcpb:pack                      build + pack dist/mcpb/<name>-<version>.mcpb
//   npm run mcpb:pack -- --validate        also run the official validator
//                                          (npx @anthropic-ai/mcpb, fetched on demand,
//                                          never a dependency)
//
// Steps: check that mcpb/manifest.json is current -> copy build/ (no source
// maps, no dark Jira client), package.json, package-lock.json, LICENSE ->
// `npm ci --omit=dev` in the stage -> prune what the runtime never loads ->
// add manifest.json + icon.png -> write a deterministic zip.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";

/** Output directory for bundles, relative to the repository root. */
export const OUT_DIR = "dist/mcpb";

/** The pinned official CLI used by `--validate` (fetched by npx, not installed). */
export const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";

/** Fixed entry timestamp (1 Jan 2020, 00:00) — identical inputs, identical zip. */
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

/** True for a path the bundle never ships (relative, POSIX separators). */
export function excluded(rel) {
  const base = rel.split("/").at(-1);
  return (
    rel.endsWith(".map") ||
    /\.d\.[cm]?ts$/.test(rel) ||
    (rel.startsWith("build/") && rel.split("/").includes("jira")) ||
    rel.startsWith("node_modules/.bin") ||
    base === ".package-lock.json"
  );
}

/** Every regular file under `dir`, as sorted POSIX paths relative to it. */
export function listFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = lstatSync(childAbs);
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile()) out.push(childRel);
      // Symlinks (node_modules/.bin shims) are skipped: zips do not carry them
      // portably and the runtime never needs them.
    }
  };
  walk(dir, "");
  return out.sort();
}

/**
 * A minimal deterministic zip writer (stored central directory, deflate
 * entries, fixed timestamps, Unix mode kept). `entries`: { name, data, mode }.
 */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, mode = 0o644 } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = zlib.crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, spec 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  if (entries.length > 0xffff || offset > 0xffffffff) {
    throw new Error("bundle too large for a non-ZIP64 archive");
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** Build the bundle; returns { file, bytes, entries }. */
export function packBundle({ root, keepStage = false, validate = false }) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json")));
  const manifest = path.join(root, "mcpb", "manifest.json");
  const built = path.join(root, "build", "index.js");
  if (!existsSync(built))
    throw new Error("build/ is missing — run npm run build");
  const shipped = JSON.parse(readFileSync(manifest, "utf8"));
  if (shipped.version !== pkg.version) {
    throw new Error(
      `mcpb/manifest.json is at ${shipped.version}, package.json at ${pkg.version} — run npm run mcpb:manifest`,
    );
  }

  const stage = mkdtempSync(path.join(tmpdir(), "servicenow-mcp-mcpb-"));
  try {
    cpSync(path.join(root, "build"), path.join(stage, "build"), {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(root, src).split(path.sep).join("/");
        return !excluded(rel);
      },
    });
    for (const name of [
      "package.json",
      "package-lock.json",
      ".npmrc",
      "LICENSE",
    ]) {
      const src = path.join(root, name);
      if (existsSync(src)) cpSync(src, path.join(stage, name));
    }
    execFileSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      {
        cwd: stage,
        stdio: ["ignore", "ignore", "inherit"],
        shell: process.platform === "win32",
      },
    );
    rmSync(path.join(stage, ".npmrc"), { force: true });
    cpSync(manifest, path.join(stage, "manifest.json"));
    cpSync(
      path.join(root, "extension", "icon.png"),
      path.join(stage, "icon.png"),
    );
    if (validate) {
      // Validated in the stage, where icon.png sits next to manifest.json.
      execFileSync(
        process.platform === "win32" ? "npx.cmd" : "npx",
        ["--yes", MCPB_CLI, "validate", path.join(stage, "manifest.json")],
        { stdio: "inherit", shell: process.platform === "win32" },
      );
    }

    const entries = listFiles(stage)
      .filter((rel) => !excluded(rel))
      .map((rel) => {
        const abs = path.join(stage, ...rel.split("/"));
        const executable = (statSync(abs).mode & 0o111) !== 0;
        return {
          name: rel,
          data: readFileSync(abs),
          mode: executable ? 0o755 : 0o644,
        };
      });
    const outDir = path.join(root, OUT_DIR);
    mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${pkg.name}-${pkg.version}.mcpb`);
    const archive = zip(entries);
    writeFileSync(file, archive);
    return { file, bytes: archive.length, entries: entries.length, stage };
  } finally {
    if (!keepStage) rmSync(stage, { recursive: true, force: true });
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  const root = path.join(import.meta.dirname, "..");
  const validate = process.argv.includes("--validate");
  try {
    execFileSync(
      process.execPath,
      [
        "--experimental-transform-types",
        "--disable-warning=ExperimentalWarning",
        path.join(import.meta.dirname, "mcpb-manifest.mjs"),
        "--check",
      ],
      { stdio: "inherit" },
    );
    const { file, bytes, entries } = packBundle({ root, validate });
    const rel = path.relative(root, file);
    console.log(
      `mcpb:pack: ${rel} — ${(bytes / 1024).toFixed(1)} KB, ${entries} files`,
    );
  } catch (err) {
    console.error(`mcpb:pack: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
