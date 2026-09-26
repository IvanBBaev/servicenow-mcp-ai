import { ServiceNowError } from "../core/errors.js";
import { getDiagramMaxNodes } from "../core/settings.js";
import {
  traceTableFlow,
  type TableFlowEntry,
  type TableOperation,
  type TraceLane,
} from "./flows.js";
import {
  erEntity,
  erRelation,
  ident,
  label,
  MermaidDoc,
  type ErAttribute,
} from "./mermaid.js";
import { describeTable, getTableChain, type ColumnInfo } from "./meta.js";

/**
 * Deterministic Mermaid diagram generators. They read the instance's own
 * metadata (sys_dictionary references, business rules) and emit Mermaid markup
 * directly, so the diagrams reflect the real instance and do not depend on the
 * model guessing structure. All markup goes through `./mermaid.js` (S-14).
 */

/** Which columns an ER entity shows. */
export type ErColumns = "all" | "own" | "keys";

export interface ErDiagramOptions {
  /**
   * `all` (every column of the chain), `own` (columns defined on the table
   * itself) or `keys` (sys_id, references and mandatory columns).
   */
  columns?: ErColumns;
  /** Columns per entity before the rest fold into one `+N` line (40). */
  max_columns?: number;
  /** Follow references this many levels, adding each target as `keys` (0). */
  depth?: 0 | 1 | 2;
}

export const DEFAULT_ER_MAX_COLUMNS = 40;

export interface ErDiagram {
  tables: string[];
  mermaid: string;
  /** Tables added by `depth` (absent without it). */
  added?: string[];
  /** Referenced tables left out by `SN_DIAGRAM_MAX_NODES`. */
  truncated?: number;
}

function hasOptions(opts: ErDiagramOptions): boolean {
  return (
    opts.columns !== undefined ||
    opts.max_columns !== undefined ||
    opts.depth !== undefined
  );
}

/**
 * Build a Mermaid `erDiagram` for the given tables: an entity per table with
 * its columns, plus a many-to-one relationship for every reference field.
 *
 * Without options the output is exactly the 2.x one (every column, no
 * markers). Passing any option switches on the detailed rendering (ID-05):
 * `PK` / `FK` keys, `"required"` / `"inherited from X"` comments, the
 * `max_columns` fold, `depth` expansion over references and an `extends`
 * edge between members of one inheritance chain.
 */
export async function generateErDiagram(
  tables: string[],
  opts: ErDiagramOptions = {},
): Promise<ErDiagram> {
  if (!tables?.length) {
    throw new ServiceNowError("Provide at least one table.", 400);
  }
  if (!hasOptions(opts)) return legacyEr(tables);
  return detailedEr(tables, opts);
}

async function legacyEr(tables: string[]): Promise<ErDiagram> {
  const lines = ["erDiagram"];
  const relationships: string[] = [];
  for (const table of tables) {
    const columns = await describeTable(table);
    lines.push(
      ...erEntity(
        table,
        columns
          .filter((col) => ident(col.element))
          .map((col) => ({ type: col.type || "string", name: col.element })),
      ),
    );
    for (const col of columns) {
      if (col.reference) {
        relationships.push(
          erRelation(table, "}o--||", col.reference, col.element),
        );
      }
    }
  }
  return { tables, mermaid: [...lines, ...relationships].join("\n") };
}

/** Whether a column is a key: sys_id, a reference or a mandatory column. */
function isKey(col: ColumnInfo): boolean {
  return col.element === "sys_id" || !!col.reference || !!col.mandatory;
}

function selectColumns(
  table: string,
  columns: ColumnInfo[],
  mode: ErColumns,
): ColumnInfo[] {
  const named = columns.filter((col) => ident(col.element));
  if (mode === "own") {
    return named.filter((c) => !c.sourceTable || c.sourceTable === table);
  }
  if (mode === "keys") return named.filter(isKey);
  return named;
}

function attribute(table: string, col: ColumnInfo): ErAttribute {
  const keys: ErAttribute["keys"] = [];
  if (col.element === "sys_id") keys.push("PK");
  if (col.reference) keys.push("FK");
  const notes: string[] = [];
  if (col.mandatory) notes.push("required");
  if (col.sourceTable && col.sourceTable !== table) {
    notes.push(`inherited from ${col.sourceTable}`);
  }
  return {
    type: col.type || "string",
    name: col.element,
    keys,
    comment: notes.join(", ") || undefined,
  };
}

