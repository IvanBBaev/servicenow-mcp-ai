import { createHash } from "node:crypto";
import { queryTable, type SnRecord } from "./table.js";
import { getTableChain } from "./meta.js";
import { RECORD_SECTIONS } from "./snapshot.js";
import { assertProfile, readSnapshotJson, COMPARE_CAVEATS } from "./compare.js";
import { snString, assertNoCaret, expectResult, IN_CHUNK } from "./shared.js";
import { snRequest } from "../core/http.js";
import { uibCompleteness } from "./uib-completeness.js";
import { ServiceNowError, rethrowIfCancelled } from "../core/errors.js";
import { activeProfile, getCredentials } from "../core/config.js";
import { runWithProfile } from "../core/request-context.js";
import { assertTableAllowed, assertWriteAllowed } from "../core/policy.js";
import { getUpdateSetSetting } from "../core/settings.js";
import { currentRuntime, defineRuntimePart } from "../core/runtime.js";

/**
 * S-6 — update-set awareness (GAP L3-06).
 *
 * Read side: list update sets, summarise one set's `sys_update_xml` rows per
 * artefact, and compare the set's payloads with another profile or a
 * snapshot. Write side: bind an applied Table-API write to a named update set
 * by switching the user's current-update-set preference for the duration of
 * the write, then restoring it.
 */

const SYS_ID_32 = /^[0-9a-f]{32}$/i;
/** Field names whose payload values are never returned. */
const SECRET_FIELD =
  /password|secret|token|credential|private[_.]?key|api[_.]?key/i;
/** Audit columns every payload carries; they always differ between instances. */
const AUDIT_FIELDS = new Set([
  "sys_updated_on",
  "sys_updated_by",
  "sys_created_on",
  "sys_created_by",
  "sys_mod_count",
]);

export const UPDATE_SET_STATES = ["in progress", "complete", "ignore"] as const;
export type UpdateSetState = (typeof UPDATE_SET_STATES)[number];

export interface UpdateSetRef {
  sys_id: string;
  name: string;
  state: string;
  /** sys_scope sys_id of the set's application ("global" for global). */
  application: string;
  application_name?: string;
}

const s = (r: SnRecord | undefined, f: string): string => snString(r?.[f]);

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

function toRef(r: SnRecord): UpdateSetRef {
  const appName = s(r, "application.name");
  return {
    sys_id: s(r, "sys_id"),
    name: s(r, "name"),
    state: s(r, "state"),
    application: s(r, "application"),
    ...(appName ? { application_name: appName } : {}),
  };
}

const REF_FIELDS = [
  "sys_id",
  "name",
  "state",
  "application",
  "application.name",
];

/**
 * Resolve an update set by sys_id (32 hex) or exact name. A name matching
 * several sets prefers the single one in progress; otherwise it is ambiguous.
 */
export async function resolveUpdateSet(ref: string): Promise<UpdateSetRef> {
  const value = ref.trim();
  assertNoCaret(value, "update_set");
  const byId = SYS_ID_32.test(value);
  const { records } = await queryTable({
    table: "sys_update_set",
    query: byId ? `sys_id=${value}` : `name=${value}`,
    fields: REF_FIELDS,
    displayValue: "false",
    limit: 20,
  });
  let rows = records;
  if (rows.length > 1) {
    const open = rows.filter((r) => s(r, "state") === "in progress");
    if (open.length === 1) rows = open;
  }
  if (rows.length === 0) {
    throw new ServiceNowError(
      `Update set "${value}" was not found (or is not readable by this user).`,
      404,
      undefined,
      {
        code: "UPDATE_SET_NOT_FOUND",
        hint: "List the sets with servicenow_list_update_sets and pass a sys_id or exact name.",
      },
    );
  }
  if (rows.length > 1) {
    throw new ServiceNowError(
      `Update set name "${value}" matches ${rows.length} sets; pass its sys_id.`,
      409,
      { candidates: rows.map(toRef) },
      { code: "AMBIGUOUS_KEY" },
    );
  }
  return toRef(rows[0]!);
}

