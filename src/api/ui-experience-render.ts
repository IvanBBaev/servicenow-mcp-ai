/**
 * P-14 / P-15 — the `explain_ui_experience` renderers: the page map and the
 * event chains as Mermaid flowcharts, and the Markdown report. Pure
 * functions of the result; import from ui-experience.ts.
 */

import type { UibElement } from "../core/artifacts/uib-composition.js";
import { MermaidDoc, ident, label } from "./mermaid.js";
import { UIB_PAGE_RULES } from "./uib-page-lint.js";
import { UIB_BROKER_RULES } from "./uib-broker-lint.js";
import { conditionText, workspaceLines } from "./uib-workspace.js";
import type {
  ExplainUiExperienceResult,
  UxEventTarget,
  UxMacroponent,
} from "./ui-experience-types.js";

const macroName = (
  result: ExplainUiExperienceResult,
  id: string | undefined,
): string => {
  if (!id) return "no macroponent";
  const m = result.macroponents.find((x) => x.sys_id === id);
  return m?.name ?? id;
};

const audience = (
  result: ExplainUiExperienceResult,
  id: string | undefined,
): string | undefined => {
  if (!id) return undefined;
  const a = result.applicabilities.find((x) => x.sys_id === id);
  if (!a) return id;
  return `${a.name ?? a.sys_id}${a.roles.length ? ` [${a.roles.join(", ")}]` : ""}`;
};

/**
 * The page map as a Mermaid flowchart (experience → routes → screen variants
 * → macroponents → data brokers, plus dashboards and list menus), capped by
 * SN_DIAGRAM_MAX_NODES; `truncated` counts the dropped nodes.
 */
export function uiExperienceMermaid(result: ExplainUiExperienceResult): {
  mermaid: string;
  truncated: number;
} {
  const doc = new MermaidDoc("flowchart TD");
  const e = result.experience;
  const root = "exp";
  doc.node(
    root,
    label(
      `Experience: ${e ? (e.title ?? e.sys_id) : "(unreadable)"}${e?.path ? ` /${e.path}` : ""}`,
    ),
    "rect",
    { pinned: true },
  );
  const macroNode = (from: string, id: string | undefined): void => {
    if (!id) return;
    const mid = `m_${ident(id)}`;
    doc.edgeTo(from, mid, label(`Macroponent: ${macroName(result, id)}`, 80), {
      arrow: "-.->",
    });
    const m = result.macroponents.find((x) => x.sys_id === id);
    for (const d of m?.data.value ?? []) {
      if (!d.broker) continue;
      const broker = result.dataBrokers.find((b) => b.sys_id === d.broker);
      doc.edgeTo(
        mid,
        `b_${ident(d.broker)}`,
        label(`Data: ${broker?.name ?? d.label ?? d.elementId}`, 80),
        { shape: "db" },
      );
    }
  };
  macroNode(root, e?.root_macroponent);
  let cfg = root;
  if (result.appConfig) {
    cfg = "cfg";
    doc.edgeTo(
      root,
      cfg,
      label(`App config: ${result.appConfig.name ?? result.appConfig.sys_id}`),
    );
  }
  for (const r of result.routes) {
    const rid = `r_${ident(r.sys_id)}`;
    doc.edgeTo(cfg, rid, label(`Route: ${r.name ?? r.sys_id}`, 80));
    if (!r.screens.length) {
      doc.edgeTo(rid, `none_${ident(r.sys_id)}`, "no screen", {
        arrow: "-.->",
      });
    }
    for (const s of r.screens) {
      const sid = `s_${ident(s.sys_id)}`;
      const who = audience(result, s.applicability);
      doc.edgeTo(
        rid,
        sid,
        label(
          `Variant ${s.order}: ${s.name ?? s.sys_id}${who ? ` · ${who}` : ""}`,
          100,
        ),
        { shape: "input" },
      );
      macroNode(sid, s.macroponent);
    }
  }
  for (const d of result.dashboards) {
    doc.edgeTo(
      root,
      `d_${ident(d.sys_id)}`,
      label(`Dashboard: ${d.name ?? d.sys_id} (${d.tabs.length} tab(s))`, 80),
      { arrow: "-.->" },
    );
  }
  for (const m of result.listMenus) {
    const lists = m.categories.reduce((n, c) => n + c.lists.length, 0);
    doc.edgeTo(
      root,
      `lm_${ident(m.sys_id)}`,
      label(`List menu: ${m.name ?? m.sys_id} (${lists} list(s))`, 80),
      { arrow: "-.->" },
    );
  }
  return { mermaid: doc.render(), truncated: doc.truncated };
}

