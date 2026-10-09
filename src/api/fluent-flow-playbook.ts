/**
 * P-27 `PlaybookDefinition` emission: lanes, activities, triggers and
 * timer fallbacks.
 */
import { type PdActivity, type PdTimer } from "./explain-flow.js";
import {
  arr,
  code,
  lit,
  obj,
  render,
  type Expr,
  type Prop,
} from "./fluent-render.js";
import {
  norm,
  ACTIVITIES,
  PB_TRIGGERS,
  PAD,
  arrowObj,
  durationExpr,
} from "./fluent-flow-maps.js";
import { FlowEmit } from "./fluent-flow-base.js";

/** The `PlaybookDefinition` body: lanes, activities, triggers and timers. */
export class PlaybookEmit extends FlowEmit {
  /** PlaybookDefinition(config, { triggers }, { lanes }). */
  playbook(): string {
    const tr = this.tree;
    const head = tr.playbook;
    this.automation.add("PlaybookDefinition");
    this.automation.add("wfa");
    const props: Prop[] = [
      this.idProp(this.key),
      { key: "label", value: lit(head?.name ?? this.src.name ?? "") },
    ];
    if (head?.internal_name) {
      props.push({ key: "name", value: lit(head.internal_name) });
    }
    if (head?.table) props.push({ key: "parentTable", value: lit(head.table) });
    if (head?.description) {
      props.push({ key: "description", value: lit(head.description) });
    }
    const ins = this.columns(tr.inputs, "sys_pd_process_input", "input");
    if (ins) props.push({ key: "inputs", value: ins });
    const outs = this.columns(tr.outputs, "sys_pd_process_output", "output");
    if (outs) props.push({ key: "outputs", value: outs });
    const triggers: Expr[] = [];
    for (const g of tr.triggers ?? []) {
      this.seen.add(g.sys_id);
      const k = this.nodeKey("trigger", g.sys_id, "sys_pd_trigger_instance");
      const type =
        PB_TRIGGERS[norm(g.type)] ?? PB_TRIGGERS[norm(g.definition?.name)];
      if (!type || !g.table) {
        const reason = `Playbook trigger '${g.name ?? g.definition?.name ?? g.sys_id}': ${type ? "no table" : `type '${g.type ?? g.definition?.name ?? "none"}' has no PlaybookTriggerTypes record trigger`}; emitted as Record().`;
        this.h.unsupported({
          kind: "api",
          table: "sys_pd_trigger_instance",
          key: k,
          sys_id: g.sys_id,
          reason,
        });
        this.fallbackRow(
          "sys_pd_trigger_instance",
          g.sys_id,
          k,
          () =>
            this.synthFlat("process_definition", {
              name: g.name,
              type: g.type,
              table: g.table,
              condition: g.condition,
              trigger_definition: g.definition?.sys_id,
            }),
          reason,
        );
        continue;
      }
      this.automation.add("PlaybookTriggerTypes");
      const cfg: Prop[] = [this.idProp(k)];
      if (g.name) cfg.push({ key: "label", value: lit(g.name) });
      const inputs: Prop[] = [{ key: "table", value: lit(g.table) }];
      if (g.condition) {
        inputs.push({ key: "condition", value: lit(g.condition) });
      }
      triggers.push(
        code(
          `wfa.playbook.trigger(PlaybookTriggerTypes.${type}, ${render(obj(cfg), 3)}, ${render(obj(inputs), 3)})`,
        ),
      );
    }
    const lanes: Prop[] = (tr.lanes ?? []).map((lane) => {
      this.seen.add(lane.sys_id);
      const lk = this.nodeKey("lane", lane.sys_id, "sys_pd_lane");
      const acts: Prop[] = [];
      for (const a of lane.activities) {
        const e = this.activity(a, lane.sys_id);
        if (e) acts.push(e);
      }
      const config: Prop[] = [
        this.idProp(lk),
        { key: "label", value: lit(lane.name) },
        { key: "order", value: lit(lane.order) },
        { key: "startRule", value: code("wfa.playbook.run.Immediately()") },
        { key: "restartRule", value: lit("RUN_ALWAYS") },
      ];
      if (lane.condition) {
        config.push({ key: "conditionToRun", value: lit(lane.condition) });
      }
      return {
        key: lk,
        value: code(
          `wfa.playbook.lane(${render(
            obj([
              { key: "config", value: obj(config) },
              {
                key: "activities",
                value: arrowObj(obj(acts), 4),
              },
            ]),
            3,
          )})`,
        ),
      };
    });
    if (lanes.length) {
      this.notes.push(
        "Lane / activity startRule and restartRule are not in the explain_flow tree: emitted as Run.Immediately() / RUN_ALWAYS — review them.",
      );
    }
    for (const v of tr.variants ?? []) {
      const k = this.nodeKey("variant", v.sys_id, "sys_pd_process_variant");
      const reason = `Playbook variant '${v.name}' has no PlaybookDefinition property; emitted as Record().`;
      this.h.unsupported({
        kind: "api",
        table: "sys_pd_process_variant",
        key: k,
        sys_id: v.sys_id,
        reason,
      });
      this.fallbackRow(
        "sys_pd_process_variant",
        v.sys_id,
        k,
        () =>
          this.synthFlat("process_definition", {
            label: v.name,
            active: v.active,
            condition: v.condition,
            order: v.order,
          }),
        reason,
      );
    }
    const state = [
      head?.status ? `status ${head.status}` : "",
      head?.active !== undefined ? `active ${head.active}` : "",
    ].filter(Boolean);
    if (state.length) {
      this.notes.push(`Instance state (not emitted): ${state.join(", ")}.`);
    }
    const dependent = obj([{ key: "triggers", value: arr(triggers) }]);
    const body = obj([
      {
        key: "lanes",
        value: arrowObj(obj(lanes), 2),
      },
    ]);
    return `PlaybookDefinition(\n${PAD}${render(obj(props), 1)},\n${PAD}${render(dependent, 1)},\n${PAD}${render(body, 1)},\n)`;
  }

