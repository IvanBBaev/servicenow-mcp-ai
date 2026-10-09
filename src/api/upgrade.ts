import { ARTIFACT_TYPES } from "../core/artifacts/registry.js";
import { rethrowIfCancelled } from "../core/errors.js";
import { unreadableReason } from "./security.js";
import { mdEscape, mdTable, snString } from "./shared.js";
import { queryTable } from "./table.js";
import { unifiedDiff } from "./unified-diff.js";
import { parseUpdatePayload } from "./updatesets.js";
import { isSysId } from "../core/sys-id.js";

/**
 * N-1 (NX-01) — upgrade readiness: the upgrade history, the skipped records
 * of one upgrade, and for one skipped record the base-system version against
 * the customer version.
 *
 * - history: sys_upgrade_history rows (from / to version, dates, state),
 *   newest first;
 * - skipped: the sys_upgrade_history_log rows of one upgrade whose
 *   disposition is a skip and that are not resolved, grouped by application
 *   and artefact type (the registry, by the table in the update name);
 * - record: the sys_update_version rows of one skipped update name. The
 *   versions an upgrade wrote are the base versions; the newest is the new
 *   base, the one before it the old base. The customer version is the
 *   current version that is not a base one. Comparing the three classifies
 *   the skip: only_customer_changes (the base did not move — keeping the
 *   customer version loses nothing), only_base_changes (the customer version
 *   equals the old base — reverting to the new base is safe) or both_changed
 *   (a merge is needed); `unknown` when a version is missing.
 * - store updates (NX-21): installed sys_store_app rows with an update
 *   available, each with the customised artefacts in its scope
 *   (sys_update_xml by application, grouped by the registry type).
 *
 * Served by `servicenow_review_upgrade` (opt-in `instance` package). The
 * `document_instance` kind `upgrade` is not wired yet (tools/list, O-10).
 *
 * Read-only and bounded; never throws except on a cancel. A failed read
 * degrades to `available:false`. Table, field and choice names
 * (sys_upgrade_history_log disposition / resolution_status, how a base
 * version is marked in sys_update_version — source_table) are unverified
 * until O-5 (PDI).
 */

/** Upgrades read per history. */
export const UPGRADE_HISTORY_LIMIT = 50;
/** Log rows read per upgrade. */
export const UPGRADE_LOG_LIMIT = 5_000;
/** Versions read per update name. */
export const VERSION_LIMIT = 50;
/** Diff lines per field. */
export const DIFF_LINES = 120;

/** System fields that every version differs on; never compared. */
const VOLATILE_FIELDS = new Set([
  "sys_created_by",
  "sys_created_on",
  "sys_mod_count",
  "sys_updated_by",
  "sys_updated_on",
  "sys_update_name",
  "sys_class_name",
  "sys_package",
  "sys_policy",
  "sys_scope",
]);

/** sys_update_version.source_table of a version an upgrade wrote. */
const BASE_SOURCES = new Set(["sys_upgrade_history", "sys_store_app"]);

export interface Unavailable {
  available: false;
  unavailableReason: string;
}

export interface UpgradeRun {
  sys_id: string;
  fromVersion: string;
  toVersion: string;
  started: string;
  finished: string;
  state: string;
}

export interface UpgradeHistory {
  available: true;
  upgrades: UpgradeRun[];
  truncated: boolean;
}

export interface SkippedRow {
  sys_id: string;
  /** The update name, e.g. `sys_script_<sys_id>`. */
  updateName: string;
  /** Record table parsed from the update name ("" when not parseable). */
  table: string;
  /** Registry type of `table`; undefined when it is not registered. */
  artifactType?: string;
  name: string;
  application: string;
  disposition: string;
  resolution: string;
}

export interface SkippedGroup {
  application: string;
  artifactType: string;
  count: number;
  rows: SkippedRow[];
}

export interface SkippedReview {
  available: true;
  upgrade: string;
  /** Log rows read (all dispositions). */
  scanned: number;
  skipped: number;
  groups: SkippedGroup[];
  truncated: boolean;
}

export type SkipClass =
  | "only_customer_changes"
  | "only_base_changes"
  | "both_changed"
  | "unknown";

export interface VersionRef {
  sys_id: string;
  recordedAt: string;
  source: string;
  state: string;
}

export interface FieldDiff {
  field: string;
  /** Unified diff new base → customer. */
  diff: string;
}

