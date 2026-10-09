import { createHash } from "node:crypto";
import {
  listTables,
  describeTable,
  type ColumnInfo,
  type TableInfo,
} from "./meta.js";
import { aggregate } from "./aggregate.js";
import { queryTable } from "./table.js";
import { SCRIPT_TYPES, scriptArtifact } from "./scripts.js";
import { snString } from "./shared.js";
import { rethrowIfCancelled } from "../core/errors.js";
import { anySignal } from "../core/http-util.js";
import { throwIfCancelled } from "../core/progress.js";
import { currentCall, runWithCall } from "../core/request-context.js";

/**
 * Instance collectors (E-7): each reads one slice of the instance's
 * structure and returns plain data — no file I/O, no Markdown. The snapshot
 * (MI-6/S-7), the comparison (MI-7) and the document generators (S-15)
 * compose them and do their own rendering, so every reader sees the same
 * shapes.
 *
 * A source that cannot be read (ACL, missing plugin, HTTP error) does not
 * fail the collector: it is listed in `unreadable` with its error in
 * `errors`, and the data leaves it out. A source that hit the
 * SN_MAX_RECORDS cap is listed in `capped` and sets `truncated`. Only a
 * cancelled call (code CANCELLED) throws.
 */

/** Cancellation and progress for one collector run. */
export interface CollectorContext {
  /** Aborts the reads (on top of the tool call's own signal). */
  signal?: AbortSignal;
  /** Called once per source of a multi-source collector (apps, automation). */
  progress?: (message: string) => void;
}

/** What a collector returns: data plus how complete it is. */
export interface CollectorResult<T> {
  data: T;
  /** Sources (table or script type) that could not be read; left out of data. */
  unreadable: string[];
  /** Set when at least one source hit the SN_MAX_RECORDS cap. */
  truncated?: boolean;
  /** The sources that hit the cap, in read order. */
  capped: string[];
  /** The error per failed source, in read order (a fallback's too). */
  errors: Record<string, Error>;
}

/** Record sections (S-7), read as plain configuration rows. */
export const RECORD_SECTIONS = {
  properties: {
    table: "sys_properties",
    title: "System properties",
    fields: ["sys_id", "name", "type", "value"],
    query: "ORDERBYname",
  },
  choices: {
    table: "sys_choice",
    title: "Choice lists",
    fields: ["sys_id", "name", "element", "value", "label", "sequence"],
    query:
      "inactive=false^language=en^ORDERBYname^ORDERBYelement^ORDERBYsequence",
  },
  acls: {
    table: "sys_security_acl",
    title: "ACLs",
    fields: [
      "sys_id",
      "name",
      "operation",
      "type",
      "active",
      "admin_overrides",
      "script",
    ],
    query: "ORDERBYname^ORDERBYoperation",
  },
  notifications: {
    table: "sysevent_email_action",
    title: "Notifications",
    fields: ["sys_id", "name", "collection", "event_name", "active"],
    query: "ORDERBYname",
  },
  flows: {
    table: "sys_hub_flow",
    title: "Flows",
    fields: ["sys_id", "name", "internal_name", "type", "active", "status"],
    query: "ORDERBYname",
  },
  catalog: {
    table: "sc_cat_item",
    title: "Catalog items",
    fields: ["sys_id", "name", "sys_class_name", "active"],
    query: "ORDERBYname",
  },
  roles: {
    table: "sys_user_role",
    title: "Roles",
    fields: ["sys_id", "name", "elevated_privilege"],
    query: "ORDERBYname",
  },
} as const;

export type RecordSectionId = keyof typeof RECORD_SECTIONS;

/** Property values that must not land in a document. */
const SECRET_NAME =
  /password|secret|token|credential|private[_.]?key|api[_.]?key/i;

const asError = (e: unknown): Error =>
  e instanceof Error ? e : new Error(String(e));

/** Accumulates one collector's unreadable/capped/errors bookkeeping. */
class Outcome {
  readonly unreadable: string[] = [];
  readonly capped: string[] = [];
  readonly errors: Record<string, Error> = {};

  cap(source: string, truncated: boolean | undefined): void {
    if (truncated) this.capped.push(source);
  }

