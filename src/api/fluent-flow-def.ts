/**
 * P-27 `Flow` / `Subflow` / `Action` emission: steps, `wfa.flowLogic.*`
 * blocks, subflow calls, the trigger and the main call.
 */
import {
  type DecodedValues,
  type ExplainFlowKind,
  type FlowStep,
  type FlowTrigger,
} from "./explain-flow.js";
import {
  arr,
  code,
  lit,
  obj,
  oneLine,
  render,
  tsString,
  type Expr,
  type Prop,
} from "./fluent-render.js";
import {
  ACTION_INSTANCE_V2,
  norm,
  CORE_ACTIONS,
  CORE_STEPS,
  LOGIC,
  TRIGGERS,
  PAD,
  pad,
  usedParam,
  asText,
  LOGIC_CONSUMED,
  withProp,
  durationExpr,
} from "./fluent-flow-maps.js";
import { FlowEmit } from "./fluent-flow-base.js";

/** The flow / subflow / action body: steps, logic blocks, trigger and the main call. */
export class FlowDefEmit extends FlowEmit {
  // --- steps -------------------------------------------------------------------------

  /** Statements for a list of sibling steps. */
  steps(list: FlowStep[], depth: number, inParallel: boolean): string[] {
    const lines: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      this.seen.add(s.sys_id);
      if (s.childrenOmitted) {
        this.h.unsupported({
          kind: "child",
          table: s.source,
          sys_id: s.sys_id,
          reason: `Step ${s.number}: ${s.childrenOmitted} nested step(s) past the tree depth cap are not in the tree.`,
        });
      }
      if (s.comment) lines.push(`${pad(depth)}// ${oneLine(s.comment)}`);
      if (s.kind === "action" || s.kind === "step") {
        this.action(s, lines, depth);
      } else if (s.kind === "subflow") {
        this.subflow(s, lines, depth);
      } else {
        i = this.logic(list, i, lines, depth, inParallel);
      }
    }
    return lines;
  }

  action(s: FlowStep, lines: string[], depth: number): void {
    const name = s.ref?.name ?? s.name;
    const hit = (s.kind === "step" ? CORE_STEPS : CORE_ACTIONS).get(norm(name));
    const k = this.nodeKey(s.kind, s.sys_id, s.source);
    if (!hit) {
      return this.fallbackStep(
        s,
        s.kind === "step"
          ? `action step type '${name}' has no actionStep mapping`
          : `'${name}' is a spoke or custom action outside action.core`,
        lines,
        depth,
        k,
      );
    }
    const raw = this.rawInputs(s.values);
    if (!raw) {
      return this.fallbackStep(s, this.undecoded(s.values), lines, depth, k);
    }
    if (s.children.length) {
      return this.fallbackStep(
        s,
        "an action step with nested steps",
        lines,
        depth,
        k,
      );
    }
    const [exp, spec] = hit;
    // now-sdk build resolves an action step by its built-in definition sys_id;
    // a step whose definition is a copy under the same name has no Fluent form.
    const defId = s.ref?.sys_id.toLowerCase();
    if (s.kind === "step" && defId && defId !== spec.sysId) {
      return this.fallbackStep(
        s,
        `step definition ${defId} is not the built-in '${spec.name}' (${spec.sysId})`,
        lines,
        depth,
        k,
      );
    }
    // now-sdk build writes wfa.action as sys_hub_action_instance_v2; a key on
    // the legacy table would make it mint a new sys_id (P-29 oracle).
    if (s.kind !== "step") this.h.retable(k, ACTION_INSTANCE_V2);
    const fn = s.kind === "step" ? "actionStep" : "action";
    const ref = s.kind === "step" ? `actionStep.${exp}` : `action.core.${exp}`;
    const unknown = raw
      .map(([n]) => n)
      .filter((n) => !spec.inputs[n] || spec.inputs[n]?.hidden);
    const missing = Object.entries(spec.inputs)
      .filter(
        ([n, i]) => i.mandatory && !i.hidden && !raw.some(([r]) => r === n),
      )
      .map(([n]) => n);
    this.automation.add("wfa");
    const cfg = render(obj([this.idProp(k)]), depth);
    if (!unknown.length && !missing.length) {
      this.automation.add(fn);
      const props = raw.map(([n, v]) =>
        this.typedProp(n, spec.inputs[n]?.kind ?? "String", v, k, s.sys_id),
      );
      lines.push(
        `${pad(depth)}wfa.${fn}(${ref}, ${cfg}, ${render(obj(props), depth)})`,
      );
      return;
    }
    const why = [
      ...(unknown.length
        ? [`input(s) ${unknown.join(", ")} not in ${ref}`]
        : []),
      ...(missing.length ? [`mandatory ${missing.join(", ")} not set`] : []),
    ].join("; ");
    const props = raw.map(([n, v]) => this.prop(n, v, k, s.sys_id));
    // The untyped forms: an action by its definition sys_id, a step by its
    // built-in name (now-sdk build resolves only those for actionStep).
    const target =
      s.kind === "step"
        ? spec.name
        : (s.ref?.sys_id ?? spec.sysId).toLowerCase();
    lines.push(
      `${pad(depth)}// ${ref} by ${s.kind === "step" ? "name" : "sys_id"} (untyped inputs): ${oneLine(why)}`,
      `${pad(depth)}wfa.${fn}(${tsString(target)}, ${cfg}, ${render(obj(props), depth)})`,
    );
  }

  undecoded(v: DecodedValues | undefined): string {
    if (v?.inputsOmitted) {
      return `${v.inputsOmitted} input(s) past the per-step cap are not in the tree`;
    }
    return `its values could not be decoded${v?.reason ? ` (${v.reason})` : ""}`;
  }

  subflow(s: FlowStep, lines: string[], depth: number): void {
    const k = this.nodeKey("subflow", s.sys_id, s.source);
    const inputs = this.inputs(s.values, k, s.sys_id);
    if (!s.ref || !inputs || s.children.length) {
      return this.fallbackStep(
        s,
        !s.ref
          ? "the called subflow is not resolved"
          : !inputs
            ? this.undecoded(s.values)
            : "a subflow call with nested steps",
        lines,
        depth,
        k,
      );
    }
    this.automation.add("wfa");
    lines.push(
      `${pad(depth)}// TODO: pass the imported Subflow() '${oneLine(s.ref.name ?? s.ref.sys_id)}' instead of its sys_id for typed inputs`,
      `${pad(depth)}wfa.subflow(${tsString(s.ref.sys_id.toLowerCase())}, ${render(obj([this.idProp(k)]), depth)}, ${render(obj(inputs), depth)})`,
    );
  }

  /**
   * The config of a logic block: `$id` plus the decoded inputs named in
   * `keep`; any other input is reported. Undefined when not decodable.
   */
  logicConfig(
    s: FlowStep,
    k: string,
    keep: readonly string[] = [],
  ): { cfg: Expr; raw: Map<string, unknown> } | undefined {
    const raw = this.rawInputs(s.values);
    if (!raw) return undefined;
    const props: Prop[] = [this.idProp(k)];
    const all = new Map(raw);
    for (const [n, v] of raw) {
      if (keep.includes(n)) {
        props.push(this.prop(n, v, k, s.sys_id));
      } else if (!LOGIC_CONSUMED.includes(n) && asText(v) !== "") {
        this.h.unsupported({
          kind: "field",
          table: s.source,
          key: k,
          sys_id: s.sys_id,
          field: n,
          reason: `Logic input '${n}' has no wfa.flowLogic config property; not emitted.`,
        });
      }
    }
    return { cfg: obj(props), raw: all };
  }

  /** A block body: `() => {…}` (or with a parameter). */
  block(
    children: FlowStep[],
    depth: number,
    inParallel: boolean,
    param = "",
    tail: string[] = [],
    endFlowScope = true,
  ): string {
    if (endFlowScope) this.endFlowScopes++;
    let body: string[];
    try {
      body = [
        ...this.steps(children, depth + 1, inParallel),
        ...tail.map((t) => `${pad(depth + 1)}${t}`),
      ];
    } finally {
      if (endFlowScope) this.endFlowScopes--;
    }
    const arg = usedParam(param, body.join("\n"));
    return body.length
      ? `(${arg}) => {\n${body.join("\n")}\n${pad(depth)}}`
      : `(${arg}) => {}`;
  }

  /** A condition value of a logic input (pills kept), or undefined when empty. */
  condition(v: unknown, k: string, sysId: string): Expr | undefined {
    const t = asText(v);
    return t ? this.stringValue(t, k, sysId) : undefined;
  }

  /** One logic step (and the siblings it chains); returns the last index consumed. */
  logic(
    list: FlowStep[],
    i: number,
    lines: string[],
    depth: number,
    inParallel: boolean,
  ): number {
    const s = list[i]!;
    const spec = LOGIC[norm(s.ref?.name ?? s.name)];
    const k = this.nodeKey("logic", s.sys_id, s.source);
    const unsupported = (why: string): number => {
      this.fallbackStep(s, why, lines, depth, k);
      return i;
    };
    if (!spec) {
      return unsupported(
        `logic '${s.ref?.name ?? s.name}' has no wfa.flowLogic mapping`,
      );
    }
    const keep =
      spec.role === "if" || spec.role === "elseIf"
        ? ["label"]
        : spec.role === "doUntil"
          ? ["label"]
          : [];
    const lc = this.logicConfig(s, k, keep);
    if (!lc) return unsupported(this.undecoded(s.values));
    const { raw } = lc;
    let cfg = lc.cfg;
    const p = pad(depth);
    this.automation.add("wfa");
    switch (spec.role) {
      case "if": {
        const cond = this.condition(raw.get("condition"), k, s.sys_id);
        if (!cond) return unsupported("an If without a condition");
        cfg = withProp(cfg, "condition", cond);
        lines.push(
          `${p}wfa.flowLogic.if(${render(cfg, depth)}, ${this.block(s.children, depth, inParallel)})`,
        );
        let j = i + 1;
        for (; j < list.length; j++) {
          const n = list[j]!;
          const role = LOGIC[norm(n.ref?.name ?? n.name)]?.role;
          if (role !== "elseIf" && role !== "else") break;
          const nk = this.nodeKey("logic", n.sys_id, n.source);
          const nl = this.logicConfig(
            n,
            nk,
            role === "elseIf" ? ["label"] : [],
          );
          if (!nl) break;
          let ncfg = nl.cfg;
          if (role === "elseIf") {
            const nc = this.condition(nl.raw.get("condition"), nk, n.sys_id);
            if (!nc) break;
            ncfg = withProp(ncfg, "condition", nc);
          }
          this.seen.add(n.sys_id);
          if (n.comment) lines.push(`${p}// ${oneLine(n.comment)}`);
          lines.push(
            `${p}wfa.flowLogic.${role}(${render(ncfg, depth)}, ${this.block(n.children, depth, inParallel)})`,
          );
          if (role === "else") {
            j++;
            break;
          }
        }
        return j - 1;
      }
      case "elseIf":
      case "else":
        return unsupported(`'${s.name}' without a preceding If`);
      case "catch":
        return unsupported("'Catch' without a preceding Try");
      case "path":
        return unsupported(
          "a parallel path outside 'Do the following in parallel'",
        );
      case "forEach": {
        const items = asText(raw.get("items"));
        if (!items) return unsupported("a For Each without items");
        const itemsExpr = this.stringValue(items, k, s.sys_id, "records");
        lines.push(
          `${p}wfa.flowLogic.forEach(${render(itemsExpr, depth)}, ${render(cfg, depth)}, ${this.block(s.children, depth, inParallel, "item")})`,
        );
        return i;
      }
      case "doUntil": {
        const cond = this.condition(raw.get("condition"), k, s.sys_id);
        if (!cond)
          return unsupported("a Do the following until without a condition");
        lines.push(
          `${p}wfa.flowLogic.doTheFollowing(${render(cfg, depth)}, ${this.block(s.children, depth, inParallel, "", [`wfa.flowLogic.until(${render(cond, depth + 1)})`])})`,
        );
        return i;
      }
      case "try": {
        const next = list[i + 1];
        const hasCatch =
          next !== undefined &&
          LOGIC[norm(next.ref?.name ?? next.name)]?.role === "catch";
        let catchBlock = "() => {}";
        if (hasCatch) {
          this.seen.add(next.sys_id);
          // The Catch block's own key is registered so its sys_id is traceable.
          this.nodeKey("logic", next.sys_id, next.source);
          catchBlock = this.block(
            next.children,
            depth + 1,
            inParallel,
            "",
            [],
            false,
          );
        }
        lines.push(
          `${p}wfa.flowLogic.tryCatch(${render(cfg, depth)}, {\n${p}${PAD}try: ${this.block(s.children, depth + 1, inParallel, "", [], false)},\n${p}${PAD}catch: ${catchBlock},\n${p}})`,
        );
        return hasCatch ? i + 1 : i;
      }
      case "parallel": {
        if (inParallel)
          return unsupported("nested doInParallel is not supported");
        const branches = s.children.map((c) => {
          const role = LOGIC[norm(c.ref?.name ?? c.name)]?.role;
          if (role === "path") {
            this.seen.add(c.sys_id);
            this.nodeKey("logic", c.sys_id, c.source);
            return this.block(c.children, depth + 1, true);
          }
          return this.block([c], depth + 1, true);
        });
        const args = [render(cfg, depth + 1), ...branches].map(
          (a) => `${p}${PAD}${a},`,
        );
        lines.push(
          `${p}wfa.flowLogic.doInParallel(\n${args.join("\n")}\n${p})`,
        );
        return i;
      }
      case "leaf": {
        if (s.children.length) {
          return unsupported(`'${s.name}' with nested steps`);
        }
        if (spec.call === "endFlow" && !this.endFlowScopes) {
          return unsupported(
            "End Flow outside an If / For Each / Do the following / Do in parallel block (the SDK rejects wfa.flowLogic.endFlow there)",
          );
        }
        if (spec.call === "waitForADuration") {
          const d = durationExpr(asText(raw.get("duration")));
          if (!d)
            return unsupported(
              "a wait duration that is not an explicit duration",
            );
          cfg = withProp(
            withProp(cfg, "durationType", lit("explicit_duration")),
            "duration",
            d,
          );
        } else if (
          spec.call === "setFlowVariables" ||
          spec.call === "assignSubflowOutputs"
        ) {
          const target =
            spec.call === "setFlowVariables"
              ? "params.flowVariables"
              : "params.outputs";
          const values = [...raw]
            .filter(([n]) => !LOGIC_CONSUMED.includes(n))
            .map(([n, v]) => this.prop(n, v, k, s.sys_id));
          lines.push(
            `${p}wfa.flowLogic.${spec.call}(${render(obj([this.idProp(k)]), depth)}, ${target}, ${render(obj(values), depth)})`,
          );
          return i;
        }
        lines.push(`${p}wfa.flowLogic.${spec.call}(${render(cfg, depth)})`);
        return i;
      }
    }
  }

  // --- trigger -------------------------------------------------------------------------

  trigger(tr: FlowTrigger | null | undefined): string {
    if (!tr) {
      this.notes.push("The flow has no trigger in the instance tree.");
      return "undefined /* no trigger */";
    }
    this.seen.add(tr.sys_id);
    const table = tr.source || "sys_hub_trigger_instance";
    const k = this.nodeKey("trigger", tr.sys_id, table);
    const path =
      TRIGGERS[norm(tr.type)] ??
      TRIGGERS[norm(tr.definition?.type)] ??
      TRIGGERS[norm(tr.definition?.name)];
    const inputs = this.inputs(tr.values, k, tr.sys_id);
    if (!path || !inputs) {
      const label = tr.definition?.name ?? tr.type ?? tr.sys_id;
      const reason = !path
        ? `Trigger '${label}' has no trigger.* mapping; emitted as Record().`
        : `Trigger '${label}': ${this.undecoded(tr.values)}; emitted as Record().`;
      this.h.unsupported({
        kind: "api",
        table,
        key: k,
        sys_id: tr.sys_id,
        reason,
      });
      this.fallbackRow(
        table,
        tr.sys_id,
        k,
        () =>
          this.synthFlat("flow", {
            trigger_definition: tr.definition?.sys_id,
            trigger_type: tr.type,
            table: tr.table,
            condition: tr.condition,
          }),
        reason,
      );
      return "undefined /* trigger emitted as Record() below */";
    }
    this.automation.add("wfa");
    this.automation.add("trigger");
    const cfg: Prop[] = [];
    if (tr.table) cfg.push({ key: "table", value: lit(tr.table) });
    if (tr.condition) {
      cfg.push({
        key: "condition",
        value: this.stringValue(tr.condition, k, tr.sys_id),
      });
    }
    for (const p of inputs) {
      if (!cfg.some((c) => c.key === p.key)) cfg.push(p);
    }
    return `wfa.trigger(trigger.${path}, ${render(obj([this.idProp(k)]), 1)}, ${render(obj(cfg), 1)})`;
  }

  // --- the whole file ----------------------------------------------------------------

  /** Flow / Subflow / Action. */
  flowLike(kind: ExplainFlowKind): string {
    const tr = this.tree;
    const head = kind === "action" ? tr.action : tr.flow;
    const api = this.t.sdkApi;
    this.automation.add(api);
    const props: Prop[] = [
      this.idProp(this.key),
      { key: "name", value: lit(head?.name ?? this.src.name ?? "") },
    ];
    if (head?.internal_name) {
      props.push({ key: "internalName", value: lit(head.internal_name) });
    }
    if (head?.description) {
      props.push({ key: "description", value: lit(head.description) });
    }
    if (kind === "action") {
      const a = tr.action;
      if (a?.category) props.push({ key: "category", value: lit(a.category) });
      if (a?.access) props.push({ key: "access", value: lit(a.access) });
    } else {
      const f = tr.flow;
      if (f?.run_as) props.push({ key: "runAs", value: lit(f.run_as) });
      if (f?.run_with_roles.length) {
        props.push({
          key: "runWithRoles",
          value: arr(
            f.run_with_roles.map((r) =>
              r.name
                ? lit(r.name)
                : code(
                    `Now.ref('sys_user_role', ${tsString(r.sys_id.toLowerCase())})`,
                  ),
            ),
          ),
        });
      }
    }
    const ioTables: readonly [string, string] =
      kind === "action"
        ? ["sys_hub_action_input", "sys_hub_action_output"]
        : ["sys_hub_flow_input", "sys_hub_flow_output"];
    if (kind !== "flow") {
      const ins = this.columns(tr.inputs, ioTables[0], "input");
      if (ins) props.push({ key: "inputs", value: ins });
      const outs = this.columns(tr.outputs, ioTables[1], "output");
      if (outs) props.push({ key: "outputs", value: outs });
      // Action() requires both, even when empty.
      if (kind === "action") {
        if (!ins) props.push({ key: "inputs", value: obj([]) });
        if (!outs) props.push({ key: "outputs", value: obj([]) });
      }
    } else {
      for (const [list, table, what] of [
        [tr.inputs, ioTables[0], "input"],
        [tr.outputs, ioTables[1], "output"],
      ] as const) {
        for (const v of list ?? []) {
          this.seen.add(v.sys_id);
          const k = this.nodeKey(what, v.sys_id, table);
          const reason = `A flow has no ${what}s in Fluent; '${v.element}' emitted as Record().`;
          this.h.unsupported({
            kind: "field",
            table,
            key: k,
            sys_id: v.sys_id,
            field: v.element,
            reason,
          });
          this.fallbackRow(
            table,
            v.sys_id,
            k,
            () => this.synthFlat("model", { ...v }),
            reason,
          );
        }
      }
    }
    if (kind !== "action") {
      const vars = this.columns(
        tr.variables,
        "sys_hub_flow_variable",
        "variable",
      );
      if (vars) props.push({ key: "flowVariables", value: vars });
      const st = this.stages(tr.stages);
      if (st) props.push({ key: "stages", value: st });
    }
    const state = [
      tr.flow?.status ? `status ${tr.flow.status}` : "",
      head?.active !== undefined ? `active ${head.active}` : "",
    ].filter(Boolean);
    if (state.length) {
      this.notes.push(`Instance state (not emitted): ${state.join(", ")}.`);
    }

    const args = [`${PAD}${render(obj(props), 1)},`];
    if (kind === "flow") args.push(`${PAD}${this.trigger(tr.trigger)},`);
    const body = this.steps(tr.steps ?? [], 2, false);
    const params = usedParam("params", body.join("\n"));
    args.push(
      body.length
        ? `${PAD}(${params}) => {\n${body.join("\n")}\n${PAD}},`
        : `${PAD}(${params}) => {},`,
    );
    return `${api}(\n${args.join("\n")}\n)`;
  }
}
