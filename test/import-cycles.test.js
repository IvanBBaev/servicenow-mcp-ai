// E-7 — runtime import cycles under src/ are a ratchet: src/api has none, and
// the modules that still sit on a cycle elsewhere are pinned below, so a new
// cycle fails and a cut one must leave the list. Type-only imports (`import type`,
// or a clause that names only `type X` members) are erased by tsc and are
// not counted.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") ? [p] : [];
  });
}

const IMPORT =
  /^\s*(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s*["'](\.[^"']+)["']/gms;

function typeOnly(clause) {
  const m = /\{([^}]*)\}/.exec(clause);
  if (!m || /^[\w$]+\s*,/.test(clause.trim()) || /\*/.test(clause)) {
    return false;
  }
  const names = m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length > 0 && names.every((n) => n.startsWith("type "));
}

export function runtimeGraph(files) {
  const graph = new Map();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const deps = new Set();
    for (const [, kw, clause, spec] of text.matchAll(IMPORT)) {
      if (kw || typeOnly(clause)) continue;
      deps.add(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
    graph.set(
      file,
      [...deps].filter((d) => files.includes(d)),
    );
  }
  return graph;
}

export function findCycles(graph) {
  const cycles = [];
  const state = new Map();
  const stack = [];
  const visit = (n) => {
    state.set(n, 1);
    stack.push(n);
    for (const d of graph.get(n) ?? []) {
      if (state.get(d) === 1) cycles.push(stack.slice(stack.indexOf(d)));
      else if (!state.has(d)) visit(d);
    }
    stack.pop();
    state.set(n, 2);
  };
  for (const n of graph.keys()) if (!state.has(n)) visit(n);
  return cycles;
}

// Modules on a runtime cycle today (core settings/logging bootstrap, flow
// value decoders, the MCP registry ↔ status resources). Shrink only.
const KNOWN = [
  "core/log-file.ts",
  "core/logging.ts",
  "core/profile.ts",
  "core/redaction.ts",
  "core/settings-manifest.ts",
  "core/settings.ts",
  "mcp/registry.ts",
  "mcp/resources.ts",
  "mcp/status.ts",
  "tools/admin.ts",
];

export function onCycle(graph) {
  const out = [];
  for (const start of graph.keys()) {
    const seen = new Set();
    const todo = [...(graph.get(start) ?? [])];
    while (todo.length > 0) {
      const n = todo.pop();
      if (n === start) {
        out.push(start);
        break;
      }
      if (seen.has(n)) continue;
      seen.add(n);
      todo.push(...(graph.get(n) ?? []));
    }
  }
  return out;
}

test("runtime import cycles: none in src/api, the rest pinned (shrink only)", () => {
  const graph = runtimeGraph(sources(SRC));
  const members = onCycle(graph)
    .map((f) => relative(SRC, f))
    .sort();
  assert.deepEqual(
    members.filter((f) => f.startsWith("api/")),
    [],
  );
  assert.deepEqual(members, KNOWN);
  assert.ok(findCycles(graph).length > 0, "the pinned cycles are still seen");
});

test("the detector sees a cycle and ignores type-only edges", () => {
  const g = new Map([
    ["a", ["b"]],
    ["b", ["a"]],
    ["c", []],
  ]);
  assert.equal(findCycles(g).length, 1);
  assert.deepEqual(onCycle(g), ["a", "b"]);
  assert.equal(typeOnly("{ type A, type B }"), true);
  assert.equal(typeOnly("{ type A, b }"), false);
  assert.equal(typeOnly("x, { type A }"), false);
  assert.equal(typeOnly("* as ns"), false);
});
