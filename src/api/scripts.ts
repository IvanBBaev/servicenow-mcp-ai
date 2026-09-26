import { isTableAllowed } from "../core/policy.js";
import { ServiceNowError } from "../core/errors.js";
import { snRequest } from "../core/http.js";
import { useCodeSearch } from "../core/settings.js";
import { queryTable, getRecord, type SnRecord } from "./table.js";
import { assertNoCaret, snString } from "./shared.js";
import { pluginCall } from "./plugin.js";
import {
  ARTIFACT_TYPES,
  getArtifactType,
  type ArtifactType,
} from "../core/artifacts/registry.js";

/**
 * Script intelligence helpers. ServiceNow keeps all server/client code in
 * ordinary tables (sys_script, sys_script_include, ...), so these read-only
 * tools go through the Table API and obey the same auth, SSRF and table-policy
 * guards as any other read. Reading `sys_script` therefore requires `sys_script`
 * to be allowed by SN_TABLES_ALLOW/DENY.
 */

/** Descriptor for one kind of ServiceNow script artefact. */
interface ScriptType {
  /** The table the artefact lives in. */
  table: string;
  /** Field holding the human-readable name. */
  nameField: string;
  /** Field referencing the table the artefact applies to, when applicable. */
  appliesToField?: string;
  /** Metadata fields surfaced in listings (besides name/sys_id/audit fields). */
  metaFields: string[];
  /** Field(s) holding executable source code. */
  scriptFields: string[];
}

/**
 * Supported script types, keyed by the value clients pass as `type`. A derived
 * view over the artefact registry (P-1): the descriptors flagged `scriptTools`,
 * in registry order, reduced to the fields the script tools read.
 */
export const SCRIPT_TYPES: Record<string, ScriptType> = scriptTypeView(
  (t) => t.scriptTools === true,
);

/** Names of every supported script type, for error messages and iteration. */
export const SCRIPT_TYPE_NAMES = Object.keys(SCRIPT_TYPES);

/**
 * Opt-in script types (P-9): the registry descriptors flagged
 * `scriptToolsOptIn` — UI Builder client scripts and data brokers, portal
 * Angular providers, templates, themes, CSS and search sources. list_scripts,
 * get_script and search_code serve them only when asked for explicitly (a
 * `type`, or search_code `extended:true`); the default sweep, where_used,
 * lint_script, code_health, snapshot and compare stay on {@link SCRIPT_TYPES}.
 */
export const OPT_IN_SCRIPT_TYPES: Record<string, ScriptType> = scriptTypeView(
  (t) => t.scriptToolsOptIn === true,
);

/** Names of the opt-in script types, in registry order. */
export const OPT_IN_SCRIPT_TYPE_NAMES = Object.keys(OPT_IN_SCRIPT_TYPES);

/** Registry descriptors matching `pick`, reduced to the script-tool fields. */
function scriptTypeView(
  pick: (t: ArtifactType) => boolean,
): Record<string, ScriptType> {
  return Object.fromEntries(
    ARTIFACT_TYPES.filter(pick).map((t): [string, ScriptType] => [
      t.type,
      {
        table: t.table,
        nameField: t.nameField,
        ...(t.appliesToField !== undefined && {
          appliesToField: t.appliesToField,
        }),
        metaFields: [...(t.metaFields ?? [])],
        scriptFields: [...t.scriptFields],
      },
    ]),
  );
}

/**
 * The full registry descriptor behind a script type — scope / active fields,
 * client and markup fields, base query. Kept apart from the `SCRIPT_TYPES` view
 * so that view stays exactly what it was before S-4.
 */
export function scriptArtifact(type: string, optIn = false): ArtifactType {
  resolveType(type, optIn);
  return getArtifactType(type)!;
}

/**
 * Encoded-query clause restricting a type to one application scope: a 32-hex
 * sys_id matches the reference, anything else the scope's namespace (`global`,
 * `x_acme_app`) through a dot-walk.
 */
export function scopeClause(scopeField: string, scope: string): string {
  const s = scope.trim();
  assertNoCaret(s, "scope");
  return /^[0-9a-f]{32}$/i.test(s)
    ? `${scopeField}=${s}`
    : `${scopeField}.scope=${s}`;
}

