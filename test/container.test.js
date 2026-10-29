// D-5: container and registry metadata, checked without docker. The
// Dockerfile must start the package's real bin entry (the one package.json
// publishes), and the HTTP transport must know a loopback bind from an exposed
// one.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { isLoopbackHost } from "../build/mcp/transport.js";

const root = path.join(import.meta.dirname, "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const pkg = JSON.parse(read("package.json"));
const dockerfile = read("Dockerfile");

test("Dockerfile starts the bin entry point that package.json publishes", () => {
  const bins = Object.values(pkg.bin);
  assert.equal(bins.length, 1);
  const binPath = bins[0].replace(/^\.\//, "");
  assert.ok(existsSync(path.join(root, binPath)), binPath);
  // The launcher imports the built ESM entry — the image must build it.
  assert.match(read(binPath), /\.\.\/build\/index\.js/);
  assert.match(dockerfile, /npm run build/);
  const entrypoint = /^ENTRYPOINT\s+(\[.*\])\s*$/m.exec(dockerfile);
  assert.ok(entrypoint, "exec-form ENTRYPOINT");
  const argv = JSON.parse(entrypoint[1]);
  assert.equal(argv.at(-1), `/app/${binPath}`);
});

test("Dockerfile: multi-stage, non-root, HTTP by default on 0.0.0.0", () => {
  assert.ok((dockerfile.match(/^FROM\s/gm) ?? []).length >= 2, "multi-stage");
  assert.match(dockerfile, /^USER\s+(?!0\b|root\b)\S+/m);
  assert.match(dockerfile, /SN_TRANSPORT=http/);
  assert.match(dockerfile, /SN_HTTP_HOST=0\.0\.0\.0/);
  assert.match(dockerfile, /^EXPOSE\s+3000/m);
  assert.match(dockerfile, /SN_HTTP_TOKEN/, "documents the HTTP token");
});

test(".dockerignore keeps env files and build output out of the context", () => {
  const lines = read(".dockerignore")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  // Deny-by-default: everything is excluded, then only the build inputs.
  assert.equal(lines[0], "**");
  for (const line of lines.slice(1)) {
    assert.ok(line.startsWith("!"), line);
    assert.ok(!/env/i.test(line), `no env file re-included: ${line}`);
  }
  const allowed = lines.slice(1).map((l) => l.slice(1).replace(/\/\*\*$/, ""));
  for (const needed of ["package.json", "package-lock.json", "src", "bin"]) {
    assert.ok(allowed.includes(needed), needed);
  }
  // Every file the Dockerfile COPYs from the context is allowed in.
  for (const m of dockerfile.matchAll(/^COPY\s+(?!--from)(.+)\s+\S+$/gm)) {
    for (const src of m[1].trim().split(/\s+/)) {
      assert.ok(allowed.includes(src), `COPY ${src} is in .dockerignore`);
    }
  }
});

test("Dockerfile copies every input of npm run build", () => {
  const copied = [
    ...dockerfile.matchAll(/^COPY\s+(?!--from)(.+)\s+\S+$/gm),
  ].flatMap((m) => m[1].trim().split(/\s+/));
  const build = pkg.scripts.build;
  const inputs = [
    ...[...build.matchAll(/tsc -p (\S+)/g)].map((m) => m[1]),
    ...[...build.matchAll(/node (scripts\/\S+\.mjs)/g)].map((m) => m[1]),
  ];
  assert.ok(inputs.length >= 2, build);
  // tsconfig.build.json extends tsconfig.json; the skills script reads skills/.
  for (const needed of [...inputs, "tsconfig.json", "src", "skills"]) {
    assert.ok(copied.includes(needed), `COPY ${needed}`);
  }
});

test("isLoopbackHost tells a local bind from an exposed one", () => {
  for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ["0.0.0.0", "::", "10.0.0.5", "example.com"]) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});