export interface RecordReview {
  available: true;
  updateName: string;
  classification: SkipClass;
  reason: string;
  newBase?: VersionRef;
  oldBase?: VersionRef;
  customer?: VersionRef;
  /** Fields where the customer version differs from the new base. */
  diffs: FieldDiff[];
}

const unavailable = (reason: string): Unavailable => ({
  available: false,
  unavailableReason: reason,
});

/** Table of an update name (`sys_script_<32 hex>` → `sys_script`). */
export function tableOfUpdateName(updateName: string): string {
  const m = /^(.+)_[0-9a-f]{32}$/.exec(updateName.trim());
  return m ? m[1]! : "";
}

/** Registry type of a table (the first descriptor whose primary table it is). */
export function artifactTypeOfTable(table: string): string | undefined {
  return table
    ? ARTIFACT_TYPES.find((t) => t.table === table)?.type
    : undefined;
}

/** True for a disposition that the upgrade skipped (label or value). */
export function isSkipDisposition(disposition: string): boolean {
  return /skip/i.test(disposition);
}

/** True for a resolution that closes a skip (reviewed and decided). */
export function isResolved(resolution: string): boolean {
  return /^(resolved|reviewed[_ ]?(retained|merged|reverted)?|merged|reverted|retained)$/i.test(
    resolution.trim(),
  );
}

/** Upgrades and patches, newest first. */
export async function readUpgradeHistory({
  limit = UPGRADE_HISTORY_LIMIT,
}: { limit?: number } = {}): Promise<UpgradeHistory | Unavailable> {
  try {
    const { records, truncated } = await queryTable({
      table: "sys_upgrade_history",
      query: "ORDERBYDESCupgrade_started",
      fields: [
        "sys_id",
        "from_version",
        "to_version",
        "upgrade_started",
        "upgrade_finished",
        "state",
      ],
      displayValue: "false",
      limit,
    });
    return {
      available: true,
      upgrades: records.map((r) => ({
        sys_id: snString(r.sys_id),
        fromVersion: snString(r.from_version),
        toVersion: snString(r.to_version),
        started: snString(r.upgrade_started),
        finished: snString(r.upgrade_finished),
        state: snString(r.state),
      })),
      truncated: truncated === true || records.length >= limit,
    };
  } catch (e) {
    rethrowIfCancelled(e);
    return unavailable(unreadableReason("sys_upgrade_history", e));
  }
}

/** Group skipped rows by application, then artefact type (largest first). */
export function groupSkipped(rows: SkippedRow[]): SkippedGroup[] {
  const groups = new Map<string, SkippedGroup>();
  for (const row of rows) {
    const application = row.application || "(unknown application)";
    const artifactType = row.artifactType ?? (row.table || "(unknown)");
    const key = `${application}\u0000${artifactType}`;
    const g = groups.get(key) ?? {
      application,
      artifactType,
      count: 0,
      rows: [],
    };
    g.count++;
    g.rows.push(row);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      rows: g.rows.sort((a, b) => a.updateName.localeCompare(b.updateName)),
    }))
    .sort(
      (a, b) =>
        a.application.localeCompare(b.application) ||
        b.count - a.count ||
        a.artifactType.localeCompare(b.artifactType),
    );
}

/** The skipped, unresolved log rows of one upgrade, grouped. */
export async function readSkipped(
  upgrade: string,
  { limit = UPGRADE_LOG_LIMIT }: { limit?: number } = {},
): Promise<SkippedReview | Unavailable> {
  if (!isSysId(upgrade)) {
    return unavailable(`"${upgrade}" is not an upgrade sys_id.`);
  }
  try {
    const { records, truncated } = await queryTable({
      table: "sys_upgrade_history_log",
      query: `upgrade_history=${upgrade}^ORDERBYfile_name`,
      fields: [
        "sys_id",
        "file_name",
        "target_name",
        "application",
        "disposition",
        "resolution_status",
      ],
      // Labels: the disposition and resolution choices are matched by text.
      displayValue: "true",
      fetchAll: true,
      limit,
    });
    const rows: SkippedRow[] = [];
    for (const r of records) {
      const disposition = snString(r.disposition);
      const resolution = snString(r.resolution_status);
      if (!isSkipDisposition(disposition) || isResolved(resolution)) continue;
      const updateName = snString(r.file_name);
      const table = tableOfUpdateName(updateName);
      const artifactType = artifactTypeOfTable(table);
      rows.push({
        sys_id: snString(r.sys_id),
        updateName,
        table,
        ...(artifactType ? { artifactType } : {}),
        name: snString(r.target_name),
        application: snString(r.application),
        disposition,
        resolution,
      });
    }
    return {
      available: true,
      upgrade,
      scanned: records.length,
      skipped: rows.length,
      groups: groupSkipped(rows),
      truncated: truncated === true,
    };
  } catch (e) {
    rethrowIfCancelled(e);
    return unavailable(unreadableReason("sys_upgrade_history_log", e));
  }
}