function resolveType(type: string, optIn = false): ScriptType {
  const descriptor =
    SCRIPT_TYPES[type] ?? (optIn ? OPT_IN_SCRIPT_TYPES[type] : undefined);
  if (!descriptor) {
    const valid = optIn
      ? [...SCRIPT_TYPE_NAMES, ...OPT_IN_SCRIPT_TYPE_NAMES]
      : SCRIPT_TYPE_NAMES;
    throw new ServiceNowError(
      `Unknown script type '${type}'. Valid types: ${valid.join(", ")}.`,
      400,
    );
  }
  return descriptor;
}

const AUDIT_FIELDS = ["sys_updated_on", "sys_updated_by"];

export interface ListScriptsOptions {
  type: string;
  table?: string;
  name?: string;
  active?: boolean;
  query?: string;
  /** Application scope (namespace or sys_id) the scripts must belong to. */
  scope?: string;
  limit?: number;
  offset?: number;
}

export interface ScriptSummary {
  type: string;
  sys_id: string;
  name: string;
  [field: string]: unknown;
}

/**
 * List script artefacts of a single type as compact metadata (no source code),
 * optionally filtered by applied table, name fragment, active flag, or a raw
 * encoded query.
 */
export async function listScripts(
  opts: ListScriptsOptions,
): Promise<{ type: string; count: number; scripts: ScriptSummary[] }> {
  const descriptor = resolveType(opts.type, true);
  const artifact = getArtifactType(opts.type)!;
  const clauses: string[] = [];

  // The base query carries `^OR`, so it goes first: every later `^` clause is
  // ANDed with the whole of it.
  if (artifact.baseQuery) clauses.push(artifact.baseQuery);
  if (opts.scope?.trim()) {
    clauses.push(scopeClause(artifact.scopeField, opts.scope));
  }
  if (opts.table?.trim()) assertNoCaret(opts.table, "table");
  if (opts.name?.trim()) assertNoCaret(opts.name, "name");
  if (opts.table?.trim()) {
    const t = opts.table.trim();
    if (descriptor.appliesToField) {
      clauses.push(`${descriptor.appliesToField}=${t}`);
    } else {
      clauses.push(`${descriptor.nameField}LIKE${t}`);
    }
  }
  if (opts.name?.trim()) {
    clauses.push(`${descriptor.nameField}LIKE${opts.name.trim()}`);
  }
  if (opts.active !== undefined) {
    if (!artifact.activeField) {
      throw new ServiceNowError(
        `Script type '${opts.type}' has no active flag; drop the 'active' filter.`,
        400,
      );
    }
    clauses.push(`${artifact.activeField}=${opts.active}`);
  }
  if (opts.query?.trim()) {
    clauses.push(opts.query.trim());
  }
  clauses.push(`ORDERBY${descriptor.nameField}`);

  const fields = [
    "sys_id",
    descriptor.nameField,
    ...descriptor.metaFields,
    ...AUDIT_FIELDS,
  ];

  const { records } = await queryTable({
    table: descriptor.table,
    query: clauses.join("^"),
    fields,
    displayValue: "true",
    limit: opts.limit ?? 50,
    offset: opts.offset,
  });

  const scripts = records.map((r) =>
    normalizeSummary(opts.type, descriptor, r),
  );
  return { type: opts.type, count: scripts.length, scripts };
}

function normalizeSummary(
  type: string,
  descriptor: ScriptType,
  record: SnRecord,
): ScriptSummary {
  const summary: ScriptSummary = {
    type,
    sys_id: snString(record.sys_id),
    name: snString(record[descriptor.nameField]),
  };
  for (const field of [...descriptor.metaFields, ...AUDIT_FIELDS]) {
    if (field in record) summary[field] = record[field];
  }
  return summary;
}

/**
 * Read one script artefact in full, including its source code and execution
 * context (e.g. for a business rule: collection, when, order, condition).
 */
export async function getScript(
  type: string,
  sysId: string,
): Promise<{ type: string; table: string; record: SnRecord }> {
  const descriptor = resolveType(type, true);
  const record = await getRecord(descriptor.table, sysId);
  return { type, table: descriptor.table, record };
}

export interface SearchCodeOptions {
  text: string;
  type?: string;
  table?: string;
  /** Application scope (namespace or sys_id) the artefacts must belong to. */
  scope?: string;
  limit?: number;
  /** Cap on `hits` per artefact (default {@link MAX_HITS_PER_ARTEFACT}). */
  maxHits?: number;
  /**
   * Also sweep the opt-in script types ({@link OPT_IN_SCRIPT_TYPES}) after the
   * default ones when no `type` is given (P-9). Takes the LIKE path: the Code
   * Search API does not index those tables.
   */
  extended?: boolean;
}

