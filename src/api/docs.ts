import { createHash, randomBytes } from "node:crypto";
import { existsSync, promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { activeProfile, getCredentials, listProfiles } from "../core/config.js";
import { ServiceNowError } from "../core/errors.js";
import {
  getDocsDir,
  getDocsMaxFileBytes,
  getDocsSearchMax,
  getDocsStaleDays,
} from "../core/settings.js";
import { appendWriteJournal, sha256Hex } from "../core/write-journal.js";

/**
 * Local self-documentation store. These tools read and write Markdown files in
 * a single directory (SN_DOCS_DIR, default `docs/instance/`) so the model can
 * accumulate durable knowledge about an instance across sessions. They touch
 * the local filesystem only — never ServiceNow — and are strictly confined to
 * the docs directory to prevent path traversal.
 *
 * Store v2 (S-14): a file written by a generator carries a frontmatter block
 * (`sn_generated`, `sn_generator`, `sn_generator_version`, `sn_profile`,
 * `sn_instance`, `sn_generated_at`, `sn_source_hash`) — a JSON companion
 * carries the same fields at its top level. Text between
 * `<!-- sn:manual:start -->` and `<!-- sn:manual:end -->` survives
 * regeneration byte for byte. `docs_write` refuses to replace a generated
 * file (and a generator refuses a hand-written one) without `overwrite`
 * (DOC_GENERATED). Every write rebuilds `index.json` (the manifest) and the
 * `index.md` rendered from it.
 *
 * Metadata-only invariant: the generators that write here (snapshot, ER,
 * table flow, compare, code health) read instance *metadata* — dictionary,
 * scripts, plugins, apps, ACL / flow / notification definitions and aggregate
 * counts — never business records. test/docs-goldens.test.js walks their
 * fetch calls against an allow-list of tables to keep it that way.
 */

const INDEX_FILE = "index.md";

function errorCode(e: unknown): string | undefined {
  return typeof e === "object" &&
    e !== null &&
    "code" in e &&
    typeof e.code === "string"
    ? e.code
    : undefined;
}

/**
 * H-5 — the lexical check cannot see symlinks: a link inside the docs
 * directory (e.g. `docs/instance/out -> /etc`) would let a write land outside
 * it. Resolve the nearest existing ancestor of the target through the file
 * system and require it to stay inside the real docs root.
 */
function assertRealPathInside(root: string, target: string, relPath: string) {
  if (!existsSync(root)) return; // nothing under a missing root can be a link
  let probe = target;
  while (!existsSync(probe)) probe = path.dirname(probe);
  const rel = path.relative(realpathSync(root), realpathSync(probe));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ServiceNowError(
      `Path escapes the docs directory through a symbolic link: ${relPath}`,
      400,
    );
  }
}

/**
 * Windows device names are special in every directory (`con.md` opens the
 * console), with or without an extension (H-6 / GAP L2-10).
 */
const RESERVED_SEGMENT_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Refuse path segments that behave differently on another platform: Windows
 * reserved device names and any `:` (an NTFS alternate data stream such as
 * `a.md:hidden`, or a drive prefix).
 */
function assertPortableSegments(relPath: string, cleaned: string): void {
  for (const segment of cleaned.split(/[/\\]/)) {
    if (segment.includes(":")) {
      throw new ServiceNowError(
        `Document path may not contain ":" (drive prefix or alternate data stream): ${relPath}`,
        400,
      );
    }
    if (RESERVED_SEGMENT_RE.test(segment)) {
      throw new ServiceNowError(
        `Document path uses a reserved Windows device name ("${segment}"): ${relPath}`,
        400,
      );
    }
  }
}

/** Resolve a docs-relative path to an absolute one, rejecting any escape. */
function resolveDocPath(relPath: string, extensions = [".md"]): string {
  if (typeof relPath !== "string" || !relPath.trim()) {
    throw new ServiceNowError("A document path is required.", 400);
  }
  // Strip leading slashes/backslashes so the path is always treated as relative.
  const cleaned = relPath.trim().replace(/^[/\\]+/, "");
  assertPortableSegments(relPath, cleaned);
  const root = getDocsDir();
  const resolved = path.resolve(root, cleaned);
  const rel = path.relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ServiceNowError(
      `Path escapes the docs directory: ${relPath}`,
      400,
    );
  }
  if (!extensions.includes(path.extname(resolved).toLowerCase())) {
    throw new ServiceNowError(
      `Only ${extensions.join("/")} files are supported.`,
      400,
    );
  }
  assertRealPathInside(root, resolved, relPath);
  return resolved;
}

/** The write journal's own files — never writable through the docs store. */
const JOURNAL_FILE = /^write-journal\./i;

/** A size-cap error for a document (SN_DOCS_MAX_FILE_BYTES). */
function tooLarge(
  relPath: string,
  bytes: number,
  max: number,
): ServiceNowError {
  return new ServiceNowError(
    `Document ${relPath} is ${bytes} bytes, over the SN_DOCS_MAX_FILE_BYTES limit of ${max}.`,
    413,
    undefined,
    {
      code: "PAYLOAD_TOO_LARGE",
      hint: "Split the document into smaller files or raise SN_DOCS_MAX_FILE_BYTES.",
    },
  );
}