  /** Record a failed read; rethrows CANCELLED. */
  fail(source: string, e: unknown, unreadable = true): void {
    rethrowIfCancelled(e);
    this.errors[source] = asError(e);
    if (unreadable) this.unreadable.push(source);
  }

  result<T>(data: T): CollectorResult<T> {
    return {
      data,
      unreadable: this.unreadable,
      ...(this.capped.length > 0 ? { truncated: true } : {}),
      capped: this.capped,
      errors: this.errors,
    };
  }
}

/**
 * Run `fn` with `ctx.signal` joined to the tool call's signal, so reads that
 * take no signal parameter (listTables, describeTable, aggregate) honour it
 * too. Without a signal the call context is left untouched.
 */
function within<T>(ctx: CollectorContext, fn: () => Promise<T>): Promise<T> {
  if (!ctx.signal) return fn();
  const call = currentCall();
  return runWithCall(
    {
      ...(call ?? { requestId: "collector", tool: "collector" }),
      signal: anySignal([call?.signal, ctx.signal]),
    },
    fn,
  );
}

// ---------------------------------------------------------------------------
// Tables and schema
// ---------------------------------------------------------------------------

/** Every table in sys_db_object (name, label, super class). */
export function collectTables(
  ctx: CollectorContext = {},
): Promise<CollectorResult<TableInfo[]>> {
  return within(ctx, async () => {
    const out = new Outcome();
    throwIfCancelled();
    try {
      return out.result(await listTables());
    } catch (e) {
      out.fail("sys_db_object", e);
      return out.result<TableInfo[]>([]);
    }
  });
}

/** The columns of one table, inherited included; unreadable → no columns. */
export function collectSchema(
  ctx: CollectorContext,
  table: string,
): Promise<CollectorResult<ColumnInfo[]>> {
  return within(ctx, async () => {
    const out = new Outcome();
    throwIfCancelled();
    try {
      return out.result(await describeTable(table));
    } catch (e) {
      out.fail(table, e);
      return out.result<ColumnInfo[]>([]);
    }
  });
}

// ---------------------------------------------------------------------------
// Plugins and applications
// ---------------------------------------------------------------------------

export interface PluginRow {
  id: string;
  name: string;
  active: string;
  version: string;
}

/** Plugin sources in fallback order, with the field that holds the id. */
const PLUGIN_ID_FIELD = { v_plugin: "id", sys_plugins: "source" } as const;
export type PluginSource = keyof typeof PLUGIN_ID_FIELD;
export const PLUGIN_SOURCES: readonly PluginSource[] = [
  "v_plugin",
  "sys_plugins",
];

/**
 * Plugins from the first readable source (v_plugin, then sys_plugins).
 * `data` is undefined when none could be read; only then are the sources
 * `unreadable` (a failed source before a working fallback is only in
 * `errors`).
 */
export function collectPlugins(
  ctx: CollectorContext = {},
  sources: readonly PluginSource[] = PLUGIN_SOURCES,
): Promise<
  CollectorResult<{ source: PluginSource; plugins: PluginRow[] } | undefined>
> {
  return within(ctx, async () => {
    const out = new Outcome();
    for (const table of sources) {
      throwIfCancelled();
      const idField = PLUGIN_ID_FIELD[table];
      try {
        const r = await queryTable({
          table,
          fields: [idField, "name", "active", "version"],
          displayValue: "false",
          fetchAll: true,
        });
        out.cap(table, r.truncated);
        const plugins = r.records.map((p) => ({
          id: snString(p[idField]),
          name: snString(p.name),
          active: snString(p.active),
          version: snString(p.version),
        }));
        return out.result({ source: table, plugins });
      } catch (e) {
        out.fail(table, e, false);
      }
    }
    out.unreadable.push(...sources);
    return out.result(undefined);
  });
}

export interface AppRow {
  name: string;
  scope: string;
  version: string;
  active: string;
}

/** The application tables read by collectApps, in order. */
export const APP_SOURCES = ["sys_app", "sys_store_app"] as const;

