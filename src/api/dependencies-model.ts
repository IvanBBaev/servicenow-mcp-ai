/**
 * P-17 — `get_artifact_dependencies` model: the walk bounds and the node, edge
 * and result shapes. Import from dependencies.ts.
 */

import type { ArtifactRef } from "./artifacts.js";

/** Levels walked from the root (default / max). */
export const DEPENDENCY_DEPTH = { default: 1, max: 3 } as const;

/** Rows each inbound source read keeps (default / max). */
export const DEPENDENCY_LIMIT = { default: 25, max: 100 } as const;

/** Nodes a graph holds; reaching it marks the result `truncated`. */
export const MAX_GRAPH_NODES = 150;

/** JSON leaves one decoded field is walked for. */
export const JSON_WALK_LIMIT = 5000;

/** Label characters kept per Mermaid node. */
export const LABEL_CHARS = 60;

/** Platform and client classes that are not script-include references. */
export const NOT_A_DEPENDENCY = new Set([
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
export const TABLE_KEYS = new Set([
  "table",
  "table_name",
  "tableName",
  "reference",
  "referenced_table",
]);

export const TABLE_NAME = /^[a-z][a-z0-9_]{1,79}$/;

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
export interface NodeSpec {
  kind: DependencyNode["kind"];
  type?: string;
  table?: string;
  sys_id?: string;
  name?: string;
}

/** One edge found for a node, before the far end is added to the graph. */
export interface FoundEdge {
  other: NodeSpec;
  via: EdgeVia;
  field: string;
  source?: string;
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
