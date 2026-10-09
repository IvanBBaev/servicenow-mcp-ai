/**
 * P-27 flow emitter base: the hooks contract, the verified note and
 * `FlowEmit` — per-file state, value and property building, columns,
 * stages, `Record()` fallbacks, leftovers and the file writer.
 */
import type { ArtifactType } from "../core/artifacts/registry.js";
import {
  type DecodedValues,
  type ExplainFlowKind,
  type ExplainFlowResult,
  type FlowStep,
  type FlowVariable,
  type Stage,
  type StepInput,
} from "./explain-flow.js";
import type { FluentSource, FluentUnsupported } from "./fluent-emit.js";
import {
  arr,
  code,
  call,
  lit,
  obj,
  oneLine,
  tsString,
  type Expr,
  type Prop,
} from "./fluent-render.js";
import { snString } from "./shared.js";
import type { SnRecord } from "./table.js";
import {
  PILL_TYPES,
  VARIABLE_PILL_TYPES,
  COLUMNS,
  ROOT_CONSUMED,
  STEP_REF_FIELD,
  pad,
  pillPath,
  templateText,
  asText,
  PILL_RE,
  durationExpr,
  typedDefault,
  isWholePill,
} from "./fluent-flow-maps.js";

export const FLOW_TREE_KINDS: Readonly<Record<string, ExplainFlowKind>> = {
  flow: "flow",
  subflow: "subflow",
  flow_action: "action",
  playbook: "playbook",
};

/** The warning every P-27 run carries. */
export const FLOW_VERIFIED_NOTE =
  "The Flow / Subflow / Action / PlaybookDefinition shapes are type-checked against @servicenow/sdk 4.12.2 (npm run fluent:verify); instance behaviour (P-29 / O-5) is not verified: review before deploying.";

/**
 * What the flow emitter needs from the P-26 core (`fluent.ts`): passed in so
 * this file imports only types from it.
 */
export interface FlowEmitHooks {
  /** A unique `Now.ID` key, registered in the run's keys fragment. */
  key(base: string, sysId: string, table: string): string;
  /** Point a registered key at another table (the one the SDK writes). */
  retable(key: string, table: string): void;
  unsupported(entry: FluentUnsupported): void;
  /** Is this field / value a secret (descriptor, name pattern, redaction rules)? */
  isSecret(field: string, value: string): boolean;
  /** The placeholder property for a secret (counts it). */
  secretProp(key: string): Prop;
  /** Set, non-system fields of `rec` outside `consumed` (and the scope field), sorted. */
  unmapped(rec: SnRecord, consumed: readonly string[]): string[];
  /** A raw child row as `Record()`, through the P-26 child path. */
  childRecord(table: string, row: SnRecord, key: string): string;
  /** `Record({ $id, table, data })`. */
  recordCall(key: string, table: string, data: Prop[]): string;
  /** The provenance header of a generated file. */
  header(lines: string[]): string;
  file(path: string, content: string): void;
}

/** Mutable state of one flow / playbook file. */
export class FlowEmit {
  /** `@servicenow/sdk/automation` imports. */
  readonly automation = new Set<string>();
  /** `@servicenow/sdk/core` imports. */
  readonly core = new Set<string>();
  readonly notes: string[] = [];
  /** `Record()` fallbacks, emitted after the main call. */
  readonly fallbacks: string[] = [];
  /** Raw child rows by sys_id, and the ones the tree represented. */
  readonly rows = new Map<string, { table: string; row: SnRecord }>();
  readonly seen = new Set<string>();
  /** Open If / For Each / Do the following / Do in parallel blocks: the SDK accepts endFlow only inside one. */
  protected endFlowScopes = 0;
  /** The table of each node key, for the `unsupported[]` entries of its values. */
  private readonly keyTables = new Map<string, string>();
  readonly rootId: string;

