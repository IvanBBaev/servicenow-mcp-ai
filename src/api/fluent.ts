/**
 * P-26 — Fluent emitter core (project/SDK-PARITY.md §5, P5).
 *
 * `emitFluent` turns artefacts read through the registry (`getArtifactFor`)
 * into ServiceNow SDK Fluent source: one `<key>.now.ts` per artefact with
 * `Now.ID['<key>']` ids, `Now.include('./…')` sidecar files for script / HTML
 * / CSS bodies, `Now.ref(table, sys_id)` for references and a `keys.ts`
 * fragment for the SDK key registry. The scalar core / server / classic-UI
 * types get their dedicated API call (`BusinessRule({…})`, `Acl({…})`, …);
 * flow-group types go through the P-27 flow emitters (`fluent-flow.ts`) and
 * portal / workspace / catalog types through the P-28 emitters
 * (`fluent-ui.ts`); every other type — `Record` / `none` types, UIB, and a
 * flow without a usable explain_flow tree — gets the generic
 * `Record({ table, data })` form plus an explicit `unsupported[]` entry, never
 * silent loss. Child records are always emitted as `Record()` rows.
 *
 * The target is the registry's SDK baseline (`SDK_BASELINE`, 4.12.2), which
 * is also the exact `@servicenow/sdk` dev dependency (owner gate O-7,
 * resolved 2026-10-01). The P-29 round-trip oracle (`npm run fluent:verify`,
 * test/fluent-sdk-oracle.test.js) type-checks every golden against the SDK
 * types and builds it with `now-sdk build`; the SDK is never a runtime
 * dependency.
 *
 * Output is deterministic: artefacts sorted by sys_id, child rows by order
 * then sys_id, `Record()` data by field name, dedicated properties in a fixed
 * order; no timestamps in the generated source. Secrets (descriptor
 * `secretFields`, credential-like field names, `SN_REDACT_FIELDS`, values the
 * read already masked, password-typed properties) become a placeholder with a
 * `// TODO: credential` comment; `SN_REDACT_PII` applies to every value.
 *
 * `generateFluent` reads the instance (GETs only), emits, and returns the
 * files inline or writes them under `<SN_DOCS_DIR>/<profile>/fluent/<scope>/`
 * with a `<base>.fluent.json` companion (S-14 kind `fluent`) that records each
 * file's hash, so a hand-edited file is never overwritten silently.
 */
import { ServiceNowError } from "../core/errors.js";
import { activeProfile } from "../core/config.js";
import {
  REDACTED,
  redactValue,
  redactionRules,
  type RedactionRules,
} from "../core/redaction.js";
import { sha256Hex } from "../core/write-journal.js";
import {
  SDK_BASELINE,
  type ArtifactChild,
  type ArtifactType,
} from "../core/artifacts/registry.js";
import {
  getArtifactFor,
  listArtifacts,
  resolveArtifactType,
  type ArtifactChildResult,
  type ArtifactRef,
} from "./artifacts.js";
import { docsReadRaw, docsWriteRaw } from "./docs.js";
import { SDK_NUMERIC_COLUMNS } from "./fluent-sdk-actions.js";
import { snString } from "./shared.js";
import type { SnRecord } from "./table.js";
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
// --- P-27 hook: flow / subflow / action / playbook emitters (fluent-flow.ts) ---
import type { ExplainFlowResult } from "./explain-flow.js";
import {
  attachFlowTrees,
  emitFlowFile,
  FLOW_TREE_KINDS,
  type FlowEmitHooks,
} from "./fluent-flow.js";
// --- end P-27 hook ---
// --- P-28: portal / workspace / catalog emitters (src/api/fluent-ui.ts) ---
import {
  UI_EMITTERS,
  UI_VERIFIED_NOTE,
  emitUi,
  uiFallbackReason,
} from "./fluent-ui.js";
// --- end P-28 ---

/** Default and maximum artefacts per `scope` run. */
export const FLUENT_LIMIT = { default: 25, max: 200 } as const;

