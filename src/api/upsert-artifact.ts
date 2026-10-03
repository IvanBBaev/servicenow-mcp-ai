import { ServiceNowError } from "../core/errors.js";
import type {
  ArtifactChild,
  ArtifactType,
  UniqueRule,
} from "../core/artifacts/registry.js";
import { evaluateTable } from "../core/policy.js";
import {
  assertWriteCap,
  journaledWrite,
  resultModCount,
  ulid,
} from "../core/write-journal.js";
import { resolveArtifactType } from "./artifacts.js";
import { unknownFields } from "./meta.js";
import {
  createRecord,
  keyQuery,
  queryTable,
  resolveUpsert,
  updateRecord,
  type KeyValue,
  type SnRecord,
} from "./table.js";
import { applyInUpdateSet, type UpdateSetBinding } from "./updatesets.js";

/**
 * P-23 — `servicenow_upsert_artifact`: create or update one registry artefact
 * (the primary record plus its child records) as a single plan. The plan
 * decides create / update / noop per record with the S-8 upsert semantics;
 * the apply writes the parent first and then the children in the order given,
 * one journal line per record with its `before` state, so S-2's revert can
 * restore each of them.
 *
 * Scope (SDK-PARITY §5(c)): scalar fields and direct parent/child records.
 * Flows, playbooks and legacy workflows, types narrowed by a `baseQuery`, and
 * children linked by value, composite link or through another child are
 * refused. A JSON field the registry marks `writable:false` makes the call
 * plan-only. Children not named in the call are left alone (no pruning).
 *
 * P-24 widens this to the portal (SP-1 … SP-10) and catalog (CAT-1 … CAT-6)
 * types: a child linked through an earlier child (a page's
 * container → row → column → widget instance tree, a variable's choices, a
 * catalog UI policy's actions) is written when the call names that earlier
 * child by position (`parent`), and the plan runs the SDK's pre-flight checks
 * — instance-wide uniqueness (`unique`), the scope prefix
 * (`scopePrefixFields`, a warning) and valid variable names.
 *
 * P-25: a `flow` accepts `{active}` only, unverified until O-5 confirms on a
 * PDI that toggling `active` leaves `master_snapshot` unchanged.
 */

export type Scalar = string | number | boolean | null;

export interface ChildInput {
  table?: string;
  key?: Record<string, KeyValue>;
  fields: Record<string, Scalar>;
  /** Position of an earlier child this one hangs off (nested children, P-24). */
  parent?: number;
}

export interface ArtifactUpsertInput {
  artifactType: string;
  key: KeyValue | Record<string, KeyValue>;
  fields: Record<string, Scalar>;
  children?: ChildInput[];
}

export type RecordAction = "create" | "update" | "noop";

export interface PlannedRecord {
  role: "parent" | "child";
  table: string;
  /** Position in `children` (children only). */
  index?: number;
  /** The field the apply points at the parent record (children only). */
  parentField?: string;
  /** Position of the parent child; absent when the parent is the primary record. */
  parent?: number;
  action: RecordAction;
  sys_id?: string;
  key: Record<string, KeyValue>;
  /** What the apply sends: the full payload of a create, the changed fields of an update. */
  write: Record<string, Scalar>;
  /** The written fields' current values (update / noop). */
  before?: Record<string, unknown>;
}

export interface ArtifactPlan {
  type: ArtifactType;
  parent: PlannedRecord;
  children: PlannedRecord[];
  /** Fields the registry marks plan-only (`writable:false`) that the plan would write. */
  planOnly: { table: string; field: string }[];
  /** Tables the H-11 policy refuses writes to. */
  deniedTables: { table: string; reason: string }[];
  unknownFields: { table: string; fields: string[] }[];
  /** Pre-flight findings that do not block the apply (P-24 scope prefix, P-25). */
  warnings: PlanWarning[];
}

export interface PlanWarning {
  code: string;
  table: string;
  field?: string;
  message: string;
}

/** P-25: the O-5 caveat every flow plan carries. */
export const FLOW_TOGGLE_UNVERIFIED =
  "Unverified (O-5): toggling sys_hub_flow.active through the Table API is expected to leave master_snapshot unchanged; confirm on a PDI before relying on it.";

