import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DOCS_GENERATOR_VERSION,
  docsList,
  docsRead,
  docsSearch,
  docsWrite,
  docsWriteRaw,
  mergeManualBlocks,
  parseFrontmatter,
  resolveDocsProfile,
  sourceHash,
} from "../build/api/docs.js";
import { ServiceNowError } from "../build/core/errors.js";
import { baselineEnv, withEnv } from "./helpers.js";

/**
 * Docs store v2 contract (S-14): frontmatter on generated files, manual
 * blocks that survive regeneration, the DOC_GENERATED ownership line, the
 * index.json manifest, profile scoping and the search / list options.
 */

// Each test file runs in its own process, so a per-file temp docs dir is safe.
const DOCS_DIR = path.join(os.tmpdir(), `servicenow-mcp-store-${process.pid}`);
process.env.SN_DOCS_DIR = DOCS_DIR;
baselineEnv();

test.before(async () => {
  await fs.rm(DOCS_DIR, { recursive: true, force: true });
});

test.after(async () => {
  await fs.rm(DOCS_DIR, { recursive: true, force: true });
});

const read = (rel) => fs.readFile(path.join(DOCS_DIR, rel), "utf8");

const META = {
  generator: "test_generator",
  kind: "report",
  profile: "default",
  instance: "dev00000.service-now.com",
  generatedAt: "2026-09-01T00:00:00.000Z",
};

const isDocGenerated = (e) =>
  e instanceof ServiceNowError &&
  e.status === 409 &&
  e.code === "DOC_GENERATED";

test("a generator write carries frontmatter and a stable source hash", async () => {
  const r = await docsWriteRaw(
    "default/report.md",
    "# Report\n\nBody.\n",
    [".md"],
    {
      ...META,
      source: { b: 2, a: 1 },
    },
  );
  assert.equal(r.status, "created");
  assert.equal(r.source_hash, sourceHash({ a: 1, b: 2 }));
  assert.match(r.source_hash, /^sha256:[0-9a-f]{64}$/);

  const { fields, body } = parseFrontmatter(await read("default/report.md"));
  assert.deepEqual(fields, {
    sn_generated: "true",
    sn_generator: "test_generator",
    sn_generator_version: DOCS_GENERATOR_VERSION,
    sn_kind: "report",
    sn_profile: "default",
    sn_instance: "dev00000.service-now.com",
    sn_generated_at: "2026-09-01T00:00:00.000Z",
    sn_source_hash: r.source_hash,
  });
  assert.equal(body, "\n# Report\n\nBody.\n");

  // Same source, later timestamp: nothing is rewritten.
  const before = await fs.stat(path.join(DOCS_DIR, "default/report.md"));
  const again = await docsWriteRaw(
    "default/report.md",
    "# Report\n\nBody.\n",
    [".md"],
    {
      ...META,
      generatedAt: "2026-09-02T00:00:00.000Z",
      source: { a: 1, b: 2 },
    },
  );
  assert.equal(again.status, "unchanged");
  assert.equal(again.source_hash, r.source_hash);
  const after = await fs.stat(path.join(DOCS_DIR, "default/report.md"));
  assert.equal(after.mtimeMs, before.mtimeMs);

  // A changed source rewrites the file.
  const changed = await docsWriteRaw(
    "default/report.md",
    "# Report\n\nNew.\n",
    [".md"],
    {
      ...META,
      source: { a: 1, b: 3 },
    },
  );
  assert.equal(changed.status, "updated");
  assert.notEqual(changed.source_hash, r.source_hash);
});

test("without a source the body minus manual blocks is hashed", async () => {
  const meta = { ...META, kind: undefined };
  const first = await docsWriteRaw(
    "default/plain.md",
    "# Plain\n",
    [".md"],
    meta,
  );
  assert.equal(first.status, "created");
  assert.equal(first.source_hash, sourceHash("# Plain\n"));
  assert.equal(
    parseFrontmatter(await read("default/plain.md")).fields.sn_kind,
    undefined,
  );
  const second = await docsWriteRaw(
    "default/plain.md",
    "# Plain\n",
    [".md"],
    meta,
  );
  assert.equal(second.status, "unchanged");
});