/** Rows of sys_app and sys_store_app, keyed by table; an unreadable one is absent. */
export function collectApps(
  ctx: CollectorContext = {},
): Promise<CollectorResult<Record<string, AppRow[]>>> {
  return within(ctx, async () => {
    const out = new Outcome();
    const apps: Record<string, AppRow[]> = {};
    for (const table of APP_SOURCES) {
      throwIfCancelled();
      try {
        const { records, truncated } = await queryTable({
          table,
          fields: ["name", "scope", "version", "active"],
          displayValue: "false",
          fetchAll: true,
        });
        out.cap(table, truncated);
        apps[table] = records.map((a) => ({
          name: snString(a.name),
          scope: snString(a.scope),
          version: snString(a.version),
          active: snString(a.active),
        }));
      } catch (e) {
        out.fail(table, e);
      }
      ctx.progress?.(`apps: ${table}`);
    }
    return out.result(apps);
  });
}

// ---------------------------------------------------------------------------
// Script automation
// ---------------------------------------------------------------------------

export interface AutomationStat {
  table: string;
  total: number;
  active: number | null;
  lastUpdated: string;
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

/**
 * Script counts per registry type via the Aggregate API (total, active,
 * last update). An unreadable type maps to null.
 */
export function collectAutomation(
  ctx: CollectorContext = {},
  types: typeof SCRIPT_TYPES = SCRIPT_TYPES,
): Promise<CollectorResult<Record<string, AutomationStat | null>>> {
  return within(ctx, async () => {
    const out = new Outcome();
    const stats: Record<string, AutomationStat | null> = {};
    for (const [type, descriptor] of Object.entries(types)) {
      throwIfCancelled();
      // S-4: the registry supplies the active flag (some types have none) and
      // a base query narrowing a shared table to the rows that carry script.
      const { activeField, baseQuery } = scriptArtifact(type);
      try {
        const buckets = parseStats(
          await aggregate({
            table: descriptor.table,
            ...(baseQuery ? { query: baseQuery } : {}),
            count: true,
            ...(activeField ? { groupBy: [activeField] } : {}),
            maxFields: ["sys_updated_on"],
          }),
        );
        const sum = (bs: StatsBucket[]): number =>
          bs.reduce((n, b) => n + (b.count ?? 0), 0);
        stats[type] = {
          table: descriptor.table,
          total: sum(buckets),
          active: activeField
            ? sum(buckets.filter((b) => b.group[activeField] === "true"))
            : null,
          lastUpdated: buckets
            .map((b) => b.maxUpdated ?? "")
            .reduce((a, b) => (b > a ? b : a), ""),
        };
      } catch (e) {
        out.fail(type, e);
        stats[type] = null;
      }
      ctx.progress?.(`automation: ${type}`);
    }
    return out.result(stats);
  });
}

// ---------------------------------------------------------------------------
// Record sections
// ---------------------------------------------------------------------------

const shortHash = (text: string): string =>
  text ? createHash("sha256").update(text).digest("hex").slice(0, 16) : "";

/**
 * The rows of one record section as flat strings. Secret-looking property
 * values are replaced by `[redacted]`; an ACL script is reduced to a short
 * `script_hash`, so a diff sees a change without the code in the document.
 * An unreadable table gives no rows and is listed in `unreadable`.
 */
export function collectRecordSection(
  ctx: CollectorContext,
  id: RecordSectionId,
): Promise<CollectorResult<Record<string, string>[]>> {
  return within(ctx, async () => {
    const out = new Outcome();
    const def = RECORD_SECTIONS[id];
    throwIfCancelled();
    try {
      const { records, truncated } = await queryTable({
        table: def.table,
        query: def.query,
        fields: [...def.fields],
        displayValue: "false",
        fetchAll: true,
      });
      out.cap(def.table, truncated);
      const rows = records.map((r) => {
        const row: Record<string, string> = {};
        for (const f of def.fields) row[f] = snString(r[f]);
        if (
          id === "properties" &&
          (/^password/i.test(row.type!) || SECRET_NAME.test(row.name!))
        ) {
          row.value = "[redacted]";
        }
        if (id === "acls") {
          row.script_hash = shortHash(row.script!);
          delete row.script;
        }
        return row;
      });
      return out.result(rows);
    } catch (e) {
      out.fail(def.table, e);
      return out.result<Record<string, string>[]>([]);
    }
  });
}
