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
 *
 * Layout: dependencies-model.ts holds the bounds and the node / edge / result
 * shapes; dependencies-graph.ts the canonical node ids and the `Graph`
 * collector (node cap, edge de-duplication, degraded sources);
 * dependencies-outbound.ts the descriptor-driven outbound edges;
 * dependencies-inbound.ts the reverse queries; dependencies-render.ts the
 * Mermaid view. This module loads nodes and walks the graph.
 */

import {
  getArtifactType,
  type ArtifactType,
} from "../core/artifacts/registry.js";
import { throwIfCancelled } from "../core/progress.js";
import { getArtifactFor, resolveArtifactType } from "./artifacts.js";
import { assertNoCaret, snString } from "./shared.js";
import { queryTable } from "./table.js";
import {
  type DependencyNode,
  type DependencyOptions,
  type DependencyResult,
  DEPENDENCY_DEPTH,
  DEPENDENCY_LIMIT,
  type FoundEdge,
} from "./dependencies-model.js";
import { Graph } from "./dependencies-graph.js";
import { outboundEdges } from "./dependencies-outbound.js";
import { inboundEdges } from "./dependencies-inbound.js";

export {
  DEPENDENCY_DEPTH,
  DEPENDENCY_LIMIT,
  MAX_GRAPH_NODES,
} from "./dependencies-model.js";
export type {
  DependencyDirection,
  EdgeVia,
  DependencyNode,
  DependencyEdge,
  DependencyUnavailable,
  DependencyOptions,
  DependencyResult,
} from "./dependencies-model.js";

export { jsonTargets, outboundEdges } from "./dependencies-outbound.js";

export { dependencyMermaid } from "./dependencies-render.js";

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