/** The user's current update set (preference `sys_update_set`), best effort. */
async function currentUpdateSetId(): Promise<string | undefined> {
  try {
    const { records } = await queryTable({
      table: "sys_user_preference",
      query: `name=sys_update_set^${userClause("user")}`,
      fields: ["value"],
      displayValue: "false",
      limit: 1,
    });
    return s(records[0], "value") || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Encoded-query clause selecting the configured user — through reference
 * field `ref`, or on sys_user itself — falling back to the session user when
 * no safe user name is configured (token / OAuth auth).
 */
function userClause(ref?: string): string {
  const { user } = getCredentials();
  const safe = !!user && !/[\^=]/.test(user);
  if (ref) {
    return safe
      ? `${ref}.user_name=${user}`
      : `${ref}=javascript:gs.getUserID()`;
  }
  return safe ? `user_name=${user}` : "sys_id=javascript:gs.getUserID()";
}

// ---------------------------------------------------------------------------
// servicenow_list_update_sets
// ---------------------------------------------------------------------------

export const LIST_LIMIT = { default: 50, max: 500 } as const;

export interface ListUpdateSetsOptions {
  state?: UpdateSetState;
  name?: string;
  application?: string;
  query?: string;
  limit?: number;
  offset?: number;
}

export async function listUpdateSets(
  opts: ListUpdateSetsOptions,
): Promise<Record<string, unknown>> {
  const clauses: string[] = [];
  if (opts.state) clauses.push(`state=${opts.state}`);
  if (opts.name) {
    assertNoCaret(opts.name, "name");
    clauses.push(`nameLIKE${opts.name}`);
  }
  if (opts.application) {
    assertNoCaret(opts.application, "application");
    clauses.push(
      SYS_ID_32.test(opts.application) || opts.application === "global"
        ? `application=${opts.application}`
        : `application.scope=${opts.application}`,
    );
  }
  if (opts.query) clauses.push(opts.query);
  clauses.push("ORDERBYDESCsys_updated_on");
  const limit = opts.limit ?? LIST_LIMIT.default;
  const [{ records, total }, current] = await Promise.all([
    queryTable({
      table: "sys_update_set",
      query: clauses.join("^"),
      fields: [
        ...REF_FIELDS,
        "is_default",
        "description",
        "sys_created_by",
        "sys_updated_on",
      ],
      displayValue: "false",
      limit,
      offset: opts.offset,
    }),
    currentUpdateSetId(),
  ]);
  const sets = records.map((r) => {
    const ref = toRef(r);
    return {
      ...ref,
      is_default: s(r, "is_default") === "true",
      current: current !== undefined && ref.sys_id === current,
      description: truncate(s(r, "description"), 200),
      created_by: s(r, "sys_created_by"),
      updated_on: s(r, "sys_updated_on"),
    };
  });
  const shown = (opts.offset ?? 0) + sets.length;
  return {
    count: sets.length,
    ...(total === undefined ? {} : { total }),
    truncated: total !== undefined ? total > shown : sets.length === limit,
    current_update_set: current ?? null,
    update_sets: sets,
  };
}

// ---------------------------------------------------------------------------
// Payload parsing (sys_update_xml.payload)
// ---------------------------------------------------------------------------

export interface ParsedPayload {
  table: string;
  action: string;
  fields: Record<string, string>;
}

const ENTITY: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function unescapeXml(text: string): string {
  return text.replace(
    /<!\[CDATA\[([\s\S]*?)\]\]>|&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (m, cdata: string | undefined, ent: string | undefined) => {
      if (cdata !== undefined) return cdata;
      const e = ent!;
      if (e[0] === "#") {
        const code =
          e[1] === "x" || e[1] === "X"
            ? parseInt(e.slice(2), 16)
            : parseInt(e.slice(1), 10);
        return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return ENTITY[e.toLowerCase()] ?? m;
    },
  );
}

// One flat child element: <name attrs/> or <name attrs>text-or-CDATA</name>.
const CHILD =
  /\s*<([A-Za-z_][\w.-]*)((?:\s[^>]*?)?)(?:\/>|>((?:<!\[CDATA\[[\s\S]*?\]\]>|[^<])*)<\/\1\s*>)/y;

/**
 * Parse a single-record update payload into flat field values. Returns a
 * `reason` instead when the payload is not one flat record (nested elements,
 * a non-record update such as a dictionary bundle or a flow snapshot).
 */
export function parseUpdatePayload(
  xml: string,
): ParsedPayload | { reason: string } {
  const head = /<record_update\b[^>]*?\btable="([\w.-]+)"[^>]*>/.exec(xml);
  if (!head) return { reason: "not a record_update payload" };
  const table = head[1]!;
  const open = new RegExp(
    `<${table.replace(/\./g, "\\.")}\\b([^>]*?)\\baction="([A-Z_]+)"[^>]*>`,
    "y",
  );
  const start = head.index + head[0].length;
  const ws = /\s*/y;
  ws.lastIndex = start;
  ws.exec(xml);
  open.lastIndex = ws.lastIndex;
  const rec = open.exec(xml);
  if (!rec) return { reason: `no <${table} action=…> record element` };
  const fields: Record<string, string> = {};
  let pos = open.lastIndex;
  const close = `</${table}>`;
  for (;;) {
    const rest = /\s*/y;
    rest.lastIndex = pos;
    rest.exec(xml);
    if (xml.startsWith(close, rest.lastIndex)) break;
    CHILD.lastIndex = pos;
    const m = CHILD.exec(xml);
    if (!m) return { reason: "nested or unrecognised elements" };
    fields[m[1]!] = m[3] === undefined ? "" : unescapeXml(m[3]);
    pos = CHILD.lastIndex;
  }
  return { table, action: rec[2]!, fields };
}

/** sys_id of the updated record: the payload's, else the name's suffix. */
function targetSysId(name: string, parsed?: ParsedPayload): string {
  const fromPayload = parsed?.fields.sys_id;
  if (fromPayload && SYS_ID_32.test(fromPayload)) return fromPayload;
  return /_([0-9a-f]{32})$/i.exec(name)?.[1] ?? "";
}

// ---------------------------------------------------------------------------
// servicenow_get_update_set
// ---------------------------------------------------------------------------

export const GET_LIMIT = { default: 200, max: 1000 } as const;
const XML_FIELDS = [
  "sys_id",
  "name",
  "type",
  "target_name",
  "action",
  "table",
  "sys_updated_on",
  "sys_updated_by",
];

export interface GetUpdateSetOptions {
  update_set: string;
  type?: string;
  limit?: number;
  include_payload?: boolean;
  payload_max_chars?: number;
}

async function readUpdateXml(
  set: UpdateSetRef,
  opts: { type?: string; limit: number; payload: boolean },
): Promise<{ rows: SnRecord[]; total?: number; truncated: boolean }> {
  if (opts.type) assertNoCaret(opts.type, "type");
  const { records, total } = await queryTable({
    table: "sys_update_xml",
    query: `update_set=${set.sys_id}${opts.type ? `^type=${opts.type}` : ""}^ORDERBYtype^ORDERBYname`,
    fields: opts.payload ? [...XML_FIELDS, "payload"] : XML_FIELDS,
    displayValue: "false",
    limit: opts.limit,
  });
  return {
    rows: records,
    total,
    truncated:
      total !== undefined
        ? total > records.length
        : records.length === opts.limit,
  };
}

function countBy(rows: SnRecord[], field: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = s(r, field) || "(none)";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export async function getUpdateSet(
  opts: GetUpdateSetOptions,
): Promise<Record<string, unknown>> {
  const set = await resolveUpdateSet(opts.update_set);
  const limit = opts.limit ?? GET_LIMIT.default;
  const max = opts.payload_max_chars ?? 500;
  const { rows, total, truncated } = await readUpdateXml(set, {
    type: opts.type,
    limit,
    payload: !!opts.include_payload,
  });
  const updates = rows.map((r) => {
    const entry: Record<string, unknown> = {
      sys_id: s(r, "sys_id"),
      name: s(r, "name"),
      type: s(r, "type"),
      target_name: s(r, "target_name"),
      action: s(r, "action"),
      table: s(r, "table"),
      updated_on: s(r, "sys_updated_on"),
      updated_by: s(r, "sys_updated_by"),
    };
    if (opts.include_payload) {
      const raw = s(r, "payload");
      const parsed = parseUpdatePayload(raw);
      if ("reason" in parsed) {
        entry.payload = {
          parsed: false,
          reason: parsed.reason,
          preview: truncate(raw, max),
        };
      } else {
        const fields: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed.fields)) {
          fields[k] = SECRET_FIELD.test(k) ? "[redacted]" : truncate(v, max);
        }
        entry.payload = { parsed: true, table: parsed.table, fields };
      }
    }
    return entry;
  });
  // N-28 (UX-09): pages the set touches, and their records it does not carry.
  const uib = rows.some((r) => s(r, "name").startsWith("sys_ux_"))
    ? await uibCompleteness(
        set.sys_id,
        rows.map((r) => s(r, "name")),
        { partial: truncated || !!opts.type },
      )
    : undefined;
  return {
    update_set: set,
    count: updates.length,
    ...(total === undefined ? {} : { total }),
    truncated,
    by_type: countBy(rows, "type"),
    by_action: countBy(rows, "action"),
    updates,
    ...(uib ? { uib_completeness: uib } : {}),
  };
}

// ---------------------------------------------------------------------------
// servicenow_compare_update_set
// ---------------------------------------------------------------------------

export const COMPARE_LIMIT = { default: 100, max: 500 } as const;
const MAX_DIFF_FIELDS = 20;

export type CompareStatus =
  | "same"
  | "different"
  | "missing"
  | "not_comparable"
  | "not_covered"
  | "unknown";

export interface CompareUpdateSetOptions {
  update_set: string;
  with_profile?: string;
  with_snapshot?: string;
  limit?: number;
}

interface Artefact {
  name: string;
  type: string;
  target_name: string;
  action: string;
  table: string;
  sys_id: string;
  status: CompareStatus;
  fields?: string[];
  reason?: string;
}

const shortHash = (text: string): string =>
  text ? createHash("sha256").update(text).digest("hex").slice(0, 16) : "";

/** Field names whose values differ; `other` lacks a field → not compared. */
function diffFields(
  payload: Record<string, string>,
  other: Record<string, string>,
): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (AUDIT_FIELDS.has(k) || !(k in other)) continue;
    if (other[k] === "[redacted]") continue;
    if (other[k] !== v) out.push(k);
  }
  return out;
}

