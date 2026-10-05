import {
  ARTIFACT_TYPES,
  getArtifactType,
  type ArtifactChild,
  type ArtifactType,
  type JsonField,
  type RefField,
} from "../core/artifacts/registry.js";
import { decodeField } from "../core/artifacts/decoders.js";
import { ServiceNowError } from "../core/errors.js";
import { throwIfCancelled } from "../core/progress.js";
import {
  getArtifactFor,
  resolveArtifactType,
  type ArtifactChildResult,
  type ArtifactRef,
} from "./artifacts.js";
import { MermaidDoc, label, type Arrow, type Shape } from "./mermaid.js";
import {
  REFERENCE_SOURCES,
  ajaxScriptNames,
  findStructuralReferences,
  parseRefTarget,
  scriptIdentifiers,
  scriptTables,
} from "./references.js";
import { searchCode } from "./scripts.js";
import {
  BROKER_TABLE_NAMES,
  brokerTable,
  isSysId,
  macroponentUses,
  uibImports,
} from "./uib-usage.js";
import { assertNoCaret, snString } from "./shared.js";
import { queryTable, type SnRecord } from "./table.js";

/**
 * P-17 — `get_artifact_dependencies`: the dependency graph of one registry
 * artefact.
 *
 * Outbound edges (what the artefact uses) come from the descriptor alone:
 * registry `refFields` on the record and its child rows, decoded JSON fields
 * (flow step `values`, widget options, UIB data) walked for table names,
 * `{table, sys_id}` pairs and script text, and script fields read with the
 * S-9 extractors ({@link scriptIdentifiers}, {@link scriptTables},
 * {@link ajaxScriptNames}).
 *
 * Inbound edges (what uses the artefact) come from bounded reverse queries:
 * every registry `refField` that points at the artefact's table, and — for a
 * script include — a script-text search (`searchCode`), a `valuesLIKE` read of
 * the flow step tables re-checked after decoding, and the S-9 structural pass
 * ({@link findStructuralReferences}); for a table, the structural pass.
 *
 * N-28 (UX-07, UX-08): a UI Builder macroponent's composition component ids
 * and data-resource broker ids are outbound edges (`composition`,
 * `data_broker`), and a UIB client script's `imports['…']` names a client
 * script include. Inbound, a macroponent, component, data broker or client
 * script include is used by the macroponents whose composition / data names
 * it, or whose client scripts import it (bounded LIKE reads, re-checked after
 * decoding). Walk two levels to reach the screens and routes (pages) that
 * render those macroponents.
 *
 * The walk is breadth-first per direction with a depth cap, a visited set per
 * direction (the cycle guard) and a node cap. Every source read degrades on
 * its own to an `unavailable` entry; only a cancelled call propagates.
 */

/** Levels walked from the root (default / max). */
export const DEPENDENCY_DEPTH = { default: 1, max: 3 } as const;

/** Rows each inbound source read keeps (default / max). */
export const DEPENDENCY_LIMIT = { default: 25, max: 100 } as const;

/** Nodes a graph holds; reaching it marks the result `truncated`. */
export const MAX_GRAPH_NODES = 150;

/** JSON leaves one decoded field is walked for. */
const JSON_WALK_LIMIT = 5000;

/** Label characters kept per Mermaid node. */
const LABEL_CHARS = 60;

/** Platform and client classes that are not script-include references. */
const NOT_A_DEPENDENCY = new Set([
  "Class",
  "GlideAjax",
  "GlideDialogWindow",
  "GlideDuration",
  "GlideFilter",
  "GlideForm",
  "GlideModal",
  "GlideScopedEvaluator",
  "GlideSession",
  "GlideStringUtil",
  "GlideTableHierarchy",
  "GlideUser",
  "Map",
  "Promise",
  "Set",
]);

/** JSON keys whose (table-like) string value names a table. */
const TABLE_KEYS = new Set([
  "table",
  "table_name",
  "tableName",
  "reference",
  "referenced_table",
]);

const SYS_ID = /^[0-9a-f]{32}$/;
const TABLE_NAME = /^[a-z][a-z0-9_]{1,79}$/;

