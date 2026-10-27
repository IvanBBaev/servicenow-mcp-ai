// N-85: scripts/footprint.mjs — the install footprint record behind
// project/FOOTPRINT.md and `npm run footprint -- --check` in the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import {
  BEGIN,
  END,
  FOOTPRINT_MD,
  LARGEST,
  TOLERANCE,
  ceilingFrom,
  compare,
  installedBytes,
  locateBlock,
  measure,
  parseRecord,
  prodDependencies,
  render,
  replaceBlock,
  run,
  summarizePack,
  table,
} from "../scripts/footprint.mjs";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const prettierMd = (text) =>
  prettier.format(text, { parser: "markdown", proseWrap: "preserve" });

const packReport = {
  entryCount: 5,
  size: 4_000,
  unpackedSize: 12_000,
  files: [
    { path: "README.md", size: 3_000 },
    { path: "package.json", size: 500 },
    { path: "build/index.js", size: 1_000 },
    { path: "build/api/table.js", size: 6_000 },
    { path: "build/core/http.js", size: 1_500 },
  ],
};

const lock = {
  lockfileVersion: 3,
  packages: {
    "": { name: "servicenow-mcp-ai", version: "3.0.0" },
    "node_modules/zod": { version: "4.6.7" },
    "node_modules/typescript": { version: "5.9.3", dev: true },
    "node_modules/@modelcontextprotocol/server": { version: "2.3.1" },
    "node_modules/@modelcontextprotocol/node/node_modules/@hono/node-server": {
      version: "1.19.17",
    },
  },
};

const record = () => ({
  measured: "2026-10-27",
  version: "3.0.0",
  ...summarizePack(packReport),
  ceilingBytes: 3 * 1024 * 1024,
  dependencies: [
    { name: "zod", version: "4.6.7", path: "node_modules/zod", bytes: 2_048 },
    {
      name: "@modelcontextprotocol/server",
      version: "2.3.1",
      path: "node_modules/@modelcontextprotocol/server",
      bytes: 1_024,
    },
  ],
  installedBytes: 3_072,
});

/** A throwaway repository root with everything measure() reads. */
function fakeRoot({ withBlock = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "footprint-"));
  mkdirSync(path.join(root, "project"));
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "node_modules", "zod"), { recursive: true });
  writeFileSync(
    path.join(root, "node_modules", "zod", "index.js"),
    "x".repeat(100),
  );
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "servicenow-mcp-ai", version: "3.0.0" }),
  );
  writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { version: "3.0.0" },
        "node_modules/zod": { version: "4.6.7" },
        "node_modules/typescript": { version: "5.9.3", dev: true },
      },
    }),
  );
  writeFileSync(
    path.join(root, "scripts", "pack-check.mjs"),
    "const MAX_UNPACKED_BYTES = 3 * 1024 * 1024;\n",
  );
  writeFileSync(
    path.join(root, FOOTPRINT_MD),
    withBlock
      ? `# Footprint\n\nIntro.\n\n${BEGIN}\n\n${END}\n\nOutro.\n`
      : "# Footprint\n\nNo block.\n",
  );
  return root;
}

const io = (root, overrides = {}) => {
  const out = [];
  const errs = [];
  return {
    io: {
      root,
      stdout: (s) => out.push(s),
      stderr: (s) => errs.push(s),
      pack: () => packReport,
      today: "2026-10-27",
      ...overrides,
    },
    out,
    errs,
  };
};

test("summarizePack sums the compiled files and names the largest", () => {
  const s = summarizePack(packReport);
  assert.equal(s.entryCount, 5);
  assert.equal(s.tarballBytes, 4_000);
  assert.equal(s.unpackedBytes, 12_000);
  assert.equal(s.buildJsBytes, 8_500);
  assert.equal(s.readmeBytes, 3_000);
  assert.deepEqual(
    s.largest.map((f) => f.path),
    ["build/api/table.js", "build/core/http.js", "build/index.js"],
  );
  assert.ok(s.largest.length <= LARGEST);
  // No README, no files: zeros rather than NaN.
  assert.deepEqual(summarizePack({ size: 1, unpackedSize: 1 }), {
    entryCount: 0,
    tarballBytes: 1,
    unpackedBytes: 1,
    buildJsBytes: 0,
    readmeBytes: 0,
    largest: [],
  });
});

