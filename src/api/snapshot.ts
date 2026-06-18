import { listTables, describeTable } from "./meta.js";
import { aggregate } from "./aggregate.js";
import { queryTable } from "./table.js";
import { SCRIPT_TYPES } from "./scripts.js";
import { docsWriteRaw } from "./docs.js";
import { snString } from "./shared.js";
import { activeProfile } from "../core/config.js";
import { getDocsDir } from "../core/settings.js";

/**
 * Instance metadata snapshot (MI-6): pull the structural picture of the
 * current profile's instance into `SN_DOCS_DIR/<profile>/` — Markdown for
 * humans/LLMs plus JSON companions for machine comparison (MI-7). Everything
 * goes through the existing api/ layers (meta, aggregate, table), so auth,
 * SSRF and table policy apply unchanged; a failing section is reported as a
 * warning instead of sinking the whole snapshot.
 */

export interface SnapshotOptions {
  /** Tables that get a detailed schema/<table>.md; omit for none. */
  tables?: string[];
}

export interface SnapshotResult {
  profile: string;
  dir: string;
  generatedAt: string;
  files: string[];
  warnings: string[];
}

/** Tables/files are written under the profile dir; keep names path-safe. */
const SAFE_NAME = /^[a-z0-9_]+$/;

const mdEscape = (value: string): string => value.replaceAll("|", "\\|");

