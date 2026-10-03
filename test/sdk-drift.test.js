// P-4 — SDK release tracking (scripts/sdk-drift.mjs). Every test runs on
// fixtures: the network is injected (or `fetch` is stubbed), so the drift
// check never touches npm or the docs site from `npm run check`.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DIST_TAGS_URL,
  LLMS_URL,
  compareVersions,
  computeDrift,
  httpGet,
  main,
  parseLlmsApis,
  renderMarkdown,
  runDrift,
} from "../scripts/sdk-drift.mjs";
import * as registry from "../build/core/artifacts/registry.js";
import { jsonResponse, withFetch } from "./helpers.js";

const here = import.meta.dirname;
const LLMS = readFileSync(path.join(here, "fixtures", "sdk-llms.txt"), "utf8");
const NEXT_TAGS = { latest: "4.12.2", next: "4.13.0" };

const fixtureDeps = (distTags = NEXT_TAGS, llmsText = LLMS) => ({
  fetchJson: async (url) => {
    assert.equal(url, DIST_TAGS_URL);
    return distTags;
  },
  fetchText: async (url) => {
    assert.equal(url, LLMS_URL);
    return llmsText;
  },
  registry,
});

const base = (over = {}) => ({
  baseline: registry.SDK_BASELINE,
  sdkApis: [...registry.SDK_APIS],
  nextApis: [...registry.SDK_NEXT_APIS],
  types: registry.ARTIFACT_TYPES,
  distTags: NEXT_TAGS,
  llmsText: LLMS,
  ...over,
});

