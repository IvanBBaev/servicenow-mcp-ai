import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { snapshotInstance } from "../build/api/snapshot.js";
import { clearSchemaCache } from "../build/core/cache.js";
import { runSpec } from "../build/mcp/define.js";
import { specs as instanceSpecs } from "../build/tools/instance.js";
import { baselineEnv, withEnv, withFetch, jsonResponse } from "./helpers.js";

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
  const records = RECORD_ROWS[u.pathname.split("/").pop()];
  if (records) return jsonResponse(200, { result: records });
  return jsonResponse(404, { error: { message: `unmocked: ${u.pathname}` } });
}

/** S-7 record sections: one or two rows per table. */
const RECORD_ROWS = {
  sys_properties: [
    { sys_id: "p1", name: "glide.ui.title", type: "string", value: "Dev" },
    { sys_id: "p2", name: "x.api_key", type: "string", value: "s3cr3t" },
    { sys_id: "p3", name: "x.login", type: "password2", value: "enc" },
  ],
  sys_choice: [
    {
      sys_id: "c1",
      name: "incident",
      element: "state",
      value: "1",
      label: "New",
      sequence: "1",
    },
  ],
  sys_security_acl: [
    {
      sys_id: "a1",
      name: "incident",
      operation: "read",
      type: "record",
      active: "true",
      admin_overrides: "true",
      script: "answer = true;",
    },
  ],
  sysevent_email_action: [
    {
      sys_id: "n1",
      name: "Incident opened",
      collection: "incident",
      event_name: "incident.inserted",
      active: "true",
    },
  ],
  sys_hub_flow: [
    {
      sys_id: "f1",
      name: "Onboard",
      internal_name: "onboard",
      type: "flow",
      active: "true",
      status: "published",
    },
  ],
  sc_cat_item: [
    {
      sys_id: "i1",
      name: "Laptop",
      sys_class_name: "sc_cat_item",
      active: "true",
    },
  ],
  sys_user_role: [{ sys_id: "r1", name: "itil", elevated_privilege: "false" }],
};

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

  // S-14: the file list lives in the root index; the profile page is a README.
  const index = await fs.readFile(
    path.join(DOCS_DIR, "default", "index.md"),
    "utf8",
  );
  assert.doesNotMatch(index, /\[tables\.md\]\(tables\.md\)/);
  assert.doesNotMatch(index, /## Warnings/);
  const rootIndex = await fs.readFile(path.join(DOCS_DIR, "index.md"), "utf8");
  assert.match(rootIndex, /\[default\/tables\.md\]\(default\/tables\.md\)/);
  assert.match(
    rootIndex,
    /\[default\/schema\/incident\.md\]\(default\/schema\/incident\.md\)/,
  );
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

test("a snapshot re-run is unchanged and keeps manual notes (S-14)", async () => {
  baselineEnv();
  clearSchemaCache();
  const first = await withFetch(instanceFetch, () =>
    snapshotInstance({ tables: ["incident"] }),
  );
  const indexPath = path.join(DOCS_DIR, "default", "index.md");
  const hashes = {};
  for (const rel of first.files) {
    const text = await fs.readFile(path.join(DOCS_DIR, rel), "utf8");
    hashes[rel] = /sn_source_hash"?: "?(sha256:[0-9a-f]{64})/.exec(text)?.[1];
    assert.ok(hashes[rel], `${rel} carries sn_source_hash`);
  }
  assert.match(
    await fs.readFile(path.join(DOCS_DIR, "default", "tables.md"), "utf8"),
    /^---\nsn_generated: true\nsn_generator: servicenow_snapshot_instance\n/,
  );

  // A human writes into the notes block of the profile README.
  const notes =
    "<!-- sn:manual:start -->\nRefresh after every upgrade — Ivan\n<!-- sn:manual:end -->";
  const readme = await fs.readFile(indexPath, "utf8");
  assert.match(readme, /<!-- sn:manual:start -->\n<!-- sn:manual:end -->/);
  await fs.writeFile(
    indexPath,
    readme.replace(/<!-- sn:manual:start -->\n<!-- sn:manual:end -->/, notes),
  );

  clearSchemaCache();
  const second = await withFetch(instanceFetch, () =>
    snapshotInstance({ tables: ["incident"] }),
  );
  assert.deepEqual(second.files, first.files);
  for (const rel of second.files) {
    assert.equal(second.changes[rel], "unchanged", rel);
    const text = await fs.readFile(path.join(DOCS_DIR, rel), "utf8");
    assert.ok(text.includes(hashes[rel]), `${rel} keeps its hash`);
  }
  assert.ok((await fs.readFile(indexPath, "utf8")).includes(notes));

  // A changed section regenerates, and the notes still survive.
  clearSchemaCache();
  const third = await withFetch(instanceFetch, () =>
    snapshotInstance({ tables: ["incident", "Bad Name"] }),
  );
  assert.equal(third.changes["default/index.md"], "updated");
  assert.equal(third.changes["default/tables.md"], "unchanged");
  const regenerated = await fs.readFile(indexPath, "utf8");
  assert.ok(regenerated.includes(notes));
  assert.match(regenerated, /## Warnings/);
});

test("a snapshot does not overwrite a hand-written file in its way", async () => {
  baselineEnv();
  clearSchemaCache();
  const hand = path.join(DOCS_DIR, "default", "apps.md");
  await fs.writeFile(hand, "# My own app notes\n");
  const r = await withFetch(instanceFetch, () =>
    snapshotInstance({ tables: ["incident"] }),
  );
  assert.equal(await fs.readFile(hand, "utf8"), "# My own app notes\n");
  assert.ok(
    r.warnings.some((w) => /apps\.md/.test(w) && /hand-written/.test(w)),
  );
  assert.ok(!r.files.includes("default/apps.md"));
});

test("snapshot automation follows the registry: base query, active field (S-4)", async () => {
  baselineEnv();
  clearSchemaCache();
  const statsUrls = new Map();
  await withFetch(
    (url) => {
      const u = new URL(url);
      if (u.pathname.includes("/api/now/stats/")) {
        statsUrls.set(u.pathname.split("/").pop(), u.searchParams);
      }
      return instanceFetch(url);
    },
    () => snapshotInstance({ tables: [] }),
  );
  // Pre-S-4 request shape for an original type.
  const br = statsUrls.get("sys_script");
  assert.equal(br.get("sysparm_group_by"), "active");
  assert.equal(br.get("sysparm_query"), null);
  // sys_dictionary is narrowed to the rows that carry script.
  assert.match(
    statsUrls.get("sys_dictionary").get("sysparm_query"),
    /^virtual=true\^ORdefault_valueSTARTSWITHjavascript:$/,
  );
  // A fix script has no active flag: no group-by, active is null / n/a.
  assert.equal(statsUrls.get("sys_script_fix").get("sysparm_group_by"), null);
  const automation = JSON.parse(
    await fs.readFile(
      path.join(DOCS_DIR, "default", "automation.json"),
      "utf8",
    ),
  );
  assert.equal(automation.automation.fix_script.active, null);
  assert.equal(automation.automation.fix_script.total, 7);
  const md = await fs.readFile(
    path.join(DOCS_DIR, "default", "automation.md"),
    "utf8",
  );
  assert.match(md, /\| fix_script \| sys_script_fix \| 7 \| n\/a \|/);
});

// --- S-7: record sections, fan-out, cancel + resume --------------------------

const readJson = async (rel) =>
  JSON.parse(await fs.readFile(path.join(DOCS_DIR, rel), "utf8"));

test("record sections are written redacted, and `sections` narrows the run (S-7)", async () => {
  baselineEnv();
  clearSchemaCache();
  const paths = [];
  const result = await withFetch(
    (url) => {
      paths.push(new URL(url).pathname);
      return instanceFetch(url);
    },
    () => snapshotInstance({ sections: ["properties", "acls", "roles"] }),
  );
  // Only the chosen sections were read.
  assert.ok(
    paths.every((p) => /sys_properties|sys_security_acl|sys_user_role/.test(p)),
  );
  for (const id of ["properties", "acls", "roles"]) {
    assert.ok(result.files.includes(`default/${id}.md`), id);
    assert.ok(result.files.includes(`default/${id}.json`), id);
  }
  assert.ok(!result.files.includes("default/tables.md"));
  assert.equal(result.resumed, undefined);

  const props = (await readJson("default/properties.json")).records;
  assert.equal(props.find((r) => r.name === "glide.ui.title").value, "Dev");
  assert.equal(props.find((r) => r.name === "x.api_key").value, "[redacted]");
  assert.equal(props.find((r) => r.name === "x.login").value, "[redacted]");
  const md = await fs.readFile(
    path.join(DOCS_DIR, "default", "properties.md"),
    "utf8",
  );
  assert.doesNotMatch(md, /s3cr3t/);

  const [acl] = (await readJson("default/acls.json")).records;
  assert.equal(acl.script, undefined);
  assert.match(acl.script_hash, /^[0-9a-f]{16}$/);
  assert.match(
    await fs.readFile(path.join(DOCS_DIR, "default", "index.md"), "utf8"),
    /domain separation/,
  );
});

test("the snapshot fans out to at most four reads at a time (S-7)", async () => {
  baselineEnv();
  clearSchemaCache();
  let inflight = 0;
  let peak = 0;
  await withEnv({ SN_MAX_CONCURRENT: "10" }, () =>
    withFetch(
      async (url) => {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 5));
        inflight--;
        return instanceFetch(url);
      },
      () => snapshotInstance({ tables: ["incident"] }),
    ),
  );
  assert.ok(peak > 1, `ran in parallel (peak ${peak})`);
  assert.ok(peak <= 4, `peak ${peak} <= 4`);
});

