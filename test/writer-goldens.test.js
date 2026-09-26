import test from "node:test";
import assert from "node:assert/strict";
import {
  promises as fs,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { snapshotInstance } from "../build/api/snapshot.js";
import { compareInstances } from "../build/api/compare.js";
import {
  baselineEnv,
  freshRuntime,
  withEnv,
  withFetch,
  jsonResponse,
} from "./helpers.js";

/**
 * Writer goldens (ID-28): every file the snapshot and the comparison write,
 * byte for byte, with the run timestamp masked. The E-7 collector split must
 * land with zero changes here. Regenerate deliberately with
 * `UPDATE_GOLDEN=1 npm test` (the docs-goldens convention).
 */

const DOCS_DIR = path.join(
  os.tmpdir(),
  `servicenow-mcp-writer-goldens-${process.pid}`,
);
process.env.SN_DOCS_DIR = DOCS_DIR;

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "docs",
  "writers",
);

const PROD_HOST = "prod99999.service-now.com";
const PROFILE_ENV = {
  SN_PROFILE_PROD_INSTANCE: PROD_HOST,
  SN_PROFILE_PROD_USER: "prod.user",
  SN_PROFILE_PROD_PASSWORD: "pr0d",
};

test.after(async () => {
  await fs.rm(DOCS_DIR, { recursive: true, force: true });
});

/** The run timestamp is the only volatile part of a writer's output. */
const mask = (text) =>
  text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<generatedAt>");

async function listFiles(dir, prefix = "") {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await listFiles(path.join(dir, entry.name), rel)));
    } else if (!entry.name.startsWith("write-journal.")) {
      // The write journal records every store write with its own ids.
      out.push(rel);
    }
  }
  return out.sort();
}

/** Compare (or, with UPDATE_GOLDEN=1, rewrite) one scenario's whole tree. */
async function assertTree(scenario, extra) {
  const actual = new Map();
  for (const rel of await listFiles(DOCS_DIR)) {
    actual.set(rel, mask(await fs.readFile(path.join(DOCS_DIR, rel), "utf8")));
  }
  // The pool finishes units in any order; `changes` is keyed, so sort it.
  const result = {
    ...extra,
    ...(extra.dir ? { dir: "<docsDir>" } : {}),
    ...(extra.changes
      ? { changes: Object.fromEntries(Object.entries(extra.changes).sort()) }
      : {}),
  };
  actual.set("_result.json", mask(`${JSON.stringify(result, null, 2)}\n`));
  const dir = path.join(FIXTURES, scenario);
  if (process.env.UPDATE_GOLDEN === "1") {
    await fs.rm(dir, { recursive: true, force: true });
    for (const [rel, text] of actual) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), text);
    }
    return;
  }
  assert.ok(existsSync(dir), `missing goldens for ${scenario}`);
  const expected = (await listFiles(dir)).filter((f) => !f.endsWith("/"));
  assert.deepEqual(
    [...actual.keys()].sort(),
    expected,
    `${scenario}: file set`,
  );
  for (const [rel, text] of actual) {
    assert.equal(
      text,
      readFileSync(path.join(dir, rel), "utf8"),
      `${scenario}/${rel}`,
    );
  }
}

async function fresh() {
  baselineEnv();
  freshRuntime();
  await fs.rm(DOCS_DIR, { recursive: true, force: true });
}

// --- mock instance ---------------------------------------------------------

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

function instanceFetch(url) {
  const u = new URL(url);
  const q = u.searchParams.get("sysparm_query") ?? "";
  const table = u.pathname.split("/").pop();
  if (table === "sys_db_object") {
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
  if (table === "sys_dictionary") {
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
          reference: "",
          name: "incident",
        },
      ],
    });
  }
  if (table === "v_plugin") {
    return jsonResponse(200, {
      result: [
        {
          id: "com.snc.incident",
          name: "Incident",
          active: "true",
          version: "1.0",
        },
        { id: "com.snc.cmdb", name: "CMDB", active: "false", version: "2.0" },
      ],
    });
  }
  if (table === "sys_plugins") {
    return jsonResponse(200, {
      result: [
        { source: "com.snc.x", name: "X", active: "true", version: "1" },
      ],
    });
  }
  if (table === "sys_app") {
    return jsonResponse(200, {
      result: [
        { name: "HR App", scope: "x_hr", version: "2.1", active: "true" },
        { name: "Old App", scope: "x_old", version: "0.9", active: "false" },
      ],
    });
  }
  if (table === "sys_store_app") {
    return jsonResponse(200, {
      result: [
        { name: "Store", scope: "sn_store", version: "3", active: "true" },
      ],
    });
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
  const records = RECORD_ROWS[table];
  if (records) return jsonResponse(200, { result: records });
  return jsonResponse(404, { error: { message: `unmocked: ${u.pathname}` } });
}

/** Unreadable sources, one failing script type and the SN_MAX_RECORDS cap. */
function degradedFetch(url) {
  const u = new URL(url);
  const table = u.pathname.split("/").pop();
  if (["v_plugin", "sys_store_app", "sys_security_acl"].includes(table)) {
    return jsonResponse(403, { error: { message: `no access to ${table}` } });
  }
  if (u.pathname.endsWith("/stats/sys_script_include")) {
    return jsonResponse(403, { error: { message: "stats denied" } });
  }
  return instanceFetch(url);
}

