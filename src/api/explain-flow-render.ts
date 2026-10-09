/**
 * `explain_flow` renderers: the Mermaid diagram (`flowMermaid`) and the
 * Markdown explanation (`flowMarkdown`).
 */
import { MermaidDoc, ident, label, type Arrow, type Shape } from "./mermaid.js";
import {
  type Callee,
  type DecodedValues,
  type ExplainFlowKind,
  type ExplainFlowResult,
  type FlowStep,
  type FlowTrigger,
  type FlowVariable,
  type MigrationReport,
  type PdTimer,
  type PdTrigger,
  type Run,
  type StepKind,
} from "./explain-flow-model.js";

// --- renderers -------------------------------------------------------------------

const STEP_SHAPE: Record<StepKind, Shape> = {
  action: "rect",
  logic: "input",
  subflow: "db",
  step: "rect",
};

const HEADER: Record<Exclude<ExplainFlowKind, "workflow">, string> = {
  flow: "Flow",
  subflow: "Subflow",
  action: "Action",
  playbook: "Playbook",
};

const pdTriggerText = (t: PdTrigger): string =>
  `Trigger: ${t.name ?? t.definition?.name ?? t.type ?? t.definition?.sys_id ?? t.sys_id}${t.table ? ` · ${t.table}` : ""}`;

const timerText = (t: PdTimer): string =>
  `timer ${t.name ?? t.type ?? t.sys_id}${t.duration ? ` (${t.duration})` : ""}`;

/**
 * A playbook as Mermaid: the header, its triggers, and one subgraph per lane
 * holding that lane's activities chained by `order`. Lanes start from the
 * header with dotted edges — lane conditions and parallelism are not modelled
 * (unverified, O-5).
 */
function playbookMermaid(
  doc: MermaidDoc,
  result: ExplainFlowResult,
): { mermaid: string; truncated: number } {
  doc.node(
    "pb",
    label(`Playbook: ${result.playbook?.name ?? result.sys_id ?? ""}`, 100),
    "rect",
    { pinned: true },
  );
  (result.triggers ?? []).forEach((t, i) => {
    doc.edgeTo("pb", `t${i + 1}`, label(pdTriggerText(t), 100), {
      shape: "input",
      pinned: true,
    });
  });
  for (const lane of result.lanes ?? []) {
    const lid = `lane_${ident(lane.sys_id)}`;
    doc.open(lid, label(`${lane.number} ${lane.name}`, 80), "TB");
    let prev: string | undefined;
    for (const a of lane.activities) {
      const aid = `act_${ident(a.sys_id)}`;
      const text = `${a.number} ${a.name}${a.definition?.name ? ` · ${a.definition.name}` : ""}${a.timers?.length ? ` · ${a.timers.length} timer(s)` : ""}`;
      if (!doc.node(aid, label(text, 100))) continue;
      if (prev) doc.edge(prev, aid);
      prev = aid;
    }
    doc.close();
    doc.edge("pb", lid, "-.->");
  }
  return { mermaid: doc.render(), truncated: doc.truncated };
}

const calleeText = (c: Callee): string =>
  `${c.kind === "action" ? "Action" : "Subflow"}: ${c.name ?? c.sys_id}`;

const stepText = (s: FlowStep): string =>
  `${s.number} ${s.kind === "subflow" ? "Subflow: " : ""}${s.name}${s.comment ? ` · ${s.comment}` : ""}`;

const triggerText = (t: FlowTrigger): string =>
  `Trigger: ${t.definition?.name ?? t.type ?? t.definition?.sys_id ?? "unknown"}${t.table ? ` · ${t.table}` : ""}`;

/**
 * The flow as a Mermaid tree (flow → trigger → steps, logic blocks holding
 * their children) or the workflow as its activity graph with one edge per
 * wf_transition row. Capped by SN_DIAGRAM_MAX_NODES; `truncated` counts the
 * dropped nodes.
 */