async function detailedEr(
  tables: string[],
  opts: ErDiagramOptions,
): Promise<ErDiagram> {
  const mode = opts.columns ?? "all";
  const maxColumns = Math.max(
    1,
    Math.floor(opts.max_columns ?? DEFAULT_ER_MAX_COLUMNS),
  );
  const depth = Math.min(2, Math.max(0, Math.floor(opts.depth ?? 0)));
  const maxNodes = getDiagramMaxNodes();

  // Breadth-first over references: level 0 is the requested tables with the
  // requested columns, every later level shows keys only.
  const entities: Array<{ table: string; columns: ErColumns }> = [];
  const seen = new Set<string>();
  const added: string[] = [];
  let truncated = 0;
  let level = tables.filter((t) => {
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  });
  for (const t of level) entities.push({ table: t, columns: mode });
  const described = new Map<string, ColumnInfo[]>();
  for (let d = 1; d <= depth; d++) {
    const next: string[] = [];
    for (const t of level) {
      const cols = await describeTable(t);
      described.set(t, cols);
      for (const col of cols) {
        const ref = col.reference;
        if (!ref || seen.has(ref)) continue;
        seen.add(ref);
        if (entities.length >= maxNodes) {
          truncated++;
          continue;
        }
        entities.push({ table: ref, columns: "keys" });
        added.push(ref);
        next.push(ref);
      }
    }
    level = next;
  }

  const lines = ["erDiagram"];
  const relationships: string[] = [];
  for (const { table, columns } of entities) {
    const all = described.get(table) ?? (await describeTable(table));
    const chosen = selectColumns(table, all, columns);
    // Keys survive the fold first; the entity keeps dictionary order.
    let shown = chosen;
    let folded = 0;
    if (chosen.length > maxColumns) {
      const keep = new Set(
        [...chosen.filter(isKey), ...chosen.filter((c) => !isKey(c))].slice(
          0,
          maxColumns,
        ),
      );
      shown = chosen.filter((c) => keep.has(c));
      folded = chosen.length - shown.length;
    }
    const attrs = shown.map((c) => attribute(table, c));
    if (folded > 0) {
      attrs.push({
        type: "string",
        name: "more_columns",
        comment: `… +${folded}`,
      });
    }
    lines.push(...erEntity(table, attrs));
    for (const col of shown) {
      if (col.reference) {
        relationships.push(
          erRelation(table, "}o--||", col.reference, col.element),
        );
      }
    }
  }

  // `extends` from the nearest ancestor that is also drawn.
  const drawn = new Set(entities.map((e) => e.table));
  for (const { table } of entities) {
    let chain: string[];
    try {
      chain = await getTableChain(table);
    } catch {
      continue;
    }
    const parent = chain.slice(1).find((p) => drawn.has(p));
    if (parent)
      relationships.push(erRelation(parent, "||--||", table, "extends"));
  }

  const result: ErDiagram = {
    tables,
    mermaid: [...lines, ...relationships].join("\n"),
  };
  if (depth > 0) result.added = added;
  if (truncated > 0) result.truncated = truncated;
  return result;
}

/** Lane order of a table flow (ID-06); unknown phases follow in data order. */
const LANE_ORDER = [
  "transform_map",
  "scheduled_job",
  "display",
  "client",
  "data_policy",
  "before",
  "database",
  "after",
  "async",
  "sla",
  "flow",
  "workflow",
  "notification",
  "event_script",
];

/** Lane titles for the non-business-rule phases. */
const LANE_TITLE: Record<string, string> = {
  transform_map: "transform maps",
  scheduled_job: "scheduled jobs",
  client: "client scripts and UI policies",
  data_policy: "data policies",
  sla: "SLA definitions",
  flow: "flows",
  workflow: "workflows",
  notification: "notifications",
  event_script: "event script actions",
};

export interface TableFlowDiagram {
  table: string;
  tables: string[];
  count: number;
  mermaid: string;
  /** Present when the flow covers one operation. */
  operation?: TableOperation;
  /** The opt-in trace lanes drawn (S-5); absent when none was asked. */
  lanes?: TraceLane[];
  /** Best-effort section failures (operation flows and opt-in lanes). */
  warnings?: string[];
  /** Nodes left out by `SN_DIAGRAM_MAX_NODES`. */
  truncated?: number;
}

