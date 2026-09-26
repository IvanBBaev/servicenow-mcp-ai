import { searchCode, tableLogic } from "./scripts.js";
import { label, MermaidDoc } from "./mermaid.js";
import {
  findStructuralReferences,
  parseRefTarget,
  type StructuralRef,
  type StructuralRefs,
} from "./references.js";

/**
 * DF-4 — where-used / impact graph. Answers "where is this table / field /
 * script referenced?", the IDE-grade navigation ServiceNow has never offered.
 * Read-only: it reuses the script-intelligence readers — a textual search across
 * every script source, plus (for a table) the automation directly attached to
 * it (business rules, client scripts, UI policies/actions, ACLs). S-9 adds a
 * structural pass (src/api/references.ts) over configuration that names the
 * target without script text: dictionary references, list / form layouts,
 * catalog variables, flow action inputs and report conditions.
 */

export type WhereUsedKind = "table" | "field" | "script";

export interface UsageRef {
  /** Artefact type, e.g. business_rule / script_include / client_script. */
  type: string;
  sys_id: string;
  name: string;
  field?: string;
  line?: number;
  /**
   * Every matching line of a "references" entry (S-4), capped at
   * {@link HITS_PER_REF} per artefact; `hitCount` keeps the full total.
   */
  hits?: { field: string; line: number; text: string }[];
  hitCount?: number;
  /** "references" = mentioned in source; "attached_to" = runs on the table. */
  relation: "references" | "attached_to";
}

export interface WhereUsed {
  kind: WhereUsedKind;
  name: string;
  count: number;
  byType: Record<string, number>;
  references: UsageRef[];
  /**
   * What this answer cannot see (H-8 C-12): a where-used result is a textual
   * search as the connected user, so an empty or short list is not proof of
   * "unused". Always present; informational only.
   */
  caveats: string[];
  /**
   * S-9 structural references (dictionary, layouts, catalog variables, flow
   * inputs, reports), with per-source availability. Kept apart from
   * `references`, whose `count` / `byType` are unchanged. Absent when the
   * caller passed `structural: false`.
   */
  structural?: StructuralRefs;
  mermaid?: string;
  /** Graph nodes left out by SN_DIAGRAM_MAX_NODES (ID-26); absent when none. */
  mermaidTruncated?: number;
}

/** Match cap passed to the code search; reaching it means the list is partial. */
const SEARCH_LIMIT = 200;

/**
 * Matching lines kept per referencing artefact. Lower than the search_code cap
 * and without context lines: a where-used answer can list up to 200 artefacts.
 */
export const HITS_PER_REF = 5;

/** Extra inputs to {@link whereUsedCaveats}; all optional. */
export interface WhereUsedCaveatOptions {
  /** Application scope the search was restricted to. */
  scope?: string;
  /** Artefact types skipped because they could not be read. */
  unreadable?: string[];
  /** The structural pass (S-9) ran alongside the textual search. */
  structural?: boolean;
  /** Structural source tables whose read stopped at its row limit. */
  truncatedSources?: string[];
}

/** Build the caveats for a where-used answer (H-8 C-12). */
export function whereUsedCaveats(
  kind: WhereUsedKind,
  name: string,
  searchHits: number,
  extra: WhereUsedCaveatOptions = {},
): string[] {
  const caveats = [
    extra.structural
      ? "Textual search of script sources plus a structural pass over dictionary references, list and form layouts, catalog variables, flow action inputs and report conditions (see structural.sources): names built at runtime (string concatenation, variables, GlideRecord(table) from a property) and references in other non-script fields (flow step values, workflow activities, UI policy and notification conditions) are not found."
      : "Textual search only: names built at runtime (string concatenation, variables, GlideRecord(table) from a property) and references in non-script fields (conditions, flows, workflows, reports) are not found.",
    "Only records the connected user can read are searched — ACLs and domain separation can hide referencing artefacts, so an empty result is not proof that nothing uses it.",
    "Cross-scope: artefacts in other application scopes are included when readable, but runtime cross-scope access is governed by application access settings and cross-scope privileges (sys_scope_privilege), which this search does not evaluate.",
  ];
  const scoped = /^(x_|sn_)[a-z0-9]+_/i.test(name);
  if (scoped) {
    caveats.push(
      `"${name}" is a scoped name: scripts inside its own scope may reference it without the scope prefix, and those unprefixed references are not matched.`,
    );
  }
  if (kind === "table") {
    caveats.push(
      "Attached automation lists only artefacts registered on this exact table — rules inherited from parent tables (e.g. task) are not included; servicenow_trace_table_event and servicenow_generate_table_flow show inherited and global business rules.",
    );
  }
  if (searchHits >= SEARCH_LIMIT) {
    caveats.push(
      `The code search stopped at ${SEARCH_LIMIT} matches — the reference list is partial.`,
    );
  }
  if (extra.scope) {
    caveats.push(
      `Restricted to application scope "${extra.scope}": references from every other scope (including global) are left out.`,
    );
  }
  if (extra.unreadable?.length) {
    caveats.push(
      `Not searched — table missing or not readable for the connected user: ${[...new Set(extra.unreadable)].join(", ")}.`,
    );
  }
  if (extra.truncatedSources?.length) {
    caveats.push(
      `The structural pass stopped early on ${[...new Set(extra.truncatedSources)].join(", ")} — its structural references may be partial.`,
    );
  }
  return caveats;
}