test("ceilingFrom reads the pack-check ceiling and refuses to guess", () => {
  assert.equal(
    ceilingFrom("const MAX_UNPACKED_BYTES = 3 * 1024 * 1024;"),
    3_145_728,
  );
  assert.throws(() => ceilingFrom("const LIMIT = 3;"), /MAX_UNPACKED_BYTES/);
  // The real guard still has the constant this script reads.
  const real = readFileSync(
    path.join(repoRoot, "scripts", "pack-check.mjs"),
    "utf8",
  );
  assert.equal(ceilingFrom(real), 3 * 1024 * 1024);
});

test("prodDependencies keeps the non-dev lockfile entries, nested ones included", () => {
  assert.deepEqual(prodDependencies(lock), [
    {
      name: "@hono/node-server",
      version: "1.19.17",
      path: "node_modules/@modelcontextprotocol/node/node_modules/@hono/node-server",
    },
    {
      name: "@modelcontextprotocol/server",
      version: "2.3.1",
      path: "node_modules/@modelcontextprotocol/server",
    },
    { name: "zod", version: "4.6.7", path: "node_modules/zod" },
  ]);
  assert.deepEqual(prodDependencies({}), []);
});

test("installedBytes sums a package's files and skips nested node_modules", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "footprint-pkg-"));
  writeFileSync(path.join(dir, "a.js"), "x".repeat(10));
  mkdirSync(path.join(dir, "lib"));
  writeFileSync(path.join(dir, "lib", "b.js"), "x".repeat(5));
  mkdirSync(path.join(dir, "node_modules", "nested"), { recursive: true });
  writeFileSync(
    path.join(dir, "node_modules", "nested", "c.js"),
    "x".repeat(99),
  );
  assert.equal(installedBytes(dir), 15);
  assert.equal(installedBytes(path.join(dir, "missing")), null);
});

test("measure reads the real repository with an injected pack report", () => {
  const m = measure(repoRoot, { pack: () => packReport, today: "2026-10-27" });
  const pkg = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  assert.equal(m.version, pkg.version);
  assert.equal(m.measured, "2026-10-27");
  assert.equal(m.ceilingBytes, 3 * 1024 * 1024);
  assert.equal(m.entryCount, 5);
  const names = m.dependencies.map((d) => d.name);
  assert.ok(names.includes("zod"));
  assert.ok(names.includes("@modelcontextprotocol/server"));
  assert.ok(!names.includes("typescript"), "dev packages are not production");
  // The dev install holds the production packages, so their bytes are known.
  assert.equal(typeof m.installedBytes, "number");
  assert.ok(m.installedBytes > 0);
});

test("table pads cells the way Prettier prints a pipe table", async () => {
  const text = table(
    ["A", "Bee"],
    [
      ["x", "—"],
      ["longer", "y"],
    ],
  );
  assert.equal(
    text,
    "| A      | Bee |\n| ------ | --- |\n| x      | —   |\n| longer | y   |",
  );
  assert.equal(await prettierMd(text + "\n"), text + "\n");
});

test("render is a Prettier fixpoint and round-trips its record", async () => {
  const r = record();
  const block = render(r);
  assert.ok(block.startsWith(BEGIN));
  assert.ok(block.endsWith(END));
  assert.equal(await prettierMd(block + "\n"), block + "\n");
  assert.deepEqual(parseRecord(block), r);
  assert.equal(locateBlock(block).text, block);
  assert.match(block, /3,145,728 B \(3,072 KB\) — 0 % used/);
  assert.match(block, /`build\/api\/table.js` 6 KB/);
  assert.match(block, /\| `zod` +\| 4\.6\.7 +\| 2 KB +\|/);
  const none = render({
    ...r,
    installedBytes: null,
    dependencies: [{ ...r.dependencies[0], bytes: null }],
  });
  assert.match(none, /not installed locally/);
  assert.match(none, /\| `zod` +\| 4\.6\.7 +\| — +\|/);
  assert.equal(parseRecord("# nothing\n"), undefined);
  assert.equal(locateBlock("# nothing\n"), undefined);
});

test("replaceBlock swaps the generated block and keeps the prose", () => {
  const md = `# T\n\nBefore.\n\n${BEGIN}\nold\n${END}\n\nAfter.\n`;
  assert.equal(
    replaceBlock(md, `${BEGIN}\nnew\n${END}`),
    `# T\n\nBefore.\n\n${BEGIN}\nnew\n${END}\n\nAfter.\n`,
  );
  assert.throws(() => replaceBlock("# T\n", "x"), /markers are missing/);
});