export function flowMermaid(result: ExplainFlowResult): {
  mermaid: string;
  truncated: number;
} {
  const doc = new MermaidDoc("flowchart TD");
  if (result.kind === "playbook") return playbookMermaid(doc, result);
  if (result.kind === "workflow") {
    const emitted = new Set<string>();
    const nodeId = (id: string): string => `a_${ident(id)}`;
    doc.node(
      "wf",
      label(
        `Workflow: ${result.workflow?.name ?? result.sys_id ?? "instance"}`,
        100,
      ),
      "rect",
      { pinned: true },
    );
    const first = result.activities?.[0];
    if (first && doc.node(nodeId(first.sys_id), label(first.name, 80))) {
      emitted.add(first.sys_id);
      doc.edge("wf", nodeId(first.sys_id), "-.->");
    }
    for (const a of (result.activities ?? []).slice(1)) {
      if (doc.node(nodeId(a.sys_id), label(a.name, 80))) emitted.add(a.sys_id);
    }
    for (const t of result.transitions ?? []) {
      for (const end of [t.from, t.to]) {
        if (
          !emitted.has(end) &&
          !result.activities?.some((a) => a.sys_id === end)
        ) {
          if (doc.node(nodeId(end), label(`Activity ${end}`, 80))) {
            emitted.add(end);
          }
        }
      }
      if (!emitted.has(t.from) || !emitted.has(t.to)) continue;
      const cond = t.condition?.name;
      doc.line(
        cond
          ? `${nodeId(t.from)} -->|"${label(cond, 60)}"| ${nodeId(t.to)}`
          : `${nodeId(t.from)} --> ${nodeId(t.to)}`,
      );
    }
    return { mermaid: doc.render(), truncated: doc.truncated };
  }
  doc.node(
    "flow",
    label(
      `${HEADER[result.kind]}: ${result.flow?.name ?? result.action?.name ?? result.sys_id ?? ""}`,
      100,
    ),
    "rect",
    { pinned: true },
  );
  let root = "flow";
  if (result.trigger) {
    doc.edgeTo("flow", "trigger", label(triggerText(result.trigger), 100), {
      shape: "input",
      pinned: true,
    });
    root = "trigger";
  }
  // Callee steps hang off the calling step with dotted edges; a callee
  // shared by several call sites renders once per site (numbered ids).
  let called = 0;
  const walk = (
    from: string,
    list: FlowStep[],
    id: (s: FlowStep) => string,
    arrow: Arrow = "-->",
  ): void => {
    for (const s of list) {
      const sid = id(s);
      doc.edgeTo(from, sid, label(stepText(s), 100), {
        arrow,
        shape: STEP_SHAPE[s.kind],
      });
      walk(sid, s.children, id);
      const c = s.callee;
      if (!c) continue;
      const site = `c${++called}`;
      if (c.cycle) {
        doc.edgeTo(sid, site, label(`${calleeText(c)} (cycle)`, 100), {
          arrow: "-.->",
          shape: "input",
        });
      } else {
        walk(sid, c.steps, (x) => `${site}_${ident(x.sys_id)}`, "-.->");
      }
    }
  };
  walk(root, result.steps ?? [], (s) => `s_${ident(s.sys_id)}`);
  return { mermaid: doc.render(), truncated: doc.truncated };
}

const fmt = (v: unknown): string => {
  const text = typeof v === "string" ? v : JSON.stringify(v);
  const one = (text ?? "").replace(/[\r\n]+/g, " ");
  return one.length > 120 ? `${one.slice(0, 117)}...` : one;
};

function valuesLines(v: DecodedValues | undefined, indent: string): string[] {
  if (!v) return [];
  if (!v.decoded) {
    return [`${indent}- _values not decoded (${v.bytes} bytes): ${v.reason}_`];
  }
  const out: string[] = [];
  for (const i of v.inputs ?? []) {
    const pills = (i.pills ?? [])
      .map((p) => `${p.pill}${p.label ? ` = ${p.label}` : ""}`)
      .join("; ");
    out.push(
      `${indent}- ${i.label ?? i.name} = ${fmt(i.displayValue ?? i.value)}${pills ? ` _(pills: ${pills})_` : ""}`,
    );
  }
  if (v.inputsOmitted)
    out.push(`${indent}- _+${v.inputsOmitted} more input(s)_`);
  if (v.value !== undefined) out.push(`${indent}- ${fmt(v.value)}`);
  return out;
}

function variablesTable(
  title: string,
  list: FlowVariable[] | undefined,
): string[] {
  if (!list?.length) return [];
  const out = [
    "",
    `## ${title}`,
    "",
    "| Name | Label | Type | Mandatory |",
    "| --- | --- | --- | --- |",
  ];
  for (const v of list) {
    out.push(
      `| ${v.element} | ${v.label ?? ""} | ${v.type ?? ""} | ${v.mandatory ? "yes" : ""} |`,
    );
  }
  return out;
}

function runLines(runs: Run[] | undefined): string[] {
  if (!runs) return [];
  const out = ["", "## Latest runs", ""];
  if (!runs.length) out.push("_No runs found._");
  for (const r of runs) {
    out.push(
      `- ${r.started ?? "?"} · ${r.state ?? "?"}${r.table ? ` · ${r.table}` : ""}${r.record ? ` ${r.record}` : ""} (${r.sys_id})`,
    );
    for (const e of r.errors ?? []) out.push(`  - error: ${fmt(e.message)}`);
  }
  return out;
}