function mdTable(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(mdEscape).join(" | ")} |`),
  ].join("\n");
}

/** One aggregate bucket of the stats API, normalised defensively. */
interface StatsBucket {
  group: Record<string, string>;
  count?: number;
  maxUpdated?: string;
}

/** The stats API returns one object without group_by, an array with it. */
function parseStats(result: unknown): StatsBucket[] {
  const entries = Array.isArray(result) ? result : [result];
  const buckets: StatsBucket[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const group: Record<string, string> = {};
    if (Array.isArray(e.groupby_fields)) {
      for (const g of e.groupby_fields as Record<string, unknown>[]) {
        const field = snString(g.field);
        if (field) group[field] = snString(g.value);
      }
    }
    const stats =
      typeof e.stats === "object" && e.stats !== null
        ? (e.stats as Record<string, unknown>)
        : {};
    const max =
      typeof stats.max === "object" && stats.max !== null
        ? (stats.max as Record<string, unknown>)
        : {};
    const count = Number(snString(stats.count));
    buckets.push({
      group,
      count: Number.isFinite(count) ? count : undefined,
      maxUpdated: snString(max.sys_updated_on) || undefined,
    });
  }
  return buckets;
}

export async function snapshotInstance(
  opts: SnapshotOptions = {},
): Promise<SnapshotResult> {
  const profile = activeProfile();
  const generatedAt = new Date().toISOString();
  const files: string[] = [];
  const warnings: string[] = [];
  const write = async (rel: string, content: string): Promise<void> => {
    await docsWriteRaw(`${profile}/${rel}`, content, [".md", ".json"]);
    files.push(`${profile}/${rel}`);
  };

  // -- tables.md + tables.json ------------------------------------------------
  const tables = await listTables();
  await write(
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
  );
  await write(
    "tables.json",
    JSON.stringify({ profile, generatedAt, tables }, null, 2),
  );

  // -- schema/<table>.md for explicitly requested tables ----------------------
  const requested = [...new Set(opts.tables ?? [])];
  const schemaJson: Record<string, unknown> = {};
  for (const table of requested) {
    const name = table.trim().toLowerCase();
    if (!SAFE_NAME.test(name)) {
      warnings.push(`schema: skipped invalid table name "${table}"`);
      continue;
    }
    try {
      const columns = await describeTable(name);
      schemaJson[name] = columns;
      await write(
        `schema/${name}.md`,
        [
          `# Schema — \`${name}\``,
          "",
          `${columns.length} columns (inherited included). Snapshot ${generatedAt}.`,
          "",
          mdTable(
            ["Column", "Type", "Label", "Mandatory", "Reference", "Defined on"],
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
      );
    } catch (e) {
      warnings.push(
        `schema: ${name} failed — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (Object.keys(schemaJson).length > 0) {
    await write(
      "schema.json",
      JSON.stringify({ profile, generatedAt, schema: schemaJson }, null, 2),
    );
  }

  // -- plugins.md (v_plugin, fallback sys_plugins) -----------------------------
  let pluginRecords: Record<string, unknown>[] | undefined;
  let pluginSource = "v_plugin";
  const warnIfTruncated = (
    truncated: boolean | undefined,
    what: string,
  ): void => {
    if (truncated) {
      warnings.push(
        `${what} hit the SN_MAX_RECORDS cap — the list is partial.`,
      );
    }
  };
  try {
    const r = await queryTable({
      table: "v_plugin",
      fields: ["id", "name", "active", "version"],
      displayValue: "false",
      fetchAll: true,
    });
    pluginRecords = r.records;
    warnIfTruncated(r.truncated, "plugins: v_plugin");
  } catch {
    try {
      pluginSource = "sys_plugins";
      const r = await queryTable({
        table: "sys_plugins",
        fields: ["source", "name", "active", "version"],
        displayValue: "false",
        fetchAll: true,
      });
      pluginRecords = r.records;
      warnIfTruncated(r.truncated, "plugins: sys_plugins");
    } catch (e) {
      warnings.push(
        `plugins: unavailable — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (pluginRecords) {
    const rows = pluginRecords.map((p) => ({
      id: snString(p.id) || snString(p.source),
      name: snString(p.name),
      active: snString(p.active),
      version: snString(p.version),
    }));
    await write(
      "plugins.md",
      [
        `# Plugins — profile \`${profile}\``,
        "",
        `Source \`${pluginSource}\`, snapshot ${generatedAt}. ${rows.length} plugins.`,
        "",
        mdTable(
          ["Id", "Name", "Active", "Version"],
          rows.map((p) => [p.id, p.name, p.active, p.version]),
        ),
        "",
      ].join("\n"),
    );
    await write(
      "plugins.json",
      JSON.stringify(
        { profile, generatedAt, source: pluginSource, plugins: rows },
        null,
        2,
      ),
    );
  }

  // -- apps.md (sys_app + sys_store_app) ---------------------------------------
  const appSections: string[] = [];
  const appsJson: Record<string, unknown> = {};
  for (const table of ["sys_app", "sys_store_app"]) {
    try {
      const { records, truncated } = await queryTable({
        table,
        fields: ["name", "scope", "version", "active"],
        displayValue: "false",
        fetchAll: true,
      });
      warnIfTruncated(truncated, `apps: ${table}`);
      const rows = records.map((a) => ({
        name: snString(a.name),
        scope: snString(a.scope),
        version: snString(a.version),
        active: snString(a.active),
      }));
      appsJson[table] = rows;
      appSections.push(
        `## ${table} (${rows.length})`,
        "",
        mdTable(
          ["Name", "Scope", "Version", "Active"],
          rows.map((a) => [a.name, a.scope, a.version, a.active]),
        ),
        "",
      );
    } catch (e) {
      warnings.push(
        `apps: ${table} unavailable — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (appSections.length > 0) {
    await write(
      "apps.md",
      [
        `# Applications — profile \`${profile}\``,
        "",
        `Snapshot ${generatedAt}.`,
        "",
        ...appSections,
      ].join("\n"),
    );
    await write(
      "apps.json",
      JSON.stringify({ profile, generatedAt, apps: appsJson }, null, 2),
    );
  }

  // -- automation.md (script counts per type via Aggregate) --------------------
  const automationRows: string[][] = [];
  const automationJson: Record<string, unknown> = {};
  for (const [type, descriptor] of Object.entries(SCRIPT_TYPES)) {
    try {
      const stats = parseStats(
        await aggregate({
          table: descriptor.table,
          count: true,
          groupBy: ["active"],
          maxFields: ["sys_updated_on"],
        }),
      );
      const total = stats.reduce((sum, b) => sum + (b.count ?? 0), 0);
      const active = stats
        .filter((b) => b.group.active === "true")
        .reduce((sum, b) => sum + (b.count ?? 0), 0);
      const lastUpdated = stats
        .map((b) => b.maxUpdated ?? "")
        .reduce((a, b) => (b > a ? b : a), "");
      automationJson[type] = {
        table: descriptor.table,
        total,
        active,
        lastUpdated,
      };
      automationRows.push([
        type,
        descriptor.table,
        String(total),
        String(active),
        lastUpdated,
      ]);
    } catch (e) {
      warnings.push(
        `automation: ${type} unavailable — ${e instanceof Error ? e.message : String(e)}`,
      );
      automationRows.push([type, descriptor.table, "n/a", "n/a", ""]);
    }
  }
  await write(
    "automation.md",
    [
      `# Script automation — profile \`${profile}\``,
      "",
      `Counts via the Aggregate API, snapshot ${generatedAt}.`,
      "",
      mdTable(
        ["Type", "Table", "Total", "Active", "Last updated"],
        automationRows,
      ),
      "",
    ].join("\n"),
  );
  await write(
    "automation.json",
    JSON.stringify(
      { profile, generatedAt, automation: automationJson },
      null,
      2,
    ),
  );

  // -- index.md -----------------------------------------------------------------
  await write(
    "index.md",
    [
      `# Instance snapshot — profile \`${profile}\``,
      "",
      `Generated ${generatedAt} by servicenow_snapshot_instance.`,
      "",
      ...files
        .filter((f) => f.endsWith(".md"))
        .map((f) => {
          const rel = f.slice(profile.length + 1);
          return `- [${rel}](${rel})`;
        }),
      "",
      warnings.length > 0
        ? ["## Warnings", "", ...warnings.map((w) => `- ${w}`), ""].join("\n")
        : "",
    ].join("\n"),
  );

  return { profile, dir: getDocsDir(), generatedAt, files, warnings };
}