/** Groups whose artefacts are graphs, not records (§5(c)): refused. */
const REFUSED_GROUPS = new Set(["flow", "workflow"]);

/** Children read per table when diffing (the P-5 read cap). */
export const CHILD_WRITE_LIMIT = 200;

const SYS_ID = /^[0-9a-f]{32}$/i;

function notWritable(message: string, hint?: string): ServiceNowError {
  return new ServiceNowError(message, 400, undefined, {
    code: "NOT_WRITABLE_TYPE",
    ...(hint ? { hint } : {}),
  });
}

function flowActiveOnly(message: string): ServiceNowError {
  return new ServiceNowError(message, 400, undefined, {
    code: "FLOW_ACTIVE_ONLY",
    hint: "servicenow_upsert_artifact only toggles an existing flow's `active` flag (unverified until O-5); edit the flow itself in Flow Designer or through the ServiceNow SDK.",
  });
}

const BOOLEAN_TEXT = new Set(["true", "false"]);

/**
 * P-25: a `flow` call may only set `active` on an existing flow, with no
 * children. Anything else is refused with FLOW_ACTIVE_ONLY.
 */
export function assertFlowToggle(input: {
  fields: Record<string, Scalar>;
  children?: ChildInput[];
}): void {
  const names = Object.keys(input.fields);
  const extra = names.filter((f) => f !== "active");
  if (extra.length || !names.length) {
    throw flowActiveOnly(
      `A flow accepts only {active} through servicenow_upsert_artifact${extra.length ? `; refused: ${extra.join(", ")}` : ""}.`,
    );
  }
  if (!BOOLEAN_TEXT.has(String(input.fields.active))) {
    throw flowActiveOnly("fields.active of a flow must be true or false.");
  }
  if (input.children?.length) {
    throw flowActiveOnly(
      "A flow's children (actions, logic, variables) are not writable; only {active} is accepted.",
    );
  }
}

/**
 * Resolve the type and refuse the ones outside §5(c). `flow` passes only
 * with `flowToggle` (P-25: the caller then enforces {@link assertFlowToggle}).
 */
export function writableArtifactType(
  type: string,
  opts: { flowToggle?: boolean } = {},
): ArtifactType {
  const t = resolveArtifactType(type);
  if (t.type === "flow" && opts.flowToggle) return t;
  if (REFUSED_GROUPS.has(t.group)) {
    throw notWritable(
      `Artifact type '${t.type}' (${t.group}) is a graph of records; servicenow_upsert_artifact writes scalar and parent/child artefacts only (SDK-PARITY §5(c)).`,
      "Edit flows, playbooks and workflows in Flow Designer / Workflow Editor, or through the ServiceNow SDK.",
    );
  }
  if (t.baseQuery) {
    throw notWritable(
      `Artifact type '${t.type}' is a filtered view of ${t.table} (baseQuery); upsert it through servicenow_upsert_record on ${t.table}.`,
    );
  }
  return t;
}

function fieldNames(list: (string | undefined)[]): string[] {
  return list.filter((f): f is string => !!f && !f.includes("."));
}

/** The fields the descriptor lets the tool write on the primary record. */
export function parentWriteFields(t: ArtifactType): string[] {
  const named = fieldNames([
    t.nameField,
    ...t.keyFields,
    t.activeField,
    ...t.scriptFields,
    ...t.jsonFields.map((j) => j.field),
    ...t.refFields.map((r) => r.field),
    t.appliesToField,
    ...(t.metaFields ?? []),
    ...(t.whenFields ?? []),
    ...(t.writeFields ?? []),
  ]).filter((f) => !f.startsWith("sys_"));
  return [...new Set(named)].sort();
}

/** The fields the descriptor lets the tool write on a child record. */
export function childWriteFields(c: ArtifactChild): string[] {
  const named = fieldNames([
    c.nameField,
    c.orderField,
    ...(c.scriptFields ?? []),
    ...(c.jsonFields ?? []).map((j) => j.field),
    ...(c.refFields ?? []).map((r) => r.field),
    ...(c.writeFields ?? []),
  ]).filter((f) => !f.startsWith("sys_") && f !== c.parentField);
  return [...new Set(named)].sort();
}

