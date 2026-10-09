/**
 * P-17 — outbound dependency edges, from the descriptor alone: registry
 * `refFields`, decoded JSON fields, script text (S-9 extractors) and the N-28
 * UI Builder composition / broker / import edges. Import from dependencies.ts.
 */

import type {
  ArtifactChild,
  ArtifactType,
  JsonField,
  RefField,
} from "../core/artifacts/registry.js";
import { decodeField } from "../core/artifacts/decoders.js";
import type { ArtifactChildResult } from "./artifacts.js";
import {
  ajaxScriptNames,
  scriptIdentifiers,
  scriptTables,
} from "./references.js";
import {
  brokerTable,
  macroponentUses,
  uibImports,
  uibIncludeIds,
} from "./uib-usage.js";
import { snString } from "./shared.js";
import type { SnRecord } from "./table.js";
import { isSysId } from "../core/sys-id.js";
import {
  type NodeSpec,
  NOT_A_DEPENDENCY,
  JSON_WALK_LIMIT,
  TABLE_KEYS,
  TABLE_NAME,
  type FoundEdge,
} from "./dependencies-model.js";

/** Script include and table names one script text uses (pure). */
export function scriptTargets(text: string, self?: string): NodeSpec[] {
  if (!text) return [];
  const scripts = new Set([
    ...scriptIdentifiers(text),
    ...ajaxScriptNames(text),
  ]);
  const out: NodeSpec[] = [];
  for (const name of scripts) {
    if (!NOT_A_DEPENDENCY.has(name) && name !== self) {
      out.push({ kind: "script", name });
    }
  }
  for (const name of scriptTables(text)) out.push({ kind: "table", name });
  return out;
}

/**
 * Walk a decoded JSON value for dependencies (pure): table names under
 * {@link TABLE_KEYS}, `{table, sys_id}` pairs, and script text in string
 * leaves. Bounded by {@link JSON_WALK_LIMIT} leaves.
 */
export function jsonTargets(value: unknown, self?: string): NodeSpec[] {
  const out: NodeSpec[] = [];
  let budget = JSON_WALK_LIMIT;
  const visit = (v: unknown, key: string | undefined, depth: number) => {
    if (budget <= 0 || depth > 20) return;
    if (typeof v === "string") {
      budget--;
      if (
        key &&
        TABLE_KEYS.has(key) &&
        TABLE_NAME.test(v) &&
        v !== "true" &&
        v !== "false"
      ) {
        out.push({ kind: "table", name: v });
      } else if (v.includes("(")) {
        out.push(...scriptTargets(v, self));
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item, undefined, depth + 1);
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const table = [o.table, o.table_name, o.tableName].find(
        (x): x is string => typeof x === "string" && TABLE_NAME.test(x),
      );
      const id = typeof o.sys_id === "string" ? o.sys_id : undefined;
      if (table && id && isSysId(id)) {
        out.push({ kind: "record", table, sys_id: id });
      }
      for (const [k, child] of Object.entries(o)) {
        if (k === "sys_id") continue;
        visit(child, k, depth + 1);
      }
    }
  };
  visit(value, undefined, 0);
  return out;
}

/** The fields of a descriptor or child that carry outbound edges. */
interface RowShape {
  refFields?: RefField[];
  scriptFields?: string[];
  markupFields?: string[];
  jsonFields?: JsonField[];
}

