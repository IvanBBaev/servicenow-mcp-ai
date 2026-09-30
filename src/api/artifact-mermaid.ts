import {
  explainFlow,
  flowMermaid,
  type ExplainFlowKind,
} from "./explain-flow.js";
import { explainPortal, portalMermaid } from "./portal.js";
import { explainUiExperience, uiExperienceMermaid } from "./ui-experience.js";
import { unifiedDiff } from "./unified-diff.js";
import { snString } from "./shared.js";
import type { ArtifactRow } from "./artifact-snapshot.js";

/**
 * P-20 — Mermaid graphs diffed as text. For the registry types that have a
 * diagram (flows, subflows, actions, workflows, playbooks, portals, portal
 * pages, UI Builder experiences) compare_instances can render each side of a
 * changed record with the existing explainer + Mermaid builder and show a
 * unified diff of the two sources. Opt-in (`mermaid:true`), bounded by
 * MERMAID_DIFFS_MAX records and MERMAID_DIFF_LINES lines per diff, and
 * informational: a Mermaid diff never counts as drift of its own.
 */

/** Changed records whose diagrams are rendered and diffed per comparison. */
export const MERMAID_DIFFS_MAX = 10;

/** Output lines kept per Mermaid diff (the rest is cut with a marker). */
export const MERMAID_DIFF_LINES = 120;

type Render = (row: ArtifactRow) => Promise<{
  mermaid: string;
  truncated: number;
}>;

const flowKind =
  (kind: ExplainFlowKind): Render =>
  async (row) =>
    flowMermaid(
      await explainFlow({ sys_id: row.sys_id, kind, runs: 0, depth: 0 }),
    );

/** Diagram renderer per registry type (the ones with a Mermaid builder). */
const RENDERERS: Record<string, Render> = {
  // `flow` lists flows and subflows (one table); render each as it is.
  flow: async (row) =>
    flowKind(snString(row.fields.type) === "subflow" ? "subflow" : "flow")(row),
  subflow: flowKind("subflow"),
  flow_action: flowKind("action"),
  workflow: flowKind("workflow"),
  playbook: flowKind("playbook"),
  sp_portal: async (row) =>
    portalMermaid(await explainPortal({ portal: row.sys_id })),
  sp_page: async (row) =>
    portalMermaid(await explainPortal({ page: row.sys_id })),
  workspace: async (row) =>
    uiExperienceMermaid(await explainUiExperience({ sys_id: row.sys_id })),
};

/** Registry types whose changed records can be diffed as Mermaid. */
export const MERMAID_TYPES: readonly string[] = Object.keys(RENDERERS).sort();

/** True when `type` has a Mermaid rendering. */
export function hasMermaid(type: string): boolean {
  return Object.hasOwn(RENDERERS, type);
}

/** Render one record of `type` as Mermaid (in the current profile context). */
export async function renderArtifactMermaid(
  type: string,
  row: ArtifactRow,
): Promise<{ mermaid: string; truncated: number }> {
  const render = RENDERERS[type];
  if (!render) throw new Error(`No Mermaid rendering for type '${type}'.`);
  return render(row);
}

/** A changed record's two diagrams, diffed as text. */
export interface MermaidDiff {
  type: string;
  key: string;
  /** Unified diff a → b of the Mermaid sources (capped, see MERMAID_DIFF_LINES). */
  diff: string;
  /** True when the diff was cut at MERMAID_DIFF_LINES. */
  cut?: boolean;
  /**
   * Nodes the diagram builder dropped per side (SN_DIAGRAM_MAX_NODES); the
   * diff then covers the rendered part only.
   */
  nodesTruncated?: { a: number; b: number };
}

/** Diff two Mermaid sources; undefined when they are identical. */
export function mermaidDiff(
  type: string,
  key: string,
  a: { label: string; mermaid: string; truncated: number },
  b: { label: string; mermaid: string; truncated: number },
): MermaidDiff | undefined {
  const diff = unifiedDiff(
    a.mermaid,
    b.mermaid,
    a.label,
    b.label,
    MERMAID_DIFF_LINES,
  );
  if (!diff) return undefined;
  return {
    type,
    key,
    diff,
    ...(/\n… \d+ more line\(s\)$/.test(diff) ? { cut: true } : {}),
    ...(a.truncated || b.truncated
      ? { nodesTruncated: { a: a.truncated, b: b.truncated } }
      : {}),
  };
}