test("a manual block survives regeneration byte for byte", async () => {
  const template = [
    "# Table",
    "",
    "<!-- sn:manual:start notes -->",
    "<!-- sn:manual:end -->",
    "",
    "<!-- sn:manual:start -->",
    "<!-- sn:manual:end -->",
    "",
  ].join("\n");
  await docsWriteRaw("default/table.md", template, [".md"], {
    ...META,
    source: { v: 1 },
  });
  // A human fills both blocks, with odd whitespace and non-ASCII text.
  const humanNotes =
    "<!-- sn:manual:start notes -->\n  Owner: Ива́н — keep `x`\t\n\n* item\n<!-- sn:manual:end -->";
  const humanAnon =
    "<!-- sn:manual:start -->\nFree text.\n<!-- sn:manual:end -->";
  const edited = (await read("default/table.md"))
    .replace(
      /<!-- sn:manual:start notes -->\n<!-- sn:manual:end -->/,
      humanNotes,
    )
    .replace(/<!-- sn:manual:start -->\n<!-- sn:manual:end -->/, humanAnon);
  await fs.writeFile(path.join(DOCS_DIR, "default/table.md"), edited);

  const r = await docsWriteRaw(
    "default/table.md",
    template.replace("# Table", "# Table v2"),
    [".md"],
    { ...META, source: { v: 2 } },
  );
  assert.equal(r.status, "updated");
  const out = await read("default/table.md");
  assert.ok(out.includes(humanNotes), "named block kept");
  assert.ok(out.includes(humanAnon), "anonymous block kept");
  assert.match(out, /# Table v2/);
});

test("mergeManualBlocks matches by id, then by order, and appends orphans", () => {
  const prev = [
    "<!-- sn:manual:start a -->A!<!-- sn:manual:end -->",
    "<!-- sn:manual:start -->first<!-- sn:manual:end -->",
    "<!-- sn:manual:start -->second<!-- sn:manual:end -->",
    "<!-- sn:manual:start gone -->kept<!-- sn:manual:end -->",
  ].join("\n");
  const next = [
    "<!-- sn:manual:start -->x<!-- sn:manual:end -->",
    "<!-- sn:manual:start a -->y<!-- sn:manual:end -->",
    "<!-- sn:manual:start b -->z<!-- sn:manual:end -->",
  ].join("\n");
  const merged = mergeManualBlocks(next, prev);
  assert.equal(
    merged,
    [
      "<!-- sn:manual:start -->first<!-- sn:manual:end -->",
      "<!-- sn:manual:start a -->A!<!-- sn:manual:end -->",
      "<!-- sn:manual:start b -->z<!-- sn:manual:end -->",
      "",
      "<!-- sn:manual:start -->second<!-- sn:manual:end -->",
      "",
      "<!-- sn:manual:start gone -->kept<!-- sn:manual:end -->",
      "",
    ].join("\n"),
  );
  assert.equal(mergeManualBlocks("body", "no blocks"), "body");
});

test("write_doc refuses a generated file without overwrite (DOC_GENERATED)", async () => {
  await assert.rejects(docsWrite("default/report.md", "# Mine"), (e) => {
    assert.ok(isDocGenerated(e));
    assert.match(e.message, /generated by test_generator/);
    assert.match(e.hint, /overwrite: true/);
    return true;
  });
  const r = await docsWrite("default/report.md", "# Mine\n", {
    overwrite: true,
  });
  assert.equal(r.path, "default/report.md");
  assert.equal(await read("default/report.md"), "# Mine\n");
});

test("a generator refuses a hand-written file unless overwrite is set", async () => {
  await docsWrite("default/handwritten.md", "# By hand\n");
  await assert.rejects(
    docsWriteRaw("default/handwritten.md", "# Gen\n", [".md"], META),
    (e) => isDocGenerated(e) && /hand-written/.test(e.message),
  );
  assert.equal(await read("default/handwritten.md"), "# By hand\n");
  const r = await docsWriteRaw("default/handwritten.md", "# Gen\n", [".md"], {
    ...META,
    overwrite: true,
  });
  assert.equal(r.status, "updated");
  assert.equal(
    parseFrontmatter(await read("default/handwritten.md")).fields.sn_generated,
    "true",
  );
});

test("legacy generator output is upgraded, not refused", async () => {
  await fs.mkdir(path.join(DOCS_DIR, "legacy"), { recursive: true });
  await fs.writeFile(
    path.join(DOCS_DIR, "legacy/old.md"),
    "# Old report — dev\n",
  );
  await fs.writeFile(
    path.join(DOCS_DIR, "legacy/old.json"),
    JSON.stringify({ generatedAt: "2026-01-01", rows: [1] }),
  );
  const md = await docsWriteRaw(
    "legacy/old.md",
    "# Old report — dev\n\nv2\n",
    [".md"],
    {
      ...META,
      legacy: /^# Old report — /,
    },
  );
  assert.equal(md.status, "updated");
  const json = await docsWriteRaw(
    "legacy/old.json",
    JSON.stringify({ generatedAt: "2026-09-01", rows: [1, 2], sn_stray: "x" }),
    [".json"],
    { ...META, source: { rows: [1, 2] } },
  );
  assert.equal(json.status, "updated");
  const obj = JSON.parse(await read("legacy/old.json"));
  assert.equal(obj.sn_generated, true);
  assert.equal(obj.sn_generator, "test_generator");
  assert.equal(obj.sn_source_hash, json.source_hash);
  assert.equal(obj.sn_stray, undefined);
  assert.deepEqual(obj.rows, [1, 2]);
  assert.deepEqual(Object.keys(obj).slice(0, 2), [
    "sn_generated",
    "sn_generator",
  ]);

  // A re-run of the JSON companion is unchanged too.
  const again = await docsWriteRaw(
    "legacy/old.json",
    JSON.stringify({ generatedAt: "2026-09-02", rows: [1, 2] }),
    [".json"],
    { ...META, source: { rows: [1, 2] } },
  );
  assert.equal(again.status, "unchanged");

  // A JSON document that is not an object cannot carry the fields.
  await assert.rejects(
    docsWriteRaw("legacy/list.json", "[1]", [".json"], META),
    (e) => e instanceof ServiceNowError && e.status === 400,
  );
  // A legacy Markdown pattern that does not match is still hand-written.
  await fs.writeFile(path.join(DOCS_DIR, "legacy/notes.md"), "# Notes\n");
  await assert.rejects(
    docsWriteRaw("legacy/notes.md", "# X\n", [".md"], {
      ...META,
      legacy: /^# Old/,
    }),
    isDocGenerated,
  );
  // A hand-written JSON file (no generatedAt) is refused as well.
  await fs.writeFile(path.join(DOCS_DIR, "legacy/mine.json"), '{"a":1}');
  await assert.rejects(
    docsWriteRaw("legacy/mine.json", '{"a":2}', [".json"], META),
    isDocGenerated,
  );
  await fs.writeFile(path.join(DOCS_DIR, "legacy/broken.json"), "{");
  await assert.rejects(
    docsWriteRaw("legacy/broken.json", '{"a":2}', [".json"], META),
    isDocGenerated,
  );
});

test("list_docs reports metadata and staleness", async () => {
  await docsWriteRaw("default/fresh.md", "# Fresh\n", [".md"], {
    ...META,
    kind: "tables",
    generatedAt: "2026-09-20T00:00:00.000Z",
  });
  await fs.writeFile(
    path.join(DOCS_DIR, "default/undated.md"),
    "---\nsn_generated: true\nsn_generator: other\n---\n\n# Undated\n",
  );
  const now = new Date("2026-09-23T00:00:00.000Z");
  const { entries, files } = await docsList({ now });
  const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
  assert.deepEqual(byPath["default/fresh.md"], {
    path: "default/fresh.md",
    bytes: byPath["default/fresh.md"].bytes,
    generated: true,
    generator: "test_generator",
    generated_at: "2026-09-20T00:00:00.000Z",
    profile: "default",
    kind: "tables",
    stale: false,
  });
  assert.equal(byPath["default/report.md"].generated, false); // overwritten by hand
  assert.equal(byPath["default/table.md"].stale, false);
  assert.equal(byPath["default/undated.md"].stale, true);
  assert.ok(files.includes("index.md"));

  await withEnv({ SN_DOCS_STALE_DAYS: "1" }, async () => {
    const r = await docsList({ now });
    const fresh = r.entries.find((e) => e.path === "default/fresh.md");
    assert.equal(fresh.stale, true);
  });
});

test("index.json lists every document and index.md groups them", async () => {
  // Any write rebuilds both.
  await docsWrite("zz-hand.md", "# Hand notes\n\n## Part\n");
  const manifest = JSON.parse(await read("index.json"));
  assert.equal(manifest.schema_version, 1);
  const byPath = Object.fromEntries(manifest.files.map((e) => [e.path, e]));
  assert.equal(byPath["index.md"], undefined);
  assert.deepEqual(byPath["zz-hand.md"], {
    path: "zz-hand.md",
    kind: null,
    title: "Hand notes",
    profile: null,
    generator: null,
    generated_at: null,
    source_hash: null,
    bytes: Buffer.byteLength("# Hand notes\n\n## Part\n"),
    headings: ["Hand notes", "Part"],
  });
  const fresh = byPath["default/fresh.md"];
  assert.equal(fresh.kind, "tables");
  assert.equal(fresh.generator, "test_generator");
  assert.match(fresh.source_hash, /^sha256:/);
  assert.equal(byPath["default/undated.md"].kind, "generated");

  const index = await read("index.md");
  const profileAt = index.indexOf("## Profile `default`");
  const tablesAt = index.indexOf("### tables");
  const handAt = index.indexOf("## Hand-written");
  assert.ok(profileAt > 0 && tablesAt > profileAt && handAt > tablesAt, index);
  assert.ok(
    index.includes("- [default/fresh.md](default/fresh.md) — Fresh"),
    index,
  );
  assert.ok(
    index.slice(handAt).includes("- [zz-hand.md](zz-hand.md) — Hand notes"),
  );
});

test("profile option scopes list, read, write and search", async () => {
  const DEV = {
    SN_PROFILE_DEV_INSTANCE: "dev1.service-now.com",
    SN_PROFILE_DEV_USER: "dev-user",
    SN_PROFILE_DEV_PASSWORD: "dev-pass",
  };
  await withEnv(DEV, async () => {
    assert.equal(resolveDocsProfile("current"), "default");
    assert.equal(resolveDocsProfile(" DEV "), "dev");
    assert.throws(
      () => resolveDocsProfile("nope"),
      (e) =>
        e instanceof ServiceNowError &&
        e.status === 400 &&
        /nope/.test(e.message),
    );

    const w = await docsWrite("/tables/x.md", "# X\n\nneedle-dev\n", {
      profile: "dev",
    });
    assert.equal(w.path, "dev/tables/x.md");
    const r = await docsRead("tables/x.md", { profile: "dev" });
    assert.equal(r.path, "dev/tables/x.md");
    assert.match(r.content, /needle-dev/);

    const list = await docsList({ profile: "dev" });
    assert.deepEqual(list.files, ["dev/tables/x.md"]);
    const cur = await docsList({ profile: "current" });
    assert.ok(cur.files.every((f) => f.startsWith("default/")));

    const s = await docsSearch("needle-dev", { profile: "current" });
    assert.equal(s.count, 0);
    assert.equal((await docsSearch("needle-dev", { profile: "dev" })).count, 1);

    await withEnv({ SN_ACTIVE_PROFILE: "dev" }, async () => {
      assert.equal(resolveDocsProfile("current"), "dev");
    });
    await assert.rejects(
      docsWrite("a.md", "x", { profile: "missing" }),
      (e) => e.status === 400,
    );
    await assert.rejects(
      docsRead("  ", { profile: "dev" }),
      (e) => e.status === 400,
    );
  });
});

test("search_docs filters by kind / generated, reports headings and caps results", async () => {
  await docsWriteRaw(
    "default/searchable.md",
    [
      "# Searchable",
      "",
      "## Section one",
      "",
      "marker line",
      "```",
      "## not a heading marker",
      "```",
      "",
    ].join("\n"),
    [".md"],
    { ...META, kind: "notes-kind", source: { s: 1 } },
  );
  await docsWrite("search-hand.md", "marker by hand\n");

  const gen = await docsSearch("marker", { kind: "notes-kind" });
  assert.equal(gen.count, 2);
  assert.deepEqual(
    gen.matches.map((m) => m.heading),
    ["Section one", "Section one"],
  );
  assert.equal(gen.matches[0].snippet, "marker line");

  const hand = await docsSearch("marker", { generated: false });
  assert.ok(hand.matches.some((m) => m.path === "search-hand.md"));
  assert.ok(hand.matches.every((m) => m.path !== "default/searchable.md"));
  const hm = hand.matches.find((m) => m.path === "search-hand.md");
  assert.equal(hm.heading, undefined);

  // Frontmatter is not searched.
  const fm = await docsSearch("sn_generator_version", { generated: true });
  assert.equal(fm.count, 0);

  await withEnv({ SN_DOCS_SEARCH_MAX: "1" }, async () => {
    const capped = await docsSearch("marker", {});
    assert.equal(capped.count, 1);
    assert.equal(capped.truncated, true);
  });
  const all = await docsSearch("marker", {});
  assert.equal(all.truncated, undefined);
});

test("docsRead of a large document skips a partial multi-byte tail", async () => {
  await withEnv({ SN_DOCS_MAX_FILE_BYTES: "5" }, async () => {
    await fs.writeFile(path.join(DOCS_DIR, "wide.md"), "abcdé and more");
    const r = await docsRead("wide.md");
    assert.equal(r.truncated, true);
    assert.equal(r.content, "abcd");
    await assert.rejects(docsRead("missing.md"), (e) => e.status === 404);
  });
});