/**
 * Recursively collect the files under `dir` whose extension is in
 * `extensions` (Markdown by default), as posix-style relative paths.
 */
async function walk(
  dir: string,
  root: string,
  out: string[],
  extensions: readonly string[] = [".md"],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (errorCode(e) === "ENOENT") return;
    throw e;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, root, out, extensions);
    } else if (
      entry.isFile() &&
      extensions.includes(path.extname(entry.name).toLowerCase())
    ) {
      out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
}

// ---------------------------------------------------------------------------
// Frontmatter, manual blocks and ownership (S-14)
// ---------------------------------------------------------------------------

/**
 * Default layout version of generated documents. Bump it when a generator's
 * output changes shape, so an unchanged source still rewrites the file once.
 * A writer with its own template declares `DocMeta.generatorVersion` instead
 * (ID-18), so bumping one writer does not rewrite every other writer's files.
 */
export const DOCS_GENERATOR_VERSION = "1";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const MANUAL_RE =
  /<!-- sn:manual:start(?:\s+([\w-]+))?\s*-->[\s\S]*?<!-- sn:manual:end\s*-->/g;

/** The `sn_*` fields of a document, as strings. */
export type DocFields = Record<string, string>;

/** Split a leading `---` frontmatter block from a Markdown body. */
export function parseFrontmatter(content: string): {
  fields?: DocFields;
  body: string;
} {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return { body: content };
  const fields: DocFields = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_]+):[ \t]?(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (value.startsWith('"')) {
      try {
        value = String(JSON.parse(value));
      } catch {
        // keep the raw text
      }
    }
    fields[kv[1]!] = value;
  }
  return { fields, body: content.slice(m[0].length) };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The `sn_*` fields of a document: frontmatter, or a JSON file's top level. */
function fieldsOf(content: string, ext: string): DocFields | undefined {
  if (ext !== ".json") return parseFrontmatter(content).fields;
  try {
    const obj: unknown = JSON.parse(content);
    if (!isPlainObject(obj)) return undefined;
    const fields: DocFields = {};
    for (const [k, v] of Object.entries(obj)) {
      if (
        k.startsWith("sn_") &&
        ["string", "boolean", "number"].includes(typeof v)
      ) {
        fields[k] = String(v);
      }
    }
    return Object.keys(fields).length > 0 ? fields : undefined;
  } catch {
    return undefined;
  }
}

const isGenerated = (fields: DocFields | undefined): fields is DocFields =>
  fields?.sn_generated === "true";

/**
 * Carry the manual blocks of the previous version into a regenerated body.
 * A block in the new body is replaced by the previous block with the same id
 * (`<!-- sn:manual:start notes -->`), or — for anonymous blocks — by the next
 * unused anonymous one, in order. Previous blocks with no slot are appended,
 * so hand-written text is never lost.
 */
export function mergeManualBlocks(next: string, previous: string): string {
  const old = [...previous.matchAll(MANUAL_RE)].map((m) => ({
    id: m[1],
    text: m[0],
    used: false,
  }));
  if (old.length === 0) return next;
  let merged = next.replace(MANUAL_RE, (block, id?: string) => {
    const hit = old.find((b) => !b.used && b.id === id);
    if (!hit) return block;
    hit.used = true;
    return hit.text;
  });
  const orphans = old.filter((b) => !b.used).map((b) => b.text);
  if (orphans.length > 0) {
    merged = `${merged.replace(/\n*$/, "")}\n\n${orphans.join("\n\n")}\n`;
  }
  return merged;
}

/** JSON with sorted keys, so a hash does not depend on insertion order. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** `sha256:<hex>` of a generator's source data (or of a body string). */
export function sourceHash(source: unknown): string {
  return `sha256:${sha256Hex(typeof source === "string" ? source : stableJson(source))}`;
}

/** What a generator passes to docsWriteRaw to own the file it writes. */
export interface DocMeta {
  /** Tool or generator name, e.g. `servicenow_snapshot_instance`. */
  generator: string;
  /** Open-ended document kind (`tables`, `schema`, `compare`, …). */
  kind?: string;
  /** Default: the active profile. */
  profile?: string;
  /** Default: the profile's instance host. */
  instance?: string;
  /** Default: now. */
  generatedAt?: string;
  /**
   * Structured source data the document was rendered from. Its hash decides
   * whether a re-run is `unchanged`; leave timestamps out of it. Without it
   * the body (minus manual blocks) is hashed.
   */
  source?: unknown;
  /** Take over a hand-written file. */
  overwrite?: boolean;
  /**
   * Recognises a file this generator wrote before the store had frontmatter,
   * so the upgrade does not trip DOC_GENERATED. A JSON file with a top-level
   * `generatedAt` key is always treated as legacy generated output.
   */
  legacy?: RegExp;
  /**
   * The document records an interrupted run (S-7): written as `sn_partial`
   * and surfaced as `partial: true` in index.json.
   */
  partial?: boolean;
  /**
   * The writer's own layout version (ID-18), written as
   * `sn_generator_version`. Default: DOCS_GENERATOR_VERSION.
   */
  generatorVersion?: string;
}