  constructor(
    readonly h: FlowEmitHooks,
    readonly t: ArtifactType,
    readonly src: FluentSource,
    readonly key: string,
    readonly tree: ExplainFlowResult,
  ) {
    this.rootId = snString(src.record!.sys_id);
    for (const child of src.children ?? []) {
      if (child.redacted || child.error !== undefined || child.reason) {
        h.unsupported({
          kind: "child",
          table: child.table,
          key,
          sys_id: this.rootId,
          reason: `Child table not emitted: ${child.reason ?? child.error ?? "redacted"}`,
        });
        continue;
      }
      if (child.truncated) {
        h.unsupported({
          kind: "child",
          table: child.table,
          key,
          sys_id: this.rootId,
          reason: `Only the first ${child.count} child rows were read and emitted.`,
        });
      }
      for (const row of child.records) {
        const id = snString(row.sys_id);
        if (id && !this.rows.has(id)) {
          this.rows.set(id, { table: child.table, row });
        }
      }
    }
  }

  /** A node key under this file's key. */
  nodeKey(kind: string, sysId: string, table: string): string {
    const k = this.h.key(
      `${this.key}__${kind}_${
        sysId
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .slice(0, 8) || "node"
      }`,
      sysId,
      table,
    );
    this.keyTables.set(k, table);
    return k;
  }

  idProp(k: string): Prop {
    return { key: "$id", value: code(`Now.ID[${tsString(k)}]`) };
  }

  /** A field value as an expression: data pills become `wfa.dataPill(…)`. */
  value(v: unknown, field: string, nodeKey: string, sysId: string): Expr {
    if (typeof v === "string") return this.stringValue(v, nodeKey, sysId);
    if (typeof v === "number" || typeof v === "boolean") return lit(v);
    if (v === null || v === undefined) return code("null");
    if (Array.isArray(v)) {
      return arr(v.map((x) => this.value(x, field, nodeKey, sysId)));
    }
    if (typeof v === "object") {
      return obj(
        Object.entries(v as Record<string, unknown>).map(([k, x]) =>
          this.prop(k, x, nodeKey, sysId),
        ),
      );
    }
    return code("null");
  }

  /** One input property, with the secret check. */
  prop(name: string, v: unknown, nodeKey: string, sysId: string): Prop {
    if (this.h.isSecret(name, asText(v))) return this.h.secretProp(name);
    return { key: name, value: this.value(v, name, nodeKey, sysId) };
  }

  /** The `wfa.dataPill()` type of a pill path: a known variable / input's, else `fallback`. */
  pillType(path: string, fallback: string): string {
    const m = /^params\.(flowVariables|inputs)\.([A-Za-z_$][\w$]*)$/.exec(path);
    if (!m) return fallback;
    const list =
      m[1] === "flowVariables" ? this.tree.variables : this.tree.inputs;
    const v = list?.find((x) => x.element === m[2]);
    return (v?.type && VARIABLE_PILL_TYPES[v.type]) || fallback;
  }

  /**
   * A string with data pills: a whole pill is `wfa.dataPill(path, type)`,
   * embedded pills become a template literal.
   */
  stringValue(
    s: string,
    nodeKey: string,
    sysId: string,
    type = "string",
  ): Expr {
    const pills = [...s.matchAll(PILL_RE)];
    if (!pills.length) return lit(s);
    const whole = pills.length === 1 && pills[0]?.[0] === s;
    let out = "";
    let last = 0;
    for (const m of pills) {
      const inner = m[1] ?? "";
      const path = pillPath(inner);
      out += templateText(s.slice(last, m.index));
      if (path) {
        this.automation.add("wfa");
        const pill = `wfa.dataPill(${path}, ${tsString(this.pillType(path, whole ? type : "string"))})`;
        if (whole) return code(pill);
        out += `\${${pill}}`;
      } else {
        this.h.unsupported({
          kind: "field",
          table: this.keyTables.get(nodeKey) ?? this.t.table,
          key: nodeKey,
          sys_id: sysId,
          reason: `Data pill {{${inner}}} has no known wfa.dataPill() root; kept as its {{…}} text.`,
        });
        out += templateText(m[0]);
      }
      last = m.index + m[0].length;
    }
    out += templateText(s.slice(last));
    return code(`\`${out}\``);
  }

