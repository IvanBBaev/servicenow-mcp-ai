import { queryTable, type SnRecord } from "./table.js";
import { assertNoCaret, snString } from "./shared.js";
import { scopeClause } from "./scripts.js";
import { ServiceNowError } from "../core/errors.js";
import { throwIfCancelled } from "../core/progress.js";
import { PERFORMANCE_ANALYTICS } from "../core/artifacts/registry.js";

/**
 * S-9 — structural reference extractor. Finds where a table, field or script
 * is referenced by configuration rather than by script text: reference-field
 * dictionary entries, list and form layouts, catalog variables, flow action
 * inputs, report conditions and (N-8) Performance Analytics indicator sources.
 *
 * Two layers, so P-17 (`get_artifact_dependencies`) can reuse the first one:
 *
 * - a pure layer — {@link REFERENCE_SOURCES}, {@link extractReferences},
 *   {@link encodedQueryFields}, {@link scriptIdentifiers},
 *   {@link refMatches} — that turns one record of a source table into every
 *   outbound {@link StructuralRef} it carries, with no I/O;
 * - {@link findStructuralReferences}, which queries each source for a target
 *   and keeps the refs that match it.
 *
 * The source queries are deliberately broad and the pure extractor re-checks
 * every row: ServiceNow drops an encoded-query condition on an unknown field
 * instead of failing, so an unverified field name would otherwise read as
 * "every row matches". Every source read goes through queryTable (so the
 * SN_TABLES_ALLOW / SN_TABLES_DENY policy applies) and degrades on its own to
 * `available:false` with the reason — one unreadable table never fails the
 * whole lookup.
 */

/** What kind of configuration a structural reference lives in. */
export type StructuralRefKind =
  | "reference_field"
  | "list_layout"
  | "form_layout"
  | "catalog_variable"
  | "flow_input"
  | "report"
  | "pa_indicator_source";

/** What a structural reference points at. */
export type RefTargetValue =
  | { kind: "table"; table: string }
  /** `table` is absent when the source does not say which table the field is on. */
  | { kind: "field"; element: string; table?: string }
  | { kind: "script"; name: string };

/** One structural reference found in a configuration record. */
export interface StructuralRef {
  kind: StructuralRefKind;
  /** Table of the referencing record, e.g. `sys_dictionary`. */
  table: string;
  sys_id: string;
  /** Human-readable name of the referencing record. */
  name: string;
  /** Field of the referencing record that holds the reference. */
  field: string;
  /** What the reference points at. */
  target: RefTargetValue;
  /** The raw value that matched (a table name, list element, condition term). */
  value?: string;
  /** Owning record, when there is one: a list's table, a catalog item, an action. */
  parent?: string;
}

/** What to look up: the where-used kind plus the parsed name. */
export interface RefTarget {
  kind: "table" | "field" | "script";
  name: string;
  /** For a field: the table part of `table.field`, when given. */
  table?: string;
  /** For a field: the field (element) name. */
  element?: string;
}

/** One table the structural pass reads, and how to read and decode it. */
export interface ReferenceSource {
  /** Stable id, e.g. `dictionary_reference`. */
  id: string;
  kind: StructuralRefKind;
  table: string;
  /** Field (possibly dot-walked) holding the record's application scope. */
  scopeField: string;
  /** Whether the table and field names are confirmed on a live instance (gate O-5). */
  verified: boolean;
  /**
   * The licensed plugin that owns the table (N-8, gate O-9): named in the
   * unavailable reason when the table is absent.
   */
  licensed?: string;
  /** Fields to read (`sysparm_fields`); dot-walks are returned as flat keys. */
  fields: string[];
  /** Encoded query for a target; `undefined` when the source cannot hold one of its kind. */
  query(target: RefTarget): string | undefined;
  /** Every outbound reference one record carries (pure). */
  extract(record: SnRecord): StructuralRef[];
}

/** Rows one source read keeps; reaching it marks the source `truncated`. */
export const STRUCTURAL_SOURCE_LIMIT = 100;