interface Version extends VersionRef {
  base: boolean;
  fields?: Record<string, string>;
}

/** Comparable fields of a payload; undefined when it is not one flat record. */
export function payloadFields(
  payload: string,
): Record<string, string> | undefined {
  const parsed = parseUpdatePayload(payload);
  if ("reason" in parsed) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.fields)) {
    if (!VOLATILE_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

/** Fields whose values differ between two field maps (sorted). */
export function changedFields(
  a: Record<string, string>,
  b: Record<string, string>,
): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => (a[k] ?? "") !== (b[k] ?? "")).sort();
}

/**
 * Classify a skip from the three field maps. `oldBase` may be missing (the
 * record was new in this upgrade, or its history was cleaned).
 */
export function classifySkip(
  newBase: Record<string, string> | undefined,
  customer: Record<string, string> | undefined,
  oldBase: Record<string, string> | undefined,
): { classification: SkipClass; reason: string } {
  if (!newBase || !customer) {
    return {
      classification: "unknown",
      reason: !newBase
        ? "No parseable base version written by an upgrade."
        : "No parseable customer version.",
    };
  }
  if (changedFields(newBase, customer).length === 0) {
    return {
      classification: "only_base_changes",
      reason:
        "The customer version equals the new base — the skip can be resolved by taking the base.",
    };
  }
  if (!oldBase) {
    return {
      classification: "unknown",
      reason:
        "No earlier base version, so it is unclear which side changed — compare by hand.",
    };
  }
  const baseMoved = changedFields(oldBase, newBase).length > 0;
  const customerMoved = changedFields(oldBase, customer).length > 0;
  if (!baseMoved) {
    return {
      classification: "only_customer_changes",
      reason:
        "The base did not change in this upgrade — keeping the customer version loses nothing.",
    };
  }
  if (!customerMoved) {
    return {
      classification: "only_base_changes",
      reason:
        "The customer version equals the old base — reverting to the new base is safe.",
    };
  }
  return {
    classification: "both_changed",
    reason:
      "Both the base and the customer changed the record — merge the base changes into the customer version.",
  };
}

const refOf = (v: Version): VersionRef => ({
  sys_id: v.sys_id,
  recordedAt: v.recordedAt,
  source: v.source,
  state: v.state,
});

/** Base vs customer for one skipped update name. */
export async function reviewSkippedRecord(
  updateName: string,
): Promise<RecordReview | Unavailable> {
  const name = updateName.trim();
  if (!tableOfUpdateName(name)) {
    return unavailable(`"${updateName}" is not an update name.`);
  }
  let records: Record<string, unknown>[];
  try {
    ({ records } = await queryTable({
      table: "sys_update_version",
      query: `name=${name}^ORDERBYDESCsys_recorded_at`,
      fields: [
        "sys_id",
        "name",
        "state",
        "source_table",
        "source",
        "sys_recorded_at",
        "payload",
      ],
      displayValue: "false",
      limit: VERSION_LIMIT,
    }));
  } catch (e) {
    rethrowIfCancelled(e);
    return unavailable(unreadableReason("sys_update_version", e));
  }
  const versions: Version[] = records.map((r) => {
    const fields = payloadFields(snString(r.payload));
    return {
      sys_id: snString(r.sys_id),
      recordedAt: snString(r.sys_recorded_at),
      source: snString(r.source),
      state: snString(r.state),
      base: BASE_SOURCES.has(snString(r.source_table)),
      ...(fields ? { fields } : {}),
    };
  });
  // Newest first (the query order; re-sorted in case the instance ignored it).
  versions.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const bases = versions.filter((v) => v.base);
  const newBase = bases[0];
  const oldBase = bases[1];
  const customer =
    versions.find((v) => !v.base && v.state === "current") ??
    versions.find((v) => !v.base);
  const { classification, reason } = classifySkip(
    newBase?.fields,
    customer?.fields,
    oldBase?.fields,
  );
  const diffs: FieldDiff[] = [];
  if (newBase?.fields && customer?.fields) {
    for (const field of changedFields(newBase.fields, customer.fields)) {
      diffs.push({
        field,
        diff: unifiedDiff(
          newBase.fields[field] ?? "",
          customer.fields[field] ?? "",
          `base/${field}`,
          `customer/${field}`,
          DIFF_LINES,
        ),
      });
    }
  }
  return {
    available: true,
    updateName: name,
    classification,
    reason,
    ...(newBase ? { newBase: refOf(newBase) } : {}),
    ...(oldBase ? { oldBase: refOf(oldBase) } : {}),
    ...(customer ? { customer: refOf(customer) } : {}),
    diffs,
  };
}