function judge(
  a: Artefact,
  parsed: ParsedPayload,
  other: Record<string, string> | undefined,
): void {
  const deleted = parsed.action === "DELETE";
  if (!other) {
    a.status = deleted ? "same" : "missing";
    return;
  }
  if (deleted) {
    a.status = "different";
    a.reason = "deleted by the set but present on the other side";
    return;
  }
  const fields = diffFields(parsed.fields, other);
  a.status = fields.length ? "different" : "same";
  if (fields.length) a.fields = fields.slice(0, MAX_DIFF_FIELDS);
}

/** Records of `table` by sys_id, read as `profile`. */
async function profileRows(
  profile: string,
  table: string,
  ids: string[],
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const { records } = await runWithProfile(profile, () =>
      queryTable({
        table,
        query: `sys_idIN${chunk.join(",")}`,
        displayValue: "false",
        limit: chunk.length,
      }),
    );
    for (const r of records) {
      const row: Record<string, string> = {};
      for (const k of Object.keys(r)) row[k] = snString(r[k]);
      out.set(row.sys_id!, row);
    }
  }
  return out;
}

/** Snapshot rows of the section for `table`, keyed by sys_id (undefined = not covered). */
async function snapshotRows(
  profile: string,
  table: string,
  cache: Map<string, Map<string, Record<string, string>> | null>,
): Promise<Map<string, Record<string, string>> | null> {
  if (cache.has(table)) return cache.get(table)!;
  const section = Object.entries(RECORD_SECTIONS).find(
    ([, def]) => def.table === table,
  )?.[0];
  let rows: Map<string, Record<string, string>> | null = null;
  if (section) {
    const snap = (await readSnapshotJson(profile, `${section}.json`)) as
      | { records?: Record<string, string>[] }
      | undefined;
    if (Array.isArray(snap?.records)) {
      rows = new Map(snap.records.map((r) => [r.sys_id ?? "", r]));
    }
  }
  cache.set(table, rows);
  return rows;
}

