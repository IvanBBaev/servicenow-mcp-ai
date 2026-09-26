import { promises as fs } from "node:fs";
import path from "node:path";
import type { ColumnInfo } from "./meta.js";
import { SCRIPT_TYPES } from "./scripts.js";
import { docFields, docsWriteRaw, type DocWriteStatus } from "./docs.js";
import {
  RECORD_SECTIONS,
  collectApps,
  collectAutomation,
  collectPlugins,
  collectRecordSection,
  collectSchema,
  collectTables,
  APP_SOURCES,
  type RecordSectionId,
} from "./collectors.js";
import { ServiceNowError } from "../core/errors.js";
import { mdTable } from "./shared.js";
import { activeProfile } from "../core/config.js";
import { getDocsDir, getMaxConcurrent } from "../core/settings.js";
import { trackProgress } from "../core/progress.js";

// The collectors moved to collectors.ts (E-7); re-exported for the importers
// that know them from here.
export {
  RECORD_SECTIONS,
  collectApps,
  collectAutomation,
  collectPlugins,
  collectRecordSection,
  collectSchema,
  collectTables,
  type AppRow,
  type AutomationStat,
  type CollectorContext,
  type CollectorResult,
  type PluginRow,
  type RecordSectionId,
} from "./collectors.js";

/**
 * Instance metadata snapshot (MI-6, v2 in S-7): pull the structural picture
 * of the current profile's instance into `SN_DOCS_DIR/<profile>/` — Markdown
 * for humans/LLMs plus JSON companions for machine comparison (MI-7).
 * Everything goes through the existing api/ layers, so auth, SSRF and table
 * policy apply unchanged; a failing section is a warning, not a failed call.
 *
 * E-7: the reads are the collectors of collectors.ts; this module composes
 * them into units and renders their data. Every unit runs in a pool bounded
 * at min(SN_MAX_CONCURRENT, 4) and writes its own files as it finishes;
 * `<profile>/snapshot.json` records the run (files → source hash, warnings
 * per unit). A cancelled or failed run still writes that state with
 * `sn_partial`, so index.json says `partial: true`, and `resume: true`
 * skips the units whose files still carry the recorded hash.
 */

/** Every section, in run and report order (schema units follow `tables`). */
export const SNAPSHOT_SECTIONS = [
  "tables",
  "plugins",
  "apps",
  "automation",
  ...(Object.keys(RECORD_SECTIONS) as RecordSectionId[]),
] as const;

export type SnapshotSection = (typeof SNAPSHOT_SECTIONS)[number];

export interface SnapshotOptions {
  /** Tables that get a detailed schema/<table>.md; omit for none. */
  tables?: string[];
  /** Sections to collect; default all. */
  sections?: SnapshotSection[];
  /** Skip units a previous interrupted run finished (files unchanged). */
  resume?: boolean;
}

export interface SnapshotResult {
  profile: string;
  dir: string;
  generatedAt: string;
  files: string[];
  /** Per file: `created`, `updated`, or `unchanged` (same source hash). */
  changes: Record<string, DocWriteStatus>;
  warnings: string[];
  /** With `resume`: units taken over from the interrupted run. */
  resumed?: string[];
}

const GENERATOR = "servicenow_snapshot_instance";
const STATE_FILE = "snapshot.json";
/** Rows rendered into a record section's Markdown; the JSON has them all. */
const MD_ROWS = 500;

/** Titles the snapshot wrote before the store had frontmatter (S-14). */
const LEGACY_TITLE =
  /^# (Tables|Schema|Plugins|Applications|Script automation|Instance snapshot) — /;

/** Tables/files are written under the profile dir; keep names path-safe. */
const SAFE_NAME = /^[a-z0-9_]+$/;

const capWarn = (what: string): string =>
  `${what} hit the SN_MAX_RECORDS cap — the list is partial.`;

// ---------------------------------------------------------------------------
// The snapshot run
// ---------------------------------------------------------------------------

/** One unit's recorded outcome in snapshot.json. */
interface UnitState {
  files: Record<string, string>;
  warnings: string[];
}

interface Unit {
  id: string;
  steps: number;
  run(ctx: UnitCtx): Promise<void>;
}

interface UnitCtx {
  write(
    rel: string,
    content: string,
    kind: string,
    source: unknown,
  ): Promise<void>;
  warn(...w: string[]): void;
  tick(msg: string): void;
}

