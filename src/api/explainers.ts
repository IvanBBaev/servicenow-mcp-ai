/**
 * P-7 — type-specific explain enrichers (project/SDK-PARITY.md §5(d)).
 *
 * `explain_artifact` reshapes any descriptor generically; some types mean
 * little until their child rows are read together. An enricher registered here
 * for an artefact type turns the record and its children into a structured
 * `explanation` (`{kind, ..., lines}`) that `explain-artifact.ts` adds to the
 * output:
 *
 * - `state-model` (`state_model`): states and the transitions between them;
 * - `choice-table` (`choice_set`, `table`): the choices of each element;
 * - `field-effects` (`ui_policy`, `data_policy`, `catalog_ui_policy`): what the
 *   policy does to each field when its condition holds, and when it does not;
 * - `catalog-form` (`catalog_item`, `record_producer`, `variable_set`, P-8):
 *   the variables in order with their choices, the included variable sets,
 *   the catalog client scripts and the catalog UI policies with their effects;
 * - `catalog-variable` (`catalog_variable`, P-8): one variable and its choices;
 * - `decision-table` (`decision_table`, P-11): the inputs and the rows in
 *   order, each with its condition and answer (tables and fields unverified).
 *
 * Enrichers are pure functions of already-read data (no extra requests) and
 * never fail the explain: `explain-artifact.ts` runs them guarded.
 */
import type { ArtifactType } from "../core/artifacts/registry.js";
import type { ArtifactChildResult } from "./artifacts.js";
import type { SnRecord } from "./table.js";
import { snString } from "./shared.js";

export interface ExplainerContext {
  t: ArtifactType;
  record: SnRecord;
  children: ArtifactChildResult[];
}

/** A structured explanation: its `kind`, kind-specific data, and prose lines. */
export interface Explanation {
  kind: string;
  lines: string[];
  [key: string]: unknown;
}

export type Explainer = (ctx: ExplainerContext) => Explanation | undefined;

const EXPLAINERS = new Map<string, Explainer>();

/**
 * Register the enricher of an artefact type; returns a function restoring the
 * previous one (tests plug in their own).
 */
export function registerExplainer(type: string, fn: Explainer): () => void {
  const previous = EXPLAINERS.get(type);
  EXPLAINERS.set(type, fn);
  return () => {
    if (previous) EXPLAINERS.set(type, previous);
    else EXPLAINERS.delete(type);
  };
}

/** The enricher registered for an artefact type, if any. */
export function getExplainer(type: string): Explainer | undefined {
  return EXPLAINERS.get(type);
}

/** The first non-empty value among `fields` of a row. */
function pick(row: SnRecord, fields: string[]): string {
  for (const f of fields) {
    const v = snString(row[f]);
    if (v) return v;
  }
  return "";
}

/** Rows of one child table (empty when it was not read). */
function rowsOf(ctx: ExplainerContext, table: string): SnRecord[] {
  return ctx.children.find((c) => c.table === table)?.records ?? [];
}

/** Why a child table has no rows, when it was not read at all. */
function unreadNote(ctx: ExplainerContext, table: string): string[] {
  const c = ctx.children.find((x) => x.table === table);
  if (!c) return [];
  const why = c.redacted
    ? "denied by the table policy"
    : c.error !== undefined
      ? `rejected by the instance (${c.status ?? "error"})`
      : c.reason;
  return why ? [`${table} was not read: ${why.replace(/\.$/, "")}.`] : [];
}

// -- state models ------------------------------------------------------------

