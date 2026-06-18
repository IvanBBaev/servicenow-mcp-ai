import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { compareInstances } from "../build/api/compare.js";
import { clearSchemaCache } from "../build/core/cache.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

// Each test file runs in its own process, so a per-file temp docs dir is safe.
const DOCS_DIR = path.join(
  os.tmpdir(),
  `servicenow-mcp-compare-${process.pid}`,
);
process.env.SN_DOCS_DIR = DOCS_DIR;

const PROD_HOST = "prod99999.service-now.com";
const PROFILE_ENV = {
  SN_PROFILE_PROD_INSTANCE: PROD_HOST,
  SN_PROFILE_PROD_USER: "prod.user",
  SN_PROFILE_PROD_PASSWORD: "pr0d",
};

test.before(async () => {
  await fs.rm(DOCS_DIR, { recursive: true, force: true });
});

test.after(async () => {
  await fs.rm(DOCS_DIR, { recursive: true, force: true });
});

/**
 * Two mock instances, routed by hostname. dev (the default profile) has an
 * extra table, a differing column type, a changed business rule and an extra
 * one, and an extra plugin; prod has one app dev lacks.
 */
function twoInstanceFetch(url) {
  const u = new URL(url);
  const prod = u.hostname === PROD_HOST;
  const q = u.searchParams.get("sysparm_query") ?? "";

  if (u.pathname.includes("/table/sys_db_object")) {
    const tables = [
      { name: "incident", label: "Incident" },
      { name: "task", label: "Task" },
    ];
    if (!prod) tables.push({ name: "u_dev_only", label: "Dev Only" });
    return jsonResponse(200, { result: tables });
  }
  if (u.pathname.includes("/table/sys_dictionary")) {
    assert.match(q, /elementISNOTEMPTY/);
    return jsonResponse(200, {
      result: [
        {
          name: "incident",
          element: "severity",
          internal_type: prod ? "string" : "integer",
          mandatory: "true",
          reference: "",
        },
        {
          name: "task",
          element: "number",
          internal_type: "string",
          mandatory: "false",
          reference: "",
        },
        // Column on a table that exists only in dev: must NOT show as a diff.
        {
          name: "u_dev_only",
          element: "u_field",
          internal_type: "string",
          mandatory: "false",
          reference: "",
        },
      ],
    });
  }
  if (u.pathname.endsWith("/table/sys_script_include")) {
    return jsonResponse(200, {
      result: [{ name: "SharedUtil", script: "function shared() {}" }],
    });
  }
  if (u.pathname.endsWith("/table/sys_script")) {
    const result = [{ name: "Common BR", script: prod ? "old();" : "new();" }];
    if (!prod) result.push({ name: "Dev BR", script: "devOnly();" });
    return jsonResponse(200, { result });
  }
  if (
    u.pathname.match(
      /\/table\/(sysauto_script|sys_ui_policy|sys_ui_action|sys_script_client|sys_transform_script|sys_ws_operation|sys_processor)/,
    )
  ) {
    return jsonResponse(200, { result: [] });
  }
  if (u.pathname.includes("/table/v_plugin")) {
    const result = [
      { id: "com.snc.base", name: "Base", active: "true", version: "1" },
    ];
    if (!prod) {
      result.push({
        id: "com.snc.dev",
        name: "DevTools",
        active: "true",
        version: "2",
      });
    }
    return jsonResponse(200, { result });
  }
  if (u.pathname.includes("/table/sys_app")) {
    return jsonResponse(200, {
      result: prod
        ? [
            {
              name: "Prod App",
              scope: "x_prod",
              version: "1.0",
              active: "true",
            },
          ]
        : [],
    });
  }
  if (u.pathname.includes("/table/sys_store_app")) {
    return jsonResponse(200, { result: [] });
  }
  return jsonResponse(404, { error: { message: `unmocked: ${u.pathname}` } });
}

