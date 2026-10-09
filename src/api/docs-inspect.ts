import { promises as fs } from "node:fs";
import path from "node:path";
import { ServiceNowError } from "../core/errors.js";
import {
  getDocsDir,
  getDocsMaxFileBytes,
  getDocsSearchMax,
  getDocsStaleDays,
} from "../core/settings.js";
import {
  type DocFields,
  fieldsOf,
  FRONTMATTER_RE,
  isGenerated,
  parseFrontmatter,
  readHead,
} from "./docs-frontmatter.js";
import {
  resolveDocPath,
  resolveDocsProfile,
  scoped,
  walk,
} from "./docs-paths.js";

/**
 * Docs store reads: document inspection, list_docs, read_doc and search_docs.
 */

interface DocInfo {
  bytes: number;
  fields?: DocFields;
  title?: string;
  headings: string[];
}

const MAX_HEADINGS = 50;

export const LIST_HEAD_BYTES = 8192;

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

export async function inspect(
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

/** One row of list_docs. */
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