/** Globals and platform classes that are not script-include references. */
const NOT_A_SCRIPT = new Set([
  "Array",
  "Boolean",
  "Date",
  "Error",
  "GlideAggregate",
  "GlideDateTime",
  "GlideElement",
  "GlideRecord",
  "GlideRecordSecure",
  "GlideSysAttachment",
  "GlideSystem",
  "JSON",
  "Math",
  "Number",
  "Object",
  "RegExp",
  "String",
]);

/**
 * Script (script-include) names a server-side expression calls: `new X(…)`,
 * `new scope.X(…)` and static calls `X.method(…)` on a capitalised name.
 * Pure; used for reference qualifiers, `javascript:` defaults and conditions.
 */
export function scriptIdentifiers(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(
    /\bnew\s+([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*\(/g,
  )) {
    names.add(m[1]!.split(".").pop()!);
  }
  for (const m of text.matchAll(
    /(?<![\w$.])([A-Z][\w$]*)\.[A-Za-z_$][\w$]*\s*\(/g,
  )) {
    names.add(m[1]!);
  }
  return [...names].filter((n) => !NOT_A_SCRIPT.has(n));
}

/**
 * Tables a server-side script opens by literal name: `new GlideRecord('x')`,
 * `GlideRecordSecure` and `GlideAggregate` (pure; P-17). A table held in a
 * variable is not resolvable statically and yields nothing.
 */
export function scriptTables(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(
    /\bnew\s+(?:GlideRecord|GlideRecordSecure|GlideAggregate)\s*\(\s*(["'])([A-Za-z0-9_]+)\1\s*\)/g,
  )) {
    names.add(m[2]!);
  }
  return [...names];
}

/**
 * Script includes a client script calls through `new GlideAjax('X')` (pure;
 * P-17): the class name is a string argument, so {@link scriptIdentifiers}
 * cannot see it. A scoped name (`x_app.X`) yields its last segment.
 */
export function ajaxScriptNames(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(
    /\bnew\s+GlideAjax\s*\(\s*(["'])([A-Za-z0-9_$.]+)\1\s*\)/g,
  )) {
    names.add(m[2]!.split(".").pop()!);
  }
  return [...names];
}

/** One field condition of an encoded query. */
export interface QueryField {
  /** Field path as written, e.g. `priority` or `caller_id.vip`. */
  path: string;
  /** The whole condition term, e.g. `priority=1`. */
  term: string;
}

/**
 * Field paths an encoded query tests, orders or groups by (pure). Splits on
 * `^NQ`, `^OR` (not `^ORDERBY`) and `^`; each term's leading lower-case identifier is the field
 * (operators such as `LIKE` / `ISEMPTY` are upper case). `ORDERBY`,
 * `ORDERBYDESC` and `GROUPBY` prefixes are stripped; `EQ` and other
 * upper-case tokens yield nothing.
 */
export function encodedQueryFields(query: string): QueryField[] {
  const out: QueryField[] = [];
  for (const raw of query.split(/\^NQ|\^OR(?!DERBY)|\^/)) {
    const term = raw.trim();
    if (!term) continue;
    const body = term.replace(/^(ORDERBYDESC|ORDERBY|GROUPBY)/, "");
    const m = /^([a-z0-9_$][a-z0-9_$.]*)/.exec(body);
    if (!m) continue;
    const path = m[1]!.replace(/\.+$/, "");
    if (path) out.push({ path, term });
  }
  return out;
}

/** First segment of a (possibly dot-walked) field path. */
function firstSegment(path: string): string {
  return path.split(".")[0] ?? path;
}

/** `javascript:` expressions and other script text → script refs. */
function scriptRefs(
  base: Omit<StructuralRef, "target" | "field" | "value">,
  field: string,
  text: string,
): StructuralRef[] {
  if (!text) return [];
  return scriptIdentifiers(text).map((name) => ({
    ...base,
    field,
    target: { kind: "script", name },
    value: text.length > 200 ? text.slice(0, 200) : text,
  }));
}

/** Common identity of a record as a reference origin. */
function origin(
  source: ReferenceSource,
  r: SnRecord,
  name: string,
  parent?: string,
): Omit<StructuralRef, "target" | "field" | "value"> {
  return {
    kind: source.kind,
    table: source.table,
    sys_id: snString(r.sys_id),
    name,
    ...(parent ? { parent } : {}),
  };
}

/** `<table> list [<view>]` / `<table> form [<view>]` */
function layoutName(what: string, table: string, view: string): string {
  return `${table} ${what} [${view || "Default view"}]`;
}

/** A layout element (list column / form field) → field ref on the layout's table. */
function elementRef(
  base: Omit<StructuralRef, "target" | "field" | "value">,
  element: string,
  table: string,
): StructuralRef[] {
  if (!element) return [];
  return [
    {
      ...base,
      field: "element",
      target: {
        kind: "field",
        element: firstSegment(element),
        ...(table ? { table } : {}),
      },
      value: element,
    },
  ];
}

/** `element=E^ORelementSTARTSWITHE.` — the field itself or a dot-walk from it. */
function elementQuery(element: string): string {
  return `element=${element}^ORelementSTARTSWITH${element}.`;
}

const dictionaryReference: ReferenceSource = {
  id: "dictionary_reference",
  kind: "reference_field",
  table: "sys_dictionary",
  scopeField: "sys_scope",
  verified: true,
  fields: ["sys_id", "name", "element", "reference", "reference_qual"],
  query: (t) =>
    t.kind === "table"
      ? `reference=${t.name}`
      : t.kind === "script"
        ? `reference_qualLIKE${t.name}`
        : undefined,
  extract(r) {
    const table = snString(r.name);
    const element = snString(r.element);
    if (!element) return [];
    const base = origin(this, r, `${table}.${element}`, table);
    const out: StructuralRef[] = [];
    const reference = snString(r.reference);
    if (reference) {
      out.push({
        ...base,
        field: "reference",
        target: { kind: "table", table: reference },
        value: reference,
      });
    }
    out.push(...scriptRefs(base, "reference_qual", snString(r.reference_qual)));
    return out;
  },
};

const listLayout: ReferenceSource = {
  id: "list_layout",
  kind: "list_layout",
  table: "sys_ui_list",
  scopeField: "sys_scope",
  verified: true,
  fields: ["sys_id", "name", "view.name"],
  query: (t) => (t.kind === "table" ? `name=${t.name}` : undefined),
  extract(r) {
    const table = snString(r.name);
    if (!table) return [];
    const base = origin(
      this,
      r,
      layoutName("list", table, snString(r["view.name"])),
    );
    return [
      {
        ...base,
        field: "name",
        target: { kind: "table", table },
        value: table,
      },
    ];
  },
};

const listElement: ReferenceSource = {
  id: "list_element",
  kind: "list_layout",
  table: "sys_ui_list_element",
  scopeField: "list_id.sys_scope",
  verified: true,
  fields: ["sys_id", "element", "list_id.name", "list_id.view.name"],
  query: (t) =>
    t.kind === "field" && t.element
      ? elementQuery(t.element) + (t.table ? `^list_id.name=${t.table}` : "")
      : undefined,
  extract(r) {
    const table = snString(r["list_id.name"]);
    const element = snString(r.element);
    const name = `${layoutName("list", table, snString(r["list_id.view.name"]))}: ${element}`;
    return elementRef(origin(this, r, name, table), element, table);
  },
};

const formSection: ReferenceSource = {
  id: "form_section",
  kind: "form_layout",
  table: "sys_ui_section",
  scopeField: "sys_scope",
  verified: true,
  fields: ["sys_id", "name", "caption", "view.name"],
  query: (t) => (t.kind === "table" ? `name=${t.name}` : undefined),
  extract(r) {
    const table = snString(r.name);
    if (!table) return [];
    const caption = snString(r.caption);
    const name =
      layoutName("form", table, snString(r["view.name"])) +
      (caption ? ` ${caption}` : "");
    return [
      {
        ...origin(this, r, name),
        field: "name",
        target: { kind: "table", table },
        value: table,
      },
    ];
  },
};

const formElement: ReferenceSource = {
  id: "form_element",
  kind: "form_layout",
  table: "sys_ui_element",
  scopeField: "sys_ui_section.sys_scope",
  verified: true,
  fields: [
    "sys_id",
    "element",
    "sys_ui_section.name",
    "sys_ui_section.view.name",
  ],
  query: (t) =>
    t.kind === "field" && t.element
      ? elementQuery(t.element) +
        (t.table ? `^sys_ui_section.name=${t.table}` : "")
      : undefined,
  extract(r) {
    const table = snString(r["sys_ui_section.name"]);
    const element = snString(r.element);
    const name = `${layoutName("form", table, snString(r["sys_ui_section.view.name"]))}: ${element}`;
    return elementRef(origin(this, r, name, table), element, table);
  },
};

/** Catalog variable fields that name a table. */
const VARIABLE_TABLE_FIELDS = ["reference", "list_table", "lookup_table"];

const catalogVariable: ReferenceSource = {
  id: "catalog_variable",
  kind: "catalog_variable",
  table: "item_option_new",
  scopeField: "sys_scope",
  verified: false,
  fields: [
    "sys_id",
    "name",
    "cat_item.name",
    "variable_set.title",
    ...VARIABLE_TABLE_FIELDS,
    "map_to_field",
    "field",
    "reference_qual",
    "default_value",
  ],
  query: (t) => {
    if (t.kind === "table") {
      return VARIABLE_TABLE_FIELDS.map((f) => `${f}=${t.name}`).join("^OR");
    }
    if (t.kind === "field") {
      return t.element ? `map_to_field=true^field=${t.element}` : undefined;
    }
    return `reference_qualLIKE${t.name}^ORdefault_valueLIKE${t.name}`;
  },
  extract(r) {
    const parent =
      snString(r["cat_item.name"]) || snString(r["variable_set.title"]);
    const variable = snString(r.name);
    const base = origin(
      this,
      r,
      parent ? `${parent}: ${variable}` : variable,
      parent,
    );
    const out: StructuralRef[] = [];
    for (const f of VARIABLE_TABLE_FIELDS) {
      const table = snString(r[f]);
      if (table) {
        out.push({
          ...base,
          field: f,
          target: { kind: "table", table },
          value: table,
        });
      }
    }
    // The record producer's table is not on the variable: the ref is table-less.
    const mapped = snString(r.field);
    if (snString(r.map_to_field) === "true" && mapped) {
      out.push({
        ...base,
        field: "field",
        target: { kind: "field", element: mapped },
        value: mapped,
      });
    }
    out.push(...scriptRefs(base, "reference_qual", snString(r.reference_qual)));
    out.push(...scriptRefs(base, "default_value", snString(r.default_value)));
    return out;
  },
};

/** Flow Designer input definitions (var_dictionary rows); unverified tables. */
function flowInputSource(id: string, table: string): ReferenceSource {
  return {
    id,
    kind: "flow_input",
    table,
    scopeField: "sys_scope",
    verified: false,
    fields: ["sys_id", "element", "label", "reference", "model.name"],
    query: (t) => (t.kind === "table" ? `reference=${t.name}` : undefined),
    extract(r) {
      const reference = snString(r.reference);
      if (!reference) return [];
      const model = snString(r["model.name"]);
      const input = snString(r.label) || snString(r.element);
      return [
        {
          ...origin(this, r, model ? `${model}: ${input}` : input, model),
          field: "reference",
          target: { kind: "table", table: reference },
          value: reference,
        },
      ];
    },
  };
}

const report: ReferenceSource = {
  id: "report",
  kind: "report",
  table: "sys_report",
  scopeField: "sys_scope",
  verified: false,
  fields: ["sys_id", "title", "table", "field", "filter"],
  query: (t) => {
    if (t.kind === "table") return `table=${t.name}`;
    if (t.kind === "field") {
      if (!t.element) return undefined;
      const q = `filterLIKE${t.element}^ORfield=${t.element}`;
      return t.table ? `${q}^table=${t.table}` : q;
    }
    return `filterLIKE${t.name}`;
  },
  extract(r) {
    const table = snString(r.table);
    const base = origin(this, r, snString(r.title) || snString(r.sys_id));
    const out: StructuralRef[] = [];
    if (table) {
      out.push({
        ...base,
        field: "table",
        target: { kind: "table", table },
        value: table,
      });
    }
    const groupBy = snString(r.field);
    if (groupBy) {
      out.push({
        ...base,
        field: "field",
        target: {
          kind: "field",
          element: firstSegment(groupBy),
          ...(table ? { table } : {}),
        },
        value: groupBy,
      });
    }
    const filter = snString(r.filter);
    for (const { path, term } of encodedQueryFields(filter)) {
      out.push({
        ...base,
        field: "filter",
        target: {
          kind: "field",
          element: firstSegment(path),
          ...(table ? { table } : {}),
        },
        value: term,
      });
    }
    if (filter.includes("javascript:")) {
      out.push(...scriptRefs(base, "filter", filter));
    }
    return out;
  },
};

/**
 * N-8 — Performance Analytics indicator sources (`pa_cubes`): the facts table
 * and the conditions every indicator built on the source inherits. Licensed
 * (O-9); O-5: verify on a live instance.
 */
const paIndicatorSource: ReferenceSource = {
  id: "pa_indicator_source",
  kind: "pa_indicator_source",
  table: "pa_cubes",
  scopeField: "sys_scope",
  verified: false,
  licensed: PERFORMANCE_ANALYTICS,
  fields: ["sys_id", "name", "facts_table", "conditions"],
  query: (t) => {
    if (t.kind === "table") return `facts_table=${t.name}`;
    if (t.kind === "field") {
      if (!t.element) return undefined;
      const q = `conditionsLIKE${t.element}`;
      return t.table ? `${q}^facts_table=${t.table}` : q;
    }
    return `conditionsLIKE${t.name}`;
  },
  extract(r) {
    const table = snString(r.facts_table);
    const base = origin(this, r, snString(r.name) || snString(r.sys_id));
    const out: StructuralRef[] = [];
    if (table) {
      out.push({
        ...base,
        field: "facts_table",
        target: { kind: "table", table },
        value: table,
      });
    }
    const conditions = snString(r.conditions);
    for (const { path, term } of encodedQueryFields(conditions)) {
      out.push({
        ...base,
        field: "conditions",
        target: {
          kind: "field",
          element: firstSegment(path),
          ...(table ? { table } : {}),
        },
        value: term,
      });
    }
    if (conditions.includes("javascript:")) {
      out.push(...scriptRefs(base, "conditions", conditions));
    }
    return out;
  },
};

/** Every source of the structural pass, in read order. */
export const REFERENCE_SOURCES: readonly ReferenceSource[] = [
  dictionaryReference,
  listLayout,
  listElement,
  formSection,
  formElement,
  catalogVariable,
  flowInputSource("flow_action_input", "sys_hub_action_input"),
  flowInputSource("flow_input", "sys_hub_flow_input"),
  report,
  paIndicatorSource,
];

/**
 * Parse a where-used name into a target (pure). A field may be given as
 * `table.field`; a bare field name matches that field on any table.
 */
export function parseRefTarget(
  kind: RefTarget["kind"],
  name: string,
): RefTarget {
  const n = name.trim();
  if (kind !== "field") return { kind, name: n };
  const dot = n.lastIndexOf(".");
  return dot > 0
    ? { kind, name: n, table: n.slice(0, dot), element: n.slice(dot + 1) }
    : { kind, name: n, element: n };
}

/**
 * Whether a reference points at the target (pure). A field ref on an unknown
 * table matches any table (catalog variables mapped by a record producer); a
 * dot-walked path matches through its first segment only.
 */
export function refMatches(ref: StructuralRef, target: RefTarget): boolean {
  const t = ref.target;
  switch (target.kind) {
    case "table":
      return t.kind === "table" && t.table === target.name;
    case "field":
      return (
        t.kind === "field" &&
        t.element === target.element &&
        (!target.table || !t.table || t.table === target.table)
      );
    case "script":
      return t.kind === "script" && t.name === target.name;
  }
}

/** Every outbound reference one record of `source` carries (pure). */
export function extractReferences(
  source: ReferenceSource,
  record: SnRecord,
): StructuralRef[] {
  return source.extract(record);
}

/** Read status of one source. */
export interface SourceStatus {
  kind: StructuralRefKind;
  table: string;
  verified: boolean;
  /** False when the table is missing, policy-denied or unreadable. */
  available: boolean;
  unavailableReason?: string;
  /** Rows read. */
  scanned: number;
  /** Refs kept after the extractor re-check. */
  matched: number;
  /** The read stopped at {@link STRUCTURAL_SOURCE_LIMIT} rows. */
  truncated?: boolean;
}

/** Result of the structural pass. */
export interface StructuralRefs {
  count: number;
  byKind: Partial<Record<StructuralRefKind, number>>;
  refs: StructuralRef[];
  /** Per-source status, keyed by source id; only sources that apply to the kind. */
  sources: Record<string, SourceStatus>;
}

function unreadableReason(source: ReferenceSource, error: unknown): string {
  const { table } = source;
  if (error instanceof ServiceNowError) {
    if (error.status === 401 || error.status === 403) {
      return `${table} is not readable for this user (HTTP ${error.status}): ${error.message}`;
    }
    if (error.status === 400 || error.status === 404) {
      const requires = source.licensed
        ? ` It requires ${source.licensed}.`
        : "";
      return `${table} does not exist on this instance or is not exposed (HTTP ${error.status}).${requires}`;
    }
  }
  return `${table} could not be read: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Query every source that applies to `target` and keep the references that
 * point at it. `sources` narrows the pass (tests, P-17); `scope` restricts
 * each read to one application scope. Never throws for a source read — only
 * a cancelled call propagates.
 */
export async function findStructuralReferences(
  target: RefTarget,
  opts: {
    scope?: string;
    limit?: number;
    sources?: readonly ReferenceSource[];
  } = {},
): Promise<StructuralRefs> {
  assertNoCaret(target.name, "name");
  const scope = opts.scope?.trim() || undefined;
  if (scope) assertNoCaret(scope, "scope");
  const limit = opts.limit ?? STRUCTURAL_SOURCE_LIMIT;
  const applicable = (opts.sources ?? REFERENCE_SOURCES)
    .map((source) => ({ source, query: source.query(target) }))
    .filter((s): s is { source: ReferenceSource; query: string } =>
      Boolean(s.query),
    );

  const sources: Record<string, SourceStatus> = {};
  const refs: StructuralRef[] = [];
  const reads = await Promise.all(
    applicable.map(async ({ source, query }) => {
      const q = scope
        ? `${scopeClause(source.scopeField, scope)}^${query}`
        : query;
      try {
        const res = await queryTable({
          table: source.table,
          query: q,
          fields: source.fields,
          displayValue: "false",
          limit,
        });
        return { source, records: res.records };
      } catch (error) {
        if (error instanceof ServiceNowError && error.code === "CANCELLED") {
          throw error;
        }
        return { source, reason: unreadableReason(source, error) };
      }
    }),
  );
  throwIfCancelled();

  const seen = new Set<string>();
  for (const read of reads) {
    const { source } = read;
    const status: SourceStatus = {
      kind: source.kind,
      table: source.table,
      verified: source.verified,
      available: !("reason" in read),
      scanned: 0,
      matched: 0,
    };
    if ("reason" in read) {
      status.unavailableReason = read.reason;
    } else {
      status.scanned = read.records.length;
      if (read.records.length >= limit) status.truncated = true;
      for (const record of read.records) {
        for (const ref of extractReferences(source, record)) {
          if (!ref.sys_id || !refMatches(ref, target)) continue;
          const key = `${ref.table}:${ref.sys_id}:${ref.field}`;
          if (seen.has(key)) continue;
          seen.add(key);
          refs.push(ref);
          status.matched++;
        }
      }
    }
    sources[source.id] = status;
  }

  const byKind: Partial<Record<StructuralRefKind, number>> = {};
  for (const r of refs) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  return { count: refs.length, byKind, refs, sources };
}