export async function compareUpdateSet(
  opts: CompareUpdateSetOptions,
): Promise<Record<string, unknown>> {
  if (!!opts.with_profile === !!opts.with_snapshot) {
    throw new ServiceNowError(
      "Pass exactly one of with_profile or with_snapshot.",
      400,
    );
  }
  const other = assertProfile((opts.with_profile ?? opts.with_snapshot)!);
  const set = await resolveUpdateSet(opts.update_set);
  const limit = opts.limit ?? COMPARE_LIMIT.default;
  const { rows, total, truncated } = await readUpdateXml(set, {
    limit,
    payload: true,
  });

  const artefacts: Artefact[] = [];
  const pending: { a: Artefact; parsed: ParsedPayload }[] = [];
  for (const r of rows) {
    const parsed = parseUpdatePayload(s(r, "payload"));
    const a: Artefact = {
      name: s(r, "name"),
      type: s(r, "type"),
      target_name: s(r, "target_name"),
      action: s(r, "action"),
      table: "reason" in parsed ? s(r, "table") : parsed.table,
      sys_id: targetSysId(
        s(r, "name"),
        "reason" in parsed ? undefined : parsed,
      ),
      status: "not_comparable",
    };
    artefacts.push(a);
    if ("reason" in parsed) a.reason = parsed.reason;
    else if (!a.sys_id) a.reason = "no target sys_id in the payload";
    else pending.push({ a, parsed });
  }

  const warnings: string[] = [];
  if (opts.with_profile) {
    const byTable = new Map<string, typeof pending>();
    for (const p of pending) {
      byTable.set(p.a.table, [...(byTable.get(p.a.table) ?? []), p]);
    }
    for (const [table, items] of byTable) {
      try {
        const found = await profileRows(
          other,
          table,
          items.map((p) => p.a.sys_id),
        );
        for (const { a, parsed } of items)
          judge(a, parsed, found.get(a.sys_id));
      } catch (e) {
        rethrowIfCancelled(e);
        const reason = `${table} unreadable on "${other}": ${e instanceof Error ? e.message : String(e)}`;
        warnings.push(reason);
        for (const { a } of items) {
          a.status = "unknown";
          a.reason = reason;
        }
      }
    }
  } else {
    const cache = new Map<string, Map<string, Record<string, string>> | null>();
    for (const { a, parsed } of pending) {
      const snap = await snapshotRows(other, a.table, cache);
      if (!snap) {
        a.status = "not_covered";
        a.reason = `no snapshot section for ${a.table} in "${other}"`;
        continue;
      }
      const row = snap.get(a.sys_id);
      const fields =
        a.table === "sys_security_acl" && "script" in parsed.fields
          ? { ...parsed.fields, script_hash: shortHash(parsed.fields.script) }
          : parsed.fields;
      judge(a, { ...parsed, fields }, row);
    }
  }

  const summary: Record<string, number> = {};
  for (const a of artefacts) summary[a.status] = (summary[a.status] ?? 0) + 1;
  return {
    update_set: set,
    against: opts.with_profile ? { profile: other } : { snapshot: other },
    count: artefacts.length,
    ...(total === undefined ? {} : { total }),
    truncated,
    summary,
    artefacts,
    ...(warnings.length ? { warnings } : {}),
    caveats: [
      "Only fields present in the update payload are compared; audit columns (sys_created_*, sys_updated_*, sys_mod_count) are ignored.",
      ...(opts.with_snapshot
        ? [
            "A snapshot covers only its record sections (properties, choices, ACLs, notifications, flows, catalog items, roles) and their snapshot columns; other artefacts are not_covered.",
          ]
        : []),
      ...COMPARE_CAVEATS,
    ],
  };
}