export type DocWriteStatus = "created" | "updated" | "unchanged";

export interface DocWriteResult {
  path: string;
  bytes: number;
  /** Set for generator writes (with `meta`). */
  status?: DocWriteStatus;
  source_hash?: string;
}

function docGenerated(
  relPath: string,
  generatedBy: string | undefined,
): ServiceNowError {
  return generatedBy !== undefined
    ? new ServiceNowError(
        `Document ${relPath} is generated by ${generatedBy || "a generator"}; it is not replaced without overwrite: true.`,
        409,
        undefined,
        {
          code: "DOC_GENERATED",
          hint: "Pass overwrite: true to replace it, or regenerate it — text inside <!-- sn:manual:start --> … <!-- sn:manual:end --> survives regeneration.",
        },
      )
    : new ServiceNowError(
        `Document ${relPath} is hand-written; a generator does not replace it without overwrite: true.`,
        409,
        undefined,
        {
          code: "DOC_GENERATED",
          hint: "Pass overwrite: true to let the generator take the file over, or move the hand-written file.",
        },
      );
}

function instanceHost(profile: string): string {
  try {
    return getCredentials(profile)
      .instance.replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "");
  } catch {
    return "";
  }
}

function yamlValue(v: string): string {
  return /^[\w.:+\-/@]+$/.test(v) ? v : JSON.stringify(v);
}