test("compare: exact facts exactly, figures within the tolerance", () => {
  const r = record();
  assert.deepEqual(compare(r, r), []);
  const close = {
    ...r,
    tarballBytes: Math.round(r.tarballBytes * (1 + TOLERANCE)),
  };
  assert.deepEqual(compare(r, close), []);
  const far = { ...r, tarballBytes: Math.round(r.tarballBytes * 1.1) };
  assert.match(
    compare(r, far).join("\n"),
    /tarballBytes: recorded 4,000, measured 4,400/,
  );
  const ceiling = { ...r, ceilingBytes: 4 * 1024 * 1024 };
  assert.match(
    compare(r, ceiling).join("\n"),
    /pack ceiling: recorded 3,145,728 B/,
  );
  const deps = {
    ...r,
    dependencies: [
      r.dependencies[0],
      {
        name: "acorn",
        version: "8.18.0",
        path: "node_modules/acorn",
        bytes: 1,
      },
    ],
  };
  assert.match(
    compare(r, deps).join("\n"),
    /production packages: \+acorn@8\.18\.0, -@modelcontextprotocol\/server@2\.3\.1/,
  );
  // An uninstalled tree is not drift.
  assert.deepEqual(compare(r, { ...r, installedBytes: null }), []);
  assert.deepEqual(compare({ ...r, installedBytes: null }, r), []);
});

test("run writes the block, then --check accepts it and names every drift", () => {
  const root = fakeRoot();
  let ctx = io(root);
  assert.equal(run([], ctx.io), 0);
  assert.deepEqual(ctx.out, [`footprint: wrote ${FOOTPRINT_MD}`]);
  const written = readFileSync(path.join(root, FOOTPRINT_MD), "utf8");
  assert.ok(written.startsWith("# Footprint\n\nIntro.\n\n"));
  assert.ok(written.endsWith(`${END}\n\nOutro.\n`));
  const recorded = parseRecord(written);
  assert.equal(recorded.version, "3.0.0");
  assert.deepEqual(
    recorded.dependencies.map((d) => d.name),
    ["zod"],
  );
  assert.equal(recorded.installedBytes, 100);

  ctx = io(root);
  assert.equal(run(["--check"], ctx.io), 0);
  assert.match(
    ctx.out[0],
    /^footprint: ok — 5 files, 12 KB unpacked, 1 production packages$/,
  );

  // Drift: a 10 % larger tarball.
  ctx = io(root, { pack: () => ({ ...packReport, size: 4_400 }) });
  assert.equal(run(["--check"], ctx.io), 1);
  assert.match(ctx.errs.join("\n"), /out of date/);
  assert.match(
    ctx.errs.join("\n"),
    /tarballBytes: recorded 4,000, measured 4,400/,
  );
  assert.equal(
    readFileSync(path.join(root, FOOTPRINT_MD), "utf8"),
    written,
    "--check never writes",
  );

  // A hand edit inside the block.
  writeFileSync(
    path.join(root, FOOTPRINT_MD),
    written.replace("Measured 2026-10-27", "Measured yesterday"),
  );
  ctx = io(root);
  assert.equal(run(["--check"], ctx.io), 1);
  assert.match(ctx.errs.join("\n"), /edited by hand/);

  // Unknown flag, missing block, unreadable file.
  ctx = io(root);
  assert.equal(run(["--nope"], ctx.io), 2);
  const bare = fakeRoot({ withBlock: false });
  ctx = io(bare);
  assert.equal(run(["--check"], ctx.io), 1);
  assert.match(ctx.errs.join("\n"), /no generated block/);
  ctx = io(bare);
  assert.equal(run([], ctx.io), 1);
  assert.match(ctx.errs.join("\n"), /markers are missing/);
  ctx = io(path.join(bare, "missing"));
  assert.equal(run(["--check"], ctx.io), 1);
  assert.match(ctx.errs.join("\n"), /^footprint: ENOENT/);
});

test("project/FOOTPRINT.md carries a generated block that matches its record", () => {
  const markdown = readFileSync(path.join(repoRoot, FOOTPRINT_MD), "utf8");
  const loc = locateBlock(markdown);
  const recorded = parseRecord(markdown);
  assert.ok(loc && recorded, "run npm run footprint");
  assert.equal(loc.text, render(recorded));
  assert.equal(recorded.ceilingBytes, 3 * 1024 * 1024);
});