/** The value a secret is replaced with. */
export const SECRET_PLACEHOLDER = "<redacted:credential>";

const SECRET_COMMENT = "TODO: credential";

/** What the generated source targets, and how sure that is. */
export const FLUENT_TARGET = {
  package: "@servicenow/sdk",
  version: SDK_BASELINE,
  assumption: false,
  typeChecked: true,
  note: `Targets @servicenow/sdk ${SDK_BASELINE} (the registry SDK baseline and the exact dev dependency). The emitters are type-checked and built against it by the P-29 round-trip oracle (npm run fluent:verify).`,
} as const;

/** File extensions the emitter writes into the docs store. */
export const FLUENT_EXTENSIONS = [".ts", ".js", ".html", ".css", ".json"];

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

const SYS_ID = /^[0-9a-f]{32}$/i;

/** Code-point order: the same on every machine and locale. */
export const cmp = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** One safe directory segment for a scope name (same rule as the file-result exports). */
function safeSegment(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 80)
    .replace(/[._]+$/, "");
  return cleaned || "export";
}

// ---------------------------------------------------------------------------
// Dedicated emitters
// ---------------------------------------------------------------------------

export type Conv =
  | "string"
  | "boolean"
  | "number"
  | "script"
  | "list"
  | { map: Record<string, string> };

/** One property of a dedicated Fluent call. */
interface PropSpec {
  prop: string;
  /** Source field; absent for a derived property. */
  field?: string;
  as?: Conv;
  /** Nested object the property belongs to (`form`, `list`, `client`). */
  group?: string;
  /** A property computed from the whole record. */
  derive?: (rec: SnRecord) => Expr | undefined;
  /** Fields a derived property consumes. */
  consumes?: string[];
}

export interface FluentEmitter {
  /** The SDK API the emitter calls; equals the descriptor's `sdkApi`. */
  api: string;
  props: PropSpec[];
  /** Fields whose value is a secret for this record (password properties). */
  secretValues?: (rec: SnRecord) => string[];
}

const str = (field: string, prop = field): PropSpec => ({ prop, field });
const bool = (field: string, prop: string): PropSpec => ({
  prop,
  field,
  as: "boolean",
});
const num = (field: string, prop: string): PropSpec => ({
  prop,
  field,
  as: "number",
});
const script = (field: string, prop: string): PropSpec => ({
  prop,
  field,
  as: "script",
});

const BR_ACTIONS = ["insert", "update", "delete", "query"] as const;

/**
 * The dedicated emitters, by registry type id. Property names follow the SDK
 * baseline's API (checked by the P-29 oracle); a field that is set on the
 * record but has no property here is reported in `unsupported[]`.
 */