function migrationLines(m: MigrationReport | undefined): string[] {
  if (!m) return [];
  const out = ["", `## Migration report (${m.scope})`, "", m.note, ""];
  if (!m.workflows.length) out.push("_No workflow is referenced or running._");
  for (const w of m.workflows) {
    out.push(
      `- **${w.name ?? w.sys_id}**: ${w.inUse ? "in use" : "not referenced"} — ${w.catalogItems.length} catalog item(s), ${w.slaDefinitions.length} SLA definition(s), ${w.runningContexts} running context(s)`,
    );
    for (const c of w.catalogItems)
      out.push(`  - catalog item ${c.name ?? c.sys_id}`);
    for (const s of w.slaDefinitions) out.push(`  - SLA ${s.name ?? s.sys_id}`);
  }
  return out;
}

/** The playbook part of the Markdown report (header to runs). */
function playbookLines(result: ExplainFlowResult): string[] {
  const p = result.playbook;
  const c = result.counts;
  const out = [`# Playbook ${p?.name ?? result.sys_id}`, ""];
  if (!p) {
    out.push(
      result.available === false
        ? "_Process Automation Designer is not available on this instance._"
        : "_The playbook could not be read._",
    );
    return out;
  }
  out.push(
    `${c.lanes ?? 0} lane(s), ${c.activities} activity(ies), ${c.triggers ?? 0} trigger(s), ${c.timers ?? 0} timer(s), ${c.variants ?? 0} variant(s). verified:false.`,
    "",
  );
  if (p.internal_name) out.push(`- Internal name: ${p.internal_name}`);
  if (p.table) out.push(`- Table: ${p.table}`);
  if (p.status) out.push(`- Status: ${p.status}`);
  if (p.active !== undefined) out.push(`- Active: ${p.active}`);
  if (p.description) out.push(`- Description: ${fmt(p.description)}`);
  if (result.triggers?.length) {
    out.push("", "## Triggers", "");
    for (const t of result.triggers) {
      out.push(
        `- ${pdTriggerText(t)}${t.condition ? ` · condition: ${fmt(t.condition)}` : ""}`,
      );
    }
  }
  out.push("", "## Lanes", "");
  if (!result.lanes?.length) out.push("_No lanes found._");
  for (const lane of result.lanes ?? []) {
    out.push(
      `- **${lane.number} ${lane.name}**${lane.condition ? ` · condition: ${fmt(lane.condition)}` : ""}`,
    );
    if (!lane.activities.length) out.push("  - _No activities._");
    for (const a of lane.activities) {
      out.push(
        `  - ${a.number} ${a.name}${a.definition ? ` _(${a.definition.name ?? a.definition.sys_id})_` : ""}${a.condition ? ` · condition: ${fmt(a.condition)}` : ""}`,
      );
      for (const t of a.timers ?? []) out.push(`    - ${timerText(t)}`);
    }
  }
  out.push(
    ...variablesTable("Inputs", result.inputs),
    ...variablesTable("Outputs", result.outputs),
  );
  if (result.variants?.length) {
    out.push("", "## Variants", "");
    for (const v of result.variants) {
      out.push(
        `- ${v.name}${v.active === false ? " (inactive)" : ""}${v.condition ? ` · condition: ${fmt(v.condition)}` : ""}`,
      );
    }
  }
  const runs = runLines(result.runs);
  for (const r of result.runs ?? []) {
    const states = Object.entries(r.activityStates ?? {});
    if (!states.length) continue;
    const at = runs.findIndex((l) => l.endsWith(`(${r.sys_id})`));
    runs.splice(
      at + 1,
      0,
      `  - activities: ${states.map(([s, n]) => `${s} ${n}`).join(", ")}`,
    );
  }
  out.push(...runs);
  return out;
}

