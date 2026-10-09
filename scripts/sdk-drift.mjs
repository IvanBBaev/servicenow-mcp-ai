// P-4 — ServiceNow SDK release tracking.
//
// Compares the registry's SDK_BASELINE with the npm `@servicenow/sdk`
// dist-tags (`latest`, `next`), diffs the SDK docs index (llms.txt, the
// "API Reference" section) against the registry's `sdkApi` values and its
// "Guides" section against GUIDE_COVERAGE (SDK-PARITY §2 rule 5). Run weekly
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

/**
 * Every guide of the docs index (`## Guides`) mapped to the SDK-PARITY §4
 * rows it describes, or to `n/a: <reason>` when it describes no artefact
 * (CLI, process or reference pages). Guides build artefacts the API index
 * alone misses (`Record()` tables, options of another API), so a guide
 * missing here is drift. `test/sdk-drift.test.js` keeps every row id present
 * in project/SDK-PARITY.md.
 */
export const GUIDE_COVERAGE = {
  "alias-guide": ["SRV-9"],
  "alias-template-guide": ["SRV-9"],
  "application-menu-guide": ["CUI-8"],
  "assessment-guide": ["QA-4"],
  "assignment-rule-guide": ["CORE-18"],
  "atf-guide": ["QA-1", "QA-2"],
  "atf-ui-test-script-guide": ["QA-1"],
  "auth-token-guide": "n/a: `now-sdk auth` CLI command",
  "building-ai-agents-advanced-guide": ["AI-1", "AI-2"],
  "building-ai-agents-guide": ["AI-1"],
  "building-ai-agents-tools-guide": ["AI-1"],
  "business-rule-guide": ["SRV-1"],
  "choiceset-guide": ["CORE-2"],
  "client-script-guide": ["CUI-1"],
  "client-side-api-guide": "n/a: browser API reference for client scripts",
  "creating-workspaces-guide": ["NX-1"],
  "cross-scope-privilege-guide": ["CORE-9"],
  "dashboard-filters-guide": ["NX-2"],
  "dashboard-guide": ["NX-2"],
  "data-lookup-guide": ["SRV-11"],
  "data-policy-guide": ["CUI-4"],
  "database-view-guide": ["CORE-3"],
  "developing-apps-guide": ["APP-1"],
  "email-notification-guide": ["SRV-14"],
  "encoded-query-guide": "n/a: encoded query syntax reference",
  "external-services-guide": ["CORE-16"],
  "field-styles-guide": ["CORE-12"],
  "fluent-overview": "n/a: language overview",
  "form-formatters-guide": ["CUI-6"],
  "form-layout-guide": ["CUI-6"],
  "graphql-api-guide": ["SRV-8"],
  "importing-data-guide": ["SRV-12", "SRV-13"],
  "inbound-email-action-guide": ["SRV-15"],
  "instance-scan-guide": ["QA-3"],
  "interceptor-guide": ["CUI-10"],
  "javascript-compatibility-guide": "n/a: server-side ECMAScript reference",
  "knowledge-base-access-guide": ["CORE-19"],
  "list-control-guide": ["CUI-9"],
  "list-guide": ["CUI-7"],
  "module-guide": ["SRV-5"],
  "nowassist-skills-advanced-guide": ["AI-3"],
  "nowassist-skills-guide": ["AI-3"],
  "nowassist-skills-tools-guide": ["AI-3"],
  "npm-libraries-guide": "n/a: third-party library support reference",
  "override-column-guide": ["CORE-1"],
  "playbook-activities-guide": ["FLW-10"],
  "playbook-anti-patterns-guide": ["FLW-10"],
  "playbook-datapills-guide": ["FLW-10"],
  "playbook-guide": ["FLW-10"],
  "playbook-lanes-guide": ["FLW-10"],
  "playbook-patterns-guide": ["FLW-10"],
  "playbook-permissions-guide": ["FLW-10"],
  "playbook-triggers-guide": ["FLW-10"],
  "playbook-unsupported-features-guide": ["FLW-10"],
  "property-guide": ["CORE-5"],
  "query-guide": "n/a: `now-sdk query` CLI command",
  "registering-events-guide": ["CORE-14"],
  "relationship-guide": ["CORE-15"],
  "rest-message-guide": ["SRV-7"],
  "retry-policy-guide": ["SRV-10"],
  "risk-assessment-guide": ["QA-5"],
  "scheduled-script-guide": ["SRV-4"],
  "script-include-guide": ["SRV-2"],
  "scripted-rest-api-guide": ["SRV-6"],
  "sdlc-guide": "n/a: build, release and CI/CD process",
  "security-guide": ["CORE-7", "CORE-8", "CORE-21"],
  "service-catalog-client-script-guide": ["CAT-5"],
  "service-catalog-guide": ["CAT-1", "CAT-2"],
  "service-catalog-ui-policy-guide": ["CAT-6"],
  "service-catalog-variables-guide": ["CAT-3", "CAT-4"],
  "service-portal-advanced-guide": ["SP-6", "SP-10"],
  "service-portal-components-guide": ["SP-3", "SP-4", "SP-7", "SP-8", "SP-9"],
  "service-portal-guide": ["SP-1", "SP-2", "SP-6", "SP-7"],
  "service-portal-ootb-reference": "n/a: OOTB record examples",
  "state-model-guide": ["CORE-4"],
  "table-augments-guide": ["CORE-20"],
  "table-guide": ["CORE-1"],
  "ui-action-guide": ["CUI-2"],
  "ui-page-guide": ["CUI-5"],
  "ui-page-patterns-guide": ["CUI-5"],
  "ui-page-theming-guide": ["CUI-5"],
  "ui-policy-guide": ["CUI-3"],
  "user-criteria-examples-guide": ["CORE-10"],
  "user-criteria-guide": ["CORE-10"],
  "view-guide": ["CUI-9"],
  "view-rule-guide": ["CUI-9"],
  "wfa-custom-action-guide": ["FLW-3"],
  "wfa-flow-actions-guide": ["FLW-5"],
  "wfa-flow-guide": ["FLW-1"],
  "wfa-flow-logic-guide": ["FLW-6"],
  "wfa-flow-stages-guide": ["FLW-8"],
  "wfa-subflow-guide": ["FLW-2"],
  "wfa-trigger-guide": ["FLW-4"],
};

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
  const links = parseSection(text, "API Reference");
  if (links === null) return null;
  const apis = [];
  for (const { slug: name, path } of links) {
    if (SUB_API_PATH.test(path)) continue;
    const slug = name.replace(/-api$/, "");
    if (HELPER_SLUGS.has(slug)) continue;
    apis.push({ slug, path });
  }
  return apis;
}