export const FLUENT_EMITTERS: Readonly<Record<string, FluentEmitter>> = {
  business_rule: {
    api: "BusinessRule",
    props: [
      str("name"),
      str("collection", "table"),
      str("when"),
      {
        prop: "action",
        consumes: BR_ACTIONS.map((a) => `action_${a}`),
        derive: (r) => {
          const on = BR_ACTIONS.filter(
            (a) => snString(r[`action_${a}`]) === "true",
          );
          return on.length ? arr(on.map((a) => lit(a))) : undefined;
        },
      },
      num("order", "order"),
      num("priority", "priority"),
      bool("active", "active"),
      str("condition"),
      str("filter_condition", "filterCondition"),
      bool("abort_action", "abortAction"),
      bool("add_message", "addMessage"),
      str("message"),
      str("description"),
      script("script", "script"),
    ],
  },
  script_include: {
    api: "ScriptInclude",
    props: [
      str("name"),
      str("api_name", "apiName"),
      str("description"),
      bool("active", "active"),
      bool("client_callable", "clientCallable"),
      bool("mobile_callable", "mobileCallable"),
      bool("sandbox_callable", "sandboxCallable"),
      str("access", "accessibleFrom"),
      script("script", "script"),
    ],
  },
  client_script: {
    api: "ClientScript",
    props: [
      str("name"),
      str("table"),
      str("type"),
      str("field"),
      {
        prop: "uiType",
        field: "ui_type",
        as: {
          map: { "0": "desktop", "1": "mobile_or_service_portal", "10": "all" },
        },
      },
      str("view"),
      bool("active", "active"),
      bool("global", "global"),
      bool("applies_extended", "appliesExtended"),
      bool("isolate_script", "isolateScript"),
      str("messages"),
      str("description"),
      script("script", "script"),
    ],
  },
  ui_policy: {
    api: "UiPolicy",
    props: [
      str("table"),
      str("short_description", "shortDescription"),
      str("description"),
      str("conditions"),
      str("view"),
      num("order", "order"),
      bool("active", "active"),
      bool("global", "global"),
      bool("inherit", "inherit"),
      bool("on_load", "onLoad"),
      bool("reverse_if_false", "reverseIfFalse"),
      bool("run_scripts", "runScripts"),
      bool("isolate_script", "isolateScript"),
      script("script_true", "scriptTrue"),
      script("script_false", "scriptFalse"),
    ],
  },
  ui_action: {
    api: "UiAction",
    props: [
      str("table"),
      str("name"),
      str("action_name", "actionName"),
      str("hint"),
      str("comments"),
      str("condition"),
      num("order", "order"),
      bool("active", "active"),
      bool("show_insert", "showInsert"),
      bool("show_update", "showUpdate"),
      bool("show_query", "showQuery"),
      bool("show_multiple_update", "showMultipleUpdate"),
      bool("isolate_script", "isolateScript"),
      { ...bool("client", "isClient"), group: "client" },
      { ...str("onclick", "onClick"), group: "client" },
      { ...bool("form_button", "showButton"), group: "form" },
      { ...bool("form_link", "showLink"), group: "form" },
      { ...bool("form_context_menu", "showContextMenu"), group: "form" },
      { ...bool("list_button", "showButton"), group: "list" },
      { ...bool("list_link", "showLink"), group: "list" },
      { ...bool("list_context_menu", "showContextMenu"), group: "list" },
      { ...bool("list_banner_button", "showBannerButton"), group: "list" },
      script("script", "script"),
    ],
  },
  scheduled_job: {
    api: "ScheduledScript",
    props: [
      str("name"),
      bool("active", "active"),
      bool("conditional", "conditional"),
      str("condition"),
      script("script", "script"),
    ],
  },
  script_action: {
    api: "ScriptAction",
    props: [
      str("name"),
      str("event_name", "eventName"),
      str("description"),
      num("order", "order"),
      bool("active", "active"),
      str("condition_script", "conditionScript"),
      script("script", "script"),
    ],
  },
  acl: {
    api: "Acl",
    props: [
      str("type"),
      str("operation"),
      {
        prop: "table",
        consumes: ["name"],
        derive: (r) => aclName(r).table,
      },
      { prop: "field", derive: (r) => aclName(r).field },
      { prop: "name", derive: (r) => aclName(r).name },
      str("description"),
      bool("active", "active"),
      bool("admin_overrides", "adminOverrides"),
      str("decision_type", "decisionType"),
      str("condition"),
      script("script", "script"),
    ],
  },
  ui_page: {
    api: "UiPage",
    props: [
      {
        prop: "endpoint",
        consumes: ["name"],
        derive: (r) => {
          const name = snString(r.name);
          if (!name) return undefined;
          return lit(name.endsWith(".do") ? name : `${name}.do`);
        },
      },
      str("category"),
      str("description"),
      bool("direct", "direct"),
      script("html", "html"),
      script("client_script", "clientScript"),
      script("processing_script", "processingScript"),
    ],
  },
  property: {
    api: "Property",
    props: [
      str("name"),
      str("type"),
      str("value"),
      str("description"),
      str("choices"),
      bool("is_private", "isPrivate"),
      bool("ignore_cache", "ignoreCache"),
    ],
    secretValues: (r) => (/password/i.test(snString(r.type)) ? ["value"] : []),
  },
  role: {
    api: "Role",
    props: [
      str("name"),
      str("description"),
      str("assignable_by", "assignableBy"),
      bool("elevated_privilege", "elevatedPrivilege"),
      bool("can_delegate", "canDelegate"),
      bool("grantable", "grantable"),
      bool("scoped_admin", "scopedAdmin"),
    ],
  },
};