// ---------------------------------------------------------------------------
// Write binding: run an applied Table-API write inside a named update set
// ---------------------------------------------------------------------------

export interface UpdateSetBinding {
  set: UpdateSetRef;
  source: "argument" | "SN_UPDATE_SET";
  /** Whether the table's records are captured by update sets. */
  captured: boolean | "unknown";
}

/**
 * Whether records of `table` are captured in update sets: tables extending
 * sys_metadata are, and so are tables whose collection entry carries the
 * `update_synch` attribute. Anything else (task, cmdb, user data…) is a data
 * row that never lands in an update set.
 */
async function isCaptured(table: string): Promise<boolean | "unknown"> {
  try {
    const chain = await getTableChain(table);
    if (chain.includes("sys_metadata")) return true;
    const { records } = await queryTable({
      table: "sys_dictionary",
      query: `nameIN${chain.join(",")}^internal_type=collection^attributesLIKEupdate_synch=true`,
      fields: ["name"],
      displayValue: "false",
      limit: 1,
    });
    return records.length > 0;
  } catch (e) {
    rethrowIfCancelled(e);
    return "unknown";
  }
}

/**
 * Resolve the update set an applied write to `table` should land in: the
 * per-call `update_set` argument, else SN_UPDATE_SET for the active profile.
 * Undefined when neither is set — no extra request is made (pre-S-6).
 */