function nodeId(ref: { sys_id: string; name: string }): string {
  return ("n_" + (ref.sys_id || ref.name))
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .slice(0, 48);
}

/**
 * Graph edges: script references and attached automation, then structural
 * refs. The size is bounded by SN_DIAGRAM_MAX_NODES alone (ID-26): nodes past
 * it fold into one "+N more" node and the count is reported.
 */
function buildMermaid(
  target: string,
  refs: UsageRef[],
  structural: StructuralRef[] = [],
): { mermaid: string; truncated: number } {
  const doc = new MermaidDoc("graph LR");
  doc.node("T", label(target, 60), "rect", { pinned: true });
  const seen = new Set<string>();
  const edges = [
    ...refs.map((r) => ({
      id: nodeId(r),
      text: `${r.type}: ${r.name}`,
      solid: r.relation === "attached_to",
    })),
    ...structural.map((r) => ({
      id: nodeId(r),
      text: `${r.kind}: ${r.name}`,
      solid: false,
    })),
  ];
  for (const e of edges) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    doc.edgeTo("T", e.id, label(e.text, 60), {
      arrow: e.solid ? "-->" : "-.->",
    });
  }
  return { mermaid: doc.render(), truncated: doc.truncated };
}

/**
 * Find references to `name` of the given `kind`. `field` and `script` rely on
 * the textual code search; `table` additionally lists the artefacts attached to
 * the table. Every kind also runs the S-9 structural pass unless `structural`
 * is `false`. Pass `mermaid` to also get a reference graph.
 */
export async function whereUsed(
  kind: WhereUsedKind,
  name: string,
  opts: { mermaid?: boolean; scope?: string; structural?: boolean } = {},
): Promise<WhereUsed> {
  const references: UsageRef[] = [];
  const scope = opts.scope?.trim() || undefined;

  // Textual references in script source (any artefact type).
  const { matches, unreadable = [] } = await searchCode({
    text: name,
    limit: SEARCH_LIMIT,
    maxHits: HITS_PER_REF,
    ...(scope ? { scope } : {}),
  });
  const skipped = [...unreadable];
  for (const m of matches) {
    references.push({
      type: m.type,
      sys_id: m.sys_id,
      name: m.name,
      field: m.field,
      line: m.line,
      hits: m.hits.map(({ field, line, text }) => ({ field, line, text })),
      hitCount: m.hitCount,
      relation: "references",
    });
  }

  // A table also has automation directly attached to it.
  if (kind === "table") {
    const logic = await tableLogic(name, scope ? { scope } : {});
    if (logic.unreadable) skipped.push(...logic.unreadable);
    const groups: [string, { sys_id: string; name: string }[]][] = [
      ["business_rule", logic.businessRules],
      ["client_script", logic.clientScripts],
      ["ui_policy", logic.uiPolicies],
      ["ui_action", logic.uiActions],
      ["acl", logic.acls],
    ];
    for (const [type, entries] of groups) {
      for (const e of entries) {
        if (!e.sys_id) continue;
        references.push({
          type,
          sys_id: e.sys_id,
          name: e.name ?? "",
          relation: "attached_to",
        });
      }
    }
  }

  // S-9: configuration that names the target structurally.
  let structural: StructuralRefs | undefined;
  const truncatedSources: string[] = [];
  if (opts.structural !== false) {
    structural = await findStructuralReferences(parseRefTarget(kind, name), {
      ...(scope ? { scope } : {}),
    });
    for (const s of Object.values(structural.sources)) {
      if (!s.available) skipped.push(s.table);
      if (s.truncated) truncatedSources.push(s.table);
    }
  }

  const byType: Record<string, number> = {};
  for (const r of references) byType[r.type] = (byType[r.type] ?? 0) + 1;

  const result: WhereUsed = {
    kind,
    name,
    count: references.length,
    byType,
    references,
    caveats: whereUsedCaveats(kind, name, matches.length, {
      ...(scope ? { scope } : {}),
      ...(skipped.length ? { unreadable: skipped } : {}),
      ...(structural ? { structural: true } : {}),
      ...(truncatedSources.length ? { truncatedSources } : {}),
    }),
  };
  if (structural) result.structural = structural;
  if (opts.mermaid) {
    const graph = buildMermaid(
      `${kind}: ${name}`,
      references,
      structural?.refs,
    );
    result.mermaid = graph.mermaid;
    if (graph.truncated > 0) result.mermaidTruncated = graph.truncated;
  }
  return result;
}
