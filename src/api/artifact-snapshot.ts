import { createHash } from "node:crypto";
import { queryTable, type SnRecord } from "./table.js";
import { resolveArtifactType } from "./artifacts.js";
import { scopeClause } from "./scripts.js";
import { snString } from "./shared.js";
import { unifiedDiff } from "./unified-diff.js";
import { rethrowIfCancelled } from "../core/errors.js";
import {
  ARTIFACT_TYPES,
  type ArtifactChild,
  type ArtifactType,
  type JsonField,
} from "../core/artifacts/registry.js";
import { decodeField } from "../core/artifacts/decoders.js";
import {
  compositionDiff,
  isEmptyCompositionDiff,
  type CompositionDiff,
} from "../core/artifacts/uib-composition-diff.js";
import { isComposition } from "../core/artifacts/uib-composition.js";
import { REDACTED } from "../core/redaction.js";
import { isSysId } from "../core/sys-id.js";

/**
 * P-20 — registry artefacts for snapshot / compare. One collector reads every
 * record of a registry type with its direct children and normalises them so
 * two reads of an unchanged instance are byte-identical: fields that change
 * on every save (`sys_updated_on`, `sys_mod_count`, …) are dropped, JSON
 * columns are decoded and re-serialised with sorted keys, secret fields are
 * masked, and each record carries a sha256 over itself and its children.
 * Compare matches records by sys_id, then by natural key (compare.ts).
 */

/** Fields that change on every save or are not part of the artefact. */
export const VOLATILE_FIELDS: ReadonlySet<string> = new Set([
  "sys_updated_on",
  "sys_updated_by",
  "sys_mod_count",
  "sys_created_on",
  "sys_created_by",
  "sys_tags",
]);

/** Parent values per child query (an `IN` list in the URL). */
const CHILD_CHUNK = 100;

export interface ArtifactChildRow {
  sys_id: string;
  key: string;
  hash: string;
}

export interface ArtifactRow {
  sys_id: string;
  /** Natural key (the registry `keyFields`, else the name). */
  key: string;
  name: string;
  hash: string;
  fields: Record<string, unknown>;
  /** Direct children per child table, ordered by key. */
  children: Record<string, ArtifactChildRow[]>;
  /**
   * Flows only: `"published"` when the children were read under the
   * published snapshot (`master_snapshot`) rather than the draft; absent
   * otherwise. Not part of the hash. Unverified authority (O-5).
   */
  source?: "published";
  /** With `source`: the sys_hub_flow_snapshot sys_id the children came from. */
  snapshot?: string;
}

export interface ArtifactTypeSnapshot {
  type: string;
  table: string;
  verified: boolean;
  records: ArtifactRow[];
  /** The primary read hit SN_MAX_RECORDS. */
  truncated?: boolean;
  /** Children that could not be read or were skipped (nested children). */
  warnings: string[];
}

/** JSON with sorted object keys — the hash and file form. */
export function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (k) =>
        `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
    )
    .join(",")}}`;
}