test("compareInstances diffs tables, columns, scripts, plugins and apps", async () => {
  baselineEnv();
  clearSchemaCache();
  const result = await withEnv(PROFILE_ENV, () =>
    withFetch(twoInstanceFetch, () =>
      compareInstances({ a: "default", b: "prod" }),
    ),
  );

  assert.deepEqual(result.tablesOnlyInA, ["u_dev_only"]);
  assert.deepEqual(result.tablesOnlyInB, []);

  // Only the genuinely differing property of a shared column shows up.
  assert.deepEqual(result.columnDiffs, [
    {
      table: "incident",
      column: "severity",
      property: "type",
      a: "integer",
      b: "string",
    },
  ]);

  const byStatus = Object.groupBy(result.scriptDiffs, (d) => d.status);
  assert.equal(byStatus.different_source.length, 1);
  assert.equal(byStatus.different_source[0].name, "Common BR");
  assert.equal(byStatus.only_in_a.length, 1);
  assert.equal(byStatus.only_in_a[0].name, "Dev BR");
  assert.equal(byStatus.only_in_b, undefined);

  assert.deepEqual(result.pluginDiffs, [
    "only in default: com.snc.dev DevTools@2",
  ]);
  assert.deepEqual(result.appDiffs, ["only in prod: x_prod Prod App@1.0"]);

  // The Markdown report landed in the docs folder and names both profiles.
  assert.equal(result.report, "_compare/default-vs-prod.md");
  const report = await fs.readFile(
    path.join(DOCS_DIR, "_compare", "default-vs-prod.md"),
    "utf8",
  );
  assert.match(report, /`default` vs `prod`/);
  assert.match(report, /u_dev_only/);
  assert.match(
    report,
    /\| incident \| severity \| type \| integer \| string \|/,
  );
  assert.match(report, /Common BR.*different_source/);
});

test("compareInstances validates profiles and rejects self-comparison", async () => {
  baselineEnv();
  await assert.rejects(
    compareInstances({ a: "default", b: "default" }),
    /itself/,
  );
  await assert.rejects(
    compareInstances({ a: "default", b: "nope" }),
    /Unknown/,
  );
});

test("from_snapshot uses stored JSON for tables and falls back live with a warning", async () => {
  baselineEnv();
  clearSchemaCache();
  // Stored snapshot for prod claims an extra table dev lacks; no snapshot for default.
  await fs.mkdir(path.join(DOCS_DIR, "prod"), { recursive: true });
  await fs.writeFile(
    path.join(DOCS_DIR, "prod", "tables.json"),
    JSON.stringify({
      profile: "prod",
      tables: [
        { name: "incident" },
        { name: "task" },
        { name: "u_prod_snapshot_only" },
      ],
    }),
    "utf8",
  );

  const result = await withEnv(PROFILE_ENV, () =>
    withFetch(twoInstanceFetch, () =>
      compareInstances({ a: "default", b: "prod", fromSnapshot: true }),
    ),
  );

  assert.deepEqual(result.tablesOnlyInB, ["u_prod_snapshot_only"]);
  assert.ok(
    result.warnings.some((w) =>
      w.includes('no snapshot for "default", reading live'),
    ),
  );
});

/**
 * sys_dictionary served over two pages with X-Total-Count=2; every other table
 * is empty. Under SN_MAX_RECORDS=1 the dictionary read truncates, so compare
 * must report a partial-column-diff warning instead of silently under-diffing.
 */
function cappedDictionaryFetch(url) {
  const u = new URL(url);
  if (u.pathname.includes("/table/sys_db_object")) {
    return jsonResponse(
      200,
      { result: [{ name: "incident", label: "Incident" }] },
      { "x-total-count": "1" },
    );
  }
  if (u.pathname.includes("/table/sys_dictionary")) {
    const limit = Number(u.searchParams.get("sysparm_limit"));
    const offset = Number(u.searchParams.get("sysparm_offset") ?? "0");
    const all = [
      {
        name: "incident",
        element: "a",
        internal_type: "string",
        mandatory: "false",
        reference: "",
      },
      {
        name: "incident",
        element: "b",
        internal_type: "string",
        mandatory: "false",
        reference: "",
      },
    ];
    return jsonResponse(
      200,
      { result: all.slice(offset, offset + limit) },
      { "x-total-count": String(all.length) },
    );
  }
  // Scripts, plugins and apps are empty (total 0) so only the dictionary caps.
  return jsonResponse(200, { result: [] }, { "x-total-count": "0" });
}

test("compareInstances warns when sys_dictionary hits the SN_MAX_RECORDS cap (QA-19)", async () => {
  baselineEnv();
  clearSchemaCache();
  const result = await withEnv({ ...PROFILE_ENV, SN_MAX_RECORDS: "1" }, () =>
    withFetch(cappedDictionaryFetch, () =>
      compareInstances({ a: "default", b: "prod" }),
    ),
  );

  assert.ok(
    result.warnings.some(
      (w) => w.includes("sys_dictionary") && w.includes("cap"),
    ),
    `expected a partial-column-diff warning, got: ${JSON.stringify(result.warnings)}`,
  );
  // The warning must also reach the persisted Markdown report.
  const report = await fs.readFile(
    path.join(DOCS_DIR, "_compare", "default-vs-prod.md"),
    "utf8",
  );
  assert.match(report, /Warnings/);
  assert.match(report, /sys_dictionary.*cap/);
});
