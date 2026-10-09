/**
 * The emission primitives shared by the Fluent emitters (P-26 core in
 * `fluent.ts`, P-28 UI emitters in `fluent-ui.ts`): run state, secret
 * detection, sidecars, `Now.ref` / `Record()` building and file headers. Kept
 * apart so that neither emitter module imports the other at runtime.
 */
import { REDACTED, type RedactionRules } from "../core/redaction.js";
import {
  SDK_BASELINE,
  type ArtifactChild,
  type ArtifactType,
} from "../core/artifacts/registry.js";
import type { ArtifactChildResult } from "./artifacts.js";
import type { ExplainFlowResult } from "./explain-flow.js";
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
import { SDK_NUMERIC_COLUMNS } from "./fluent-sdk-actions.js";
import { snString } from "./shared.js";
import type { SnRecord } from "./table.js";
import { isSysIdAnyCase } from "../core/sys-id.js";

/** The value a secret is replaced with. */
export const SECRET_PLACEHOLDER = "<redacted:credential>";

const SECRET_COMMENT = "TODO: credential";

/** Record fields that never go into generated source. */
const SYSTEM_FIELDS = new Set([
  "sys_id",
  "sys_created_on",
  "sys_created_by",
  "sys_updated_on",
  "sys_updated_by",
  "sys_mod_count",
  "sys_class_name",
  "sys_domain",
  "sys_domain_path",
  "sys_package",
  "sys_scope",
  "sys_policy",
  "sys_update_name",
  "sys_name",
  "sys_customer_update",
  "sys_replace_on_upgrade",
  "sys_tags",
]);

/** Field names that hold a credential, whatever the descriptor says. */
const CREDENTIAL_NAME =
  /(^|_)(password\d*|passwd|pwd|secret|token|api_?key|private_?key|client_secret|credentials?|passphrase)(_|$)/i;

/** Code-point order: the same on every machine and locale. */
export const cmp = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

export type Conv =
  | "string"
  | "boolean"
  | "number"
  | "script"
  | "list"
  | { map: Record<string, string> };

/** One generated file: a path relative to the output directory and its text. */
export interface FluentFile {
  path: string;
  content: string;
}

export interface FluentKey {
  key: string;
  table: string;
  sys_id: string;
}

export interface FluentUnsupported {
  kind: "api" | "field" | "child" | "unavailable";
  table: string;
  key?: string;
  sys_id?: string;
  field?: string;
  reason: string;
}

export interface FluentBundle {
  files: FluentFile[];
  keys: FluentKey[];
  unsupported: FluentUnsupported[];
  /** Values replaced by the credential placeholder. */
  secretsReplaced: number;
}

/** The part of a `getArtifactFor` result the emitter reads. */
export interface FluentSource {
  sys_id?: string;
  name?: string;
  scope?: { sys_id: string | null; scope: string | null };
  record: SnRecord | null;
  children?: ArtifactChildResult[];
  degraded?: { status: number; reason: string };
  // --- P-27 hook: the explain_flow tree of a flow-group artefact ---
  flowTree?: ExplainFlowResult;
  // --- end P-27 hook ---
}

/** A lower-case identifier-safe slug, at most 60 characters. */
export function fluentSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60)
    .replace(/_+$/, "");
}

/** Mutable state of one emission run. */
export class EmitRun {
  readonly files: FluentFile[] = [];
  keys: FluentKey[] = [];
  readonly unsupported: FluentUnsupported[] = [];
  secrets = 0;
  private readonly used = new Set<string>();

  constructor(readonly rules: RedactionRules | null) {}

  /** A unique `Now.ID` key: the base, else the base plus more of the sys_id. */
  key(base: string, sysId: string, table: string): string {
    const id = sysId.toLowerCase();
    let k = base;
    if (this.used.has(k) && id) k = `${base}_${id.slice(0, 8)}`;
    if (this.used.has(k) && id) k = `${base}_${id}`;
    for (let n = 2; this.used.has(k); n++) k = `${base}_${n}`;
    this.used.add(k);
    this.keys.push({ key: k, table, sys_id: sysId });
    return k;
  }

  /** Point a registered key at another table. */
  retable(key: string, table: string): void {
    const entry = this.keys.find((k) => k.key === key);
    if (entry) entry.table = table;
  }
}

/** Is `field` a secret on this row? */
export function isSecret(
  field: string,
  value: string,
  secretFields: readonly string[],
  extra: readonly string[],
  rules: RedactionRules | null,
): boolean {
  return (
    secretFields.includes(field) ||
    extra.includes(field) ||
    CREDENTIAL_NAME.test(field) ||
    value === REDACTED ||
    (rules?.fields.has(field) ?? false)
  );
}

/** The sidecar file suffix of a script / markup field. */
export function sidecarSuffix(
  field: string,
  t: Pick<ArtifactType, "clientFields" | "markupFields">,
): string {
  if (t.markupFields?.includes(field)) {
    return /css/i.test(field) ? "css" : "html";
  }
  return t.clientFields?.includes(field) ? "client.js" : "server.js";
}

/** Write a sidecar file and return its `Now.include` expression. */
export function sidecar(
  run: EmitRun,
  key: string,
  field: string,
  body: string,
  suffix: string,
): Expr {
  const file = `${key}.${fluentSlug(field) || "field"}.${suffix}`;
  run.files.push({ path: file, content: body });
  return code(`Now.include(${tsString(`./${file}`)})`);
}