  /** One playbook activity (`key: wfa.playbook.activity(…)`), or undefined on fallback. */
  activity(a: PdActivity, laneId: string): Prop | undefined {
    this.seen.add(a.sys_id);
    const k = this.nodeKey("activity", a.sys_id, "sys_pd_activity");
    const defName = norm(a.definition?.name);
    const core = ACTIVITIES[defName];
    if (!core) {
      const reason =
        defName === "questionnaire"
          ? `Activity '${a.name}': playbook Questionnaire activities are not supported; emitted as Record().`
          : `Activity '${a.name}': definition '${a.definition?.name ?? a.definition?.sys_id ?? "none"}' has no ActivityDefinitions.Core mapping; emitted as Record().`;
      this.h.unsupported({
        kind: "api",
        table: "sys_pd_activity",
        key: k,
        sys_id: a.sys_id,
        reason,
      });
      this.fallbackRow(
        "sys_pd_activity",
        a.sys_id,
        k,
        () =>
          this.synthFlat(
            "lane",
            {
              label: a.name,
              order: String(a.order),
              activity_definition: a.definition?.sys_id,
              condition: a.condition,
            },
            ["sys_id"],
            ["sys_pd_lane", laneId],
          ),
        reason,
      );
      for (const tm of a.timers ?? []) {
        this.timerFallback(tm, a.sys_id, reason);
      }
      return undefined;
    }
    this.automation.add("ActivityDefinitions");
    const p: Prop[] = [
      this.idProp(k),
      { key: "label", value: lit(a.name) },
      { key: "order", value: lit(a.order) },
      { key: "startRule", value: code("wfa.playbook.run.Immediately()") },
      { key: "restartRule", value: lit("RUN_ALWAYS") },
    ];
    if (a.condition) p.push({ key: "conditionToRun", value: lit(a.condition) });
    let delayed = false;
    for (const tm of a.timers ?? []) {
      const d = delayed ? undefined : durationExpr(tm.duration ?? "");
      if (!d) {
        this.timerFallback(
          tm,
          a.sys_id,
          delayed
            ? "only one startWithDelay per activity"
            : `duration '${tm.duration ?? ""}' is not an explicit duration`,
        );
        continue;
      }
      delayed = true;
      this.seen.add(tm.sys_id);
      this.nodeKey("timer", tm.sys_id, "sys_pd_timer_attributes");
      p.push({
        key: "startWithDelay",
        value: obj([
          { key: "type", value: lit("explicit") },
          { key: "duration", value: d },
        ]),
      });
    }
    return {
      key: k,
      value: code(
        `wfa.playbook.activity(ActivityDefinitions.Core.${core}, ${render(obj(p), 5)})`,
      ),
    };
  }

  timerFallback(tm: PdTimer, activityId: string, reason: string): void {
    const k = this.nodeKey("timer", tm.sys_id, "sys_pd_timer_attributes");
    this.h.unsupported({
      kind: "api",
      table: "sys_pd_timer_attributes",
      key: k,
      sys_id: tm.sys_id,
      reason: `Timer not emitted as startWithDelay (${reason}); emitted as Record().`,
    });
    this.fallbackRow(
      "sys_pd_timer_attributes",
      tm.sys_id,
      k,
      () =>
        this.synthFlat(
          "activity",
          {
            name: tm.name,
            type: tm.type,
            duration: tm.duration,
          },
          ["sys_id", "activity"],
          ["sys_pd_activity", tm.activity ?? activityId],
        ),
      `timer ${tm.name ?? tm.sys_id}`,
    );
  }
}