const explainStateModel: Explainer = (ctx) => {
  const { record } = ctx;
  const states = rowsOf(ctx, "sttrm_state").map((r) => ({
    sys_id: snString(r.sys_id),
    value: pick(r, ["state_value", "value", "state"]),
    label: pick(r, ["label", "name", "display_name"]),
  }));
  const byId = new Map(states.map((s) => [s.sys_id, s]));
  const byValue = new Map(states.map((s) => [s.value, s]));
  const stateName = (ref: string): string => {
    const s = byId.get(ref) ?? byValue.get(ref);
    if (!s) return ref || "(any)";
    return s.label && s.label !== s.value
      ? `${s.label} (${s.value})`
      : s.value || s.label;
  };

  const conditions = new Map<string, string[]>();
  for (const r of rowsOf(ctx, "sttrm_transition_condition")) {
    const key = snString(r.transition);
    const text = pick(r, ["condition", "condition_string", "name", "label"]);
    if (!key || !text) continue;
    conditions.set(key, [...(conditions.get(key) ?? []), text]);
  }
  const transitions = rowsOf(ctx, "sttrm_state_transition").map((r) => {
    const own = pick(r, ["condition", "conditions"]);
    const conds = [
      ...(own ? [own] : []),
      ...(conditions.get(snString(r.sys_id)) ?? []),
    ];
    return {
      sys_id: snString(r.sys_id),
      ...(pick(r, ["name", "label"])
        ? { name: pick(r, ["name", "label"]) }
        : {}),
      from: stateName(snString(r.from_state)),
      to: stateName(snString(r.to_state)),
      ...(conds.length ? { conditions: conds } : {}),
    };
  });

  const table = snString(record.table);
  const field = pick(record, ["state_field", "field"]);
  const on = [table, field].filter(Boolean).join(".");
  const lines = [
    `State model '${snString(record[ctx.t.nameField])}'${on ? ` on ${on}` : ""}: ${states.length} state(s), ${transitions.length} transition(s).`,
    ...(states.length
      ? [`States: ${states.map((s) => stateName(s.sys_id)).join(", ")}.`]
      : []),
    ...transitions.map(
      (x) =>
        `${x.from} -> ${x.to}${x.conditions ? ` when ${x.conditions.join(" and ")}` : ""}`,
    ),
    ...unreadNote(ctx, "sttrm_state"),
    ...unreadNote(ctx, "sttrm_state_transition"),
    ...unreadNote(ctx, "sttrm_transition_condition"),
  ];
  return { kind: "state-model", states, transitions, lines };
};

// -- choice tables -----------------------------------------------------------

interface ChoiceRow {
  value: string;
  label: string;
  sequence: string;
  inactive?: true;
  dependent_value?: string;
  language?: string;
}

const explainChoices: Explainer = (ctx) => {
  const rows = rowsOf(ctx, "sys_choice");
  const elements = new Map<string, ChoiceRow[]>();
  for (const r of rows) {
    const element = snString(r.element);
    const language = snString(r.language);
    const dependent = snString(r.dependent_value);
    const choice: ChoiceRow = {
      value: snString(r.value),
      label: snString(r.label),
      sequence: snString(r.sequence),
      ...(snString(r.inactive) === "true" ? { inactive: true as const } : {}),
      ...(dependent ? { dependent_value: dependent } : {}),
      ...(language ? { language } : {}),
    };
    elements.set(element, [...(elements.get(element) ?? []), choice]);
  }
  const seq = (c: ChoiceRow) => {
    const n = Number(c.sequence);
    return c.sequence !== "" && Number.isFinite(n) ? n : Infinity;
  };
  const list = [...elements.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([element, choices]) => ({
      element,
      choices: choices.sort(
        (a, b) => seq(a) - seq(b) || a.value.localeCompare(b.value),
      ),
    }));
  if (
    ctx.t.type === "table" &&
    !list.length &&
    !unreadNote(ctx, "sys_choice").length
  ) {
    return undefined;
  }
  // Both sys_choice_set and sys_db_object hold the table in `name`.
  const table = snString(ctx.record.name);
  const lines = [
    `${rows.length} choice(s) on ${list.length} element(s) of ${table || "(unknown table)"}.`,
    ...list.map(
      ({ element, choices }) =>
        `${element || "(no element)"}: ${choices
          .map(
            (c) =>
              `${c.value}=${JSON.stringify(c.label)}${c.inactive ? " (inactive)" : ""}${c.dependent_value ? ` [if ${c.dependent_value}]` : ""}${c.language ? ` {${c.language}}` : ""}`,
          )
          .join(", ")}`,
    ),
    ...unreadNote(ctx, "sys_choice"),
  ];
  return { kind: "choice-table", elements: list, lines };
};

// -- UI / data policy field effects -------------------------------------------

/** Effect names per action field and value; `ignore` / empty = no change. */
const EFFECTS: Record<string, Record<string, string>> = {
  visible: { true: "visible", false: "hidden" },
  mandatory: { true: "mandatory", false: "optional" },
  disabled: { true: "read-only", false: "editable" },
  read_only: { true: "read-only", false: "editable" },
  cleared: { true: "cleared" },
};

/** What an effect turns into when the condition is false (reverse_if_false). */
const REVERSE: Record<string, string> = {
  visible: "hidden",
  hidden: "visible",
  mandatory: "optional",
  optional: "mandatory",
  "read-only": "editable",
  editable: "read-only",
};

