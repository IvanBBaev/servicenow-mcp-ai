/**
 * P-6 — `explain_artifact` (project/SDK-PARITY.md §3 tier X, §5(d)).
 *
 * Reads one artefact through `getArtifactFor` (same policy, redaction and
 * degrade rules as `servicenow_get_artifact`) and reshapes it from descriptor
 * data into `{summary, when, fields, children, references, decoded}`:
 *
 * - `when`: the trigger fields (`whenFields`, or a generic list) that are set;
 * - `fields` / child `items`: non-empty, non-system fields, scripts capped;
 * - `references`: descriptor `refFields` edges from the record and children;
 * - `decoded`: every `jsonFields` value through its decoder
 *   (`src/core/artifacts/decoders.ts`); undecodable ones stay raw with
 *   `decoded:false`, so a bad field never fails the call;
 * - `explanation`: a type-specific reading of the record with its children
 *   (state-model transitions, choice tables, policy field effects), from the
 *   enricher registered for the type in `./explainers.ts` (P-7).
 *
 * Output is size-capped against `SN_MAX_RESULT_CHARS` (the M-6 budget): each
 * value gets at most a twentieth of it, the whole explain four fifths.
 */
import { getMaxResultChars } from "../core/settings.js";
import { decodeField } from "../core/artifacts/decoders.js";
import type {
  ArtifactType,
  JsonField,
  RefField,
} from "../core/artifacts/registry.js";
import {
  getArtifactFor,
  resolveArtifactType,
  type ArtifactChildResult,
  type GetArtifactOptions,
} from "./artifacts.js";
import { getExplainer, type Explanation } from "./explainers.js";
import type { SnRecord } from "./table.js";
import { snString } from "./shared.js";

/** Trigger fields used when a descriptor declares no `whenFields`. */
const DEFAULT_WHEN_FIELDS = [
  "when",
  "order",
  "action_insert",
  "action_update",
  "action_delete",
  "action_query",
  "condition",
  "filter_condition",
  "conditions",
  "on_load",
  "reverse_if_false",
  "event_name",
  "run_type",
  "run_time",
  "run_dayofweek",
  "run_dayofmonth",
  "operation",
  "http_method",
  "operation_uri",
];

/** At most this many reference edges are listed. */
const REFERENCE_LIMIT = 500;

/** Shared character budget for one explain. */
class Budget {
  left: number;
  readonly field: number;
  constructor(total: number) {
    this.left = Math.floor(total * 0.8);
    this.field = Math.max(500, Math.floor(total / 20));
  }
  /** Chars one value may take now. */
  get room(): number {
    return Math.max(0, Math.min(this.field, this.left));
  }
  spend(chars: number): void {
    this.left -= chars;
  }
}

/** A reference `{value, link}` unwrapped to its value; scalars as-is. */
function flat(v: unknown): unknown {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? snString(v)
    : v;
}

function isEmpty(v: unknown): boolean {
  return v === "" || v === null || v === undefined;
}

/**
 * Non-empty, non-system fields of a row (sys_id aside), `first` ones in
 * order, JSON fields left out (they go to `decoded`). Long strings are cut to
 * the budget and listed in `truncated`.
 */
function compactFields(
  row: SnRecord,
  first: string[],
  skip: Set<string>,
  budget: Budget,
  truncated: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const names = [...new Set([...first, ...Object.keys(row).sort()])].filter(
    (f) =>
      f in row && !skip.has(f) && !f.startsWith("sys_") && !f.includes("."),
  );
  for (const f of names) {
    let v = flat(row[f]);
    if (isEmpty(v)) continue;
    if (typeof v === "string" && v.length > budget.room) {
      v = v.slice(0, budget.room);
      truncated.push(f);
    }
    budget.spend(f.length + JSON.stringify(v).length);
    out[f] = v;
  }
  return out;
}

export interface DecodedEntry {
  /** `record`, or the child table the row belongs to. */
  source: string;
  sys_id: string;
  field: string;
  decoder: string;
  via?: string;
  decoded: boolean;
  value?: unknown;
  /** Undecodable: the raw text (capped) and why. */
  raw?: string;
  reason?: string;
  /** The serialised value / raw text did not fit the budget. */
  truncated?: boolean;
  preview?: string;
  chars?: number;
}