/** Matching lines reported per artefact; `hitCount` keeps the full total. */
export const MAX_HITS_PER_ARTEFACT = 20;

/** Characters kept of a matching (or context) line. */
const LINE_CHARS = 200;

/** One matching line inside an artefact's source. */
export interface CodeHit {
  field: string;
  /** 1-based line number within `field`. */
  line: number;
  /** The matching line, trimmed and cut to 200 characters. */
  text: string;
  /** The non-blank line just before / after, trimmed and cut the same way. */
  before?: string;
  after?: string;
}

export interface CodeMatch {
  type: string;
  sys_id: string;
  name: string;
  table?: string;
  /** Field / line / snippet of the first hit (the pre-S-4 result shape). */
  field: string;
  line: number;
  snippet: string;
  /** Every matching line across the script fields, capped per artefact. */
  hits: CodeHit[];
  /** Total matching lines, including any beyond the `hits` cap. */
  hitCount: number;
}

export interface SearchCodeResult {
  count: number;
  matches: CodeMatch[];
  /**
   * Widened (S-4) and opt-in (P-9) unverified script types skipped in an all-types search
   * because their table is missing, policy-denied or unreadable for the
   * connected user. Present only when non-empty.
   */
  unreadable?: string[];
}

/**
 * Search the source of script artefacts for a literal substring (case
 * sensitivity follows ServiceNow's LIKE). Returns one entry per artefact: the
 * first hit as a snippet plus every matching line (with a line of context either
 * side) up to a per-artefact cap, rather than whole scripts. Answers questions
 * like "where is this script include used?".
 */
export async function searchCode(
  opts: SearchCodeOptions,
): Promise<SearchCodeResult> {
  const text = opts.text?.trim();
  if (!text) {
    throw new ServiceNowError("searchCode requires a non-empty 'text'.", 400);
  }
  assertNoCaret(text, "text");
  if (opts.table?.trim()) assertNoCaret(opts.table, "table");
  const scope = opts.scope?.trim() || undefined;
  if (scope) assertNoCaret(scope, "scope");
  const limit = opts.limit ?? 50;
  const maxHits = Math.max(1, opts.maxHits ?? MAX_HITS_PER_ARTEFACT);
  const extended = opts.extended === true && !opts.type;
  const types = opts.type
    ? [opts.type]
    : extended
      ? [...SCRIPT_TYPE_NAMES, ...OPT_IN_SCRIPT_TYPE_NAMES]
      : SCRIPT_TYPE_NAMES;
  // Validate an explicit type up front (iterating all types skips validation).
  if (opts.type) resolveType(opts.type, true);

  // FT-7: use the indexed Code Search API when opted in and available; fall
  // back to the LIKE iteration below on any failure. The API cannot filter by
  // scope, so a scoped search always takes the LIKE path.
  if (useCodeSearch() && !scope && !extended) {
    try {
      return await codeSearchApi(text, opts.table?.trim(), limit);
    } catch {
      // fall through to the LIKE search
    }
  }

  const matches: CodeMatch[] = [];
  const unreadable: string[] = [];
  for (const typeName of types) {
    if (matches.length >= limit) break;
    const descriptor = SCRIPT_TYPES[typeName] ?? OPT_IN_SCRIPT_TYPES[typeName];
    if (!descriptor) continue;
    const artifact = getArtifactType(typeName)!;
    const remaining = limit - matches.length;

    const codeQuery = descriptor.scriptFields
      .map((f) => `${f}LIKE${text}`)
      .join("^OR");
    const singleField = descriptor.scriptFields.length === 1;
    const tableFilter =
      opts.table?.trim() && descriptor.appliesToField
        ? `${descriptor.appliesToField}=${opts.table.trim()}`
        : undefined;

    // A table filter can only be safely AND-ed in the query for single-field
    // types; for multi-field types it is applied as a post-filter instead.
    // Encoded-query `^OR` binds to the clause before it, so each `^`-joined
    // prefix below ANDs with the whole code OR-chain.
    const query = [
      ...(artifact.baseQuery ? [artifact.baseQuery] : []),
      ...(scope ? [scopeClause(artifact.scopeField, scope)] : []),
      tableFilter && singleField ? `${tableFilter}^${codeQuery}` : codeQuery,
    ].join("^");

    const fields = [
      "sys_id",
      descriptor.nameField,
      ...(descriptor.appliesToField ? [descriptor.appliesToField] : []),
      ...descriptor.scriptFields,
    ];

    let records: SnRecord[];
    try {
      ({ records } = await queryTable({
        table: descriptor.table,
        query,
        fields,
        displayValue: "false",
        limit: remaining,
      }));
    } catch (error) {
      // An all-types sweep skips a widened type whose table is missing or
      // unreadable instead of failing; the nine verified types keep failing
      // loudly, exactly as before S-4.
      if (!opts.type && !artifact.verified && isSkippable(error)) {
        unreadable.push(typeName);
        continue;
      }
      throw error;
    }

    for (const record of records) {
      if (matches.length >= limit) break;
      const appliesTo = descriptor.appliesToField
        ? snString(record[descriptor.appliesToField])
        : undefined;
      if (tableFilter && !singleField && appliesTo !== opts.table?.trim()) {
        continue;
      }
      const match = matchRecord(
        typeName,
        descriptor,
        record,
        text,
        appliesTo,
        maxHits,
      );
      if (match) matches.push(match);
    }
  }
  return {
    count: matches.length,
    matches,
    ...(unreadable.length ? { unreadable } : {}),
  };
}

