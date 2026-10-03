// D-3: README env tables, .env.example and the server.json env block are
// generated from the E-4 settings manifest. This guard fails when a generated
// file is stale (run `npm run docs:env`) and pins the generator's behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EXAMPLE_BEGIN,
  EXAMPLE_END,
  README_BEGIN,
  README_END,
  buildEnvExample,
  buildReadmeEnv,
  buildServerEnv,
  renderEnvDocs,
  stripMarkdown,
  syncEnvDocs,
} from "../scripts/env-docs.mjs";
import { SETTINGS, SETTING_SECTIONS } from "../build/core/settings-manifest.js";

const root = path.join(import.meta.dirname, "..");
const FILES = ["README.md", ".env.example", "server.json"];

test("the generated env docs match the settings manifest", () => {
  const next = renderEnvDocs({
    root,
    settings: SETTINGS,
    sections: SETTING_SECTIONS,
  });
  for (const file of FILES) {
    assert.equal(
      readFileSync(path.join(root, file), "utf8"),
      next[file],
      `${file} is stale — run \`npm run docs:env\``,
    );
  }
});

test("every declared setting is documented in README and .env.example", () => {
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  const example = readFileSync(path.join(root, ".env.example"), "utf8");
  for (const spec of SETTINGS) {
    assert.ok(readme.includes(`\`${spec.key}\``), `README: ${spec.key}`);
    if (!spec.pattern) {
      assert.ok(example.includes(`${spec.key}=`), `.env.example: ${spec.key}`);
    }
  }
  // The stale pre-rename config path is gone.
  assert.ok(!example.includes("sincronia-mcp"));
  assert.ok(example.includes("servicenow-mcp-ai"));
});

test("only the required connection keys are uncommented in .env.example", () => {
  const body = buildEnvExample(SETTINGS, SETTING_SECTIONS);
  const live = body
    .split("\n")
    .filter((line) => /^[A-Z]/.test(line))
    .map((line) => line.split("=")[0]);
  assert.deepEqual(live, ["SN_INSTANCE", "SN_USER", "SN_PASSWORD"]);
  assert.ok(body.startsWith(EXAMPLE_BEGIN) && body.endsWith(EXAMPLE_END));
  for (const line of body.split("\n")) {
    assert.ok(line.length <= 100, `long line: ${line}`);
  }
});

test("the README tables escape pipes and group by section", () => {
  const settings = [
    {
      key: "SN_A",
      section: "network",
      kind: "string",
      since: "unreleased",
      description: "a | b with `code`",
      default: 5,
      aliases: ["A"],
    },
    {
      key: "SN_PROFILE_<NAME>_*",
      section: "profiles",
      kind: "string",
      since: "1.1.0",
      pattern: true,
      example: "SN_PROFILE_X_A=1\nSN_PROFILE_X_B=2",
      description: "pattern",
    },
  ];
  const md = buildReadmeEnv(settings, SETTING_SECTIONS);
  assert.ok(md.startsWith(README_BEGIN) && md.endsWith(README_END));
  assert.match(
    md,
    /\| `SN_A` \| no \| `5` \| next \| a \\\| b with `code` Also read as `A`\. \|/,
  );
  assert.match(md, /Example: `SN_PROFILE_X_A=1`, `SN_PROFILE_X_B=2`\./);
  assert.ok(md.indexOf("#### Profiles") < md.indexOf("#### Network"));
  // Sections without settings are skipped.
  assert.ok(!md.includes("#### Logging"));
  const env = buildEnvExample(settings, SETTING_SECTIONS);
  assert.match(env, /# SN_A=5/);
  assert.match(env, /# SN_PROFILE_X_A=1\n# SN_PROFILE_X_B=2/);
  assert.match(env, /Also read as A\./);
});

test("server.json publishes the registry keys with secret flags", () => {
  const env = buildServerEnv(SETTINGS);
  const names = env.map((e) => e.name);
  for (const key of [
    "SN_INSTANCE",
    "SN_AUTH",
    "SN_USER",
    "SN_PASSWORD",
    "SN_API_KEY",
    "SN_TOOL_PACKAGES",
  ]) {
    assert.ok(names.includes(key), key);
  }
  const byName = Object.fromEntries(env.map((e) => [e.name, e]));
  assert.equal(byName.SN_INSTANCE.isRequired, true);
  assert.equal(byName.SN_USER.isRequired, false);
  assert.equal(byName.SN_PASSWORD.isSecret, true);
  assert.equal(byName.SN_API_KEY.isSecret, true);
  assert.equal(byName.SN_INSTANCE.isSecret, undefined);
  for (const e of env) assert.equal(e.format, "string");
});

test("stripMarkdown drops code ticks, bold and links", () => {
  assert.equal(
    stripMarkdown("use `x` and **y** per [docs](https://e.x/)"),
    "use x and y per docs",
  );
});

test("--check reports stale files; a write fixes them; missing markers throw", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sn-env-docs-"));
  try {
    for (const file of FILES) {
      copyFileSync(path.join(root, file), path.join(dir, file));
    }
    const opts = { root: dir, settings: SETTINGS, sections: SETTING_SECTIONS };
    assert.deepEqual(syncEnvDocs({ ...opts, check: true }), []);
    const trimmed = SETTINGS.filter((s) => s.key !== "SN_TIMEOUT_MS");
    const stale = { ...opts, settings: trimmed };
    assert.deepEqual(syncEnvDocs({ ...stale, check: true }), [
      "README.md",
      ".env.example",
    ]);
    assert.deepEqual(syncEnvDocs(stale), ["README.md", ".env.example"]);
    assert.deepEqual(syncEnvDocs({ ...stale, check: true }), []);
    assert.doesNotMatch(
      readFileSync(path.join(dir, "README.md"), "utf8"),
      /^\| `SN_TIMEOUT_MS` \|/m,
    );
    copyFileSync(path.join(root, "package.json"), path.join(dir, "README.md"));
    assert.throws(() => syncEnvDocs(opts), /README\.md: markers not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
