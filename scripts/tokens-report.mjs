// N-57: where the `tools/list` bytes go, per profile, with estimated tokens at
// the fixed TK-37 ratio (bytes / 4.0 for schema and text; reports only, never
// a gate). Reads the wire through test/surface.js (run `npm run build` first).
//
//   npm run tokens:report             the breakdown, repeated parameter text,
//                                     the 15 heaviest tools and the deltas
//                                     against test/fixtures/token-budgets.json,
//                                     plus the N-58 lean projection (not wired)
//   npm run tokens:report -- --json   the same data as JSON

import { readFileSync } from "node:fs";

import { leanToolsList } from "../build/mcp/lean-list.js";
import { baselineEnv } from "../test/helpers.js";
import {
  BYTES_PER_TOKEN,
  PROFILES,
  listPublishedTools,
  measureSurface,
} from "../test/surface.js";

const FIXTURE = new URL("../test/fixtures/token-budgets.json", import.meta.url);
const COMPONENTS = [
  "description",
  "title",
  "annotations",
  "inputSchema",
  "paramDescriptions",
  "outputSchema",
];

/** Repeated parameter descriptions: the bytes saved if each appeared once. */
function repeatedParamText(tools) {
  const counts = new Map();
  for (const tool of tools) {
    for (const prop of Object.values(tool.inputSchema?.properties ?? {})) {
      if (typeof prop?.description !== "string") continue;
      counts.set(prop.description, (counts.get(prop.description) ?? 0) + 1);
    }
  }
  const repeated = [...counts]
    .filter(([, n]) => n > 1)
    .map(([text, n]) => ({
      text,
      repeats: n,
      savings: (n - 1) * JSON.stringify(text).length,
    }))
    .sort((a, b) => b.savings - a.savings);
  return {
    savings: repeated.reduce((sum, r) => sum + r.savings, 0),
    top: repeated.slice(0, 10),
  };
}

baselineEnv();
const budgets = JSON.parse(readFileSync(FIXTURE, "utf8")).profiles;
const tokens = (bytes) => Math.round(bytes / BYTES_PER_TOKEN.schema);

const profiles = {};
for (const profile of Object.keys(PROFILES)) {
  const m = await measureSurface(profile);
  const lean = JSON.stringify(
    leanToolsList(await listPublishedTools(PROFILES[profile])),
  ).length;
  const breakdown = Object.fromEntries(
    COMPONENTS.map((c) => [c, m.perTool.reduce((sum, t) => sum + t[c], 0)]),
  );
  profiles[profile] = {
    bytes: m.bytes,
    tokens: tokens(m.bytes),
    tools: m.tools,
    budget: budgets[profile] ?? null,
    delta: budgets[profile] === undefined ? null : m.bytes - budgets[profile],
    lean,
    breakdown,
  };
}
const all = await measureSurface("all");
const report = {
  bytesPerToken: BYTES_PER_TOKEN.schema,
  profiles,
  repeatedParamText: repeatedParamText(await listPublishedTools(PROFILES.all)),
  heaviest: all.perTool.slice(0, 15),
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const n = (v) => String(v).padStart(8);
  console.log(
    `tools/list surface (tokens ≈ bytes / ${report.bytesPerToken})\n`,
  );
  console.log(
    `${"profile".padEnd(11)}${n("tools")}${n("bytes")}${n("tokens")}${n("budget")}${n("delta")}${n("lean")}`,
  );
  for (const [name, p] of Object.entries(profiles)) {
    console.log(
      `${name.padEnd(11)}${n(p.tools)}${n(p.bytes)}${n(p.tokens)}${n(p.budget ?? "-")}${n(p.delta ?? "-")}${n(p.lean)}`,
    );
  }
  console.log("(lean: N-58 serializer, not on the wire until O-10 (b))");
  console.log(`\n${"component (bytes)".padEnd(19)}${n("core")}${n("all")}`);
  for (const c of COMPONENTS) {
    console.log(
      `${c.padEnd(19)}${n(profiles.core.breakdown[c])}${n(profiles.all.breakdown[c])}`,
    );
  }
  const rep = report.repeatedParamText;
  console.log(
    `\nrepeated parameter text (all): ${rep.savings} B if each appeared once`,
  );
  for (const r of rep.top) {
    console.log(
      `${n(r.savings)}  ×${String(r.repeats).padEnd(4)} ${r.text.slice(0, 60)}`,
    );
  }
  console.log(
    `\nheaviest tools (all)\n${"tool".padEnd(40)}${n("total")}${n("desc")}${n("input")}${n("output")}`,
  );
  for (const t of report.heaviest) {
    console.log(
      `${t.name.padEnd(40)}${n(t.total)}${n(t.description)}${n(t.inputSchema)}${n(t.outputSchema)}`,
    );
  }
}
