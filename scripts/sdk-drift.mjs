// P-4 — ServiceNow SDK release tracking.
//
// Compares the registry's SDK_BASELINE with the npm `@servicenow/sdk`
// dist-tags (`latest`, `next`) and diffs the SDK docs index (llms.txt, the
// "API Reference" section) against the registry's `sdkApi` values. Run weekly
// by .github/workflows/sdk-drift.yml, which opens or updates one tracking
// issue. It is NOT part of `npm run check` and never ships in the package.
//
//   node --experimental-transform-types scripts/sdk-drift.mjs [--json] [--out <file>]
//
// Always exits 0 when the report was produced (drift is information, not a
// failure); exits 1 only when a source could not be fetched. When
// GITHUB_OUTPUT is set it also writes `drift=true|false` there.
//
// Importing this module is side-effect free: the pure functions below take
// their inputs (dist-tags, llms.txt text, registry) as arguments, so the unit
// test runs them against fixtures without network access.
import { appendFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

export const DIST_TAGS_URL =
  "https://registry.npmjs.org/-/package/@servicenow/sdk/dist-tags";
export const LLMS_URL = "https://servicenow.github.io/sdk/llms.txt";
export const ISSUE_TITLE = "SDK drift tracking";

/**
 * Doc slugs whose page name is not the Fluent API name (slug → API).
 * Compared case-insensitively after dropping the `-api` suffix.
 */
export const SLUG_ALIASES = {
  playbook: "PlaybookDefinition",
  "custom-action": "Action",
};

/**
 * Doc pages that are helpers of another API, not artefact APIs of their own:
 * the Flow built-in step catalogue (`action-api`), flow stages, triggers and
 * the Workflow Automation helpers. Column and catalog-variable pages (under
 * `table/columns/` and `service-catalog/variables/`) belong to `Table` and
 * `CatalogItem` and are skipped by path.
 */
export const HELPER_SLUGS = new Set([
  "action",
  "flow-stages",
  "trigger",
  "wfa",
  "wfa-flow-logic",
]);
const SUB_API_PATH = /\/(table\/columns|service-catalog\/variables)\//;

/** Numeric x.y.z comparison; a pre-release sorts before its release. */
export function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).split("-", 2);
    return { nums: core.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return 0;
}

/**
 * The API pages listed under "## API Reference" in llms.txt: `[{slug, path}]`,
 * helpers and sub-APIs removed. `null` when the section is missing (the index
 * format changed — itself drift).
 */
export function parseLlmsApis(text) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+API Reference\s*$/i.test(l));
  if (start === -1) return null;
  const apis = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    const m = /^\s*[-*]\s*\[([^\]]+)\]\(([^)\s]+)\)/.exec(line);
    if (!m) continue;
    let pathname;
    try {
      pathname = new URL(m[2]).pathname;
    } catch {
      continue;
    }
    if (SUB_API_PATH.test(pathname)) continue;
    const slug = m[1].trim().toLowerCase().replace(/-api$/, "");
    if (HELPER_SLUGS.has(slug)) continue;
    apis.push({ slug, path: pathname });
  }
  return apis;
}

/**
 * The drift report. Inputs: `baseline` (SDK_BASELINE), `sdkApis` (baseline
 * API names), `nextApis` (next-only API names), `types` (registry
 * descriptors: `{type, sdkApi, verified, tiers}`), `distTags` (npm) and
 * `llmsText` (the docs index).
 */
export function computeDrift({
  baseline,
  sdkApis,
  nextApis = [],
  types = [],
  distTags = {},
  llmsText = "",
}) {
  const findings = [];
  const versions = {};
  for (const tag of ["latest", "next"]) {
    const version = distTags[tag] ?? null;
    const cmp = version === null ? null : compareVersions(version, baseline);
    const status =
      cmp === null ? "absent" : cmp > 0 ? "newer" : cmp < 0 ? "older" : "same";
    const major =
      version !== null &&
      Number(version.split(".")[0]) > Number(baseline.split(".")[0]);
    versions[tag] = { version, status, newMajor: major };
  }
  if (versions.latest.status === "newer") {
    findings.push(
      `npm latest is ${versions.latest.version}, ahead of the baseline ${baseline}${
        versions.latest.newMajor ? " — a new MAJOR: re-run the inventory" : ""
      }.`,
    );
  } else if (versions.latest.status === "absent") {
    findings.push("npm has no `latest` dist-tag for @servicenow/sdk.");
  }
  if (
    versions.next.status === "newer" &&
    compareVersions(versions.next.version, versions.latest.version ?? "0") > 0
  ) {
    findings.push(
      `npm next is ${versions.next.version} (pre-release track; next-only APIs stay verified:false).`,
    );
  }

  const known = new Map(
    [...sdkApis, ...nextApis].map((name) => [name.toLowerCase(), name]),
  );
  for (const [slug, api] of Object.entries(SLUG_ALIASES)) {
    known.set(slug, api);
  }
  const parsed = parseLlmsApis(llmsText);
  let docs = null;
  if (parsed === null) {
    findings.push(
      "The docs index has no `## API Reference` section — its format changed.",
    );
  } else {
    const inDocs = new Set();
    const newInDocs = [];
    for (const { slug, path } of parsed) {
      const api = known.get(slug);
      if (api) inDocs.add(api);
      else newInDocs.push({ slug, path });
    }
    const missingFromDocs = sdkApis.filter((a) => !inDocs.has(a));
    docs = {
      listed: parsed.length,
      matched: [...inDocs].sort(),
      newInDocs,
      missingFromDocs,
    };
    for (const n of newInDocs) {
      findings.push(
        `New API page in the docs: \`${n.slug}\` (${n.path}) — no registry sdkApi matches it.`,
      );
    }
    if (missingFromDocs.length > 0) {
      findings.push(
        `Registry APIs without a docs page: ${missingFromDocs.join(", ")} (renamed or removed?).`,
      );
    }
  }

  const nextOnly = nextApis.map((api) => {
    const descriptors = types
      .filter((t) => t.sdkApi === api)
      .map((t) => ({
        type: t.type,
        verified: t.verified,
        generate: (t.tiers ?? []).includes("G"),
      }));
    const listed = docs?.matched.includes(api) ?? false;
    return { api, known: descriptors.length > 0, descriptors, inDocs: listed };
  });
  for (const n of nextOnly) {
    if (!n.known) {
      findings.push(`next-only API ${n.api} has no registry descriptor.`);
    } else if (n.descriptors.some((d) => d.verified || d.generate)) {
      findings.push(
        `next-only API ${n.api} has a verified or G-tier descriptor (SDK-PARITY §2 rule 4).`,
      );
    }
    if (n.inDocs) {
      findings.push(
        `next-only API ${n.api} now has a docs page — move it to SDK_APIS once it is on npm latest and O-5 confirms its tables.`,
      );
    }
  }

  return {
    baseline,
    distTags,
    versions,
    docs,
    nextOnly,
    findings,
    drift: findings.length > 0,
  };
}

