import { ServiceNowError, rethrowIfCancelled } from "../core/errors.js";
import { throwIfCancelled } from "../core/progress.js";
import { type AppRow, type CollectorResult } from "./collectors.js";
import { type ErColumns } from "./diagrams.js";
import { mdTable, snString, IN_CHUNK } from "./shared.js";
import { queryTable } from "./table.js";

/**
 * Shared pieces of the S-15 document generators: caveats, the kind
 * contract, Markdown helpers and the guarded section reads of the
 * instance-level kinds.
 */

/** Caveat every document carries: what it is built from (C-11, ID-02). */
export const METADATA_CAVEAT =
  "Metadata only: built from dictionary, automation and access-control definitions; no business records were read.";

export const VISIBILITY_CAVEAT =
  "Visibility: every read runs as this profile's user. On a domain-separated instance only the records of the user's domain (and its visible parents) are seen, and ACLs can hide definitions, so an absent entry is not proof that none exists.";

/** Rows per logic type that tableLogic reads (its own page size). */
export const LOGIC_LIMIT = 200;

/** One kind of generated document (ID-11): the S-15 kind registry entry. */
export interface DocKind<T = unknown> {
  title: string;
  /** Layout version, written as `sn_generator_version` (ID-18). */
  version: string;
  /** Packages whose tools the kind's data comes from. */
  requires: readonly string[];
  /** The generator name recorded in the frontmatter and in index.json runs. */
  generator: string;
  /** Profile-relative path of the Markdown document for a target. */
  path: (target: string) => string;
  collect: (target: string, opts: CollectOptions) => Promise<T>;
  render: (data: T, ctx: RenderContext) => string;
  /** One document per profile: the target is not a name (no path check). */
  singleton?: boolean;
  /** Tables whose records the document holds (ID-29's collected column). */
  sources?: (data: T) => string[];
}

export interface CollectOptions {
  /** document_table: draw the ER and table-flow diagrams (default true). */
  diagrams?: boolean;
  /** document_table: which columns the ER entity shows (default `own`). */
  columns?: ErColumns;
  /** document_instance: the run the README and artifact-types kinds describe. */
  instance?: InstanceRunContext;
  /**
   * document_app (P-21): also a Mermaid diagram per flow, subflow, workflow,
   * portal and UI Builder experience, a dependency graph and a lint summary
   * (default false).
   */
  detail?: boolean;
  /** document_app kind `i18n` (N-7): one language code (default: the active languages). */
  language?: string;
}

export interface RenderContext {
  profile: string;
}

export const code = (v: string): string =>
  v ? `\`${v.replaceAll("`", "'")}\`` : "";