function elementLines(
  elements: UibElement[],
  indent: string,
  out: string[],
): void {
  for (const el of elements) {
    out.push(
      `${indent}- ${el.label ? `${el.label} ` : ""}\`${el.elementId}\`${
        el.component ? ` → ${el.component}` : ""
      }${el.type ? ` (${el.type})` : ""}${el.hidden ? " _(hidden)_" : ""}`,
    );
    for (const slot of el.slots) {
      out.push(`${indent}  - slot ${slot.name}`);
      elementLines(slot.elements, `${indent}    `, out);
    }
  }
}

const targetText = (t: UxEventTarget): string => {
  switch (t.kind) {
    case "clientScript":
      return `client script ${t.name ?? t.sys_id ?? "?"}`;
    case "brokerOperation":
      return `${t.operation ?? "operation"} on ${t.dataResource ?? "?"}${
        t.brokerName ? ` (${t.brokerName})` : ""
      }`;
    case "state":
      return `set state ${t.property ?? t.name ?? "?"}${
        t.declared === false ? " _(undeclared)_" : ""
      }`;
    case "event":
      return `event ${t.name ?? "?"}`;
    default:
      return `?${t.type ? ` (${t.type})` : ""}`;
  }
};

/** N-26 sections of one macroponent; nothing when no detail was read. */
function detailLines(m: UxMacroponent, out: string[]): void {
  if (m.components?.length) {
    out.push("", "Components:");
    for (const c of m.components) {
      out.push(
        `- \`${c.id}\` → ${c.kind}${c.name ? ` ${c.name}` : ""}${
          c.artifactType ? ` [${c.artifactType}]` : ""
        } · ${c.elements.join(", ")}`,
      );
    }
  }
  if (m.bindings?.length) {
    out.push("", "Bindings:");
    for (const b of m.bindings) {
      const r = b.resolves;
      const to = r?.dataResource
        ? ` → ${r.brokerName ?? r.broker ?? r.dataResource}`
        : r?.state
          ? r.declared
            ? " → client state"
            : " → _undeclared state_"
          : r?.context
            ? " → page context"
            : "";
      out.push(`- \`${b.elementId}\`.${b.prop} = ${b.expression}${to}`);
    }
  }
  if (m.pageMetrics) {
    const p = m.pageMetrics;
    out.push(
      "",
      `Page weight: ${p.elements} element(s), slot depth ${p.maxDepth}, ${p.onLoadBrokers} of ${p.dataBrokers} data resource(s) on load${
        p.unconditionalOnLoad.length
          ? `, ${p.unconditionalOnLoad.length} without \`when\``
          : ""
      }${p.partial ? " _(partial)_" : ""}`,
    );
  }
  if (m.translations) {
    const t = m.translations;
    out.push(
      "",
      `Translations: ${t.texts} string(s) in ${t.strings} use(s), ${
        t.declared === null
          ? "required_translations unreadable"
          : `${t.declared} declared, ${t.undeclared} undeclared`
      }${t.omitted ? ` (${t.omitted} past the cap)` : ""}${
        t.sample.length
          ? ` · ${t.declared === null ? "e.g." : "missing"}: ${t.sample
              .map((x) => JSON.stringify(x))
              .join(", ")}`
          : ""
      }`,
    );
  }
  if (m.eventChains?.length) {
    out.push("", "Event chains:");
    for (const c of m.eventChains) {
      out.push(
        `- ${c.element ?? c.source}${c.event ? ` · ${c.event}` : ""} → ${
          c.targets.map(targetText).join("; ") || "?"
        }`,
      );
    }
  }
}

/** N-31: the `## Page hints` section; nothing when no page has a finding. */
function pageHintLines(result: ExplainUiExperienceResult, out: string[]): void {
  if (!result.pageHints?.length) return;
  const rule = UIB_PAGE_RULES[0]!;
  out.push("## Page hints", "", `\`${rule.id}\`: ${rule.hint}`, "");
  for (const h of result.pageHints) {
    out.push(
      `- **${h.name ?? h.macroponent}**${
        h.screens?.length ? ` (${h.screens.join(", ")})` : ""
      }${h.partial ? " _(partial)_" : ""}`,
    );
    for (const f of h.findings) {
      out.push(
        `  - ${f.message}${
          f.elementIds?.length
            ? ` ${f.elementIds.map((e) => `\`${e}\``).join(", ")}`
            : ""
        }`,
      );
    }
  }
  out.push("");
}

/** N-29: the `## Broker hints` section; nothing when no broker has a finding. */
function brokerHintLines(
  result: ExplainUiExperienceResult,
  out: string[],
): void {
  if (!result.brokerHints?.length) return;
  out.push("## Broker hints", "");
  const used = new Set<string>(
    result.brokerHints.flatMap((h) => h.findings.map((f) => f.rule)),
  );
  for (const r of UIB_BROKER_RULES) {
    if (used.has(r.id)) out.push(`- \`${r.id}\` (${r.severity}): ${r.hint}`);
  }
  out.push("");
  for (const h of result.brokerHints) {
    out.push(`- **${h.name ?? h.broker}** (${h.table})`);
    for (const f of h.findings) {
      out.push(`  - ${f.severity}: ${f.message} (\`${f.rule}\`)`);
    }
  }
  out.push("");
}

/**
 * N-26: the event flow of every macroponent as a Mermaid flowchart (source
 * element → event → handler target), capped by SN_DIAGRAM_MAX_NODES; empty
 * when no event chain was read.
 */
export function uiExperienceEventMermaid(result: ExplainUiExperienceResult): {
  mermaid: string;
  truncated: number;
} {
  const doc = new MermaidDoc("flowchart LR");
  const seen = new Set<string>();
  const declare = (id: string, text: string, shape?: "db" | "input"): void => {
    if (seen.has(id)) return;
    seen.add(id);
    doc.node(id, label(text, 80), shape);
  };
  let chains = 0;
  for (const m of result.macroponents) {
    const mid = ident(m.sys_id);
    for (const [i, c] of (m.eventChains ?? []).entries()) {
      chains += 1;
      const src = `src_${mid}_${ident(c.element ?? c.source)}`;
      declare(
        src,
        `${m.name ?? m.sys_id}: ${c.element ?? c.source}${c.component ? ` (${c.component})` : ""}`,
      );
      const ev = `ev_${mid}_${i}`;
      declare(ev, c.event ?? "event", "input");
      doc.edge(src, ev);
      for (const t of c.targets) {
        const tid =
          t.kind === "clientScript"
            ? `cs_${ident(t.sys_id ?? t.name ?? "x")}`
            : t.kind === "brokerOperation"
              ? `b_${ident(t.broker ?? `${mid}_${t.dataResource ?? "x"}`)}`
              : t.kind === "state"
                ? `st_${mid}_${ident(t.property ?? t.name ?? "x")}`
                : `t_${ident(t.name ?? t.type ?? "unknown")}`;
        declare(
          tid,
          t.kind === "brokerOperation"
            ? `Data: ${t.brokerName ?? t.dataResource ?? "?"}`
            : targetText(t).replace(/ _\(undeclared\)_/, " (undeclared)"),
          t.kind === "brokerOperation" ? "db" : undefined,
        );
        doc.edge(ev, tid);
      }
    }
  }
  return chains
    ? { mermaid: doc.render(), truncated: doc.truncated }
    : { mermaid: "", truncated: 0 };
}

const fmt = (v: unknown): string => {
  const text = typeof v === "string" ? v : JSON.stringify(v);
  const one = (text ?? "").replace(/[\r\n]+/g, " ");
  return one.length > 120 ? `${one.slice(0, 117)}...` : one;
};

/** A readable Markdown report of the page map (the diagram included). */
export function uiExperienceMarkdown(
  result: ExplainUiExperienceResult,
  mermaid: string,
): string {
  const out: string[] = [];
  const e = result.experience;
  out.push(
    `# Experience ${e ? (e.title ?? e.sys_id) : "(unreadable)"}${e?.path ? ` (/${e.path})` : ""}`,
    "",
  );
  const c = result.counts;
  out.push(
    `${c.routes} route(s), ${c.screens} screen variant(s), ${c.macroponents} macroponent(s), ${c.elements} element(s), ${c.dataResources} data resource(s), ${c.dataBrokers} data broker(s), ${c.acls} broker ACL(s), ${c.dashboards} dashboard(s), ${c.lists} list(s), ${c.formActionLayouts} form action layout(s), ${c.actions} declarative action(s), ${c.themes} theme(s). verified:false.`,
  );
  if (result.appConfig) {
    const a = result.appConfig;
    out.push(
      "",
      `App config: **${a.name ?? a.sys_id}**${a.landing_path ? ` (landing ${a.landing_path})` : ""}`,
    );
  }
  if (result.properties.length) {
    out.push("", "## Page properties", "");
    for (const p of result.properties) {
      out.push(
        `- ${p.name}${p.value !== undefined ? ` = ${fmt(p.value)}` : ""}`,
      );
    }
  }
  out.push("", "## Routes", "");
  if (!result.routes.length) out.push("_No routes read._");
  for (const r of result.routes) {
    out.push(
      `- **${r.name ?? r.sys_id}**${r.route_type ? ` (${r.route_type})` : ""}${
        r.screens.length ? "" : " _(no screen)_"
      }`,
    );
    for (const s of r.screens) {
      const who = audience(result, s.applicability);
      out.push(
        `  - Variant ${s.order}: ${s.name ?? s.sys_id} → ${macroName(result, s.macroponent)}${
          who ? ` · audience ${who}` : " · no applicability"
        }${s.active === "false" ? " _(inactive)_" : ""}`,
      );
    }
  }
  if (result.macroponents.length) {
    out.push("", "## Macroponents", "");
    for (const m of result.macroponents) {
      out.push(
        `### ${m.name ?? m.sys_id}${m.category ? ` (${m.category})` : ""}`,
        "",
      );
      if (m.composition.decoded) {
        const tree = m.composition.value!;
        out.push(`Component tree (${tree.count} element(s)):`);
        elementLines(tree.elements, "", out);
        if (tree.omitted) out.push(`- _${tree.omitted} element(s) omitted_`);
      } else {
        out.push(
          `_composition did not decode: ${m.composition.reason}_ (returned raw)`,
        );
      }
      const data = m.data.value ?? [];
      if (data.length) {
        out.push("", "Data resources:");
        for (const d of data) {
          const b = result.dataBrokers.find((x) => x.sys_id === d.broker);
          out.push(
            `- \`${d.elementId}\`${d.type ? ` (${d.type})` : ""} → ${b?.name ?? d.broker ?? "?"}`,
          );
        }
      } else if (!m.data.decoded) {
        out.push("", `_data did not decode: ${m.data.reason}_`);
      }
      if (m.state.value?.length) {
        out.push(
          "",
          `Client state: ${m.state.value
            .map((s) => `${s.name}${s.type ? ` (${s.type})` : ""}`)
            .join(", ")}`,
        );
      } else if (!m.state.decoded) {
        out.push("", `_state_properties did not decode: ${m.state.reason}_`);
      }
      if (m.events.value?.length) {
        out.push("", "Event wiring:");
        for (const w of m.events.value) {
          out.push(
            `- ${w.source}${w.event ? ` · ${w.event}` : ""} → ${w.handlers.join(", ") || "?"}`,
          );
        }
      } else if (!m.events.decoded) {
        out.push(
          "",
          `_internal_event_mappings did not decode: ${m.events.reason}_`,
        );
      }
      if (m.clientScripts.length) {
        out.push(
          "",
          `Client scripts: ${m.clientScripts
            .map((s) => `${s.name ?? s.sys_id}${s.type ? ` (${s.type})` : ""}`)
            .join(", ")}`,
        );
      }
      detailLines(m, out);
      out.push("");
    }
  }
  pageHintLines(result, out);
  brokerHintLines(result, out);
  if (result.dataBrokers.length || result.unresolvedBrokers.length) {
    out.push("## Data brokers", "");
    for (const b of result.dataBrokers) {
      out.push(
        `- **${b.name ?? b.sys_id}** (${b.table})${
          b.mutates_server_data === "true" ? " · mutates server data" : ""
        } · ${b.acls.length ? `ACLs: ${b.acls.map((a) => a.operation ?? a.sys_id).join(", ")}` : "no ux_data_broker ACL"}`,
      );
    }
    for (const id of result.unresolvedBrokers) {
      out.push(
        `- ${id} _(not a transform / scriptlet / REST / GraphQL broker, or not found)_`,
      );
    }
    out.push("");
  }
  if (result.dashboards.length) {
    out.push("## Dashboards", "");
    for (const d of result.dashboards) {
      out.push(`- **${d.name ?? d.sys_id}**`);
      for (const t of d.tabs) {
        out.push(
          `  - Tab ${t.name ?? t.sys_id}: ${t.widgets.length} widget(s)${
            t.widgets.length
              ? ` (${t.widgets.map((w) => w.name ?? w.component ?? w.sys_id).join(", ")})`
              : ""
          }`,
        );
      }
    }
    out.push("");
  }
  if (result.listMenus.length) {
    out.push("## Lists", "");
    for (const m of result.listMenus) {
      out.push(`- **${m.name ?? m.sys_id}**`);
      for (const cat of m.categories) {
        out.push(`  - ${cat.title ?? cat.sys_id}`);
        for (const l of cat.lists) {
          const who = l.applicability
            .map((a) => audience(result, a))
            .filter(Boolean);
          out.push(
            `    - ${l.title ?? l.sys_id}${l.table ? ` (${l.table})` : ""}${
              who.length ? ` · audience ${who.join("; ")}` : ""
            }`,
          );
          const decoded = [
            ...(l.columns?.length ? [`columns ${l.columns.join(", ")}`] : []),
            ...(l.conditionTerms?.length
              ? [`condition ${conditionText(l.conditionTerms)}`]
              : []),
          ];
          if (decoded.length) out.push(`      - ${decoded.join(" · ")}`);
        }
      }
    }
    out.push("");
  }
  if (result.formActionLayouts.length) {
    out.push("## Form action layouts", "");
    for (const l of result.formActionLayouts) {
      out.push(`- **${l.name ?? l.sys_id}**${l.table ? ` (${l.table})` : ""}`);
      for (const i of l.items) {
        out.push(`  - ${i.order}: ${i.label ?? i.form_action ?? i.sys_id}`);
      }
    }
    out.push("");
  }
  workspaceLines(result, out);
  out.push("## Page map", "", "```mermaid", mermaid, "```", "");
  out.push("## Caveats", "");
  for (const cav of result.caveats) out.push(`- ${cav}`);
  if (result.missingFields) {
    for (const [table, fields] of Object.entries(result.missingFields)) {
      out.push(`- ${table}: fields not returned: ${fields.join(", ")}`);
    }
  }
  return out.join("\n");
}
