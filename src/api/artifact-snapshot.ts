import { createHash } from "node:crypto";
import { queryTable, type SnRecord } from "./table.js";
import { resolveArtifactType } from "./artifacts.js";
import { scopeClause } from "./scripts.js";
import { snString } from "./shared.js";
import { ServiceNowError } from "../core/errors.js";
import {
  ARTIFACT_TYPES,
  type ArtifactChild,
  type ArtifactType,
  type JsonField,
} from "../core/artifacts/registry.js";
import { decodeField } from "../core/artifacts/decoders.js";
import { REDACTED } from "../core/redaction.js";

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

async function readChildren(
  t: ArtifactType,
  child: ArtifactChild,
  parents: { sys_id: string; fields: Record<string, unknown> }[],
  warnings: string[],
): Promise<Map<string, ArtifactChildRow[]>> {
  const byParent = new Map<string, ArtifactChildRow[]>();
  const parentKey = child.parentKey ?? "sys_id";
  const link = (p: { sys_id: string; fields: Record<string, unknown> }) =>
    parentKey === "sys_id" ? p.sys_id : snString(p.fields[parentKey]);
  const values = [...new Set(parents.map(link).filter((v) => IN_SAFE.test(v)))];
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
  for (const p of parents) {
    const pv = link(p);
    const mine = rows.filter(
      (r) =>
        snString(r[child.parentField]) === pv &&
        (child.alsoMatch ?? []).every(
          (m) => snString(r[m.field]) === snString(p.fields[m.parentKey]),
        ),
    );
    const out = mine
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
    byParent.set(p.sys_id, out);
  }
  return byParent;
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

  const children: Record<string, Map<string, ArtifactChildRow[]>> = {};
  for (const child of t.children) {
    if (child.parentTable && child.parentTable !== t.table) {
      warnings.push(
        `${t.type}: ${child.table} hangs off ${child.parentTable} and is not snapshotted.`,
      );
      continue;
    }
    try {
      children[child.table] = await readChildren(t, child, parents, warnings);
    } catch (e) {
      if (e instanceof ServiceNowError && e.code === "CANCELLED") throw e;
      warnings.push(
        `${t.type}: ${child.table} unavailable — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const records: ArtifactRow[] = parents.map((p) => {
    const kids: Record<string, ArtifactChildRow[]> = {};
    for (const [table, map] of Object.entries(children)) {
      kids[table] = map.get(p.sys_id) ?? [];
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
    };
  });
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
 * Diff one type between two sides: records matched by sys_id, then natural
 * key; a pair differs when its hash does, and the diff names the top-level
 * fields and counts the child changes (children matched the same way).
 */
export function diffArtifactType(
  a: ArtifactTypeSnapshot,
  b: ArtifactTypeSnapshot,
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
    out.push({
      type,
      key: l.key,
      status: "different",
      ...(fields.length ? { fields } : {}),
      ...(Object.keys(children).length ? { children } : {}),
    });
  }
  return out.sort((x, y) => x.key.localeCompare(y.key));
}
