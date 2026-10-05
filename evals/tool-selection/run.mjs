#!/usr/bin/env node
/**
 * N-18 — tool-selection eval runner.
 *
 * Builds the published `tools/list` of each profile from `build/` in-process
 * (no instance, no network), hands every case prompt to a backend and scores
 * the first tool it picks. Reports top-1 accuracy per profile, kind, package
 * and cluster, the confusion pairs, plan-first compliance and argument
 * validity for backends that produce arguments, and token usage.
 *
 * It runs on demand (`npm run eval:tools`) and is not part of `npm run check`.
 *
 * Usage (after `npm run build`):
 *   node evals/tool-selection/run.mjs [options]
 *
 *   --backend lexical|recorded|anthropic   default lexical (offline)
 *   --profile core,all,discovery           default all three
 *   --model <id>                           anthropic model (default claude-sonnet-5-5)
 *   --answers <file>                       recorded answers to replay (recorded backend)
 *   --record <file>                        save this run's answers for later replay
 *   --cases <file>                         default evals/tool-selection/cases.json
 *   --filter <text>                        only cases whose id contains <text>
 *   --concurrency <n>                      parallel model calls (default 4 for anthropic)
 *   --baseline <file>                      baseline to compare with (default per backend)
 *   --write-baseline                       write the baseline file for this backend
 *   --max-drop <points>                    exit 1 when top-1 drops more than this
 *   --json                                 print the full run as JSON
 *
 * The anthropic backend reads ANTHROPIC_API_KEY and spends real API budget
 * (roughly cases x profiles calls with the whole tool list as input).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  DEFAULT_MODEL,
  PROFILE_ENV,
  SURFACE_PROFILES,
  buildSurface,
  compareToBaseline,
  createAnthropicBackend,
  createLexicalBackend,
  createRecordedBackend,
  descriptionDrift,
  descriptionHashes,
  evaluate,
  loadCases,
} from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const RESULTS_DIR = join(ROOT, "evals", "results", "tool-selection");

const { values: opts } = parseArgs({
  options: {
    backend: { type: "string", default: "lexical" },
    profile: { type: "string", default: SURFACE_PROFILES.join(",") },
    model: { type: "string", default: DEFAULT_MODEL },
    answers: { type: "string" },
    record: { type: "string" },
    cases: { type: "string", default: join(HERE, "cases.json") },
    filter: { type: "string" },
    concurrency: { type: "string" },
    baseline: { type: "string" },
    "write-baseline": { type: "boolean", default: false },
    "max-drop": { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (opts.help) {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  console.log(
    src
      .slice(src.indexOf(" * Usage"), src.indexOf(" */"))
      .replace(/^ \* ?/gm, ""),
  );
  process.exit(0);
}

// Keep the server's registration log quiet; the eval prints its own report.
process.env.SN_LOG_LEVEL ??= "error";

const { listPublishedTools } = await import("../../test/surface.js");
const { describeAllTools } = await import("../../build/mcp/registry.js");

const profiles = opts.profile
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
for (const p of profiles) {
  if (!SURFACE_PROFILES.includes(p)) {
    console.error(`unknown profile ${p}; use ${SURFACE_PROFILES.join(", ")}`);
    process.exit(2);
  }
}

const toolPackages = Object.fromEntries(
  describeAllTools().map((t) => [t.name, t.package]),
);
const known = new Set(Object.keys(toolPackages));
const { cases: allCases, sha256: casesSha } = loadCases(opts.cases, known);
const cases = opts.filter
  ? allCases.filter((c) => c.id.includes(opts.filter))
  : allCases;

function makeBackend() {
  switch (opts.backend) {
    case "lexical":
      return createLexicalBackend();
    case "recorded": {
      if (!opts.answers)
        throw new Error("--backend recorded needs --answers <file>");
      return createRecordedBackend(
        JSON.parse(readFileSync(opts.answers, "utf8")),
      );
    }
    case "anthropic":
      return createAnthropicBackend({
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: opts.model,
      });
    default:
      throw new Error(`unknown backend ${opts.backend}`);
  }
}

let backend;
try {
  backend = makeBackend();
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

const concurrency = Number(
  opts.concurrency ?? (backend.id === "anthropic" ? 4 : 1),
);
const published = {
  core: await listPublishedTools(PROFILE_ENV.core),
  all: await listPublishedTools(PROFILE_ENV.all),
};

const run = {
  schema: 1,
  backend: backend.id,
  model: backend.model,
  cases: { n: cases.length, sha256: casesSha, filter: opts.filter ?? null },
  profiles: {},
  results: {},
  descriptions: descriptionHashes(published.all),
};
const recorded = { backend: backend.id, model: backend.model, answers: {} };

for (const profile of profiles) {
  const surface = buildSurface(profile, published);
  const { answers, results, summary } = await evaluate({
    cases,
    surface,
    backend,
    toolPackages,
    concurrency,
  });
  run.profiles[profile] = { tools: surface.tools.length, ...summary };
  run.results[profile] = results;
  recorded.answers[profile] = Object.fromEntries(
    cases.map((c, i) => [c.id, answers[i]]),
  );
}

// ------------------------------------------------------------ baseline ---

const baselineKey =
  backend.id === "lexical"
    ? "offline"
    : backend.model.replace(/^recorded:/, "").replace(/[^A-Za-z0-9._-]/g, "_");
const baselinePath =
  opts.baseline ?? join(HERE, `baseline.${baselineKey}.json`);
let comparison = null;
let drift = null;
if (!opts["write-baseline"] && existsSync(baselinePath)) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  comparison = compareToBaseline(baseline, run);
  drift = descriptionDrift(baseline.descriptions, run.descriptions);
  if (baseline.cases?.sha256 !== casesSha) {
    drift.casesChanged = true;
  }
}
run.comparison = comparison;
run.drift = drift;

mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(
  join(RESULTS_DIR, `latest-${baselineKey}.json`),
  JSON.stringify(run, null, 2) + "\n",
);
if (opts.record) {
  writeFileSync(opts.record, JSON.stringify(recorded, null, 2) + "\n");
}
if (opts["write-baseline"]) {
  if (opts.filter) {
    console.error("refusing to write a baseline from a filtered run");
    process.exit(2);
  }
  const baseline = {
    schema: 1,
    note:
      backend.id === "lexical"
        ? "Offline lexical (TF-IDF) baseline: measures how lexically separable the tool descriptions are. It is not a model baseline."
        : `Model baseline for ${backend.model}.`,
    backend: run.backend,
    model: run.model,
    cases: { n: cases.length, sha256: casesSha },
    profiles: Object.fromEntries(
      Object.entries(run.profiles).map(([p, s]) => [
        p,
        {
          tools: s.tools,
          n: s.n,
          top1: s.top1,
          byKind: s.byKind,
          byPackage: s.byPackage,
          byCluster: s.byCluster,
          argValidity: s.argValidity,
          planFirst: s.planFirst,
        },
      ]),
    ),
    picks: Object.fromEntries(
      Object.entries(run.results).map(([p, rs]) => [
        p,
        Object.fromEntries(
          rs.map((r) => [r.id, { pick: r.pick, correct: r.correct }]),
        ),
      ]),
    ),
    descriptions: run.descriptions,
  };
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
}

// -------------------------------------------------------------- report ---

if (opts.json) {
  console.log(JSON.stringify(run, null, 2));
} else {
  const pct = (v) => (v === null || v === undefined ? "n/a" : `${v}%`);
  console.log(
    `tool-selection eval — backend ${run.backend} (${run.model}), ${cases.length} cases`,
  );
  for (const [profile, s] of Object.entries(run.profiles)) {
    console.log(
      `\n[${profile}] ${s.tools} tools  top-1 ${pct(s.top1)} (${s.correct}/${s.n})` +
        `  args ${pct(s.argValidity)}  plan-first ${pct(s.planFirst)}` +
        (s.errors ? `  errors ${s.errors}` : "") +
        (s.usage
          ? `  tokens in ${s.usage.input_tokens} out ${s.usage.output_tokens}`
          : ""),
    );
    const line = (label, groups) =>
      console.log(
        `  ${label}: ` +
          Object.entries(groups)
            .map(([k, g]) => `${k} ${g.correct}/${g.n}`)
            .join(", "),
      );
    line("kind", s.byKind);
    line("package", s.byPackage);
    line("cluster", s.byCluster);
    const top = s.confusion.slice(0, 8);
    if (top.length) {
      console.log("  confusion (expected -> picked):");
      for (const { pair, count } of top) console.log(`    ${count}x ${pair}`);
      if (s.confusion.length > top.length) {
        console.log(`    … ${s.confusion.length - top.length} more`);
      }
    }
  }
  if (comparison) {
    console.log(`\nvs ${relative(ROOT, baselinePath)}:`);
    for (const [p, c] of Object.entries(comparison)) {
      console.log(
        `  [${p}] ${c.before}% -> ${c.after}% (${c.delta >= 0 ? "+" : ""}${c.delta})` +
          (c.broken.length ? `  broken: ${c.broken.join(", ")}` : "") +
          (c.fixed.length ? `  fixed: ${c.fixed.join(", ")}` : ""),
      );
    }
  }
  if (
    drift &&
    (drift.changed.length ||
      drift.added.length ||
      drift.removed.length ||
      drift.casesChanged)
  ) {
    console.log(
      "\nwarning: the baseline is stale" +
        (drift.casesChanged ? " (cases.json changed)" : "") +
        (drift.changed.length
          ? `; descriptions changed: ${drift.changed.join(", ")}`
          : "") +
        (drift.added.length ? `; new tools: ${drift.added.join(", ")}` : "") +
        (drift.removed.length
          ? `; removed tools: ${drift.removed.join(", ")}`
          : "") +
        ". Re-run with --write-baseline after review.",
    );
  }
  if (opts["write-baseline"]) {
    console.log(`\nwrote ${relative(ROOT, baselinePath)}`);
  }
}

if (opts["max-drop"] !== undefined && comparison) {
  const limit = Number(opts["max-drop"]);
  const failed = Object.entries(comparison).filter(([, c]) => -c.delta > limit);
  if (failed.length) {
    console.error(
      `top-1 dropped more than ${limit} points: ${failed.map(([p, c]) => `${p} ${c.delta}`).join(", ")}`,
    );
    process.exit(1);
  }
}