const UNVERIFIED =
  "_Table, field and choice names are unverified until O-5 (PDI)._";

/** Markdown for the upgrade history. */
export function renderUpgradeHistory(
  h: UpgradeHistory | Unavailable,
): string[] {
  if (!h.available) return [`Unavailable: ${h.unavailableReason}`];
  if (h.upgrades.length === 0) return ["_No upgrade history._", "", UNVERIFIED];
  return [
    `${h.upgrades.length} upgrade(s)${h.truncated ? " (newest only — truncated)" : ""}.`,
    "",
    mdTable(
      ["From", "To", "Started", "Finished", "State"],
      h.upgrades.map((u) => [
        u.fromVersion,
        u.toVersion,
        u.started,
        u.finished,
        u.state,
      ]),
    ),
    "",
    UNVERIFIED,
  ];
}

/** Markdown for the skipped grouping. */
export function renderSkipped(s: SkippedReview | Unavailable): string[] {
  if (!s.available) return [`Unavailable: ${s.unavailableReason}`];
  const out = [
    `${s.skipped} unresolved skipped record(s) of ${s.scanned} log row(s)${s.truncated ? " (partial read)" : ""}.`,
    "",
  ];
  if (s.groups.length === 0) return [...out, "_None._", "", UNVERIFIED];
  out.push(
    mdTable(
      ["Application", "Artefact type", "Skipped"],
      s.groups.map((g) => [g.application, g.artifactType, String(g.count)]),
    ),
    "",
  );
  for (const g of s.groups) {
    out.push(
      `### ${mdEscape(g.application)} — ${mdEscape(g.artifactType)}`,
      "",
    );
    out.push(
      mdTable(
        ["Update name", "Name", "Disposition", "Resolution"],
        g.rows.map((r) => [
          `\`${r.updateName}\``,
          r.name,
          r.disposition,
          r.resolution,
        ]),
      ),
      "",
    );
  }
  return [...out, UNVERIFIED];
}

/** Store apps read per review. */
export const STORE_APP_LIMIT = 50;
/** Customer update rows read per store app. */
export const STORE_CUSTOMISATION_LIMIT = 500;

export interface StoreCustomisation {
  updateName: string;
  table: string;
  artifactType?: string;
  name: string;
}

export interface StoreAppUpdate {
  sys_id: string;
  name: string;
  scope: string;
  version: string;
  latestVersion: string;
  /** Distinct customised update names in the app scope, by name. */
  customisations: StoreCustomisation[] | Unavailable;
  /** Customisation count per artefact type (or table), largest first. */
  byType: { artifactType: string; count: number }[];
  truncated: boolean;
}

export interface StoreUpdates {
  available: true;
  apps: StoreAppUpdate[];
  truncated: boolean;
}

/** Customisation count per artefact type, largest first. */
function countByType(
  rows: StoreCustomisation[],
): { artifactType: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const t = r.artifactType ?? (r.table || "(unknown)");
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts]
    .map(([artifactType, count]) => ({ artifactType, count }))
    .sort(
      (a, b) =>
        b.count - a.count || a.artifactType.localeCompare(b.artifactType),
    );
}