function fieldNotAllowed(
  table: string,
  fields: string[],
  allowed: string[],
  why = "not writable through servicenow_upsert_artifact",
): ServiceNowError {
  return new ServiceNowError(
    `Field${fields.length > 1 ? "s" : ""} ${fields.join(", ")} on ${table} ${fields.length > 1 ? "are" : "is"} ${why}. Allowed: ${allowed.join(", ") || "(none)"}.`,
    400,
    { table, fields, allowed },
    {
      code: "FIELD_NOT_ALLOWED",
      hint: "Write other fields with servicenow_upsert_record / servicenow_update_record, or extend the type's writeFields in the registry.",
    },
  );
}

function childNotWritable(
  message: string,
  code: "CHILD_NOT_WRITABLE" | "CHILD_PARENT_INVALID" = "CHILD_NOT_WRITABLE",
): ServiceNowError {
  return new ServiceNowError(message, 400, undefined, { code });
}

/**
 * The writable child descriptor for `table` (the only child when omitted).
 * `parentTable` is the table of the earlier child the record hangs off
 * (P-24 nested children); without it only a direct child matches. Children
 * linked by value (`parentKey`, `alsoMatch`) are never writable.
 */
export function writableChild(
  t: ArtifactType,
  table?: string,
  parentTable?: string,
): ArtifactChild {
  const all = t.children;
  const named = table
    ? all.filter((c) => c.table === table)
    : all.length === 1
      ? all
      : [];
  if (!named.length) {
    throw childNotWritable(
      table
        ? `Table ${table} is not a child of artifact type '${t.type}'. Children: ${[...new Set(all.map((c) => c.table))].join(", ") || "(none)"}.`
        : `Artifact type '${t.type}' has ${all.length ? "several child tables" : "no child tables"}; name the child's table.`,
    );
  }
  const linked = named.filter(
    (c) => c.parentKey === undefined && !c.alsoMatch?.length,
  );
  if (!linked.length) {
    throw childNotWritable(
      `Child table ${named[0]?.table} of '${t.type}' is linked by value, not by a reference to its parent record; servicenow_upsert_artifact writes reference-linked children only.`,
    );
  }
  const hit = linked.find((c) =>
    parentTable === undefined
      ? c.parentTable === undefined || c.parentTable === t.table
      : c.parentTable === parentTable,
  );
  if (hit) return hit;
  const expected = [
    ...new Set(linked.map((c) => c.parentTable ?? t.table)),
  ].join(" or ");
  throw childNotWritable(
    parentTable === undefined
      ? `Child table ${linked[0]?.table} of '${t.type}' hangs off ${expected}; set 'parent' to the position of that earlier child.`
      : `Child table ${linked[0]?.table} of '${t.type}' hangs off ${expected}, not ${parentTable}.`,
    "CHILD_PARENT_INVALID",
  );
}

/** The parent key as field/value pairs (a scalar names the single key field). */
function parentKey(
  t: ArtifactType,
  key: KeyValue | Record<string, KeyValue>,
  allowed: string[],
): Record<string, KeyValue> {
  const bySysId = t.keyFields.length === 1 && t.keyFields[0] === "sys_id";
  if (typeof key !== "object") {
    if (t.keyFields.length !== 1) {
      throw new ServiceNowError(
        `Artifact type '${t.type}' has a composite key (${t.keyFields.join(", ")}); pass 'key' as an object.`,
        400,
      );
    }
    const field = t.keyFields[0] as string;
    if (field === "sys_id" && !SYS_ID.test(String(key))) {
      throw new ServiceNowError(
        `Artifact type '${t.type}' is keyed by sys_id; a plain key must be a 32-character sys_id, or pass an object of identifying fields.`,
        400,
      );
    }
    return { [field]: key };
  }
  const names = Object.keys(key);
  if (!names.length) {
    throw new ServiceNowError("The key needs at least one field.", 400);
  }
  if (!bySysId) {
    const missing = t.keyFields.filter((f) => !(f in key));
    if (missing.length) {
      throw new ServiceNowError(
        `The key of '${t.type}' needs every key field: missing ${missing.join(", ")}.`,
        400,
      );
    }
  }
  const bad = names.filter(
    (f) => !allowed.includes(f) && !t.keyFields.includes(f),
  );
  if (bad.length) {
    throw fieldNotAllowed(t.table, bad, allowed, "not usable as a key");
  }
  if ("sys_id" in key && !SYS_ID.test(String(key.sys_id))) {
    throw new ServiceNowError("key.sys_id must be a 32-character sys_id.", 400);
  }
  return key;
}