/** What one policy action / rule does when the condition holds, and when not. */
function actionEffects(
  r: SnRecord,
  reverse: boolean,
): { whenTrue: string[]; whenFalse?: string[] } {
  const whenTrue: string[] = [];
  for (const [f, map] of Object.entries(EFFECTS)) {
    const effect = map[snString(r[f])];
    if (effect && !whenTrue.includes(effect)) whenTrue.push(effect);
  }
  const whenFalse = reverse
    ? whenTrue.map((e) => REVERSE[e]).filter((e): e is string => !!e)
    : [];
  return { whenTrue, ...(whenFalse.length ? { whenFalse } : {}) };
}

/** A catalog variable reference (`IO:<sys_id>`) without its prefix. */
function variableRef(value: string): string {
  return value.startsWith("IO:") ? value.slice(3) : value;
}

function fieldEffects(
  ctx: ExplainerContext,
  childTable: string,
  appliesTo: string,
  extra: string[],
): Explanation {
  const { record } = ctx;
  const reverse = snString(record.reverse_if_false) === "true";
  const effects = rowsOf(ctx, childTable)
    .map((r) => ({
      field: variableRef(
        pick(r, [
          "field",
          "element",
          "name",
          "variable_name",
          "catalog_variable",
        ]),
      ),
      ...actionEffects(r, reverse),
    }))
    .filter((e) => e.whenTrue.length);
  const condition = pick(record, [
    "conditions",
    "condition",
    "catalog_conditions",
  ]);
  const table = snString(record[appliesTo]);
  const describe = (key: "whenTrue" | "whenFalse") =>
    effects
      .filter((e) => e[key]?.length)
      .map((e) => `${e.field} ${e[key]!.join(", ")}`)
      .join("; ");
  const onTrue = describe("whenTrue");
  const onFalse = describe("whenFalse");
  const lines = [
    `${condition ? `When ${condition}` : "Always"}${table ? ` on ${table}` : ""}: ${onTrue || "no field changes"}.`,
    ...(onFalse ? [`Otherwise (reverse if false): ${onFalse}.`] : []),
    ...extra,
    ...unreadNote(ctx, childTable),
  ];
  return {
    kind: "field-effects",
    table,
    condition: condition || null,
    reverseIfFalse: reverse,
    effects,
    lines,
  };
}

const explainUiPolicy: Explainer = (ctx) => {
  const onLoad = snString(ctx.record.on_load);
  return fieldEffects(
    ctx,
    "sys_ui_policy_action",
    "table",
    onLoad === "false"
      ? ["Not applied on form load, only on field change."]
      : [],
  );
};

const explainDataPolicy: Explainer = (ctx) => {
  const r = ctx.record;
  const flag = (f: string) => snString(r[f]) === "true";
  const channels = [
    ...(flag("apply_import_set") ? ["import sets"] : []),
    ...(flag("apply_soap") ? ["web services"] : []),
    ...(flag("use_as_ui_policy") ? ["forms (as a UI policy)"] : []),
  ];
  return fieldEffects(ctx, "sys_data_policy_rule", "model_table", [
    channels.length
      ? `Also applied to ${channels.join(", ")}.`
      : "Import set, web service and UI policy flags are all off.",
  ]);
};

// -- Service Catalog forms (P-8) -----------------------------------------------

/** Catalog variable type codes (`item_option_new.type`). */
const VARIABLE_TYPES: Record<string, string> = {
  "1": "Yes / No",
  "2": "Multi Line Text",
  "3": "Multiple Choice",
  "4": "Numeric Scale",
  "5": "Select Box",
  "6": "Single Line Text",
  "7": "CheckBox",
  "8": "Reference",
  "9": "Date",
  "10": "Date/Time",
  "11": "Label",
  "12": "Break",
  "14": "Custom",
  "15": "UI Page",
  "16": "Wide Single Line Text",
  "17": "Custom with Label",
  "18": "Lookup Select Box",
  "19": "Container Start",
  "20": "Container End",
  "21": "List Collector",
  "22": "Lookup Multiple Choice",
  "23": "HTML",
  "24": "Container Split",
  "25": "Masked",
  "26": "Email",
  "27": "URL",
  "28": "IP Address",
  "29": "Duration",
  "31": "Requested For",
  "32": "Rich Text Label",
  "33": "Attachment",
};

/** Catalog client script / UI policy `ui_type` codes. */
const UI_TYPES: Record<string, string> = {
  "0": "desktop",
  "1": "mobile / service portal",
  "10": "all UIs",
};

