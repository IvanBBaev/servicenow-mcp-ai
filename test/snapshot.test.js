import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { snapshotInstance } from "../build/api/snapshot.js";
import { clearSchemaCache } from "../build/core/cache.js";
import { baselineEnv, withFetch, jsonResponse } from "./helpers.js";

// Each test file runs in its own process, so a per-file temp docs dir is safe.
const DOCS_DIR = path.join(
  os.tmpdir(),
  `servicenow-mcp-snapshot-${process.pid}`,
);
process.env.SN_DOCS_DIR = DOCS_DIR;

test.before(async () => {
  await fs.rm(DOCS_DIR, { recursive: true, force: true });
});

test.after(async () => {
  await fs.rm(DOCS_DIR, { recursive: true, force: true });
});

/** Mock instance: enough sys_db_object/sys_dictionary/plugin/app/stats data. */
function instanceFetch(url) {
  const u = new URL(url);
  const q = u.searchParams.get("sysparm_query") ?? "";

  if (u.pathname.includes("/table/sys_db_object")) {
    // getTableChain asks name=<table>; listTables asks the full ordered list.
    if (q.includes("name=incident")) {
      return jsonResponse(200, {
        result: [{ name: "incident", "super_class.name": "task" }],
      });
    }
    if (q.includes("name=task")) {
      return jsonResponse(200, { result: [{ name: "task" }] });
    }
    return jsonResponse(200, {
      result: [
        { name: "incident", label: "Incident", "super_class.name": "task" },
        { name: "task", label: "Task" },
      ],
    });
  }
  if (u.pathname.includes("/table/sys_dictionary")) {
    return jsonResponse(200, {
      result: [
        {
          element: "number",
          column_label: "Number",
          internal_type: "string",
          mandatory: "false",
          name: "task",
        },
        {
          element: "severity",
          column_label: "Severity",
          internal_type: "integer",
          mandatory: "true",
          name: "incident",
        },
      ],
    });
  }
  if (u.pathname.includes("/table/v_plugin")) {
    return jsonResponse(200, {
      result: [
        {
          id: "com.snc.incident",
          name: "Incident",
          active: "true",
          version: "1.0",
        },
      ],
    });
  }
  if (u.pathname.includes("/table/sys_app")) {
    return jsonResponse(200, {
      result: [
        { name: "HR App", scope: "x_hr", version: "2.1", active: "true" },
      ],
    });
  }
  if (u.pathname.includes("/table/sys_store_app")) {
    return jsonResponse(200, { result: [] });
  }
  if (u.pathname.includes("/api/now/stats/")) {
    return jsonResponse(200, {
      result: [
        {
          groupby_fields: [{ field: "active", value: "true" }],
          stats: { count: "5", max: { sys_updated_on: "2026-06-01 10:00:00" } },
        },
        {
          groupby_fields: [{ field: "active", value: "false" }],
          stats: { count: "2", max: { sys_updated_on: "2025-12-24 09:00:00" } },
        },
      ],
    });
  }
  return jsonResponse(404, { error: { message: `unmocked: ${u.pathname}` } });
}