/** A readable report: header, trigger, steps / activities, diagram, caveats. */
export function flowMarkdown(
  result: ExplainFlowResult,
  mermaid: string,
): string {
  const out: string[] = [];
  const c = result.counts;
  if (result.kind === "workflow") {
    const w = result.workflow;
    out.push(
      `# Workflow ${w?.name ?? result.sys_id ?? "(instance migration report)"}`,
      "",
    );
    if (w) {
      out.push(
        `${c.activities} activity(ies), ${c.transitions} transition(s), ${c.stages} stage(s). verified:false.`,
      );
      if (w.table) out.push("", `- Table: ${w.table}`);
      if (w.active !== undefined) out.push(`- Active: ${w.active}`);
      if (result.version) {
        out.push(
          `- Version: ${result.version.name ?? result.version.sys_id}${result.version.published ? " (published)" : " (not published)"}`,
        );
      }
      out.push("", "## Activities", "");
      const names = new Map(
        (result.activities ?? []).map((a) => [a.sys_id, a.name]),
      );
      for (const a of result.activities ?? []) {
        out.push(
          `- **${a.name}**${a.definition?.name ? ` (${a.definition.name})` : ""}`,
        );
        for (const t of (result.transitions ?? []).filter(
          (x) => x.from === a.sys_id,
        )) {
          out.push(
            `  - ${t.condition?.name ?? "→"} → ${names.get(t.to) ?? t.to}`,
          );
        }
      }
      if (result.stages?.length) {
        out.push("", "## Stages", "");
        for (const s of result.stages)
          out.push(`- ${s.label}${s.value ? ` (${s.value})` : ""}`);
      }
    }
    out.push(...runLines(result.runs), ...migrationLines(result.migration));
  } else if (result.kind === "playbook") {
    out.push(...playbookLines(result));
  } else {
    const f = result.flow;
    const a = result.action;
    out.push(
      `# ${HEADER[result.kind]} ${f?.name ?? a?.name ?? result.sys_id}`,
      "",
    );
    out.push(
      result.kind === "action"
        ? `${c.steps} step(s), ${c.inputs} input(s), ${c.outputs} output(s). verified:false.`
        : `${c.steps} step(s): ${c.actions} action(s), ${c.logic} logic, ${c.subflows} subflow call(s)${c.callees ? `; ${c.callees} callee(s) expanded` : ""}. verified:false.`,
    );
    if (a) {
      out.push("");
      if (a.internal_name) out.push(`- Internal name: ${a.internal_name}`);
      if (a.category) out.push(`- Category: ${a.category}`);
      if (a.access) out.push(`- Access: ${a.access}`);
      if (a.active !== undefined) out.push(`- Active: ${a.active}`);
      if (a.description) out.push(`- Description: ${fmt(a.description)}`);
    }
    if (f) {
      out.push("");
      if (f.status) out.push(`- Status: ${f.status}`);
      if (f.active !== undefined) out.push(`- Active: ${f.active}`);
      if (f.run_as) out.push(`- Run as: ${f.run_as}`);
      if (f.run_with_roles.length) {
        out.push(
          `- Run with roles: ${f.run_with_roles.map((r) => r.name ?? r.sys_id).join(", ")}`,
        );
      }
      const p = result.published;
      if (p) {
        out.push(
          `- Published: ${p.basis === "never-published" ? "never" : p.draftDiffers ? "yes — the draft differs" : "yes — the draft matches"}`,
        );
      }
    }
    if (result.trigger) {
      out.push("", "## Trigger", "", `- ${triggerText(result.trigger)}`);
      if (result.trigger.condition)
        out.push(`- Condition: ${result.trigger.condition}`);
      out.push(...valuesLines(result.trigger.values, ""));
    }
    out.push("", "## Steps", "");
    const steps = (list: FlowStep[], indent: string): void => {
      for (const s of list) {
        out.push(`${indent}- **${stepText(s)}** _(${s.kind})_`);
        out.push(...valuesLines(s.values, `${indent}  `));
        steps(s.children, `${indent}  `);
        if (s.childrenOmitted)
          out.push(
            `${indent}  - _${s.childrenOmitted} nested step(s) not expanded_`,
          );
        const callee = s.callee;
        if (callee) {
          out.push(
            `${indent}  - ↳ calls ${calleeText(callee)}${callee.cycle ? " _(cycle — not expanded)_" : callee.steps.length ? "" : " _(no steps found)_"}`,
          );
          if (!callee.cycle) steps(callee.steps, `${indent}    `);
        }
      }
    };
    if (!result.steps?.length) out.push("_No steps found._");
    steps(result.steps ?? [], "");
    out.push(
      ...variablesTable("Inputs", result.inputs),
      ...variablesTable("Outputs", result.outputs),
      ...variablesTable("Variables", result.variables),
    );
    if (result.stages?.length) {
      out.push("", "## Stages", "");
      for (const s of result.stages)
        out.push(`- ${s.label}${s.value ? ` (${s.value})` : ""}`);
    }
    out.push(...runLines(result.runs));
  }
  if (result.kind !== "workflow" || result.workflow) {
    out.push("", "## Diagram", "", "```mermaid", mermaid, "```");
  }
  out.push("", "## Caveats", "");
  for (const cav of result.caveats) out.push(`- ${cav}`);
  for (const [table, fields] of Object.entries(result.missingFields ?? {})) {
    out.push(`- ${table}: fields not returned: ${fields.join(", ")}`);
  }
  return out.join("\n");
}