/** Run `fn` over `items`, at most `limit` at a time; stop launching on error. */
async function pool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<{ error?: unknown }> {
  let next = 0;
  let failed: { error?: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (error) {
        failed ??= { error };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return failed ?? {};
}

export async function snapshotInstance(
  opts: SnapshotOptions = {},
): Promise<SnapshotResult> {
  const profile = activeProfile();
  const generatedAt = new Date().toISOString();
  const sections = new Set<string>(opts.sections ?? SNAPSHOT_SECTIONS);
  const state: Record<string, UnitState> = {};
  const changes: Record<string, DocWriteStatus> = {};
  const schema: Record<string, ColumnInfo[]> = {};

  const previous = opts.resume ? await readState(profile) : undefined;
  const resumed: string[] = [];

  const units: Unit[] = [];
  const add = (id: string, steps: number, run: Unit["run"]): void => {
    if (sections.has(id.split(":")[0]!)) units.push({ id, steps, run });
  };

  add("tables", 1, async (u) => {
    const r = await collectTables();
    // The table list is the snapshot's backbone: a failed read fails the run.
    if (r.unreadable.length > 0) throw r.errors[r.unreadable[0]!]!;
    const tables = r.data;
    await u.write(
      "tables.md",
      [
        `# Tables — profile \`${profile}\``,
        "",
        `Snapshot of \`sys_db_object\` taken ${generatedAt}. ${tables.length} tables.`,
        "",
        mdTable(
          ["Name", "Label", "Extends"],
          tables.map((t) => [t.name, t.label ?? "", t.superClass ?? ""]),
        ),
        "",
      ].join("\n"),
      "tables",
      { tables },
    );
    await u.write(
      "tables.json",
      JSON.stringify({ profile, generatedAt, tables }, null, 2),
      "tables",
      { tables },
    );
    u.tick("tables");
  });

  // Schema units follow `tables` and are not a selectable section of their
  // own: the `tables` option already opts in.
  for (const table of new Set(opts.tables ?? [])) {
    const name = table.trim().toLowerCase();
    units.push({
      id: `schema:${SAFE_NAME.test(name) ? name : table}`,
      steps: 1,
      run: async (u) => {
        if (!SAFE_NAME.test(name)) {
          u.warn(`schema: skipped invalid table name "${table}"`);
          u.tick(`schema: ${table} skipped`);
          return;
        }
        const r = await collectSchema({}, name);
        if (r.unreadable.length > 0) {
          u.warn(`schema: ${name} failed — ${r.errors[name]!.message}`);
        } else {
          const columns = r.data;
          schema[name] = columns;
          await u.write(
            `schema/${name}.md`,
            [
              `# Schema — \`${name}\``,
              "",
              `${columns.length} columns (inherited included). Snapshot ${generatedAt}.`,
              "",
              mdTable(
                [
                  "Column",
                  "Type",
                  "Label",
                  "Mandatory",
                  "Reference",
                  "Defined on",
                ],
                columns.map((c) => [
                  c.element,
                  c.type ?? "",
                  c.label ?? "",
                  c.mandatory ? "yes" : "",
                  c.reference ?? "",
                  c.sourceTable ?? "",
                ]),
              ),
              "",
            ].join("\n"),
            "schema",
            { table: name, columns },
          );
        }
        u.tick(`schema: ${name}`);
      },
    });
  }

  add("plugins", 1, async (u) => {
    const r = await collectPlugins();
    const { data } = r;
    u.warn(...r.capped.map((t) => capWarn(`plugins: ${t}`)));
    const last = r.unreadable.at(-1);
    if (last) u.warn(`plugins: unavailable — ${r.errors[last]!.message}`);
    if (data) {
      const source = { source: data.source, plugins: data.plugins };
      await u.write(
        "plugins.md",
        [
          `# Plugins — profile \`${profile}\``,
          "",
          `Source \`${data.source}\`, snapshot ${generatedAt}. ${data.plugins.length} plugins.`,
          "",
          mdTable(
            ["Id", "Name", "Active", "Version"],
            data.plugins.map((p) => [p.id, p.name, p.active, p.version]),
          ),
          "",
        ].join("\n"),
        "plugins",
        source,
      );
      await u.write(
        "plugins.json",
        JSON.stringify({ profile, generatedAt, ...source }, null, 2),
        "plugins",
        source,
      );
    }
    u.tick("plugins");
  });

  add("apps", 2, async (u) => {
    const r = await collectApps({ progress: (m) => u.tick(m) });
    const apps = r.data;
    // Source order: a table either hit the cap or could not be read.
    for (const t of APP_SOURCES) {
      if (r.capped.includes(t)) u.warn(capWarn(`apps: ${t}`));
      if (r.errors[t])
        u.warn(`apps: ${t} unavailable — ${r.errors[t].message}`);
    }
    if (Object.keys(apps).length === 0) return;
    await u.write(
      "apps.md",
      [
        `# Applications — profile \`${profile}\``,
        "",
        `Snapshot ${generatedAt}.`,
        "",
        ...Object.entries(apps).flatMap(([table, rows]) => [
          `## ${table} (${rows.length})`,
          "",
          mdTable(
            ["Name", "Scope", "Version", "Active"],
            rows.map((a) => [a.name, a.scope, a.version, a.active]),
          ),
          "",
        ]),
      ].join("\n"),
      "apps",
      { apps },
    );
    await u.write(
      "apps.json",
      JSON.stringify({ profile, generatedAt, apps }, null, 2),
      "apps",
      { apps },
    );
  });

  add("automation", Object.keys(SCRIPT_TYPES).length, async (u) => {
    const r = await collectAutomation({ progress: (m) => u.tick(m) });
    const { data } = r;
    u.warn(
      ...r.unreadable.map(
        (t) => `automation: ${t} unavailable — ${r.errors[t]!.message}`,
      ),
    );
    const rows = Object.entries(data).map(([type, s]) => [
      type,
      SCRIPT_TYPES[type]!.table,
      s ? String(s.total) : "n/a",
      s?.active == null ? "n/a" : String(s.active),
      s?.lastUpdated ?? "",
    ]);
    const automation = Object.fromEntries(
      Object.entries(data).filter(([, s]) => s),
    );
    await u.write(
      "automation.md",
      [
        `# Script automation — profile \`${profile}\``,
        "",
        `Counts via the Aggregate API, snapshot ${generatedAt}.`,
        "",
        mdTable(["Type", "Table", "Total", "Active", "Last updated"], rows),
        "",
      ].join("\n"),
      "automation",
      { rows },
    );
    await u.write(
      "automation.json",
      JSON.stringify({ profile, generatedAt, automation }, null, 2),
      "automation",
      { automation },
    );
  });

  for (const id of Object.keys(RECORD_SECTIONS) as RecordSectionId[]) {
    add(id, 1, async (u) => {
      const def = RECORD_SECTIONS[id];
      const r = await collectRecordSection({}, id);
      if (r.unreadable.length > 0) {
        u.warn(
          `${id}: ${def.table} unavailable — ${r.errors[def.table]!.message}`,
        );
        u.tick(id);
        return;
      }
      if (r.truncated) u.warn(capWarn(`${id}: ${def.table}`));
      const rows = r.data;
      const cols = Object.keys(rows[0] ?? {}).filter((c) => c !== "sys_id");
      const source = { table: def.table, records: rows };
      await u.write(
        `${id}.md`,
        [
          `# ${def.title} — profile \`${profile}\``,
          "",
          `Source \`${def.table}\`, snapshot ${generatedAt}. ${rows.length} records.`,
          "",
          ...(rows.length > MD_ROWS
            ? [`First ${MD_ROWS} rows; all of them are in ${id}.json.`, ""]
            : []),
          mdTable(
            cols,
            rows.slice(0, MD_ROWS).map((r) => cols.map((c) => r[c]!)),
          ),
          "",
        ].join("\n"),
        id,
        source,
      );
      await u.write(
        `${id}.json`,
        JSON.stringify({ profile, generatedAt, ...source }, null, 2),
        id,
        source,
      );
      u.tick(id);
    });
  }

  const progress = trackProgress(units.reduce((n, u) => n + u.steps, 0) + 1);

  /**
   * `source` is the data the file is rendered from — without the timestamp,
   * so an unchanged instance re-snapshots as `unchanged`. A hand-written
   * file in the way is reported as a warning, not overwritten.
   */
  const writeFor =
    (s: UnitState) =>
    async (
      rel: string,
      content: string,
      kind: string,
      source: unknown,
      partial?: boolean,
    ): Promise<void> => {
      const file = `${profile}/${rel}`;
      try {
        const r = await docsWriteRaw(file, content, [".md", ".json"], {
          generator: GENERATOR,
          kind,
          profile,
          generatedAt,
          source,
          legacy: LEGACY_TITLE,
          partial,
        });
        s.files[file] = r.source_hash!;
        changes[file] = r.status!;
      } catch (e) {
        if (e instanceof ServiceNowError && e.code === "DOC_GENERATED") {
          s.warnings.push(`${rel}: ${e.message}`);
          return;
        }
        throw e;
      }
    };

  const outcome = await pool(
    units,
    Math.min(getMaxConcurrent(), 4),
    async (unit) => {
      const prev = previous?.units[unit.id];
      if (prev && (await stillOnDisk(prev, unit.id, previous.schema, schema))) {
        state[unit.id] = prev;
        for (const f of Object.keys(prev.files)) changes[f] = "unchanged";
        resumed.push(unit.id);
        progress.tick(`${unit.id} (resumed)`, unit.steps);
        return;
      }
      const s: UnitState = { files: {}, warnings: [] };
      await unit.run({
        write: writeFor(s),
        warn: (...w) => s.warnings.push(...w),
        tick: (msg) => progress.tick(msg),
      });
      state[unit.id] = s;
    },
  );

  // Declaration order, not completion order: the output is deterministic.
  const done = units.filter((u) => state[u.id]).map((u) => u.id);
  const warnings = done.flatMap((id) => state[id]!.warnings);
  const files = done.flatMap((id) => Object.keys(state[id]!.files));
  const final: UnitState = { files: {}, warnings: [] };
  const write = writeFor(final);
  const partial = outcome.error !== undefined;

  if (Object.keys(schema).length > 0) {
    await write(
      "schema.json",
      JSON.stringify({ profile, generatedAt, schema }, null, 2),
      "schema",
      { schema },
    );
  }
  // The profile's README; the file list lives in the root index (S-14). An
  // interrupted run marks it `sn_partial`, which index.json surfaces.
  await write(
    "index.md",
    [
      `# Instance snapshot — profile \`${profile}\``,
      "",
      "Written by servicenow_snapshot_instance (the timestamp is in the frontmatter). " +
        "The file list is in the root index.md and index.json of the docs folder.",
      "",
      ...(partial
        ? ["**Interrupted** — re-run with `resume: true` to finish.", ""]
        : []),
      "Rows are read with this profile's credentials: domain separation and ACLs " +
        "can hide records, so every list is what this user can see.",
      "",
      warnings.length > 0
        ? ["## Warnings", "", ...warnings.map((w) => `- ${w}`), ""].join("\n")
        : "",
      "## Notes",
      "",
      "<!-- sn:manual:start -->",
      "<!-- sn:manual:end -->",
      "",
    ].join("\n"),
    "snapshot",
    { warnings, units: done },
    partial,
  );
  const units_ = Object.fromEntries(done.map((id) => [id, state[id]!]));
  await write(
    STATE_FILE,
    JSON.stringify({ profile, generatedAt, units: units_ }, null, 2),
    "snapshot",
    { units: units_ },
    partial,
  );
  if (partial) throw outcome.error;
  progress.tick("index");

  files.push(...Object.keys(final.files));
  warnings.push(...final.warnings);
  return {
    profile,
    dir: getDocsDir(),
    generatedAt,
    files,
    changes,
    warnings,
    ...(opts.resume ? { resumed } : {}),
  };
}

interface PrevState {
  units: Record<string, UnitState>;
  schema: Record<string, ColumnInfo[]>;
}

/** The recorded state of an interrupted run; undefined for a complete one. */
async function readState(profile: string): Promise<PrevState | undefined> {
  const fields = await docFields(`${profile}/${STATE_FILE}`);
  if (fields?.sn_partial !== "true") return undefined;
  const read = async (rel: string): Promise<Record<string, unknown>> => {
    try {
      return JSON.parse(
        await fs.readFile(path.join(getDocsDir(), profile, rel), "utf8"),
      ) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const units = (await read(STATE_FILE)).units;
  const schema = (await read("schema.json")).schema;
  return {
    units: (units ?? {}) as Record<string, UnitState>,
    schema: (schema ?? {}) as Record<string, ColumnInfo[]>,
  };
}

/**
 * A finished unit of the interrupted run can be skipped when every file it
 * wrote still carries the recorded source hash (and a schema unit's columns
 * are still in schema.json, which the final write needs).
 */
async function stillOnDisk(
  prev: UnitState,
  id: string,
  prevSchema: Record<string, ColumnInfo[]>,
  schema: Record<string, ColumnInfo[]>,
): Promise<boolean> {
  const table = id.startsWith("schema:") ? id.slice(7) : undefined;
  if (table && Object.keys(prev.files).length > 0 && !prevSchema[table]) {
    return false;
  }
  for (const [file, hash] of Object.entries(prev.files)) {
    if ((await docFields(file))?.sn_source_hash !== hash) return false;
  }
  if (table && prevSchema[table]) schema[table] = prevSchema[table];
  return true;
}
