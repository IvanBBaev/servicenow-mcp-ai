import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { listTables, type TableInfo } from "./meta.js";
import { queryTable } from "./table.js";
import { SCRIPT_TYPES } from "./scripts.js";
import { docsWriteRaw } from "./docs.js";
import { snString } from "./shared.js";
import { listProfiles } from "../core/config.js";
import { runWithProfile } from "../core/request-context.js";
import { getDocsDir } from "../core/settings.js";
import { ServiceNowError } from "../core/errors.js";

/**
 * Instance comparison (MI-7): diff two connection profiles — the "dev → test
 * → prod: what drifted?" answer. Tables/plugins/apps come live or from the
 * MI-6 JSON snapshots (`from_snapshot`); script sources are always read live
 * and compared by SHA-256, so the report stays compact however large the
 * scripts are. Each side runs in its profile's AsyncLocalStorage context, so
 * every existing auth/SSRF/policy guard applies per instance.
 */

export interface CompareOptions {
  a: string;
  b: string;
  /** Prefer the stored MI-6 JSON snapshots where present (default false). */
  fromSnapshot?: boolean;
}

interface ColumnDiff {
  table: string;
  column: string;
  property: "type" | "mandatory" | "reference";
  a: string;
  b: string;
}

interface ScriptDiff {
  type: string;
  name: string;
  status: "only_in_a" | "only_in_b" | "different_source";
}

export interface CompareResult {
  a: string;
  b: string;
  report: string;
  tablesOnlyInA: string[];
  tablesOnlyInB: string[];
  columnDiffs: ColumnDiff[];
  scriptDiffs: ScriptDiff[];
  pluginDiffs: string[];
  appDiffs: string[];
  warnings: string[];
}

const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

function assertProfile(name: string): string {
  const profile = name.trim().toLowerCase();
  if (!listProfiles().includes(profile)) {
    throw new ServiceNowError(
      `Unknown connection profile "${name}". Available: ${listProfiles().join(", ") || "(none)"}.`,
      400,
    );
  }
  return profile;
}

