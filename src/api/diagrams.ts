import { ServiceNowError } from "../core/errors.js";
import { describeTable } from "./meta.js";
import { listScripts } from "./scripts.js";
import { snString } from "./shared.js";

/**
 * Deterministic Mermaid diagram generators. They read the instance's own
 * metadata (sys_dictionary references, business rules) and emit Mermaid markup
 * directly, so the diagrams reflect the real instance and do not depend on the
 * model guessing structure.
 */

/** Mermaid identifiers allow word characters; sanitise anything else. */
function ident(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Escape a Mermaid node/label string (quotes and brackets break parsing). */
function label(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/["[\]{}|]/g, "'")
    .trim();
}

/**
 * Build a Mermaid `erDiagram` for the given tables: an entity per table with
 * its columns, plus a many-to-one relationship for every reference field.
 */
export async function generateErDiagram(
  tables: string[],
): Promise<{ tables: string[]; mermaid: string }> {
  if (!tables?.length) {
    throw new ServiceNowError("Provide at least one table.", 400);
  }
  const lines = ["erDiagram"];
  const relationships: string[] = [];
  for (const table of tables) {
    const columns = await describeTable(table);
    const entity = ident(table);
    lines.push(`  ${entity} {`);
    for (const col of columns) {
      const name = ident(col.element);
      if (!name) continue;
      const type = ident(col.type || "string");
      lines.push(`    ${type} ${name}`);
    }
    lines.push("  }");
    for (const col of columns) {
      if (col.reference) {
        relationships.push(
          `  ${entity} }o--|| ${ident(col.reference)} : "${label(col.element)}"`,
        );
      }
    }
  }
  return { tables, mermaid: [...lines, ...relationships].join("\n") };
}

const PHASE_ORDER = ["display", "before", "after", "async"];

/**
 * Build a Mermaid `flowchart` of a record's lifecycle on a table, grouping the
 * active business rules by execution phase (display → before → after → async)
 * and chaining them in `order` within each phase.
 */
export async function generateTableFlow(
  table: string,
): Promise<{ table: string; count: number; mermaid: string }> {
  const t = table.trim();
  if (!t) throw new ServiceNowError("A table name is required.", 400);

  const { scripts } = await listScripts({
    type: "business_rule",
    query: `collection=${t}^active=true^ORDERBYwhen^ORDERBYorder`,
    limit: 200,
  });

  const byPhase = new Map<string, typeof scripts>();
  for (const rule of scripts) {
    const phase = snString(rule.when).toLowerCase() || "other";
    const list = byPhase.get(phase) ?? [];
    list.push(rule);
    byPhase.set(phase, list);
  }

  const present = [
    ...PHASE_ORDER.filter((p) => byPhase.has(p)),
    ...[...byPhase.keys()].filter((p) => !PHASE_ORDER.includes(p)),
  ];

  const lines = ["flowchart TD", `  op[/"insert / update on ${label(t)}"/]`];
  let prev = "op";
  let nodeId = 0;
  for (const phase of present) {
    const sub = `P_${ident(phase)}`;
    lines.push(`  subgraph ${sub}["${label(phase)} business rules"]`);
    lines.push("    direction TB");
    let prevNode: string | undefined;
    for (const rule of byPhase.get(phase) ?? []) {
      const id = `n${nodeId++}`;
      const ord = rule.order !== undefined ? ` (${label(snString(rule.order))})` : "";
      lines.push(`    ${id}["${label(String(rule.name))}${ord}"]`);
      if (prevNode) lines.push(`    ${prevNode} --> ${id}`);
      prevNode = id;
    }
    lines.push("  end");
    lines.push(`  ${prev} --> ${sub}`);
    prev = sub;
  }
  lines.push(`  ${prev} --> done([record saved])`);

  return { table: t, count: scripts.length, mermaid: lines.join("\n") };
}
