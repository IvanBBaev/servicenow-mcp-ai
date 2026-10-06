// N-57: where the `tools/list` bytes go, per profile, with estimated tokens at
// the fixed TK-37 ratio (bytes / 4.0 for schema and text; reports only, never
// a gate). Reads the wire through test/surface.js (run `npm run build` first).
//
//   npm run tokens:report             the breakdown, repeated parameter text,
//                                     the 15 heaviest tools and the deltas
//                                     against test/fixtures/token-budgets.json,
//                                     plus the raw size before the N-58 lean
//                                     serializer
//   npm run tokens:report -- --json   the same data as JSON
//   npm run tokens:report -- --base <ref>
//                                     also measure <ref> (built in a temporary
//                                     git worktree) and show the delta per
//                                     profile; refs from 893f7e2 on (they
//                                     carry test/surface.js)

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { baselineEnv } from "../test/helpers.js";
import {
  BYTES_PER_TOKEN,
  PROFILES,
  listPublishedTools,
  measureSurface,
} from "../test/surface.js";

const FIXTURE = new URL("../test/fixtures/token-budgets.json", import.meta.url);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
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

/** The value after `--base`, or undefined. */
function baseRef() {
  const at = process.argv.indexOf("--base");
  if (at === -1) return undefined;
  const ref = process.argv[at + 1];
  if (!ref || ref.startsWith("--")) {
    console.error("tokens:report: --base needs a git ref");
    process.exit(2);
  }
  return ref;
}

/**
 * Build `ref` in a temporary worktree (sharing this checkout's node_modules)
 * and measure every profile with that ref's own test/surface.js, so the base
 * is measured the way it measured itself. The worktree is always removed.
 */
function measureBase(ref) {
  const git = (...args) =>
    execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  const sha = git("rev-parse", "--verify", `${ref}^{commit}`);
  const dir = join(mkdtempSync(join(tmpdir(), "tokens-base-")), "repo");
  git("worktree", "add", "--detach", dir, sha);
  try {
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
    execFileSync("npm", ["run", "--silent", "build"], {
      cwd: dir,
      stdio: ["ignore", "ignore", "inherit"],
    });
    const probe = [
      'import { baselineEnv } from "./test/helpers.js";',
      'import { PROFILES, measureSurface } from "./test/surface.js";',
      "baselineEnv();",
      "const out = {};",
      "for (const p of Object.keys(PROFILES)) {",
      "  const m = await measureSurface(p);",
      "  out[p] = { bytes: m.bytes, tools: m.tools };",
      "}",
      "process.stdout.write(JSON.stringify(out));",
    ].join("\n");
    const json = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", probe],
      { cwd: dir, stdio: ["ignore", "pipe", "ignore"] },
    ).toString();
    return { ref, sha, profiles: JSON.parse(json) };
  } finally {
    git("worktree", "remove", "--force", dir);
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
}

const ref = baseRef();
const base = ref === undefined ? undefined : measureBase(ref);

baselineEnv();
const budgets = JSON.parse(readFileSync(FIXTURE, "utf8")).profiles;
const tokens = (bytes) => Math.round(bytes / BYTES_PER_TOKEN.schema);

const profiles = {};
for (const profile of Object.keys(PROFILES)) {
  const m = await measureSurface(profile);
  const raw = JSON.stringify(
    await listPublishedTools(PROFILES[profile], { raw: true }),
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
    raw,
    breakdown,
  };
  if (base) {
    const was = base.profiles[profile];
    profiles[profile].base = was
      ? { bytes: was.bytes, tools: was.tools, delta: m.bytes - was.bytes }
      : null;
  }
}
const all = await measureSurface("all");
const report = {
  bytesPerToken: BYTES_PER_TOKEN.schema,
  ...(base ? { base: { ref: base.ref, sha: base.sha } } : {}),
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
    `${"profile".padEnd(11)}${n("tools")}${n("bytes")}${n("tokens")}${n("budget")}${n("delta")}${n("raw")}`,
  );
  for (const [name, p] of Object.entries(profiles)) {
    console.log(
      `${name.padEnd(11)}${n(p.tools)}${n(p.bytes)}${n(p.tokens)}${n(p.budget ?? "-")}${n(p.delta ?? "-")}${n(p.raw)}`,
    );
  }
  console.log("(raw: bytes before the N-58 lean serializer)");
  if (base) {
    console.log(
      `\nagainst ${base.ref} (${base.sha.slice(0, 7)})\n${"profile".padEnd(11)}${n("base")}${n("now")}${n("delta")}${n("tools")}`,
    );
    for (const [name, p] of Object.entries(profiles)) {
      const b = p.base;
      const tools = b ? `${b.tools}→${p.tools}` : "-";
      console.log(
        `${name.padEnd(11)}${n(b?.bytes ?? "-")}${n(p.bytes)}${n(b ? (b.delta > 0 ? `+${b.delta}` : b.delta) : "-")}${n(tools)}`,
      );
    }
  }
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