/** Outbound edges of one row (the record or a child row) — pure. */
function rowEdges(
  shape: RowShape,
  row: SnRecord,
  self: string | undefined,
  source?: string,
  table?: string,
): FoundEdge[] {
  const out: FoundEdge[] = [];
  const tag = source ? { source } : {};
  for (const rf of shape.refFields ?? []) {
    const value = snString(row[rf.field]);
    if (!isSysId(value)) continue;
    out.push({
      other: {
        kind: "record",
        table: rf.table,
        sys_id: value,
        ...(rf.type ? { type: rf.type } : {}),
      },
      via: "reference",
      field: rf.field,
      ...tag,
    });
  }
  const markup = new Set(shape.markupFields ?? []);
  for (const field of shape.scriptFields ?? []) {
    if (markup.has(field)) continue;
    for (const other of scriptTargets(snString(row[field]), self)) {
      out.push({ other, via: "script", field, ...tag });
    }
    if (table === UIB_CLIENT_SCRIPT) {
      for (const name of uibImports(snString(row[field]))) {
        out.push({
          other: {
            kind: "record",
            table: UIB_INCLUDE,
            type: "uib_client_script_include",
            name,
          },
          via: "script",
          field,
          ...tag,
        });
      }
    }
  }
  if (table === UIB_CLIENT_SCRIPT) {
    for (const id of uibIncludeIds(snString(row.includes))) {
      out.push({
        other: {
          kind: "record",
          table: UIB_INCLUDE,
          type: "uib_client_script_include",
          sys_id: id,
        },
        via: "reference",
        field: "includes",
        ...tag,
      });
    }
  }
  if (table === UIB_MACROPONENT) out.push(...uibEdges(row, tag));
  for (const jf of shape.jsonFields ?? []) {
    const raw = snString(row[jf.field]);
    if (!raw) continue;
    const decoded = decodeField(jf.decoder, raw);
    if (!decoded.decoded) continue;
    for (const other of jsonTargets(decoded.value, self)) {
      out.push({ other, via: "json", field: jf.field, ...tag });
    }
  }
  return out;
}

export const UIB_MACROPONENT = "sys_ux_macroponent";
export const UIB_CLIENT_SCRIPT = "sys_ux_client_script";
export const UIB_INCLUDE = "sys_ux_client_script_include";

/**
 * N-28 — the composition component ids and data-resource broker ids of one
 * sys_ux_macroponent row as edges (pure). Ids that are not sys_ids (tags,
 * built-in brokers) are not edges.
 */
function uibEdges(row: SnRecord, tag: { source?: string }): FoundEdge[] {
  const out: FoundEdge[] = [];
  const self = snString(row.sys_id);
  const uses = macroponentUses(row);
  for (const c of uses.components) {
    if (!isSysId(c.id) || c.id === self) continue;
    out.push({
      other: {
        kind: "record",
        table: UIB_MACROPONENT,
        type: "uib_macroponent",
        sys_id: c.id,
      },
      via: "composition",
      field: "composition",
      ...tag,
    });
  }
  for (const b of uses.brokers) {
    if (!isSysId(b.id)) continue;
    const { table, type } = brokerTable(b.type);
    out.push({
      other: {
        kind: "record",
        table,
        sys_id: b.id,
        ...(type ? { type } : {}),
      },
      via: "data_broker",
      field: "data",
      ...tag,
    });
  }
  return out;
}

/** Outbound edges of a loaded artefact: record, then every child row (pure). */
export function outboundEdges(
  t: ArtifactType,
  artifact: Record<string, unknown>,
): FoundEdge[] {
  const record = artifact.record as SnRecord | null;
  if (!record) return [];
  const self =
    t.table === "sys_script_include" ? snString(record.name) : undefined;
  const out = rowEdges(t, record, self, undefined, t.table);
  if (t.appliesToField) {
    const applies = snString(record[t.appliesToField]);
    if (TABLE_NAME.test(applies)) {
      out.push({
        other: { kind: "table", name: applies },
        via: "reference",
        field: t.appliesToField,
      });
    }
  }
  for (const entry of (artifact.children ?? []) as ArtifactChildResult[]) {
    const desc: ArtifactChild | undefined = t.children.find(
      (c) => c.table === entry.table && c.parentField === entry.parentField,
    );
    if (!desc) continue;
    for (const row of entry.records ?? []) {
      out.push(...rowEdges(desc, row, self, entry.table, entry.table));
    }
  }
  return out;
}