export async function planUpdateSetBinding(
  table: string,
  ref?: string,
): Promise<UpdateSetBinding | undefined> {
  const setting = ref ?? getUpdateSetSetting(activeProfile());
  if (!setting) return undefined;
  const [set, captured] = await Promise.all([
    resolveUpdateSet(setting),
    isCaptured(table),
  ]);
  return { set, source: ref ? "argument" : "SN_UPDATE_SET", captured };
}

/** What a plan preview says about the binding. */
export function bindingPlanDetail(
  binding: UpdateSetBinding | undefined,
): Record<string, unknown> {
  if (!binding) return {};
  const { set, source, captured } = binding;
  const inProgress = set.state === "in progress";
  return {
    update_set: {
      ...set,
      source,
      captured,
      note:
        captured === false
          ? "This table holds data rows, which update sets do not capture; the write is applied without switching the update set."
          : inProgress
            ? `The change will be recorded in update set "${set.name}"; the user's current update set is restored afterwards.`
            : `Update set "${set.name}" is "${set.state}", not "in progress" — applying is refused (UPDATE_SET_NOT_IN_PROGRESS).`,
      ...(captured !== false && !inProgress ? { would_refuse: true } : {}),
    },
  };
}

// One preference switch per instance+user at a time: two bound writes of the
// same session must not interleave their switch/restore.
const lockPart = defineRuntimePart(
  "updateSetLocks",
  () => new Map<string, Promise<void>>(),
  (map) => map.clear(),
  { scope: "process" },
);

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const locks = currentRuntime().get(lockPart);
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const mine = previous.then(() => gate);
  locks.set(key, mine);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === mine) locks.delete(key);
  }
}

const PREF_PATH = "/api/now/table/sys_user_preference";

interface PrefState {
  name: string;
  /** Existing row (sys_id + value) or undefined when the row was created. */
  existing?: { sys_id: string; value: string };
  created?: string;
}

/**
 * P-22: read one of the session user's preferences (`sys_user_preference`,
 * matched by user name, or by `gs.getUserID()` when the name is unusable).
 * Undefined when the user has no row for it.
 */
export async function readUserPreference(
  name: string,
): Promise<SnRecord | undefined> {
  return readPref(name);
}

async function readPref(name: string): Promise<SnRecord | undefined> {
  const { records } = await queryTable({
    table: "sys_user_preference",
    query: `name=${name}^${userClause("user")}`,
    fields: ["sys_id", "value", "user"],
    displayValue: "false",
    limit: 1,
  });
  return records[0];
}

async function userSysId(): Promise<string> {
  const { records } = await queryTable({
    table: "sys_user",
    query: userClause(),
    fields: ["sys_id"],
    displayValue: "false",
    limit: 1,
  });
  const id = s(records[0], "sys_id");
  if (!id) {
    throw new ServiceNowError(
      "Could not resolve the user's sys_user record to set the update-set preference.",
      404,
    );
  }
  return id;
}