// --- snapshot --------------------------------------------------------------

test("snapshot writer golden: full run", async () => {
  await fresh();
  const r = await withFetch(instanceFetch, () =>
    snapshotInstance({ tables: ["incident"] }),
  );
  await assertTree("snapshot-full", r);
});

test("snapshot writer golden: degraded run (unreadable, capped, invalid)", async () => {
  await fresh();
  const r = await withEnv({ SN_MAX_RECORDS: "1" }, () =>
    withFetch(degradedFetch, () =>
      snapshotInstance({ tables: ["incident", "../evil"] }),
    ),
  );
  await assertTree("snapshot-degraded", r);
});

test("snapshot writer golden: both plugin sources unreadable", async () => {
  await fresh();
  const r = await withFetch(
    (url) =>
      /\/table\/(v_plugin|sys_plugins|sys_app)$/.test(new URL(url).pathname)
        ? jsonResponse(403, { error: { message: "denied" } })
        : degradedFetch(url),
    () => snapshotInstance({ sections: ["plugins", "apps", "roles"] }),
  );
  await assertTree("snapshot-noplugins", r);
});

// --- compare ---------------------------------------------------------------

/** Two instances by hostname; prod differs in tables, plugins, apps, rows. */
function twoInstanceFetch(url) {
  const u = new URL(url);
  const prod = u.hostname === PROD_HOST;
  const table = u.pathname.split("/").pop();
  if (table === "sys_db_object") {
    const tables = [
      { name: "incident", label: "Incident" },
      { name: "task", label: "Task" },
    ];
    if (!prod) tables.push({ name: "u_dev_only", label: "Dev Only" });
    return jsonResponse(200, { result: tables });
  }
  if (table === "sys_dictionary") {
    return jsonResponse(200, {
      result: [
        {
          name: "incident",
          element: "severity",
          internal_type: prod ? "string" : "integer",
          mandatory: "true",
          reference: "",
        },
      ],
    });
  }
  if (table === "sys_script") {
    return jsonResponse(200, {
      result: [
        { sys_id: "b1", name: "Common BR", script: prod ? "old();" : "new();" },
      ],
    });
  }
  if (table === "v_plugin") {
    const result = [
      { id: "com.snc.base", name: "Base", active: "true", version: "1" },
    ];
    if (!prod)
      result.push({
        id: "com.snc.dev",
        name: "Dev",
        active: "false",
        version: "2",
      });
    return jsonResponse(200, { result });
  }
  if (table === "sys_app") {
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
  if (table === "sys_store_app") {
    return prod
      ? jsonResponse(403, { error: { message: "store denied" } })
      : jsonResponse(200, { result: [] });
  }
  if (table === "sys_properties") {
    return jsonResponse(200, {
      result: [
        {
          sys_id: "p1",
          name: "glide.ui.title",
          type: "string",
          value: prod ? "Prod" : "Dev",
        },
      ],
    });
  }
  if (table === "sys_security_acl" && prod) {
    return jsonResponse(403, { error: { message: "acl denied" } });
  }
  if (RECORD_ROWS[table])
    return jsonResponse(200, { result: RECORD_ROWS[table] });
  return jsonResponse(200, { result: [] });
}

test("compare writer golden: live, with record sections", async () => {
  await fresh();
  const r = await withEnv(PROFILE_ENV, () =>
    withFetch(twoInstanceFetch, () =>
      compareInstances({
        a: "default",
        b: "prod",
        sections: ["properties", "acls"],
      }),
    ),
  );
  await assertTree("compare-live", r);
});

test("compare writer golden: capped, prod plugins unreadable", async () => {
  await fresh();
  const r = await withEnv({ ...PROFILE_ENV, SN_MAX_RECORDS: "1" }, () =>
    withFetch(
      (url) =>
        new URL(url).hostname === PROD_HOST && url.includes("/table/v_plugin")
          ? jsonResponse(403, { error: { message: "plugins denied" } })
          : twoInstanceFetch(url),
      () => compareInstances({ a: "default", b: "prod", sections: ["roles"] }),
    ),
  );
  await assertTree("compare-degraded", r);
});

test("compare writer golden: from snapshot", async () => {
  await fresh();
  const r = await withEnv(PROFILE_ENV, async () => {
    await withFetch(instanceFetch, () => snapshotInstance());
    await fs.rm(path.join(DOCS_DIR, "_compare"), {
      recursive: true,
      force: true,
    });
    return withFetch(twoInstanceFetch, () =>
      compareInstances({
        a: "default",
        b: "prod",
        fromSnapshot: true,
        sections: ["roles"],
      }),
    );
  });
  // Only the comparison is under test here; the snapshot has its own goldens.
  for (const f of await fs.readdir(DOCS_DIR)) {
    if (f !== "_compare")
      await fs.rm(path.join(DOCS_DIR, f), { recursive: true });
  }
  await assertTree("compare-snapshot", r);
});

test("writer goldens have no stray scenario folders", () => {
  if (process.env.UPDATE_GOLDEN === "1") return;
  // Scenario folders only: the S-15 document goldens sit here as flat files.
  const folders = readdirSync(FIXTURES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert.deepEqual(folders.sort(), [
    "compare-degraded",
    "compare-live",
    "compare-snapshot",
    "snapshot-degraded",
    "snapshot-full",
    "snapshot-noplugins",
  ]);
});