  /** The raw `[name, value]` inputs of decoded step values; undefined = not decodable. */
  rawInputs(
    values: DecodedValues | undefined,
  ): Array<[string, unknown]> | undefined {
    if (!values || values.format === "empty") return [];
    if (!values.decoded || values.inputsOmitted) return undefined;
    if (values.inputs) {
      return values.inputs.map((i: StepInput) => [i.name, i.value ?? ""]);
    }
    const v = values.value;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.entries(v as Record<string, unknown>);
    }
    if (v === undefined || v === null || v === "") return [];
    return [["values", v]];
  }

  /** The input properties of decoded step values; undefined = not decodable. */
  inputs(
    values: DecodedValues | undefined,
    nodeKey: string,
    sysId: string,
  ): Prop[] | undefined {
    return this.rawInputs(values)?.map(([k, v]) =>
      this.prop(k, v, nodeKey, sysId),
    );
  }

  /** A typed action input, coerced to its SDK column kind. */
  typedProp(
    name: string,
    kind: string,
    v: unknown,
    nodeKey: string,
    sysId: string,
  ): Prop {
    if (this.h.isSecret(name, asText(v))) return this.h.secretProp(name);
    if (typeof v !== "string") {
      return { key: name, value: this.value(v, name, nodeKey, sysId) };
    }
    const t = v.trim();
    let value: Expr;
    if (kind === "Boolean" && (t === "true" || t === "false")) {
      value = lit(t === "true");
    } else if (kind === "Integer" && /^-?\d+$/.test(t)) {
      value = lit(Number(t));
    } else if (kind === "TemplateValue" && !isWholePill(v)) {
      value = this.templateValue(v, nodeKey, sysId) ?? lit(v);
    } else {
      value = this.stringValue(v, nodeKey, sysId, PILL_TYPES[kind] ?? "string");
    }
    return { key: name, value };
  }

  /** `a=b^c=d` as `TemplateValue({ a: …, c: … })`; undefined when not of that form. */
  templateValue(s: string, nodeKey: string, sysId: string): Expr | undefined {
    const props: Prop[] = [];
    for (const part of s.split("^")) {
      if (part === "" || part === "EQ") continue;
      const eq = part.indexOf("=");
      if (eq <= 0) return undefined;
      const field = part.slice(0, eq);
      if (!/^[a-z_][a-z0-9_]*$/i.test(field)) return undefined;
      props.push(this.prop(field, part.slice(eq + 1), nodeKey, sysId));
    }
    if (!props.length) return undefined;
    return call("TemplateValue", obj(props));
  }

  // --- fallbacks ---------------------------------------------------------------

  /** A tree node as `Record()`: its raw row when read, else synthesised from the tree. */
  fallbackRow(
    table: string,
    sysId: string,
    nodeKey: string,
    synth: () => Prop[],
    label: string,
  ): void {
    this.seen.add(sysId);
    this.core.add("Record");
    const raw = this.rows.get(sysId);
    const call = raw
      ? this.h.childRecord(raw.table, raw.row, nodeKey)
      : this.h.recordCall(nodeKey, table, synth());
    this.fallbacks.push(
      `// unsupported in ${this.key}: ${oneLine(label)}\n${call}`,
    );
  }

  /** A step and its whole subtree as `Record()` rows, with `unsupported[]` entries. */
  fallbackStep(
    s: FlowStep,
    reason: string,
    lines: string[],
    depth: number,
    k?: string,
  ): void {
    const top = k ?? this.nodeKey(s.kind, s.sys_id, s.source);
    lines.push(
      `${pad(depth)}// step ${s.number} '${oneLine(s.name)}': emitted as Record() below (${oneLine(reason)})`,
    );
    const walk = (n: FlowStep, nk: string, why: string) => {
      this.h.unsupported({
        kind: "api",
        table: n.source,
        key: nk,
        sys_id: n.sys_id,
        reason: why,
      });
      this.fallbackRow(
        n.source,
        n.sys_id,
        nk,
        () => this.synthStep(n, nk),
        `step ${n.number} '${n.name}': ${why}`,
      );
      for (const c of n.children) {
        walk(
          c,
          this.nodeKey(c.kind, c.sys_id, c.source),
          `Inside unsupported step ${s.number}; emitted as Record().`,
        );
      }
    };
    walk(s, top, reason);
  }

  /** `Record()` data for a step the raw rows do not hold. */
  synthStep(s: FlowStep, nk: string): Prop[] {
    const parentField = s.kind === "step" ? "action" : "flow";
    const data: Prop[] = [
      {
        key: parentField,
        value: code(
          `Now.ref(${tsString(this.t.table)}, ${tsString(this.rootId.toLowerCase())})`,
        ),
      },
      { key: "order", value: lit(String(s.order)) },
    ];
    if (s.ui_id) data.push({ key: "ui_id", value: lit(s.ui_id) });
    if (s.parent_ui_id) {
      data.push({ key: "parent_ui_id", value: lit(s.parent_ui_id) });
    }
    if (s.ref)
      data.push({ key: STEP_REF_FIELD[s.kind], value: lit(s.ref.sys_id) });
    if (s.comment) data.push({ key: "comment", value: lit(s.comment) });
    const v = s.values;
    if (v && v.format !== "empty") {
      let text: string;
      if (v.raw !== undefined) text = v.raw;
      else if (v.inputs) {
        text = JSON.stringify(
          v.inputs.map((i) => ({
            name: i.name,
            value: this.h.isSecret(i.name, asText(i.value))
              ? this.secretText(i.name)
              : i.value,
          })),
        );
      } else text = JSON.stringify(v.value ?? null);
      data.push({ key: "values", value: lit(text) });
    }
    void nk;
    return data.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  secretText(name: string): string {
    const p = this.h.secretProp(name);
    return p.value.k === "lit" ? String(p.value.v) : "";
  }

  /** `Record()` data from a flat tree object (variables, stages, triggers, variants). */
  synthFlat(
    parentField: string,
    fields: Record<string, unknown>,
    skip: readonly string[] = ["sys_id"],
    parent: readonly [table: string, sysId: string] = [
      this.t.table,
      this.rootId,
    ],
  ): Prop[] {
    const data: Prop[] = [
      {
        key: parentField,
        value: code(
          `Now.ref(${tsString(parent[0])}, ${tsString(parent[1].toLowerCase())})`,
        ),
      },
    ];
    for (const [k, v] of Object.entries(fields)) {
      if (skip.includes(k) || v === undefined || v === "") continue;
      const text = typeof v === "string" ? v : JSON.stringify(v);
      data.push(
        this.h.isSecret(k, text)
          ? this.h.secretProp(k)
          : {
              key: k,
              value: lit(
                typeof v === "object" ? text : (v as string | number | boolean),
              ),
            },
      );
    }
    return data.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  // --- variables, stages -----------------------------------------------------------

  /**
   * `{ name: XColumn({…}) }` for inputs / outputs / variables; unknown types
   * fall back.
   */
  columns(
    list: FlowVariable[] | undefined,
    table: string,
    what: string,
  ): Expr | undefined {
    if (!list?.length) return undefined;
    const props: Prop[] = [];
    for (const v of list) {
      this.seen.add(v.sys_id);
      const col = v.type ? COLUMNS[v.type] : undefined;
      const k = this.nodeKey(what, v.sys_id, table);
      if (!col) {
        const reason = `${what} '${v.element}': ${v.type ? `type '${v.type}' has no column constructor mapped` : "no type"}; emitted as Record().`;
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
        continue;
      }
      const refTable =
        col === "ReferenceColumn"
          ? v.reference || asText(this.rows.get(v.sys_id)?.row.reference)
          : "";
      if (col === "ReferenceColumn" && !refTable) {
        const reason = `${what} '${v.element}': reference column without a reference table; emitted as Record().`;
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
        continue;
      }
      this.core.add(col);
      const args: Prop[] = [];
      if (refTable) {
        args.push({ key: "referenceTable", value: lit(refTable) });
      }
      if (v.label) args.push({ key: "label", value: lit(v.label) });
      if (v.mandatory !== undefined) {
        args.push({ key: "mandatory", value: lit(v.mandatory) });
      }
      if (v.default !== undefined && v.default !== "") {
        args.push(
          this.h.isSecret(v.element, v.default)
            ? this.h.secretProp("default")
            : { key: "default", value: lit(typedDefault(col, v.default)) },
        );
      }
      props.push({
        key: v.element,
        value: call(col, obj(args)),
      });
    }
    return props.length ? obj(props) : undefined;
  }

  /** `{ key: FlowStage({…}) }` for the flow's stages. */
  stages(list: Stage[] | undefined): Expr | undefined {
    if (!list?.length) return undefined;
    this.automation.add("FlowStage");
    return obj(
      list.map((s) => {
        this.seen.add(s.sys_id);
        this.nodeKey("stage", s.sys_id, "sys_hub_flow_stage");
        const value = s.value || s.label;
        const d = s.duration ? durationExpr(s.duration) : undefined;
        if (s.duration && !d) {
          this.h.unsupported({
            kind: "field",
            table: "sys_hub_flow_stage",
            sys_id: s.sys_id,
            field: "duration",
            reason: `Stage '${s.label}': duration '${s.duration}' is not an explicit duration; not emitted.`,
          });
        }
        return {
          key: value,
          value: call(
            "FlowStage",
            obj([
              { key: "label", value: lit(s.label) },
              { key: "value", value: lit(value) },
              ...(d ? [{ key: "duration", value: d }] : []),
            ]),
          ),
        };
      }),
    );
  }

  /** Raw child rows the tree did not represent: `Record()` rows, reported. */
  leftovers(): void {
    const rest = [...this.rows.entries()]
      .filter(([id]) => !this.seen.has(id))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [id, { table, row }] of rest) {
      const k = this.nodeKey("row", id, table);
      const reason =
        "Row not represented in the explain_flow tree; emitted as Record().";
      this.h.unsupported({ kind: "child", table, key: k, sys_id: id, reason });
      this.seen.add(id);
      this.core.add("Record");
      this.fallbacks.push(
        `// child of ${this.key}: ${table} (${reason})\n${this.h.childRecord(table, row, k)}`,
      );
    }
  }

  /** Root fields the emitter does not represent. */
  rootFields(kind: ExplainFlowKind): void {
    const unmapped = this.h.unmapped(this.src.record!, ROOT_CONSUMED[kind]);
    for (const field of unmapped) {
      this.h.unsupported({
        kind: "field",
        table: this.t.table,
        key: this.key,
        sys_id: this.rootId,
        field,
        reason: `No ${this.t.sdkApi} property is mapped for ${field}; not emitted.`,
      });
    }
    if (unmapped.length) {
      this.notes.push(
        `Not emitted (no ${this.t.sdkApi} property mapped): ${unmapped.join(", ")}.`,
      );
    }
  }

  file(main: string, kind: ExplainFlowKind): void {
    const name = this.tree.name ?? this.src.name ?? "";
    const scope = this.src.scope?.scope ?? this.src.scope?.sys_id ?? "unknown";
    const imports = [
      "import '@servicenow/sdk/global'",
      `import { ${[...this.automation].sort().join(", ")} } from '@servicenow/sdk/automation'`,
    ];
    if (this.core.size) {
      imports.push(
        `import { ${[...this.core].sort().join(", ")} } from '@servicenow/sdk/core'`,
      );
    }
    const lines = [
      this.h.header([
        `Source: ${this.t.table} ${this.rootId} '${name}' (scope ${scope}), from the explain_flow ${kind} tree.`,
        FLOW_VERIFIED_NOTE,
      ]),
      "",
      ...imports,
      "",
      ...(this.notes.length
        ? [...this.notes.map((n) => `// ${oneLine(n)}`), ""]
        : []),
      [main, ...this.fallbacks].join("\n\n"),
      "",
    ];
    this.h.file(`${this.key}.now.ts`, lines.join("\n"));
  }
}