export type DependencyDirection = "outbound" | "inbound" | "both";

/** How an edge was found. */
export type EdgeVia =
  | "reference"
  | "json"
  | "script"
  | "flow_step"
  | "structural"
  /** N-28: a UIB composition element renders the macroponent. */
  | "composition"
  /** N-28: a UIB data resource calls the data broker. */
  | "data_broker";

export interface DependencyNode {
  /** Stable id: `script:<name>`, `table:<name>` or `<table>:<sys_id>`. */
  id: string;
  kind: "record" | "script" | "table";
  /** Registry type, when known. */
  type?: string;
  table?: string;
  sys_id?: string;
  name: string;
  /** Levels from the root (0 for the root). */
  depth: number;
  /** Which walk reached the node first. */
  reached: "root" | "outbound" | "inbound";
  /** A script include named by script text that does not exist. */
  missing?: boolean;
}

/** `from` depends on (uses, references) `to`. */
export interface DependencyEdge {
  from: string;
  to: string;
  via: EdgeVia;
  /** Field holding the reference, on the source record or child row. */
  field: string;
  /** Child table (outbound) or source table / kind (inbound) of the edge. */
  source?: string;
}

/** A source read that failed; the graph is complete without it. */
export interface DependencyUnavailable {
  node: string;
  source: string;
  reason: string;
}

export interface DependencyOptions extends ArtifactRef {
  artifactType: string;
  direction?: DependencyDirection;
  depth?: number;
  limit?: number;
}

/** A node as a source or target is first described. */
interface NodeSpec {
  kind: DependencyNode["kind"];
  type?: string;
  table?: string;
  sys_id?: string;
  name?: string;
}

/** One edge found for a node, before the far end is added to the graph. */
interface FoundEdge {
  other: NodeSpec;
  via: EdgeVia;
  field: string;
  source?: string;
}

/** A registry refField read backwards: rows of `table` whose `field` = sys_id. */
interface ReverseSource {
  table: string;
  field: string;
  target: string;
  type?: string;
  nameField?: string;
  /** Set for a child of the primary table: report the parent record. */
  parent?: { field: string; table: string; type: string };
}

/** Every registry refField, indexed for the reverse (inbound) queries. */
const REVERSE_SOURCES: readonly ReverseSource[] = (() => {
  const out = new Map<string, ReverseSource>();
  const add = (s: ReverseSource) => {
    const key = `${s.table}.${s.field}>${s.target}`;
    if (!out.has(key)) out.set(key, s);
  };
  for (const t of ARTIFACT_TYPES) {
    for (const rf of t.refFields) {
      add({
        table: t.table,
        field: rf.field,
        target: rf.table,
        type: t.type,
        nameField: t.nameField,
      });
    }
    for (const c of t.children) {
      for (const rf of c.refFields ?? []) {
        add({
          table: c.table,
          field: rf.field,
          target: rf.table,
          ...(c.nameField ? { nameField: c.nameField } : {}),
          ...(!c.parentTable && !c.parentKey
            ? { parent: { field: c.parentField, table: t.table, type: t.type } }
            : {}),
        });
      }
    }
  }
  return [...out.values()];
})();

/** Flow step tables whose `values` column holds decoded step inputs. */
const FLOW_STEP_TABLES: readonly string[] = [
  ...new Set(
    ARTIFACT_TYPES.filter((t) => t.table === "sys_hub_flow").flatMap((t) =>
      t.children
        .filter((c) => c.jsonFields?.some((j) => j.decoder === "flow-values"))
        .map((c) => c.table),
    ),
  ),
];

const FLOW_VALUES_CAVEAT =
  "Flow step values stored base64 + gzip cannot be matched by a LIKE query; steps stored that way are not found as inbound edges.";