test("a cancelled snapshot leaves a partial index; resume skips finished units (S-7)", async () => {
  baselineEnv();
  clearSchemaCache();
  await fs.rm(path.join(DOCS_DIR, "default"), { recursive: true, force: true });
  const spec = instanceSpecs.find(
    (s) => s.name === "servicenow_snapshot_instance",
  );
  const controller = new AbortController();
  await withEnv({ SN_MAX_CONCURRENT: "1" }, () =>
    withFetch(
      (url) => {
        if (new URL(url).pathname.endsWith("/sys_security_acl")) {
          controller.abort();
        }
        return instanceFetch(url);
      },
      async () => {
        const r = await runSpec(
          spec,
          { tables: ["incident"] },
          { signal: controller.signal },
        );
        assert.equal(JSON.parse(r.content[0].text).error.code, "CANCELLED");
      },
    ),
  );
  const state = await fs.readFile(
    path.join(DOCS_DIR, "default", "snapshot.json"),
    "utf8",
  );
  assert.match(state, /"sn_partial": true/);
  assert.equal((await readJson("index.json")).partial, true);
  // The profile README says so; index.json flags the entry.
  const readme = await fs.readFile(
    path.join(DOCS_DIR, "default", "index.md"),
    "utf8",
  );
  assert.match(readme, /^sn_partial: true$/m);
  assert.match(readme, /Interrupted/);
  const entry = (await readJson("index.json")).files.find(
    (e) => e.path === "default/index.md",
  );
  assert.equal(entry.partial, true);

  // Resume: finished units are not read again.
  clearSchemaCache();
  const paths = [];
  const resumed = await withFetch(
    (url) => {
      paths.push(new URL(url).pathname);
      return instanceFetch(url);
    },
    () => snapshotInstance({ tables: ["incident"], resume: true }),
  );
  assert.ok(resumed.resumed.includes("plugins"));
  assert.ok(resumed.resumed.includes("schema:incident"));
  assert.ok(!resumed.resumed.includes("roles"));
  assert.ok(!paths.some((p) => p.endsWith("/v_plugin")));
  assert.ok(paths.some((p) => p.endsWith("/sys_user_role")));
  assert.equal(resumed.changes["default/plugins.md"], "unchanged");
  assert.equal(resumed.changes["default/index.md"], "updated");
  assert.equal((await readJson("index.json")).partial, undefined);
  assert.ok((await readJson("default/schema.json")).schema.incident);

  // A complete run is not resumable: everything is read again.
  clearSchemaCache();
  const again = await withFetch(instanceFetch, () =>
    snapshotInstance({ tables: ["incident"], resume: true }),
  );
  assert.deepEqual(again.resumed, []);
});

test("resume re-runs a unit whose file changed on disk (S-7)", async () => {
  baselineEnv();
  clearSchemaCache();
  const controller = new AbortController();
  const spec = instanceSpecs.find(
    (s) => s.name === "servicenow_snapshot_instance",
  );
  await withEnv({ SN_MAX_CONCURRENT: "1" }, () =>
    withFetch(
      (url) => {
        if (new URL(url).pathname.endsWith("/sys_user_role")) {
          controller.abort();
        }
        return instanceFetch(url);
      },
      () =>
        runSpec(
          spec,
          { sections: ["plugins", "roles"] },
          { signal: controller.signal },
        ),
    ),
  );
  // Tamper with a finished unit's output.
  const f = path.join(DOCS_DIR, "default", "plugins.md");
  await fs.writeFile(
    f,
    (await fs.readFile(f, "utf8")).replace(
      /sn_source_hash: \S+/,
      "sn_source_hash: sha256:x",
    ),
  );
  const r = await withFetch(instanceFetch, () =>
    snapshotInstance({ sections: ["plugins", "roles"], resume: true }),
  );
  assert.deepEqual(r.resumed, []);
  assert.equal(r.changes["default/plugins.md"], "updated");
});
