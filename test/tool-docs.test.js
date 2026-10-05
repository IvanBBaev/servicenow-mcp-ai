// N-42 / N-53: the generated tool reference (docs/tools/, docs/llms-full.txt,
// the docs/llms.txt link section) follows the live registry, and
// context7.json points the documentation index at it. Run
// `npm run docs:sync` when the drift test fails.
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CONTEXT7,
  LANDING_HTML,
  LANDING_MD,
  LLMS,
  LLMS_FULL,
  TOOLS_DIR,
  checkContext7,
  generateToolDocs,
  syncToolDocs,
  typeLabel,
  writesLabel,
} from "../scripts/tool-docs.mjs";
import {
  decodeEntities,
  htmlToMarkdown,
  landingMarkdown,
} from "../scripts/landing-md.mjs";
import {
  describeAllTools,
  describeToolSchemas,
  resolveEnabledPackages,
} from "../build/mcp/registry.js";
import { errorCodeTable } from "../build/core/errors.js";

const root = path.join(import.meta.dirname, "..");

function liveFiles(at = root) {
  return generateToolDocs({
    root: at,
    tools: describeAllTools(),
    schemas: describeToolSchemas(),
    errorCodes: errorCodeTable(),
    corePackages: resolveEnabledPackages(["core"]),
  });
}

test("the committed tool reference matches the registry", () => {
  assert.deepEqual(
    syncToolDocs({ root, files: liveFiles(), check: true }),
    [],
    "tool reference drift — run `npm run docs:sync`",
  );
});

test("every tool has a section on its package page", () => {
  const files = liveFiles();
  for (const tool of describeAllTools()) {
    const page = files.get(`${TOOLS_DIR}/${tool.package}.md`);
    assert.ok(page, tool.package);
    assert.ok(page.includes(`\n## ${tool.name}\n`), tool.name);
  }
  const index = files.get(`${TOOLS_DIR}/README.md`);
  for (const code of Object.keys(errorCodeTable())) {
    assert.ok(index.includes(`| \`${code}\` |`), code);
  }
});

test("llms-full.txt bundles README, SECURITY and the tool reference", () => {
  const full = liveFiles().get(LLMS_FULL);
  assert.ok(
    full.includes(readFileSync(path.join(root, "README.md"), "utf8").trim()),
  );
  assert.ok(
    full.includes(readFileSync(path.join(root, "SECURITY.md"), "utf8").trim()),
  );
  assert.ok(full.includes("# Tool reference\n"));
  assert.ok(full.includes("## servicenow_query_table\n"));
  const llms = liveFiles().get(LLMS);
  assert.match(llms, /\[Full documentation in one file\]\(.*llms-full\.txt\)/);
  assert.match(llms, /\[table\]\(.*docs\/tools\/table\.md\)/);
});

test("typeLabel renders enums, unions, arrays and records", () => {
  assert.equal(typeLabel({ type: "string" }), "string");
  assert.equal(typeLabel({ enum: ["a", "b"] }), '"a" | "b"');
  assert.equal(
    typeLabel({ type: "array", items: { type: "string" } }),
    "string[]",
  );
  assert.equal(
    typeLabel({ anyOf: [{ type: "string" }, { type: "number" }] }),
    "string | number",
  );
  assert.equal(
    typeLabel({ type: "object", additionalProperties: { type: "boolean" } }),
    "record<boolean>",
  );
  assert.equal(typeLabel({ type: ["string", "null"] }), "string | null");
  assert.equal(typeLabel({ const: 1 }), "1");
  assert.equal(typeLabel(undefined), "any");
  assert.equal(typeLabel({}), "any");
});

test("writesLabel follows the annotations and the plan-and-apply parameters", () => {
  assert.equal(
    writesLabel({ annotations: { readOnlyHint: true } }, {}),
    "Read-only.",
  );
  const write = writesLabel(
    { annotations: { readOnlyHint: false, destructiveHint: true } },
    { properties: { apply: {}, plan_token: {} } },
  );
  assert.match(write, /^Destructive write\./);
  assert.match(write, /plan preview/);
  assert.match(write, /plan_token/);
  assert.equal(
    writesLabel({ annotations: { idempotentHint: true } }, { properties: {} }),
    "Write, idempotent.",
  );
});

