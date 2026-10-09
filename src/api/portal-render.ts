import { MermaidDoc, ident, label } from "./mermaid.js";
import {
  type ExplainPortalResult,
  type PortalInstance,
  type PortalPage,
  type PortalRow,
} from "./portal-model.js";

/**
 * P-16 `explain_portal` renderers: the Mermaid view and the Markdown report.
 */

const pageLabel = (p: PortalPage): string =>
  `${p.title ? `${p.title} ` : ""}(${p.id || p.sys_id})${
    p.roles_in_portal.length ? ` · ${p.roles_in_portal.join(", ")}` : ""
  }`;

const instanceLabel = (i: PortalInstance): string => {
  const widget = i.widget ? (i.widget.name ?? i.widget.sys_id) : "no widget";
  return i.title ? `${i.title} · ${widget}` : widget;
};

/**
 * The layout tree as a Mermaid flowchart (portal → theme / menu / pages →
 * container → row → column → widget instance), capped by
 * SN_DIAGRAM_MAX_NODES; `truncated` counts the dropped nodes.
 */
export function portalMermaid(result: ExplainPortalResult): {
  mermaid: string;
  truncated: number;
} {
  const doc = new MermaidDoc("flowchart TD");
  let root: string | undefined;
  if (result.portal) {
    root = "portal";
    const p = result.portal;
    doc.node(
      root,
      label(
        `Portal: ${p.title ?? p.sys_id}${p.url_suffix ? ` /${p.url_suffix}` : ""}`,
      ),
      "rect",
      { pinned: true },
    );
    if (result.theme) {
      doc.edgeTo(
        root,
        "theme",
        label(`Theme: ${result.theme.name ?? result.theme.sys_id}`),
        {
          arrow: "-.->",
        },
      );
    }
    if (result.menu) {
      doc.edgeTo(
        root,
        "menu",
        label(`Menu: ${result.menu.title ?? result.menu.sys_id}`),
        {
          arrow: "-.->",
        },
      );
    }
  }
  const rowNodes = (from: string, rows: PortalRow[]): void => {
    for (const row of rows) {
      const rid = `r_${ident(row.sys_id)}`;
      doc.edgeTo(from, rid, "Row");
      for (const col of row.columns) {
        const cid = `col_${ident(col.sys_id)}`;
        doc.edgeTo(rid, cid, label(col.size ? `Column ${col.size}` : "Column"));
        for (const inst of col.instances) {
          doc.edgeTo(
            cid,
            `i_${ident(inst.sys_id)}`,
            label(instanceLabel(inst), 80),
            {
              shape: "input",
            },
          );
        }
        rowNodes(cid, col.rows);
        if (col.rowsOmitted) {
          doc.edgeTo(
            cid,
            `more_${ident(col.sys_id)}`,
            label(`+${col.rowsOmitted} nested row(s)`),
            {
              arrow: "-.->",
            },
          );
        }
      }
    }
  };
  for (const page of result.pages) {
    const pid = `pg_${ident(page.sys_id)}`;
    const text = label(`Page: ${pageLabel(page)}`, 100);
    if (root) doc.edgeTo(root, pid, text);
    else doc.node(pid, text, "rect", { pinned: true });
    for (const c of page.layout ?? []) {
      const cid = `c_${ident(c.sys_id)}`;
      doc.edgeTo(
        pid,
        cid,
        label(`Container${c.name ? `: ${c.name}` : ""}`, 80),
        {
          shape: "db",
        },
      );
      rowNodes(cid, c.rows);
    }
  }
  return { mermaid: doc.render(), truncated: doc.truncated };
}

const fmt = (v: unknown): string => {
  const text = typeof v === "string" ? v : JSON.stringify(v);
  const one = (text ?? "").replace(/[\r\n]+/g, " ");
  return one.length > 120 ? `${one.slice(0, 117)}...` : one;
};