/** A value with its object keys sorted, recursively (for the stored JSON). */
function sortedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortedDeep((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

const sha = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/**
 * One row as snapshotted: volatile fields dropped, secrets masked, JSON
 * fields decoded (a value that does not decode stays raw), keys sorted.
 */
export function normalizeRow(
  row: SnRecord,
  opts: { jsonFields?: readonly JsonField[]; secretFields?: readonly string[] },
): Record<string, unknown> {
  const json = new Map((opts.jsonFields ?? []).map((j) => [j.field, j]));
  const secrets = new Set(opts.secretFields ?? []);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    if (VOLATILE_FIELDS.has(key)) continue;
    const raw = snString(row[key]);
    if (secrets.has(key)) {
      out[key] = raw ? REDACTED : "";
      continue;
    }
    const j = json.get(key);
    if (j && raw) {
      const d = decodeField(j.decoder, raw);
      out[key] = d.decoded ? sortedDeep(d.value) : raw;
      continue;
    }
    out[key] = raw;
  }
  return out;
}

function keyOf(
  fields: Record<string, unknown>,
  keyFields: readonly string[],
  nameField: string | undefined,
  fallback: string,
): string {
  const parts = keyFields.map((f) => snString(fields[f])).filter(Boolean);
  if (parts.length === keyFields.length && parts.length > 0) {
    return parts.join("|");
  }
  return (nameField && snString(fields[nameField])) || fallback;
}

/** Values safe inside an encoded `IN` list (no `^` / `,`). */
const IN_SAFE = /^[^,^]+$/;

/** Table whose records carry published flow snapshots (flow, subflow). */
const FLOW_TABLE = "sys_hub_flow";

/**
 * P-20: the published-snapshot caveat. The flow's child rows are read under
 * `master_snapshot` (the sys_hub_flow_snapshot record Flow Designer publishes)
 * — the same keying `servicenow_explain_flow` uses for `draftDiffers`.
 */
export const PUBLISHED_FLOW_WARNING =
  "read from the published snapshot (sys_hub_flow_snapshot via master_snapshot); which of the published snapshot and the draft is authoritative, and the snapshot child-row keying, are unverified (O-5).";

type Parent = { sys_id: string; fields: Record<string, unknown> };

/** Children of one table grouped under one parent link value. */
type ChildGroups = (link: string, parent: Parent) => ArtifactChildRow[];

/**
 * The published snapshot of a flow parent: its `master_snapshot`, when that
 * is a sys_id other than the flow's own. Undefined for every other table.
 */
function publishedSnapshot(t: ArtifactType, p: Parent): string | undefined {
  if (t.table !== FLOW_TABLE) return undefined;
  const id = snString(p.fields.master_snapshot);
  return isSysId(id) && id !== p.sys_id ? id : undefined;
}

async function readChildren(
  t: ArtifactType,
  child: ArtifactChild,
  parents: Parent[],
  warnings: string[],
  extraLinks: readonly string[] = [],
): Promise<ChildGroups> {
  const parentKey = child.parentKey ?? "sys_id";
  const link = (p: Parent) =>
    parentKey === "sys_id" ? p.sys_id : snString(p.fields[parentKey]);
  const values = [
    ...new Set(
      [
        ...parents.map(link),
        ...(parentKey === "sys_id" ? extraLinks : []),
      ].filter((v) => IN_SAFE.test(v)),
    ),
  ];
  const rows: SnRecord[] = [];
  for (let i = 0; i < values.length; i += CHILD_CHUNK) {
    const chunk = values.slice(i, i + CHILD_CHUNK);
    const res = await queryTable({
      table: child.table,
      query: `${child.parentField}IN${chunk.join(",")}^ORDERBYsys_id`,
      displayValue: "false",
      fetchAll: true,
    });
    if (res.truncated) {
      warnings.push(
        `${t.type}: ${child.table} hit the SN_MAX_RECORDS cap — children are partial.`,
      );
    }
    rows.push(...res.records);
  }
  return (pv, p) => {
    const mine = rows.filter(
      (r) =>
        snString(r[child.parentField]) === pv &&
        (child.alsoMatch ?? []).every(
          (m) => snString(r[m.field]) === snString(p.fields[m.parentKey]),
        ),
    );
    return mine
      .map((r) => {
        const fields = normalizeRow(r, {
          jsonFields: child.jsonFields,
          secretFields: t.secretFields,
        });
        // The parent link is implied by the grouping; keep the hash free of it.
        delete fields[child.parentField];
        const sysId = snString(r.sys_id);
        return {
          sys_id: sysId,
          key: keyOf(fields, [], child.nameField ?? child.orderField, sysId),
          hash: sha(canonical(fields)),
        };
      })
      .sort(
        (a, b) =>
          a.key.localeCompare(b.key) || a.sys_id.localeCompare(b.sys_id),
      );
  };
}

/**
 * Collect one registry type (optionally one application scope): every record,
 * normalised, with its direct children. Children that hang off another child
 * (`parentTable`) are not read here and are named in `warnings`.
 */
export async function collectArtifactType(
  type: string,
  opts: { scope?: string } = {},
): Promise<ArtifactTypeSnapshot> {
  const t = resolveArtifactType(type);
  const warnings: string[] = [];
  const query = [
    ...(t.baseQuery ? [t.baseQuery] : []),
    ...(opts.scope?.trim() ? [scopeClause(t.scopeField, opts.scope)] : []),
    "ORDERBYsys_id",
  ].join("^");
  const res = await queryTable({
    table: t.table,
    query,
    displayValue: "false",
    fetchAll: true,
  });
  const parents = res.records.map((r) => ({
    sys_id: snString(r.sys_id),
    fields: normalizeRow(r, {
      jsonFields: t.jsonFields,
      secretFields: t.secretFields,
    }),
  }));

  // Flows: also read the children keyed by the published snapshot.
  const snapshots = new Map<string, string>();
  for (const p of parents) {
    const id = publishedSnapshot(t, p);
    if (id) snapshots.set(p.sys_id, id);
  }

  const children: Record<string, ChildGroups> = {};
  for (const child of t.children) {
    if (child.parentTable && child.parentTable !== t.table) {
      warnings.push(
        `${t.type}: ${child.table} hangs off ${child.parentTable} and is not snapshotted.`,
      );
      continue;
    }
    try {
      children[child.table] = await readChildren(t, child, parents, warnings, [
        ...snapshots.values(),
      ]);
    } catch (e) {
      rethrowIfCancelled(e);
      warnings.push(
        `${t.type}: ${child.table} unavailable — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  let published = 0;
  let draftFallback = 0;
  const records: ArtifactRow[] = parents.map((p) => {
    const draft = (): Record<string, ArtifactChildRow[]> =>
      Object.fromEntries(
        Object.entries(children).map(([table, group]) => [
          table,
          group(p.sys_id, p),
        ]),
      );
    let kids = draft();
    const snapshot = snapshots.get(p.sys_id);
    let source: Pick<ArtifactRow, "source" | "snapshot"> = {};
    if (snapshot) {
      const fromSnapshot = Object.fromEntries(
        Object.entries(children).map(([table, group]) => [
          table,
          group(snapshot, p),
        ]),
      );
      // Only a snapshot that has rows is taken; otherwise the draft stands.
      if (Object.values(fromSnapshot).some((rows) => rows.length > 0)) {
        kids = fromSnapshot;
        source = { source: "published", snapshot };
        published++;
      } else draftFallback++;
    }
    const { sys_id: _drop, ...body } = p.fields;
    void _drop;
    return {
      sys_id: p.sys_id,
      key: keyOf(p.fields, t.keyFields, t.nameField, p.sys_id),
      name: snString(p.fields[t.nameField]),
      hash: sha(
        canonical({
          fields: body,
          children: Object.fromEntries(
            Object.entries(kids).map(([k, v]) => [k, v.map((c) => c.hash)]),
          ),
        }),
      ),
      fields: body,
      children: kids,
      ...source,
    };
  });
  if (published > 0) {
    warnings.push(
      `${t.type}: ${published} record(s) ${PUBLISHED_FLOW_WARNING}`,
    );
  }
  if (draftFallback > 0) {
    warnings.push(
      `${t.type}: ${draftFallback} record(s) have a master_snapshot with no child rows under it; the draft definition was read (snapshot keying unverified, O-5).`,
    );
  }
  return {
    type: t.type,
    table: t.table,
    verified: t.verified,
    records,
    ...(res.truncated ? { truncated: true } : {}),
    warnings,
  };
}

/** Expand `["all"]` to every registry type and validate the rest. */
export function resolveArtifactTypes(types: readonly string[]): string[] {
  if (types.some((t) => t.trim() === "all")) {
    return ARTIFACT_TYPES.map((t) => t.type);
  }
  return [...new Set(types.map((t) => resolveArtifactType(t).type))];
}

/** A difference between two sides' records of one type. */
export interface ArtifactDiff {
  type: string;
  key: string;
  status: "only_in_a" | "only_in_b" | "different";
  /** `different`: top-level fields whose values differ. */
  fields?: string[];
  /** `different`: per child table, what changed. */
  children?: Record<
    string,
    { only_in_a: number; only_in_b: number; different: number }
  >;
  /**
   * N-31 (UX-21): `different` UI Builder macroponents — per composition
   * field (`uib-composition` decoder) that differs, the element-level diff
   * (added / removed / moved / prop or binding changed). Additive: the field
   * is still named in `fields`.
   */
  elementDiff?: Record<string, CompositionDiff>;
  /**
   * N-31: only with `raw` — per composition field in `elementDiff`, the
   * unified diff a → b of the pretty-printed JSON (the hunk the element diff
   * replaces).
   */
  rawDiff?: Record<string, string>;
}

/** N-31: a composition value as diffable text (pretty JSON). */
function compositionText(v: unknown): string {
  if (typeof v !== "string") return JSON.stringify(v ?? [], null, 2) ?? "";
  try {
    return JSON.stringify(JSON.parse(v), null, 2);
  } catch {
    return v;
  }
}

/** The registry fields of a type decoded as UIB compositions. */
function compositionFields(type: string): string[] {
  const t = ARTIFACT_TYPES.find((x) => x.type === type);
  return (t?.jsonFields ?? [])
    .filter((j) => j.decoder === "uib-composition")
    .map((j) => j.field);
}

/** A stored composition value: decoded array, or empty for no value. */
function asComposition(v: unknown): unknown[] | undefined {
  if (v === undefined || v === null || v === "") return [];
  return isComposition(v) ? v : undefined;
}

/**
 * N-31: element diffs of the differing composition fields of one record
 * pair; a side whose value did not decode to a composition is skipped.
 */
export function elementDiffs(
  type: string,
  fields: readonly string[],
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, CompositionDiff> | undefined {
  const out: Record<string, CompositionDiff> = {};
  for (const f of compositionFields(type)) {
    if (!fields.includes(f)) continue;
    const x = asComposition(a[f]);
    const y = asComposition(b[f]);
    if (!x || !y) continue;
    const d = compositionDiff(x, y);
    if (!isEmptyCompositionDiff(d)) out[f] = d;
  }
  return Object.keys(out).length ? out : undefined;
}

function pairUp<T extends { sys_id: string; key: string }>(
  left: T[],
  right: T[],
): { pairs: [T, T][]; onlyA: T[]; onlyB: T[] } {
  const pairs: [T, T][] = [];
  const restB = new Set(right);
  const bySysId = new Map(right.map((r) => [r.sys_id, r]));
  const restA: T[] = [];
  for (const l of left) {
    const r = bySysId.get(l.sys_id);
    if (r && restB.has(r)) {
      pairs.push([l, r]);
      restB.delete(r);
    } else restA.push(l);
  }
  const byKey = new Map<string, T>();
  for (const r of restB) if (!byKey.has(r.key)) byKey.set(r.key, r);
  const onlyA: T[] = [];
  for (const l of restA) {
    const r = byKey.get(l.key);
    if (r && restB.has(r)) {
      pairs.push([l, r]);
      restB.delete(r);
    } else onlyA.push(l);
  }
  return { pairs, onlyA, onlyB: [...restB] };
}

/**
 * The matched record pairs of one type whose hashes differ (the `different`
 * rows of {@link diffArtifactType}), ordered by key — for detail views such
 * as the Mermaid diff of compare_instances.
 */
export function changedArtifactPairs(
  a: ArtifactTypeSnapshot,
  b: ArtifactTypeSnapshot,
): [ArtifactRow, ArtifactRow][] {
  return pairUp(a.records, b.records)
    .pairs.filter(([l, r]) => l.hash !== r.hash)
    .sort(([x], [y]) => x.key.localeCompare(y.key));
}

/**
 * Diff one type between two sides: records matched by sys_id, then natural
 * key; a pair differs when its hash does, and the diff names the top-level
 * fields and counts the child changes (children matched the same way).
 * With `raw` (the two side labels) a changed composition also carries its
 * JSON hunk in `rawDiff` (N-31).
 */
export function diffArtifactType(
  a: ArtifactTypeSnapshot,
  b: ArtifactTypeSnapshot,
  opts: { raw?: { a: string; b: string } } = {},
): ArtifactDiff[] {
  const type = a.type;
  const { pairs, onlyA, onlyB } = pairUp(a.records, b.records);
  const out: ArtifactDiff[] = [
    ...onlyA.map((r) => ({ type, key: r.key, status: "only_in_a" as const })),
    ...onlyB.map((r) => ({ type, key: r.key, status: "only_in_b" as const })),
  ];
  for (const [l, r] of pairs) {
    if (l.hash === r.hash) continue;
    const fields = [
      ...new Set([...Object.keys(l.fields), ...Object.keys(r.fields)]),
    ]
      .filter((f) => canonical(l.fields[f]) !== canonical(r.fields[f]))
      .sort();
    const children: NonNullable<ArtifactDiff["children"]> = {};
    for (const table of new Set([
      ...Object.keys(l.children),
      ...Object.keys(r.children),
    ])) {
      const c = pairUp(l.children[table] ?? [], r.children[table] ?? []);
      const different = c.pairs.filter(([x, y]) => x.hash !== y.hash).length;
      if (c.onlyA.length || c.onlyB.length || different) {
        children[table] = {
          only_in_a: c.onlyA.length,
          only_in_b: c.onlyB.length,
          different,
        };
      }
    }
    const elementDiff = elementDiffs(type, fields, l.fields, r.fields);
    const raw = opts.raw;
    const rawDiff =
      raw && elementDiff
        ? Object.fromEntries(
            Object.keys(elementDiff).map((f) => [
              f,
              unifiedDiff(
                compositionText(l.fields[f]),
                compositionText(r.fields[f]),
                `${raw.a}/${l.key}.${f}`,
                `${raw.b}/${r.key}.${f}`,
              ),
            ]),
          )
        : undefined;
    out.push({
      type,
      key: l.key,
      status: "different",
      ...(fields.length ? { fields } : {}),
      ...(Object.keys(children).length ? { children } : {}),
      ...(elementDiff ? { elementDiff } : {}),
      ...(rawDiff ? { rawDiff } : {}),
    });
  }
  return out.sort((x, y) => x.key.localeCompare(y.key));
}