/**
 * Rows of every read of one child table, first read first, without repeats
 * (an item reads `item_option_new` for itself and for its variable sets).
 */
function allRows(ctx: ExplainerContext, table: string): SnRecord[] {
  const seen = new Set<string>();
  const out: SnRecord[] = [];
  for (const c of ctx.children) {
    if (c.table !== table) continue;
    for (const r of c.records) {
      const id = snString(r.sys_id);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push(r);
    }
  }
  return out;
}

/** `unreadNote` for every read of a table, without repeats. */
function unreadNotes(ctx: ExplainerContext, table: string): string[] {
  const notes = new Set<string>();
  for (const c of ctx.children) {
    if (c.table !== table) continue;
    for (const n of unreadNote({ ...ctx, children: [c] }, table)) notes.add(n);
  }
  return [...notes];
}

/** Stable sort by a numeric `order` field; blank or non-numeric goes last. */
function byOrder<T extends { order: string }>(rows: T[]): T[] {
  const n = (x: T) => {
    const v = Number(x.order);
    return x.order !== "" && Number.isFinite(v) ? v : Infinity;
  };
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => n(a.r) - n(b.r) || a.i - b.i)
    .map(({ r }) => r);
}

interface CatalogChoice {
  value: string;
  text: string;
  order: string;
  inactive?: true;
}

interface CatalogVariable {
  sys_id: string;
  name: string;
  label: string;
  order: string;
  type: string;
  typeName: string;
  mandatory: boolean;
  inactive?: true;
  variableSet?: string;
  choices: CatalogChoice[];
}

/** The choices of each variable, keyed by the variable's sys_id, in order. */
function choicesByVariable(
  ctx: ExplainerContext,
): Map<string, CatalogChoice[]> {
  const out = new Map<string, CatalogChoice[]>();
  for (const r of allRows(ctx, "question_choice")) {
    const q = snString(r.question);
    const choice: CatalogChoice = {
      value: snString(r.value),
      text: snString(r.text),
      order: snString(r.order),
      ...(snString(r.inactive) === "true" ? { inactive: true as const } : {}),
    };
    out.set(q, [...(out.get(q) ?? []), choice]);
  }
  for (const [q, list] of out) out.set(q, byOrder(list));
  return out;
}

function toVariable(
  r: SnRecord,
  choices: Map<string, CatalogChoice[]>,
): CatalogVariable {
  const id = snString(r.sys_id);
  const type = snString(r.type);
  const set = snString(r.variable_set);
  return {
    sys_id: id,
    name: snString(r.name),
    label: pick(r, ["question_text", "label"]),
    order: snString(r.order),
    type,
    typeName: VARIABLE_TYPES[type] ?? (type ? `type ${type}` : "unknown"),
    mandatory: snString(r.mandatory) === "true",
    ...(snString(r.active) === "false" ? { inactive: true as const } : {}),
    ...(set ? { variableSet: set } : {}),
    choices: choices.get(id) ?? [],
  };
}

function variableLine(v: CatalogVariable): string {
  const flags = [
    v.typeName,
    ...(v.mandatory ? ["mandatory"] : []),
    ...(v.inactive ? ["inactive"] : []),
  ];
  const choices = v.choices.length
    ? `: ${v.choices
        .map(
          (c) =>
            `${c.value}=${JSON.stringify(c.text)}${c.inactive ? " (inactive)" : ""}`,
        )
        .join(", ")}`
    : "";
  return `${v.order || "-"} ${v.name || v.sys_id}${v.label ? ` ${JSON.stringify(v.label)}` : ""} [${flags.join(", ")}]${choices}`;
}