async function readIfExists(abs: string): Promise<string | undefined> {
  try {
    return await fs.readFile(abs, "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return undefined;
    throw e;
  }
}

/** Up to `max` leading bytes of a file, plus its size; undefined if missing. */
async function readHead(
  abs: string,
  max: number,
): Promise<{ text: string; size: number; mtimeMs: number } | undefined> {
  let handle;
  try {
    handle = await fs.open(abs, "r");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return undefined;
    throw e;
  }
  try {
    const { size, mtimeMs } = await handle.stat();
    const n = Math.min(size, max);
    const buf = Buffer.alloc(n);
    const { bytesRead } = await handle.read(buf, 0, n, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    // A cut can split a multi-byte character; drop the partial tail.
    return {
      text: n < size ? text.replace(/\uFFFD+$/, "") : text,
      size,
      mtimeMs,
    };
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Profile scoping (S-14)
// ---------------------------------------------------------------------------

/**
 * Resolve a docs `profile` argument: `current` is the active profile, any
 * other value must name a configured profile.
 */
export function resolveDocsProfile(profile: string): string {
  const name = String(profile).trim().toLowerCase();
  if (name === "current") return activeProfile();
  const known = new Set([activeProfile(), ...listProfiles()]);
  if (!known.has(name)) {
    throw new ServiceNowError(
      `Unknown profile "${profile}" — use "current" or one of: ${[...known].join(", ")}.`,
      400,
    );
  }
  return name;
}

/** A docs path, prefixed with `<profile>/` when a profile is given. */
function scoped(relPath: string, profile?: string): string {
  if (profile === undefined) return relPath;
  const p = resolveDocsProfile(profile);
  if (typeof relPath !== "string" || !relPath.trim()) {
    throw new ServiceNowError("A document path is required.", 400);
  }
  return `${p}/${relPath.trim().replace(/^[/\\]+/, "")}`;
}

// ---------------------------------------------------------------------------
// Document inspection (docs_list, manifest)
// ---------------------------------------------------------------------------

interface DocInfo {
  bytes: number;
  fields?: DocFields;
  title?: string;
  headings: string[];
}

const MAX_HEADINGS = 50;
const LIST_HEAD_BYTES = 8192;

/** Headings (h1–h3) outside code fences; the first h1 is the title. */
function outline(body: string): { title?: string; headings: string[] } {
  let title: string | undefined;
  const headings: string[] = [];
  let fence = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const h = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!h) continue;
    if (h[1] === "#" && title === undefined) title = h[2];
    if (headings.length < MAX_HEADINGS) headings.push(h[2]!);
  }
  return { title, headings };
}

/** Parsed documents, keyed by path and invalidated by size + mtime. */
const infoCache = new Map<string, { key: string; info: DocInfo }>();

async function inspect(
  abs: string,
  headBytes: number,
): Promise<DocInfo | undefined> {
  const head = await readHead(abs, headBytes);
  if (!head) return undefined;
  const key = `${head.size}:${head.mtimeMs}:${headBytes}`;
  const hit = infoCache.get(abs);
  if (hit?.key === key) return hit.info;
  let info: DocInfo;
  if (path.extname(abs).toLowerCase() === ".json") {
    const fields =
      head.text.length >= head.size
        ? fieldsOf(head.text, ".json")
        : jsonHeadFields(head.text);
    info = { bytes: head.size, fields, headings: [] };
  } else {
    const { fields, body } = parseFrontmatter(head.text);
    info = { bytes: head.size, fields, ...outline(body) };
  }
  infoCache.set(abs, { key, info });
  return info;
}

/**
 * The leading top-level `sn_*` fields of a generated JSON document that is
 * too large to parse whole: withJsonFields writes them first, two-space
 * indented, so the head of the file is enough.
 */
function jsonHeadFields(head: string): DocFields | undefined {
  const fields: DocFields = {};
  for (const m of head.matchAll(
    /^ {2}"(sn_[A-Za-z0-9_]+)": ("(?:[^"\\]|\\.)*"|true|false|-?\d+(?:\.\d+)?)/gm,
  )) {
    let value = m[2]!;
    try {
      value = String(JSON.parse(value));
    } catch {
      // keep the raw text
    }
    fields[m[1]!] = value;
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

/** One row of docs_list. */
export interface DocEntry {
  path: string;
  bytes: number;
  generated: boolean;
  generator?: string;
  generated_at?: string;
  profile?: string;
  kind?: string;
  /** Generated and older than SN_DOCS_STALE_DAYS. */
  stale?: boolean;
}

function toEntry(file: string, info: DocInfo, now: number): DocEntry {
  const f = info.fields;
  if (!isGenerated(f)) {
    return { path: file, bytes: info.bytes, generated: false };
  }
  const at = Date.parse(f.sn_generated_at ?? "");
  return {
    path: file,
    bytes: info.bytes,
    generated: true,
    generator: f.sn_generator,
    generated_at: f.sn_generated_at,
    profile: f.sn_profile,
    kind: f.sn_kind,
    stale: Number.isFinite(at)
      ? now - at > getDocsStaleDays() * 86_400_000
      : true,
  };
}

export interface DocsListOptions {
  /** `current`, a profile name, or omitted for the whole store. */
  profile?: string;
  /** Clock for `stale` (tests). */
  now?: Date;
}

/** List the Markdown documents under the docs directory, with their metadata. */
export async function docsList(opts: DocsListOptions = {}): Promise<{
  dir: string;
  count: number;
  files: string[];
  entries: DocEntry[];
}> {
  const root = getDocsDir();
  const all: string[] = [];
  await walk(root, root, all);
  const prefix =
    opts.profile === undefined ? "" : `${resolveDocsProfile(opts.profile)}/`;
  const files = all.filter((f) => f.startsWith(prefix)).sort();
  const now = (opts.now ?? new Date()).getTime();
  const entries: DocEntry[] = [];
  for (const file of files) {
    const info = await inspect(path.join(root, file), LIST_HEAD_BYTES);
    if (info) entries.push(toEntry(file, info, now));
  }
  return { dir: root, count: files.length, files, entries };
}

/** The media type of a readable docs file (ID-21). */
export type DocMimeType = "text/markdown" | "application/json";

/**
 * Read one Markdown document or JSON companion (ID-21). A file over
 * SN_DOCS_MAX_FILE_BYTES is returned truncated to that many bytes, flagged
 * `truncated: true` with its full size in `bytes`. With `profile`, the path
 * is relative to `<profile>/`.
 */
export async function docsRead(
  relPath: string,
  opts: { profile?: string } = {},
): Promise<{
  path: string;
  content: string;
  mimeType: DocMimeType;
  truncated?: true;
  bytes?: number;
}> {
  const rel = scoped(relPath, opts.profile);
  const abs = resolveDocPath(rel, [".md", ".json"]);
  const mimeType: DocMimeType =
    path.extname(abs).toLowerCase() === ".json"
      ? "application/json"
      : "text/markdown";
  const max = getDocsMaxFileBytes();
  const head = await readHead(abs, max);
  if (!head) throw new ServiceNowError(`Document not found: ${rel}`, 404);
  return head.size <= max
    ? { path: rel, content: head.text, mimeType }
    : {
        path: rel,
        content: head.text,
        mimeType,
        truncated: true,
        bytes: head.size,
      };
}

export interface DocMatch {
  path: string;
  line: number;
  snippet: string;
  /** Nearest heading above the match. */
  heading?: string;
}

export interface DocsSearchOptions {
  profile?: string;
  /** Only generated documents of this kind. */
  kind?: string;
  /** Only generated (true) or hand-written (false) documents. */
  generated?: boolean;
}

/**
 * Search the docs for a literal substring, returning a snippet (and the
 * nearest heading) per match. Frontmatter is not searched. Files over
 * SN_DOCS_MAX_FILE_BYTES are not read; they are listed in `skipped` so the
 * caller knows the search was partial. At most SN_DOCS_SEARCH_MAX matches
 * are returned (`truncated: true` past it).
 */
export async function docsSearch(
  text: string,
  opts: DocsSearchOptions = {},
): Promise<{
  count: number;
  matches: DocMatch[];
  skipped?: { path: string; bytes: number }[];
  truncated?: true;
}> {
  const needle = text?.trim();
  if (!needle) {
    throw new ServiceNowError("docsSearch requires a non-empty 'text'.", 400);
  }
  const lower = needle.toLowerCase();
  const { entries } = await docsList({ profile: opts.profile });
  const matches: DocMatch[] = [];
  const skipped: { path: string; bytes: number }[] = [];
  const max = getDocsMaxFileBytes();
  const cap = getDocsSearchMax();
  let truncated = false;
  for (const entry of entries) {
    if (truncated) break;
    if (opts.generated !== undefined && entry.generated !== opts.generated) {
      continue;
    }
    if (opts.kind !== undefined && entry.kind !== opts.kind) continue;
    const abs = resolveDocPath(entry.path);
    const { size } = await fs.stat(abs);
    if (size > max) {
      skipped.push({ path: entry.path, bytes: size });
      continue;
    }
    const content = await fs.readFile(abs, "utf8");
    const fm = FRONTMATTER_RE.exec(content);
    const lines = content.split("\n");
    const first = fm ? fm[0].split("\n").length - 1 : 0;
    let heading: string | undefined;
    let fence = false;
    for (let i = first; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      const h = fence ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
      if (h) heading = h[1];
      if (!line.toLowerCase().includes(lower)) continue;
      if (matches.length >= cap) {
        truncated = true;
        break;
      }
      const match: DocMatch = {
        path: entry.path,
        line: i + 1,
        snippet: line.trim().slice(0, 200),
      };
      if (heading !== undefined) match.heading = heading;
      matches.push(match);
    }
  }
  return {
    count: matches.length,
    matches,
    ...(skipped.length > 0 ? { skipped } : {}),
    ...(truncated ? { truncated: true as const } : {}),
  };
}

// ---------------------------------------------------------------------------
// Manifest (index.json) and index.md
// ---------------------------------------------------------------------------

const MANIFEST_FILE = "index.json";

/** One document in index.json. */
export interface ManifestEntry {
  path: string;
  kind: string | null;
  title: string | null;
  profile: string | null;
  generator: string | null;
  generated_at: string | null;
  source_hash: string | null;
  bytes: number;
  headings: string[];
  /** Present when the document records an interrupted run. */
  partial?: true;
  /** The sibling generated `.json` companion of a Markdown entry (ID-21). */
  companion?: string;
}

/** The last run of one generator, as recorded in index.json (ID-19). */
export interface ManifestRun {
  profile: string;
  started_at: string;
  /** `null` while the run is open. */
  finished_at: string | null;
  /** True while the run is open, and after an interrupted run. */
  partial: boolean;
  /** Files the run wrote. */
  files: number;
}

/** A change to the recorded runs, applied inside the serialized rebuild. */
type RunsUpdate = (runs: Record<string, ManifestRun>) => void;

/**
 * index.md / index.json regeneration is serialized through this tail
 * promise: concurrent docsWriteRaw() calls (pipelined requests, or two
 * profiles snapshotting at once) must not interleave a walk() with another
 * call's write, or the rebuilt index would drop the entries written in
 * between. The tail keeps the chain alive across a failed rebuild so a later
 * call is not stuck behind it.
 */
let indexTail: Promise<unknown> = Promise.resolve();

/** Rebuild the manifest and the index.md rendered from it. */
function regenerateIndex(update?: RunsUpdate): Promise<void> {
  const rebuild = () => rebuildIndex(update);
  const run = indexTail.then(rebuild, rebuild);
  indexTail = run.catch(() => {});
  return run;
}

/** The `runs` recorded in the current index.json (ID-19), or none. */
async function readRuns(root: string): Promise<Record<string, ManifestRun>> {
  try {
    const raw = await fs.readFile(path.join(root, MANIFEST_FILE), "utf8");
    const runs = (JSON.parse(raw) as { runs?: unknown }).runs;
    return isPlainObject(runs) ? (runs as Record<string, ManifestRun>) : {};
  } catch {
    return {};
  }
}

async function rebuildIndex(update?: RunsUpdate): Promise<void> {
  const root = getDocsDir();
  const all: string[] = [];
  // ID-21: generated `.json` companions are listed too; other JSON files
  // (exports) and the manifest itself are not.
  await walk(root, root, all, [".md", ".json"]);
  const docs = all
    .filter((f) => {
      const lower = f.toLowerCase();
      return lower !== INDEX_FILE && lower !== MANIFEST_FILE;
    })
    .sort();
  const max = getDocsMaxFileBytes();
  const files: ManifestEntry[] = [];
  for (const file of docs) {
    const info = await inspect(path.join(root, file), max);
    if (!info) continue;
    const f = isGenerated(info.fields) ? info.fields : undefined;
    if (file.toLowerCase().endsWith(".json")) {
      if (!f) continue;
      files.push({
        path: file,
        kind: f.sn_kind ?? null,
        title: null,
        profile: f.sn_profile ?? null,
        generator: f.sn_generator ?? null,
        generated_at: f.sn_generated_at ?? null,
        source_hash: f.sn_source_hash ?? null,
        bytes: info.bytes,
        headings: [],
        ...(f.sn_partial === "true" ? { partial: true as const } : {}),
      });
      continue;
    }
    files.push({
      path: file,
      kind: f ? (f.sn_kind ?? "generated") : null,
      title: info.title ?? null,
      profile: f?.sn_profile ?? null,
      generator: f?.sn_generator ?? null,
      generated_at: f?.sn_generated_at ?? null,
      source_hash: f?.sn_source_hash ?? null,
      bytes: info.bytes,
      headings: info.headings,
      ...(f?.sn_partial === "true" ? { partial: true as const } : {}),
    });
  }
  const jsonPaths = new Set(
    files.filter((e) => e.path.endsWith(".json")).map((e) => e.path),
  );
  for (const e of files) {
    const sibling = e.path.replace(/\.md$/i, ".json");
    if (sibling !== e.path && jsonPaths.has(sibling)) e.companion = sibling;
  }
  const runs = await readRuns(root);
  update?.(runs);
  const partial = files.some((e) => e.partial);
  await fs.writeFile(
    path.join(root, MANIFEST_FILE),
    `${JSON.stringify(
      {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        ...(partial ? { partial } : {}),
        ...(Object.keys(runs).length > 0 ? { runs } : {}),
        files,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(root, INDEX_FILE),
    renderIndex(files, runs),
    "utf8",
  );
}

/**
 * Open a multi-file generator run (ID-19): recorded in index.json `runs` as
 * `{ partial: true, finished_at: null }` until docsRunEnd closes it, so a
 * reader can tell an open or cancelled run from a finished one.
 */
export function docsRunBegin(
  generator: string,
  profile: string,
  startedAt = new Date().toISOString(),
): Promise<void> {
  return regenerateIndex((runs) => {
    runs[generator] = {
      profile,
      started_at: startedAt,
      finished_at: null,
      partial: true,
      files: 0,
    };
  });
}

/** Close a run opened by docsRunBegin; `partial` marks an interrupted run. */
export function docsRunEnd(
  generator: string,
  profile: string,
  result: { files: number; partial?: boolean },
): Promise<void> {
  return regenerateIndex((runs) => {
    const now = new Date().toISOString();
    runs[generator] = {
      profile,
      started_at: runs[generator]?.started_at ?? now,
      finished_at: now,
      partial: result.partial === true,
      files: result.files,
    };
  });
}

/**
 * M-4 (ID-13): the manifest's entries as last written, or `undefined` when
 * the store has no (readable) index.json yet. Read-only; never rebuilds.
 */
export async function docsManifest(): Promise<ManifestEntry[] | undefined> {
  try {
    const raw = await fs.readFile(
      path.join(getDocsDir(), MANIFEST_FILE),
      "utf8",
    );
    const files = (JSON.parse(raw) as { files?: unknown }).files;
    return Array.isArray(files)
      ? (files as ManifestEntry[]).filter((e) => typeof e?.path === "string")
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * index.md: open or interrupted runs first (ID-19), then generated documents
 * by profile and kind; hand-written last. JSON companions are reached through
 * their Markdown entry.
 */
function renderIndex(
  entries: ManifestEntry[],
  runs: Record<string, ManifestRun> = {},
): string {
  const files = entries.filter((e) => !e.path.toLowerCase().endsWith(".json"));
  const link = (e: ManifestEntry): string =>
    `- [${e.path}](${e.path})${e.title ? ` — ${e.title}` : ""}`;
  const lines = [
    "# ServiceNow instance documentation",
    "",
    "Auto-generated index of documents in this folder.",
    "",
  ];
  const unfinished = Object.entries(runs)
    .filter(([, r]) => r.partial)
    .sort(([a], [b]) => a.localeCompare(b));
  if (unfinished.length > 0) {
    lines.push("## Unfinished runs", "");
    for (const [generator, r] of unfinished) {
      lines.push(
        r.finished_at === null
          ? `- ${generator} on \`${r.profile}\` — open, started ${r.started_at}`
          : `- ${generator} on \`${r.profile}\` — partial, ${r.files} files, interrupted ${r.finished_at}`,
      );
    }
    lines.push("");
  }
  const generated = files.filter((e) => e.generator !== null);
  const profiles = [...new Set(generated.map((e) => e.profile ?? ""))].sort();
  for (const profile of profiles) {
    lines.push(profile ? `## Profile \`${profile}\`` : "## No profile", "");
    const inProfile = generated.filter((e) => (e.profile ?? "") === profile);
    const kinds = [...new Set(inProfile.map((e) => e.kind ?? ""))].sort();
    for (const kind of kinds) {
      lines.push(`### ${kind}`, "");
      for (const e of inProfile.filter((x) => (x.kind ?? "") === kind)) {
        lines.push(link(e));
      }
      lines.push("");
    }
  }
  const manual = files.filter((e) => e.generator === null);
  if (manual.length > 0) {
    if (generated.length > 0) lines.push("## Hand-written", "");
    for (const e of manual) lines.push(link(e));
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface DocsWriteOptions {
  /** Replace a generated document. */
  overwrite?: boolean;
  /** Write under `<profile>/` (`current` or a profile name). */
  profile?: string;
}

/**
 * Create or overwrite a Markdown document, then regenerate index.md. Writing
 * index.md directly is allowed; it is rebuilt afterwards either way. Content
 * over SN_DOCS_MAX_FILE_BYTES is refused (the tool path; the internal
 * snapshot writer is not capped). A generated document is only replaced with
 * `overwrite: true` (DOC_GENERATED).
 */
export async function docsWrite(
  relPath: string,
  content: string,
  opts: DocsWriteOptions = {},
): Promise<DocWriteResult> {
  const rel = scoped(relPath, opts.profile);
  const bytes = Buffer.byteLength(content, "utf8");
  const max = getDocsMaxFileBytes();
  if (bytes > max) throw tooLarge(rel, bytes, max);
  if (!opts.overwrite) {
    const head = await readHead(resolveDocPath(rel), LIST_HEAD_BYTES);
    const fields = head ? parseFrontmatter(head.text).fields : undefined;
    if (isGenerated(fields)) throw docGenerated(rel, fields.sn_generator);
  }
  return docsWriteRaw(rel, content);
}

/**
 * Read a file of the docs store verbatim (no frontmatter parsing), with the
 * same confinement as docsWriteRaw; undefined when it does not exist. The
 * Fluent emitter (P-26) uses it to spot hand-edited generated sources.
 */
export async function docsReadRaw(
  relPath: string,
  extensions = [".md"],
): Promise<string | undefined> {
  return readIfExists(resolveDocPath(relPath, extensions));
}

/**
 * Same confinement and index upkeep as docsWrite, but with a caller-chosen
 * extension whitelist — the instance snapshot (MI-6) writes .json companions
 * next to its Markdown. Not exposed as a tool; tools keep the .md-only rule.
 *
 * With `meta` the caller is a generator: the file gets frontmatter (JSON: top
 * level `sn_*` fields), manual blocks of the previous version are carried
 * over, a hand-written file is refused without `meta.overwrite`
 * (DOC_GENERATED), and a re-run whose source hash, generator and profile
 * match is reported `unchanged` without touching the file.
 */
export async function docsWriteRaw(
  relPath: string,
  content: string,
  extensions = [".md"],
  meta?: DocMeta,
): Promise<DocWriteResult> {
  const abs = resolveDocPath(relPath, extensions);
  // H-5: a docs write must not be able to overwrite (and so launder) the
  // audit trail that sits in the same directory.
  if (JOURNAL_FILE.test(path.basename(abs))) {
    throw new ServiceNowError(
      `The write journal cannot be written through the docs store: ${relPath}`,
      400,
    );
  }
  if (!meta) {
    const bytes = await persist(abs, content);
    await regenerateIndex();
    return { path: relPath, bytes };
  }

  const ext = path.extname(abs).toLowerCase();
  const previous = await readIfExists(abs);
  const prevFields =
    previous === undefined ? undefined : fieldsOf(previous, ext);
  if (
    previous !== undefined &&
    !isGenerated(prevFields) &&
    !meta.overwrite &&
    !isLegacyOutput(previous, ext, meta)
  ) {
    throw docGenerated(relPath, undefined);
  }

  const profile = meta.profile ?? activeProfile();
  const version = meta.generatorVersion ?? DOCS_GENERATOR_VERSION;
  const hash = sourceHash(meta.source ?? content.replace(MANUAL_RE, ""));
  if (
    isGenerated(prevFields) &&
    prevFields.sn_generator === meta.generator &&
    prevFields.sn_generator_version === version &&
    prevFields.sn_profile === profile &&
    prevFields.sn_source_hash === hash &&
    (prevFields.sn_partial === "true") === (meta.partial === true)
  ) {
    return {
      path: relPath,
      bytes: Buffer.byteLength(previous!, "utf8"),
      status: "unchanged",
      source_hash: hash,
    };
  }

  const fields: [string, string][] = [
    ["sn_generated", "true"],
    ["sn_generator", meta.generator],
    ["sn_generator_version", version],
    ...(meta.kind ? [["sn_kind", meta.kind] as [string, string]] : []),
    ["sn_profile", profile],
    ["sn_instance", meta.instance ?? instanceHost(profile)],
    ["sn_generated_at", meta.generatedAt ?? new Date().toISOString()],
    ["sn_source_hash", hash],
    ...(meta.partial ? [["sn_partial", "true"] as [string, string]] : []),
  ];
  let out: string;
  if (ext === ".json") {
    out = withJsonFields(relPath, content, fields);
  } else {
    const body =
      previous === undefined
        ? content
        : mergeManualBlocks(content, parseFrontmatter(previous).body);
    out = `---\n${fields.map(([k, v]) => `${k}: ${yamlValue(v)}`).join("\n")}\n---\n\n${body}`;
  }
  const bytes = await persist(abs, out);
  await regenerateIndex();
  return {
    path: relPath,
    bytes,
    status: previous === undefined ? "created" : "updated",
    source_hash: hash,
  };
}

/**
 * The `sn_*` fields of a stored document, or undefined when it is missing or
 * carries none — how a resumed snapshot (S-7) checks a file still holds the
 * source hash it recorded.
 */
export async function docFields(
  relPath: string,
): Promise<DocFields | undefined> {
  const abs = resolveDocPath(relPath, [".md", ".json"]);
  const text = await readIfExists(abs);
  return text === undefined
    ? undefined
    : fieldsOf(text, path.extname(abs).toLowerCase());
}

/** A file this generator wrote before frontmatter existed. */
function isLegacyOutput(previous: string, ext: string, meta: DocMeta): boolean {
  if (ext === ".json") {
    try {
      const obj: unknown = JSON.parse(previous);
      return isPlainObject(obj) && "generatedAt" in obj;
    } catch {
      return false;
    }
  }
  return meta.legacy?.test(previous) ?? false;
}

/** Put the `sn_*` fields first in a generated JSON object. */
function withJsonFields(
  relPath: string,
  content: string,
  fields: [string, string][],
): string {
  const obj: unknown = JSON.parse(content);
  if (!isPlainObject(obj)) {
    throw new ServiceNowError(
      `Generated JSON document ${relPath} must be an object.`,
      400,
    );
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of fields)
    out[k] = k === "sn_generated" || k === "sn_partial" ? true : v;
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith("sn_")) out[k] = v;
  }
  return JSON.stringify(out, null, 2);
}

/** Write a file and journal it (L2-04). */
async function persist(abs: string, content: string): Promise<number> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  const bytes = Buffer.byteLength(content, "utf8");
  // L2-04: local file writes are journalled too, so the audit trail covers
  // every side effect of a tool call, not only instance mutations.
  appendWriteJournal({
    action: "local_write",
    table: "local",
    target: `docs/${path.relative(getDocsDir(), abs).split(path.sep).join("/")}`,
    bytes,
    sha256: sha256Hex(content),
  });
  return bytes;
}

