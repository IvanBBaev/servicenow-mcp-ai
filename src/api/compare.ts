import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { TableInfo } from "./meta.js";
import { queryTable } from "./table.js";
import { SCRIPT_TYPES, scriptArtifact } from "./scripts.js";
import { docsWriteRaw } from "./docs.js";
import {
  APP_SOURCES,
  RECORD_SECTIONS,
  collectApps,
  collectPlugins,
  collectRecordSection,
  collectTables,
  type RecordSectionId,
} from "./collectors.js";
import { unifiedDiff } from "./unified-diff.js";
import { snString, mdTable } from "./shared.js";
import { listProfiles } from "../core/config.js";
import { runWithProfile } from "../core/request-context.js";
import { getDocsDir } from "../core/settings.js";
import { ServiceNowError } from "../core/errors.js";
import { trackProgress } from "../core/progress.js";

/**
 * Instance comparison (MI-7): diff two connection profiles — the "dev → test
 * → prod: what drifted?" answer. Tables/plugins/apps come live or from the
 * MI-6 JSON snapshots (`from_snapshot`); script sources are always read live
 * and compared by SHA-256, so the report stays compact however large the
 * scripts are. Each side runs in its profile's AsyncLocalStorage context, so
 * every existing auth/SSRF/policy guard applies per instance.
 *
 * S-7: scripts are matched by sys_id first, then by name (a sys_id match
 * under another name is `renamed`), and a changed script carries a unified
 * diff. `sections` adds the snapshot's record sections (properties, ACLs,
 * roles, …) matched the same way.
 *
 * M-3: each side of each dimension is one progress step (9 with the report);
 * a step is also the cancellation checkpoint, so a cancelled comparison
 * stops instead of turning the aborted reads into "unavailable" warnings.
 */

export interface CompareOptions {
  a: string;
  b: string;
  /** Prefer the stored MI-6 JSON snapshots where present (default false). */
  fromSnapshot?: boolean;
  /** Record sections to compare as well (S-7); default none. */
  sections?: RecordSectionId[];
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
  status: "only_in_a" | "only_in_b" | "different_source" | "renamed";
  /** `renamed`: the name on side b. */
  nameB?: string;
  /** Unified diff a → b of a changed source (the first MAX_DIFFS only). */
  diff?: string;
}

/** A record of a compared section that differs (S-7 `sections`). */
interface RecordDiff {
  section: string;
  key: string;
  status: "only_in_a" | "only_in_b" | "different";
  /** `different`: the fields whose values differ. */
  fields?: string[];
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
  /** Only with `sections`. */
  recordDiffs?: RecordDiff[];
  warnings: string[];
  /**
   * Standing limits of the comparison (H-8 C-11): domain separation and ACL
   * visibility. Informational — never counted as drift (see driftCount).
   */
  caveats: string[];
}

/**
 * What a drift report cannot see (H-8 C-11). Every read runs as each
 * profile's user, so domain separation, ACLs and scoped-app access shape both
 * sides — a "difference" can be a visibility difference.
 */
export const COMPARE_CAVEATS: readonly string[] = [
  "Domain separation: on a domain-separated instance each profile sees only the records of its user's domain (and its visible parents). Domain-specific overrides of scripts and dictionary entries can therefore show up as — or hide — drift. Compare with users in the same domain (or global) for a like-for-like result.",
  "Visibility: every read runs as the profile's user. ACLs, before-query rules and roles that differ between the two users make records appear 'only in' one side; use equivalent (ideally admin) read access on both instances.",
  "Matching: scripts and records are matched by sys_id, then by name across all application scopes; two artefacts with the same name in different scopes (and different sys_ids) are compared as one.",
];

/** Scripts whose unified diff is kept; the rest are listed without one. */
const MAX_DIFFS = 50;

const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

