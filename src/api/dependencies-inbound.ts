/**
 * P-17 — inbound dependency edges, from bounded reverse queries: registry
 * `refFields` read backwards, script-text search, flow step values, the S-9
 * structural pass and the N-28 UI Builder usage reads. Import from
 * dependencies.ts.
 */

import { ARTIFACT_TYPES, getArtifactType } from "../core/artifacts/registry.js";
import { decodeField } from "../core/artifacts/decoders.js";
import {
  REFERENCE_SOURCES,
  findStructuralReferences,
  parseRefTarget,
} from "./references.js";
import { searchCode } from "./scripts.js";
import {
  BROKER_TABLE_NAMES,
  macroponentUses,
  uibImports,
  uibIncludeIds,
} from "./uib-usage.js";
import { assertNoCaret, snString } from "./shared.js";
import { queryTable, type SnRecord } from "./table.js";
import { isSysId } from "../core/sys-id.js";
import type {
  DependencyNode,
  FoundEdge,
  NodeSpec,
} from "./dependencies-model.js";
import { Graph } from "./dependencies-graph.js";
import {
  jsonTargets,
  scriptTargets,
  UIB_MACROPONENT,
  UIB_INCLUDE,
  UIB_CLIENT_SCRIPT,
} from "./dependencies-outbound.js";

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
      if (s.parent && isSysId(parentId)) {
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
      if (!isSysId(flow)) continue;
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
    const id = node.sys_id ?? "";
    if (!name && !isSysId(id)) return [];
    if (name) assertNoCaret(name, "name");
    graph.caveats.add(UIB_CAVEAT);
    const user = (row: SnRecord): NodeSpec => {
      const macro = snString(row.macroponent);
      return isSysId(macro)
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
          };
    };
    if (name) {
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
        out.push({
          other: user(row),
          via: "script",
          field: "script",
          source: UIB_CLIENT_SCRIPT,
        });
      }
    }
    if (isSysId(id)) {
      // O-5: the `includes` glide_list is unverified.
      const rows = await likeRead(
        node,
        UIB_CLIENT_SCRIPT,
        `includesLIKE${id}`,
        ["sys_id", "name", "macroponent", "includes"],
        limit,
        graph,
      );
      for (const row of rows) {
        if (!uibIncludeIds(snString(row.includes)).includes(id)) continue;
        out.push({
          other: user(row),
          via: "reference",
          field: "includes",
          source: UIB_CLIENT_SCRIPT,
        });
      }
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
export async function inboundEdges(
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