/** A streaming write into the docs store (S-11 file delivery). */
export interface DocStream {
  /** The docs-relative path the file lands at on close. */
  readonly path: string;
  /** Append a chunk (UTF-8). */
  write(chunk: string): Promise<void>;
  /** Finish: move the file into place and journal it. */
  close(): Promise<{ path: string; abs: string; bytes: number }>;
  /** Give up: delete the partial file; nothing lands at `path`. */
  abort(): Promise<void>;
}

/**
 * Open a file in the docs store for streaming (S-11 — `format:"file"`
 * exports). Same confinement as docsWriteRaw — lexical containment, portable
 * segments, the symlink check and the write-journal refusal — but the content
 * arrives in chunks, so a large export never sits in memory whole. Chunks go to
 * a sibling `.part` file that is renamed into place on close (a failed or
 * cancelled export leaves nothing at `path`); the close is journalled as a
 * `local_write` with the byte count and sha256, like every docs write. Not
 * size-capped (SN_DOCS_MAX_FILE_BYTES governs `docs_write`), not indexed (the
 * index covers Markdown only), and not exposed as a tool.
 */
export async function openDocStream(
  relPath: string,
  extensions: string[],
): Promise<DocStream> {
  const abs = resolveDocPath(relPath, extensions);
  if (JOURNAL_FILE.test(path.basename(abs))) {
    throw new ServiceNowError(
      `The write journal cannot be written through the docs store: ${relPath}`,
      400,
    );
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  // Re-check after mkdir: a directory created above cannot be a link, but an
  // existing ancestor could have been swapped for one in the meantime.
  assertRealPathInside(getDocsDir(), abs, relPath);
  const part = `${abs}.${randomBytes(4).toString("hex")}.part`;
  const handle = await fs.open(part, "wx");
  const hash = createHash("sha256");
  let bytes = 0;
  let done = false;
  const finish = async () => {
    if (done) return false;
    done = true;
    await handle.close();
    return true;
  };
  return {
    path: relPath,
    async write(chunk: string) {
      if (done) throw new Error(`Stream already closed: ${relPath}`);
      if (!chunk) return;
      const buf = Buffer.from(chunk, "utf8");
      hash.update(buf);
      bytes += buf.length;
      await handle.write(buf);
    },
    async close() {
      if (!(await finish())) {
        throw new Error(`Stream already closed: ${relPath}`);
      }
      await fs.rename(part, abs);
      appendWriteJournal({
        action: "local_write",
        table: "local",
        target: `docs/${path.relative(getDocsDir(), abs).split(path.sep).join("/")}`,
        bytes,
        sha256: hash.digest("hex"),
      });
      return { path: relPath, abs, bytes };
    },
    async abort() {
      if (!(await finish())) return;
      await fs.rm(part, { force: true });
    },
  };
}