const explainCatalogForm: Explainer = (ctx) => {
  const { record, t } = ctx;
  const choices = choicesByVariable(ctx);
  const variables = byOrder(
    allRows(ctx, "item_option_new").map((r) => toVariable(r, choices)),
  );
  const names = new Map(variables.map((v) => [v.sys_id, v.name]));
  const varName = (ref: string) => {
    const id = variableRef(ref);
    return names.get(id) ?? id;
  };

  // Variable sets included by an item (none for a variable set itself).
  const titles = new Map(
    allRows(ctx, "item_option_new_set").map((r) => [
      snString(r.sys_id),
      pick(r, ["title", "name", "internal_name"]),
    ]),
  );
  const isSet = t.type === "variable_set";
  const variableSets = isSet
    ? []
    : byOrder(
        allRows(ctx, "io_set_item").map((r) => ({
          sys_id: snString(r.variable_set),
          order: snString(r.order),
        })),
      ).map((s) => ({
        ...s,
        title: titles.get(s.sys_id) ?? "",
        variables: variables
          .filter((v) => v.variableSet === s.sys_id)
          .map((v) => v.name),
      }));
  const setIds = new Set(variableSets.map((s) => s.sys_id));
  const own = isSet
    ? variables
    : variables.filter((v) => !v.variableSet || !setIds.has(v.variableSet));
  const setTitle = (id: string) => titles.get(id) || id;

  const clientScripts = allRows(ctx, "catalog_script_client").map((r) => {
    const variable = snString(r.cat_variable);
    const set = snString(r.variable_set);
    const ui = snString(r.ui_type);
    return {
      sys_id: snString(r.sys_id),
      name: snString(r.name),
      type: snString(r.type),
      ...(variable ? { variable: varName(variable) } : {}),
      ...(ui ? { uiType: UI_TYPES[ui] ?? ui } : {}),
      ...(set && !isSet ? { variableSet: set } : {}),
      ...(snString(r.active) === "false" ? { inactive: true as const } : {}),
    };
  });

  const actions = new Map<string, SnRecord[]>();
  for (const r of allRows(ctx, "catalog_ui_policy_action")) {
    const p = snString(r.ui_policy);
    actions.set(p, [...(actions.get(p) ?? []), r]);
  }
  const uiPolicies = byOrder(
    allRows(ctx, "catalog_ui_policy").map((r) => {
      const reverse = snString(r.reverse_if_false) === "true";
      const set = snString(r.variable_set);
      return {
        sys_id: snString(r.sys_id),
        name: pick(r, ["short_description", "name"]),
        order: snString(r.order),
        condition: snString(r.catalog_conditions) || null,
        reverseIfFalse: reverse,
        onLoad: snString(r.on_load) !== "false",
        ...(set && !isSet ? { variableSet: set } : {}),
        ...(snString(r.active) === "false" ? { inactive: true as const } : {}),
        effects: (actions.get(snString(r.sys_id)) ?? [])
          .map((a) => ({
            variable: varName(
              pick(a, ["catalog_variable", "variable_name", "variable"]),
            ),
            ...actionEffects(a, reverse),
          }))
          .filter((e) => e.whenTrue.length),
      };
    }),
  );

  const kind =
    t.type === "record_producer"
      ? "Record producer"
      : isSet
        ? "Variable set"
        : "Catalog item";
  const lines = [
    `${kind} '${snString(record[t.nameField])}': ${variables.length} variable(s)${
      isSet
        ? ""
        : ` (${own.length} own, ${variables.length - own.length} from ${variableSets.length} variable set(s))`
    }, ${clientScripts.length} catalog client script(s), ${uiPolicies.length} catalog UI policy(ies).`,
    ...own.map(variableLine),
    ...variableSets.flatMap((s) => [
      `Variable set '${s.title || s.sys_id}' (order ${s.order || "-"}): ${s.variables.length} variable(s).`,
      ...variables
        .filter((v) => v.variableSet === s.sys_id)
        .map((v) => `  ${variableLine(v)}`),
    ]),
    ...clientScripts.map(
      (c) =>
        `Client script '${c.name}': ${c.type || "(no type)"}${c.variable ? ` of ${c.variable}` : ""}${c.uiType ? ` (${c.uiType})` : ""}${c.variableSet ? ` from set '${setTitle(c.variableSet)}'` : ""}${c.inactive ? " (inactive)" : ""}.`,
    ),
    ...uiPolicies.flatMap((p) => {
      const on = (key: "whenTrue" | "whenFalse") =>
        p.effects
          .filter((e) => e[key]?.length)
          .map((e) => `${e.variable} ${e[key]!.join(", ")}`)
          .join("; ");
      const onFalse = on("whenFalse");
      return [
        `UI policy '${p.name}': ${p.condition ? `when ${p.condition}` : "always"}: ${on("whenTrue") || "no variable changes"}.${onFalse ? ` Otherwise: ${onFalse}.` : ""}${p.variableSet ? ` From set '${setTitle(p.variableSet)}'.` : ""}${p.inactive ? " (inactive)" : ""}`,
      ];
    }),
    ...[...new Set(t.children.map((c) => c.table))].flatMap((table) =>
      unreadNotes(ctx, table),
    ),
  ];
  return {
    kind: "catalog-form",
    variables: own,
    ...(isSet ? {} : { variableSets }),
    ...(isSet
      ? {}
      : {
          setVariables: variables.filter(
            (v) => v.variableSet && setIds.has(v.variableSet),
          ),
        }),
    clientScripts,
    uiPolicies,
    lines,
  };
};