/** A readable Markdown report of the tree (the Mermaid diagram included). */
export function portalMarkdown(
  result: ExplainPortalResult,
  mermaid: string,
): string {
  const out: string[] = [];
  const p = result.portal;
  if (p) {
    out.push(
      `# Portal ${p.title ?? p.sys_id}${p.url_suffix ? ` (/${p.url_suffix})` : ""}`,
    );
  } else {
    const page = result.pages[0];
    out.push(`# Page ${page ? pageLabel(page) : "(unreadable)"}`);
  }
  out.push("");
  const c = result.counts;
  out.push(
    `${c.pages} page(s), ${c.containers} container(s), ${c.rows} row(s), ${c.columns} column(s), ${c.instances} instance(s), ${c.widgets} widget(s), ${c.dependencies} dependency(ies). verified:false.`,
  );
  if (result.theme) {
    const t = result.theme;
    out.push("", "## Theme", "");
    out.push(`- **${t.name ?? t.sys_id}**`);
    if (t.header)
      out.push(`- Header: ${t.header.name ?? t.header.id ?? t.header.sys_id}`);
    if (t.footer)
      out.push(`- Footer: ${t.footer.name ?? t.footer.id ?? t.footer.sys_id}`);
    for (const i of t.jsIncludes)
      out.push(`- JS include: ${i.name ?? i.sys_id}`);
    for (const i of t.cssIncludes)
      out.push(`- CSS include: ${i.name ?? i.sys_id}`);
  }
  if (result.menu) {
    out.push("", `## Menu ${result.menu.title ?? result.menu.sys_id}`, "");
    for (const i of result.menu.items) {
      out.push(
        `- ${i.label ?? i.sys_id}${i.type ? ` (${i.type})` : ""}${i.url ? ` → ${i.url}` : ""}`,
      );
    }
  }
  out.push("", "## Pages", "");
  for (const page of result.pages) {
    out.push(`### ${pageLabel(page)}`, "");
    if (page.layoutOmitted) {
      out.push("_Layout not read (page limit)._", "");
      continue;
    }
    const rows = (list: PortalRow[], indent: string): void => {
      for (const row of list) {
        out.push(`${indent}- Row`);
        for (const col of row.columns) {
          out.push(`${indent}  - Column${col.size ? ` ${col.size}` : ""}`);
          for (const inst of col.instances) {
            out.push(`${indent}    - **${instanceLabel(inst)}**`);
            for (const o of inst.options.filter((x) => x.set)) {
              out.push(`${indent}      - ${o.name} = ${fmt(o.value)}`);
            }
            for (const [k, v] of Object.entries(inst.unknownOptions ?? {})) {
              out.push(
                `${indent}      - ${k} = ${fmt(v)} _(not in option_schema)_`,
              );
            }
            if (inst.parametersDecoded === false) {
              out.push(
                `${indent}      - _widget_parameters did not decode: ${inst.parametersReason}_`,
              );
            }
          }
          rows(col.rows, `${indent}    `);
          if (col.rowsOmitted) {
            out.push(
              `${indent}    - _${col.rowsOmitted} nested row(s) past depth_`,
            );
          }
        }
      }
    };
    for (const cont of page.layout ?? []) {
      out.push(
        `- Container${cont.name ? ` ${cont.name}` : ""}${cont.width ? ` (${cont.width})` : ""}`,
      );
      rows(cont.rows, "  ");
    }
    out.push("");
  }
  if (result.widgets.length) {
    out.push("## Widgets", "");
    for (const w of result.widgets) {
      out.push(
        `- **${w.name ?? w.id ?? w.sys_id}**${w.id ? ` (${w.id})` : ""}: ${w.instances} instance(s)`,
      );
      if (w.optionSchema.length) {
        out.push(
          `  - Options: ${w.optionSchema.map((o) => o.name).join(", ")}`,
        );
      }
      for (const d of w.dependencies) {
        const inc = [...d.jsIncludes, ...d.cssIncludes].map(
          (i) => i.name ?? i.sys_id,
        );
        out.push(
          `  - Dependency ${d.name ?? d.sys_id}${inc.length ? `: ${inc.join(", ")}` : ""}`,
        );
      }
      for (const pr of w.providers) {
        out.push(
          `  - Angular provider ${pr.name ?? pr.sys_id}${pr.type ? ` (${pr.type})` : ""}`,
        );
      }
      for (const t of w.templates)
        out.push(`  - ng-template ${t.id ?? t.sys_id}`);
    }
    out.push("");
  }
  if (result.routeMaps.length) {
    out.push("## Route maps", "");
    for (const m of result.routeMaps) {
      out.push(
        `- ${m.short_description ?? m.sys_id}: ${m.route_from_page ?? "?"} → ${m.route_to_page ?? "?"}${m.active === "false" ? " (inactive)" : ""}`,
      );
    }
    out.push("");
  }
  out.push("## Layout diagram", "", "```mermaid", mermaid, "```", "");
  out.push("## Caveats", "");
  for (const cav of result.caveats) out.push(`- ${cav}`);
  if (result.missingFields) {
    for (const [table, fields] of Object.entries(result.missingFields)) {
      out.push(`- ${table}: fields not returned: ${fields.join(", ")}`);
    }
  }
  return out.join("\n");
}
