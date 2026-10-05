import { decodeField } from "../core/artifacts/decoders.js";
import { scriptCalls } from "./script-ast.js";
import type { UibRule, UibSeverity } from "./uib-script-lint.js";

/**
 * N-29 (UX-11) — data broker hints for UI Builder: three rules over one
 * broker row (transform, scriptlet, REST or GraphQL) and whether a
 * `ux_data_broker` ACL names it.
 *
 * - `uib-broker-mutates-no-acl` (error) — the broker declares
 *   `mutates_server_data` and no ACL guards it;
 * - `uib-transform-gliderecord-no-acl-check` (warn) — a transform script
 *   reads data with `new GlideRecord` / `GlideAggregate` and never checks
 *   access (`canRead` / `canWrite` / `canCreate` / `canDelete`, a role check,
 *   or `GlideRecordSecure`);
 * - `uib-broker-no-input-schema` (info) — the broker declares no input
 *   schema (`properties` empty).
 *
 * Pure: no network, no I/O, never throws. The script rule parses with acorn
 * (./script-ast.ts) and falls back to a regex when the source does not parse.
 *
 * ASSUMPTION (unverified until O-5, PDI): `mutates_server_data` and
 * `properties` exist on every broker table; the REST and GraphQL broker
 * tables (`sys_ux_data_broker_rest`, `sys_ux_data_broker_graphql`) are not in
 * the SDK inventory. A field the instance did not return (`undefined`) is
 * unknown, so its rule does not fire.
 */

/** The broker rule catalogue (same shape as UIB_SCRIPT_RULES). */
export const UIB_BROKER_RULES: readonly UibRule[] = [
  {
    id: "uib-broker-mutates-no-acl",
    severity: "error",
    hint: "A broker that mutates server data must be guarded: add a sys_security_acl of type ux_data_broker whose name is the broker's sys_id, with the roles that may run it.",
  },
  {
    id: "uib-transform-gliderecord-no-acl-check",
    severity: "warn",
    hint: "A transform runs on the server with the caller's session but GlideRecord skips ACLs: use GlideRecordSecure, or check canRead() / canWrite() (or a role) before returning or changing records.",
  },
  {
    id: "uib-broker-no-input-schema",
    severity: "info",
    hint: "Declare every input in the broker's `properties` (name, type, mandatory) so UI Builder can bind them and the broker can trust their shape; an empty schema is fine only for a broker that takes no input.",
  },
];

export type UibBrokerRuleId =
  | "uib-broker-mutates-no-acl"
  | "uib-transform-gliderecord-no-acl-check"
  | "uib-broker-no-input-schema";

export type UibBrokerKind = "transform" | "scriptlet" | "rest" | "graphql";

/** Broker table → kind (the four tables explain_ui_experience reads). */
export const BROKER_KIND_BY_TABLE: Readonly<Record<string, UibBrokerKind>> = {
  sys_ux_data_broker_transform: "transform",
  sys_ux_data_broker_scriptlet: "scriptlet",
  sys_ux_data_broker_rest: "rest",
  sys_ux_data_broker_graphql: "graphql",
};

export interface UibBrokerRow {
  kind: UibBrokerKind;
  /** Raw field value; undefined when not returned (unknown). */
  mutates_server_data?: unknown;
  /** Raw `properties` JSON (or decoded); undefined when not returned. */
  properties?: unknown;
  /** Transform script; undefined when not read. */
  script?: unknown;
}

export interface UibBrokerContext {
  /** A ux_data_broker ACL names the broker; undefined when ACLs are unknown. */
  hasAcl?: boolean;
}

export interface UibBrokerFinding {
  rule: UibBrokerRuleId;
  severity: UibSeverity;
  message: string;
  hint: string;
  /** `uib-transform-gliderecord-no-acl-check`: first unchecked query line. */
  line?: number;
}

const rule = (id: UibBrokerRuleId): UibRule =>
  UIB_BROKER_RULES.find((r) => r.id === id)!;

/** `mutates_server_data` as a boolean; undefined when unknown. */
export function brokerMutates(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const s = String(value).trim().toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0" || s === "") return false;
  return undefined;
}

/**
 * Whether `properties` declares at least one input; undefined when the field
 * was not returned or does not decode.
 */
export function hasInputSchema(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  let v: unknown = value;
  if (typeof v === "string") {
    if (!v.trim()) return false;
    const d = decodeField("json", v);
    if (!d.decoded) return undefined;
    v = d.value;
  }
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    // A JSON-schema-like object: its `properties` map, else its own keys.
    if (o.properties && typeof o.properties === "object") {
      return Object.keys(o.properties).length > 0;
    }
    return Object.keys(o).length > 0;
  }
  return undefined;
}

const QUERY_CLASSES = new Set(["GlideRecord", "GlideAggregate"]);
const ACCESS_METHODS = new Set([
  "canRead",
  "canWrite",
  "canCreate",
  "canDelete",
  "canAccess",
  "hasRole",
  "hasRoleExactly",
  "hasRoleInGroup",
]);
const QUERY_RE = /\bnew\s+(?:GlideRecord|GlideAggregate)\s*\(/;
const GUARD_RE =
  /\bnew\s+GlideRecordSecure\s*\(|\.(?:canRead|canWrite|canCreate|canDelete|canAccess|hasRole|hasRoleExactly|hasRoleInGroup)\s*\(/;

/**
 * The line of the first `new GlideRecord` / `GlideAggregate` of a script that
 * never checks access; null when the script is clean (or has no query).
 */
export function uncheckedGlideRecord(source: string): number | null {
  if (!source || !QUERY_RE.test(source)) return null;
  const calls = scriptCalls(source);
  if (!calls) {
    if (GUARD_RE.test(source)) return null;
    const at = source.search(QUERY_RE);
    return source.slice(0, at).split("\n").length;
  }
  const queries = calls.filter(
    (c) => c.kind === "new" && !c.object && QUERY_CLASSES.has(c.name ?? ""),
  );
  if (!queries.length) return null;
  const guarded = calls.some(
    (c) =>
      (c.kind === "new" && !c.object && c.name === "GlideRecordSecure") ||
      (c.kind === "call" && !!c.object && ACCESS_METHODS.has(c.name ?? "")),
  );
  return guarded ? null : Math.min(...queries.map((q) => q.line));
}

/** The N-29 broker rules over one row. Never throws. */
export function lintUibBroker(
  row: UibBrokerRow,
  ctx: UibBrokerContext = {},
): UibBrokerFinding[] {
  const out: UibBrokerFinding[] = [];
  const add = (
    id: UibBrokerRuleId,
    message: string,
    extra: { line?: number } = {},
  ): void => {
    const r = rule(id);
    out.push({
      rule: id,
      severity: r.severity,
      message,
      hint: r.hint,
      ...extra,
    });
  };
  if (brokerMutates(row.mutates_server_data) && ctx.hasAcl === false) {
    add(
      "uib-broker-mutates-no-acl",
      "The broker mutates server data and no ux_data_broker ACL names it.",
    );
  }
  if (row.kind === "transform" && typeof row.script === "string") {
    const line = uncheckedGlideRecord(row.script);
    if (line !== null) {
      add(
        "uib-transform-gliderecord-no-acl-check",
        `The transform queries with GlideRecord (line ${line}) and never checks access.`,
        { line },
      );
    }
  }
  if (hasInputSchema(row.properties) === false) {
    add(
      "uib-broker-no-input-schema",
      "The broker declares no input schema (`properties` is empty).",
    );
  }
  return out;
}