/** One-line cell text: no newlines, no runaway length. */
export function cell(value: unknown, max = 200): string {
  const text = snString(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function tableOrNone(header: string[], rows: string[][]): string {
  return rows.length ? mdTable(header, rows) : "_None._";
}

export function mermaidBlock(mermaid: string): string {
  return ["```mermaid", mermaid.replace(/\n+$/, ""), "```"].join("\n");
}

export function caveatsSection(caveats: string[]): string[] {
  return ["## Caveats", "", ...caveats.map((c) => `- ${c}`), ""];
}

export const PURPOSE_BLOCK = [
  "## Purpose",
  "",
  "<!-- sn:manual:start purpose -->",
  "<!-- sn:manual:end -->",
  "",
];

export function isAccessDenied(error: unknown): boolean {
  return (
    error instanceof ServiceNowError &&
    (error.status === 401 || error.status === 403)
  );
}

/** One table an instance-level kind read: its rows, or why it has none. */
export interface SectionRead {
  table: string;
  rows: Record<string, string>[];
  /** The user could not read the table (any error but a cancel). */
  unreadable?: true;
  /** The read stopped at the SN_MAX_RECORDS cap. */
  truncated?: true;
}

/**
 * Read `fields` of every row of `table` matching `query` as flat strings.
 * Never throws except on a cancel: an unreadable table is a flagged, empty
 * read that the document turns into a Caveats line.
 */
export async function readSection(
  table: string,
  fields: string[],
  query: string,
  opts: { absentIsEmpty?: boolean } = {},
): Promise<SectionRead> {
  throwIfCancelled();
  try {
    const r = await queryTable({
      table,
      fields,
      query,
      displayValue: "false",
      fetchAll: true,
    });
    return {
      table,
      rows: r.records.map((rec) =>
        Object.fromEntries(fields.map((f) => [f, snString(rec[f])])),
      ),
      ...(r.truncated ? { truncated: true as const } : {}),
    };
  } catch (error) {
    rethrowIfCancelled(error);
    // A plugin table that is not installed (404) has no rows to report.
    if (
      opts.absentIsEmpty &&
      error instanceof ServiceNowError &&
      error.status === 404
    ) {
      return { table, rows: [] };
    }
    return { table, rows: [], unreadable: true };
  }
}

/** {@link readSection} over `field IN values`, in chunks; no values, no read. */
export async function readSectionIn(
  table: string,
  fields: string[],
  field: string,
  values: string[],
  rest = "",
): Promise<SectionRead> {
  const unique = [...new Set(values.filter(Boolean))];
  const out: SectionRead = { table, rows: [] };
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const part = await readSection(
      table,
      fields,
      `${field}IN${unique.slice(i, i + IN_CHUNK).join(",")}${rest}`,
    );
    out.rows.push(...part.rows);
    if (part.unreadable) out.unreadable = true;
    if (part.truncated) out.truncated = true;
  }
  return out;
}

export const NOT_READABLE = "_Not readable for this user — see Caveats._";

/** A section's table, or the not-readable note. */
export function sectionTable(
  read: SectionRead,
  header: string[],
  rows: string[][],
): string {
  return read.unreadable ? NOT_READABLE : tableOrNone(header, rows);
}

/** Caveats lines for unreadable and capped reads, in read order. */
export function readCaveats(reads: SectionRead[]): string[] {
  const out: string[] = [];
  for (const r of reads) {
    if (r.unreadable) {
      out.push(
        `${codeOf(r.table)} is not readable for this user; its section is empty.`,
      );
    } else if (r.truncated) {
      out.push(
        `Truncated: the ${codeOf(r.table)} read stopped at the SN_MAX_RECORDS cap; its list is partial.`,
      );
    }
  }
  return out;
}

export const yesNo = (v?: string): string =>
  v === "true" ? "yes" : v === "false" ? "no" : (v ?? "");

/** `code()` over an optional row field. */
export const codeOf = (v?: string): string => code(v ?? "");

/** Compare by a numeric `order` then by name (stable across instances). */
export function byOrderThenName(
  a: Record<string, string>,
  b: Record<string, string>,
): number {
  const oa = Number(a.order);
  const ob = Number(b.order);
  const na = Number.isFinite(oa) ? oa : 0;
  const nb = Number.isFinite(ob) ? ob : 0;
  if (na !== nb) return na - nb;
  return (a.name ?? "").localeCompare(b.name ?? "");
}

/** One document linked from the README, relative to the profile folder. */
export interface InstanceDocLink {
  kind: string;
  target: string;
  path: string;
}

/** The instance-run context the README and artifact-types kinds read. */
export interface InstanceRunContext {
  documents: InstanceDocLink[];
  /** Tables whose records some document of this run holds. */
  collected: ReadonlySet<string>;
  /** Application rows read before the run (depth without named apps, S-16). */
  apps?: CollectorResult<Record<string, AppRow[]>>;
  /** S-16 discovery: the depth and the scopes this run documents. */
  discovery?: DiscoveryRun;
  /** Data of the documents built so far, keyed `<kind>:<target>` (S-16). */
  built?: ReadonlyMap<string, unknown>;
}

/**
 * `document_instance({depth})` tiers, cumulative: `overview` (version and
 * counts), `apps` (+ per-scope tables and dictionary, the apps index),
 * `artefacts` (+ per-scope artefacts by registry type).
 */
export const DISCOVERY_DEPTHS = ["overview", "apps", "artefacts"] as const;

export type DiscoveryDepth = (typeof DISCOVERY_DEPTHS)[number];

/** The discovery part of one document_instance run. */
export interface DiscoveryRun {
  depth: DiscoveryDepth;
  /** Scopes the per-scope files cover, in order. */
  scopes: string[];
  /** `sys_app` scopes beyond INSTANCE_TARGETS_MAX, left out of this run. */
  skipped: string[];
  /** `named` (the `apps` argument) or `sys_app` (every custom application). */
  source: "named" | "sys_app";
}