function assertNoKeyConflict(
  table: string,
  key: Record<string, KeyValue>,
  fields: Record<string, Scalar>,
): void {
  for (const [field, value] of Object.entries(key)) {
    if (field in fields && String(fields[field]) !== String(value)) {
      throw new ServiceNowError(
        `${table}: fields.${field} conflicts with key.${field}; a created record would not match its own key.`,
        400,
      );
    }
  }
}

/** Raw Table API values compared as the instance stores them. */
function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (typeof v === "object" && "value" in v) return norm(v.value);
    return JSON.stringify(v) ?? "";
  };
  return norm(a) === norm(b);
}

function changedFields(
  fields: Record<string, Scalar>,
  before: Record<string, unknown>,
): Record<string, Scalar> {
  return Object.fromEntries(
    Object.entries(fields).filter(([f, v]) => !same(before[f], v)),
  );
}

function pick(
  record: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  return Object.fromEntries(fields.map((f) => [f, record[f] ?? null]));
}

interface ResolvedChild {
  input: ChildInput;
  index: number;
  child: ArtifactChild;
  key: Record<string, KeyValue>;
  /** Position of the parent child (nested children). */
  parent?: number;
}

/** CAT-1 … CAT-3: a catalog variable's `name` (the SDK's pre-flight rule). */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function preflightInvalid(message: string, detail?: unknown): ServiceNowError {
  return new ServiceNowError(message, 400, detail, {
    code: "PREFLIGHT_INVALID",
    hint: "Fix the value before planning again; the ServiceNow SDK refuses the same input.",
  });
}

/** Refuse an invalid catalog variable name (item_option_new.name). */
function assertVariableName(
  table: string,
  values: Record<string, unknown>,
  where: string,
): void {
  if (table !== "item_option_new" || !("name" in values)) return;
  const name = scalarText(values.name);
  if (!VARIABLE_NAME.test(name)) {
    throw preflightInvalid(
      `${where}: catalog variable name '${name}' is invalid; use letters, digits and '_' and do not start with a digit.`,
      { table, field: "name", value: name },
    );
  }
}

function resolveChildren(
  t: ArtifactType,
  children: ChildInput[],
): ResolvedChild[] {
  const seen = new Set<string>();
  const resolved: ResolvedChild[] = [];
  children.forEach((input, index) => {
    let parentTable: string | undefined;
    if (input.parent !== undefined) {
      const p = resolved[input.parent];
      if (!Number.isInteger(input.parent) || input.parent >= index || !p) {
        throw childNotWritable(
          `children[${index}].parent must be the position of an earlier child${index ? ` (0 … ${index - 1})` : ""}.`,
          "CHILD_PARENT_INVALID",
        );
      }
      parentTable = p.child.table;
    }
    const child = writableChild(t, input.table, parentTable);
    const allowed = childWriteFields(child);
    if (child.parentField in input.fields) {
      throw fieldNotAllowed(
        child.table,
        [child.parentField],
        allowed,
        "set by the tool (the link to its parent record)",
      );
    }
    const bad = Object.keys(input.fields).filter((f) => !allowed.includes(f));
    if (bad.length) throw fieldNotAllowed(child.table, bad, allowed);
    let key = input.key;
    if (!key) {
      const name = [child.nameField, child.orderField].find(
        (f): f is string =>
          f !== undefined &&
          input.fields[f] !== undefined &&
          input.fields[f] !== null,
      );
      if (!name) {
        throw new ServiceNowError(
          `children[${index}] on ${child.table} needs a 'key'${child.nameField ? ` or a value for its name field '${child.nameField}'` : ""}${child.orderField ? ` or its order field '${child.orderField}'` : ""}.`,
          400,
        );
      }
      key = { [name]: input.fields[name] as KeyValue };
    }
    const badKey = Object.keys(key).filter(
      (f) => !allowed.includes(f) && f !== "sys_id",
    );
    if (!Object.keys(key).length || badKey.length) {
      throw fieldNotAllowed(
        child.table,
        badKey,
        allowed,
        "not usable as a key",
      );
    }
    if ("sys_id" in key && !SYS_ID.test(String(key.sys_id))) {
      throw new ServiceNowError(
        `children[${index}].key.sys_id must be a 32-character sys_id.`,
        400,
      );
    }
    assertNoKeyConflict(child.table, key, input.fields);
    assertVariableName(
      child.table,
      { ...key, ...input.fields },
      `children[${index}]`,
    );
    const id = `${child.table}|${input.parent ?? ""}|${JSON.stringify(
      Object.entries(key)
        .map(([f, v]) => [f, String(v)])
        .sort(),
    )}`;
    if (seen.has(id)) {
      throw new ServiceNowError(
        `children[${index}] repeats the key of an earlier child on ${child.table}.`,
        400,
        { key },
        { code: "DUPLICATE_CHILD_KEY" },
      );
    }
    seen.add(id);
    resolved.push({
      input,
      index,
      child,
      key,
      ...(input.parent !== undefined ? { parent: input.parent } : {}),
    });
  });
  return resolved;
}