test("snapshotInstance writes the documented file set", async () => {
  baselineEnv();
  clearSchemaCache();
  const result = await withFetch(instanceFetch, () =>
    snapshotInstance({ tables: ["incident"] }),
  );

  assert.equal(result.profile, "default");
  assert.deepEqual(result.warnings, []);
  for (const rel of [
    "tables.md",
    "tables.json",
    "schema/incident.md",
    "schema.json",
    "plugins.md",
    "plugins.json",
    "apps.md",
    "apps.json",
    "automation.md",
    "automation.json",
    "index.md",
  ]) {
    assert.ok(result.files.includes(`default/${rel}`), `${rel} in result`);
    await fs.access(path.join(DOCS_DIR, "default", rel));
  }

  const tablesJson = JSON.parse(
    await fs.readFile(path.join(DOCS_DIR, "default", "tables.json"), "utf8"),
  );
  assert.equal(tablesJson.profile, "default");
  assert.equal(tablesJson.tables.length, 2);

  const schemaMd = await fs.readFile(
    path.join(DOCS_DIR, "default", "schema", "incident.md"),
    "utf8",
  );
  // Inherited column from task is present and attributed to its source table.
  assert.match(schemaMd, /number.*task/);
  assert.match(schemaMd, /severity.*incident/);

  const automation = JSON.parse(
    await fs.readFile(
      path.join(DOCS_DIR, "default", "automation.json"),
      "utf8",
    ),
  );
  assert.equal(automation.automation.business_rule.total, 7);
  assert.equal(automation.automation.business_rule.active, 5);
  assert.equal(
    automation.automation.business_rule.lastUpdated,
    "2026-06-01 10:00:00",
  );

  const index = await fs.readFile(
    path.join(DOCS_DIR, "default", "index.md"),
    "utf8",
  );
  assert.match(index, /\[tables\.md\]\(tables\.md\)/);
  assert.match(index, /\[schema\/incident\.md\]\(schema\/incident\.md\)/);
  assert.doesNotMatch(index, /## Warnings/);
});

test("snapshotInstance is idempotent and skips unsafe table names", async () => {
  baselineEnv();
  clearSchemaCache();
  const rerun = await withFetch(instanceFetch, () =>
    snapshotInstance({ tables: ["incident", "../evil", "Bad Name"] }),
  );

  // Same file set as before — rerun overwrites cleanly, nothing accumulates.
  assert.ok(rerun.files.includes("default/tables.md"));
  const schemaDir = await fs.readdir(path.join(DOCS_DIR, "default", "schema"));
  assert.deepEqual(schemaDir.sort(), ["incident.md"]);

  // Unsafe names are reported, not written.
  assert.equal(rerun.warnings.length, 2);
  assert.match(rerun.warnings[0], /invalid table name/);
  await assert.rejects(
    fs.access(path.join(DOCS_DIR, "default", "schema", "evil.md")),
  );
});

test("snapshot falls back to sys_plugins and reports failing sections", async () => {
  baselineEnv();
  clearSchemaCache();
  const failingFetch = (url) => {
    const u = new URL(url);
    if (u.pathname.includes("/table/v_plugin")) {
      return jsonResponse(403, { error: { message: "no access" } });
    }
    if (u.pathname.includes("/table/sys_plugins")) {
      return jsonResponse(200, {
        result: [
          { source: "com.snc.x", name: "X", active: "true", version: "1" },
        ],
      });
    }
    if (u.pathname.includes("/api/now/stats/")) {
      return jsonResponse(403, { error: { message: "stats denied" } });
    }
    return instanceFetch(url);
  };

  const result = await withFetch(failingFetch, () => snapshotInstance());

  const plugins = JSON.parse(
    await fs.readFile(path.join(DOCS_DIR, "default", "plugins.json"), "utf8"),
  );
  assert.equal(plugins.source, "sys_plugins");
  assert.equal(plugins.plugins[0].id, "com.snc.x");

  // Every script type failed via stats — warnings recorded, automation.md still written.
  assert.ok(result.warnings.some((w) => w.startsWith("automation:")));
  const automationMd = await fs.readFile(
    path.join(DOCS_DIR, "default", "automation.md"),
    "utf8",
  );
  assert.match(automationMd, /n\/a/);
  const index = await fs.readFile(
    path.join(DOCS_DIR, "default", "index.md"),
    "utf8",
  );
  assert.match(index, /## Warnings/);
});

test("snapshot skips the plugins section and warns when BOTH sources fail (QA-6)", async () => {
  baselineEnv();
  clearSchemaCache();
  // Start clean so the absence assertions are not satisfied by a prior run.
  await fs.rm(path.join(DOCS_DIR, "default"), { recursive: true, force: true });

  const bothFail = (url) => {
    const u = new URL(url);
    if (
      u.pathname.includes("/table/v_plugin") ||
      u.pathname.includes("/table/sys_plugins")
    ) {
      return jsonResponse(403, { error: { message: "no access" } });
    }
    if (u.pathname.includes("/api/now/stats/")) {
      return jsonResponse(403, { error: { message: "stats denied" } });
    }
    return instanceFetch(url);
  };

  const result = await withFetch(bothFail, () => snapshotInstance());

  assert.ok(
    result.warnings.some((w) => /^plugins: unavailable/.test(w)),
    "a plugins-unavailable warning must be recorded",
  );
  // Neither the markdown nor the JSON companion is written when both fail.
  await assert.rejects(
    fs.access(path.join(DOCS_DIR, "default", "plugins.json")),
    "plugins.json must not exist when both sources fail",
  );
  await assert.rejects(
    fs.access(path.join(DOCS_DIR, "default", "plugins.md")),
    "plugins.md must not exist when both sources fail",
  );
});