/** Missing table (400/404), or denied by policy or ACL (401/403). */
function isSkippable(error: unknown): boolean {
  return (
    error instanceof ServiceNowError &&
    [400, 401, 403, 404].includes(error.status ?? 0)
  );
}

/**
 * FT-7 — query the Code Search API (`sn_codesearch`). The result shape varies by
 * instance version, so each field is read leniently; an inactive plugin throws
 * (via pluginCall) and the caller falls back to the LIKE iteration.
 */
async function codeSearchApi(
  text: string,
  table: string | undefined,
  limit: number,
): Promise<SearchCodeResult> {
  return pluginCall("Code Search", async () => {
    const params = new URLSearchParams({ term: text });
    const { data } = await snRequest<{ result: unknown }>({
      method: "GET",
      path: "/api/sn_codesearch/code_search/search",
      params,
    });
    const raw = (data as { result?: unknown }).result;
    const items: unknown[] = Array.isArray(raw)
      ? raw
      : raw &&
          typeof raw === "object" &&
          Array.isArray((raw as { results?: unknown }).results)
        ? (raw as { results: unknown[] }).results
        : [];
    const matches: CodeMatch[] = [];
    for (const it of items) {
      if (matches.length >= limit) break;
      if (typeof it !== "object" || it === null) continue;
      const r = it as Record<string, unknown>;
      const tbl = snString(r.table ?? r.tableName ?? r.table_name);
      if (table && tbl && tbl !== table) continue;
      // H-4: the Code Search API scans every script table itself, so a hit
      // on a denied table is dropped here (the LIKE path asserts per table).
      if (tbl && !isTableAllowed(tbl)) continue;
      const lineNo = Number(snString(r.line ?? r.lineNumber ?? r.line_number));
      const field =
        snString(r.field ?? r.fieldName ?? r.field_name) || "script";
      const line = Number.isFinite(lineNo) && lineNo > 0 ? lineNo : 1;
      const snippet = snString(r.snippet ?? r.line ?? r.code ?? r.match)
        .trim()
        .slice(0, LINE_CHARS);
      // The API reports one line per item, so each item is its own single hit.
      matches.push({
        type: snString(r.type ?? r.className ?? r.class_name) || "code",
        sys_id: snString(r.sys_id ?? r.sysId ?? r.id),
        name: snString(r.name ?? r.label),
        ...(tbl ? { table: tbl } : {}),
        field,
        line,
        snippet,
        hits: [{ field, line, text: snippet }],
        hitCount: 1,
      });
    }
    return { count: matches.length, matches };
  });
}

/** A context line: trimmed and cut, or undefined when absent or blank. */
function contextLine(line: string | undefined): string | undefined {
  const t = line?.trim();
  return t ? t.slice(0, LINE_CHARS) : undefined;
}

/**
 * Every line of the record's script fields containing `text` (case-
 * insensitive), in field then line order. The first hit doubles as the pre-S-4
 * `field` / `line` / `snippet`; `hits` stops at `maxHits`, `hitCount` does not.
 */