/** A reference value: `Now.ref` for a sys_id, the plain value otherwise. */
export function refExpr(table: string, value: string): Expr {
  return isSysIdAnyCase(value)
    ? code(`Now.ref(${tsString(table)}, ${tsString(value.toLowerCase())})`)
    : lit(value);
}

/** Convert one field value for a dedicated property; undefined = not emitted. */
export function convert(
  value: string,
  as: Conv | undefined,
): { expr?: Expr; problem?: string } {
  if (value === "") return {};
  if (as === undefined || as === "string") return { expr: lit(value) };
  if (as === "boolean") {
    if (value === "true" || value === "1") return { expr: lit(true) };
    if (value === "false" || value === "0") return { expr: lit(false) };
    return { problem: `value '${value}' is not a boolean` };
  }
  if (as === "number") {
    const n = Number(value);
    return /^-?\d+(\.\d+)?$/.test(value.trim()) && Number.isFinite(n)
      ? { expr: lit(n) }
      : { problem: `value '${value}' is not a number` };
  }
  if (as === "list") {
    const items = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { expr: arr(items.map((s) => lit(s))) };
  }
  if (as === "script") return { expr: lit(value) };
  const mapped = as.map[value];
  return mapped !== undefined
    ? { expr: lit(mapped) }
    : { problem: `value '${value}' has no Fluent equivalent` };
}

/** The placeholder property for a secret value. */
export function secretProp(run: EmitRun, key: string): Prop {
  run.secrets++;
  return { key, value: lit(SECRET_PLACEHOLDER), comment: SECRET_COMMENT };
}

/** Non-system field names of a row with a non-empty value, sorted. */
export function setFields(row: SnRecord, skip: ReadonlySet<string>): string[] {
  return Object.keys(row)
    .filter(
      (f) => !SYSTEM_FIELDS.has(f) && !skip.has(f) && snString(row[f]) !== "",
    )
    .sort();
}

/** `Record()` data for a row: every set field, sorted, with refs / sidecars / secrets. */
export function recordData(
  run: EmitRun,
  row: SnRecord,
  key: string,
  shape: {
    table: string;
    secretFields: readonly string[];
    scriptFields: readonly string[];
    refFields: readonly { field: string; table: string }[];
    clientFields?: string[];
    markupFields?: string[];
    skip: ReadonlySet<string>;
    parent?: { field: string; table: string; byValue: boolean };
  },
): Prop[] {
  const data: Prop[] = [];
  for (const field of setFields(row, shape.skip)) {
    const value = snString(row[field]);
    if (isSecret(field, value, shape.secretFields, [], run.rules)) {
      data.push(secretProp(run, field));
      continue;
    }
    if (shape.parent?.field === field) {
      data.push({
        key: field,
        value: shape.parent.byValue
          ? lit(value)
          : refExpr(shape.parent.table, value),
      });
      continue;
    }
    if (shape.scriptFields.includes(field)) {
      data.push({
        key: field,
        value: sidecar(run, key, field, value, sidecarSuffix(field, shape)),
      });
      continue;
    }
    const ref = shape.refFields.find((r) => r.field === field);
    data.push({
      key: field,
      value: ref
        ? refExpr(ref.table, value)
        : recordValue(value, shape.table, field),
    });
  }
  return data;
}

/**
 * A `Record()` data value. The SDK types `data` by the table schema, where a
 * boolean column takes a boolean and an integer / decimal column a number
 * (P-29 oracle), so `'true'` / `'false'` become boolean literals and a numeric
 * value of a numeric column (`SDK_NUMERIC_COLUMNS`) a number; every other
 * value stays the instance's string.
 */
export function recordValue(
  value: string,
  table?: string,
  field?: string,
): Expr {
  if (value === "true") return lit(true);
  if (value === "false") return lit(false);
  if (
    table !== undefined &&
    field !== undefined &&
    SDK_NUMERIC_COLUMNS[table]?.includes(field) &&
    /^-?\d+(\.\d+)?$/.test(value)
  ) {
    return lit(Number(value));
  }
  return lit(value);
}

/** `Record({ $id, table, data })`. */
export function recordCall(key: string, table: string, data: Prop[]): string {
  return `Record(${render(
    obj([
      { key: "$id", value: code(`Now.ID[${tsString(key)}]`) },
      { key: "table", value: lit(table) },
      { key: "data", value: obj(data) },
    ]),
  )})`;
}

/** The provenance header of a generated `.ts` file. */
export function header(lines: string[]): string {
  return [
    "// Generated by servicenow-mcp (servicenow_generate_fluent). Regenerate instead of editing;",
    "// a hand-edited file is not overwritten without overwrite: true.",
    `// Target: @servicenow/sdk ${SDK_BASELINE} (registry SDK baseline; checked by npm run fluent:verify).`,
    ...lines.map((l) => `// ${oneLine(l)}`),
  ].join("\n");
}

/** Sort key of a child row: numeric order field, then sys_id. */
export function childOrder(
  c: ArtifactChild,
): (a: SnRecord, b: SnRecord) => number {
  return (a, b) => {
    if (c.orderField) {
      const x = Number(snString(a[c.orderField])) || 0;
      const y = Number(snString(b[c.orderField])) || 0;
      if (x !== y) return x - y;
    }
    return cmp(snString(a.sys_id), snString(b.sys_id));
  };
}
