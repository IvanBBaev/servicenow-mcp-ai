// P-29 — the Fluent emitters' SDK oracle (scripts/fluent-verify.mjs, owner
// gate O-7). Every golden under test/fixtures/fluent/ is type-checked against
// the pinned @servicenow/sdk devDependency and built with `now-sdk build`
// (offline); each keyed record must come out under its source sys_id and no
// DELETE may be emitted. Skipped when the SDK is not installed.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SDK = path.join(
  ROOT,
  "node_modules",
  "@servicenow",
  "sdk",
  "package.json",
);

test(
  "every Fluent golden type-checks and builds with the pinned SDK",
  {
    skip: existsSync(SDK) ? false : "@servicenow/sdk is not installed",
    timeout: 300_000,
  },
  () => {
    const r = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "fluent-verify.mjs"), "--json"],
      { cwd: ROOT, encoding: "utf8", timeout: 290_000 },
    );
    const report = JSON.parse(r.stdout.trim().split("\n").pop());
    const pinned = JSON.parse(
      readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ).devDependencies["@servicenow/sdk"];
    assert.equal(report.sdk, pinned);
    assert.ok(report.goldens >= 27, String(report.goldens));
    assert.deepEqual(report.typeErrors, []);
    assert.deepEqual(report.keyConflicts, []);
    assert.equal(report.build?.ok, true, report.build?.log);
    assert.deepEqual(report.build.missing, []);
    assert.equal(report.ok, true);
    assert.equal(r.status, 0);
  },
);

test(
  "the action.core input table matches the pinned SDK",
  {
    skip: existsSync(SDK) ? false : "@servicenow/sdk is not installed",
  },
  () => {
    const r = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "gen-fluent-actions.mjs"), "--check"],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  },
);
