// N-30 (O-5) — UX action configurations: the experience names one in its
// `actionConfigId` page property, and sys_ux_m2m_action_assignment_action_config
// adds declarative action assignments to it (the experience-restricted ones
// show only there). Both tables and their fields were checked on a PDI.
import test from "node:test";
import assert from "node:assert/strict";

import { runSpec } from "../build/mcp/define.js";
import { ALL_TOOLS } from "../build/mcp/registry.js";
import {
  readActionConfigs,
  workspaceLines,
} from "../build/api/uib-workspace.js";
import { baselineEnv, jsonResponse, withMetadataFetch } from "./helpers.js";

baselineEnv();

const id = (c) => c.repeat(32);
const EXP = id("a");
const CFG = id("c");
const OTHER = id("d");

const TABLES = {
  sys_ux_page_registry: [
    { sys_id: EXP, title: "Acme Workspace", path: "now/acme", active: "true" },
  ],
  sys_ux_page_property: [
    { sys_id: "pp1", page: EXP, name: "actionConfigId", value: CFG },
  ],
  sys_ux_action_config: [{ sys_id: CFG, name: "Acme Actions", active: "true" }],
  sys_ux_m2m_action_assignment_action_config: [
    {
      sys_id: "m1",
      action_configuration: CFG,
      action_assignment: id("1"),
      "action_assignment.action_name": "resolve",
      "action_assignment.label": "Resolve",
      "action_assignment.table": "incident",
      "action_assignment.experience_restricted": "true",
    },
    {
      sys_id: "m2",
      action_configuration: CFG,
      action_assignment: id("2"),
      "action_assignment.action_name": "export",
      "action_assignment.table": "change_request",
      "action_assignment.experience_restricted": "false",
    },
    {
      sys_id: "m3",
      action_configuration: OTHER,
      action_assignment: id("3"),
      "action_assignment.action_name": "elsewhere",
    },
  ],
};

/** A fake WorkspaceIo that ignores the filter (as an unknown field would). */
const io = (tables = TABLES, reads = []) => ({
  read: async (table) => {
    reads.push(table);
    return tables[table] ?? [];
  },
  readIn: async (table) => {
    reads.push(table);
    return tables[table] ?? [];
  },
});

test("action configs list their assignments; other configs' rows are dropped", async () => {
  const configs = await readActionConfigs(io(), [CFG, CFG, "not-an-id", 7]);
  assert.deepEqual(configs, [
    {
      sys_id: CFG,
      name: "Acme Actions",
      active: "true",
      assignments: [
        {
          sys_id: id("2"),
          action_name: "export",
          table: "change_request",
          experience_restricted: "false",
        },
        {
          sys_id: id("1"),
          action_name: "resolve",
          label: "Resolve",
          table: "incident",
          experience_restricted: "true",
        },
      ],
    },
  ]);
});

test("no actionConfigId value reads nothing", async () => {
  const reads = [];
  assert.deepEqual(await readActionConfigs(io(TABLES, reads), []), []);
  assert.deepEqual(reads, []);
});

test("an unreadable action config still lists its id", async () => {
  const configs = await readActionConfigs(
    io({ ...TABLES, sys_ux_action_config: [] }),
    [CFG],
  );
  assert.equal(configs[0].name, undefined);
  assert.equal(configs[0].assignments.length, 2);
});

test("markdown lists the action configurations", () => {
  const out = [];
  workspaceLines(
    {
      shell: null,
      actions: [],
      forms: [],
      themes: [],
      workspace: { kind: "unknown", signals: [], migration: [] },
      actionConfigs: [
        {
          sys_id: CFG,
          name: "Acme Actions",
          active: "false",
          assignments: [
            {
              sys_id: id("1"),
              label: "Resolve",
              table: "incident",
              experience_restricted: "true",
            },
          ],
        },
        { sys_id: OTHER, assignments: [] },
      ],
    },
    out,
  );
  const md = out.join("\n");
  assert.match(md, /### Action configurations/);
  assert.match(
    md,
    /- \*\*Acme Actions\*\* _\(inactive\)_: incident Resolve \(restricted\)/,
  );
  assert.match(md, new RegExp(`- \\*\\*${OTHER}\\*\\*: no assignments`));
});

const spec = ALL_TOOLS.find(
  (s) => s.name === "servicenow_explain_ui_experience",
);
const handler = (url) => {
  const m = /\/api\/now\/table\/([^/?]+)/.exec(new URL(url).pathname);
  return jsonResponse(200, { result: (m && TABLES[m[1]]) ?? [] });
};

test("explain_ui_experience returns actionConfigs from the page property", async () => {
  const res = await withMetadataFetch(handler, () =>
    runSpec(spec, { path: "now/acme" }),
  );
  assert.equal(res.isError, undefined, res.content[0].text);
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.actionConfigs.length, 1);
  assert.equal(out.actionConfigs[0].name, "Acme Actions");
  assert.deepEqual(
    out.actionConfigs[0].assignments.map((a) => a.action_name),
    ["export", "resolve"],
  );
});

test("an experience without actionConfigId has no actionConfigs key", async () => {
  const tables = { ...TABLES, sys_ux_page_property: [] };
  const res = await withMetadataFetch(
    (url) => {
      const m = /\/api\/now\/table\/([^/?]+)/.exec(new URL(url).pathname);
      return jsonResponse(200, { result: (m && tables[m[1]]) ?? [] });
    },
    () => runSpec(spec, { path: "now/acme" }),
  );
  assert.ok(!("actionConfigs" in JSON.parse(res.content[0].text)));
});

test("an unreadable assignment m2m degrades to a caveat", async () => {
  const res = await withMetadataFetch(
    (url) => {
      const m = /\/api\/now\/table\/([^/?]+)/.exec(new URL(url).pathname);
      if (m?.[1] === "sys_ux_m2m_action_assignment_action_config")
        return jsonResponse(403, { error: { message: "denied" } });
      return jsonResponse(200, { result: (m && TABLES[m[1]]) ?? [] });
    },
    () => runSpec(spec, { path: "now/acme" }),
  );
  assert.equal(res.isError, undefined, res.content[0].text);
  const out = JSON.parse(res.content[0].text);
  assert.deepEqual(out.actionConfigs[0].assignments, []);
  assert.ok(
    JSON.stringify(out).includes("sys_ux_m2m_action_assignment_action_config"),
  );
});
