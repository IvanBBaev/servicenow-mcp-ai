/**
 * P-17 — dependency graph primitives: canonical node ids and the `Graph`
 * collector (node cap, edge de-duplication, per-source degradation).
 * Import from dependencies.ts.
 */

import { rethrowIfCancelled } from "../core/errors.js";
import {
  type NodeSpec,
  type DependencyNode,
  type DependencyEdge,
  type DependencyUnavailable,
  MAX_GRAPH_NODES,
} from "./dependencies-model.js";

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

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The dependency graph under construction. */
export class Graph {
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
    rethrowIfCancelled(error);
    this.unavailable.push({ node, source, reason: reasonOf(error) });
  }
}