function decodeOne(
  source: string,
  row: SnRecord,
  jf: JsonField,
  budget: Budget,
): DecodedEntry | undefined {
  const raw = snString(row[jf.field]);
  if (!(jf.field in row) || raw === "") return undefined;
  const head = { source, sys_id: snString(row.sys_id), field: jf.field };
  const d = decodeField(jf.decoder, raw);
  const meta = { decoder: d.decoder, ...(d.via ? { via: d.via } : {}) };
  const room = budget.room;
  if (!d.decoded) {
    const cut = raw.length > room;
    budget.spend(Math.min(raw.length, room));
    return {
      ...head,
      ...meta,
      decoded: false,
      reason: d.reason,
      raw: cut ? raw.slice(0, room) : raw,
      ...(cut ? { truncated: true, chars: raw.length } : {}),
    };
  }
  const text = JSON.stringify(d.value) ?? "null";
  if (text.length <= room) {
    budget.spend(text.length);
    return { ...head, ...meta, decoded: true, value: d.value };
  }
  budget.spend(room);
  return {
    ...head,
    ...meta,
    decoded: true,
    truncated: true,
    chars: text.length,
    preview: text.slice(0, room),
  };
}

export interface ReferenceEdge {
  field: string;
  table: string;
  type?: string;
  sys_id: string;
  /** Set for edges from a child row: its table and sys_id. */
  from?: { table: string; sys_id: string };
}

function edges(
  row: SnRecord,
  refs: readonly RefField[] | undefined,
  out: ReferenceEdge[],
  from?: string,
): void {
  for (const r of refs ?? []) {
    const id = snString(row[r.field]);
    if (!id || out.length >= REFERENCE_LIMIT) continue;
    out.push({
      field: r.field,
      table: r.table,
      ...(r.type ? { type: r.type } : {}),
      sys_id: id,
      ...(from ? { from: { table: from, sys_id: snString(row.sys_id) } } : {}),
    });
  }
}

/** The one-line human summary. */
function summarize(
  t: ArtifactType,
  body: Record<string, unknown>,
  record: SnRecord,
  childCount: number,
  childTables: number,
  decoded: DecodedEntry[],
): string {
  const parts = [`${t.type} '${snString(body.name)}' (${t.table})`];
  const applies = t.appliesToField ? snString(record[t.appliesToField]) : "";
  if (applies) parts.push(`applies to ${applies}`);
  if (t.activeField && t.activeField in record) {
    parts.push(
      snString(record[t.activeField]) === "true" ? "active" : "inactive",
    );
  }
  const scope = body.scope as { scope: string | null; sys_id: string | null };
  if (scope?.scope ?? scope?.sys_id) {
    parts.push(`scope ${scope.scope ?? scope.sys_id}`);
  }
  if (childCount) {
    parts.push(`${childCount} child record(s) in ${childTables} table(s)`);
  }
  if (decoded.length) {
    const ok = decoded.filter((d) => d.decoded).length;
    parts.push(`${ok}/${decoded.length} JSON field(s) decoded`);
  }
  if (!t.verified) parts.push("unverified type");
  const about = ["short_description", "description"]
    .map((f) => (f === t.nameField ? "" : snString(record[f])))
    .find(Boolean);
  const text = parts.join("; ");
  return about ? `${text}. ${about.slice(0, 200)}` : text;
}

/**
 * Run the type's enricher, if any, and fit it to the budget: at most half of
 * what is left (never less than one field's share). An oversized result keeps
 * its `kind` and as many `lines` as fit, with `truncated:true`; a throwing
 * enricher yields `{kind:"error"}` instead of failing the explain.
 */
function enrich(
  t: ArtifactType,
  record: SnRecord,
  children: ArtifactChildResult[],
  budget: Budget,
): Explanation | undefined {
  const fn = getExplainer(t.type);
  if (!fn) return undefined;
  let out: Explanation | undefined;
  try {
    out = fn({ t, record, children });
  } catch (error) {
    out = {
      kind: "error",
      lines: [`The ${t.type} explainer failed: ${(error as Error).message}`],
    };
  }
  if (!out) return undefined;
  const cap = Math.max(budget.field, Math.floor(budget.left / 2));
  const text = JSON.stringify(out);
  if (text.length <= cap) {
    budget.spend(text.length);
    return out;
  }
  const lines: string[] = [];
  let used = out.kind.length + 40;
  for (const line of out.lines) {
    if (used + line.length + 3 > cap) break;
    lines.push(line);
    used += line.length + 3;
  }
  budget.spend(used);
  return { kind: out.kind, lines, truncated: true, chars: text.length };
}