/** The existing children of one table under the parent, for matching. */
async function existingChildren(
  child: ArtifactChild,
  parentSysId: string,
  fields: string[],
): Promise<SnRecord[]> {
  const { records, total } = await queryTable({
    table: child.table,
    query: `${child.parentField}=${parentSysId}`,
    fields: [...new Set(["sys_id", ...fields])],
    limit: CHILD_WRITE_LIMIT + 1,
    displayValue: "false",
  });
  if (Math.max(records.length, total ?? 0) > CHILD_WRITE_LIMIT) {
    throw new ServiceNowError(
      `The artefact has more than ${CHILD_WRITE_LIMIT} ${child.table} records; servicenow_upsert_artifact diffs at most ${CHILD_WRITE_LIMIT} per table.`,
      409,
      undefined,
      { code: "TOO_MANY_CHILDREN" },
    );
  }
  return records;
}

function planOnlyFields(
  jsonFields: { field: string; writable: boolean }[] | undefined,
  table: string,
  written: Record<string, unknown>,
): { table: string; field: string }[] {
  return (jsonFields ?? [])
    .filter((j) => !j.writable && j.field in written)
    .map((j) => ({ table, field: j.field }));
}

function duplicateUnique(
  table: string,
  values: Record<string, KeyValue>,
  why: string,
  detail?: Record<string, unknown>,
): ServiceNowError {
  const shown = Object.entries(values)
    .map(([f, v]) => `${f}='${String(v)}'`)
    .join(", ");
  return new ServiceNowError(
    `${table} ${shown} ${why}; the ServiceNow SDK refuses the same duplicate. Nothing was changed.`,
    409,
    { table, values, ...detail },
    {
      code: "DUPLICATE_UNIQUE_FIELD",
      hint: "Pick another value (with your scope prefix), or update the existing record under its own scope.",
    },
  );
}

function filled(v: Scalar | undefined): v is KeyValue {
  return v !== undefined && v !== null && String(v) !== "";
}

interface UniqueCheck {
  record: PlannedRecord;
  rules: UniqueRule[] | undefined;
  where: string;
}

/**
 * P-24 pre-flight (SDK parity): every unique rule whose fields a create or
 * update writes must match no other record on the instance — nor another
 * record of the same plan.
 */
async function assertUniqueFields(checks: UniqueCheck[]): Promise<void> {
  const claimed = new Map<string, string>();
  for (const { record, rules, where } of checks) {
    if (record.action === "noop") continue;
    for (const rule of rules ?? []) {
      const values: Record<string, KeyValue> = {};
      for (const f of rule.fields) {
        const v = record.write[f];
        if (filled(v)) values[f] = v;
      }
      if (Object.keys(values).length !== rule.fields.length) continue;
      const table = rule.table ?? record.table;
      const id = `${table}|${JSON.stringify(Object.entries(values).sort())}`;
      const prior = claimed.get(id);
      if (prior) {
        throw duplicateUnique(
          table,
          values,
          `is claimed by both ${prior} and ${where}`,
        );
      }
      claimed.set(id, where);
      const { records } = await queryTable({
        table,
        query: `${keyQuery(values)}${record.sys_id ? `^sys_id!=${record.sys_id}` : ""}`,
        fields: ["sys_id", "sys_scope"],
        limit: 1,
        displayValue: "false",
      });
      const hit = records[0];
      if (hit) {
        throw duplicateUnique(table, values, `already exists (${where})`, {
          existing: hit.sys_id,
          existing_scope: scalarText(hit.sys_scope),
        });
      }
    }
  }
}