function matchRecord(
  type: string,
  descriptor: ScriptType,
  record: SnRecord,
  text: string,
  appliesTo: string | undefined,
  maxHits: number,
): CodeMatch | undefined {
  const needle = text.toLowerCase();
  const hits: CodeHit[] = [];
  let hitCount = 0;
  for (const field of descriptor.scriptFields) {
    const source = record[field];
    if (typeof source !== "string") continue;
    const lines = source.split("\n");
    for (const [i, line] of lines.entries()) {
      if (!line.toLowerCase().includes(needle)) continue;
      hitCount++;
      if (hits.length >= maxHits) continue;
      const before = contextLine(lines[i - 1]);
      const after = contextLine(lines[i + 1]);
      hits.push({
        field,
        line: i + 1,
        text: line.trim().slice(0, LINE_CHARS),
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
      });
    }
  }
  const first = hits[0];
  if (!first) return undefined;
  return {
    type,
    sys_id: snString(record.sys_id),
    name: snString(record[descriptor.nameField]),
    ...(appliesTo ? { table: appliesTo } : {}),
    field: first.field,
    line: first.line,
    snippet: first.text,
    hits,
    hitCount,
  };
}

/** One automation entry in a table's logic overview (metadata only). */
type LogicEntry = ScriptSummary;

export interface TableLogic {
  table: string;
  businessRules: LogicEntry[];
  clientScripts: LogicEntry[];
  uiPolicies: LogicEntry[];
  uiActions: LogicEntry[];
  acls: LogicEntry[];
  /**
   * Artefact types the connected user could not read (the table is
   * admin-restricted and the user lacks a read role). Present only when at
   * least one sub-query was denied — DF-0 graceful degrade, so an overview on a
   * governed instance is partial-and-flagged rather than a hard 403 or a
   * silently empty result. Run servicenow_check_capabilities for the full map.
   */
  unreadable?: string[];
}

/**
 * Run one tableLogic sub-query, degrading a 401/403 (the artefact table is
 * admin-restricted and the user lacks a read role) to an empty list plus a
 * recorded label, so one unreadable artefact type does not fail the whole
 * overview. Any other error is genuinely unexpected and propagates.
 */
async function readableEntries(
  label: string,
  load: Promise<LogicEntry[]>,
  unreadable: string[],
): Promise<LogicEntry[]> {
  try {
    return await load;
  } catch (error) {
    if (
      error instanceof ServiceNowError &&
      (error.status === 403 || error.status === 401)
    ) {
      unreadable.push(label);
      return [];
    }
    throw error;
  }
}

/**
 * Assemble the full automation picture for a table: business rules (ordered by
 * when + order), client scripts, UI policies, UI actions and ACLs. Metadata
 * only — use getScript for source. This is the entry point for "what happens
 * when a record on this table is inserted/updated?".
 */
export async function tableLogic(
  table: string,
  opts: { scope?: string } = {},
): Promise<TableLogic> {
  const t = table.trim();
  const scope = opts.scope?.trim() || undefined;
  // Guard at the entry: two of the sub-queries below embed `t` raw into an
  // encoded query (collection=…, nameLIKE…), so a stray `^` would otherwise
  // fire injected clauses before the table-validated sub-requests reject.
  assertNoCaret(t, "table");
  const unreadable: string[] = [];
  const wrap = (label: string, load: Promise<LogicEntry[]>) =>
    readableEntries(label, load, unreadable);
  const [businessRules, clientScripts, uiPolicies, uiActions, acls] =
    await Promise.all([
      wrap(
        "business_rule",
        listOrdered(
          "business_rule",
          `collection=${t}^ORDERBYwhen^ORDERBYorder`,
          scope,
        ),
      ),
      wrap(
        "client_script",
        listScripts({
          type: "client_script",
          table: t,
          scope,
          limit: 200,
        }).then((r) => r.scripts),
      ),
      wrap(
        "ui_policy",
        listScripts({ type: "ui_policy", table: t, scope, limit: 200 }).then(
          (r) => r.scripts,
        ),
      ),
      wrap(
        "ui_action",
        listScripts({ type: "ui_action", table: t, scope, limit: 200 }).then(
          (r) => r.scripts,
        ),
      ),
      wrap(
        "acl",
        listScripts({
          type: "acl",
          query: `nameLIKE${t}`,
          scope,
          limit: 200,
        }).then((r) => r.scripts),
      ),
    ]);
  return {
    table: t,
    businessRules,
    clientScripts,
    uiPolicies,
    uiActions,
    acls,
    ...(unreadable.length ? { unreadable } : {}),
  };
}

/** List a script type with an explicit raw query (used for custom ordering). */
async function listOrdered(
  type: string,
  query: string,
  scope?: string,
): Promise<LogicEntry[]> {
  const { scripts } = await listScripts({ type, query, scope, limit: 200 });
  return scripts;
}
