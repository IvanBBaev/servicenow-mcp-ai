import { searchCode, tableLogic } from "./scripts.js";

/**
 * DF-4 — where-used / impact graph. Answers "where is this table / field /
 * script referenced?", the IDE-grade navigation ServiceNow has never offered.
 * Read-only: it reuses the script-intelligence readers — a textual search across
 * every script source, plus (for a table) the automation directly attached to
 * it (business rules, client scripts, UI policies/actions, ACLs).
 */

export type WhereUsedKind = "table" | "field" | "script";

export interface UsageRef {
  /** Artefact type, e.g. business_rule / script_include / client_script. */
  type: string;
  sys_id: string;
  name: string;
  field?: string;
  line?: number;
  /** "references" = mentioned in source; "attached_to" = runs on the table. */
  relation: "references" | "attached_to";
}

export interface WhereUsed {
  kind: WhereUsedKind;
  name: string;
  count: number;
  byType: Record<string, number>;
  references: UsageRef[];
  mermaid?: string;
}

function nodeId(ref: UsageRef): string {
  return ("n_" + (ref.sys_id || ref.name))
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .slice(0, 48);
}

function buildMermaid(target: string, refs: UsageRef[]): string {
  const label = (s: string) => s.replaceAll('"', "'").slice(0, 60);
  const lines = ["graph LR", `  T["${label(target)}"]`];
  const seen = new Set<string>();
  for (const r of refs.slice(0, 40)) {
    const id = nodeId(r);
    if (seen.has(id)) continue;
    seen.add(id);
    const edge = r.relation === "attached_to" ? "-->" : "-.->";
    lines.push(`  T ${edge} ${id}["${label(`${r.type}: ${r.name}`)}"]`);
  }
  return lines.join("\n");
}

/**
 * Find references to `name` of the given `kind`. `field` and `script` rely on
 * the textual code search; `table` additionally lists the artefacts attached to
 * the table. Pass `mermaid` to also get a reference graph.
 */
export async function whereUsed(
  kind: WhereUsedKind,
  name: string,
  opts: { mermaid?: boolean } = {},
): Promise<WhereUsed> {
  const references: UsageRef[] = [];

  // Textual references in script source (any artefact type).
  const { matches } = await searchCode({ text: name, limit: 200 });
  for (const m of matches) {
    references.push({
      type: m.type,
      sys_id: m.sys_id,
      name: m.name,
      field: m.field,
      line: m.line,
      relation: "references",
    });
  }

  // A table also has automation directly attached to it.
  if (kind === "table") {
    const logic = await tableLogic(name);
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

  const byType: Record<string, number> = {};
  for (const r of references) byType[r.type] = (byType[r.type] ?? 0) + 1;

  const result: WhereUsed = {
    kind,
    name,
    count: references.length,
    byType,
    references,
  };
  if (opts.mermaid) {
    result.mermaid = buildMermaid(`${kind}: ${name}`, references);
  }
  return result;
}