export interface ExplainedChild {
  table: string;
  parentField: string;
  parentTable?: string;
  verified: boolean;
  count: number;
  items: Record<string, unknown>[];
  /** Rows left out because the budget ran out. */
  omitted?: number;
  truncated?: boolean;
  redacted?: boolean;
  reason?: string;
  error?: string;
  status?: number;
}

/**
 * Explain one artefact: a summary, when it runs, its fields, its children,
 * its outbound references and its decoded JSON fields.
 */
export async function explainArtifact(
  opts: GetArtifactOptions,
): Promise<Record<string, unknown>> {
  return explainArtifactFor(resolveArtifactType(opts.artifactType), opts);
}

/** `explainArtifact` against an explicit descriptor (tests). */
export async function explainArtifactFor(
  t: ArtifactType,
  opts: Omit<GetArtifactOptions, "artifactType">,
): Promise<Record<string, unknown>> {
  const body = await getArtifactFor(t, opts);
  const {
    record,
    children: rawChildren,
    ...head
  } = body as {
    record: SnRecord | null;
    children: ArtifactChildResult[];
  } & Record<string, unknown>;
  if (!record) {
    return {
      ...head,
      summary:
        typeof head.requires === "string"
          ? `${t.type} (${t.table}) is not installed on this instance; it requires ${head.requires}.`
          : `${t.type} (${t.table}) could not be read.`,
      when: null,
      fields: {},
      children: [],
      references: [],
      decoded: [],
    };
  }

  const budget = new Budget(getMaxResultChars());
  const truncatedFields: string[] = [];
  const decoded: DecodedEntry[] = [];
  const references: ReferenceEdge[] = [];

  const whenList = t.whenFields ?? DEFAULT_WHEN_FIELDS;
  const when: Record<string, unknown> = {};
  for (const f of whenList) {
    const v = flat(record[f]);
    if (!isEmpty(v)) when[f] = v;
  }

  const primaryJson = new Set(t.jsonFields.map((j) => j.field));
  const fields = compactFields(
    record,
    [
      t.nameField,
      ...t.keyFields,
      ...(t.appliesToField ? [t.appliesToField] : []),
      ...(t.metaFields ?? []),
      ...t.scriptFields,
    ],
    primaryJson,
    budget,
    truncatedFields,
  );
  for (const jf of t.jsonFields) {
    const d = decodeOne("record", record, jf, budget);
    if (d) decoded.push(d);
  }
  edges(record, t.refFields, references);
  const explanation = enrich(t, record, rawChildren, budget);

  const children: ExplainedChild[] = [];
  let childCount = 0;
  for (const entry of rawChildren) {
    const c = t.children.find(
      (x) => x.table === entry.table && x.parentField === entry.parentField,
    );
    const { records, ...rest } = entry;
    const skip = new Set((c?.jsonFields ?? []).map((j) => j.field));
    const first = [
      ...(c?.nameField ? [c.nameField] : []),
      ...(c?.orderField ? [c.orderField] : []),
      entry.parentField,
    ];
    const items: Record<string, unknown>[] = [];
    for (const row of records) {
      if (budget.left <= 0) break;
      const cut: string[] = [];
      const before = budget.left;
      const item: Record<string, unknown> = {
        sys_id: snString(row.sys_id),
        ...compactFields(row, first, skip, budget, cut),
      };
      if (cut.length) item.truncatedFields = cut;
      items.push(item);
      // Charge the item's serialized size (keys, sys_id, punctuation), not
      // only its values, so the result fits before runSpec's N-61 cap.
      budget.spend(JSON.stringify(item).length + 1 - (before - budget.left));
      for (const jf of c?.jsonFields ?? []) {
        const d = decodeOne(entry.table, row, jf, budget);
        if (d) decoded.push(d);
      }
      edges(row, c?.refFields, references, entry.table);
    }
    childCount += records.length;
    children.push({
      ...rest,
      items,
      ...(items.length < records.length
        ? { omitted: records.length - items.length }
        : {}),
    });
  }

  return {
    ...head,
    summary: summarize(
      t,
      body,
      record,
      childCount,
      children.filter((c) => c.count > 0).length,
      decoded,
    ),
    when: Object.keys(when).length ? when : null,
    fields,
    ...(truncatedFields.length ? { truncatedFields } : {}),
    ...(explanation ? { explanation } : {}),
    children,
    references,
    decoded,
  };
}