/** Markdown body for the tracking issue. */
export function renderMarkdown(report, now = new Date()) {
  const out = [];
  out.push(`# ${ISSUE_TITLE}`, "");
  out.push(
    `Generated by \`scripts/sdk-drift.mjs\` on ${now.toISOString().slice(0, 10)}. Baseline: **${report.baseline}**.`,
    "",
  );
  out.push("| dist-tag | version | vs. baseline |", "| --- | --- | --- |");
  for (const [tag, v] of Object.entries(report.versions)) {
    out.push(
      `| ${tag} | ${v.version ?? "—"} | ${v.status}${v.newMajor ? " (new major)" : ""} |`,
    );
  }
  out.push("", "## Findings", "");
  if (report.findings.length === 0) out.push("No drift.");
  for (const f of report.findings) out.push(`- ${f}`);
  out.push("", "## Known next-only APIs", "");
  if (report.nextOnly.length === 0) out.push("None.");
  for (const n of report.nextOnly) {
    const desc =
      n.descriptors
        .map(
          (d) =>
            `\`${d.type}\` (verified:${d.verified}${d.generate ? ", G tier" : ""})`,
        )
        .join(", ") || "no descriptor";
    out.push(
      `- ${n.api}: ${desc}; ${n.inDocs ? "listed" : "not listed"} in the docs index.`,
    );
  }
  if (report.docs) {
    out.push(
      "",
      `Docs index: ${report.docs.listed} API pages, ${report.docs.matched.length} matched to registry APIs.`,
    );
  }
  out.push(
    "",
    "Process: SDK-PARITY §2 — a new minor gets registry descriptors within one release; a new major re-runs the inventory.",
    "",
  );
  return out.join("\n");
}

/**
 * Fetch both sources and compute the report. `fetchJson` / `fetchText` are
 * injectable (the test passes fixtures); `registry` is the registry module.
 */
export async function runDrift({ fetchJson, fetchText, registry }) {
  const [distTags, llmsText] = await Promise.all([
    fetchJson(DIST_TAGS_URL),
    fetchText(LLMS_URL),
  ]);
  return computeDrift({
    baseline: registry.SDK_BASELINE,
    sdkApis: [...registry.SDK_APIS],
    nextApis: [...(registry.SDK_NEXT_APIS ?? [])],
    types: registry.ARTIFACT_TYPES,
    distTags,
    llmsText,
  });
}

/** GET a URL as JSON or text through the global `fetch` (30 s timeout). */
export async function httpGet(url, as) {
  const res = await fetch(url, {
    headers: { "user-agent": "servicenow-mcp-ai sdk-drift" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return as === "json" ? res.json() : res.text();
}

/** Load the registry straight from the TypeScript sources (no build needed). */
async function loadRegistry() {
  register("./ts-source-loader.mjs", import.meta.url);
  return import("../src/core/artifacts/registry.ts");
}

/**
 * CLI entry: `--json` prints the raw report, `--out <file>` writes it to a
 * file. `deps` overrides the network, the registry, stdout and the env (the
 * test injects all of them); defaults are the real ones.
 */
export async function main(argv, deps = {}) {
  const json = argv.includes("--json");
  const outIdx = argv.indexOf("--out");
  const out = outIdx !== -1 ? argv[outIdx + 1] : undefined;
  const env = deps.env ?? process.env;
  const report = await runDrift({
    fetchJson: deps.fetchJson ?? ((u) => httpGet(u, "json")),
    fetchText: deps.fetchText ?? ((u) => httpGet(u, "text")),
    registry: deps.registry ?? (await loadRegistry()),
  });
  const body = json
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderMarkdown(report);
  const write = deps.write ?? ((text) => process.stdout.write(text));
  if (out) writeFileSync(out, body);
  else write(body);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `drift=${report.drift}\n`);
  }
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).then(
    (report) => {
      process.stderr.write(
        `sdk-drift: ${report.findings.length} finding(s); drift=${report.drift}\n`,
      );
    },
    (error) => {
      process.stderr.write(`sdk-drift: ${error.message}\n`);
      process.exit(1);
    },
  );
}