/** Point preference `name` at `value`; returns how to undo it. */
async function setPref(
  name: string,
  value: string,
  user: () => Promise<string>,
): Promise<PrefState> {
  const row = await readPref(name);
  if (row) {
    const sysId = s(row, "sys_id");
    const old = s(row, "value");
    if (old !== value) {
      await snRequest({
        method: "PATCH",
        path: `${PREF_PATH}/${sysId}`,
        body: { value },
      });
    }
    return { name, existing: { sys_id: sysId, value: old } };
  }
  const { data } = await snRequest<{ result: SnRecord }>({
    method: "POST",
    path: PREF_PATH,
    body: { user: await user(), name, value, type: "string" },
  });
  return { name, created: s(expectResult(data, "Table API"), "sys_id") };
}

async function restorePref(state: PrefState, signal: AbortSignal) {
  if (state.existing) {
    await snRequest({
      method: "PATCH",
      path: `${PREF_PATH}/${state.existing.sys_id}`,
      body: { value: state.existing.value },
      signal,
    });
  } else if (state.created) {
    await snRequest({
      method: "DELETE",
      path: `${PREF_PATH}/${state.created}`,
      signal,
    });
  }
}

export interface BoundResult<T> {
  result: T;
  /** Added to the tool result; absent when no binding applied. */
  report?: Record<string, unknown>;
}

/**
 * Run an applied write inside the bound update set. `run` receives the
 * journal fields to add (`update_set`). Without a binding, or for a data-row
 * table, it runs unchanged. The user's previous preference is restored in a
 * `finally` with a fresh signal (so a cancelled call still restores); a
 * failed restore is reported as a warning, never as the write's failure.
 */
export async function applyInUpdateSet<T>(
  binding: UpdateSetBinding | undefined,
  run: (journal: { update_set?: string }) => Promise<T>,
): Promise<BoundResult<T>> {
  if (!binding) return { result: await run({}) };
  const { set } = binding;
  if (binding.captured === false) {
    return {
      result: await run({}),
      report: {
        update_set: {
          sys_id: set.sys_id,
          name: set.name,
          bound: false,
          note: "Data-row table: not captured by update sets, so the update set was not switched.",
        },
      },
    };
  }
  if (set.state !== "in progress") {
    throw new ServiceNowError(
      `Update set "${set.name}" is "${set.state}"; only an "in progress" set can receive changes.`,
      409,
      { update_set: set },
      {
        code: "UPDATE_SET_NOT_IN_PROGRESS",
        hint: "Pick an in-progress set (servicenow_list_update_sets state='in progress') or reopen this one.",
      },
    );
  }
  assertTableAllowed("sys_user_preference");
  assertWriteAllowed("update");
  const { instance, user } = getCredentials();
  return withLock(`${instance}|${user}`, async () => {
    let userId: string | undefined;
    const lazyUser = async () => (userId ??= await userSysId());
    const states: PrefState[] = [];
    let restored = true;
    let warning: string | undefined;
    let result: T;
    try {
      states.push(await setPref("sys_update_set", set.sys_id, lazyUser));
      if (set.application && set.application !== "global") {
        states.push(
          await setPref(
            `updateSetForScope${set.application}`,
            set.sys_id,
            lazyUser,
          ),
        );
      }
      result = await run({ update_set: set.sys_id });
    } finally {
      const signal = new AbortController().signal;
      for (const state of [...states].reverse()) {
        try {
          await restorePref(state, signal);
        } catch (e) {
          restored = false;
          warning = `Could not restore preference ${state.name}: ${e instanceof Error ? e.message : String(e)}. Check the user's current update set.`;
        }
      }
    }
    return {
      result,
      report: {
        update_set: {
          sys_id: set.sys_id,
          name: set.name,
          bound: true,
          // The user's update set before the switch (null: no preference row).
          previous: states[0]?.existing?.value || null,
          restored,
          ...(warning ? { warning } : {}),
        },
      },
    };
  });
}