/** An ACL name split into the SDK's table / field (record ACLs) or kept whole. */
function aclName(r: SnRecord): {
  table?: Expr;
  field?: Expr;
  name?: Expr;
} {
  const name = snString(r.name);
  if (!name) return {};
  const type = snString(r.type) || "record";
  if (type !== "record") return { name: lit(name) };
  const dot = name.indexOf(".");
  if (dot < 0) return { table: lit(name) };
  return {
    table: lit(name.slice(0, dot)),
    field: lit(name.slice(dot + 1)),
  };
}

/** Why a type has no dedicated emitter, for its `unsupported[]` entry. */
function fallbackReason(t: ArtifactType): string | undefined {
  // --- P-28: portal / workspace / catalog emitters (src/api/fluent-ui.ts) ---
  const ui = uiFallbackReason(t);
  if (ui !== undefined) return ui;
  // --- end P-28 ---
  if (t.sdkApi === "Record") return undefined;
  if (t.sdkApi === "none") {
    return `No Fluent API for ${t.table} in the SDK baseline; emitted as Record().`;
  }
  if (t.group === "flow") {
    return `The ${t.sdkApi} emitter is P-27; emitted as Record() rows.`;
  }
  return `No ${t.sdkApi} emitter yet (P-26 covers the scalar core / server / classic-UI types); emitted as Record().`;
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

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
  return SYS_ID.test(value)
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

/** The dedicated call's argument object, and the fields left unmapped. */
function dedicatedArgs(
  run: EmitRun,
  t: ArtifactType,
  e: FluentEmitter,
  rec: SnRecord,
  key: string,
): { props: Prop[]; unmapped: string[] } {
  const props: Prop[] = [
    { key: "$id", value: code(`Now.ID[${tsString(key)}]`) },
  ];
  const groups = new Map<string, Prop[]>();
  const consumed = new Set<string>([t.scopeField]);
  const secretExtra = e.secretValues?.(rec) ?? [];
  const sysId = snString(rec.sys_id);
  const push = (p: Prop, group?: string) => {
    if (!group) return props.push(p);
    let g = groups.get(group);
    if (!g) {
      g = [];
      groups.set(group, g);
      props.push({ key: group, value: obj(g) });
    }
    g.push(p);
  };
  for (const spec of e.props) {
    for (const f of spec.consumes ?? []) consumed.add(f);
    if (spec.derive) {
      const expr = spec.derive(rec);
      if (expr) push({ key: spec.prop, value: expr }, spec.group);
      continue;
    }
    const field = spec.field!;
    consumed.add(field);
    const value = snString(rec[field]);
    if (value === "") continue;
    if (isSecret(field, value, t.secretFields, secretExtra, run.rules)) {
      push(secretProp(run, spec.prop), spec.group);
      continue;
    }
    if (spec.as === "script") {
      push(
        {
          key: spec.prop,
          value: sidecar(run, key, field, value, sidecarSuffix(field, t)),
        },
        spec.group,
      );
      continue;
    }
    const { expr, problem } = convert(value, spec.as);
    if (expr) push({ key: spec.prop, value: expr }, spec.group);
    if (problem) {
      run.unsupported.push({
        kind: "field",
        table: t.table,
        key,
        sys_id: sysId,
        field,
        reason: `${spec.prop}: ${problem}; not emitted.`,
      });
    }
  }
  // Drop a nested group that ended up empty (every member was unset).
  const kept = props.filter((p) => p.value.k !== "obj" || p.value.props.length);
  const unmapped = setFields(rec, consumed);
  return { props: kept, unmapped };
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

// --- P-27 hook: the P-26 internals the flow emitters use (fluent-flow.ts) ---
function flowHooks(run: EmitRun, t: ArtifactType): FlowEmitHooks {
  return {
    key: (base, sysId, table) => run.key(base, sysId, table),
    retable: (key, table) => run.retable(key, table),
    unsupported: (entry) => run.unsupported.push(entry),
    isSecret: (field, value) =>
      isSecret(field, value, t.secretFields, [], run.rules),
    secretProp: (key) => secretProp(run, key),
    unmapped: (rec, consumed) =>
      setFields(rec, new Set([t.scopeField, ...consumed])),
    childRecord: (table, row, key) => {
      const c = t.children.find((d) => d.table === table);
      const data = recordData(run, row, key, {
        table,
        secretFields: t.secretFields,
        scriptFields: c?.scriptFields ?? [],
        refFields: c?.refFields ?? [],
        skip: new Set(),
        ...(c
          ? {
              parent: {
                field: c.parentField,
                table: c.parentTable ?? t.table,
                byValue: c.parentKey !== undefined,
              },
            }
          : {}),
      });
      return recordCall(key, table, data);
    },
    recordCall,
    header,
    file: (path, content) => run.files.push({ path, content }),
  };
}
// --- end P-27 hook ---

/** Emit one artefact's `.now.ts` (and its sidecars) into the run. */
function emitOne(run: EmitRun, t: ArtifactType, src: FluentSource): void {
  const rec = src.record;
  if (!rec) {
    run.unsupported.push({
      kind: "unavailable",
      table: t.table,
      ...(src.sys_id ? { sys_id: src.sys_id } : {}),
      reason: src.degraded
        ? `The record could not be read (${src.degraded.status}): ${src.degraded.reason}`
        : "The record could not be read.",
    });
    return;
  }
  // --- P-28: portal / workspace / catalog emitters (src/api/fluent-ui.ts) ---
  if (UI_EMITTERS[t.type]) return emitUi(run, t, src, rec);
  // --- end P-28 ---
  const sysId = snString(rec.sys_id);
  const name = snString(rec[t.nameField]) || src.name || "";
  const key = run.key(
    `${t.type}_${fluentSlug(name) || sysId.slice(0, 8)}`,
    sysId,
    t.table,
  );
  // --- P-27 hook: a usable explain_flow tree gets the flow emitter ---
  if (src.flowTree && emitFlowFile(flowHooks(run, t), t, src, key)) return;
  // --- end P-27 hook ---
  const emitter = FLUENT_EMITTERS[t.type];
  const apis = new Set<string>();
  const body: string[] = [];
  const notes: string[] = [];

  if (emitter) {
    apis.add(emitter.api);
    const { props, unmapped } = dedicatedArgs(run, t, emitter, rec, key);
    for (const field of unmapped) {
      run.unsupported.push({
        kind: "field",
        table: t.table,
        key,
        sys_id: sysId,
        field,
        reason: `No ${emitter.api} property is mapped for ${field}; not emitted.`,
      });
    }
    if (unmapped.length) {
      notes.push(
        `Not emitted (no ${emitter.api} property mapped): ${unmapped.join(", ")}.`,
      );
    }
    body.push(`${emitter.api}(${render(obj(props))})`);
  } else {
    apis.add("Record");
    const reason = fallbackReason(t);
    if (reason) {
      run.unsupported.push({
        kind: "api",
        table: t.table,
        key,
        sys_id: sysId,
        reason,
      });
      notes.push(reason);
    }
    const data = recordData(run, rec, key, {
      ...t,
      skip: new Set([t.scopeField]),
    });
    body.push(recordCall(key, t.table, data));
  }

  for (const child of src.children ?? []) {
    const c = t.children.find(
      (d) => d.table === child.table && d.parentField === child.parentField,
    );
    if (child.redacted || child.error !== undefined || child.reason) {
      run.unsupported.push({
        kind: "child",
        table: child.table,
        key,
        sys_id: sysId,
        reason: `Child table not emitted: ${child.reason ?? child.error ?? "redacted"}`,
      });
      continue;
    }
    if (child.truncated) {
      run.unsupported.push({
        kind: "child",
        table: child.table,
        key,
        sys_id: sysId,
        reason: `Only the first ${child.count} child rows were read and emitted.`,
      });
    }
    if (!c || !child.records.length) continue;
    apis.add("Record");
    const rows = [...child.records].sort(childOrder(c));
    for (const row of rows) {
      const rowId = snString(row.sys_id);
      const childKey = run.key(
        `${key}__${fluentSlug(c.table)}_${rowId.slice(0, 8).toLowerCase()}`,
        rowId,
        c.table,
      );
      const data = recordData(run, row, childKey, {
        table: c.table,
        secretFields: t.secretFields,
        scriptFields: c.scriptFields ?? [],
        refFields: c.refFields ?? [],
        skip: new Set(),
        parent: {
          field: c.parentField,
          table: c.parentTable ?? t.table,
          byValue: c.parentKey !== undefined,
        },
      });
      body.push(
        `// child of ${key}: ${c.table}\n${recordCall(childKey, c.table, data)}`,
      );
    }
  }

  const scope = src.scope?.scope ?? src.scope?.sys_id ?? "unknown";
  const lines = [
    header([`Source: ${t.table} ${sysId} '${name}' (scope ${scope}).`]),
    "",
    "import '@servicenow/sdk/global'",
    `import { ${[...apis].sort().join(", ")} } from '@servicenow/sdk/core'`,
    "",
    ...(notes.length ? [...notes.map((n) => `// ${oneLine(n)}`), ""] : []),
    body.join("\n\n"),
    "",
  ];
  run.files.push({ path: `${key}.now.ts`, content: lines.join("\n") });
}

/** The `keys.ts` fragment: the run's keys for the SDK key registry. */
function keysFragment(keys: FluentKey[]): string {
  const sorted = [...keys].sort((a, b) => cmp(a.key, b.key));
  const pad = " ".repeat(20);
  const entries = sorted.map(
    (k) =>
      `${pad}${tsString(k.key)}: {\n${pad}    table: ${tsString(k.table)}\n${pad}    id: ${tsString(k.sys_id.toLowerCase())}\n${pad}}`,
  );
  return [
    header([
      "Merge these entries into the SDK project's src/fluent/generated/keys.ts.",
    ]),
    "",
    "import '@servicenow/sdk/global'",
    "",
    "declare global {",
    "    namespace Now {",
    "        namespace Internal {",
    "            interface Keys extends KeysRegistry {",
    "                explicit: {",
    ...entries,
    "                }",
    "            }",
    "        }",
    "    }",
    "}",
    "",
  ].join("\n");
}

/**
 * Emit Fluent for artefacts of one type. Pure: the same sources give the same
 * files byte for byte. `base` names the `keys.ts` fragment.
 */
export function emitFluent(
  t: ArtifactType,
  sources: FluentSource[],
  base: string,
  rules: RedactionRules | null = redactionRules(),
): FluentBundle {
  const run = new EmitRun(rules);
  const sorted = [...sources]
    .map((s) => (rules ? redactValue(s, rules).value : s))
    .sort((a, b) =>
      cmp(
        snString(a.record?.sys_id ?? a.sys_id),
        snString(b.record?.sys_id ?? b.sys_id),
      ),
    );
  for (const src of sorted) emitOne(run, t, src);
  // A key no `$id` uses would make `now-sdk build` emit a DELETE of that
  // sys_id (a record the SDK mints its own id for, such as a flow variable,
  // or one an emitter fell back on): only referenced keys are declared.
  const code = run.files.map((f) => f.content).join("\n");
  run.keys = run.keys.filter((k) =>
    code.includes(`Now.ID[${tsString(k.key)}]`),
  );
  if (run.keys.length) {
    run.files.push({
      path: `${base}.keys.ts`,
      content: keysFragment(run.keys),
    });
  }
  run.files.sort((a, b) => cmp(a.path, b.path));
  return {
    files: run.files,
    keys: [...run.keys].sort((a, b) => cmp(a.key, b.key)),
    unsupported: run.unsupported,
    secretsReplaced: run.secrets,
  };
}

// ---------------------------------------------------------------------------
// The tool body
// ---------------------------------------------------------------------------

export interface GenerateFluentOptions extends ArtifactRef {
  artifactType: string;
  /** Every artefact of the type in this application scope (namespace or sys_id). */
  scope?: string;
  limit?: number;
  format?: "inline" | "file";
  /** File output: replace files that were edited by hand since generation. */
  overwrite?: boolean;
}

/** A file as reported by `generateFluent`. */
export interface FluentFileResult {
  path: string;
  bytes: number;
  content?: string;
  status?: "created" | "updated" | "unchanged";
}

/** Read the artefacts, emit Fluent and deliver it inline or to the docs store. */
export async function generateFluent(
  opts: GenerateFluentOptions,
): Promise<Record<string, unknown>> {
  const t = resolveArtifactType(opts.artifactType);
  const hasId = opts.sys_id !== undefined && opts.sys_id !== "";
  const hasKey = opts.key !== undefined && opts.key !== "";
  const hasScope = opts.scope !== undefined && opts.scope.trim() !== "";
  if (Number(hasId) + Number(hasKey) + Number(hasScope) !== 1) {
    throw new ServiceNowError(
      "Pass exactly one of 'sys_id', 'key' or 'scope'.",
      400,
    );
  }

  const sources: FluentSource[] = [];
  const warnings: string[] = [];
  let scopeName: string;
  let total: number | undefined;
  let truncated = false;
  if (hasScope) {
    const limit = Math.min(
      opts.limit ?? FLUENT_LIMIT.default,
      FLUENT_LIMIT.max,
    );
    const listed = await listArtifacts({
      artifactType: t.type,
      scope: opts.scope,
      limit,
    });
    const rows = (listed.artifacts ?? []) as { sys_id: string }[];
    total = typeof listed.total === "number" ? listed.total : undefined;
    truncated = total !== undefined && total > rows.length;
    if (listed.degraded) {
      const d = listed.degraded as { status: number; reason: string };
      warnings.push(`The listing degraded (${d.status}): ${d.reason}`);
    }
    for (const row of rows) {
      sources.push(
        (await getArtifactFor(t, {
          sys_id: row.sys_id,
        })) as unknown as FluentSource,
      );
    }
    scopeName = opts.scope!.trim();
  } else {
    const one = (await getArtifactFor(
      t,
      hasId ? { sys_id: opts.sys_id } : { key: opts.key },
    )) as unknown as FluentSource;
    sources.push(one);
    scopeName = one.scope?.scope ?? one.scope?.sys_id ?? "unscoped";
  }
  for (const s of sources) {
    const managed = (s as { sdkManaged?: { managed?: string } }).sdkManaged;
    if (managed?.managed === "yes") {
      warnings.push(
        `${s.name ?? s.sys_id} is SDK-managed: its source of truth is the SDK project, not this output.`,
      );
    }
  }
  // --- P-27 hook: read the explain_flow tree of flow-group artefacts ---
  await attachFlowTrees(t, sources, warnings);
  // --- end P-27 hook ---

  // --- P-28: portal / workspace / catalog emitters (src/api/fluent-ui.ts) ---
  const uiEmitter = UI_EMITTERS[t.type] !== undefined;
  if (uiEmitter) warnings.push(UI_VERIFIED_NOTE);
  // --- end P-28 ---
  const first = sources.find((s) => s.record);
  const base = hasScope
    ? t.type
    : first?.record
      ? `${t.type}_${fluentSlug(snString(first.record[t.nameField])) || snString(first.record.sys_id).slice(0, 8)}`
      : t.type;
  const bundle = emitFluent(t, sources, base);
  const head = {
    artifactType: t.type,
    table: t.table,
    sdkApi: t.sdkApi,
    emitter: FLUENT_EMITTERS[t.type] || uiEmitter ? "dedicated" : "record",
    verified: t.verified,
    target: FLUENT_TARGET,
    // --- P-27 hook ---
    ...(FLOW_TREE_KINDS[t.type] ? { emitter: "flow" } : {}),
    // --- end P-27 hook ---
    scope: scopeName,
    count: sources.filter((s) => s.record).length,
    ...(total !== undefined ? { total } : {}),
    ...(truncated ? { truncated: true } : {}),
    keys: bundle.keys,
    unsupported: bundle.unsupported,
    secretsReplaced: bundle.secretsReplaced,
    ...(warnings.length ? { warnings } : {}),
  };

  if (opts.format !== "file") {
    return {
      ...head,
      format: "inline",
      files: bundle.files.map((f) => ({
        path: f.path,
        bytes: Buffer.byteLength(f.content, "utf8"),
        content: f.content,
      })),
    };
  }
  const written = await writeFluentFiles(
    `${activeProfile()}/fluent/${safeSegment(scopeName)}`,
    base,
    bundle,
    { artifactType: t.type, scope: scopeName },
    opts.overwrite === true,
  );
  return { ...head, format: "file", ...written };
}

/** The companion's record of what a run wrote. */
interface Companion {
  files?: { path: string; sha256: string }[];
}

/**
 * Write a bundle under `dir`: every file raw (source files carry no
 * frontmatter), then the `<base>.fluent.json` companion (kind `fluent`) with
 * each file's hash. A file whose content differs from what the previous run
 * recorded was edited by hand: nothing is written unless `overwrite`.
 */
export async function writeFluentFiles(
  dir: string,
  base: string,
  bundle: FluentBundle,
  about: { artifactType: string; scope: string },
  overwrite: boolean,
): Promise<{
  directory: string;
  companion: string;
  files: FluentFileResult[];
}> {
  const companionPath = `${dir}/${base}.fluent.json`;
  const recorded = new Map<string, string>();
  const previous = await docsReadRaw(companionPath, [".json"]);
  if (previous !== undefined) {
    try {
      const parsed = JSON.parse(previous) as Companion;
      for (const f of parsed.files ?? []) recorded.set(f.path, f.sha256);
    } catch {
      // An unreadable companion records nothing: every changed file conflicts.
    }
  }

  const plan: { file: FluentFile; status: FluentFileResult["status"] }[] = [];
  const conflicts: string[] = [];
  for (const file of bundle.files) {
    const existing = await docsReadRaw(
      `${dir}/${file.path}`,
      FLUENT_EXTENSIONS,
    );
    if (existing === undefined) {
      plan.push({ file, status: "created" });
    } else if (existing === file.content) {
      plan.push({ file, status: "unchanged" });
    } else {
      if (!overwrite && recorded.get(file.path) !== sha256Hex(existing)) {
        conflicts.push(file.path);
      }
      plan.push({ file, status: "updated" });
    }
  }
  if (conflicts.length) {
    throw new ServiceNowError(
      `Refusing to overwrite ${conflicts.length} file(s) in ${dir} that were edited by hand or not generated here: ${conflicts.join(", ")}.`,
      409,
      { conflicts },
      {
        code: "DOC_GENERATED",
        hint: "Pass overwrite: true to replace them, or move the edited files.",
      },
    );
  }

  const files: FluentFileResult[] = [];
  for (const { file, status } of plan) {
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (status !== "unchanged") {
      await docsWriteRaw(
        `${dir}/${file.path}`,
        file.content,
        FLUENT_EXTENSIONS,
      );
    }
    files.push({ path: `${dir}/${file.path}`, bytes, status });
  }
  const companion = {
    generator: "servicenow_generate_fluent",
    target: FLUENT_TARGET,
    artifactType: about.artifactType,
    scope: about.scope,
    files: bundle.files.map((f) => ({
      path: f.path,
      sha256: sha256Hex(f.content),
    })),
    keys: bundle.keys,
    unsupported: bundle.unsupported,
  };
  await docsWriteRaw(
    companionPath,
    JSON.stringify(companion, null, 2),
    [".json"],
    {
      generator: "servicenow_generate_fluent",
      kind: "fluent",
      source: companion,
      overwrite,
    },
  );
  return { directory: dir, companion: companionPath, files };
}
