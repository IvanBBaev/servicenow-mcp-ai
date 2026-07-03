// GA-6 (the M-5 remainder): the README env reference and .env.example are
// hand-maintained — this test pins them to the code. Every SN_*/JIRA_* env
// var the source can read must be documented in both files, so a new knob
// cannot ship undocumented.
//
// The inventory is the union of two scans over src/**/*.ts:
//   1. literal SN_*/JIRA_* tokens anywhere in the source — env reads,
//      docstrings and error messages all count (an error message naming a
//      var IS the var's public name);
//   2. authEnv("SUFFIX") call sites, which resolve to SN_<SUFFIX> (the
//      profile-scoped variant rides the same suffix) — these names never
//      appear literally.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// Internal identifiers that match the token pattern but are not env vars.
const NOT_ENV_VARS = new Set([
  "SN_HOST_POLICY", // const in core/host.ts (the SSRF-guard policy object)
  "JIRA_HOST_POLICY", // const in core/jira/host.ts (same)
]);

// ARCH-14: the Jira core exists but its tool surface is deliberately dark —
// no tools, no README section. Documenting JIRA_* now would advertise a
// surface that does not exist; the docs update belongs to the ARCH-14 change.
// The inverse assertion below deletes this exception the moment that happens.
const PENDING_DARK_SURFACE = new Set([
  "JIRA_SITE",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "JIRA_ALLOWED_HOSTS",
]);

function tsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function envVarsReadInSrc() {
  const vars = new Set();
  for (const file of tsFiles(path.join(root, "src"))) {
    const source = readFileSync(file, "utf8");
    for (const [token] of source.matchAll(
      /\b(?:SN|JIRA)_[A-Z0-9_]*[A-Z0-9]\b/g,
    )) {
      if (!NOT_ENV_VARS.has(token)) vars.add(token);
    }
    for (const [, suffix] of source.matchAll(/authEnv\("([A-Z0-9_]+)"\)/g)) {
      vars.add(`SN_${suffix}`);
    }
  }
  return [...vars].sort();
}

const readme = readFileSync(path.join(root, "README.md"), "utf8");
const envExample = readFileSync(path.join(root, ".env.example"), "utf8");
const srcVars = envVarsReadInSrc();

test("the source scan finds a sane inventory", () => {
  // A refactor that breaks the extraction would silently pass an empty list;
  // pin a floor and a few sentinels from different read styles.
  assert.ok(srcVars.length >= 50, `only ${srcVars.length} vars found`);
  for (const sentinel of [
    "SN_INSTANCE", // dotted process.env read
    "SN_READONLY", // suffix-built via policyValue, named in an error message
    "SN_OAUTH_JWT_KID", // suffix-built via authEnv, never literal in src
  ]) {
    assert.ok(srcVars.includes(sentinel), `${sentinel} missing from the scan`);
  }
});

test("every env var read in src/ is documented in the README env reference", () => {
  const missing = srcVars.filter(
    (v) => !PENDING_DARK_SURFACE.has(v) && !readme.includes(v),
  );
  assert.deepEqual(missing, [], `undocumented in README.md: ${missing}`);
});

test("every env var read in src/ appears in .env.example", () => {
  const missing = srcVars.filter(
    (v) => !PENDING_DARK_SURFACE.has(v) && !envExample.includes(v),
  );
  assert.deepEqual(missing, [], `missing from .env.example: ${missing}`);
});

test("the ARCH-14 exception self-destructs once Jira is documented", () => {
  // When the Jira tool surface lands and JIRA_* enters the README, the
  // exception above must be removed so the sync becomes binding for it too.
  const documented = [...PENDING_DARK_SURFACE].filter((v) =>
    readme.includes(v),
  );
  assert.deepEqual(
    documented,
    [],
    `now documented — remove from PENDING_DARK_SURFACE: ${documented}`,
  );
});