/**
 * The guide pages listed under "## Guides" in llms.txt: `[{slug, path}]`.
 * `null` when the section is missing.
 */
export function parseLlmsGuides(text) {
  return parseSection(text, "Guides");
}

/** The `- [name](url)` links of one `## <heading>` section, lower-cased. */
function parseSection(text, heading) {
  const lines = String(text).split(/\r?\n/);
  const header = new RegExp(`^##\\s+${heading}\\s*$`, "i");
  const start = lines.findIndex((l) => header.test(l));
  if (start === -1) return null;
  const links = [];
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
    links.push({ slug: m[1].trim().toLowerCase(), path: pathname });
  }
  return links;
}

/**
 * The drift report. Inputs: `baseline` (SDK_BASELINE), `sdkApis` (baseline
 * API names), `nextApis` (next-only API names), `types` (registry
 * descriptors: `{type, sdkApi, verified, tiers}`), `distTags` (npm),
 * `llmsText` (the docs index) and `guideCoverage` (GUIDE_COVERAGE).
 */
export function computeDrift({
  baseline,
  sdkApis,
  nextApis = [],
  types = [],
  distTags = {},
  llmsText = "",
  guideCoverage = GUIDE_COVERAGE,
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

  const guides = diffGuides(llmsText, guideCoverage, findings);

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
    guides,
    nextOnly,
    findings,
    drift: findings.length > 0,
  };
}

/**
 * Diff the `## Guides` section against the coverage map; pushes findings and
 * returns `{listed, mapped, newGuides, missingGuides}` (`null` when the
 * section is missing).
 */
function diffGuides(llmsText, guideCoverage, findings) {
  const parsed = parseLlmsGuides(llmsText);
  // No Guides section is neutral: a format change already shows as a
  // missing API Reference section.
  if (parsed === null) return null;
  const listed = new Set(parsed.map((g) => g.slug));
  const newGuides = parsed.filter((g) => !Object.hasOwn(guideCoverage, g.slug));
  const missingGuides = Object.keys(guideCoverage).filter(
    (slug) => !listed.has(slug),
  );
  for (const g of newGuides) {
    findings.push(
      `New guide in the docs: \`${g.slug}\` (${g.path}) — map it in GUIDE_COVERAGE to SDK-PARITY §4 rows (add a row if none fits) or to n/a.`,
    );
  }
  if (missingGuides.length > 0) {
    findings.push(
      `Mapped guides without a docs page: ${missingGuides.join(", ")} (renamed or removed?).`,
    );
  }
  return {
    listed: parsed.length,
    mapped: parsed.length - newGuides.length,
    newGuides,
    missingGuides,
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
  if (report.guides) {
    out.push(
      "",
      `Guides: ${report.guides.listed} pages, ${report.guides.mapped} mapped in GUIDE_COVERAGE.`,
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