/** The customised artefacts (sys_update_xml) in one app scope, deduplicated. */
async function readScopeCustomisations(
  app: string,
  limit: number,
): Promise<{ rows: StoreCustomisation[] | Unavailable; truncated: boolean }> {
  try {
    const { records, truncated } = await queryTable({
      table: "sys_update_xml",
      query: `application=${app}^ORDERBYname`,
      fields: ["name", "target_name"],
      displayValue: "false",
      fetchAll: true,
      limit,
    });
    const seen = new Map<string, StoreCustomisation>();
    for (const r of records) {
      const updateName = snString(r.name);
      if (!updateName || seen.has(updateName)) continue;
      const table = tableOfUpdateName(updateName);
      const artifactType = artifactTypeOfTable(table);
      seen.set(updateName, {
        updateName,
        table,
        ...(artifactType ? { artifactType } : {}),
        name: snString(r.target_name),
      });
    }
    return {
      rows: [...seen.values()],
      truncated: truncated === true || records.length >= limit,
    };
  } catch (e) {
    rethrowIfCancelled(e);
    return {
      rows: unavailable(unreadableReason("sys_update_xml", e)),
      truncated: false,
    };
  }
}

/**
 * NX-21 — installed store apps with a newer version available, and for each
 * one the customised artefacts in its scope that the update would touch.
 * sys_store_app.update_available / latest_version are unverified until O-5.
 */
export async function readStoreUpdates({
  limit = STORE_APP_LIMIT,
  customisationLimit = STORE_CUSTOMISATION_LIMIT,
}: { limit?: number; customisationLimit?: number } = {}): Promise<
  StoreUpdates | Unavailable
> {
  let records: Record<string, unknown>[];
  let truncated: boolean | undefined;
  try {
    ({ records, truncated } = await queryTable({
      table: "sys_store_app",
      query: "active=true^update_available=true^ORDERBYname",
      fields: ["sys_id", "name", "scope", "version", "latest_version"],
      displayValue: "false",
      limit,
    }));
  } catch (e) {
    rethrowIfCancelled(e);
    return unavailable(unreadableReason("sys_store_app", e));
  }
  const apps: StoreAppUpdate[] = [];
  for (const r of records) {
    const sys_id = snString(r.sys_id);
    const { rows, truncated: partial } = isSysId(sys_id)
      ? await readScopeCustomisations(sys_id, customisationLimit)
      : {
          rows: unavailable(`"${sys_id}" is not a store app sys_id.`),
          truncated: false,
        };
    apps.push({
      sys_id,
      name: snString(r.name),
      scope: snString(r.scope),
      version: snString(r.version),
      latestVersion: snString(r.latest_version),
      customisations: rows,
      byType: Array.isArray(rows) ? countByType(rows) : [],
      truncated: partial,
    });
  }
  return {
    available: true,
    apps,
    truncated: truncated === true || records.length >= limit,
  };
}

/** Markdown for the store-app updates. */
export function renderStoreUpdates(s: StoreUpdates | Unavailable): string[] {
  if (!s.available) return [`Unavailable: ${s.unavailableReason}`];
  if (s.apps.length === 0) {
    return ["_No store app has an update available._", "", UNVERIFIED];
  }
  const count = (a: StoreAppUpdate): string =>
    Array.isArray(a.customisations)
      ? `${a.customisations.length}${a.truncated ? "+" : ""}`
      : "?";
  const out = [
    `${s.apps.length} store app(s) with an update available${s.truncated ? " (first only — truncated)" : ""}.`,
    "",
    mdTable(
      ["App", "Scope", "Installed", "Available", "Customised"],
      s.apps.map((a) => [
        a.name,
        a.scope,
        a.version,
        a.latestVersion,
        count(a),
      ]),
    ),
    "",
  ];
  for (const a of s.apps) {
    out.push(`### ${mdEscape(a.name || a.sys_id)}`, "");
    if (!Array.isArray(a.customisations)) {
      out.push(`Unavailable: ${a.customisations.unavailableReason}`, "");
      continue;
    }
    if (a.customisations.length === 0) {
      out.push("_No customised artefacts — the update touches none._", "");
      continue;
    }
    out.push(
      mdTable(
        ["Artefact type", "Customised"],
        a.byType.map((t) => [t.artifactType, String(t.count)]),
      ),
      "",
      mdTable(
        ["Update name", "Name"],
        a.customisations.map((c) => [`\`${c.updateName}\``, c.name]),
      ),
      "",
    );
  }
  return [...out, UNVERIFIED];
}