/** Read a profile's MI-6 snapshot JSON, or undefined when absent/invalid. */
async function readSnapshotJson(
  profile: string,
  file: string,
): Promise<unknown> {
  try {
    const raw = await fs.readFile(
      path.join(getDocsDir(), profile, file),
      "utf8",
    );
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Tables for one side: the snapshot's tables.json when allowed, else live. */
async function tablesFor(
  profile: string,
  fromSnapshot: boolean,
  warnings: string[],
): Promise<TableInfo[]> {
  if (fromSnapshot) {
    const snap = (await readSnapshotJson(profile, "tables.json")) as
      | { tables?: TableInfo[] }
      | undefined;
    if (Array.isArray(snap?.tables)) return snap.tables;
    warnings.push(`tables: no snapshot for "${profile}", reading live`);
  }
  return runWithProfile(profile, () => listTables());
}

/** One sys_dictionary pull per side: table → column → comparable properties. */
type DictionaryMap = Map<string, Map<string, Record<string, string>>>;

async function dictionaryFor(
  profile: string,
  warnings: string[],
): Promise<DictionaryMap> {
  const { records, truncated } = await runWithProfile(profile, () =>
    queryTable({
      table: "sys_dictionary",
      query: "elementISNOTEMPTY",
      fields: ["name", "element", "internal_type", "mandatory", "reference"],
      displayValue: "false",
      fetchAll: true,
    }),
  );
  if (truncated) {
    warnings.push(
      `columns: sys_dictionary on "${profile}" hit the SN_MAX_RECORDS cap — the column diff is partial (raise SN_MAX_RECORDS for a complete comparison).`,
    );
  }
  const map: DictionaryMap = new Map();
  for (const r of records) {
    const table = snString(r.name);
    const column = snString(r.element);
    if (!table || !column) continue;
    let columns = map.get(table);
    if (!columns) {
      columns = new Map<string, Record<string, string>>();
      map.set(table, columns);
    }
    columns.set(column, {
      type: snString(r.internal_type),
      mandatory: snString(r.mandatory),
      reference: snString(r.reference),
    });
  }
  return map;
}

/** One pull per script type and side: name → SHA-256 of its source fields. */
async function scriptHashesFor(
  profile: string,
  warnings: string[],
): Promise<Map<string, Map<string, string>>> {
  const byType = new Map<string, Map<string, string>>();
  for (const [type, descriptor] of Object.entries(SCRIPT_TYPES)) {
    try {
      const { records, truncated } = await runWithProfile(profile, () =>
        queryTable({
          table: descriptor.table,
          fields: [descriptor.nameField, ...descriptor.scriptFields],
          displayValue: "false",
          fetchAll: true,
        }),
      );
      if (truncated) {
        warnings.push(
          `scripts: ${type} on "${profile}" hit the SN_MAX_RECORDS cap — the script diff is partial.`,
        );
      }
      const hashes = new Map<string, string>();
      for (const r of records) {
        const name = snString(r[descriptor.nameField]);
        if (!name) continue;
        hashes.set(
          name,
          sha256(descriptor.scriptFields.map((f) => snString(r[f])).join("\n")),
        );
      }
      byType.set(type, hashes);
    } catch (e) {
      warnings.push(
        `scripts: ${type} unavailable on "${profile}" — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return byType;
}

/** Plugin/app identity sets ("id name@version [inactive]") per side. */
async function inventoryFor(
  profile: string,
  fromSnapshot: boolean,
  warnings: string[],
): Promise<{ plugins: Set<string>; apps: Set<string> }> {
  const plugins = new Set<string>();
  const apps = new Set<string>();

  const pluginLine = (p: Record<string, unknown>): string =>
    `${snString(p.id) || snString(p.source)} ${snString(p.name)}@${snString(p.version)}${
      snString(p.active) === "false" ? " [inactive]" : ""
    }`;
  const appLine = (a: Record<string, unknown>): string =>
    `${snString(a.scope)} ${snString(a.name)}@${snString(a.version)}${
      snString(a.active) === "false" ? " [inactive]" : ""
    }`;

  if (fromSnapshot) {
    const pluginSnap = (await readSnapshotJson(profile, "plugins.json")) as
      | { plugins?: Record<string, unknown>[] }
      | undefined;
    const appSnap = (await readSnapshotJson(profile, "apps.json")) as
      | { apps?: Record<string, Record<string, unknown>[]> }
      | undefined;
    if (Array.isArray(pluginSnap?.plugins) && appSnap?.apps) {
      for (const p of pluginSnap.plugins) plugins.add(pluginLine(p));
      for (const rows of Object.values(appSnap.apps)) {
        for (const a of rows) apps.add(appLine(a));
      }
      return { plugins, apps };
    }
    warnings.push(`inventory: no snapshot for "${profile}", reading live`);
  }

  try {
    const { records, truncated } = await runWithProfile(profile, () =>
      queryTable({
        table: "v_plugin",
        fields: ["id", "name", "active", "version"],
        displayValue: "false",
        fetchAll: true,
      }),
    );
    if (truncated) {
      warnings.push(
        `plugins: v_plugin on "${profile}" hit the SN_MAX_RECORDS cap — the plugin diff is partial.`,
      );
    }
    for (const p of records) plugins.add(pluginLine(p));
  } catch (e) {
    warnings.push(
      `plugins: unavailable on "${profile}" — ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  for (const table of ["sys_app", "sys_store_app"]) {
    try {
      const { records, truncated } = await runWithProfile(profile, () =>
        queryTable({
          table,
          fields: ["name", "scope", "version", "active"],
          displayValue: "false",
          fetchAll: true,
        }),
      );
      if (truncated) {
        warnings.push(
          `apps: ${table} on "${profile}" hit the SN_MAX_RECORDS cap — the app diff is partial.`,
        );
      }
      for (const a of records) apps.add(appLine(a));
    } catch (e) {
      warnings.push(
        `apps: ${table} unavailable on "${profile}" — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { plugins, apps };
}

const onlyIn = (left: Set<string>, right: Set<string>): string[] =>
  [...left].filter((x) => !right.has(x)).sort();

function mdList(title: string, items: string[]): string[] {
  if (items.length === 0) return [];
  return [
    `### ${title} (${items.length})`,
    "",
    ...items.map((i) => `- ${i}`),
    "",
  ];
}

export async function compareInstances(
  opts: CompareOptions,
): Promise<CompareResult> {
  const a = assertProfile(opts.a);
  const b = assertProfile(opts.b);
  if (a === b) {
    throw new ServiceNowError("Cannot compare a profile with itself.", 400);
  }
  const fromSnapshot = opts.fromSnapshot === true;
  const warnings: string[] = [];
  const generatedAt = new Date().toISOString();

  // -- tables -------------------------------------------------------------
  const [tablesA, tablesB] = [
    await tablesFor(a, fromSnapshot, warnings),
    await tablesFor(b, fromSnapshot, warnings),
  ];
  const namesA = new Set(tablesA.map((t) => t.name));
  const namesB = new Set(tablesB.map((t) => t.name));
  const tablesOnlyInA = onlyIn(namesA, namesB);
  const tablesOnlyInB = onlyIn(namesB, namesA);

  // -- columns (one dictionary pull per side, diff over common tables) -----
  const [dictA, dictB] = [
    await dictionaryFor(a, warnings),
    await dictionaryFor(b, warnings),
  ];
  const columnDiffs: ColumnDiff[] = [];
  for (const [table, columnsA] of dictA) {
    const columnsB = dictB.get(table);
    if (!columnsB || !namesA.has(table) || !namesB.has(table)) continue;
    for (const [column, propsA] of columnsA) {
      const propsB = columnsB.get(column);
      if (!propsB) continue;
      for (const property of ["type", "mandatory", "reference"] as const) {
        if (propsA[property] !== propsB[property]) {
          columnDiffs.push({
            table,
            column,
            property,
            a: propsA[property] ?? "",
            b: propsB[property] ?? "",
          });
        }
      }
    }
  }
  columnDiffs.sort(
    (x, y) =>
      x.table.localeCompare(y.table) || x.column.localeCompare(y.column),
  );

  // -- scripts (always live; compact SHA-256 comparison) -------------------
  const [scriptsA, scriptsB] = [
    await scriptHashesFor(a, warnings),
    await scriptHashesFor(b, warnings),
  ];
  const scriptDiffs: ScriptDiff[] = [];
  for (const [type, hashesA] of scriptsA) {
    const hashesB = scriptsB.get(type);
    if (!hashesB) continue;
    for (const [name, hashA] of hashesA) {
      const hashB = hashesB.get(name);
      if (hashB === undefined) {
        scriptDiffs.push({ type, name, status: "only_in_a" });
      } else if (hashA !== hashB) {
        scriptDiffs.push({ type, name, status: "different_source" });
      }
    }
    for (const name of hashesB.keys()) {
      if (!hashesA.has(name))
        scriptDiffs.push({ type, name, status: "only_in_b" });
    }
  }
  scriptDiffs.sort(
    (x, y) => x.type.localeCompare(y.type) || x.name.localeCompare(y.name),
  );

  // -- plugins / apps -------------------------------------------------------
  const [invA, invB] = [
    await inventoryFor(a, fromSnapshot, warnings),
    await inventoryFor(b, fromSnapshot, warnings),
  ];
  const pluginDiffs = [
    ...onlyIn(invA.plugins, invB.plugins).map((p) => `only in ${a}: ${p}`),
    ...onlyIn(invB.plugins, invA.plugins).map((p) => `only in ${b}: ${p}`),
  ];
  const appDiffs = [
    ...onlyIn(invA.apps, invB.apps).map((x) => `only in ${a}: ${x}`),
    ...onlyIn(invB.apps, invA.apps).map((x) => `only in ${b}: ${x}`),
  ];

  // -- report ---------------------------------------------------------------
  const report = `_compare/${a}-vs-${b}.md`;
  await docsWriteRaw(
    report,
    [
      `# Instance comparison — \`${a}\` vs \`${b}\``,
      "",
      `Generated ${generatedAt}${fromSnapshot ? " (tables/plugins/apps from snapshots where available)" : ""}. Scripts compared live by SHA-256.`,
      "",
      "## Tables",
      "",
      ...mdList(`Only in ${a}`, tablesOnlyInA),
      ...mdList(`Only in ${b}`, tablesOnlyInB),
      "## Columns (common tables, differing properties)",
      "",
      ...(columnDiffs.length > 0
        ? [
            `| Table | Column | Property | ${a} | ${b} |`,
            "| --- | --- | --- | --- | --- |",
            ...columnDiffs.map(
              (d) =>
                `| ${d.table} | ${d.column} | ${d.property} | ${d.a} | ${d.b} |`,
            ),
            "",
          ]
        : ["No differences.", ""]),
      "## Scripts",
      "",
      ...(scriptDiffs.length > 0
        ? [
            "| Type | Name | Status |",
            "| --- | --- | --- |",
            ...scriptDiffs.map(
              (d) => `| ${d.type} | ${d.name} | ${d.status} |`,
            ),
            "",
          ]
        : ["No differences.", ""]),
      "## Plugins",
      "",
      ...(pluginDiffs.length > 0
        ? [...pluginDiffs.map((p) => `- ${p}`), ""]
        : ["No differences.", ""]),
      "## Applications",
      "",
      ...(appDiffs.length > 0
        ? [...appDiffs.map((x) => `- ${x}`), ""]
        : ["No differences.", ""]),
      ...(warnings.length > 0
        ? ["## Warnings", "", ...warnings.map((w) => `- ${w}`), ""]
        : []),
    ].join("\n"),
  );

  return {
    a,
    b,
    report,
    tablesOnlyInA,
    tablesOnlyInB,
    columnDiffs,
    scriptDiffs,
    pluginDiffs,
    appDiffs,
    warnings,
  };
}