test("syncToolDocs writes, reports drift under --check and drops stale pages", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sn-tool-docs-"));
  try {
    for (const file of ["README.md", "SECURITY.md", LLMS, LANDING_HTML]) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(
        path.join(dir, file),
        readFileSync(path.join(root, file), "utf8"),
      );
    }
    mkdirSync(path.join(dir, TOOLS_DIR), { recursive: true });
    writeFileSync(path.join(dir, TOOLS_DIR, "gone.md"), "stale\n");
    const files = liveFiles(dir);
    const drift = syncToolDocs({ root: dir, files, check: true });
    assert.ok(drift.includes(`${TOOLS_DIR}/gone.md`));
    assert.ok(drift.includes(LLMS_FULL));
    assert.ok(
      existsSync(path.join(dir, TOOLS_DIR, "gone.md")),
      "check writes nothing",
    );
    syncToolDocs({ root: dir, files });
    assert.ok(!existsSync(path.join(dir, TOOLS_DIR, "gone.md")));
    assert.deepEqual(syncToolDocs({ root: dir, files, check: true }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generateToolDocs fails loudly when the llms.txt markers are gone", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sn-tool-docs-"));
  try {
    for (const file of ["README.md", "SECURITY.md"]) {
      writeFileSync(path.join(dir, file), "x\n");
    }
    mkdirSync(path.join(dir, "docs"));
    writeFileSync(path.join(dir, LANDING_HTML), "<main><p>x</p></main>\n");
    writeFileSync(path.join(dir, LLMS), "# no markers\n");
    assert.throws(() => liveFiles(dir), /markers not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("context7.json indexes docs/ and keeps planning and test trees out (N-53)", () => {
  assert.deepEqual(checkContext7(root), []);
  const dir = mkdtempSync(path.join(tmpdir(), "sn-context7-"));
  try {
    assert.deepEqual(checkContext7(dir), [`${CONTEXT7} is missing`]);
    writeFileSync(path.join(dir, CONTEXT7), "{");
    assert.equal(checkContext7(dir).length, 1);
    writeFileSync(
      path.join(dir, CONTEXT7),
      JSON.stringify({ folders: ["nowhere"], excludeFolders: [] }),
    );
    const problems = checkContext7(dir).join("\n");
    assert.match(problems, /projectTitle is missing/);
    assert.match(problems, /excludeFiles must be an array/);
    assert.match(problems, /folder nowhere does not exist/);
    assert.match(problems, /folders must include docs/);
    assert.match(problems, /excludeFolders must include project/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the landing page has a Markdown alternate that keeps its sections", () => {
  const html = readFileSync(path.join(root, LANDING_HTML), "utf8");
  assert.match(
    html,
    /<link rel="alternate" type="text\/markdown" href="index\.md"/,
  );
  const md = liveFiles().get(LANDING_MD);
  for (const heading of html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)) {
    const words = decodeEntities(heading[1].replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    assert.ok(md.includes(`\n## ${words}\n`), words);
  }
  assert.ok(!/<(svg|script|button|div|span)\b/.test(md), "markup leaked");
  assert.ok(md.length < html.length / 2);
  assert.match(md, /not affiliated with/);
  assert.match(liveFiles().get(LLMS), /\[Documentation site as Markdown\]/);
});

test("htmlToMarkdown renders the elements the landing page uses", () => {
  assert.equal(
    htmlToMarkdown(
      '<h2>A &amp; B</h2><p>Text <strong>bold</strong> <em>it</em> <code>x|y</code> <a href="https://e.x">link</a> <a href="#in">anchor</a></p>',
    ),
    "## A & B\n\nText **bold** *it* `x|y` [link](https://e.x) anchor\n",
  );
  assert.equal(
    htmlToMarkdown("<pre>\n{ &quot;a&quot;: 1 }\n</pre>"),
    '```\n{ "a": 1 }\n```\n',
  );
  assert.equal(
    htmlToMarkdown(
      "<table><thead><tr><th>K</th><th>V</th></tr></thead><tbody><tr><td><code>a|b</code></td></tr></tbody></table>",
    ),
    "| K | V |\n| --- | --- |\n| `a\\|b` |  |\n",
  );
  assert.equal(
    htmlToMarkdown("<ol><li>one</li><li><p>two</p><pre>x</pre></li></ol>"),
    "1. one\n2. two\n\n   ```\n   x\n   ```\n",
  );
  assert.equal(
    htmlToMarkdown(
      '<div class="stat-row"><div><b>9</b><span>tools</span></div></div><svg><text>no</text></svg><button>no</button><p aria-hidden="true">no</p><p hidden>no</p>',
    ),
    "- **9** tools\n",
  );
  assert.equal(
    htmlToMarkdown(
      "<details><summary><code>t</code> sum</summary><p>body</p></details>",
    ),
    "`t` sum\n\nbody\n",
  );
  assert.equal(htmlToMarkdown("<script>if (a < b) {}</script>"), "");
  assert.equal(decodeEntities("&#9829; &#x2192; &bogus;"), "♥ → &bogus;");
  assert.throws(
    () => landingMarkdown("<p>no main</p>", { siteUrl: "s" }),
    /no <main>/,
  );
});