export function assertProfile(name: string): string {
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
export async function readSnapshotJson(
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
  const r = await runWithProfile(profile, () => collectTables());
  if (r.unreadable.length > 0) throw r.errors[r.unreadable[0]!]!;
  return r.data;
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

/** One script as compared: identity plus its source text. */
interface ScriptRec {
  sysId: string;
  name: string;
  text: string;
}

/** One pull per script type and side. */
async function scriptsFor(
  profile: string,
  warnings: string[],
): Promise<Map<string, ScriptRec[]>> {
  const byType = new Map<string, ScriptRec[]>();
  for (const [type, descriptor] of Object.entries(SCRIPT_TYPES)) {
    const { baseQuery } = scriptArtifact(type);
    const multi = descriptor.scriptFields.length > 1;
    try {
      const { records, truncated } = await runWithProfile(profile, () =>
        queryTable({
          table: descriptor.table,
          ...(baseQuery ? { query: baseQuery } : {}),
          fields: ["sys_id", descriptor.nameField, ...descriptor.scriptFields],
          displayValue: "false",
          fetchAll: true,
        }),
      );
      if (truncated) {
        warnings.push(
          `scripts: ${type} on "${profile}" hit the SN_MAX_RECORDS cap — the script diff is partial.`,
        );
      }
      const recs: ScriptRec[] = [];
      for (const r of records) {
        const name = snString(r[descriptor.nameField]);
        if (!name) continue;
        const text = descriptor.scriptFields
          .map((f) =>
            multi ? `/* ${f} */\n${snString(r[f])}` : snString(r[f]),
          )
          .join("\n");
        recs.push({ sysId: snString(r.sys_id), name, text });
      }
      byType.set(type, recs);
    } catch (e) {
      rethrowCancel(e);
      warnings.push(
        `scripts: ${type} unavailable on "${profile}" — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return byType;
}

/**
 * Pair the items of two sides: by sys_id first, then by key among the rest.
 * Returns the pairs and the unmatched items of each side.
 */
export function matchBySysId<T extends { sysId: string }>(
  left: T[],
  right: T[],
  key: (item: T) => string,
): { pairs: [T, T][]; onlyA: T[]; onlyB: T[] } {
  const pairs: [T, T][] = [];
  const restB = new Set(right);
  const bySysId = new Map(
    right.filter((r) => r.sysId).map((r) => [r.sysId, r]),
  );
  const restA: T[] = [];
  for (const l of left) {
    const r = l.sysId ? bySysId.get(l.sysId) : undefined;
    if (r && restB.has(r)) {
      pairs.push([l, r]);
      restB.delete(r);
    } else restA.push(l);
  }
  const byKey = new Map<string, T>();
  for (const r of restB) if (!byKey.has(key(r))) byKey.set(key(r), r);
  const onlyA: T[] = [];
  for (const l of restA) {
    const r = byKey.get(key(l));
    if (r && restB.has(r)) {
      pairs.push([l, r]);
      restB.delete(r);
    } else onlyA.push(l);
  }
  return { pairs, onlyA, onlyB: [...restB] };
}

/** A cancelled call must stop, not become an "unavailable" warning. */
function rethrowCancel(e: unknown): void {
  if (e instanceof ServiceNowError && e.code === "CANCELLED") throw e;
}

/** The match key of a record section row (choices: name.element=value). */
function recordKey(section: string, row: Record<string, string>): string {
  if (section === "choices") return `${row.name}.${row.element}=${row.value}`;
  if (section === "acls") return `${row.name} ${row.operation}`;
  return row.name ?? "";
}

/** One side of a record section: the snapshot JSON when allowed, else live. */
async function recordsFor(
  profile: string,
  section: RecordSectionId,
  fromSnapshot: boolean,
  warnings: string[],
): Promise<Record<string, string>[] | undefined> {
  if (fromSnapshot) {
    const snap = (await readSnapshotJson(profile, `${section}.json`)) as
      | { records?: Record<string, string>[] }
      | undefined;
    if (Array.isArray(snap?.records)) return snap.records;
    warnings.push(`${section}: no snapshot for "${profile}", reading live`);
  }
  const { table } = RECORD_SECTIONS[section];
  const r = await runWithProfile(profile, () =>
    collectRecordSection({}, section),
  );
  if (r.unreadable.length > 0) {
    warnings.push(
      `${section}: ${table} unavailable on "${profile}" — ${r.errors[table]!.message}`,
    );
    return undefined;
  }
  if (r.truncated) {
    warnings.push(
      `${section}: ${table} hit the SN_MAX_RECORDS cap — the list is partial. (${profile})`,
    );
  }
  return r.data;
}

function diffRecords(
  section: string,
  rowsA: Record<string, string>[],
  rowsB: Record<string, string>[],
): RecordDiff[] {
  const wrap = (rows: Record<string, string>[]) =>
    rows.map((row) => ({ sysId: row.sys_id ?? "", row }));
  const k = (x: { row: Record<string, string> }): string =>
    recordKey(section, x.row);
  const { pairs, onlyA, onlyB } = matchBySysId(wrap(rowsA), wrap(rowsB), k);
  const out: RecordDiff[] = [
    ...onlyA.map((x) => ({ section, key: k(x), status: "only_in_a" as const })),
    ...onlyB.map((x) => ({ section, key: k(x), status: "only_in_b" as const })),
  ];
  for (const [l, r] of pairs) {
    const fields = [...new Set([...Object.keys(l.row), ...Object.keys(r.row)])]
      .filter((f) => f !== "sys_id" && (l.row[f] ?? "") !== (r.row[f] ?? ""))
      .sort();
    if (fields.length > 0) {
      out.push({ section, key: k(l), status: "different", fields });
    }
  }
  return out.sort((x, y) => x.key.localeCompare(y.key));
}

/** Plugin/app identity sets ("id name@version [inactive]") per side. */
async function inventoryFor(
  profile: string,
  fromSnapshot: boolean,
  warnings: string[],
): Promise<{ plugins: Set<string>; apps: Set<string> }> {
  const plugins = new Set<string>();
  const apps = new Set<string>();

  type Row = Partial<Record<string, unknown>>;
  const pluginLine = (p: Row): string =>
    `${snString(p.id) || snString(p.source)} ${snString(p.name)}@${snString(p.version)}${
      snString(p.active) === "false" ? " [inactive]" : ""
    }`;
  const appLine = (a: Row): string =>
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

  // Live: v_plugin only (no sys_plugins fallback), as before E-7.
  const p = await runWithProfile(profile, () =>
    collectPlugins({}, ["v_plugin"]),
  );
  if (p.truncated) {
    warnings.push(
      `plugins: v_plugin on "${profile}" hit the SN_MAX_RECORDS cap — the plugin diff is partial.`,
    );
  }
  if (p.data)
    for (const row of p.data.plugins) plugins.add(pluginLine({ ...row }));
  else {
    warnings.push(
      `plugins: unavailable on "${profile}" — ${p.errors.v_plugin!.message}`,
    );
  }
  const a = await runWithProfile(profile, () => collectApps());
  for (const table of APP_SOURCES) {
    if (a.capped.includes(table)) {
      warnings.push(
        `apps: ${table} on "${profile}" hit the SN_MAX_RECORDS cap — the app diff is partial.`,
      );
    }
    const e = a.errors[table];
    if (e)
      warnings.push(
        `apps: ${table} unavailable on "${profile}" — ${e.message}`,
      );
    for (const row of a.data[table] ?? []) apps.add(appLine({ ...row }));
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
  const sections = [...new Set(opts.sections ?? [])];
  const progress = trackProgress(9 + 2 * sections.length);
  /** Run one side of one dimension as a progress step. */
  const step = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const value = await fn();
    progress.tick(label);
    return value;
  };

  // -- tables -------------------------------------------------------------
  const [tablesA, tablesB] = [
    await step(`tables: ${a}`, () => tablesFor(a, fromSnapshot, warnings)),
    await step(`tables: ${b}`, () => tablesFor(b, fromSnapshot, warnings)),
  ];
  const namesA = new Set(tablesA.map((t) => t.name));
  const namesB = new Set(tablesB.map((t) => t.name));
  const tablesOnlyInA = onlyIn(namesA, namesB);
  const tablesOnlyInB = onlyIn(namesB, namesA);

  // -- columns (one dictionary pull per side, diff over common tables) -----
  const [dictA, dictB] = [
    await step(`columns: ${a}`, () => dictionaryFor(a, warnings)),
    await step(`columns: ${b}`, () => dictionaryFor(b, warnings)),
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

  // -- scripts (always live; sys_id first, then name) ---------------------
  const [scriptsA, scriptsB] = [
    await step(`scripts: ${a}`, () => scriptsFor(a, warnings)),
    await step(`scripts: ${b}`, () => scriptsFor(b, warnings)),
  ];
  const scriptDiffs: ScriptDiff[] = [];
  let diffs = 0;
  for (const [type, recsA] of scriptsA) {
    const recsB = scriptsB.get(type);
    if (!recsB) continue;
    const { pairs, onlyA, onlyB } = matchBySysId(recsA, recsB, (r) => r.name);
    for (const r of onlyA) {
      scriptDiffs.push({ type, name: r.name, status: "only_in_a" });
    }
    for (const r of onlyB) {
      scriptDiffs.push({ type, name: r.name, status: "only_in_b" });
    }
    for (const [x, y] of pairs) {
      const renamed = x.name !== y.name;
      const changed = sha256(x.text) !== sha256(y.text);
      if (!renamed && !changed) continue;
      scriptDiffs.push({
        type,
        name: x.name,
        status: renamed ? "renamed" : "different_source",
        ...(renamed ? { nameB: y.name } : {}),
        ...(changed && diffs++ < MAX_DIFFS
          ? {
              diff: unifiedDiff(
                x.text,
                y.text,
                `${a}/${x.name}`,
                `${b}/${y.name}`,
              ),
            }
          : {}),
      });
    }
  }
  scriptDiffs.sort(
    (x, y) => x.type.localeCompare(y.type) || x.name.localeCompare(y.name),
  );

  // -- record sections (opt-in) --------------------------------------------
  const recordDiffs: RecordDiff[] = [];
  for (const section of sections) {
    const rowsA = await step(`${section}: ${a}`, () =>
      recordsFor(a, section, fromSnapshot, warnings),
    );
    const rowsB = await step(`${section}: ${b}`, () =>
      recordsFor(b, section, fromSnapshot, warnings),
    );
    if (rowsA && rowsB) recordDiffs.push(...diffRecords(section, rowsA, rowsB));
  }

  // -- plugins / apps -------------------------------------------------------
  const [invA, invB] = [
    await step(`inventory: ${a}`, () =>
      inventoryFor(a, fromSnapshot, warnings),
    ),
    await step(`inventory: ${b}`, () =>
      inventoryFor(b, fromSnapshot, warnings),
    ),
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
      `Generated ${generatedAt}${fromSnapshot ? " (tables/plugins/apps from snapshots where available)" : ""}. Scripts compared live, matched by sys_id then name.`,
      "",
      "## Tables",
      "",
      ...mdList(`Only in ${a}`, tablesOnlyInA),
      ...mdList(`Only in ${b}`, tablesOnlyInB),
      "## Columns (common tables, differing properties)",
      "",
      ...(columnDiffs.length > 0
        ? [
            mdTable(
              ["Table", "Column", "Property", a, b],
              columnDiffs.map((d) => [d.table, d.column, d.property, d.a, d.b]),
            ),
            "",
          ]
        : ["No differences.", ""]),
      "## Scripts",
      "",
      ...(scriptDiffs.length > 0
        ? [
            mdTable(
              ["Type", "Name", "Status"],
              scriptDiffs.map((d) => [
                d.type,
                d.nameB ? `${d.name} → ${d.nameB}` : d.name,
                d.status,
              ]),
            ),
            "",
            ...scriptDiffs
              .filter((d) => d.diff)
              .flatMap((d) => [
                `### ${d.type}: ${d.name}`,
                "",
                "```diff",
                d.diff!.replace(/```/g, "` ` `"),
                "```",
                "",
              ]),
          ]
        : ["No differences.", ""]),
      ...(sections.length > 0
        ? [
            `## Records (${sections.join(", ")})`,
            "",
            ...(recordDiffs.length > 0
              ? [
                  mdTable(
                    ["Section", "Key", "Status", "Fields"],
                    recordDiffs.map((d) => [
                      d.section,
                      d.key,
                      d.status,
                      d.fields?.join(", ") ?? "",
                    ]),
                  ),
                  "",
                ]
              : ["No differences.", ""]),
          ]
        : []),
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
      "## Caveats",
      "",
      ...COMPARE_CAVEATS.map((c) => `- ${c}`),
      "",
    ].join("\n"),
    [".md"],
    {
      generator: "servicenow_compare_instances",
      kind: "compare",
      // Filed under the first profile; the report covers both.
      profile: a,
      generatedAt,
      source: {
        a,
        b,
        fromSnapshot,
        tablesOnlyInA,
        tablesOnlyInB,
        columnDiffs,
        scriptDiffs,
        pluginDiffs,
        appDiffs,
        ...(sections.length > 0 ? { sections, recordDiffs } : {}),
        warnings,
      },
      legacy: /^# Instance comparison — /,
    },
  );
  progress.tick("report");

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
    ...(sections.length > 0 ? { recordDiffs } : {}),
    warnings,
    caveats: [...COMPARE_CAVEATS],
  };
}

/** DF-3 — total number of differences across every dimension of a comparison. */
export function driftCount(result: CompareResult): number {
  return (
    result.tablesOnlyInA.length +
    result.tablesOnlyInB.length +
    result.columnDiffs.length +
    result.scriptDiffs.length +
    result.pluginDiffs.length +
    result.appDiffs.length +
    (result.recordDiffs?.length ?? 0)
  );
}