function scalarText(v: unknown): string {
  if (v && typeof v === "object" && "value" in v) return scalarText(v.value);
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/**
 * P-24 scope prefix (a warning, unverified): on a create into a scoped
 * application, the declared fields should start with `<scope>_`.
 */
async function scopePrefixWarnings(
  t: ArtifactType,
  parent: PlannedRecord,
): Promise<PlanWarning[]> {
  const scopeId = parent.write.sys_scope;
  if (
    parent.action !== "create" ||
    !t.scopePrefixFields?.length ||
    typeof scopeId !== "string" ||
    !SYS_ID.test(scopeId)
  ) {
    return [];
  }
  const { records } = await queryTable({
    table: "sys_scope",
    query: keyQuery({ sys_id: scopeId }),
    fields: ["sys_id", "scope"],
    limit: 1,
    displayValue: "false",
  });
  const scope = scalarText(records[0]?.scope);
  if (!scope || scope === "global") return [];
  return t.scopePrefixFields.flatMap((field) => {
    const value = parent.write[field];
    return typeof value === "string" && !value.startsWith(`${scope}_`)
      ? [
          {
            code: "SCOPE_PREFIX",
            table: t.table,
            field,
            message: `${t.table}.${field} '${value}' does not start with the scope prefix '${scope}_' (the ServiceNow SDK convention; unverified, O-5).`,
          },
        ]
      : [];
  });
}

/**
 * Build the plan: resolve the parent by its key (S-8), diff each named child
 * against its parent's current children (the primary record, or an earlier
 * child for a nested one), run the P-24 pre-flight checks and collect what
 * the apply would refuse (plan-only fields, table policy). Reads only.
 */
export async function planArtifactUpsert(
  input: ArtifactUpsertInput,
): Promise<ArtifactPlan> {
  const flow = resolveArtifactType(input.artifactType).type === "flow";
  const t = writableArtifactType(input.artifactType, { flowToggle: flow });
  if (flow) assertFlowToggle(input);
  const allowed = parentWriteFields(t);
  const scopeOnCreate = t.scopeField === "sys_scope" ? ["sys_scope"] : [];
  const bad = Object.keys(input.fields).filter(
    (f) => !allowed.includes(f) && !scopeOnCreate.includes(f),
  );
  if (bad.length) throw fieldNotAllowed(t.table, bad, allowed);
  const key = parentKey(t, input.key, allowed);
  assertNoKeyConflict(t.table, key, input.fields);
  assertVariableName(t.table, { ...key, ...input.fields }, "fields");
  const children = resolveChildren(t, input.children ?? []);

  const decision = await resolveUpsert(t.table, key, Object.keys(input.fields));
  if (flow && decision.action === "create") {
    throw flowActiveOnly(
      `No flow matches the key; servicenow_upsert_artifact never creates a flow, it only toggles an existing flow's active flag.`,
    );
  }
  if (
    decision.action === "update" &&
    "sys_scope" in input.fields &&
    !same(decision.before.sys_scope, input.fields.sys_scope)
  ) {
    if (t.unique?.length) {
      throw duplicateUnique(t.table, key, "already exists in another scope", {
        existing: decision.sys_id,
        existing_scope: scalarText(decision.before.sys_scope),
      });
    }
    throw fieldNotAllowed(
      t.table,
      ["sys_scope"],
      allowed,
      "only writable on a create (moving an existing record between scopes is not supported)",
    );
  }
  let parent: PlannedRecord;
  if (decision.action === "create") {
    parent = {
      role: "parent",
      table: t.table,
      action: "create",
      key,
      write: { ...key, ...input.fields },
    };
  } else {
    const write = changedFields(input.fields, decision.before);
    parent = {
      role: "parent",
      table: t.table,
      action: Object.keys(write).length ? "update" : "noop",
      sys_id: decision.sys_id,
      key,
      write,
      before: pick(decision.before, Object.keys(input.fields)),
    };
  }

  const planned: PlannedRecord[] = [];
  const existing = new Map<string, SnRecord[]>();
  for (const c of children) {
    const base = {
      role: "child" as const,
      table: c.child.table,
      index: c.index,
      parentField: c.child.parentField,
      ...(c.parent !== undefined ? { parent: c.parent } : {}),
      key: c.key,
    };
    const owner = c.parent === undefined ? parent : planned[c.parent];
    const ownerId = owner?.action === "create" ? undefined : owner?.sys_id;
    if (!ownerId) {
      planned.push({
        ...base,
        action: "create",
        write: { ...c.key, ...c.input.fields },
      });
      continue;
    }
    const cacheKey = `${c.child.table}|${c.child.parentField}|${ownerId}`;
    let rows = existing.get(cacheKey);
    if (!rows) {
      const wanted = children
        .filter((o) => o.child === c.child)
        .flatMap((o) => [
          ...Object.keys(o.key),
          ...Object.keys(o.input.fields),
        ]);
      rows = await existingChildren(c.child, ownerId, wanted);
      existing.set(cacheKey, rows);
    }
    const matches = rows.filter((r) =>
      Object.entries(c.key).every(([f, v]) => same(r[f], v)),
    );
    if (matches.length > 1) {
      throw new ServiceNowError(
        `children[${c.index}] matches ${matches.length} ${c.child.table} records of its parent; a child key must identify at most one.`,
        409,
        { matches: matches.map((m) => m.sys_id) },
        {
          code: "AMBIGUOUS_KEY",
          hint: "Add fields to the child's key until it is unique.",
        },
      );
    }
    const found = matches[0];
    if (!found) {
      planned.push({
        ...base,
        action: "create",
        write: { ...c.key, ...c.input.fields },
      });
      continue;
    }
    const write = changedFields(c.input.fields, found);
    planned.push({
      ...base,
      action: Object.keys(write).length ? "update" : "noop",
      sys_id: String(found.sys_id),
      write,
      before: pick(found, Object.keys(c.input.fields)),
    });
  }

  await assertUniqueFields([
    { record: parent, rules: t.unique, where: "the primary record" },
    ...children.map((c, i) => ({
      record: planned[i] as PlannedRecord,
      rules: c.child.unique,
      where: `children[${c.index}]`,
    })),
  ]);
  const warnings = await scopePrefixWarnings(t, parent);
  if (flow) {
    warnings.push({
      code: "UNVERIFIED",
      table: t.table,
      field: "active",
      message: FLOW_TOGGLE_UNVERIFIED,
    });
  }

  const planOnly = [
    ...(parent.action === "noop"
      ? []
      : planOnlyFields(t.jsonFields, t.table, parent.write)),
    ...children.flatMap((c, i) =>
      planned[i]?.action === "noop"
        ? []
        : planOnlyFields(
            c.child.jsonFields,
            c.child.table,
            planned[i]?.write ?? {},
          ),
    ),
  ];
  const writing = [parent, ...planned].filter((r) => r.action !== "noop");
  const tables = [...new Set(writing.map((r) => r.table))];
  const deniedTables = tables.flatMap((table) => {
    const v = evaluateTable(table, "write");
    return v.allowed ? [] : [{ table, reason: v.reason ?? "denied" }];
  });
  const unknown = writing.flatMap((r) => {
    const u = unknownFields(r.table, r.write);
    return u?.length ? [{ table: r.table, fields: u }] : [];
  });
  return {
    type: t,
    parent,
    children: planned,
    planOnly,
    deniedTables,
    unknownFields: unknown,
    warnings,
  };
}

/** Whether the plan writes anything. */
export function planWrites(plan: ArtifactPlan): number {
  return [plan.parent, ...plan.children].filter((r) => r.action !== "noop")
    .length;
}

/** Refuse the apply of a plan that writes a plan-only field (§5(c)). */
export function assertNotPlanOnly(plan: ArtifactPlan): void {
  if (!plan.planOnly.length) return;
  throw new ServiceNowError(
    `The plan writes ${plan.planOnly.map((p) => `${p.table}.${p.field}`).join(", ")}, which the registry marks plan-only (writable:false) until a round-trip test exists. Nothing was changed.`,
    409,
    { plan_only: plan.planOnly },
    {
      code: "PLAN_ONLY_FIELD",
      hint: "Review the plan, then make the change in the owning designer (e.g. UI Builder) or through the ServiceNow SDK.",
    },
  );
}

export interface AppliedRecord {
  role: "parent" | "child";
  table: string;
  index?: number;
  action: RecordAction;
  sys_id?: string;
}

/**
 * Apply a plan: the parent first, then the children in order, each through
 * the journal (H-5 `before`, `after_mod_count`, the created sys_id) and all
 * inside one update-set binding. The session write cap is checked for the
 * whole plan before the first write. A failure stops the apply; the records
 * already written stay journaled and revertible one by one.
 */
export async function applyArtifactPlan(
  plan: ArtifactPlan,
  binding: UpdateSetBinding | undefined,
): Promise<{
  records: AppliedRecord[];
  artifact_write: string;
  report?: unknown;
}> {
  const writes = planWrites(plan);
  const link = ulid();
  if (writes === 0) {
    return {
      records: [plan.parent, ...plan.children].map((r) => ({
        role: r.role,
        table: r.table,
        ...(r.index !== undefined ? { index: r.index } : {}),
        action: r.action,
        sys_id: r.sys_id,
      })),
      artifact_write: link,
    };
  }
  assertWriteCap(
    { action: "update", table: plan.parent.table, artifact_write: link },
    { writes, deletes: 0 },
  );
  const { result: records, report } = await applyInUpdateSet(
    binding,
    async (extra) => {
      const done: AppliedRecord[] = [];
      let parentId = plan.parent.sys_id;
      // Written / matched sys_ids by child position, for nested links.
      const ids: (string | undefined)[] = [];
      for (const r of [plan.parent, ...plan.children]) {
        const head = {
          role: r.role,
          table: r.table,
          ...(r.index !== undefined ? { index: r.index } : {}),
        };
        if (r.role === "child" && r.index !== undefined)
          ids[r.index] = r.sys_id;
        if (r.action === "noop") {
          done.push({ ...head, action: "noop", sys_id: r.sys_id });
          continue;
        }
        if (r.action === "create") {
          const owner =
            r.role !== "child"
              ? undefined
              : r.parent === undefined
                ? parentId
                : ids[r.parent];
          if (r.role === "child" && !owner) {
            throw new ServiceNowError(
              `The parent of children[${r.index}] came back without a sys_id; it and the records after it were not written.`,
              502,
              undefined,
              { code: "UNEXPECTED_RESPONSE", source: "servicenow" },
            );
          }
          const payload =
            r.role === "child"
              ? { ...r.write, [r.parentField as string]: owner as string }
              : r.write;
          const created = await journaledWrite(
            {
              action: "create",
              table: r.table,
              fields: payload,
              artifact_write: link,
              ...extra,
            },
            () => createRecord(r.table, payload),
            (res) => ({
              sys_id: typeof res.sys_id === "string" ? res.sys_id : undefined,
              after_mod_count: resultModCount(res),
            }),
          );
          const id =
            typeof created.sys_id === "string" ? created.sys_id : undefined;
          if (r.role === "parent") parentId = id;
          else if (r.index !== undefined) ids[r.index] = id;
          done.push({ ...head, action: "create", sys_id: id });
          continue;
        }
        const sysId = r.sys_id as string;
        const before = pick(r.before ?? {}, Object.keys(r.write));
        await journaledWrite(
          {
            action: "update",
            table: r.table,
            sys_id: sysId,
            fields: r.write,
            before,
            artifact_write: link,
            ...extra,
          },
          () => updateRecord(r.table, sysId, r.write),
          (res) => ({ after_mod_count: resultModCount(res) }),
        );
        done.push({ ...head, action: "update", sys_id: sysId });
      }
      return done;
    },
  );
  return { records, artifact_write: link, ...(report ? { report } : {}) };
}