const explainCatalogVariable: Explainer = (ctx) => {
  const v = toVariable(ctx.record, choicesByVariable(ctx));
  return {
    kind: "catalog-variable",
    variable: v,
    lines: [variableLine(v), ...unreadNotes(ctx, "question_choice")],
  };
};

const explainCatalogUiPolicy: Explainer = (ctx) =>
  fieldEffects(ctx, "catalog_ui_policy_action", "catalog_item", [
    ...(snString(ctx.record.on_load) === "false"
      ? ["Not applied on form load, only on variable change."]
      : []),
  ]);

// -- decision tables (P-11) -----------------------------------------------------

const DECISION_CAVEAT =
  "sys_decision, sys_decision_input and sys_decision_question and their fields (condition, answer, default_answer) are verified:false: unconfirmed on a live instance (gate O-5).";

const explainDecisionTable: Explainer = (ctx) => {
  const { record } = ctx;
  const inputs = byOrder(
    allRows(ctx, "sys_decision_input").map((r) => ({
      sys_id: snString(r.sys_id),
      element: pick(r, ["element", "name"]),
      label: pick(r, ["label", "element", "name"]),
      order: snString(r.order),
      ...(pick(r, ["internal_type", "type"])
        ? { type: pick(r, ["internal_type", "type"]) }
        : {}),
    })),
  );
  const rows = byOrder(
    allRows(ctx, "sys_decision_question").map((r) => {
      const condition = pick(r, [
        "condition",
        "conditions",
        "decision_condition",
      ]);
      const answer = pick(r, ["answer", "result", "answer_value"]);
      return {
        sys_id: snString(r.sys_id),
        order: snString(r.order),
        ...(pick(r, ["label", "name"])
          ? { label: pick(r, ["label", "name"]) }
          : {}),
        ...(condition ? { condition } : {}),
        ...(answer ? { answer } : {}),
        ...(snString(r.default_answer) === "true"
          ? { default: true as const }
          : {}),
        ...(snString(r.active) === "false" ? { inactive: true as const } : {}),
      };
    }),
  );
  const answerTable = pick(record, ["answer_table", "table"]);
  const capped = ["sys_decision_input", "sys_decision_question"].filter((t) =>
    ctx.children.some((c) => c.table === t && c.truncated),
  );
  const lines = [
    `Decision table '${snString(record[ctx.t.nameField])}'${answerTable ? ` answering from ${answerTable}` : ""}: ${inputs.length} input(s), ${rows.length} row(s).`,
    ...(inputs.length
      ? [
          `Inputs: ${inputs.map((i) => `${i.label}${i.element && i.element !== i.label ? ` (${i.element})` : ""}${i.type ? ` [${i.type}]` : ""}`).join(", ")}.`,
        ]
      : []),
    ...rows.map(
      (r, i) =>
        `${i + 1}. ${r.label ?? "(unlabelled)"}: when ${r.condition ?? "(always)"} -> ${r.answer ?? "(no answer)"}${r.default ? " [default]" : ""}${r.inactive ? " [inactive]" : ""}`,
    ),
    ...capped.map((t) => `${t} was capped; some rows are not shown.`),
    ...unreadNotes(ctx, "sys_decision_input"),
    ...unreadNotes(ctx, "sys_decision_question"),
    DECISION_CAVEAT,
  ];
  return {
    kind: "decision-table",
    ...(answerTable ? { answerTable } : {}),
    inputs,
    rows,
    verified: false,
    lines,
  };
};

registerExplainer("state_model", explainStateModel);
registerExplainer("choice_set", explainChoices);
registerExplainer("table", explainChoices);
registerExplainer("ui_policy", explainUiPolicy);
registerExplainer("data_policy", explainDataPolicy);
registerExplainer("catalog_item", explainCatalogForm);
registerExplainer("record_producer", explainCatalogForm);
registerExplainer("variable_set", explainCatalogForm);
registerExplainer("catalog_variable", explainCatalogVariable);
registerExplainer("catalog_ui_policy", explainCatalogUiPolicy);
registerExplainer("decision_table", explainDecisionTable);