test("acceptance: the 4.13.0 next tag reports DatabaseView as a known verified:false type", async () => {
  const report = await runDrift(fixtureDeps());
  assert.equal(report.baseline, "4.12.2");
  assert.deepEqual(report.versions.latest, {
    version: "4.12.2",
    status: "same",
    newMajor: false,
  });
  assert.equal(report.versions.next.status, "newer");
  const dbView = report.nextOnly.find((n) => n.api === "DatabaseView");
  assert.ok(dbView, "DatabaseView is a known next-only API");
  assert.equal(dbView.known, true);
  assert.deepEqual(dbView.descriptors, [
    { type: "database_view", verified: false, generate: false },
  ]);
  assert.equal(dbView.inDocs, false);
  assert.ok(report.findings.some((f) => /npm next is 4\.13\.0/.test(f)));
  // Every docs page maps to a registry API; the two include APIs have none.
  assert.deepEqual(report.docs.newInDocs, []);
  assert.deepEqual(report.docs.missingFromDocs, ["JsInclude", "CssInclude"]);
  assert.equal(report.drift, true);
  const md = renderMarkdown(report, new Date("2026-09-24T00:00:00Z"));
  assert.match(md, /^# SDK drift tracking/);
  assert.match(md, /on 2026-09-24\. Baseline: \*\*4\.12\.2\*\*/);
  assert.match(md, /\| next \| 4\.13\.0 \| newer \|/);
  assert.match(
    md,
    /- DatabaseView: `database_view` \(verified:false\); not listed/,
  );
});

test("parseLlmsApis reads only the API Reference section, drops helpers and sub-APIs", () => {
  const apis = parseLlmsApis(LLMS);
  const slugs = apis.map((a) => a.slug);
  assert.ok(slugs.includes("acl"));
  assert.ok(slugs.includes("riskassessment"));
  assert.ok(slugs.includes("playbook"));
  assert.ok(slugs.includes("custom-action"));
  for (const helper of ["action", "trigger", "flow-stages", "wfa"]) {
    assert.ok(!slugs.includes(helper), `${helper} is a helper page`);
  }
  assert.ok(!apis.some((a) => /\/(columns|variables)\//.test(a.path)));
  assert.ok(!slugs.includes("build-guide"), "Guides are out of scope");
  assert.ok(!slugs.includes("now-config"), "the next section ends the scan");
  assert.equal(parseLlmsApis("# nothing here"), null);
  assert.deepEqual(
    parseLlmsApis(
      [
        "## API Reference",
        "prose line",
        "- [broken](not-a-url)",
        "* [Foo-API](https://x.test/api/foo-api)",
      ].join("\n"),
    ),
    [{ slug: "foo", path: "/api/foo-api" }],
  );
});

test("compareVersions orders numerically and puts pre-releases first", () => {
  assert.equal(compareVersions("4.13.0", "4.12.2"), 1);
  assert.equal(compareVersions("4.9.0", "4.12.2"), -1);
  assert.equal(compareVersions("4.12.2", "4.12.2"), 0);
  assert.equal(compareVersions("4.13.0-beta.1", "4.13.0"), -1);
  assert.equal(compareVersions("4.13.0", "4.13.0-beta.1"), 1);
  assert.equal(compareVersions("5", "4.99.99"), 1);
});

test("computeDrift flags a newer latest, a new major and new doc pages", () => {
  const minor = computeDrift(base({ distTags: { latest: "4.13.0" } }));
  assert.equal(minor.versions.next.status, "absent");
  assert.ok(
    minor.findings.includes(
      "npm latest is 4.13.0, ahead of the baseline 4.12.2.",
    ),
  );
  const major = computeDrift(
    base({
      distTags: { latest: "5.0.0", next: "5.0.0" },
      llmsText: `${LLMS}\n`.replace(
        "## Configuration",
        "- [widget-api](https://servicenow.github.io/sdk/api/widget-api?embed=true)\n\n## Configuration",
      ),
    }),
  );
  assert.equal(major.versions.latest.newMajor, true);
  assert.ok(major.findings.some((f) => /new MAJOR/.test(f)));
  assert.ok(
    !major.findings.some((f) => /npm next is/.test(f)),
    "next equal to latest is not reported",
  );
  assert.deepEqual(major.docs.newInDocs, [
    { slug: "widget", path: "/sdk/api/widget-api" },
  ]);
  assert.ok(major.findings.some((f) => /`widget`/.test(f)));
  assert.match(
    renderMarkdown(major),
    /\| latest \| 5\.0\.0 \| newer \(new major\) \|/,
  );
});

test("computeDrift reports a missing latest, an unparsable index and next-only rule breaches", () => {
  const report = computeDrift({
    baseline: "4.12.2",
    sdkApis: ["Table"],
    nextApis: ["DatabaseView", "Ghost", "Early"],
    types: [
      { type: "database_view", sdkApi: "DatabaseView", verified: true },
      { type: "early", sdkApi: "Early", verified: false, tiers: ["G"] },
    ],
    distTags: { next: "4.11.0" },
    llmsText: "no index",
  });
  assert.equal(report.versions.latest.status, "absent");
  assert.equal(report.versions.next.status, "older");
  assert.equal(report.docs, null);
  assert.deepEqual(report.findings, [
    "npm has no `latest` dist-tag for @servicenow/sdk.",
    "The docs index has no `## API Reference` section — its format changed.",
    "next-only API DatabaseView has a verified or G-tier descriptor (SDK-PARITY §2 rule 4).",
    "next-only API Ghost has no registry descriptor.",
    "next-only API Early has a verified or G-tier descriptor (SDK-PARITY §2 rule 4).",
  ]);
  const md = renderMarkdown(report);
  assert.match(md, /\| latest \| — \| absent \|/);
  assert.match(md, /- Ghost: no descriptor; not listed/);
  assert.match(md, /`early` \(verified:false, G tier\)/);
  assert.doesNotMatch(md, /Docs index:/);
});

test("computeDrift: a next-only API that reaches the docs asks for promotion; no drift renders cleanly", () => {
  const promoted = computeDrift({
    baseline: "4.12.2",
    sdkApis: ["Table"],
    nextApis: ["DatabaseView"],
    types: [{ type: "database_view", sdkApi: "DatabaseView", verified: false }],
    distTags: { latest: "4.12.2" },
    llmsText: [
      "## API Reference",
      "- [table-api](https://x.test/api/table/table-api)",
      "- [databaseview-api](https://x.test/api/databaseview-api)",
    ].join("\n"),
  });
  assert.equal(promoted.nextOnly[0].inDocs, true);
  assert.ok(promoted.findings.some((f) => /move it to SDK_APIS/.test(f)));
  assert.match(renderMarkdown(promoted), /; listed in the docs index\./);

  const clean = computeDrift({
    baseline: "4.12.2",
    sdkApis: ["Table"],
    distTags: { latest: "4.12.2" },
    llmsText: "## API Reference\n- [table-api](https://x.test/api/table-api)",
  });
  assert.equal(clean.drift, false);
  assert.deepEqual(clean.nextOnly, []);
  const md = renderMarkdown(clean);
  assert.match(md, /No drift\./);
  assert.match(md, /## Known next-only APIs\n\nNone\./);
  assert.equal(computeDrift({ baseline: "1.0.0", sdkApis: [] }).drift, true);
});

test("runDrift tolerates a registry without SDK_NEXT_APIS", async () => {
  const report = await runDrift({
    ...fixtureDeps({ latest: "4.12.2" }),
    registry: {
      SDK_BASELINE: "4.12.2",
      SDK_APIS: ["Table"],
      ARTIFACT_TYPES: [],
    },
  });
  assert.deepEqual(report.nextOnly, []);
});

test("main writes Markdown or JSON, to stdout or --out, and sets GITHUB_OUTPUT", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sdk-drift-"));
  try {
    const printed = [];
    const report = await main([], {
      ...fixtureDeps(),
      env: {},
      write: (text) => printed.push(text),
    });
    assert.equal(report.drift, true);
    assert.match(printed.join(""), /^# SDK drift tracking/);

    const out = path.join(dir, "report.json");
    const ghOut = path.join(dir, "gh-output");
    await main(["--json", "--out", out], {
      ...fixtureDeps(),
      env: { GITHUB_OUTPUT: ghOut },
    });
    const json = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(json.versions.next.version, "4.13.0");
    assert.equal(readFileSync(ghOut, "utf8"), "drift=true\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main's default network path uses fetch and fails loudly on HTTP errors", async () => {
  await withFetch(
    (url) =>
      url === DIST_TAGS_URL
        ? jsonResponse(200, NEXT_TAGS)
        : new Response(LLMS, { status: 200 }),
    async (calls) => {
      const printed = [];
      const report = await main([], {
        registry,
        env: {},
        write: (text) => printed.push(text),
      });
      assert.equal(report.versions.next.version, "4.13.0");
      assert.deepEqual(
        calls.map((c) => c.url).sort(),
        [DIST_TAGS_URL, LLMS_URL].sort(),
      );
      assert.match(calls[0].init.headers["user-agent"], /sdk-drift/);
    },
  );
  await withFetch(
    () => new Response("nope", { status: 503 }),
    async () => {
      await assert.rejects(httpGet(LLMS_URL, "text"), /HTTP 503/);
    },
  );
});