/** Canonical node id and shape of a spec. */
function canonical(spec: NodeSpec): NodeSpec & { id: string } {
  if (spec.kind === "record" && spec.name) {
    if (spec.table === "sys_script_include") {
      return { ...spec, kind: "script", id: `script:${spec.name}` };
    }
    if (spec.table === "sys_db_object") {
      return { ...spec, kind: "table", id: `table:${spec.name}` };
    }
  }
  if (spec.kind === "script") return { ...spec, id: `script:${spec.name}` };
  if (spec.kind === "table") return { ...spec, id: `table:${spec.name}` };
  // N-28: a record known by name only (a UIB client script include import).
  if (!spec.sys_id && spec.name) {
    return { ...spec, id: `${spec.table}:${spec.name}` };
  }
  return { ...spec, id: `${spec.table}:${spec.sys_id}` };
}

function isCancelled(error: unknown): boolean {
  return error instanceof ServiceNowError && error.code === "CANCELLED";
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Script include and table names one script text uses (pure). */
function scriptTargets(text: string, self?: string): NodeSpec[] {
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
      if (table && id && SYS_ID.test(id)) {
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
    if (!SYS_ID.test(value)) continue;
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

const UIB_MACROPONENT = "sys_ux_macroponent";
const UIB_CLIENT_SCRIPT = "sys_ux_client_script";
const UIB_INCLUDE = "sys_ux_client_script_include";

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

/** The dependency graph under construction. */
class Graph {
  readonly nodes = new Map<string, DependencyNode>();
  readonly edges = new Map<string, DependencyEdge>();
  readonly unavailable: DependencyUnavailable[] = [];
  readonly caveats = new Set<string>();
  truncated = false;

  /** Add (or find) a node; `undefined` when the node cap drops it. */
  add(
    spec: NodeSpec,
    depth: number,
    reached: DependencyNode["reached"],
  ): { node: DependencyNode; added: boolean } | undefined {
    const c = canonical(spec);
    const known = this.nodes.get(c.id);
    if (known) {
      if (!known.name.trim() || known.name === known.sys_id) {
        if (c.name) known.name = c.name;
      }
      return { node: known, added: false };
    }
    if (this.nodes.size >= MAX_GRAPH_NODES) {
      this.truncated = true;
      return undefined;
    }
    const node: DependencyNode = {
      id: c.id,
      kind: c.kind,
      ...(c.type ? { type: c.type } : {}),
      ...(c.table ? { table: c.table } : {}),
      ...(c.sys_id ? { sys_id: c.sys_id } : {}),
      name: c.name ?? c.sys_id ?? "",
      depth,
      reached,
    };
    this.nodes.set(c.id, node);
    return { node, added: true };
  }

  link(edge: DependencyEdge): void {
    const key = `${edge.from}|${edge.to}|${edge.via}|${edge.field}|${edge.source ?? ""}`;
    if (!this.edges.has(key)) this.edges.set(key, edge);
  }

  fail(node: string, source: string, error: unknown): void {
    if (isCancelled(error)) throw error;
    this.unavailable.push({ node, source, reason: reasonOf(error) });
  }
}

/** A loaded artefact and its descriptor. */
interface Loaded {
  t: ArtifactType;
  artifact: Record<string, unknown>;
}

/** Read the artefact behind a non-root node; `undefined` for a leaf. */
async function loadNode(
  node: DependencyNode,
  graph: Graph,
): Promise<Loaded | undefined> {
  try {
    if (node.kind === "script") {
      const t = getArtifactType("script_include")!;
      let sysId = node.sys_id;
      if (!sysId) {
        assertNoCaret(node.name, "name");
        const res = await queryTable({
          table: t.table,
          query: `name=${node.name}`,
          fields: ["sys_id", "name"],
          displayValue: "false",
          limit: 1,
        });
        sysId = snString(res.records[0]?.sys_id);
        if (!sysId) {
          node.missing = true;
          return undefined;
        }
        node.sys_id = sysId;
        node.table = t.table;
        node.type = t.type;
      }
      return { t, artifact: await getArtifactFor(t, { sys_id: sysId }) };
    }
    // Tables are leaves: their children are dictionary rows, not dependencies.
    if (node.kind !== "record" || !node.type) return undefined;
    const t = getArtifactType(node.type);
    if (!t) return undefined;
    if (!node.sys_id) {
      // N-28: a record known by name only (a UIB client script include).
      if (!node.name || !t.nameField) return undefined;
      assertNoCaret(node.name, "name");
      const res = await queryTable({
        table: t.table,
        query: `${t.nameField}=${node.name}`,
        fields: ["sys_id"],
        displayValue: "false",
        limit: 1,
      });
      const sysId = snString(res.records[0]?.sys_id);
      if (!sysId) {
        node.missing = true;
        return undefined;
      }
      node.sys_id = sysId;
    }
    const artifact = await getArtifactFor(t, { sys_id: node.sys_id });
    if (artifact.record) node.name = snString(artifact.name) || node.name;
    return { t, artifact };
  } catch (error) {
    graph.fail(node.id, "artifact", error);
    return undefined;
  }
}

/** Rows of every registry refField that points at `node` (inbound). */
async function reverseEdges(
  node: DependencyNode,
  limit: number,
  graph: Graph,
): Promise<FoundEdge[]> {
  if (!node.sys_id || !node.table) return [];
  const sysId = node.sys_id;
  const sources = REVERSE_SOURCES.filter((s) => s.target === node.table);
  const reads = await Promise.all(
    sources.map(async (s) => {
      try {
        const res = await queryTable({
          table: s.table,
          query: `${s.field}=${sysId}`,
          fields: [
            "sys_id",
            ...(s.nameField ? [s.nameField] : []),
            ...(s.parent ? [s.parent.field] : []),
          ],
          displayValue: "false",
          limit,
        });
        return { s, rows: res.records };
      } catch (error) {
        graph.fail(node.id, `${s.table}.${s.field}`, error);
        return { s, rows: [] as SnRecord[] };
      }
    }),
  );
  const out: FoundEdge[] = [];
  for (const { s, rows } of reads) {
    for (const row of rows) {
      const parentId = s.parent ? snString(row[s.parent.field]) : "";
      if (s.parent && SYS_ID.test(parentId)) {
        out.push({
          other: {
            kind: "record",
            table: s.parent.table,
            type: s.parent.type,
            sys_id: parentId,
          },
          via: "reference",
          field: s.field,
          source: s.table,
        });
        continue;
      }
      const rowId = snString(row.sys_id);
      if (!rowId) continue;
      out.push({
        other: {
          kind: "record",
          table: s.table,
          sys_id: rowId,
          ...(s.type ? { type: s.type } : {}),
          ...(s.nameField && snString(row[s.nameField])
            ? { name: snString(row[s.nameField]) }
            : {}),
        },
        via: "reference",
        field: s.field,
      });
    }
  }
  return out;
}

/** Whether a string leaf of decoded JSON calls the script include (pure). */
function jsonCalls(value: unknown, name: string): boolean {
  return jsonTargets(value).some((s) => s.kind === "script" && s.name === name);
}

/** Script artefacts and flow steps whose code calls script include `name`. */
async function scriptUsers(
  node: DependencyNode,
  name: string,
  limit: number,
  graph: Graph,
): Promise<FoundEdge[]> {
  const out: FoundEdge[] = [];
  try {
    const { matches } = await searchCode({ text: name, limit, maxHits: 5 });
    for (const m of matches) {
      if (m.sys_id === node.sys_id) continue;
      const calls = m.hits.some((h) =>
        scriptTargets(h.text).some(
          (s) => s.kind === "script" && s.name === name,
        ),
      );
      if (!calls) continue;
      const t = getArtifactType(m.type);
      out.push({
        other: {
          kind: "record",
          type: m.type,
          table: t?.table ?? m.table ?? m.type,
          sys_id: m.sys_id,
          name: m.name,
        },
        via: "script",
        field: m.field,
      });
    }
  } catch (error) {
    graph.fail(node.id, "search_code", error);
  }

  graph.caveats.add(FLOW_VALUES_CAVEAT);
  const reads = await Promise.all(
    FLOW_STEP_TABLES.map(async (table) => {
      try {
        const res = await queryTable({
          table,
          query: `valuesLIKE${name}`,
          fields: ["sys_id", "flow", "flow.name", "values"],
          displayValue: "false",
          limit,
        });
        return { table, rows: res.records };
      } catch (error) {
        graph.fail(node.id, table, error);
        return { table, rows: [] as SnRecord[] };
      }
    }),
  );
  for (const { table, rows } of reads) {
    for (const row of rows) {
      const flow = snString(row.flow);
      if (!SYS_ID.test(flow)) continue;
      const decoded = decodeField("flow-values", snString(row.values));
      if (!decoded.decoded || !jsonCalls(decoded.value, name)) continue;
      const flowName = snString(row["flow.name"]);
      out.push({
        other: {
          kind: "record",
          type: "flow",
          table: "sys_hub_flow",
          sys_id: flow,
          ...(flowName ? { name: flowName } : {}),
        },
        via: "flow_step",
        field: "values",
        source: table,
      });
    }
  }
  return out;
}

/** The S-9 sources minus the N-28 UIB ones (see {@link uibUsers}). */
const NON_UIB_SOURCES = REFERENCE_SOURCES.filter(
  (s) => !s.kind.startsWith("uib_"),
);

/** S-9 structural references to a script or table (inbound). */
async function structuralUsers(
  node: DependencyNode,
  kind: "script" | "table",
  limit: number,
  graph: Graph,
): Promise<FoundEdge[]> {
  try {
    const res = await findStructuralReferences(
      parseRefTarget(kind, node.name),
      // UIB sources run in uibUsers, against the UIB record itself.
      { limit, sources: NON_UIB_SOURCES },
    );
    for (const [id, status] of Object.entries(res.sources)) {
      if (!status.available) {
        graph.unavailable.push({
          node: node.id,
          source: `structural:${id}`,
          reason: status.unavailableReason ?? "unavailable",
        });
      }
    }
    return res.refs.map((ref) => ({
      other: {
        kind: "record",
        table: ref.table,
        sys_id: ref.sys_id,
        name: ref.name,
      },
      via: "structural",
      field: ref.field,
      source: ref.kind,
    }));
  } catch (error) {
    graph.fail(node.id, "structural", error);
    return [];
  }
}

/** Tables whose records UIB macroponents use (N-28 inbound). */
const UIB_USED_TABLES = new Set([
  UIB_MACROPONENT,
  "sys_ux_lib_component",
  ...BROKER_TABLE_NAMES,
]);

const UIB_CAVEAT =
  "UI Builder users are read with a LIKE query on the macroponent composition / data and client script text, re-checked after decoding; a component is matched by the id its composition elements carry (assumed to be a sys_ux_macroponent sys_id, unverified until a live instance confirms it).";

/** One bounded LIKE read; failures go to `unavailable`. */
async function likeRead(
  node: DependencyNode,
  table: string,
  query: string,
  fields: string[],
  limit: number,
  graph: Graph,
): Promise<SnRecord[]> {
  try {
    const res = await queryTable({
      table,
      query,
      fields,
      displayValue: "false",
      limit,
    });
    return res.records;
  } catch (error) {
    graph.fail(node.id, `${table}.${query.split("LIKE")[0]}`, error);
    return [];
  }
}

/**
 * N-28 — the UIB macroponents that use a macroponent, component or data
 * broker (composition / data) or import a client script include (inbound).
 */
async function uibUsers(
  node: DependencyNode,
  limit: number,
  graph: Graph,
): Promise<FoundEdge[]> {
  const out: FoundEdge[] = [];
  const table = node.table ?? "";
  if (table === UIB_INCLUDE) {
    const name = node.name.trim();
    if (!name) return [];
    assertNoCaret(name, "name");
    graph.caveats.add(UIB_CAVEAT);
    const rows = await likeRead(
      node,
      UIB_CLIENT_SCRIPT,
      `scriptLIKE${name}`,
      ["sys_id", "name", "macroponent", "script"],
      limit,
      graph,
    );
    for (const row of rows) {
      if (!uibImports(snString(row.script)).includes(name)) continue;
      const macro = snString(row.macroponent);
      out.push({
        other: SYS_ID.test(macro)
          ? {
              kind: "record",
              table: UIB_MACROPONENT,
              type: "uib_macroponent",
              sys_id: macro,
            }
          : {
              kind: "record",
              table: UIB_CLIENT_SCRIPT,
              type: "uib_client_script",
              sys_id: snString(row.sys_id),
              name: snString(row.name),
            },
        via: "script",
        field: "script",
        source: UIB_CLIENT_SCRIPT,
      });
    }
    return out;
  }
  if (!UIB_USED_TABLES.has(table) || !node.sys_id) return [];
  const id = node.sys_id;
  graph.caveats.add(UIB_CAVEAT);
  const broker = table !== UIB_MACROPONENT && table !== "sys_ux_lib_component";
  const column = broker ? "data" : "composition";
  const rows = await likeRead(
    node,
    UIB_MACROPONENT,
    `${column}LIKE${id}`,
    ["sys_id", "name", column],
    limit,
    graph,
  );
  for (const row of rows) {
    const rowId = snString(row.sys_id);
    if (!rowId || rowId === id) continue;
    const uses = macroponentUses(row);
    const hit = broker
      ? uses.brokers.some((b) => b.id === id)
      : uses.components.some((c) => c.id === id);
    if (!hit) continue;
    out.push({
      other: {
        kind: "record",
        table: UIB_MACROPONENT,
        type: "uib_macroponent",
        sys_id: rowId,
        ...(snString(row.name) ? { name: snString(row.name) } : {}),
      },
      via: broker ? "data_broker" : "composition",
      field: column,
    });
  }
  return out;
}

/** Every inbound edge of a node. */
async function inboundEdges(
  node: DependencyNode,
  limit: number,
  graph: Graph,
): Promise<FoundEdge[]> {
  const out = await reverseEdges(node, limit, graph);
  out.push(...(await uibUsers(node, limit, graph)));
  if (node.kind === "script" && node.name) {
    out.push(...(await scriptUsers(node, node.name, limit, graph)));
    out.push(...(await structuralUsers(node, "script", limit, graph)));
  } else if (node.kind === "table" && node.name) {
    out.push(...(await structuralUsers(node, "table", limit, graph)));
  }
  return out;
}

/** Result of {@link artifactDependencies}. */
export interface DependencyResult {
  artifactType: string;
  table: string;
  verified: boolean;
  caveat?: string;
  sys_id?: string;
  name?: string;
  root: string | null;
  direction: DependencyDirection;
  depth: number;
  count: { nodes: number; edges: number; outbound: number; inbound: number };
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  truncated?: boolean;
  unavailable?: DependencyUnavailable[];
  caveats?: string[];
  degraded?: { status: number; reason: string };
  available?: boolean;
  [key: string]: unknown;
}

/**
 * Build the dependency graph of one artefact. The root is read with the
 * artefact tools' own rules (exactly one of `sys_id` / `key`); a degraded read
 * of an unverified type answers an empty graph with `degraded`.
 */
export async function artifactDependencies(
  opts: DependencyOptions,
): Promise<DependencyResult> {
  const t = resolveArtifactType(opts.artifactType);
  const direction = opts.direction ?? "both";
  const depth = Math.min(
    Math.max(1, opts.depth ?? DEPENDENCY_DEPTH.default),
    DEPENDENCY_DEPTH.max,
  );
  const limit = Math.min(
    Math.max(1, opts.limit ?? DEPENDENCY_LIMIT.default),
    DEPENDENCY_LIMIT.max,
  );
  const artifact = await getArtifactFor(t, {
    ...(opts.sys_id !== undefined ? { sys_id: opts.sys_id } : {}),
    ...(opts.key !== undefined ? { key: opts.key } : {}),
  });
  const head = {
    artifactType: t.type,
    table: t.table,
    verified: t.verified,
    ...(typeof artifact.caveat === "string" ? { caveat: artifact.caveat } : {}),
  };
  if (!artifact.record) {
    return {
      ...head,
      root: null,
      direction,
      depth,
      count: { nodes: 0, edges: 0, outbound: 0, inbound: 0 },
      nodes: [],
      edges: [],
      ...(artifact.degraded
        ? { degraded: artifact.degraded as { status: number; reason: string } }
        : {}),
      ...(typeof artifact.available === "boolean"
        ? { available: artifact.available }
        : {}),
    };
  }

  const graph = new Graph();
  const sysId = snString(artifact.sys_id);
  const name = snString(artifact.name);
  const root = graph.add(
    { kind: "record", type: t.type, table: t.table, sys_id: sysId, name },
    0,
    "root",
  )!.node;
  const loaded = new Map<string, Loaded | undefined>([
    [root.id, { t, artifact }],
  ]);

  const walk = async (dir: "outbound" | "inbound") => {
    const visited = new Set<string>([root.id]);
    let frontier: DependencyNode[] = [root];
    for (let level = 1; level <= depth && frontier.length; level++) {
      const next: DependencyNode[] = [];
      for (const node of frontier) {
        throwIfCancelled();
        let found: FoundEdge[];
        if (dir === "outbound") {
          if (!loaded.has(node.id)) {
            loaded.set(node.id, await loadNode(node, graph));
          }
          const l = loaded.get(node.id);
          found = l ? outboundEdges(l.t, l.artifact) : [];
        } else {
          if (node.kind === "script" && !node.sys_id && !loaded.has(node.id)) {
            // Resolve the name to a record, so reverse refFields apply too.
            loaded.set(node.id, await loadNode(node, graph));
          }
          found = await inboundEdges(node, limit, graph);
        }
        for (const f of found) {
          const far = graph.add(f.other, level, dir);
          if (!far) continue;
          if (far.node.id === node.id) continue;
          graph.link({
            from: dir === "outbound" ? node.id : far.node.id,
            to: dir === "outbound" ? far.node.id : node.id,
            via: f.via,
            field: f.field,
            ...(f.source ? { source: f.source } : {}),
          });
          if (!visited.has(far.node.id)) {
            visited.add(far.node.id);
            next.push(far.node);
          }
        }
      }
      frontier = next;
    }
  };
  if (direction !== "inbound") await walk("outbound");
  if (direction !== "outbound") await walk("inbound");
  throwIfCancelled();

  const nodes = [...graph.nodes.values()];
  const edges = [...graph.edges.values()];
  return {
    ...head,
    sys_id: sysId,
    name,
    root: root.id,
    direction,
    depth,
    count: {
      nodes: nodes.length,
      edges: edges.length,
      outbound: edges.filter((e) => e.from === root.id).length,
      inbound: edges.filter((e) => e.to === root.id).length,
    },
    nodes,
    edges,
    ...(graph.truncated ? { truncated: true } : {}),
    ...(graph.unavailable.length ? { unavailable: graph.unavailable } : {}),
    ...(graph.caveats.size ? { caveats: [...graph.caveats] } : {}),
  };
}

function shapeOf(node: DependencyNode): Shape {
  if (node.kind === "table") return "db";
  if (node.kind === "script") return "input";
  return "rect";
}

/** Solid arrows for references, dotted for edges read from code or JSON. */
function arrowOf(edge: DependencyEdge): Arrow {
  return edge.via === "reference" ? "-->" : "-.->";
}

/**
 * A `graph LR` Mermaid diagram of a dependency result (pure): one node per
 * graph node (capped by SN_DIAGRAM_MAX_NODES), an arrow from each dependent
 * to what it depends on, labelled with the field. Returns the nodes the cap
 * dropped as `truncated`.
 */
export function dependencyMermaid(result: DependencyResult): {
  mermaid: string;
  truncated: number;
} {
  const doc = new MermaidDoc("graph LR");
  const ids = new Map<string, string>();
  result.nodes.forEach((node, i) => {
    const id = `n${i}`;
    const kind = node.type ?? node.table ?? node.kind;
    const text = label(
      `${node.id === result.root ? "* " : ""}${kind}: ${node.name || node.sys_id || node.id}`,
      LABEL_CHARS,
    );
    if (doc.node(id, text, shapeOf(node))) ids.set(node.id, id);
  });
  for (const edge of result.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (!from || !to) continue;
    doc.line(`${from} ${arrowOf(edge)}|"${label(edge.field, 40)}"| ${to}`);
  }
  return { mermaid: doc.render(), truncated: doc.truncated };
}