/**
 * Build a Mermaid `flowchart` of a record's lifecycle on a table from
 * `traceTableFlow` (S-14, ID-06): one subgraph per lane in execution order
 * (client → display → before → after → async → flows → workflows →
 * notifications), each entry chained in `order`. Artefacts inherited from
 * parent tables and global (`global=true`) rules run too (S-1), so each lane
 * lists the table's own entries first, then one nested lane per parent table
 * in chain order, then a lane for the global rules.
 *
 * Without `operation` the diagram is the 2.x lifecycle view — every active
 * business rule, grouped by `when`. With one it is the trace of that
 * operation, database write included. `lanes` (S-5) adds the opt-in trace
 * lanes (transform maps, scheduled jobs, client side, data policies, SLAs,
 * event script actions) to either view, each in its own subgraph.
 */
export async function generateTableFlow(
  table: string,
  opts: { operation?: TableOperation; lanes?: readonly TraceLane[] } = {},
): Promise<TableFlowDiagram> {
  const trace = await traceTableFlow(table, opts.operation, {
    lanes: opts.lanes,
  });
  const { table: t, tables, entries } = trace;

  const byPhase = new Map<string, TableFlowEntry[]>();
  for (const entry of entries) {
    const list = byPhase.get(entry.phase) ?? [];
    list.push(entry);
    byPhase.set(entry.phase, list);
  }
  const present = [
    ...LANE_ORDER.filter((p) => byPhase.has(p)),
    ...[...byPhase.keys()].filter((p) => !LANE_ORDER.includes(p)),
  ];

  const doc = new MermaidDoc("flowchart TD");
  const start = trace.operation ?? "insert / update";
  doc.node("op", `${start} on ${label(t)}`, "input", { pinned: true });
  let prev = "op";
  let nodeId = 0;

  /** Emit one `-->` chain of entry nodes; returns the last node id, if any. */
  const emitChain = (list: TableFlowEntry[]): string | undefined => {
    let prevNode: string | undefined;
    for (const entry of list) {
      const id = `n${nodeId++}`;
      const ord =
        entry.order_text !== undefined ? ` (${label(entry.order_text)})` : "";
      if (!doc.node(id, `${label(entry.name)}${ord}`)) continue;
      if (prevNode) doc.edge(prevNode, id);
      prevNode = id;
    }
    return prevNode;
  };

  for (const phase of present) {
    if (phase === "database") {
      doc.node("db", "database write", "db", { pinned: true });
      doc.edge(prev, "db");
      prev = "db";
      continue;
    }
    const sub = `P_${ident(phase)}`;
    doc.open(sub, LANE_TITLE[phase] ?? `${label(phase)} business rules`, "TB");

    // Split the phase into the table's own entries, one lane per parent
    // table (pre-seeded in chain order; an unexpected table lands after
    // them) and the global lane.
    const own: TableFlowEntry[] = [];
    const parents = new Map<string, TableFlowEntry[]>(
      tables.slice(1).map((parent) => [parent, []]),
    );
    const globals: TableFlowEntry[] = [];
    for (const entry of byPhase.get(phase) ?? []) {
      if (entry.global) {
        globals.push(entry);
      } else if (!entry.inherited_from) {
        own.push(entry);
      } else {
        let lane = parents.get(entry.inherited_from);
        if (!lane) {
          lane = [];
          parents.set(entry.inherited_from, lane);
        }
        lane.push(entry);
      }
    }

    let prevLane = emitChain(own);
    const lanes: Array<[string, string, TableFlowEntry[]]> = [
      ...[...parents].map(
        ([parent, list]): [string, string, TableFlowEntry[]] => [
          `${sub}_${ident(parent)}`,
          `inherited from ${label(parent)}`,
          list,
        ],
      ),
      [`${sub}_global`, "global", globals],
    ];
    for (const [laneId, title, list] of lanes) {
      if (list.length === 0) continue;
      doc.open(laneId, title, "TB");
      emitChain(list);
      doc.close();
      if (prevLane) doc.edge(prevLane, laneId);
      prevLane = laneId;
    }

    doc.close();
    doc.edge(prev, sub);
    prev = sub;
  }
  doc.edgeTo(prev, "done", "record saved", {
    shape: "terminal",
    pinned: true,
  });

  const result: TableFlowDiagram = {
    table: t,
    tables,
    count: trace.count,
    mermaid: doc.render(),
  };
  if (trace.operation) result.operation = trace.operation;
  if (trace.lanes) result.lanes = trace.lanes;
  if (trace.operation || trace.warnings.length > 0) {
    result.warnings = trace.warnings;
  }
  if (doc.truncated > 0) result.truncated = doc.truncated;
  return result;
}
